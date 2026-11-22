import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheableDiff, contentRows, detailBytes, diffBytes, fileTree, FileTreeCache, fileWindow, MAX_DIFF_LINES, parsePatch, PatchModelCache, textLines } from '../src/lib/diff';
import { formatDate, LruCache, matchesCommit } from '../src/lib/format';
import { StateStore } from '../src/lib/state';
import { DEFAULT_SETTINGS, type ChangedFile, type Commit, type CommitDetail, type DiffQuery, type DiffResult, type Host, type Repository, type WorkingState } from '../src/shared/protocol';
import { DetailsPane } from '../src/ui/details';
import { DiffView } from '../src/ui/diff-view';

const oid = (character: string) => character.repeat(40);
const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 1, staged: false, unstaged: false, ...extra });
const commit = (id = oid('a')): Commit => ({ oid: id, parents: [], subject: `Subject ${id}`, author: 'Author', email: 'a@example.test', authoredAt: 1, committedAt: 2, refs: [] });
const detail = (id = oid('a'), files = [file('one.ts'), file('two.ts')]): CommitDetail => ({ commit: commit(id), files, base: null, body: '', committer: 'Author', committerEmail: 'a@example.test', signature: { status: 'N', signer: '', key: '' } });
const patch = (name = 'changed'): DiffResult => ({ patch: `@@ -1 +1 @@\n-old\n+${name}\n`, binary: false, truncated: false, oldContent: null, newContent: null });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { for (let index = 0; index < 10; index++) await Promise.resolve(); }

/** Minimal event/node stubs, not a DOM package or a browser: exercise actual pane methods and callbacks. */
class StubNode {
  static all: StubNode[] = [];
  children: StubNode[] = []; parent: StubNode | null = null; className = ''; dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  style: Record<string, unknown> = { setProperty: (key: string, value: string) => { this.style[key] = value; } };
  id = ''; title = ''; value = ''; type = ''; checked = false; hidden = false; disabled = false; tabIndex = -1;
  scrollTop = 0; scrollLeft = 0; clientHeight = 240; clientWidth = 1000; private text = ''; listeners = new Map<string, ((event: unknown) => void)[]>();
  constructor(readonly tag = 'div') { StubNode.all.push(this); }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    toggle: (name: string, force?: boolean) => { const add = force ?? !this.classList.contains(name); if (add) this.classList.add(name); else this.classList.remove(name); return add; },
  };
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text: string) { this.text = text; this.children = []; }
  appendChild(child: StubNode) { this.append(child); return child; }
  append(...children: (StubNode | string)[]) { for (const child of children) { if (typeof child === 'string') { const node = new StubNode('#text'); node.textContent = child; this.append(node); } else if (child.tag === '#fragment') { for (const node of [...child.children]) this.append(node); child.children = []; } else { child.remove(); child.parent = this; this.children.push(child); } } }
  replaceChildren(...children: StubNode[]) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  addEventListener(name: string, listener: (event: unknown) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  removeEventListener() {}
  fire(name: string, extra: Record<string, unknown> = {}) { const event = { target: this, key: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra }; for (const listener of this.listeners.get(name) ?? []) listener(event); return event; }
  matches(selector: string): boolean { if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim())); if (selector.startsWith('.')) return this.classList.contains(selector.slice(1)); if (selector === 'input[type="checkbox"]') return this.tag === 'input' && this.type === 'checkbox'; return this.tag === selector; }
  querySelectorAll<T = StubNode>(selector: string): T[] { const found: StubNode[] = []; const visit = (node: StubNode) => { for (const child of node.children) { if (child.matches(selector)) found.push(child); visit(child); } }; visit(this); return found as T[]; }
  querySelector<T = StubNode>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  closest(selector: string): StubNode | null { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  contains(node: StubNode): boolean { return node === this || this.children.some(child => child.contains(node)); }
  focus() {} scrollIntoView() {} getBoundingClientRect() { return { left: 0, right: 1000, top: 0, bottom: 240, width: 1000, height: 240 }; }
}
let frames: Map<number, FrameRequestCallback>; let nextFrame: number;
function installNodes() {
  StubNode.all = []; frames = new Map(); nextFrame = 0;
  vi.stubGlobal('Node', StubNode);
  vi.stubGlobal('document', { createElement: (tag: string) => new StubNode(tag), createElementNS: (_namespace: string, tag: string) => new StubNode(tag), createDocumentFragment: () => new StubNode('#fragment'), createTextNode: (text: string) => { const node = new StubNode('#text'); node.textContent = text; return node; }, getElementById: (id: string) => StubNode.all.find(node => node.id === id) ?? null, body: new StubNode('body') });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
}
function flushFrames() { const queued = [...frames.values()]; frames.clear(); for (const callback of queued) callback(0); }
function query(root: { element: HTMLElement }, selector: string): StubNode { const node = (root.element as unknown as StubNode).querySelector(selector); if (!node) throw new Error(`Missing ${selector}`); return node; }
function titled(root: StubNode, title: string): StubNode { const node = root.querySelectorAll<StubNode>('button').find(item => item.title === title); if (!node) throw new Error(`Missing button ${title}`); return node; }
function changeMode(view: { element: HTMLElement }, value: string) { const select = query(view, 'select'); select.value = value; select.fire('change'); }
function clickFile(pane: DetailsPane, path: string) { const row = query(pane, '.file-list').querySelectorAll<StubNode>('.file-row').find(node => node.dataset.path === path); if (!row) throw new Error(`Missing file ${path}`); row.fire('click'); }
function harness(overrides: Partial<Host> = {}, working: WorkingState | null = null) {
  const repo: Repository = { id: 'repo', path: 'D:/repo', name: 'repo', gitDir: '', commonDir: '', head: oid('a'), branch: 'main', trusted: false, bare: false };
  const context = { repo: repo as Repository | null, settings: structuredClone(DEFAULT_SETTINGS), working };
  const host = { cancel: vi.fn(async () => {}), commitDetail: vi.fn(async (_repo: string, id: string) => detail(id)), diffPatch: vi.fn(async () => patch()), fileContent: vi.fn(async () => ({ ...patch(), newContent: 'new file\n' })), diff: vi.fn(async () => ({ ...patch(), oldContent: 'old file\n', newContent: 'new file\n' })), ...overrides } as unknown as Host;
  const store = new StateStore(async () => {}, vi.fn()); store.queue = vi.fn();
  const pane = new DetailsPane(host, store, { context: () => context, settings: update => { Object.assign(context.settings, update); pane.updateSettings(); }, copy: vi.fn(), action: vi.fn(), close: vi.fn(), follow: vi.fn(), error: vi.fn(), ensureTrust: async () => false, openUrl: vi.fn(), changed: vi.fn() });
  return { pane, host, store, context };
}

beforeEach(installNodes);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded diff models and tree preparation', () => {
  it('stops parsing at the budget, accurately distinguishes an exact boundary, and bounds header-only input', () => {
    expect(parsePatch('@@ -0,0 +1,2 @@\n+a\n+b\n', 3).limited).toBeUndefined();
    const limited = parsePatch('@@ -0,0 +1,3 @@\r\n+a\r\n+b\r\n+c\r\n', 3);
    expect(limited.limited).toBe(true); expect(limited.hunks[0].lines.map(line => line.text)).toEqual(['a', 'b']);
    expect(parsePatch('header\n'.repeat(1_000_000), 4)).toEqual({ headers: ['header', 'header', 'header', 'header'], hunks: [], limited: true });
    expect(textLines('a\r\nb\r\n', 2)).toEqual({ lines: ['a', 'b'], limited: false });
    expect(contentRows('a\nb\nc\n', 'old', 2)).toMatchObject({ limited: true, lines: [{ old: 1, next: null }, { old: 2, next: null }] });
    expect(contentRows('a\nb\n', 'new', 2).limited).toBe(false);
  });
  it('reuses parsed hunks and each row variant by result identity, with byte and entry eviction', () => {
    const cache = new PatchModelCache(100, 2, 32_000), result = patch();
    const unified = cache.prepare(result, false), split = cache.prepare(result, true);
    expect(cache.prepare(result, false)).toBe(unified); expect(cache.prepare(result, true)).toBe(split); expect(cache.parsePasses).toBe(1); expect(cache.rowPasses).toBe(2);
    cache.prepare(patch('two'), false); cache.prepare(patch('three'), false);
    expect(cache.size).toBe(2); cache.prepare(result, false); expect(cache.parsePasses).toBe(4); expect(cache.bytes).toBeLessThanOrEqual(32_000);
    const tiny = new PatchModelCache(100, 20, 100); tiny.prepare(result, false); expect(tiny.size).toBe(0); expect(tiny.bytes).toBe(0);
  });
  it('indexes broad directories without child-array searching, preserves numeric/Unicode sorting and memoizes each compact variant', () => {
    const find = vi.spyOn(Array.prototype, 'find');
    const files = Array.from({ length: 5000 }, (_, index) => ({ path: `目录/folder${index}/file.ts` })); files.push({ path: 'root10.ts' }, { path: 'root2.ts' });
    const cache = new FileTreeCache<{ path: string }>(), compact = cache.get(files, true);
    expect(find).not.toHaveBeenCalled(); expect(compact.map(node => node.name)).toEqual(['目录', 'root2.ts', 'root10.ts']);
    expect(cache.get(files, true)).toBe(compact); expect(cache.buildPasses).toBe(1);
    const expanded = cache.get(files, false); expect(expanded).not.toBe(compact); expect(cache.get(files, false)).toBe(expanded); expect(cache.buildPasses).toBe(2);
    expect(fileTree([{ path: 'a/b/c.ts' }])[0]).toMatchObject({ name: 'a/b', path: 'a/b' });
    expect(fileWindow(50_000, 24 * 20_000, 240)).toEqual({ first: 19992, last: 20018 });
  });
  it('measures large DTOs without JSON serialization and leaves generic cache mutation semantics intact', () => {
    const result = patch(); result.patch += 'x'.repeat(100_000);
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation(() => { throw new Error('must not serialize'); });
    expect(diffBytes(result)).toBeGreaterThan(200_000); expect(detailBytes(detail())).toBeGreaterThan(0);
    const measure = vi.fn(diffBytes), cache = new LruCache<DiffResult>(20, 32 * 1024 * 1024, measure); cache.set('a', result); for (let index = 0; index < 20; index++) expect(cache.get('a')).toBe(result);
    expect(measure).toHaveBeenCalledOnce(); expect(stringify).not.toHaveBeenCalled();
    const generic = new LruCache<{ weight: number }>(2, 20, value => value.weight), mutable = { weight: 1 }; generic.set('x', mutable); mutable.weight = 100; generic.set('x', mutable); expect(generic.size).toBe(0);
  });
  it('returns unfiltered commits before reading fields and only materializes required search fields', () => {
    const unreadable = new Proxy(commit(), { get: () => { throw new Error('read'); } });
    expect(matchesCommit(unreadable, { text: ' ', mode: 'all' })).toBe(true);
    const item = commit(); Object.defineProperty(item, 'refs', { get: () => { throw new Error('refs read'); } }); Object.defineProperty(item, 'authoredAt', { get: () => { throw new Error('date read'); } });
    expect(matchesCommit(item, { text: 'SUBJECT', mode: 'message' })).toBe(true); expect(matchesCommit(item, { text: 'AUTHOR', mode: 'author' })).toBe(true);
    const value = Date.parse('2026-01-02T12:00:00Z') / 1000;
    expect(formatDate(value, 'local')).toBe(new Date(value * 1000).toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  });
});

describe('patch-first Details lifecycle', () => {
  it('publishes files before its first diff, single-flights the same pending selection/file, and never fetches side content eagerly', async () => {
    const gate = deferred<DiffResult>(), { pane, host } = harness({ diffPatch: vi.fn(() => gate.promise) });
    const first = pane.show({ kind: 'commit', oid: oid('a') }); expect(pane.show({ kind: 'commit', oid: oid('a') })).toBe(first);
    await tick(); expect(query(pane, '.file-list').querySelectorAll('.file-row')).toHaveLength(2); expect(query(pane, '.commit-metadata').textContent).toContain('Subject');
    const row = query(pane, '.file-row'); row.fire('click'); row.fire('click'); expect(host.diffPatch).toHaveBeenCalledOnce(); expect(host.cancel).not.toHaveBeenCalled(); expect(host.fileContent).not.toHaveBeenCalled();
    pane.updateSettings(); expect(query(pane, '.diff-container').textContent).toContain('Loading diff');
    gate.resolve(patch()); await first; expect(query(pane, '.diff-container').textContent).toContain('changed'); expect(host.diff).not.toHaveBeenCalled();
    pane.destroy();
  });
  it('marks an already displayed file after starting review without reloading its successful diff', async () => {
    const { pane, host, store } = harness();
    await pane.show({ kind: 'commit', oid: oid('a') });
    const key = `commit:${oid('a')}:ROOT`, row = query(pane, '.file-row');
    expect(query(pane, '.diff-container').textContent).toContain('changed');
    expect(row.classList.contains('reviewed')).toBe(false);
    store.startReview(key, 'repo', { kind: 'commit', oid: oid('a') });
    expect(store.reviewed(key, 'repo').size).toBe(0);
    clickFile(pane, 'one.ts'); await tick();
    expect([...store.reviewed(key, 'repo')]).toEqual(['one.ts']);
    expect(query(pane, '.file-row')).toBe(row); expect(row.classList.contains('reviewed')).toBe(true);
    expect(host.diffPatch).toHaveBeenCalledOnce(); expect(host.diff).not.toHaveBeenCalled(); expect(host.fileContent).not.toHaveBeenCalled();
    pane.destroy();
  });
  it('latest file and repository win even when cancelled host requests finish successfully', async () => {
    const one = deferred<DiffResult>(), two = deferred<DiffResult>(), diffPatch = vi.fn((query: DiffQuery) => query.path === 'one.ts' ? one.promise : two.promise), { pane, context } = harness({ diffPatch });
    const first = pane.show({ kind: 'commit', oid: oid('a') }); await tick(); clickFile(pane, 'two.ts');
    expect(query(pane, '.file-list').querySelectorAll<StubNode>('.file-row').find(row => row.dataset.path === 'two.ts')?.classList.contains('selected')).toBe(true);
    one.resolve(patch('stale-one')); await first; expect(query(pane, '.diff-container').textContent).not.toContain('stale-one');
    two.resolve(patch('current-two')); await tick(); expect(query(pane, '.diff-container').textContent).toContain('current-two');
    const next = deferred<CommitDetail>(); (pane as unknown as { host: Host }).host.commitDetail = vi.fn(() => next.promise);
    const pending = pane.show({ kind: 'commit', oid: oid('b') }); context.repo = { ...context.repo!, id: 'different' }; next.resolve(detail(oid('b'))); await pending;
    expect(query(pane, '.commit-metadata').textContent).not.toContain(`Subject ${oid('b')}`); pane.destroy();
  });
  it('retries same-selection metadata failures and cancellation instead of replacing loading/error state with blank metadata', async () => {
    const gate = deferred<CommitDetail>(), commitDetail = vi.fn().mockRejectedValueOnce(new Error('metadata failed')).mockImplementationOnce(() => gate.promise).mockResolvedValue(detail()), { pane } = harness({ commitDetail });
    const selection = { kind: 'commit' as const, oid: oid('a') };
    await pane.show(selection); expect(query(pane, '.commit-metadata').textContent).toContain('metadata failed'); pane.updateSettings(); expect(query(pane, '.commit-metadata').textContent).toContain('metadata failed');
    const pending = pane.show(selection); await tick(); titled(query(pane, '.commit-metadata'), 'Cancel').fire('click');
    expect(query(pane, '.commit-metadata').textContent).toContain('cancelled'); const retry = pane.show(selection); await retry; gate.resolve(detail()); await pending;
    expect(commitDetail).toHaveBeenCalledTimes(3); expect(query(pane, '.diff-container').textContent).toContain('changed'); pane.destroy();
  });
  it('retries same-file patch failure/cancellation and does not fall back when diffPatch actually fails', async () => {
    const gate = deferred<DiffResult>(), diffPatch = vi.fn().mockRejectedValueOnce(new Error('patch failed')).mockImplementationOnce(() => gate.promise).mockResolvedValue(patch('retried')), { pane, host } = harness({ diffPatch });
    const selection = { kind: 'commit' as const, oid: oid('a') }; await pane.show(selection); expect(query(pane, '.diff-container').textContent).toContain('patch failed'); expect(host.diff).not.toHaveBeenCalled();
    const pending = pane.show(selection); await tick(); titled(query(pane, '.diff-container'), 'Cancel').fire('click');
    clickFile(pane, 'one.ts'); await tick(); expect(query(pane, '.diff-container').textContent).toContain('retried'); gate.resolve(patch('cancelled-result')); await pending;
    expect(query(pane, '.diff-container').textContent).not.toContain('cancelled-result'); expect(diffPatch).toHaveBeenCalledTimes(3); pane.destroy();
  });
  it('loads only the chosen side, remembers null completion, preserves patch identity, and discards stale side responses', async () => {
    const old = deferred<DiffResult>(), fileContent = vi.fn((_query: DiffQuery, side: 'old' | 'new') => side === 'old' ? old.promise : Promise.resolve({ ...patch(), newContent: null })), result = patch(), { pane, host } = harness({ fileContent, diffPatch: vi.fn(async () => result) });
    await pane.show({ kind: 'commit', oid: oid('a') }); const view = query(pane, '.diff-view');
    const mode = view.querySelector<StubNode>('select')!; mode.value = 'new'; mode.fire('change'); await tick(); expect(fileContent).toHaveBeenCalledOnce(); expect(query(pane, '.diff-container').textContent).toContain('Content unavailable');
    mode.value = 'diff'; mode.fire('change'); await tick(); changeMode({ element: view as unknown as HTMLElement }, 'new'); await tick(); expect(fileContent).toHaveBeenCalledOnce();
    changeMode({ element: view as unknown as HTMLElement }, 'old'); await tick(); expect(query(pane, '.diff-scroll').getAttribute('aria-busy')).toBe('true');
    clickFile(pane, 'two.ts'); await tick(); old.resolve({ ...patch(), oldContent: 'stale old file' }); await tick();
    expect(query(pane, '.diff-container').textContent).not.toContain('stale old file'); expect(result.oldContent).toBeNull(); expect(result.newContent).toBeNull(); expect(host.cancel).toHaveBeenCalled(); pane.destroy();
  });
  it('cancels and retries side loads locally, and never marks content/metadata prefetch as reviewed', async () => {
    const gate = deferred<DiffResult>(), fileContent = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue({ ...patch(), newContent: 'retry content' }), { pane, store } = harness({ fileContent });
    await pane.show({ kind: 'commit', oid: oid('a') }); const key = `commit:${oid('a')}:ROOT`; store.startReview(key, 'repo', { kind: 'commit', oid: oid('a') });
    changeMode({ element: query(pane, '.diff-view') as unknown as HTMLElement }, 'new'); await tick();
    expect(store.reviewed(key, 'repo').size).toBe(0); titled(query(pane, '.diff-scroll'), 'Cancel').fire('click'); expect(query(pane, '.diff-scroll').textContent).toContain('cancelled');
    titled(query(pane, '.diff-scroll'), 'Retry content').fire('click'); await tick(); expect(query(pane, '.diff-scroll').textContent).toContain('retry content'); gate.resolve({ ...patch(), newContent: 'stale cancelled' }); await tick();
    expect(query(pane, '.diff-scroll').textContent).not.toContain('stale cancelled'); expect(store.reviewed(key, 'repo').size).toBe(0);
    clickFile(pane, 'two.ts'); await tick(); expect([...store.reviewed(key, 'repo')]).toEqual(['two.ts']); pane.destroy();
  });
  it('supports legacy hosts and preserves immutable cache entries until explicit invalidation/refresh', async () => {
    const { pane, host, context } = harness({ diffPatch: undefined, fileContent: undefined }); const selection = { kind: 'commit' as const, oid: oid('a') };
    await pane.show(selection); changeMode({ element: query(pane, '.diff-view') as unknown as HTMLElement }, 'old'); await tick(); expect(query(pane, '.diff-scroll').textContent).toContain('old file'); expect(host.diff).toHaveBeenCalledOnce();
    await pane.show({ kind: 'commit', oid: oid('b') }); await pane.show(selection); expect(host.commitDetail).toHaveBeenCalledTimes(2); expect(host.diff).toHaveBeenCalledTimes(2);
    context.settings.mailmap = true; pane.invalidate(); pane.refresh(); await tick(); expect(host.commitDetail).toHaveBeenCalledTimes(3); expect(host.diff).toHaveBeenCalledTimes(3); pane.destroy();
  });
  it('never calls an unknown working tree clean or caches mutable comparisons', async () => {
    const { pane, context, host } = harness(); await pane.show({ kind: 'working' }); expect(query(pane, '.diff-container').textContent).toContain('not loaded'); expect(query(pane, '.commit-metadata').textContent).toContain('unknown');
    context.working = { files: [file('one.ts', { unstaged: true })], branch: 'main', ahead: 0, behind: 0, conflicts: 0, operation: null }; pane.refresh(); await tick();
    expect(host.diffPatch).toHaveBeenCalledOnce(); pane.refresh(); await tick(); expect(host.diffPatch).toHaveBeenCalledTimes(2); expect(cacheableDiff({ base: oid('a'), target: 'WORKTREE' })).toBe(false); pane.destroy();
  });
});

describe('changed-file virtualization and diff view reuse', () => {
  it('bounds mounted rows, updates selection/review in place, and keeps keyboard active descendants mounted', async () => {
    const files = Array.from({ length: 5000 }, (_, index) => file(`src/file${String(index).padStart(4, '0')}.ts`)), { pane, store } = harness({ commitDetail: vi.fn(async () => detail(oid('a'), files)) });
    await pane.show({ kind: 'commit', oid: oid('a') }); const list = query(pane, '.file-list'), first = list.querySelector<StubNode>('.file-row')!, count = list.querySelectorAll('.file-row').length;
    expect(count).toBeLessThan(40); const row = first; first.fire('click'); expect(list.querySelector('.file-row')).toBe(row);
    for (const offset of [24 * 24, 24 * 36, 24 * 20, 0]) {
      list.scrollTop = offset; list.fire('scroll'); flushFrames();
      const paths = list.querySelectorAll<StubNode>('.file-row').map(node => node.dataset.path);
      expect(paths).toEqual([...paths].sort()); expect(paths.length).toBeLessThan(40);
    }
    const key = `commit:${oid('a')}:ROOT`; store.startReview(key, 'repo', { kind: 'commit', oid: oid('a') }); list.fire('keydown', { key: 'End' }); await tick();
    expect(list.querySelectorAll('.file-row').length).toBeLessThan(40); const active = list.querySelectorAll<StubNode>('.file-row').find(node => node.id === list.getAttribute('aria-activedescendant'));
    expect(active?.dataset.path).toBe('src/file4999.ts'); expect(active?.style.height).toBe('24px'); expect(active?.getAttribute('aria-setsize')).toBe('5000');
    expect(store.reviewed(key, 'repo').has('src/file4999.ts')).toBe(true); list.fire('keydown', { key: 'Home' }); list.fire('keydown', { key: 'ArrowLeft' });
    expect(list.querySelectorAll('.file-row')).toHaveLength(0); expect(list.querySelector<StubNode>('.file-folder')?.getAttribute('aria-expanded')).toBe('false'); pane.destroy();
  });
  it('does not reparse or rebuild row models for unrelated settings, font, or repeated mode variants', () => {
    const models = vi.spyOn(PatchModelCache.prototype, 'prepare'), view = new DiffView(vi.fn(), vi.fn()), result = patch(), settings = structuredClone(DEFAULT_SETTINGS);
    view.set(result, settings); const first = models.mock.results[0].value;
    view.set(result, { ...settings, theme: 'light', fontSize: 18 }, false); expect(models).toHaveBeenCalledOnce(); expect((view as unknown as { lines: unknown }).lines).toBe(first.lines);
    view.set(result, { ...settings, diffView: 'split' }, false); const split = models.mock.results[1].value; expect(split).not.toBe(first);
    view.set(result, settings, false); expect(models).toHaveBeenCalledTimes(2); expect((view as unknown as { lines: unknown }).lines).toBe(first.lines);
    const cache = (view as unknown as { models: PatchModelCache }).models; expect(cache.parsePasses).toBe(1); expect(cache.rowPasses).toBe(2); view.destroy();
  });
  it('does not start cancelled queued side loads and never substitutes new content for an unavailable old side', async () => {
    const ensureContent = vi.fn(async () => ({ content: null, binary: false, truncated: false })), cancelContent = vi.fn(), view = new DiffView(vi.fn(), vi.fn());
    view.set({ ...patch(), newContent: 'must not appear on old side' }, structuredClone(DEFAULT_SETTINGS), true, { ensureContent, cancelContent });
    changeMode(view, 'new'); changeMode(view, 'diff'); await tick(); expect(ensureContent).not.toHaveBeenCalled();
    changeMode(view, 'old'); await tick(); expect(ensureContent).toHaveBeenCalledWith('old'); expect(query(view, '.diff-scroll').textContent).toContain('Content unavailable'); expect(query(view, '.diff-scroll').textContent).not.toContain('must not appear'); view.destroy();
  });
  it('limits large previews before materializing the rest and truthfully labels the limit', () => {
    const view = new DiffView(vi.fn(), vi.fn()), result = patch(); result.patch = `@@ -0,0 +1,${MAX_DIFF_LINES + 50} @@\n${'+x\n'.repeat(MAX_DIFF_LINES + 50)}`;
    view.set(result, structuredClone(DEFAULT_SETTINGS)); expect(query(view, '.diff-toolbar').textContent).toContain('Limited preview'); expect(query(view, '.diff-rows').children.length).toBeLessThan(40); view.destroy();
  });
});

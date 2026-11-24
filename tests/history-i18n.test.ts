import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileTreeCache, PatchModelCache } from '../src/lib/diff';
import { formatDate, formatFullDate } from '../src/lib/format';
import { initI18n, setLanguage } from '../src/lib/i18n';
import { HistoryLayoutCache } from '../src/lib/performance-models';
import { StateStore } from '../src/lib/state';
import { m, t } from '../src/i18n/history';
import { DEFAULT_SETTINGS, type ChangedFile, type Commit, type CommitDetail, type DiffResult, type Host, type Repository, type WorkingState } from '../src/shared/protocol';
import { DetailsPane } from '../src/ui/details';
import { DiffView, type DiffViewState, type LoadedContent } from '../src/ui/diff-view';
import { closeMenu, disposeBindings } from '../src/ui/dom';
import { CommitTable, type TableModel } from '../src/ui/table';

/** Presentation-only test double: real component methods, no DOM library or host/repository access. */
class PresentationNode {
  static all: PresentationNode[] = [];
  readonly tagName: string;
  readonly nodeName: string;
  readonly nodeType: number;
  parentNode: PresentationNode | null = null;
  children: PresentationNode[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, ((event: PresentationEvent) => void)[]>();
  className = ''; id = ''; title = ''; placeholder = ''; value = ''; type = '';
  checked = false; hidden = false; disabled = false; open = false; tabIndex = -1;
  selectionStart = 0; selectionEnd = 0; selectionDirection = 'none';
  scrollTop = 0; scrollLeft = 0; clientHeight = 240; clientWidth = 1000;
  replacements = 0; text = '';
  style: Record<string, unknown> = { setProperty: (name: string, value: string) => { this.style[name] = value; }, getPropertyValue: () => '' };
  constructor(tag = 'div', text = '') {
    this.tagName = tag.startsWith('#') ? tag : tag.toUpperCase(); this.nodeName = this.tagName;
    this.nodeType = tag === '#text' ? 3 : tag === '#fragment' ? 11 : 1; this.text = text;
    PresentationNode.all.push(this);
  }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    toggle: (name: string, force?: boolean) => { const enabled = force ?? !this.classList.contains(name); if (enabled) this.classList.add(name); else this.classList.remove(name); return enabled; },
  };
  get parentElement(): PresentationNode | null { return this.parentNode; }
  get firstElementChild(): PresentationNode | null { return this.children.find(node => node.nodeType === 1) ?? null; }
  get childElementCount(): number { return this.children.filter(node => node.nodeType === 1).length; }
  get nextElementSibling(): PresentationNode | null {
    const siblings = this.parentNode?.children ?? [], index = siblings.indexOf(this);
    return siblings.slice(index + 1).find(node => node.nodeType === 1) ?? null;
  }
  get isConnected(): boolean { return this === dom.body || Boolean(this.parentNode?.isConnected); }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value: string) { for (const child of this.children) child.parentNode = null; this.children = []; this.text = value; }
  appendChild(child: PresentationNode): PresentationNode { this.append(child); return child; }
  append(...children: (PresentationNode | string)[]): void {
    for (const child of children) {
      if (typeof child === 'string') this.append(new PresentationNode('#text', child));
      else if (child.nodeType === 11) { for (const node of [...child.children]) this.append(node); }
      else { child.remove(); child.parentNode = this; this.children.push(child); }
    }
  }
  insertBefore(child: PresentationNode, before: PresentationNode | null): PresentationNode {
    child.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentNode = this; return child;
  }
  replaceChildren(...children: PresentationNode[]): void { this.replacements++; this.textContent = ''; this.append(...children); }
  remove(): void { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'title') this.title = value;
    if (name === 'placeholder') this.placeholder = value;
  }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, listener: (event: PresentationEvent) => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  removeEventListener(name: string, listener: (event: PresentationEvent) => void): void { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== listener)); }
  fire(name: string, extra: Partial<PresentationEvent> = {}): PresentationEvent {
    const event = { target: this, key: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    for (const listener of this.listeners.get(name) ?? []) listener(event); return event;
  }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector === 'input[type="checkbox"]') return this.tagName === 'INPUT' && this.type === 'checkbox';
    if (selector.startsWith('[data-')) {
      const key = selector.slice(6, -1).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      return Object.hasOwn(this.dataset, key);
    }
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll<T = PresentationNode>(selector: string): T[] {
    const found: PresentationNode[] = [];
    for (const child of this.children) { if (selector.split(',').some(item => child.matches(item.trim()))) found.push(child); found.push(...child.querySelectorAll<PresentationNode>(selector)); }
    return found as T[];
  }
  querySelector<T = PresentationNode>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  closest(selector: string): PresentationNode | null { return selector.split(',').some(item => this.matches(item.trim())) ? this : this.parentNode?.closest(selector) ?? null; }
  contains(node: PresentationNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
  focus(): void { dom.activeElement = this; }
  scrollIntoView(): void {}
  getBoundingClientRect() { return { left: 0, right: this.clientWidth, top: 0, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  getContext(): null { return null; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
}
interface PresentationEvent {
  target: PresentationNode; key: string; preventDefault: () => void; stopPropagation: () => void;
  ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; clientX?: number; clientY?: number;
}
const dom = {
  body: new PresentationNode('body'), documentElement: new PresentationNode('html'), activeElement: null as PresentationNode | null,
  createElement: (tag: string) => new PresentationNode(tag), createElementNS: (_namespace: string, tag: string) => new PresentationNode(tag),
  createTextNode: (text: string) => new PresentationNode('#text', text), createDocumentFragment: () => new PresentationNode('#fragment'),
  getElementById: (id: string) => PresentationNode.all.find(node => node.id === id) ?? null,
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
};
let frames: Map<number, FrameRequestCallback>, nextFrame = 0;
const live: { destroy(): void }[] = [];
function flushFrames(): void { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); }
async function tick(): Promise<void> { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const oid = (value: string) => value.repeat(40);
const commit = (id = oid('a'), extra: Partial<Commit> = {}): Commit => ({ oid: id, parents: [], subject: 'Read only', author: 'Working tree', email: 'Commit history@example.test', authoredAt: 1_769_432_400, committedAt: 1_769_436_000, refs: [], ...extra });
const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, oldPath: null, status: 'M', additions: 12, deletions: 3, staged: false, unstaged: true, ...extra });
const detail = (files = [file('Working tree.ts'), file('No changed files.ts')], extra: Partial<CommitDetail> = {}): CommitDetail => ({ commit: commit(), base: null, body: 'Read-only diff\n\nWorking tree', committer: 'Committed by', committerEmail: 'Author@example.test', signature: { status: 'N', signer: '', key: '' }, files, ...extra });
const patch = (extra: Partial<DiffResult> = {}): DiffResult => ({ patch: '@@ -1 +1 @@\n-Read only\n+Working tree\n', binary: false, truncated: false, oldContent: null, newContent: null, ...extra });
function node(element: HTMLElement): PresentationNode { return element as unknown as PresentationNode; }
function query(root: PresentationNode, selector: string): PresentationNode { const found = root.querySelector(selector); if (!found) throw new Error(`Missing ${selector}`); return found; }
function titled(root: PresentationNode, title: string): PresentationNode { const found = root.querySelectorAll<PresentationNode>('button').find(button => button.title === title); if (!found) throw new Error(`Missing button ${title}`); return found; }
function mode(view: DiffView, value: DiffViewState['mode']): void { const select = query(node(view.element), 'select'); select.value = value; select.fire('change'); }
function spyMethods(instance: object, names: readonly string[]) { return names.map(name => vi.spyOn(instance as Record<string, () => unknown>, name)); }
function expectNotCalled(spies: ReturnType<typeof vi.spyOn>[]): void { for (const spy of spies) expect(spy).not.toHaveBeenCalled(); }
function calls(host: Host): Record<string, number> { return Object.fromEntries(Object.entries(host).filter(([, value]) => vi.isMockFunction(value)).map(([name, value]) => [name, vi.mocked(value).mock.calls.length])); }
function makePane(overrides: Partial<Host> = {}, working: WorkingState | null = null, initialDetail = detail()) {
  const repo: Repository = { id: 'fixture', path: 'D:/synthetic-fixture', name: 'fixture', gitDir: '', commonDir: '', head: oid('a'), branch: 'main', trusted: false, bare: false };
  const context = { repo, settings: structuredClone(DEFAULT_SETTINGS), working };
  const host = { cancel: vi.fn(async () => {}), commitDetail: vi.fn(async () => initialDetail), compare: vi.fn(async () => initialDetail.files), diffPatch: vi.fn(async () => patch()), fileContent: vi.fn(async () => ({ ...patch(), newContent: 'Read only\nWorking tree\n' })), diff: vi.fn(async () => patch()), ...overrides } as unknown as Host;
  const store = new StateStore(vi.fn(async () => {}), vi.fn()); store.queue = vi.fn();
  const callbacks = { context: () => context, settings: vi.fn(), error: vi.fn(), copy: vi.fn(), action: vi.fn(), close: vi.fn(), follow: vi.fn(), ensureTrust: vi.fn(async () => true), openUrl: vi.fn(), changed: vi.fn() };
  const pane = new DetailsPane(host, store, callbacks); live.push(pane); dom.body.append(node(pane.element));
  return { pane, context, host, store, callbacks };
}
function makeView(result = patch()) {
  const view = new DiffView(vi.fn(), vi.fn()); live.push(view); dom.body.append(node(view.element)); view.set(result, structuredClone(DEFAULT_SETTINGS)); return view;
}

beforeEach(() => {
  PresentationNode.all = []; dom.body = new PresentationNode('body'); dom.documentElement = new PresentationNode('html'); dom.activeElement = null;
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal('Node', PresentationNode); vi.stubGlobal('Element', PresentationNode); vi.stubGlobal('HTMLElement', PresentationNode);
  vi.stubGlobal('HTMLInputElement', PresentationNode); vi.stubGlobal('HTMLSelectElement', PresentationNode); vi.stubGlobal('HTMLTextAreaElement', PresentationNode);
  vi.stubGlobal('document', dom); vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++nextFrame; frames.set(id, callback); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900, getSelection: () => null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  initI18n('en', ['en']);
});
afterEach(() => {
  closeMenu(); for (const component of live.splice(0)) component.destroy();
  for (const candidate of PresentationNode.all) disposeBindings(candidate as unknown as Node);
  initI18n('en', ['en']); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('history presentation-only locale changes', () => {
  it('updates mounted labels/dates/ARIA while preserving rows, refs, inline details, scroll and autoload state', () => {
    const refs: Commit['refs'] = [{ name: 'Working tree', fullName: 'refs/heads/Working tree', oid: oid('a'), kind: 'branch', upstream: null, current: true, subject: 'Commit' }];
    const commits = [commit(oid('a'), { refs, parents: [oid('b'), oid('c')] }), commit(oid('b'), { subject: '' }), ...Array.from({ length: 80 }, (_, index) => commit(`c${String(index).padStart(39, '0')}`))];
    const working: WorkingState = { files: [file('Graph.ts')], branch: 'main', ahead: 1, behind: 2, conflicts: 3, operation: 'rebase' };
    const layout = new HistoryLayoutCache(), graph = layout.prepare({ commits, visible: commits, topologyRevision: 1, workingHead: oid('a') });
    const inline = new PresentationNode('aside'); inline.append(new PresentationNode('input')); inline.text = 'Working tree';
    const callbacks = { select: vi.fn(), context: vi.fn(), refContext: vi.fn(), loadMore: vi.fn(), widths: vi.fn(), copy: vi.fn() };
    const table = new CommitTable(callbacks); live.push(table); dom.body.append(node(table.element));
    const model: TableModel = { commits, working, graph, settings: { ...structuredClone(DEFAULT_SETTINGS), autoLoad: true, avatars: false }, selected: oid('a'), compareBase: oid('b'), head: oid('a'), hasMore: true, loading: false, totalLoaded: 1000, inline: { oid: oid('a'), height: 80, element: inline as unknown as HTMLElement } };
    table.setModel(model); flushFrames();
    const root = node(table.element), header = query(root, '.table-header'), rows = query(root, '.commit-rows').children.slice();
    const ref = query(root, '[data-ref]'), workingRow = rows[0], date = query(rows[1], '.date-cell'), dateBefore = date.textContent;
    const inlineSlot = query(root, '.inline-detail-slot'), inlineCell = query(root, '.inline-detail-cell');
    ref.focus(); node(table.viewport).scrollTop = 31; node(table.viewport).scrollLeft = 9;
    // A generic render would hit autoLoad here: leave its model at the end without issuing a scroll event.
    node(table.viewport).scrollTop = 100_000;
    const hookSpies = spyMethods(table, ['setModel', 'render', 'schedule', 'renderHeader', 'drawGraph']);
    const prepare = vi.spyOn(layout, 'prepare'), passes = layout.preparePasses, revisions = (table as unknown as { version: number; graphRevision: number }).version;
    const frameCount = frames.size;
    setLanguage('zh-CN'); table.updateLocale();
    expectNotCalled(hookSpies); expect(prepare).not.toHaveBeenCalled(); expect(layout.preparePasses).toBe(passes);
    expect(callbacks.loadMore).not.toHaveBeenCalled(); expect(frames.size).toBe(frameCount);
    expect(query(root, '.table-header')).toBe(header); expect(query(root, '.commit-rows').children).toEqual(rows);
    expect(query(root, '[data-ref]')).toBe(ref); expect(dom.activeElement).toBe(ref); expect(ref.textContent).toBe('Working tree');
    expect(query(root, '.commit-subject').textContent).toBe('Read only'); expect(query(rows[1], '.author-cell').textContent).toBe('Working tree');
    expect(header.textContent).toContain('提交图'); expect(root.getAttribute('aria-label')).toContain('提交历史');
    expect(query(header, '.resize-handle').getAttribute('aria-label')).toBe('调整提交图列宽');
    expect(workingRow.textContent).toContain('工作区'); expect(workingRow.textContent).toContain('1 个更改文件'); expect(workingRow.textContent).toContain('变基中'); expect(workingRow.textContent).toContain('3 个冲突');
    expect(query(rows[1], '.graph-cell').getAttribute('aria-label')).toBe('合并提交');
    expect(query(rows[2], '.commit-subject').textContent).toBe('（无主题）');
    expect(date.textContent).toBe(formatDate(commits[0].authoredAt, model.settings.dateFormat)); expect(date.textContent).not.toBe(dateBefore);
    expect(date.title).toBe(formatFullDate(commits[0].authoredAt));
    expect(query(root, '.history-count').textContent).toContain('已加载 1,000 条');
    expect(query(root, '.table-footer').textContent).toContain('加载更多提交');
    expect(inlineSlot.getAttribute('aria-label')).toBe('所选提交的详情'); expect(inlineCell.firstElementChild).toBe(inline);
    expect(inline.textContent).toBe('Working tree'); expect(table.scrollTop).toBe(100_000); expect(node(table.viewport).scrollLeft).toBe(9);
    expect(rows[1].getAttribute('aria-selected')).toBe('true'); expect(rows[2].classList.contains('compare-base')).toBe(true);
    expect((table as unknown as { version: number }).version).toBe(revisions);
    setLanguage('en'); table.updateLocale(); expect(date.textContent).toBe(dateBefore); expect(ref.textContent).toBe('Working tree');
    expectNotCalled(hookSpies); expect(callbacks.loadMore).not.toHaveBeenCalled();
  });

  it('localizes newly materialized virtual rows and loading labels without invalidating cached row identity', () => {
    const commits = Array.from({ length: 100 }, (_, index) => commit(`${index.toString(16).padStart(40, '0')}`, { nodeKind: 'stash' }));
    const callbacks = { select: vi.fn(), context: vi.fn(), refContext: vi.fn(), loadMore: vi.fn(), widths: vi.fn(), copy: vi.fn() };
    const table = new CommitTable(callbacks); live.push(table); dom.body.append(node(table.element));
    const model: TableModel = { commits, graph: [], working: null, settings: { ...structuredClone(DEFAULT_SETTINGS), avatars: false, autoLoad: false }, selected: null, compareBase: null, head: null, hasMore: true, loading: true, totalLoaded: commits.length };
    table.setModel(model); flushFrames(); const first = query(node(table.element), '.commit-row');
    setLanguage('zh-CN'); table.updateLocale();
    expect(query(node(table.element), '.commit-row')).toBe(first); expect(query(first, '.graph-cell').getAttribute('aria-label')).toBe('贮藏');
    const load = titled(node(table.element), '加载中…'); expect(load.disabled).toBe(true); expect(load.textContent).toContain('加载中…');
    node(table.viewport).scrollTop = 1000; node(table.viewport).fire('scroll'); flushFrames();
    const newlyVisible = query(node(table.element), '.commit-row'); expect(newlyVisible).not.toBe(first); expect(query(newlyVisible, '.graph-cell').getAttribute('aria-label')).toBe('贮藏');
    setLanguage('en'); table.updateLocale(); expect(query(newlyVisible, '.graph-cell').getAttribute('aria-label')).toBe('Stash');
    expect(callbacks.loadMore).not.toHaveBeenCalled();
  });
});

describe('details presentation-only locale changes', () => {
  it('preserves filter/focus/caret, review state, merge controls, full message, diff mode and selected text without IO or preparation', async () => {
    const initial = detail([file('Working tree.ts', { submodule: { commitChanged: true, modified: false, untracked: true } }), file('No changed files.ts')], { commit: commit(oid('a'), { parents: [oid('b'), oid('c')] }), base: oid('b') });
    const { pane, store, host, callbacks, context } = makePane({}, null, initial); context.settings.dateFormat = 'local';
    await pane.show({ kind: 'commit', oid: oid('a') });
    const root = node(pane.element), key = `commit:${oid('a')}:${oid('b')}`;
    titled(root, 'Start review').fire('click');
    const list = query(root, '.file-list'), selected = list.querySelectorAll<PresentationNode>('.file-row').find(row => row.dataset.path === 'Working tree.ts')!;
    selected.fire('click'); await tick();
    const body = query(root, '.message-body'); body.open = true;
    const parent = query(query(root, '.parent-row'), 'select'), metadata = query(root, '.commit-metadata'); metadata.scrollTop = 28;
    const filter = query(root, '.file-filter'); filter.value = 'Working'; filter.fire('input'); filter.selectionStart = 2; filter.selectionEnd = 5; filter.selectionDirection = 'forward'; filter.focus();
    const currentRow = query(root, '.file-row'), checkbox = query(currentRow, 'input[type="checkbox"]'); list.scrollTop = 34;
    const view = (pane as unknown as { diffView: DiffView }).diffView;
    mode(view, 'new'); await tick(); const diff = query(root, '.diff-scroll'); diff.scrollTop = 42; diff.scrollLeft = 17;
    diff.fire('keydown', { key: 'a', ctrlKey: true });
    const modeControl = query(query(root, '.diff-toolbar'), 'select');
    const beforeView = pane.view, beforeReview = structuredClone(store.state.reviews), beforeCalls = calls(host);
    const beforeQueue = vi.mocked(store.queue).mock.calls.length, beforeChanged = callbacks.changed.mock.calls.length;
    const noWork = spyMethods(pane, ['show', 'refresh', 'updateSettings', 'selectFile', 'renderHeader', 'renderMetadata', 'renderFileToolbar', 'renderFiles', 'renderDiffHeader', 'renderFileWindow', 'updateFileRows']);
    const noDiffWork = spyMethods(view, ['set', 'build', 'render', 'requestContent', 'changeMode']);
    const noTree = vi.spyOn(FileTreeCache.prototype, 'get'), noModels = vi.spyOn(PatchModelCache.prototype, 'prepare');
    const beforeMode = view.getState(), beforeFrames = frames.size;
    setLanguage('zh-CN'); pane.updateLocale();
    expectNotCalled(noWork); expectNotCalled(noDiffWork); expect(noTree).not.toHaveBeenCalled(); expect(noModels).not.toHaveBeenCalled();
    expect(calls(host)).toEqual(beforeCalls); expect(store.state.reviews).toEqual(beforeReview); expect(vi.mocked(store.queue).mock.calls.length).toBe(beforeQueue);
    expect(callbacks.changed.mock.calls.length).toBe(beforeChanged); expect(frames.size).toBe(beforeFrames); expect(view.getState()).toEqual(beforeMode); expect(pane.view).toEqual(beforeView);
    expect(query(root, '.file-filter')).toBe(filter); expect(filter.value).toBe('Working'); expect(filter.selectionStart).toBe(2); expect(filter.selectionEnd).toBe(5); expect(filter.selectionDirection).toBe('forward'); expect(dom.activeElement).toBe(filter);
    expect(filter.placeholder).toBe('筛选文件'); expect(filter.getAttribute('aria-label')).toBe('筛选更改文件');
    expect(query(root, '.file-row')).toBe(currentRow); expect(query(currentRow, 'input[type="checkbox"]')).toBe(checkbox); expect(checkbox.checked).toBe(true); expect(checkbox.getAttribute('aria-label')).toBe('将 Working tree.ts 标记为已审阅');
    expect(currentRow.title).toBe('Working tree.ts\n新增 12 行，删除 3 行'); expect(currentRow.textContent).toContain('子模块');
    expect(currentRow.querySelectorAll<PresentationNode>('.badge').find(badge => badge.textContent === '子模块')?.title).toBe('提交已更改：是；已修改：否；未跟踪：是');
    expect(query(root, '.message-body')).toBe(body); expect(body.open).toBe(true); expect(body.textContent).toContain('完整消息'); expect(body.textContent).toContain('Read-only diff\n\nWorking tree');
    expect(query(query(root, '.parent-row'), 'select')).toBe(parent); expect(parent.value).toBe(oid('b')); expect(parent.getAttribute('aria-label')).toBe('合并父提交');
    expect(metadata.scrollTop).toBe(28); expect(list.scrollTop).toBe(34); expect(query(root, '.detail-summary').title).toContain('创作时间：');
    expect(query(root, '.detail-subject').textContent).toBe('Read only'); expect(metadata.textContent).toContain('Working tree <Commit history@example.test>');
    expect(titled(root, '审阅进行中').getAttribute('aria-pressed')).toBe('true'); expect(store.reviewed(key, 'fixture').has('Working tree.ts')).toBe(true);
    expect(query(query(root, '.diff-toolbar'), 'select')).toBe(modeControl); expect(modeControl.value).toBe('new'); expect(modeControl.textContent).toContain('新文件 · 只读');
    expect(diff.classList.contains('all-selected')).toBe(true); expect(diff.getAttribute('aria-label')).toBe('已选择所有差异内容。按 Control C 复制。'); expect(diff.textContent).toContain('Read only'); expect(diff.textContent).toContain('Working tree');
    setLanguage('en'); pane.updateLocale(); expect(query(root, '.file-filter')).toBe(filter); expect(filter.placeholder).toBe('Filter files'); expect(query(root, '.file-row')).toBe(currentRow);
    expect(calls(host)).toEqual(beforeCalls); expectNotCalled(noWork); expectNotCalled(noDiffWork);
  });

  it('localizes new virtual file rows, review labels and counts without affecting reviewed membership', async () => {
    const files = Array.from({ length: 1200 }, (_, index) => file(`src/Working tree ${String(index).padStart(4, '0')}.ts`));
    const { pane, host, store } = makePane({}, null, detail(files)); await pane.show({ kind: 'commit', oid: oid('a') });
    const root = node(pane.element), list = query(root, '.file-list'); titled(root, 'Start review').fire('click');
    const beforeCalls = calls(host), reviewed = structuredClone(store.state.reviews);
    setLanguage('zh-CN'); pane.updateLocale();
    expect(list.querySelectorAll('.file-row').length).toBeLessThan(40); expect(query(root, '.review-count').textContent).toBe('0/1,200');
    list.scrollTop = 24 * 600; list.fire('scroll'); flushFrames();
    const row = query(list, '.file-row'), check = query(row, 'input[type="checkbox"]');
    expect(check.getAttribute('aria-label')).toBe(`将 ${row.dataset.path} 标记为已审阅`); expect(row.title).toContain('新增 12 行，删除 3 行');
    expect(calls(host)).toEqual(beforeCalls); expect(store.state.reviews).toEqual(reviewed); expect(list.querySelectorAll('.file-row').length).toBeLessThan(40);
    setLanguage('en'); pane.updateLocale(); expect(query(list, '.file-row')).toBe(row); expect(check.getAttribute('aria-label')).toBe(`Mark ${row.dataset.path} reviewed`);
  });

  it('keeps loading, cancellation and raw error content intact while translating retries and known summaries in place', async () => {
    const metadata = deferred<CommitDetail>(), { pane, host } = makePane({ commitDetail: vi.fn(() => metadata.promise) });
    const pending = pane.show({ kind: 'commit', oid: oid('a') }), root = node(pane.element), loadingState = query(root, '.loading-state');
    const noWork = spyMethods(pane, ['show', 'refresh', 'updateSettings', 'selectFile']); const before = calls(host);
    setLanguage('zh-CN'); pane.updateLocale(); expect(query(root, '.loading-state')).toBe(loadingState); expect(loadingState.textContent).toContain('正在加载详情…'); expect(titled(loadingState, '取消').textContent).toBe('取消'); expect(calls(host)).toEqual(before); expectNotCalled(noWork);
    titled(loadingState, '取消').fire('click'); const cancelled = query(root, '.empty-state'), cancelledCalls = calls(host);
    setLanguage('en'); pane.updateLocale(); expect(query(root, '.empty-state')).toBe(cancelled); expect(cancelled.textContent).toBe('Details loading cancelled'); expect(titled(root, 'Retry')).toBeTruthy(); expect(calls(host)).toEqual(cancelledCalls);
    metadata.resolve(detail()); await pending;
    const raw = 'fatal: Working tree.ts: Read only\nCommit history', failed = makePane({ commitDetail: vi.fn(async () => { throw { code: 'ARGUMENT', message: raw, detail: 'No changed files' }; }) });
    await failed.pane.show({ kind: 'commit', oid: oid('a') }); const error = query(node(failed.pane.element), '.inline-error'), failedBefore = calls(failed.host);
    setLanguage('zh-CN'); failed.pane.updateLocale(); expect(query(node(failed.pane.element), '.inline-error')).toBe(error); expect(error.textContent).toContain('无法接受此请求'); expect(error.textContent).toContain(raw); expect(error.textContent).toContain('No changed files'); expect(error.textContent).toContain('重试'); expect(calls(failed.host)).toEqual(failedBefore);
  });

  it('localizes patch loading/errors and empty working views without retrying or changing working-mode controls', async () => {
    const diff = deferred<DiffResult>(), { pane, host } = makePane({ diffPatch: vi.fn(() => diff.promise) });
    const pending = pane.show({ kind: 'commit', oid: oid('a') }); await tick(); const root = node(pane.element), loadingState = query(query(root, '.diff-container'), '.loading-state'), before = calls(host);
    setLanguage('zh-CN'); pane.updateLocale(); expect(query(query(root, '.diff-container'), '.loading-state')).toBe(loadingState); expect(loadingState.textContent).toContain('正在加载差异'); expect(calls(host)).toEqual(before);
    diff.reject({ code: 'TIMEOUT', message: 'Git says Read only' }); await pending; const inline = query(query(root, '.diff-container'), '.inline-error'), failed = calls(host);
    expect(inline.textContent).toContain('Git 操作超时'); expect(inline.textContent).toContain('Git says Read only');
    setLanguage('en'); pane.updateLocale(); expect(query(query(root, '.diff-container'), '.inline-error')).toBe(inline); expect(inline.textContent).toContain('Retry diff'); expect(calls(host)).toEqual(failed);
    const working: WorkingState = { files: [file('Working tree.ts', { staged: true, unstaged: false })], branch: 'main', ahead: 12, behind: 3, conflicts: 0, operation: null };
    const workingPane = makePane({}, working); await workingPane.pane.show({ kind: 'working' }); const workingRoot = node(workingPane.pane.element), control = query(query(workingRoot, '.working-controls'), 'select');
    control.value = 'unstaged'; control.fire('change'); const emptyView = query(query(workingRoot, '.diff-container'), '.empty-state'), workingBefore = calls(workingPane.host); control.focus();
    setLanguage('zh-CN'); workingPane.pane.updateLocale(); expect(query(query(workingRoot, '.working-controls'), 'select')).toBe(control); expect(control.value).toBe('unstaged'); expect(control.getAttribute('aria-label')).toBe('工作区更改'); expect(dom.activeElement).toBe(control); expect(control.textContent).toContain('未暂存 · 暂存区 → 工作区'); expect(emptyView.textContent).toBe('此视图中没有文件'); expect(workingRoot.textContent).toContain('领先 12 · 落后 3'); expect(workingRoot.textContent).toContain('只读查看'); expect(calls(workingPane.host)).toEqual(workingBefore);
    const unknown = makePane(); await unknown.pane.show({ kind: 'working' }); expect(node(unknown.pane.element).textContent).toContain('尚未加载工作区状态'); expect(node(unknown.pane.element).textContent).not.toContain('工作区干净');
  });

  it('keeps open localized menus and signature output raw without retriggering their actions', async () => {
    const verify = vi.fn(async () => ({ kind: 'commit' as const, oid: oid('a'), status: 'valid' as const, signer: 'Working tree', key: 'Commit history', output: 'Read only\nNo changed files' }));
    const { pane, host } = makePane({ verify }); await pane.show({ kind: 'commit', oid: oid('a') }); const root = node(pane.element);
    titled(root, 'Details position').fire('click'); const menu = query(dom.body, '.context-menu'), first = query(menu, 'button');
    setLanguage('zh-CN'); pane.updateLocale(); expect(query(dom.body, '.context-menu')).toBe(menu); expect(query(menu, 'button')).toBe(first); expect(menu.textContent).toBe('行内底部右侧'); expect(dom.activeElement).toBe(first);
    closeMenu(); titled(root, '验证签名…').fire('click'); await tick(); const dialog = query(dom.body, 'dialog'), output = query(dialog, '.output-text'), before = calls(host);
    expect(output.textContent).toContain('有效\n签名者：Working tree\n密钥：Commit history'); expect(output.textContent).toContain('Read only\nNo changed files');
    setLanguage('en'); pane.updateLocale(); expect(query(dom.body, 'dialog')).toBe(dialog); expect(query(dialog, '.output-text')).toBe(output); expect(output.textContent).toContain('valid\nSigner: Working tree\nKey: Commit history'); expect(output.textContent).toContain('Read only\nNo changed files'); expect(calls(host)).toEqual(before); expect(verify).toHaveBeenCalledOnce();
    titled(dialog, 'Close dialog').fire('click'); await tick();
  });
});

describe('diff presentation-only locale changes', () => {
  it('preserves rendered diff nodes, selection, toolbar focus and scroll with no render/model/content work', () => {
    const view = makeView(), root = node(view.element), viewport = query(root, '.diff-scroll'), rows = query(root, '.diff-rows').children.slice(), toolbar = query(root, '.diff-toolbar'), control = query(toolbar, 'select');
    const noWork = spyMethods(view, ['build', 'render', 'set', 'changeMode', 'requestContent']); const prepare = vi.spyOn(PatchModelCache.prototype, 'prepare');
    viewport.scrollTop = 37; viewport.scrollLeft = 19; viewport.fire('keydown', { key: 'a', ctrlKey: true }); control.focus(); const before = view.getState();
    setLanguage('zh-CN'); view.updateLocale();
    expectNotCalled(noWork); expect(prepare).not.toHaveBeenCalled(); expect(view.getState()).toEqual(before); expect(query(root, '.diff-rows').children).toEqual(rows); expect(query(root, '.diff-toolbar')).toBe(toolbar); expect(query(toolbar, 'select')).toBe(control); expect(dom.activeElement).toBe(control); expect(control.value).toBe('diff'); expect(control.textContent).toBe('更改新文件 · 只读旧文件 · 只读');
    expect(titled(toolbar, '并排差异').getAttribute('aria-pressed')).toBe('false'); expect(viewport.getAttribute('aria-label')).toBe('已选择所有差异内容。按 Control C 复制。'); expect(viewport.textContent).toContain('Read only'); expect(viewport.textContent).toContain('Working tree');
    setLanguage('en'); view.updateLocale(); expect(query(root, '.diff-rows').children).toEqual(rows); expectNotCalled(noWork);
  });

  it('leaves a chosen lazy side loading while localizing controls and cancellation/retry state', async () => {
    const pending = deferred<LoadedContent>(), ensureContent = vi.fn(() => pending.promise), cancelContent = vi.fn();
    const view = makeView(); view.set(patch(), structuredClone(DEFAULT_SETTINGS), true, { ensureContent, cancelContent }); mode(view, 'old'); await tick();
    const root = node(view.element), viewport = query(root, '.diff-scroll'), loadingState = query(viewport, '.loading-state'), control = query(query(root, '.diff-toolbar'), 'select'); control.focus();
    const noWork = spyMethods(view, ['build', 'render', 'set', 'requestContent', 'changeMode']);
    setLanguage('zh-CN'); view.updateLocale(); expect(query(viewport, '.loading-state')).toBe(loadingState); expect(loadingState.textContent).toContain('正在加载旧文件'); expect(viewport.getAttribute('aria-busy')).toBe('true'); expect(control.value).toBe('old'); expect(query(query(root, '.diff-toolbar'), 'select')).toBe(control); expect(dom.activeElement).toBe(control); expect(ensureContent).toHaveBeenCalledOnce(); expect(cancelContent).not.toHaveBeenCalled(); expectNotCalled(noWork);
    titled(loadingState, '取消').fire('click'); const cancelled = query(viewport, '.inline-error');
    setLanguage('en'); view.updateLocale(); expect(query(viewport, '.inline-error')).toBe(cancelled); expect(cancelled.textContent).toContain('Content loading cancelled'); expect(titled(cancelled, 'Retry content')).toBeTruthy(); expect(ensureContent).toHaveBeenCalledOnce(); expect(cancelContent).toHaveBeenCalledOnce();
    pending.resolve({ content: 'stale Working tree', binary: false, truncated: false }); await tick(); expect(viewport.textContent).not.toContain('stale Working tree');
  });

  it.each([
    { name: 'binary', result: patch({ binary: true }), title: '二进制文件', hint: '使用已配置的外部差异工具' },
    { name: 'no differences', result: patch({ patch: '' }), title: '没有文本差异', hint: '选择“新文件”或“旧文件”' },
    { name: 'raw header', result: patch({ patch: 'Read only\nWorking tree' }), title: '没有文本差异块', hint: 'Read only\nWorking tree' },
    { name: 'truncated', result: patch({ patch: '', truncated: true }), title: '预览受限 · 内容不可用', hint: '空补丁并不代表没有更改' },
  ])('localizes $name placeholders in place without attempting a lazy content load', ({ result, title, hint }) => {
    const ensureContent = vi.fn(async () => ({ content: '', binary: false, truncated: false })), view = makeView(); view.set(result, structuredClone(DEFAULT_SETTINGS), true, { ensureContent, cancelContent: vi.fn() });
    const root = node(view.element), placeholder = query(root, '.empty-state'), noWork = spyMethods(view, ['build', 'render', 'requestContent']);
    setLanguage('zh-CN'); view.updateLocale(); expect(query(root, '.empty-state')).toBe(placeholder); expect(placeholder.textContent).toContain(title); expect(placeholder.textContent).toContain(hint); expect(ensureContent).not.toHaveBeenCalled(); expectNotCalled(noWork);
  });

  it('localizes content-unavailable, binary-side, empty-file, limited and raw-content error states', async () => {
    const cases = [
      { data: { content: null, binary: false, truncated: false }, expected: '此侧不存在' },
      { data: { content: null, binary: true, truncated: false }, expected: '二进制文件内容不会解码为文本' },
      { data: { content: '', binary: false, truncated: false }, expected: '空文件' },
      { data: { content: 'Working tree\n', binary: false, truncated: true }, expected: 'Working tree' },
    ];
    for (const item of cases) {
      initI18n('en', ['en']); const view = makeView(), ensureContent = vi.fn(async () => item.data); view.set(patch(), structuredClone(DEFAULT_SETTINGS), true, { ensureContent, cancelContent: vi.fn() }); mode(view, 'new'); await tick();
      const root = node(view.element), rows = query(root, '.diff-rows').children.slice(), noWork = spyMethods(view, ['build', 'render', 'requestContent']);
      setLanguage('zh-CN'); view.updateLocale(); expect(query(root, '.diff-rows').children).toEqual(rows); expect(root.textContent).toContain(item.expected); expect(ensureContent).toHaveBeenCalledOnce(); expectNotCalled(noWork);
      if (item.data.truncated) expect(query(root, '.diff-toolbar').textContent).toContain('预览受限');
    }
    const view = makeView(), ensureContent = vi.fn(async () => { throw { code: 'TIMEOUT', message: 'Read only: Working tree', detail: 'Commit history' }; });
    view.set(patch(), structuredClone(DEFAULT_SETTINGS), true, { ensureContent, cancelContent: vi.fn() }); mode(view, 'new'); await tick(); const error = query(node(view.element), '.inline-error');
    setLanguage('en'); view.updateLocale(); setLanguage('zh-CN'); view.updateLocale(); expect(query(node(view.element), '.inline-error')).toBe(error); expect(error.textContent).toContain('Git 操作超时'); expect(error.textContent).toContain('Read only: Working tree\nCommit history'); expect(error.textContent).toContain('重试内容'); expect(ensureContent).toHaveBeenCalledOnce();
  });

  it('disposes mounted presentation bindings when panes are destroyed', async () => {
    const { pane } = makePane(); await pane.show({ kind: 'commit', oid: oid('a') }); const root = node(pane.element), title = query(root, '.detail-title');
    pane.destroy(); const before = title.textContent; setLanguage('zh-CN'); expect(title.textContent).toBe(before);
    const view = makeView(), control = query(node(view.element), 'select'); view.destroy(); const options = control.textContent; setLanguage('en'); expect(control.textContent).toBe(options);
  });
});

describe('owned history catalogue data boundaries', () => {
  it('uses exact Chinese/English messages and interpolates raw repository text verbatim', () => {
    const raw = '<Working tree> {count}\nRead only';
    expect(t('files.markPathReviewed', { path: raw })).toBe(`Mark ${raw} reviewed`);
    setLanguage('zh-CN'); expect(t('files.markPathReviewed', { path: raw })).toBe(`将 ${raw} 标记为已审阅`);
    expect(t('signature.result', { status: m('signature.valid'), signer: raw, key: raw, output: raw })).toBe(`有效\n签名者：${raw}\n密钥：${raw}\n\n${raw}`);
  });
});

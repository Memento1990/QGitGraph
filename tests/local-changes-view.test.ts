import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ChangedFile, type DiffQuery, type DiffResult, type Host, type Repository, type WorkingState } from '../src/shared/protocol';
import { setLanguage } from '../src/lib/i18n';
import { LocalChangesPane, type LocalChangesContext, type LocalChangesAction } from '../src/ui/local-changes';

/** Native-API-only DOM adapter: no DOM dependency, real component event handlers and lazy DiffView. */
class TestNode {
  children: TestNode[] = []; parentElement: TestNode | null = null;
  attributes = new Map<string, string>(); dataset: Record<string, string> = {}; listeners = new Map<string, ((event: unknown) => void)[]>();
  style: Record<string, unknown> = { setProperty: (key: string, value: string) => { this.style[key] = value; } };
  className = ''; id = ''; title = ''; value = ''; name = ''; type = ''; disabled = false; hidden = false; open = false; checked = false; required = false;
  tabIndex = -1; scrollTop = 0; scrollLeft = 0; clientWidth = 390; clientHeight = 225;
  selectionStart = 0; selectionEnd = 0; selectionDirection: 'forward' | 'backward' | 'none' = 'none'; private text = '';
  readonly tagName: string; readonly nodeName: string; readonly nodeType: number;
  constructor(readonly tag: string, text = '') { this.text = text; this.tagName = tag.startsWith('#') ? tag : tag.toUpperCase(); this.nodeName = this.tagName; this.nodeType = tag === '#text' ? 3 : 1; }
  get parentNode(): TestNode | null { return this.parentElement; }
  get isConnected(): boolean { return this === documentStub.body || Boolean(this.parentElement?.isConnected); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { names.forEach(name => this.classList.toggle(name, true)); },
    remove: (...names: string[]) => { names.forEach(name => this.classList.toggle(name, false)); },
    toggle: (name: string, force?: boolean) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); const add = force ?? !names.has(name); if (add) names.add(name); else names.delete(name); this.className = [...names].join(' '); return add; },
  };
  appendChild(child: TestNode): TestNode { return this.insertBefore(child, null); }
  append(...children: (TestNode | string)[]): void { for (const child of children) this.appendChild(typeof child === 'string' ? new TestNode('#text', child) : child); }
  insertBefore(child: TestNode, before: TestNode | null): TestNode {
    if (child.tag === '#fragment') { for (const node of [...child.children]) this.insertBefore(node, before); return child; }
    if (child === before) return child;
    const focus = documentStub.activeElement; if (focus && child.contains(focus)) documentStub.activeElement = null;
    child.remove(); const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentElement = this; return child;
  }
  replaceChildren(...children: TestNode[]): void { for (const child of [...this.children]) child.remove(); this.text = ''; this.append(...children); }
  remove(): void { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
  contains(node: TestNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); if (name === 'title') this.title = value; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, listener: (event: unknown) => void): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  removeEventListener(name: string, listener: (event: unknown) => void): void { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(value => value !== listener)); }
  fire(name: string, extra: Record<string, unknown> = {}) { const event = { target: this, key: '', button: 0, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra }; this.listeners.get(name)?.forEach(listener => listener(event)); return event; }
  dispatchEvent(event: Event): boolean { this.listeners.get(event.type)?.forEach(listener => listener(event)); return !event.defaultPrevented; }
  click(): void { if (!this.disabled) this.fire('click'); }
  matches(selector: string): boolean { return selector.split(',').some(part => part.trim().startsWith('.') ? this.classList.contains(part.trim().slice(1)) : this.tag === part.trim()); }
  querySelectorAll<T = TestNode>(selector: string): T[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll<TestNode>(selector)]) as T[]; }
  querySelector<T = TestNode>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  closest(selector: string): TestNode | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  focus(): void { documentStub.activeElement = this; }
  setSelectionRange(start: number, end: number, direction: 'forward' | 'backward' | 'none' = 'none'): void { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  getBoundingClientRect() { return { left: 0, top: 0, bottom: 225, right: 390, width: 390, height: 225 }; }
}
const documentStub = {
  body: new TestNode('body'), documentElement: new TestNode('html'), activeElement: null as TestNode | null,
  createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag), createTextNode: (text: string) => new TestNode('#text', text), createDocumentFragment: () => new TestNode('#fragment'),
};
let frames: Map<number, FrameRequestCallback>, frameId: number;
let resizeCallbacks: (() => void)[];
const panes: LocalChangesPane[] = [];
const file = (path: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ path, oldPath: null, status: '.M', additions: 1, deletions: 1, staged: false, unstaged: true, ...extra });
const repository = (id = 'repo'): Repository => ({ id, name: id, path: `D:/${id}`, gitDir: '.git', commonDir: '.git', head: 'a'.repeat(40), branch: 'main', trusted: true, bare: false });
const working = (files: ChangedFile[] = []): WorkingState => ({ files, branch: 'main', head: 'a'.repeat(40), ahead: 0, behind: 0, conflicts: 0, operation: null });
const patch = (value = 'current'): DiffResult => ({ patch: `@@ -1 +1 @@\n-old\n+${value}\n`, binary: false, truncated: false, oldContent: null, newContent: null });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function tick() { for (let count = 0; count < 12; count++) await Promise.resolve(); }
function flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); }
function node(element: HTMLElement): TestNode { return element as unknown as TestNode; }
function query(root: TestNode, selector: string): TestNode { const result = root.querySelector(selector); if (!result) throw new Error(`Missing ${selector}`); return result; }
function action(root: TestNode, name: string, group?: string): TestNode { const result = root.querySelectorAll<TestNode>('button').find(button => button.dataset.action === name && (!group || button.dataset.group === group)); if (!result) throw new Error(`Missing action ${name} ${group ?? ''}`); return result; }
function row(pane: LocalChangesPane, path: string, group: string): TestNode { const result = node(pane.listElement).querySelectorAll<TestNode>('.local-changes-file').find(item => item.dataset.path === path && item.dataset.group === group); if (!result) throw new Error(`Missing row ${path} ${group}`); return result; }
function changeMode(pane: LocalChangesPane, mode: string): void { const control = query(node(pane.previewElement), 'select'); control.value = mode; control.fire('change'); }
function setMessage(pane: LocalChangesPane, message: string): TestNode { const control = query(node(pane.listElement), 'textarea'); control.value = message; control.fire('input'); return control; }
function harness(files: ChangedFile[] = [], overrides: Partial<Host> = {}, executeOverride?: (action: LocalChangesAction) => Promise<unknown>) {
  const context: LocalChangesContext = { repo: repository(), working: working(files), settings: structuredClone(DEFAULT_SETTINGS), busy: false, loading: false, generation: 1 };
  const host = { cancel: vi.fn(async () => {}), diffPatch: vi.fn(async () => patch()), diff: vi.fn(async () => ({ ...patch(), oldContent: 'legacy old', newContent: 'legacy new' })), fileContent: vi.fn(async (_query: DiffQuery, side: 'old' | 'new') => ({ ...patch(), ...(side === 'old' ? { oldContent: 'loaded old' } : { newContent: 'loaded new' }) })), workingIndex: vi.fn(async () => 'index-v1:opaque'), workingAction: vi.fn(), action: vi.fn(), ...overrides } as unknown as Host;
  const error = vi.fn(), copy = vi.fn(), position = vi.fn(), close = vi.fn(), changed = vi.fn(), listSize = vi.fn();
  const execute = vi.fn(executeOverride ?? (async () => undefined));
  const pane = new LocalChangesPane(host, { context: () => context, execute, error, copy, position, close, changed, listSize, settings: patch => { Object.assign(context.settings, patch); pane.update(); } });
  documentStub.body.append(node(pane.element)); panes.push(pane); pane.update();
  return { pane, host, context, execute, error, copy, position, close, changed, listSize };
}
beforeEach(() => {
  frames = new Map(); frameId = 0; resizeCallbacks = []; documentStub.body = new TestNode('body'); documentStub.documentElement = new TestNode('html'); documentStub.activeElement = null;
  vi.stubGlobal('document', documentStub); vi.stubGlobal('Node', TestNode); vi.stubGlobal('HTMLInputElement', TestNode);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resizeCallbacks.push(callback); } observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id = ++frameId; frames.set(id, callback); return id; }); vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  setLanguage('en');
});
afterEach(() => { panes.splice(0).forEach(pane => pane.dispose()); setLanguage('en'); vi.unstubAllGlobals(); });

describe('independent local changes surface', () => {
  it('keeps partially staged file identities and exact comparison sides separate; file selection never writes', async () => {
    const renamed = file('new/file.ts', { status: 'RM', oldPath: 'old/file.ts', staged: true });
    const { pane, host, execute } = harness([renamed, file('new.txt', { status: '??' })]); await tick();
    expect(row(pane, renamed.path, 'staged')).not.toBe(row(pane, renamed.path, 'unstaged'));
    expect(host.diffPatch).toHaveBeenLastCalledWith(expect.objectContaining({ base: 'INDEX', target: 'WORKTREE', staged: false, path: renamed.path }));
    expect((host.diffPatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('oldPath');
    row(pane, renamed.path, 'staged').click(); await tick();
    expect(host.diffPatch).toHaveBeenLastCalledWith(expect.objectContaining({ base: 'a'.repeat(40), target: 'INDEX', oldPath: 'old/file.ts', staged: true }));
    expect(row(pane, renamed.path, 'staged').getAttribute('aria-selected')).toBe('true'); expect(row(pane, renamed.path, 'unstaged').getAttribute('aria-selected')).toBe('false');
    row(pane, 'new.txt', 'untracked').click(); await tick();
    expect(host.diffPatch).toHaveBeenLastCalledWith(expect.objectContaining({ base: 'ROOT', target: 'WORKTREE', staged: false }));
    expect(execute).not.toHaveBeenCalled(); expect(host.workingAction).not.toHaveBeenCalled(); expect(host.action).not.toHaveBeenCalled(); expect(host.fileContent).not.toHaveBeenCalled();
    action(node(pane.previewElement), 'copy-local-file-path').click(); expect(host.diff).not.toHaveBeenCalled();
  });

  it('moves one composer/list without losing message, selection, focus, scroll or preview, and restores bounded per-repo drafts', async () => {
    const { pane, context, host } = harness([file('one')]); await tick();
    const surface = pane.listElement, preview = pane.previewElement, message = setMessage(pane, 'repo one draft'); message.setSelectionRange(2, 7, 'backward'); message.focus();
    const viewport = query(node(surface), '.local-changes-files'); viewport.scrollTop = 17;
    const sidebar = new TestNode('aside'); documentStub.body.append(sidebar); pane.setPlacement('sidebar', sidebar as unknown as HTMLElement);
    expect(node(surface).parentElement).toBe(sidebar); expect(documentStub.activeElement).toBe(message); expect(message.selectionStart).toBe(2); expect(message.selectionEnd).toBe(7); expect(message.selectionDirection).toBe('backward'); expect(viewport.scrollTop).toBe(17);
    pane.update(); pane.setPlacement('workspace'); expect(pane.listElement).toBe(surface); expect(pane.previewElement).toBe(preview); expect(query(node(surface), 'textarea')).toBe(message); expect(documentStub.activeElement).toBe(message);
    expect(host.diffPatch).toHaveBeenCalledOnce();
    context.repo = repository('second'); context.working = working([file('two')]); context.generation = 2; pane.update(); expect(message.value).toBe('');
    setMessage(pane, 'second draft'); context.repo = repository(); context.working = working([file('one')]); context.generation = 3; pane.update(); expect(message.value).toBe('repo one draft'); expect(message.selectionStart).toBe(2);
    node(pane.element).hidden = true; pane.update(); expect(node(pane.element).hidden).toBe(true);
  });

  it('restores draft viewport after the owner reparents and restores selection, including ResizeObserver and later frame layout', async () => {
    const { pane, host, context } = harness([file('one')]); await tick(); flushFrames();
    const message = setMessage(pane, 'movable draft\nsecond line\nthird line'); message.setSelectionRange(4, 12, 'backward'); message.focus();
    message.scrollTop = 10; message.scrollLeft = 7;
    const viewport = query(node(pane.listElement), '.local-changes-files'); viewport.scrollTop = 17; viewport.scrollLeft = 3;
    const sidebar = new TestNode('aside'); documentStub.body.append(sidebar);
    pane.setPlacement('sidebar');
    // Main calls tree.mountLocal after setPlacement: moving/focusing/selection can reset the internal textarea viewport.
    sidebar.append(node(pane.listElement)); message.focus(); message.setSelectionRange(0, 0); message.scrollTop = 0; message.scrollLeft = 0; viewport.scrollTop = 0; viewport.scrollLeft = 0;
    await tick();
    expect([message.scrollTop, message.scrollLeft, message.selectionStart, message.selectionEnd, message.selectionDirection]).toEqual([10, 7, 4, 12, 'backward']);
    expect([viewport.scrollTop, viewport.scrollLeft]).toEqual([17, 3]);
    message.scrollTop = 0; message.scrollLeft = 0; resizeCallbacks.forEach(callback => callback());
    expect([message.scrollTop, message.scrollLeft]).toEqual([10, 7]);
    message.scrollTop = 0; message.scrollLeft = 0; flushFrames(); expect([message.scrollTop, message.scrollLeft]).toEqual([10, 7]);
    // Repeated renderWorkspace/setPlacement calls must retain the pending capture, not replace it with a clamped zero.
    message.scrollTop = 0; pane.setPlacement('sidebar'); flushFrames(); expect(message.scrollTop).toBe(10);
    pane.setPlacement('workspace'); message.scrollTop = 0; message.scrollLeft = 0; flushFrames(); flushFrames();
    expect([message.scrollTop, message.scrollLeft, message.selectionStart, message.selectionEnd, message.selectionDirection]).toEqual([10, 7, 4, 12, 'backward']);
    expect(host.diffPatch).toHaveBeenCalledOnce();
    context.repo = repository('other'); context.working = working([file('two')]); context.generation = 2; pane.update();
    context.repo = repository(); context.working = working([file('one')]); context.generation = 3; pane.update();
    expect([message.scrollTop, message.scrollLeft]).toEqual([10, 7]);
  });

  it('cancels a placement viewport restore when the user edits or scrolls and never applies it to another repository', async () => {
    const { pane, context } = harness([file('one')]); await tick(); flushFrames();
    const message = setMessage(pane, 'first draft'); message.scrollTop = 10;
    const sidebar = new TestNode('aside'); documentStub.body.append(sidebar); pane.setPlacement('sidebar', sidebar as unknown as HTMLElement);
    message.fire('wheel'); message.scrollTop = 23; await tick(); flushFrames(); flushFrames(); expect(message.scrollTop).toBe(23);
    pane.setPlacement('workspace'); setMessage(pane, 'new user draft'); message.setSelectionRange(1, 3, 'forward'); message.scrollTop = 4;
    await tick(); flushFrames(); flushFrames(); expect(message.value).toBe('new user draft'); expect([message.scrollTop, message.selectionStart, message.selectionEnd]).toEqual([4, 1, 3]);
    pane.setPlacement('sidebar', sidebar as unknown as HTMLElement); context.repo = repository('other'); context.working = working([file('two')]); context.generation = 2; pane.update();
    await tick(); flushFrames(); flushFrames(); expect(message.value).toBe(''); expect(message.scrollTop).toBe(0);
    pane.dispose(); expect(frames.size).toBe(0);
  });

  it('sends explicit immutable target lists and only a callback write; counts change only after a real snapshot arrives', async () => {
    const gate = deferred<unknown>(), first = Object.freeze(file('one', { staged: true, status: 'MM' })), second = Object.freeze(file('two'));
    const { pane, context, execute, host } = harness([first, second], {}, () => gate.promise); await tick();
    const before = query(node(pane.listElement), '.local-changes-rows').textContent;
    action(node(pane.listElement), 'stage-group', 'unstaged').click();
    expect(execute).toHaveBeenCalledWith({ kind: 'stage', files: [{ path: 'one', status: 'MM' }, { path: 'two', status: '.M' }] });
    expect(context.working!.files).toEqual([first, second]); expect(query(node(pane.listElement), '.local-changes-rows').textContent).toBe(before); expect(host.workingAction).not.toHaveBeenCalled();
    gate.resolve(undefined); await tick(); expect(row(pane, 'two', 'unstaged')).toBeDefined();
    context.working = working([file('one', { status: 'M.', staged: true, unstaged: false }), file('two', { status: 'M.', staged: true, unstaged: false })]); pane.update(); await tick();
    expect(node(pane.listElement).querySelectorAll<TestNode>('.local-changes-file').every(item => item.dataset.group === 'staged')).toBe(true);
    action(node(pane.listElement), 'unstage-group', 'staged').click(); expect(execute).toHaveBeenLastCalledWith({ kind: 'unstage', files: [{ path: 'one', status: 'M.' }, { path: 'two', status: 'M.' }] });
  });

  it('never auto-stages on zero staged files and captures a safe index/head on commit; failed callbacks preserve the draft', async () => {
    const { pane, context, host, execute } = harness([file('one')]); await tick();
    const message = setMessage(pane, 'do not add all'); action(node(pane.listElement), 'commit-staged').click(); await tick();
    expect(execute).not.toHaveBeenCalled(); expect(host.workingIndex).not.toHaveBeenCalled(); expect(query(node(pane.listElement), '.composer-error').textContent).toContain('nothing will be added automatically');
    context.repo = { ...context.repo!, head: null }; context.working = working([file('one', { staged: true, status: 'A.', unstaged: false })]); pane.update(); context.settings.commitSigning = 'no-sign';
    execute.mockResolvedValueOnce(false); action(node(pane.listElement), 'commit-staged').click(); await tick();
    expect(execute).toHaveBeenLastCalledWith({ kind: 'commit-staged', message: 'do not add all', expectedHead: null, expectedIndex: 'index-v1:opaque', sign: false }); expect(message.value).toBe('do not add all');
    action(node(pane.listElement), 'commit-staged').click(); await tick(); expect(message.value).toBe(''); expect(host.workingAction).not.toHaveBeenCalled(); expect(host.action).not.toHaveBeenCalled();
  });

  it('does not clear a newly edited draft while an earlier commit completes', async () => {
    const gate = deferred<unknown>(), { pane, execute } = harness([file('one', { status: 'M.', staged: true, unstaged: false })], {}, () => gate.promise); await tick();
    const message = setMessage(pane, 'captured draft'); message.fire('keydown', { key: 'Enter', ctrlKey: true }); await tick(); expect(execute).toHaveBeenCalledOnce();
    setMessage(pane, 'next draft'); gate.resolve(undefined); await tick(); expect(message.value).toBe('next draft');
  });

  it('rejects stale index-read completion across owner generation, snapshot and repository switches including A→B→A', async () => {
    const gate = deferred<string>(), { pane, context, execute, host } = harness([file('one', { status: 'M.', staged: true, unstaged: false })], { workingIndex: vi.fn(() => gate.promise) }); await tick();
    setMessage(pane, 'must stay'); action(node(pane.listElement), 'commit-staged').click();
    context.generation = 3; gate.resolve('index-v1:stale'); await tick(); expect(execute).not.toHaveBeenCalled(); expect(query(node(pane.listElement), 'textarea').value).toBe('must stay');
    expect(host.workingIndex).toHaveBeenCalledOnce();
  });

  it('does not keep a new repository blocked by an index read whose host ignores cancellation', async () => {
    const gate = deferred<string>(), indexRead = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue('index-v1:new');
    const { pane, context, execute } = harness([file('one', { status: 'M.', staged: true, unstaged: false })], { workingIndex: indexRead }); await tick();
    setMessage(pane, 'old draft'); action(node(pane.listElement), 'commit-staged').click();
    context.repo = repository('new'); context.working = working([file('new-file', { status: 'M.', staged: true, unstaged: false })]); context.generation = 2; pane.update();
    setMessage(pane, 'new draft'); action(node(pane.listElement), 'commit-staged').click(); await tick();
    expect(execute).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledWith(expect.objectContaining({ message: 'new draft', expectedIndex: 'index-v1:new' }));
    gate.resolve('index-v1:old'); await tick(); expect(execute).toHaveBeenCalledOnce();
  });

  it('requires typed discard/delete confirmation and revalidates its exact repository snapshot after the dialog', async () => {
    const { pane, execute, context } = harness([file('tracked'), file(' new file ', { status: '??' })]); await tick();
    action(row(pane, 'tracked', 'unstaged'), 'discard-file').click(); const dialog = query(documentStub.body, 'dialog');
    expect(execute).not.toHaveBeenCalled(); expect(dialog.textContent).toContain('Staged changes are kept');
    const confirm = query(dialog, 'input'), form = query(dialog, 'form'); confirm.value = 'wrong'; form.fire('submit'); await tick(); expect(execute).not.toHaveBeenCalled(); expect(dialog.open).toBe(true);
    confirm.value = 'discard'; form.fire('submit'); await tick(); expect(execute).toHaveBeenCalledWith({ kind: 'discard', files: [{ path: 'tracked', status: '.M' }], confirmation: 'discard' });
    action(row(pane, ' new file ', 'untracked'), 'delete-untracked-file').click(); const deleteDialog = query(documentStub.body, 'dialog'); const pathInput = query(deleteDialog, 'input');
    pathInput.value = 'new file'; query(deleteDialog, 'form').fire('submit'); await tick(); expect(execute).toHaveBeenCalledTimes(1);
    pathInput.value = ' new file '; query(deleteDialog, 'form').fire('submit'); await tick(); expect(execute).toHaveBeenLastCalledWith({ kind: 'delete-untracked', files: [{ path: ' new file ', status: '??' }], confirmation: ' new file ' });
    action(row(pane, 'tracked', 'unstaged'), 'discard-file').click(); const stale = query(documentStub.body, 'dialog'); query(stale, 'input').value = 'discard';
    context.working = working([file('tracked')]); query(stale, 'form').fire('submit'); await tick(); expect(execute).toHaveBeenCalledTimes(2);
  });

  it('closes its own destructive dialog on repository switch and disposal without executing a stale operation', async () => {
    const { pane, context, execute } = harness([file('one')]); await tick();
    action(row(pane, 'one', 'unstaged'), 'discard-file').click(); expect(query(documentStub.body, 'dialog').open).toBe(true);
    context.repo = repository('other'); context.working = working([file('other')]); context.generation = 2; pane.update(); await tick();
    expect(documentStub.body.querySelector('dialog')).toBeNull(); expect(execute).not.toHaveBeenCalled();
    action(row(pane, 'other', 'unstaged'), 'discard-file').click(); pane.dispose(); await tick();
    expect(documentStub.body.querySelector('dialog')).toBeNull(); expect(execute).not.toHaveBeenCalled();
  });

  it('publishes local rows before patch completion, cancels outdated requests and ignores stale patches and lazy content', async () => {
    const first = deferred<DiffResult>(), second = deferred<DiffResult>(), old = deferred<DiffResult>();
    const diffPatch = vi.fn((query: DiffQuery) => query.path === 'one' ? first.promise : second.promise);
    const { pane, host, context } = harness([file('one'), file('two')], { diffPatch, fileContent: vi.fn(() => old.promise) });
    expect(node(pane.listElement).querySelectorAll('.local-changes-file')).toHaveLength(2); row(pane, 'two', 'unstaged').click(); expect(host.cancel).toHaveBeenCalled();
    first.resolve(patch('stale first')); second.resolve(patch('valid second')); await tick(); expect(node(pane.previewElement).textContent).toContain('valid second'); expect(node(pane.previewElement).textContent).not.toContain('stale first');
    changeMode(pane, 'old'); await tick(); expect(host.fileContent).toHaveBeenCalledOnce();
    context.repo = repository('other'); context.working = working([file('other-file')]); context.generation = 2; pane.update();
    old.resolve({ ...patch(), oldContent: 'stale side content' }); await tick(); expect(node(pane.previewElement).textContent).not.toContain('stale side content');
  });

  it('loads sides lazily, remembers unavailable sides, and refreshes all local results rather than caching mutable state', async () => {
    const fileContent = vi.fn(async () => ({ ...patch(), newContent: null })), { pane, host, context } = harness([file('one')], { fileContent }); await tick();
    expect(fileContent).not.toHaveBeenCalled(); changeMode(pane, 'new'); await tick(); expect(fileContent).toHaveBeenCalledOnce(); expect(node(pane.previewElement).textContent).toContain('Content unavailable');
    changeMode(pane, 'diff'); changeMode(pane, 'new'); await tick(); expect(fileContent).toHaveBeenCalledOnce();
    context.working = working([file('one')]); pane.update(); await tick(); expect(host.diffPatch).toHaveBeenCalledTimes(2); changeMode(pane, 'new'); await tick(); expect(fileContent).toHaveBeenCalledTimes(2);
    pane.update(); expect(host.diffPatch).toHaveBeenCalledTimes(2); pane.update(true); await tick(); expect(host.diffPatch).toHaveBeenCalledTimes(3);
  });

  it('refreshes explicit forced observations even when a host reuses its mutable snapshot identity', async () => {
    const { pane, context, host } = harness([file('one')]); await tick();
    context.working!.files = [file('two', { staged: true, unstaged: false, status: 'M.' })];
    pane.update(true); await tick(); expect(row(pane, 'two', 'staged')).toBeDefined();
    expect(node(pane.listElement).querySelectorAll<TestNode>('.local-changes-file').some(item => item.dataset.path === 'one')).toBe(false);
    expect(host.diffPatch).toHaveBeenLastCalledWith(expect.objectContaining({ path: 'two', staged: true, target: 'INDEX' }));
  });

  it('supports the legacy diff path without additional lazy reads; patch failures do not trigger a misleading legacy fallback', async () => {
    const { pane, host } = harness([file('one')], { diffPatch: undefined, fileContent: undefined }); await tick();
    changeMode(pane, 'old'); await tick(); expect(node(pane.previewElement).textContent).toContain('legacy old'); expect(host.diff).toHaveBeenCalledOnce();
    const failure = harness([file('one')], { diffPatch: vi.fn(async () => { throw new Error('patch failed'); }) }); await tick(); expect(node(failure.pane.previewElement).textContent).toContain('patch failed'); expect(failure.host.diff).not.toHaveBeenCalled();
  });

  it('virtualizes from 200 files, keeps keyboard active rows mounted, preserves node identities and translates presentation only', async () => {
    const { pane, host } = harness(Array.from({ length: 5000 }, (_, index) => file(`目录/file${String(index).padStart(4, '0')}.ts`))); await tick();
    const viewport = query(node(pane.listElement), '.local-changes-files'), first = row(pane, '目录/file0000.ts', 'unstaged'); expect(viewport.querySelectorAll('.local-changes-file').length).toBeLessThan(40);
    pane.update(); expect(row(pane, '目录/file0000.ts', 'unstaged')).toBe(first);
    viewport.scrollTop = 27 * 3000; viewport.fire('scroll'); flushFrames(); expect(viewport.querySelectorAll('.local-changes-file').length).toBeLessThan(40);
    viewport.fire('keydown', { key: 'End' }); await tick(); expect(row(pane, '目录/file4999.ts', 'unstaged').getAttribute('aria-setsize')).toBe('5000'); expect(viewport.getAttribute('aria-activedescendant')).toBe(row(pane, '目录/file4999.ts', 'unstaged').id);
    const reads = (host.diffPatch as ReturnType<typeof vi.fn>).mock.calls.length, message = setMessage(pane, 'raw 原文 draft'); message.focus();
    setLanguage('zh-CN'); expect(action(node(pane.listElement), 'commit-staged').textContent).toBe('提交已暂存'); expect(query(node(pane.listElement), 'textarea')).toBe(message); expect(documentStub.activeElement).toBe(message); expect(message.value).toBe('raw 原文 draft'); expect(host.diffPatch).toHaveBeenCalledTimes(reads);
  });

  it('distinguishes unknown, clean, bare, stale and loading states, disables stale writes and delegates resizing', async () => {
    const { pane, context, execute, listSize } = harness(); await tick(); expect(node(pane.listElement).textContent).toContain('Working tree clean');
    context.working = null; pane.update(); expect(node(pane.listElement).textContent).toContain('status is not loaded');
    context.repo = { ...context.repo!, bare: true }; pane.update(); expect(node(pane.listElement).textContent).toContain('Bare repository');
    context.repo = repository(); context.working = working([file('one')]); context.loading = true; pane.update(); action(row(pane, 'one', 'unstaged'), 'stage-file').click(); expect(execute).not.toHaveBeenCalled();
    context.loading = false; context.error = new Error('raw host failure'); pane.update(); expect(action(row(pane, 'one', 'unstaged'), 'stage-file').disabled).toBe(true);
    node(pane.element).clientHeight = 800; query(node(pane.listElement), '.local-changes-composer').clientHeight = 100;
    const splitter = query(node(pane.element), '.local-changes-list-resizer'); splitter.fire('keydown', { key: 'ArrowDown' }); expect(listSize).toHaveBeenCalledWith(233, true);
  });
});

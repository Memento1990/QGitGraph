import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '../src/i18n/app';
import { errorText, formatFullDate, scopeText } from '../src/lib/format';
import { initI18n, LocalizedError, resolveText, setLanguage, type Localizable } from '../src/lib/i18n';
import { HistoryLayoutCache } from '../src/lib/performance-models';
import type { StateStore } from '../src/lib/state';
import type { StatusResult, StatusTask } from '../src/lib/status';
import { defaultState, type ActionResult, type Commit, type DirectoryScopeState, type GitAction, type GitRef, type Host, type Repository, type RepositoryDiscovery, type ViewState, type WorkingState } from '../src/shared/protocol';
import { ACTION_GROUPS, ACTION_LABELS } from '../src/ui/actions';
import { App } from '../src/ui/app';
import type { DetailsPane } from '../src/ui/details';
import type { HistoryDocuments } from '../src/ui/history-documents';
import type { LocalChangesPane } from '../src/ui/local-changes';
import { closeMenu, disposeBindings, type MenuItem } from '../src/ui/dom';
import type { CommitTable } from '../src/ui/table';

/** Presentation-only DOM adapter. The real App and child components run; all host calls are fixtures. */
class TestNode {
  readonly tagName: string;
  readonly nodeType: number;
  parentNode: TestNode | null = null;
  children: TestNode[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  events = new Map<string, ((event: TestEvent) => void)[]>();
  className = ''; id = ''; title = ''; placeholder = ''; type = ''; name = ''; text = '';
  hidden = false; disabled = false; checked = false; required = false; open = false; composing = false;
  tabIndex = 0; rows = 0; scrollTop = 0; scrollLeft = 0; clientHeight = 560; clientWidth = 1000; offsetHeight = 100;
  selectionStart = 0; selectionEnd = 0; selectionDirection = 'none'; valueWrites = 0;
  private ownValue = '';
  style: Record<string, unknown> = { setProperty: (name: string, value: string) => { this.style[name] = value; }, getPropertyValue: () => '' };
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    toggle: (name: string, force?: boolean) => { const enabled = force ?? !this.classList.contains(name); if (enabled) this.classList.add(name); else this.classList.remove(name); return enabled; },
  };
  constructor(tag = 'div', text = '') { this.tagName = tag.startsWith('#') ? tag : tag.toUpperCase(); this.nodeType = tag === '#text' ? 3 : tag === '#fragment' ? 11 : 1; this.text = text; }
  get nodeName(): string { return this.tagName; }
  get parentElement(): TestNode | null { return this.parentNode; }
  get firstElementChild(): TestNode | null { return this.children.find(node => node.nodeType === 1) ?? null; }
  get childElementCount(): number { return this.children.filter(node => node.nodeType === 1).length; }
  get nextElementSibling(): TestNode | null { const siblings = this.parentNode?.children ?? []; return siblings.slice(siblings.indexOf(this) + 1).find(node => node.nodeType === 1) ?? null; }
  get isConnected(): boolean { return this === dom.body || Boolean(this.parentNode?.isConnected); }
  get value(): string { return this.ownValue; }
  set value(value: string) { this.ownValue = value; this.valueWrites++; }
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.children.forEach(node => { node.parentNode = null; }); this.children = []; this.text = value; }
  append(...children: (TestNode | string)[]): void {
    for (const child of children) {
      if (typeof child === 'string') this.append(new TestNode('#text', child));
      else if (child.nodeType === 11) this.append(...[...child.children]);
      else { child.remove(); child.parentNode = this; this.children.push(child); }
    }
  }
  appendChild(child: TestNode): TestNode { this.append(child); return child; }
  insertBefore(child: TestNode, before: TestNode | null): TestNode { child.remove(); const index = before ? this.children.indexOf(before) : this.children.length; this.children.splice(index < 0 ? this.children.length : index, 0, child); child.parentNode = this; return child; }
  replaceChildren(...children: TestNode[]): void { this.textContent = ''; this.append(...children); }
  replaceWith(next: TestNode): void { const parent = this.parentNode; if (parent) { parent.insertBefore(next, this); this.remove(); } }
  remove(): void { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; }
  contains(node: TestNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); if (name === 'title') this.title = value; if (name === 'placeholder') this.placeholder = value; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, [...(this.events.get(name) ?? []), listener]); }
  removeEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, (this.events.get(name) ?? []).filter(value => value !== listener)); }
  fire(name: string, extra: Partial<TestEvent> = {}): void { const event = { target: this, key: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra }; this.events.get(name)?.forEach(listener => listener(event)); }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = /^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      if (attribute[1] && this.tagName !== attribute[1].toUpperCase()) return false;
      const key = attribute[2], value = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] : key === 'open' ? this.open ? '' : undefined : this.attributes.get(key);
      return attribute[3] === undefined ? value !== undefined : value === attribute[3];
    }
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll<T = TestNode>(selector: string): T[] { return this.children.flatMap(child => [...(selector.split(',').some(item => child.matches(item.trim())) ? [child] : []), ...child.querySelectorAll<TestNode>(selector)]) as T[]; }
  querySelector<T = TestNode>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  closest(selector: string): TestNode | null { return selector.split(',').some(item => this.matches(item.trim())) ? this : this.parentNode?.closest(selector) ?? null; }
  focus(): void { dom.activeElement = this; }
  select(): void { this.setSelectionRange(0, this.value.length); }
  setSelectionRange(start: number, end: number, direction = 'none'): void { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; }
  click(): void { this.fire('click'); }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
  reportValidity(): boolean { return true; }
  scrollIntoView(): void {}
  getBoundingClientRect() { return { top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  getContext(): null { return null; }
}
interface TestEvent { target: TestNode; key: string; preventDefault(): void; stopPropagation(): void }
const all = (root: TestNode): TestNode[] => [root, ...root.children.flatMap(all)];
const dom = {
  body: new TestNode('body'), documentElement: new TestNode('html'), activeElement: null as TestNode | null, hidden: false,
  createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('#text', text), createDocumentFragment: () => new TestNode('#fragment'),
  getElementById: (id: string) => all(dom.body).find(node => node.id === id) ?? null,
  querySelector: (selector: string) => dom.body.querySelector(selector), addEventListener: vi.fn(), removeEventListener: vi.fn(),
};
function node(value: Node): TestNode { return value as unknown as TestNode; }
function find(root: TestNode, predicate: (value: TestNode) => boolean): TestNode { const result = all(root).find(predicate); if (!result) throw new Error('Expected presentation node missing'); return result; }
function action(root: TestNode, id: string): TestNode { return find(root, value => value.dataset.action === id); }
function titled(root: TestNode, title: string): TestNode { return find(root, value => value.tagName === 'BUTTON' && value.title === title); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function settle(): Promise<void> { for (let index = 0; index < 16; index++) await Promise.resolve(); }
let frames: Map<number, FrameRequestCallback>, nextFrame = 0;
function paint(): void { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); }
const oid = 'a'.repeat(40), parent = 'b'.repeat(40);
const repo: Repository = { id: 'fixture', path: 'D:/Refresh / 保存', name: 'No repository / 保存', gitDir: '.git', commonDir: '.git', head: oid, branch: 'Trust repository…', trusted: false, bare: false };
const ref: GitRef = { name: repo.branch!, fullName: `refs/heads/${repo.branch}`, oid, kind: 'branch', upstream: null, current: true, subject: 'Open repository…' };
const commits: Commit[] = [
  { oid, parents: [parent], author: 'No repository', email: 'Filter loaded@example.test', subject: 'Open repository…', authoredAt: 1_790_000_000, committedAt: 1_790_000_010, refs: [ref] },
  { oid: parent, parents: [], author: 'No repository', email: 'author@example.test', subject: 'Cancel / 保存', authoredAt: 1_780_000_000, committedAt: 1_780_000_000, refs: [] },
];
const working = (): WorkingState => ({ files: [], branch: repo.branch, head: oid, ahead: 0, behind: 0, conflicts: 0, operation: null });
function makeHost(overrides: Partial<Host> = {}): Host {
  const state = defaultState(); state.settings.language = 'en'; state.settings.autoLoad = false;
  return {
    loadState: vi.fn(async () => state), saveState: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
    diagnostics: vi.fn(async () => ({ appVersion: '0.2.2', gitVersion: 'git fixture', gitPath: 'git', platform: 'fixture', hostMode: 'desktop' as const })),
    onRepositoryChanged: vi.fn(async () => () => {}), onExternalSession: vi.fn(async () => () => {}),
    openRepository: vi.fn(async () => ({ ...repo })),
    history: vi.fn(async () => ({ commits: structuredClone(commits), hasMore: false })),
    snapshot: vi.fn(async () => ({ repository: { ...repo }, working: working(), refs: [{ ...ref }], stashes: [], remotes: [], fingerprint: 'fixture' })),
    copy: vi.fn(async () => {}), openUrl: vi.fn(async () => {}), action: vi.fn(async () => ({ output: '', operation: null })),
    ...overrides,
  } as unknown as Host;
}
type AppInternals = {
  store: StateStore; repo: Repository | null; table: CommitTable; graph: HistoryLayoutCache; refs: GitRef[];
  details: DetailsPane; localChanges: LocalChangesPane; historyDocuments: HistoryDocuments;
  root: HTMLElement; toolbar: HTMLElement; querybar: HTMLElement; errorbar: HTMLElement; historyOverlay: HTMLElement; operationbar: HTMLElement; toastElement: HTMLElement;
  sidebar: HTMLElement; sidebarResizer: HTMLElement; workspace: HTMLElement; resizeHandle: HTMLElement;
  searchInput: HTMLInputElement; searchScope: HTMLSelectElement; searchType: HTMLSelectElement; orderSelect: HTMLSelectElement;
  scope: ViewState['scope']; search: string; searchMode: string; queryMode: 'filter' | 'search'; order: string;
  openGeneration: number; historyGeneration: number; intentEpoch: number; hasMore: boolean; autoLoadBlocked: boolean; taskSequence: number;
  directoryLoading: boolean; directoryPendingScope: DirectoryScopeState | null; working: WorkingState | null;
  statusResult: StatusResult | null; activeWrite: StatusTask | null;
  openRepository(path: string): Promise<void>; openDirectory(path: string): Promise<void>;
  selectCommit(oid: string, compare: boolean): void;
  restoreQuery(view: ViewState): void; renderDirectory(): void; renderOperation(): void;
  showError(error: unknown): void; chooseLanguage(): Promise<void>; advancedFilter(): Promise<void>;
  cleanMenu(items: (MenuItem | null)[], context?: 'branch' | 'commit'): (MenuItem | null)[]; moreMenu(control: HTMLElement): void;
  showTagDetail(ref: GitRef): Promise<void>; showStashDetail(selector: string): Promise<void>; showRemotes(): Promise<void>; showSubmodules(): Promise<void>;
  execute(action: GitAction, label: Localizable): Promise<ActionResult | null>;
};
const live: App[] = [];
async function makeApp(host = makeHost(), open = true) {
  const root = new TestNode(); dom.body.append(root);
  const app = new App(host, root as unknown as HTMLElement), state = app as unknown as AppInternals; live.push(app);
  await app.init(); if (open) await state.openRepository(repo.path); paint();
  expect(state.errorbar.hidden, node(state.errorbar).textContent).toBe(true);
  return { app, state, host, root };
}
function calls(host: Host) { return Object.fromEntries(Object.entries(host).filter(([, value]) => vi.isMockFunction(value)).map(([key, value]) => [key, vi.mocked(value).mock.calls.length])); }
function noWork(instance: object, names: string[]) { return names.map(name => vi.spyOn(instance as Record<string, () => unknown>, name)); }
function expectNoWork(spies: ReturnType<typeof vi.spyOn>[]) { for (const spy of spies) expect(spy).not.toHaveBeenCalled(); }

beforeEach(() => {
  vi.useFakeTimers(); dom.body = new TestNode('body'); dom.documentElement = new TestNode('html'); dom.activeElement = null; dom.hidden = false;
  frames = new Map(); nextFrame = 0;
  for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement']) vi.stubGlobal(name, TestNode);
  vi.stubGlobal('document', dom); vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' });
  vi.stubGlobal('window', { devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900, addEventListener: vi.fn(), removeEventListener: vi.fn(), getSelection: () => null });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id)); initI18n('en', []);
});
afterEach(() => {
  closeMenu(); live.splice(0).forEach(app => app.dispose()); disposeBindings(dom.body as unknown as Node);
  initI18n('en', []); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe('App-owned presentation-only localization', () => {
  it('updates toolbar/query/empty/ARIA labels without rebuilding controls, preparing history, changing query state or calling Host', async () => {
    const { state, host, root } = await makeApp();
    state.searchInput.value = 'Open repository…'; node(state.searchInput).fire('input'); paint();
    const input = node(state.searchInput); input.focus(); input.selectionStart = 2; input.selectionEnd = 7; input.selectionDirection = 'forward'; input.composing = true;
    state.table.scrollTop = 17; node(state.table.viewport).scrollLeft = 12;
    const controlNodes = all(root).filter(value => ['INPUT', 'SELECT', 'BUTTON'].includes(value.tagName));
    const query = [state.scope, state.search, state.searchMode, state.queryMode, state.order], generations = [state.openGeneration, state.historyGeneration, state.intentEpoch, state.taskSequence];
    const widths = structuredClone(state.store.state.settings.columnWidths), refs = state.refs, rows = root.querySelectorAll('.commit-row'), refNode = find(root, value => value.dataset.ref !== undefined);
    const passes = state.graph.preparePasses, beforeCalls = calls(host), writes = input.valueWrites, beforeFrames = frames.size;
    const forbidden = noWork(state, ['buildToolbar', 'buildQuerybar', 'applySettings', 'settingsChanged', 'renderTable', 'loadHistory', 'loadMetadata', 'renderDirectory']);
    const prepare = vi.spyOn(state.graph, 'prepare');
    setLanguage('zh-CN');
    expectNoWork(forbidden); expect(prepare).not.toHaveBeenCalled(); expect(calls(host)).toEqual(beforeCalls); expect(frames.size).toBe(beforeFrames); expect(state.graph.preparePasses).toBe(passes);
    expect(all(root).filter(value => ['INPUT', 'SELECT', 'BUTTON'].includes(value.tagName))).toEqual(controlNodes);
    expect(root.querySelectorAll('.commit-row')).toEqual(rows); expect(find(root, value => value.dataset.ref !== undefined)).toBe(refNode); expect(state.refs).toBe(refs);
    expect([state.scope, state.search, state.searchMode, state.queryMode, state.order]).toEqual(query); expect([state.openGeneration, state.historyGeneration, state.intentEpoch, state.taskSequence]).toEqual(generations);
    expect(state.store.state.settings.columnWidths).toEqual(widths); expect(state.table.scrollTop).toBe(17); expect(node(state.table.viewport).scrollLeft).toBe(12);
    expect(input.value).toBe('Open repository…'); expect(input.valueWrites).toBe(writes); expect(dom.activeElement).toBe(input); expect([input.selectionStart, input.selectionEnd, input.selectionDirection, input.composing]).toEqual([2, 7, 'forward', true]);
    expect(input.placeholder).toBe('筛选提交'); expect(input.getAttribute('aria-label')).toBe('搜索提交'); expect(node(state.toolbar).getAttribute('aria-label')).toBe('应用全局操作');
    expect(find(root, value => value.classList.contains('repository-toolbar')).getAttribute('aria-label')).toBe('当前仓库操作');
    expect(action(root, 'refresh').title).toContain('刷新'); expect(action(root, 'head').title).toContain('HEAD'); expect(action(root, 'settings').title).toBe('设置（Ctrl+,）');
    expect(action(root, 'scope').textContent).toBe(resolveText(scopeText(state.scope))); expect(node(state.searchScope).textContent).toContain('搜索历史'); expect(node(state.orderSelect).textContent).toContain('拓扑顺序');
    expect(node(state.resizeHandle).getAttribute('aria-label')).toBe('调整提交详情大小'); expect(node(state.sidebarResizer).getAttribute('aria-label')).toBe('调整仓库导航大小');
    expect(refNode.textContent).toBe(repo.branch); expect(root.textContent).toContain(repo.name); expect(root.textContent).toContain('Open repository…'); expect(root.textContent).toContain('No repository');
    setLanguage('en'); expect(input.placeholder).toBe('Filter commits'); expect(action(root, 'refresh').title).toContain('Refresh'); expectNoWork(forbidden); expect(calls(host)).toEqual(beforeCalls);
  });

  it('localizes the live local composer and open history document in place without IO, document activation, or draft/view changes', async () => {
    const localPath = 'Local / 保存.ts', historyPath = 'History / {name}.ts';
    const file = (path: string) => ({ path, oldPath: null, status: ' M', additions: 1, deletions: 1, staged: false, unstaged: true });
    const host = makeHost({
      snapshot: vi.fn(async () => ({ repository: { ...repo }, working: { ...working(), files: [file(localPath)] }, refs: [{ ...ref }], stashes: [], remotes: [], fingerprint: 'dirty-fixture' })),
      commitDetail: vi.fn(async () => ({ commit: structuredClone(commits[0]), body: 'Raw full message / 保存 / {name}', committer: '', committerEmail: '', base: parent, signature: { status: 'unsigned', signer: '', key: '' }, files: [file(historyPath)] })),
      diff: vi.fn(async () => ({ patch: '@@ -1 +1 @@\n-old raw\n+new raw / 保存\n', binary: false, truncated: false, oldContent: 'old raw\n', newContent: 'new raw / 保存\n' })),
    });
    const { state, root } = await makeApp(host); await settle(); paint();
    const draft = action(root, 'local-commit-message'); draft.value = 'Draft raw / 保存 / {name}'; draft.setSelectionRange(3, 11, 'forward'); draft.scrollTop = 9; draft.fire('input');
    state.selectCommit(oid, false); await settle(); paint();
    action(root, 'toggle-full-message').fire('click'); state.table.scrollTop = 81; state.table.scrollLeft = 43;
    const opening = vi.spyOn(state.historyDocuments, 'open'); find(node(state.details.element), value => value.dataset.path === historyPath).fire('click');
    expect(opening).toHaveBeenCalledOnce(); await opening.mock.results[0].value; paint();
    const localPreview = find(node(state.localChanges.previewElement), value => value.classList.contains('diff-scroll'));
    const documentPreview = find(node(state.historyDocuments.surface), value => value.classList.contains('diff-scroll'));
    localPreview.scrollTop = 29; localPreview.scrollLeft = 13; documentPreview.scrollTop = 37; documentPreview.scrollLeft = 17;
    draft.focus(); draft.composing = true;
    const nodes = all(root), beforeCalls = calls(host), writes = draft.valueWrites, detail = structuredClone(state.details.view), active = state.historyDocuments.activeId;
    const forbidden = [...noWork(state, ['buildToolbar', 'buildQuerybar', 'renderTable', 'renderDirectory', 'renderWorkspace', 'loadHistory', 'loadMetadata', 'openHistoryDocument']),
      ...noWork(state.details, ['show', 'updateSettings', 'refresh']), ...noWork(state.localChanges, ['update', 'setPlacement']), ...noWork(state.historyDocuments, ['activate', 'updateSettings', 'invalidate'])];
    const beforeFrames = frames.size, passes = state.graph.preparePasses;
    for (const language of ['zh-CN', 'en'] as const) {
      setLanguage(language);
      expectNoWork(forbidden); expect(calls(host)).toEqual(beforeCalls); expect(all(root)).toEqual(nodes); expect(frames.size).toBe(beforeFrames); expect(state.graph.preparePasses).toBe(passes);
      expect(state.historyDocuments.activeId).toBe(active); expect(state.details.view).toEqual(detail);
      expect(draft.value).toBe('Draft raw / 保存 / {name}'); expect(draft.valueWrites).toBe(writes); expect(dom.activeElement).toBe(draft);
      expect([draft.selectionStart, draft.selectionEnd, draft.selectionDirection, draft.scrollTop, draft.composing]).toEqual([3, 11, 'forward', 9, true]);
      expect([localPreview.scrollTop, localPreview.scrollLeft, documentPreview.scrollTop, documentPreview.scrollLeft]).toEqual([29, 13, 37, 17]);
      expect(draft.getAttribute('aria-label')).toContain(repo.name); expect(draft.getAttribute('aria-label')).toContain(language === 'zh-CN' ? '提交' : 'Commit');
      expect(node(state.historyDocuments.tabs).textContent).toContain(language === 'zh-CN' ? '提交图' : 'Commit graph');
      expect(node(state.localChanges.previewElement).textContent).toContain(localPath); expect(node(state.historyDocuments.surface).textContent).toContain(historyPath);
      expect(node(state.historyDocuments.surface).textContent).toContain('new raw / 保存'); expect(node(state.details.element).textContent).toContain('Raw full message / 保存 / {name}');
    }
    expect(host.diff).toHaveBeenCalledTimes(2); expect(host.history).toHaveBeenCalledOnce(); expect(host.commitDetail).toHaveBeenCalledOnce();
  });

  it('keeps dynamic search placeholders bound after a query-mode change and a restored view', async () => {
    const { state, host } = await makeApp(); state.searchScope.value = 'search'; node(state.searchScope).fire('change'); await settle(); paint();
    const input = node(state.searchInput); input.value = 'Search entire Git history / {name} / 保存'; input.selectionStart = 4; input.focus(); const writes = input.valueWrites, beforeCalls = calls(host);
    expect(input.placeholder).toBe('Search entire Git history'); setLanguage('zh-CN');
    expect(input.placeholder).toBe('搜索完整 Git 历史'); expect(input.value).toBe('Search entire Git history / {name} / 保存'); expect(input.valueWrites).toBe(writes); expect(input.selectionStart).toBe(4); expect(calls(host)).toEqual(beforeCalls);
    state.restoreQuery({ scope: { kind: 'all' }, search: 'raw restored query', searchMode: 'refs', queryMode: 'filter', order: 'author-date', scrollTop: 0, selected: null });
    expect(input.placeholder).toBe('筛选提交'); setLanguage('en'); expect(input.placeholder).toBe('Filter commits'); expect(input.value).toBe('raw restored query'); expect(state.searchType.value).toBe('refs'); expect(state.orderSelect.value).toBe('author-date');
  });

  it('persists status language choice globally without applying settings, rebuilding UI or changing repository overrides', async () => {
    const { state, host } = await makeApp(); state.store.state.repoSettings[repo.id] = { theme: 'light' };
    const forbidden = noWork(state, ['buildToolbar', 'applySettings', 'settingsChanged', 'renderTable', 'loadHistory']);
    const beforeCalls = calls(host), rootInput = state.searchInput, choosing = state.chooseLanguage();
    const dialog = dom.querySelector('dialog[open]')!, control = dialog.querySelector('select')!; expect(control.children.map(option => option.value)).toEqual(['system', 'zh-CN', 'en']);
    control.value = 'zh-CN'; dialog.querySelector('form')!.fire('submit'); await choosing;
    expect(state.store.state.settings.language).toBe('zh-CN'); expect(state.store.state.repoSettings[repo.id]).toEqual({ theme: 'light' }); expect(state.searchInput).toBe(rootInput);
    expectNoWork(forbidden); expect(calls(host)).toEqual(beforeCalls); expect(node(state.toolbar).getAttribute('aria-label')).toBe('应用全局操作');
  });

  it('keeps an invalid advanced-filter draft, focus, validation and field names stable across language changes', async () => {
    const { state, host } = await makeApp(); const opening = state.advancedFilter(), dialog = dom.querySelector('dialog[open]')!;
    const date = find(dialog, value => value.name === 'after'); date.value = 'not-a-date {raw}'; date.focus(); date.selectionStart = 3; date.selectionEnd = 8; dialog.querySelector('form')!.fire('submit');
    const before = all(dialog), beforeCalls = calls(host), writes = date.valueWrites; expect(dialog.textContent).toContain('Dates must use YYYY-MM-DD.');
    setLanguage('zh-CN'); expect(dialog.textContent).toContain('日期必须采用 YYYY-MM-DD 格式。'); expect(dialog.textContent).toContain('作者或邮箱包含'); expect(all(dialog)).toEqual(before);
    expect(date.value).toBe('not-a-date {raw}'); expect(date.valueWrites).toBe(writes); expect(date.name).toBe('after'); expect(dom.activeElement).toBe(date); expect([date.selectionStart, date.selectionEnd]).toEqual([3, 8]); expect(calls(host)).toEqual(beforeCalls);
    dialog.fire('cancel'); await opening;
  });

  it('filters and orders context actions using only stable ids, even when labels collide or group labels change', async () => {
    const { state } = await makeApp(); state.store.state.settings.contextActions.commit = ['revert', 'merge'];
    const custom: MenuItem = { label: ACTION_LABELS.reset, action: vi.fn() };
    const merge: MenuItem = { label: 'not the merge display label', dataAction: 'merge', action: vi.fn() };
    const revert: MenuItem = { label: m('menu.openTerminal'), dataAction: 'revert', action: vi.fn() };
    expect(state.cleanMenu([custom, merge, null, { label: m('menu.openTerminal'), dataAction: 'reset', action: vi.fn() }, revert], 'commit')).toEqual([custom, revert, null, merge]);
    state.store.state.settings.contextActions.branch = ['branch-create']; const branch: MenuItem = { label: 'arbitrary', dataAction: 'create-branch', action: vi.fn() };
    expect(state.cleanMenu([branch, { ...branch, dataAction: 'delete-branch' }], 'branch')).toEqual([branch]);
    state.store.state.settings.contextActions.commit = ['revert']; state.store.state.settings.contextActions.remote = ['push'];
    const group = ACTION_GROUPS.find(value => value.id === 'history')!, previous = group.label; group.label = m('toolbar.remotes');
    try {
      state.moreMenu(state.toolbar); const menu = dom.querySelector('[role="menu"]')!;
      expect(all(menu).some(value => value.dataset.action === 'revert')).toBe(true); expect(all(menu).some(value => value.dataset.action === 'merge')).toBe(false);
      const nodes = all(menu); setLanguage('zh-CN'); expect(all(menu)).toEqual(nodes); expect(menu.textContent).toContain(resolveText(ACTION_LABELS.revert)); expect(all(menu).some(value => value.dataset.action === 'revert')).toBe(true);
    } finally { group.label = previous; closeMenu(); }
  });

  it('shows precise localized error headings while copying untouched original diagnostics before or after init', async () => {
    const host = makeHost(), root = new TestNode(); dom.body.append(root); const app = new App(host, root as unknown as HTMLElement), state = app as unknown as AppInternals; live.push(app);
    const error = { code: 'ARGUMENT', message: 'The start date must not be after HEAD / 保存 / {name}.', detail: 'fatal: raw Git output\nsecond line' }, raw = `${error.message}\n${error.detail}`;
    state.showError(error); setLanguage('zh-CN'); const errorbar = node(state.errorbar);
    expect(errorbar.textContent).toContain(resolveText(errorText(error)).split('\n')[0]); expect(errorbar.textContent).not.toContain('[object Object]');
    titled(errorbar, resolveText(m('error.copy'))).fire('click'); await settle(); expect(host.copy).toHaveBeenLastCalledWith(raw);
    titled(errorbar, resolveText(m('error.details'))).fire('click'); const dialog = dom.querySelector('dialog[open]')!, output = dialog.querySelector('pre')!, nodes = all(dialog);
    expect(output.textContent).toContain(raw); expect(dialog.textContent).toContain('操作错误'); setLanguage('en');
    expect(all(dialog)).toEqual(nodes); expect(output.textContent).toBe(resolveText(errorText(error))); expect(output.textContent).toContain(raw); expect(resolveText(state.statusResult!.message)).toBe(resolveText(errorText(error)).split('\n')[0]);
    dialog.fire('cancel'); await app.init();
    state.showError(new LocalizedError(m('pullRequest.unsafeUrl'))); setLanguage('zh-CN'); expect(errorbar.textContent).toContain('没有安全的拉取请求 URL');
    state.showError(m('pullRequest.invalidTemplate')); expect(errorbar.textContent).toContain('配置有效的拉取请求 URL 模板');
  });

  it('localizes open manager titles, metadata labels, nested yes/no and dates without touching raw tag objects or messages', async () => {
    const timestamp = 1_790_000_000, rawMessage = 'Name: Keep this message / 保存 / {name}', tagRef: GitRef = { ...ref, kind: 'tag', name: 'Tag {name} / 保存', fullName: 'refs/tags/Tag {name} / 保存' };
    const { state, host } = await makeApp(makeHost({ tagDetail: vi.fn(async () => ({ name: tagRef.name, ref: tagRef.fullName, oid, targetOid: parent, targetType: 'commit', annotated: true, tagger: 'Tagger / 保存', email: 'name@example.test', timestamp, message: rawMessage, signature: { status: 'unsigned', signer: 'Signer {name}', key: 'KEY-ID' } })) }));
    const showing = state.showTagDetail(tagRef); await settle(); const dialog = dom.querySelector('dialog[open]')!, output = dialog.querySelector('pre')!, title = dialog.querySelector('h2')!, nodes = all(dialog), beforeCalls = calls(host);
    expect(output.textContent).toContain('Annotated: yes'); expect(output.textContent).toContain(formatFullDate(timestamp)); expect(title.textContent).toBe(`Tag ${tagRef.name}`);
    setLanguage('zh-CN'); expect(all(dialog)).toEqual(nodes); expect(title.textContent).toBe(`标签 ${tagRef.name}`); expect(output.textContent).toContain('附注标签：是'); expect(output.textContent).toContain('类型：commit'); expect(output.textContent).toContain(formatFullDate(timestamp));
    expect(output.textContent).toContain(tagRef.fullName); expect(output.textContent).toContain('Signer {name}'); expect(output.textContent).toContain('KEY-ID'); expect(dialog.textContent).toContain(rawMessage); expect(calls(host)).toEqual(beforeCalls);
    dialog.fire('cancel'); await showing; const closed = dialog.textContent; setLanguage('en'); expect(dialog.textContent).toBe(closed);
  });

  it('localizes stash, remote and submodule managers while preserving selectors, URLs, paths and raw messages', async () => {
    const selector = 'stash@{12}', rawMessage = 'View stash changes / 保存 / {name}', timestamp = 1_790_000_000;
    const { state, host } = await makeApp(makeHost({
      stashDetail: vi.fn(async () => ({ selector, oid, base: parent, index: oid, untracked: null, message: rawMessage, timestamp })),
      remotes: vi.fn(async () => [{ name: 'Fetch / 保存', fetchUrl: 'https://example.test/Fetch/{name}', pushUrl: 'ssh://example.test/Push/保存' }]),
      submodules: vi.fn(async () => [{ name: 'Not initialized', path: 'Modified / 保存', url: 'https://example.test/Untracked', initialized: false, head: null, indexOid: null, modified: true, untracked: true }]),
    }));
    const stash = state.showStashDetail(selector); await settle(); let dialog = dom.querySelector('dialog[open]')!; setLanguage('zh-CN');
    expect(dialog.textContent).toContain(`贮藏 ${selector}`); expect(dialog.textContent).toContain('未跟踪：无'); expect(dialog.textContent).toContain(rawMessage); expect(dialog.textContent).toContain('查看贮藏更改'); dialog.fire('cancel'); await stash;
    setLanguage('en'); const remotes = state.showRemotes(); await settle(); dialog = dom.querySelector('dialog[open]')!; let beforeCalls = calls(host), nodes = all(dialog); setLanguage('zh-CN');
    expect(dialog.textContent).toContain('远程仓库与身份'); expect(dialog.textContent).toContain('获取'); expect(dialog.textContent).toContain('Fetch / 保存'); expect(dialog.textContent).toContain('推送：ssh://example.test/Push/保存'); expect(dialog.textContent).toContain('https://example.test/Fetch/{name}'); expect(all(dialog)).toEqual(nodes); expect(calls(host)).toEqual(beforeCalls); dialog.fire('cancel'); await remotes;
    setLanguage('en'); const modules = state.showSubmodules(); await settle(); dialog = dom.querySelector('dialog[open]')!; beforeCalls = calls(host); nodes = all(dialog); setLanguage('zh-CN');
    expect(dialog.textContent).toContain('子模块'); expect(dialog.textContent).toContain('未初始化 · 已修改 · 未跟踪'); expect(dialog.textContent).toContain('Modified / 保存'); expect(dialog.textContent).toContain('https://example.test/Untracked'); expect(all(dialog)).toEqual(nodes); expect(calls(host)).toEqual(beforeCalls); dialog.fire('cancel'); await modules;
  });

  it('keeps a pending write and cancel controls alive across locale changes and composes the completed label as a nested descriptor', async () => {
    const pending = deferred<ActionResult>(), { state, host } = await makeApp(makeHost({ action: vi.fn(() => pending.promise) }));
    const running = state.execute({ repoId: repo.id, requestId: '', kind: 'merge', target: parent }, ACTION_LABELS.merge), operation = node(state.operationbar), nodes = all(operation), task = state.activeWrite, beforeCalls = calls(host);
    expect(operation.textContent).toContain('Merge'); setLanguage('zh-CN');
    expect(all(operation)).toEqual(nodes); expect(operation.textContent).toContain('合并'); expect(operation.textContent).toContain('取消进程'); expect(state.activeWrite).toBe(task); expect(calls(host)).toEqual(beforeCalls);
    pending.resolve({ output: 'Raw output / 保存', operation: null, status: 'completed' }); await running;
    expect(node(state.toastElement).textContent).toBe('合并已完成。'); expect(node(state.toastElement).textContent).not.toContain('[object Object]');
    setLanguage('en'); expect(node(state.toastElement).textContent).toBe('Merge completed.'); expect(state.activeWrite).toBeNull();
  });

  it('updates a pending directory scan presentation without restarting discovery or changing pending width, depth or controls', async () => {
    const pending = deferred<RepositoryDiscovery>(), { state, host } = await makeApp(makeHost({ discoverRepositories: vi.fn(() => pending.promise) }), false);
    const scan = state.openDirectory('D:/No repository / 保存'), scope = state.directoryPendingScope!; scope.width = 311; state.renderDirectory();
    const nodes = all(node(state.sidebar)), beforeCalls = calls(host), generation = state.openGeneration; setLanguage('zh-CN');
    expect(state.directoryPendingScope).toBe(scope); expect(scope.width).toBe(311); expect(scope.depth).toBe(2); expect(state.directoryLoading).toBe(true); expect(state.openGeneration).toBe(generation); expect(all(node(state.sidebar))).toEqual(nodes); expect(calls(host)).toEqual(beforeCalls);
    pending.resolve({ root: scope.root, repositories: [], complete: true, limit: null, warnings: [], directories: 1, entries: 0 }); await scan;
    expect(host.discoverRepositories).toHaveBeenCalledOnce(); expect(host.openRepository).not.toHaveBeenCalled(); expect(state.store.state.directoryScope?.width).toBe(311); expect(node(state.historyOverlay).textContent).toContain('未打开仓库');
  });
});

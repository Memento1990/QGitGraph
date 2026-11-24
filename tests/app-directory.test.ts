import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopHost } from '../src/host';
import { initI18n } from '../src/lib/i18n';
import type { StateStore } from '../src/lib/state';
import {
  defaultState, type AppSettings, type ChangedFile, type Commit, type CommitDetail, type DiffQuery, type DiffResult, type DirectoryScopeState, type HistoryPage, type HistoryQuery, type Host,
  type Repository, type RepositoryCandidate, type RepositoryDiscovery, type RepositorySnapshot, type RepositorySummary, type ViewState, type WorkingAction,
} from '../src/shared/protocol';
import { App } from '../src/ui/app';
import type { DetailsPane } from '../src/ui/details';
import type { HistoryDocuments } from '../src/ui/history-documents';
import type { LocalChangesPane } from '../src/ui/local-changes';
import { closeMenu, disposeBindings } from '../src/ui/dom';
import type { CommitTable } from '../src/ui/table';

const nativeInvoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }));

/** Presentation adapter only. App, the repository tree, history table and details all run unchanged. */
class TestNode {
  readonly tagName: string;
  readonly nodeType: number;
  parentNode: TestNode | null = null;
  children: TestNode[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  events = new Map<string, ((event: TestEvent) => void)[]>();
  className = ''; id = ''; title = ''; placeholder = ''; type = ''; value = ''; text = '';
  hidden = false; disabled = false; checked = false; open = false; tabIndex = 0;
  scrollTop = 0; scrollLeft = 0; clientHeight = 560; clientWidth = 1000; offsetHeight = 100;
  selectionStart = 0; selectionEnd = 0; selectionDirection = 'none';
  style: Record<string, unknown> = { setProperty: (key: string, value: string) => { this.style[key] = value; }, getPropertyValue: () => '' };
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
    toggle: (name: string, force?: boolean) => { const enabled = force ?? !this.classList.contains(name); if (enabled) this.classList.add(name); else this.classList.remove(name); return enabled; },
  };
  constructor(tag = 'div', text = '') { this.tagName = tag.startsWith('#') ? tag : tag.toUpperCase(); this.nodeType = tag === '#text' ? 3 : tag === '#fragment' ? 11 : 1; this.text = text; }
  get nodeName(): string { return this.tagName; }
  get parentElement(): TestNode | null { return this.parentNode; }
  get firstElementChild(): TestNode | null { return this.children.find(child => child.nodeType === 1) ?? null; }
  get nextElementSibling(): TestNode | null { const siblings = this.parentNode?.children ?? []; return siblings.slice(siblings.indexOf(this) + 1).find(child => child.nodeType === 1) ?? null; }
  get isConnected(): boolean { return this === dom.body || Boolean(this.parentNode?.isConnected); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(text: string) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = text; }
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
  remove(): void { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  contains(node: TestNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); if (name === 'title') this.title = value; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, [...(this.events.get(name) ?? []), listener]); }
  removeEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, (this.events.get(name) ?? []).filter(value => value !== listener)); }
  fire(name: string, extra: Partial<TestEvent> = {}): void {
    let stopped = false;
    const event = { target: this, key: '', button: 0, clientX: 0, clientY: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn(() => { stopped = true; }), ...extra };
    const bubbles = ['click', 'dblclick', 'keydown', 'input', 'change', 'contextmenu'].includes(name);
    for (let current: TestNode | null = this; current; current = bubbles && !stopped ? current.parentNode : null) current.events.get(name)?.forEach(listener => listener(event));
  }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const attribute = /^(\w+)?\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) {
      if (attribute[1] && this.tagName !== attribute[1].toUpperCase()) return false;
      const key = attribute[2], value = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] : this.attributes.get(key);
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
  scrollIntoView(): void {}
  getBoundingClientRect() { return { top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  getContext(): null { return null; }
}
interface TestEvent { target: TestNode; key: string; button: number; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean; preventDefault(): void; stopPropagation(): void }
const all = (root: TestNode): TestNode[] => [root, ...root.children.flatMap(all)];
const dom = {
  body: new TestNode('body'), documentElement: new TestNode('html'), activeElement: null as TestNode | null, hidden: false,
  createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('#text', text), createDocumentFragment: () => new TestNode('#fragment'),
  getElementById: (id: string) => all(dom.body).find(node => node.id === id) ?? null,
  querySelector: (selector: string) => dom.body.querySelector(selector), addEventListener: vi.fn(), removeEventListener: vi.fn(),
};
const node = (value: Node) => value as unknown as TestNode;
function required(root: TestNode, selector: string): TestNode { const found = root.querySelector(selector); if (!found) throw new Error(`Missing fixture node: ${selector}`); return found; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle(): Promise<void> { for (let count = 0; count < 32; count++) await Promise.resolve(); }
let frames: Map<number, FrameRequestCallback>, nextFrame = 0;
function paint(): void { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0)); }

// These are opaque fixture paths; no test reads a repository, user profile or filesystem.
const ROOT = 'D:/DirectoryFixtures/projects', OTHER = 'D:/DirectoryFixtures/other';
const A = `${ROOT}/a`, B = `${ROOT}/b`, C = `${OTHER}/c`;
const oid = (character: string) => character.repeat(40);
const changedFile = (path = 'local.ts', staged = false): ChangedFile => ({ path, oldPath: null, status: staged ? 'M ' : ' M', additions: 1, deletions: 1, staged, unstaged: !staged });
const candidate = (path: string, components = [path.split('/').at(-1)!]): RepositoryCandidate => ({ path, components, marker: 'git-directory' });
const discovery = (root: string, repositories: RepositoryCandidate[], extra: Partial<RepositoryDiscovery> = {}): RepositoryDiscovery => ({ root, repositories, complete: true, limit: null, warnings: [], directories: 4, entries: 12, ...extra });
function fixtureState() { const state = defaultState(); state.settings.language = 'en'; state.settings.autoLoad = false; state.settings.autoCenterDetails = false; return state; }
function fixtureCommit(repo: Repository): Commit { return { oid: repo.head!, parents: [], author: `Author ${repo.name}`, email: `${repo.name}@example.test`, subject: `Commit ${repo.name}`, authoredAt: 1, committedAt: 2, refs: [] }; }
class FakeHost {
  readonly state = fixtureState();
  readonly files = new Map<string, ChangedFile[]>();
  readonly unlistenRepository = vi.fn();
  private readonly repositories = new Map<string, Repository>();
  nativeActive: Repository | null = null;
  repository(path: string): Repository {
    const id = `fixture:${path}`;
    if (!this.repositories.has(id)) this.repositories.set(id, { id, path, name: path.split('/').at(-1)!, gitDir: `${path}/.git`, commonDir: `${path}/.git`, head: oid(path === B ? 'b' : path === C ? 'c' : 'a'), branch: 'main', trusted: false, bare: false });
    return this.repositories.get(id)!;
  }
  private byId(id: string): Repository { const repo = this.repositories.get(id); if (!repo) throw new Error(`Unexpected fixture repository: ${id}`); return repo; }
  loadState = vi.fn(async () => structuredClone(this.state));
  saveState = vi.fn(async () => {});
  diagnostics = vi.fn(async () => ({ appVersion: '0.3.0', gitVersion: 'git fixture', gitPath: 'git', platform: 'fixture', hostMode: 'desktop' as const }));
  onRepositoryChanged = vi.fn(async (_listener: (repoId: string) => void) => this.unlistenRepository);
  onExternalSession = vi.fn(async () => () => {});
  discoverRepositories = vi.fn(async (path: string, _depth: number, _requestId?: string): Promise<RepositoryDiscovery> => discovery(path, []));
  openRepository = vi.fn(async (path: string, _requestId?: string, _scopeRoot?: string): Promise<Repository> => { const repo = this.repository(path); this.nativeActive = repo; return structuredClone(repo); });
  deactivateRepository = vi.fn(async (_requestId?: string) => { this.nativeActive = null; });
  snapshot = vi.fn(async (repoId: string, _requestId: string): Promise<RepositorySnapshot> => {
    const repo = this.byId(repoId);
    return { repository: structuredClone(repo), working: { files: structuredClone(this.files.get(repo.path) ?? []), head: repo.head, branch: repo.branch, ahead: 0, behind: 0, conflicts: 0, operation: null }, refs: [], stashes: [], remotes: [], fingerprint: repoId };
  });
  history = vi.fn(async (query: HistoryQuery) => ({ commits: [fixtureCommit(this.byId(query.repoId))], hasMore: false }));
  commitDetail = vi.fn(async (repoId: string, commitOid: string, _requestId: string): Promise<CommitDetail> => {
    const repo = this.byId(repoId);
    return { commit: { ...fixtureCommit(repo), oid: commitOid }, body: `Full message ${repo.name}\n\nRaw details / 保存`, committer: '', committerEmail: '', signature: { status: 'unsigned', signer: '', key: '' }, base: null, files: [{ path: `${repo.name}.ts`, oldPath: null, status: 'M', additions: 1, deletions: 1, staged: false, unstaged: false }] };
  });
  diff = vi.fn(async (_query: DiffQuery): Promise<DiffResult> => ({ patch: '@@ -1 +1 @@\n-old\n+new\n', binary: false, truncated: false, oldContent: 'old\n', newContent: 'new\n' }));
  workingIndex = vi.fn(async (_repoId: string, _requestId: string): Promise<string | null> => 'fixture-index');
  workingAction = vi.fn(async (_action: WorkingAction) => ({ output: '', operation: null }));
  cancel = vi.fn(async (_requestId: string) => {});
  trustRepository = vi.fn(async () => {});
  refs = vi.fn(async () => []);
  workingState = vi.fn(async () => { throw new Error('Use the single selected repository snapshot'); });
  stashes = vi.fn(async () => []);
  remotes = vi.fn(async () => []);
  repoConfig = vi.fn(async () => { throw new Error('Discovery must not inspect repository config'); });
  action = vi.fn(async () => ({ output: '', operation: null }));
  copy = vi.fn(async () => {});
  openUrl = vi.fn(async () => {});
}
type AppInternals = {
  store: StateStore; repo: Repository | null; commits: Commit[]; selected: string | null; compareBase: string | null;
  initialized: boolean; loadingRepo: boolean; loadingHistory: boolean; detailsOpen: boolean;
  directoryDiscovery: RepositoryDiscovery | null; directoryPendingScope: DirectoryScopeState | null;
  directoryFlight: Promise<RepositoryDiscovery> | undefined; directoryLoading: boolean; directoryCancelled: boolean; directoryError: string | null;
  openingPath: string | null; sidebar: HTMLElement; sidebarResizer: HTMLElement; historyOverlay: HTMLElement; errorbar: HTMLElement;
  table: CommitTable; details: DetailsPane; historyDocuments: HistoryDocuments; localChanges: LocalChangesPane;
  localOpen: boolean; localDecision: boolean | null; graphSurface: HTMLElement; graphScroll: { top: number; left: number }; openGeneration: number;
  scope: ViewState['scope']; search: string; searchMode: string; queryMode: ViewState['queryMode']; order: ViewState['order'];
  searchInput: HTMLInputElement; searchScope: HTMLSelectElement; searchType: HTMLSelectElement; orderSelect: HTMLSelectElement;
  openDirectory(path: string, depth?: number, restore?: boolean, remembered?: string | null): Promise<void>;
  activateCandidate(candidate: RepositoryCandidate): Promise<boolean>; openRepository(path: string, scopeRoot?: string): Promise<boolean>;
  closeDirectory(): void; closeRepository(): void; toggleSidebar(visible?: boolean): void; cancelDirectoryScan(): void;
  selectCommit(oid: string, compare: boolean, intent?: 'toggle' | 'ensure-open'): void; setScope(scope: ViewState['scope']): void; saveView(): void;
  refresh(): Promise<void>; updateSettings(patch: Partial<AppSettings>): void; closeDetails(): void;
  repositoryRowAction(candidate: RepositoryCandidate, anchor: HTMLElement, kind: 'branch' | 'sync' | 'commit' | 'refresh' | 'more'): Promise<void>;
  refreshQueue: { idle(): Promise<void>; pendingMask: number };
};
const live: App[] = [];
function constructApp(host: FakeHost | Host = new FakeHost()) {
  const root = new TestNode(); dom.body.append(root);
  const app = new App(host as unknown as Host, root as unknown as HTMLElement); live.push(app);
  return { app, state: app as unknown as AppInternals, root };
}
async function makeApp(host = new FakeHost()) { const value = constructApp(host); await value.app.init(); paint(); return { ...value, host }; }
async function openMulti(host = new FakeHost()) {
  const candidates = [candidate(A), candidate(B)]; host.discoverRepositories.mockResolvedValueOnce(discovery(ROOT, candidates));
  const value = await makeApp(host); await value.state.openDirectory(ROOT); paint(); return { ...value, candidates };
}
function expectNoGit(host: FakeHost): void { for (const call of [host.openRepository, host.snapshot, host.history, host.commitDetail, host.diff, host.workingIndex, host.workingAction, host.refs, host.workingState, host.stashes, host.remotes, host.repoConfig, host.action, host.trustRepository]) expect(call).not.toHaveBeenCalled(); }

beforeEach(() => {
  vi.useFakeTimers(); nativeInvoke.mockReset();
  dom.body = new TestNode('body'); dom.documentElement = new TestNode('html'); dom.activeElement = null; dom.hidden = false;
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

describe('App directory discovery and activation', () => {
  it('does structural discovery without Git, recents or trust fan-out, then activates only the actual tree-row selection', async () => {
    const gate = deferred<RepositoryDiscovery>(), host = new FakeHost();
    host.state.recent = [{ path: 'D:/DirectoryFixtures/recent', name: 'recent' }]; host.state.trusted = ['D:/DirectoryFixtures/trusted'];
    host.discoverRepositories.mockImplementationOnce(() => gate.promise);
    const { state, root } = await makeApp(host), scan = state.openDirectory(ROOT);
    expectNoGit(host); expect(state.directoryLoading).toBe(true);
    gate.resolve(discovery(ROOT, [candidate(A), candidate(B)])); await scan; paint();
    expectNoGit(host); expect(state.repo).toBeNull(); expect(state.sidebar.hidden).toBe(false);
    expect(state.store.state.recent).toEqual(host.state.recent); expect(state.store.state.trusted).toEqual(host.state.trusted);
    // RepositoryTree creates its own candidate objects. Exercise its real callback, not reference equality on the scan DTO.
    required(root, '[data-repository-key="b"]').fire('click'); await settle(); paint();
    expect(host.openRepository).toHaveBeenCalledExactlyOnceWith(B, expect.any(String), ROOT);
    expect(state.errorbar.hidden, node(state.errorbar).textContent).toBe(true);
    expect(host.snapshot).toHaveBeenCalledExactlyOnceWith(host.repository(B).id, expect.any(String));
    expect(host.history).toHaveBeenCalledOnce(); expect(host.history.mock.calls[0][0].repoId).toBe(host.repository(B).id);
    expect(state.repo?.path).toBe(B); expect(state.store.state.recent.map(item => item.path)).toEqual([B, 'D:/DirectoryFixtures/recent']);
    expect(state.store.state.trusted).toEqual(host.state.trusted); expect(host.trustRepository).not.toHaveBeenCalled();
    for (const call of [host.refs, host.workingState, host.stashes, host.remotes, host.repoConfig, host.action]) expect(call).not.toHaveBeenCalled();
  });

  it('auto-activates a complete single result and collapses only after activation succeeds', async () => {
    const gate = deferred<Repository>(), host = new FakeHost(); host.openRepository.mockImplementationOnce(() => gate.promise);
    host.discoverRepositories.mockResolvedValueOnce(discovery(ROOT, [candidate(A)]));
    const { state } = await makeApp(host), scan = state.openDirectory(ROOT); await settle();
    expect(host.openRepository).toHaveBeenCalledOnce(); expect(state.repo).toBeNull(); expect(state.sidebar.hidden).toBe(false);
    gate.resolve(host.repository(A)); await scan;
    expect(state.repo?.path).toBe(A); expect(state.store.state.directoryScope?.collapsed).toBe(true); expect(state.sidebar.hidden).toBe(true);
  });

  it('does not infer a single-repository scope from an incomplete one-candidate scan', async () => {
    const host = new FakeHost(); host.discoverRepositories.mockResolvedValueOnce(discovery(ROOT, [candidate(A)], { complete: false, limit: 'entries' }));
    const { state, root } = await makeApp(host); await state.openDirectory(ROOT);
    expectNoGit(host); expect(state.store.state.directoryScope?.collapsed).toBe(false);
    expect(required(root, '.repository-tree-status-text').textContent).toMatch(/partial|incomplete|limit/i);
  });

  it('honors a manual expansion while automatic single-repository activation is still pending', async () => {
    const gate = deferred<Repository>(), host = new FakeHost(); host.openRepository.mockImplementationOnce(() => gate.promise);
    host.discoverRepositories.mockResolvedValueOnce(discovery(ROOT, [candidate(A)]));
    const { state } = await makeApp(host), scan = state.openDirectory(ROOT); await settle();
    state.toggleSidebar(false); state.toggleSidebar(true);
    gate.resolve(host.repository(A)); await scan;
    expect(state.repo?.path).toBe(A); expect(state.store.state.directoryScope?.collapsed).toBe(false); expect(state.sidebar.hidden).toBe(false);
  });

  it('restores an explicitly expanded persisted single-repository scope without auto-collapsing it', async () => {
    const host = new FakeHost(); host.state.lastRepo = A;
    host.state.directoryScope = { root: ROOT, depth: 3, width: 311, collapsed: false, collapsedPaths: [] };
    host.discoverRepositories.mockResolvedValueOnce(discovery(ROOT, [candidate(A)]));
    const { state } = await makeApp(host);
    expect(state.repo?.path).toBe(A); expect(state.store.state.directoryScope).toEqual(host.state.directoryScope); expect(state.sidebar.hidden).toBe(false);
  });

  it('keeps manually collapsed navigation and its width/disclosures during a same-root rescan', async () => {
    const { state, host, candidates } = await openMulti(); state.toggleSidebar(false);
    Object.assign(state.store.state.directoryScope!, { width: 307, collapsedPaths: ['a'] });
    const gate = deferred<RepositoryDiscovery>(); host.discoverRepositories.mockImplementationOnce(() => gate.promise);
    const scan = state.openDirectory(ROOT, 4);
    expect(state.sidebar.hidden).toBe(true); expect(state.directoryPendingScope).toMatchObject({ collapsed: true, width: 307, collapsedPaths: ['a'], depth: 4 });
    gate.resolve(discovery(ROOT, candidates)); await scan;
    expect(state.store.state.directoryScope).toMatchObject({ collapsed: true, width: 307, collapsedPaths: ['a'], depth: 4 }); expect(state.sidebar.hidden).toBe(true);
  });

  it('does not let an old single-repository activation completion collapse a newer same-root multi-repository scan', async () => {
    const host = new FakeHost(), metadata = deferred<RepositorySnapshot>(), history = deferred<HistoryPage>();
    host.discoverRepositories.mockResolvedValueOnce(discovery(ROOT, [candidate(A)]));
    host.snapshot.mockImplementationOnce(() => metadata.promise); host.history.mockImplementationOnce(() => history.promise);
    const { state } = await makeApp(host), oldScan = state.openDirectory(ROOT, 1); await settle();
    expect(state.repo?.path).toBe(A); expect(host.snapshot).toHaveBeenCalledOnce(); expect(host.history).toHaveBeenCalledOnce();
    const latestDiscovery = discovery(ROOT, [candidate(A), candidate(B)]);
    host.discoverRepositories.mockResolvedValueOnce(latestDiscovery); await state.openDirectory(ROOT, 3);
    expect(state.store.state.directoryScope).toMatchObject({ root: ROOT, depth: 3, collapsed: false });
    const repo = host.repository(A);
    metadata.resolve({ repository: repo, working: { files: [], head: repo.head, branch: repo.branch, ahead: 0, behind: 0, conflicts: 0, operation: null }, refs: [], stashes: [], remotes: [], fingerprint: 'late-single' });
    history.resolve({ commits: [fixtureCommit(repo)], hasMore: false }); await oldScan; await settle();
    expect(state.directoryDiscovery).toBe(latestDiscovery); expect(host.openRepository).toHaveBeenCalledOnce();
    expect(state.store.state.directoryScope).toMatchObject({ root: ROOT, depth: 3, collapsed: false }); expect(state.sidebar.hidden).toBe(false);
  });

  it('preserves pending same-root disclosure, sidebar width and visibility preferences across depth changes, cancellation and failure', async () => {
    const { state, host, root, candidates } = await openMulti(), oldGate = deferred<RepositoryDiscovery>(), failedGate = deferred<RepositoryDiscovery>();
    const width = Math.max(state.store.state.directoryScope!.width, Number(node(state.sidebarResizer).getAttribute('aria-valuemin')));
    host.discoverRepositories.mockImplementationOnce(() => oldGate.promise).mockImplementationOnce(() => failedGate.promise);
    const oldScan = state.openDirectory(ROOT, 3);
    required(root, '[data-repository-key=""]').fire('keydown', { key: 'ArrowLeft' });
    node(state.sidebarResizer).fire('keydown', { key: 'ArrowRight' }); state.toggleSidebar(false);
    expect(state.directoryPendingScope).toMatchObject({ root: ROOT, depth: 3, width: width + 8, collapsed: true, collapsedPaths: [''] });
    const changedDepth = state.openDirectory(ROOT, 4);
    expect(state.directoryPendingScope).toMatchObject({ root: ROOT, depth: 4, width: width + 8, collapsed: true, collapsedPaths: [''] });
    state.cancelDirectoryScan();
    expect(state.store.state.directoryScope).toMatchObject({ root: ROOT, depth: 2, width: width + 8, collapsed: true, collapsedPaths: [''] });
    expect(state.sidebar.hidden).toBe(true);
    oldGate.resolve(discovery(ROOT, candidates)); await Promise.all([oldScan, changedDepth]);

    const failedScan = state.openDirectory(ROOT, 5); state.toggleSidebar(true);
    required(root, '[data-repository-key=""]').fire('keydown', { key: 'ArrowRight' });
    node(state.sidebarResizer).fire('keydown', { key: 'ArrowRight' });
    expect(state.directoryPendingScope).toMatchObject({ width: width + 16, collapsed: false, collapsedPaths: [] });
    failedGate.reject({ code: 'IO', message: 'Fixture rescan unavailable' }); await failedScan;
    expect(state.store.state.directoryScope).toMatchObject({ root: ROOT, depth: 2, width: width + 16, collapsed: false, collapsedPaths: [] });
    expect(state.sidebar.hidden).toBe(false); expect(required(root, '[data-repository-key=""]').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps the previous scope and active repository when a replacement scan fails', async () => {
    const { state, host, candidates, root } = await openMulti(); await state.activateCandidate(candidates[0]);
    const previousScope = structuredClone(state.store.state.directoryScope), previousDiscovery = state.directoryDiscovery, previousCommits = state.commits;
    const gate = deferred<RepositoryDiscovery>(); host.discoverRepositories.mockImplementationOnce(() => gate.promise);
    const scan = state.openDirectory(OTHER); gate.reject({ code: 'IO', message: 'Fixture directory disconnected' }); await scan;
    expect(state.store.state.directoryScope).toEqual(previousScope); expect(state.directoryDiscovery).toBe(previousDiscovery);
    expect(state.repo?.path).toBe(A); expect(state.commits).toBe(previousCommits); expect(host.deactivateRepository).not.toHaveBeenCalled();
    expect(state.directoryLoading).toBe(false); expect(required(root, '.repository-tree-status-text').textContent).toContain('Scan failed');
    expect(node(state.errorbar).textContent).toContain('Fixture directory disconnected');
  });

  it('cancels without replacing a previous scope/active repository even if the old worker later succeeds', async () => {
    const { state, host, candidates } = await openMulti(); await state.activateCandidate(candidates[0]);
    const previousScope = structuredClone(state.store.state.directoryScope), previousDiscovery = state.directoryDiscovery;
    const gate = deferred<RepositoryDiscovery>(); host.discoverRepositories.mockImplementationOnce(() => gate.promise);
    const scan = state.openDirectory(OTHER), requestId = host.discoverRepositories.mock.calls.at(-1)![2];
    state.cancelDirectoryScan(); expect(host.cancel).toHaveBeenCalledWith(requestId); expect(state.directoryFlight).toBe(gate.promise);
    gate.resolve(discovery(OTHER, [candidate(C)])); await scan;
    expect(state.store.state.directoryScope).toEqual(previousScope); expect(state.directoryDiscovery).toBe(previousDiscovery); expect(state.repo?.path).toBe(A);
    expect(state.directoryCancelled).toBe(true); expect(state.directoryLoading).toBe(false); expect(host.openRepository).toHaveBeenCalledOnce(); expect(host.deactivateRepository).not.toHaveBeenCalled();
  });

  it('waits for actual cancelled-worker completion and starts only the latest queued rescan, without overlap', async () => {
    const { state, host, candidates } = await openMulti(), first = deferred<RepositoryDiscovery>(), latest = deferred<RepositoryDiscovery>();
    let workers = 0, peakWorkers = 0;
    const worker = (gate: ReturnType<typeof deferred<RepositoryDiscovery>>) => { workers++; peakWorkers = Math.max(peakWorkers, workers); return gate.promise.finally(() => { workers--; }); };
    host.discoverRepositories.mockImplementationOnce(() => worker(first)).mockImplementationOnce(() => worker(latest));
    const oldScan = state.openDirectory(ROOT, 2); state.cancelDirectoryScan();
    const skippedScan = state.openDirectory(ROOT, 3), currentScan = state.openDirectory(ROOT, 5); await settle();
    expect(host.discoverRepositories).toHaveBeenCalledTimes(2); expect(workers).toBe(1);
    first.resolve(discovery(ROOT, [candidate(A)])); await settle();
    expect(host.discoverRepositories.mock.calls.map(call => call[1])).toEqual([2, 2, 5]); expect(workers).toBe(1); expect(peakWorkers).toBe(1);
    latest.resolve(discovery(ROOT, candidates)); await Promise.all([oldScan, skippedScan, currentScan]);
    expect(state.store.state.directoryScope?.depth).toBe(5); expect(workers).toBe(0); expect(state.directoryFlight).toBeUndefined(); expectNoGit(host);
  });

  it('closes the folder, invalidates pending scan/open results, and deactivates the native repository', async () => {
    const { state, host, candidates } = await openMulti(); await state.activateCandidate(candidates[0]);
    const scanGate = deferred<RepositoryDiscovery>(), openGate = deferred<Repository>();
    host.discoverRepositories.mockImplementationOnce(() => scanGate.promise); host.openRepository.mockImplementationOnce(() => openGate.promise);
    const scan = state.openDirectory(ROOT), opening = state.activateCandidate(candidates[1]); await settle();
    const scanId = host.discoverRepositories.mock.calls.at(-1)![2], openId = host.openRepository.mock.calls.at(-1)![1];
    state.closeDirectory(); await settle();
    expect(host.cancel).toHaveBeenCalledWith(scanId); expect(host.cancel).toHaveBeenCalledWith(openId); expect(host.deactivateRepository).toHaveBeenCalledOnce();
    scanGate.resolve(discovery(ROOT, [candidate(B)])); openGate.resolve(host.repository(B)); await Promise.all([scan, opening]);
    expect(state.store.state.directoryScope).toBeNull(); expect(state.directoryDiscovery).toBeNull(); expect(state.repo).toBeNull(); expect(state.store.state.lastRepo).toBeNull();
    expect(state.sidebar.hidden).toBe(true); expect(state.commits).toEqual([]); expect(host.snapshot).toHaveBeenCalledOnce(); expect(host.history).toHaveBeenCalledOnce();
  });

  it('a direct-open intent invalidates in-flight discovery before its late auto-activation can replace the requested repository', async () => {
    const { state, host } = await openMulti(), scanGate = deferred<RepositoryDiscovery>(), openGate = deferred<Repository>();
    host.discoverRepositories.mockImplementationOnce(() => scanGate.promise); host.openRepository.mockImplementationOnce(() => openGate.promise);
    const scan = state.openDirectory(OTHER), scanId = host.discoverRepositories.mock.calls.at(-1)![2];
    const opening = state.openRepository(B); await settle();
    expect(host.cancel).toHaveBeenCalledWith(scanId); expect(state.store.state.directoryScope?.root).toBe(ROOT);
    scanGate.resolve(discovery(OTHER, [candidate(C)])); await scan;
    expect(host.openRepository).toHaveBeenCalledExactlyOnceWith(B, expect.any(String), undefined);
    openGate.resolve(host.repository(B)); await opening;
    expect(state.repo?.path).toBe(B); expect(state.store.state.directoryScope).toBeNull(); expect(state.directoryDiscovery).toBeNull();
  });

  it('does not reopen captured remembered A after two queued rescans when the user has selected B', async () => {
    const { state, host, candidates } = await openMulti(); await state.activateCandidate(candidates[0]);
    const oldGate = deferred<RepositoryDiscovery>(), latestGate = deferred<RepositoryDiscovery>();
    host.discoverRepositories.mockImplementationOnce(() => oldGate.promise).mockImplementationOnce(() => latestGate.promise);
    const oldScan = state.openDirectory(ROOT, 2), latestScan = state.openDirectory(ROOT, 3);
    await state.activateCandidate(candidates[1]);
    oldGate.resolve(discovery(ROOT, candidates)); await settle();
    // B disappeared from the new scan (e.g. temporarily disconnected). That is not permission to undo the user's activation.
    latestGate.resolve(discovery(ROOT, [candidate(A), candidate(`${ROOT}/new`)])); await Promise.all([oldScan, latestScan]);
    expect(host.openRepository.mock.calls.map(call => call[0])).toEqual([A, B]); expect(state.repo?.path).toBe(B); expect(state.store.state.lastRepo).toBe(B);
    expect(host.deactivateRepository).not.toHaveBeenCalled();
  });

  it('does not let single-result scan auto-selection supersede a newer still-pending candidate activation', async () => {
    const { state, host, candidates } = await openMulti(); await state.activateCandidate(candidates[0]);
    const scanGate = deferred<RepositoryDiscovery>(), openGate = deferred<Repository>();
    host.discoverRepositories.mockImplementationOnce(() => scanGate.promise); host.openRepository.mockImplementationOnce(() => openGate.promise);
    const scan = state.openDirectory(ROOT), opening = state.activateCandidate(candidates[1]); await settle();
    scanGate.resolve(discovery(ROOT, [candidate(`${ROOT}/new`)])); await scan;
    expect(host.openRepository.mock.calls.map(call => call[0])).toEqual([A, B]);
    openGate.resolve(host.repository(B)); await opening;
    expect(state.repo?.path).toBe(B); expect(state.store.state.lastRepo).toBe(B); expect(host.deactivateRepository).not.toHaveBeenCalled();
  });

  it('shows an honest disconnected startup scope error instead of a successful empty scan or endless preferences spinner', async () => {
    const host = new FakeHost(); host.state.lastRepo = A;
    host.state.directoryScope = { root: ROOT, depth: 2, width: 240, collapsed: false, collapsedPaths: [] };
    host.discoverRepositories.mockRejectedValueOnce({ code: 'IO', message: 'Fixture drive disconnected' });
    const { state, root } = await makeApp(host);
    expectNoGit(host); expect(state.initialized).toBe(true); expect(state.directoryLoading).toBe(false); expect(state.directoryDiscovery).toBeNull();
    expect(state.store.state.directoryScope).toEqual(host.state.directoryScope);
    expect(required(root, '.repository-tree-status-text').textContent).toContain('Scan failed');
    expect(required(root, '.repository-tree-error').textContent).toContain('Fixture drive disconnected');
    expect(node(state.historyOverlay).querySelector('.loading-state')).toBeNull(); expect(node(state.historyOverlay).textContent).not.toContain('Loading local preferences');
    expect(required(root, '.repository-tree-status-text').textContent).not.toContain('No repositories found');
  });
});

describe('App workspace integration with fixture-only repositories', () => {
  it('toggles only local changes on a repeated active-row click without expanding repository descendants or reopening history', async () => {
    const host = new FakeHost(); host.files.set(A, [changedFile('a-local.ts')]);
    const candidates = [candidate(A), candidate(`${A}/nested`, ['a', 'nested']), candidate(B)];
    host.discoverRepositories.mockResolvedValueOnce(discovery(ROOT, candidates));
    const { state, root } = await makeApp(host); await state.openDirectory(ROOT);
    const row = required(root, '[data-repository-key="a"]'), nested = required(root, '[data-repository-key="a/nested"]');
    const expanded = row.getAttribute('aria-expanded'); expect(expanded).toBe('true');
    row.fire('click'); await settle(); paint();
    expect(state.localOpen).toBe(true); expect(state.localChanges.element.hidden).toBe(false);
    const history = state.commits, calls = [host.openRepository.mock.calls.length, host.snapshot.mock.calls.length, host.history.mock.calls.length, host.diff.mock.calls.length];
    const preview = required(node(state.localChanges.previewElement), '.diff-scroll');
    preview.scrollTop = 31; preview.scrollLeft = 15;
    for (const open of [false, true, false, true]) {
      row.fire('click'); await settle(); paint();
      expect(state.localOpen).toBe(open); expect(state.localChanges.element.hidden).toBe(!open);
      expect(row.getAttribute('aria-expanded')).toBe(expanded); expect(required(root, '[data-repository-key="a/nested"]')).toBe(nested);
      expect(state.commits).toBe(history); expect(state.selected).toBeNull(); expect(state.detailsOpen).toBe(false);
      expect([host.openRepository.mock.calls.length, host.snapshot.mock.calls.length, host.history.mock.calls.length, host.diff.mock.calls.length]).toEqual(calls);
    }
    expect(required(node(state.localChanges.previewElement), '.diff-scroll')).toBe(preview); expect([preview.scrollTop, preview.scrollLeft]).toEqual([31, 15]);
    expect(host.commitDetail).not.toHaveBeenCalled(); expect(state.historyDocuments.size).toBe(0);
  });

  it('keeps clean repositories closed and isolates row-button events from active-row toggling', async () => {
    const { state, host, candidates, root } = await openMulti(); await state.activateCandidate(candidates[0]); paint();
    const row = required(root, '[data-repository-key="a"]'), current = state.commits;
    for (let count = 0; count < 3; count++) { row.fire('click'); await settle(); paint(); expect(state.localOpen).toBe(false); }
    expect(state.commits).toBe(current); expect(host.openRepository).toHaveBeenCalledOnce(); expect(host.snapshot).toHaveBeenCalledOnce();
    host.files.set(A, [changedFile()]); await state.refresh(); await settle(); paint();
    expect(state.localOpen).toBe(false); // A real snapshot must not override the earlier explicit close.
    row.fire('click'); await settle(); paint(); expect(state.localOpen).toBe(true);
    const calls = [host.openRepository.mock.calls.length, host.snapshot.mock.calls.length, host.history.mock.calls.length];
    required(row, '[data-action="repository-more"]').fire('click'); await settle();
    expect(dom.querySelector('[role="menu"]')).not.toBeNull(); expect(state.localOpen).toBe(true); closeMenu();
    const selected = state.selected;
    state.selectCommit('WORKTREE', false);
    expect(state.localOpen).toBe(true); expect(state.selected).toBe(selected); expect(state.detailsOpen).toBe(false);
    expect([host.openRepository.mock.calls.length, host.snapshot.mock.calls.length, host.history.mock.calls.length]).toEqual(calls);
    // A nested icon click must bubble to exactly one row action, never to the row's toggle handler.
    const action = vi.spyOn(state, 'repositoryRowAction');
    required(required(row, '[data-action="repository-commit"]'), 'svg').fire('click'); await settle();
    expect(action).toHaveBeenCalledTimes(1); expect(action.mock.calls[0][2]).toBe('commit'); expect(state.localOpen).toBe(true);
    expect(host.openRepository).toHaveBeenCalledOnce(); expect(host.commitDetail).not.toHaveBeenCalled();
  });

  it('moves the one local composer/list between sidebar and middle without losing drafts, focus, or per-repository decisions', async () => {
    const host = new FakeHost(); host.files.set(A, [changedFile('a-local.ts')]); host.files.set(B, [changedFile('b-local.ts')]);
    const { state, candidates, root } = await openMulti(host); await state.activateCandidate(candidates[0]); await settle(); paint();
    const message = required(root, '[data-action="local-commit-message"]'), list = node(state.localChanges.listElement);
    message.value = 'Draft A / 保存'; message.setSelectionRange(2, 7, 'forward'); message.scrollTop = 9; message.fire('input'); message.focus();
    const beforeIO = [host.openRepository.mock.calls.length, host.history.mock.calls.length, host.snapshot.mock.calls.length, host.diff.mock.calls.length];
    state.updateSettings({ localChangesPosition: 'inline' }); paint();
    expect(list.closest('.repository-tree')).not.toBeNull(); expect(dom.activeElement).toBe(message); expect(message.value).toBe('Draft A / 保存');
    state.toggleSidebar(false); paint();
    expect(list.closest('.repository-tree')).toBeNull(); expect(list.parentElement).toBe(node(state.localChanges.element)); expect(dom.activeElement).toBe(message);
    state.toggleSidebar(true); paint();
    expect(list.closest('.repository-tree')).not.toBeNull(); expect(required(root, '[data-action="local-commit-message"]')).toBe(message);
    expect([message.selectionStart, message.selectionEnd, message.selectionDirection, message.scrollTop]).toEqual([2, 7, 'forward', 9]);
    expect([host.openRepository.mock.calls.length, host.history.mock.calls.length, host.snapshot.mock.calls.length, host.diff.mock.calls.length]).toEqual(beforeIO);
    required(root, '[data-repository-key="a"]').fire('click'); expect(state.localOpen).toBe(false);
    await state.activateCandidate(candidates[1]); await settle(); paint();
    expect(state.localOpen).toBe(true); expect(message.value).toBe('');
    message.value = 'Draft B'; message.setSelectionRange(1, 5, 'backward'); message.fire('input');
    await state.activateCandidate(candidates[0]); await settle(); paint();
    expect(state.localOpen).toBe(false); expect(message.value).toBe('Draft A / 保存'); expect([message.selectionStart, message.selectionEnd, message.selectionDirection, message.scrollTop]).toEqual([2, 7, 'forward', 9]);
    required(root, '[data-repository-key="a"]').fire('click'); expect(state.localOpen).toBe(true);
    await state.activateCandidate(candidates[1]); await settle(); paint();
    expect(message.value).toBe('Draft B'); expect([message.selectionStart, message.selectionEnd, message.selectionDirection]).toEqual([1, 5, 'backward']);
    expect(host.workingAction).not.toHaveBeenCalled(); expect(host.action).not.toHaveBeenCalled();
  });

  it('rejects a late local preview from A after B activates without dropping A draft', async () => {
    const host = new FakeHost(); host.files.set(A, [changedFile('a-local.ts')]); host.files.set(B, [changedFile('b-local.ts')]);
    const old = deferred<DiffResult>(); host.diff.mockImplementationOnce(() => old.promise).mockResolvedValue({ patch: '@@ -1 +1 @@\n-before\n+current-b\n', binary: false, truncated: false, oldContent: 'before', newContent: 'current-b' });
    const { state, candidates, root } = await openMulti(host); await state.activateCandidate(candidates[0]);
    const oldQuery = host.diff.mock.calls[0][0];
    const message = required(root, '[data-action="local-commit-message"]'); message.value = 'Pending draft A'; message.fire('input');
    await state.activateCandidate(candidates[1]); await settle(); paint();
    expect(host.cancel).toHaveBeenCalledWith(oldQuery.requestId); expect(state.localChanges.element.dataset.repo).toBe(host.repository(B).id);
    old.resolve({ patch: '@@ -1 +1 @@\n-before\n+late-a-only\n', binary: false, truncated: false, oldContent: 'before', newContent: 'late-a-only' }); await settle(); paint();
    const preview = node(state.localChanges.previewElement);
    expect(preview.textContent).toContain('b-local.ts'); expect(preview.textContent).toContain('current-b'); expect(preview.textContent).not.toContain('late-a-only'); expect(message.value).toBe('');
    await state.activateCandidate(candidates[0]); await settle(); paint();
    expect(message.value).toBe('Pending draft A'); expect(host.diff.mock.calls.at(-1)![0].repoId).toBe(host.repository(A).id);
  });

  it('keeps the existing local preview and composer usable when another repository fails activation', async () => {
    const host = new FakeHost(); host.repository(A).trusted = true; host.files.set(A, [changedFile('staged-a.ts', true)]);
    const oldPatch = deferred<DiffResult>(), patch = deferred<DiffResult>();
    host.diff.mockImplementationOnce(() => oldPatch.promise).mockImplementationOnce(() => patch.promise);
    const { state, candidates, root } = await openMulti(host); await state.activateCandidate(candidates[0]);
    expect(host.diff).toHaveBeenCalledOnce(); const previousRequest = host.diff.mock.calls[0][0].requestId;
    const preview = node(state.localChanges.previewElement), message = required(root, '[data-action="local-commit-message"]');
    message.value = 'Keep draft and usable composer'; message.setSelectionRange(2, 9, 'forward'); message.fire('input');
    host.openRepository.mockRejectedValueOnce({ code: 'IO', message: 'Fixture candidate unavailable' });
    expect(await state.activateCandidate(candidates[1])).toBe(false); await settle(); paint();
    expect(state.repo?.path).toBe(A); expect(state.localChanges.previewElement).toBe(preview); expect(host.unlistenRepository).not.toHaveBeenCalled();
    expect(host.diff).toHaveBeenCalledTimes(2); expect(host.cancel).toHaveBeenCalledWith(previousRequest);
    expect(host.diff.mock.calls[1][0]).toMatchObject({ repoId: host.repository(A).id, path: 'staged-a.ts' }); expect(host.diff.mock.calls[1][0].requestId).not.toBe(previousRequest);
    oldPatch.resolve({ patch: '@@ -1 +1 @@\n-before\n+stale-owner-only\n', binary: false, truncated: false, oldContent: 'before', newContent: 'stale-owner-only' }); await settle(); paint();
    expect(preview.textContent).not.toContain('stale-owner-only'); expect(preview.querySelector('.loading-state')).not.toBeNull();
    patch.resolve({ patch: '@@ -1 +1 @@\n-before\n+kept-a-preview\n', binary: false, truncated: false, oldContent: 'before', newContent: 'kept-a-preview' }); await settle(); paint();
    expect(preview.textContent).toContain('kept-a-preview'); expect(preview.querySelector('.loading-state')).toBeNull();
    expect(message.value).toBe('Keep draft and usable composer'); expect([message.selectionStart, message.selectionEnd, message.selectionDirection]).toEqual([2, 9, 'forward']);
    const index = deferred<string | null>(); host.workingIndex.mockImplementationOnce(() => index.promise);
    const control = required(root, '[data-action="commit-staged"]'); expect(control.disabled).toBe(false); control.fire('click'); await settle();
    expect(host.workingIndex).toHaveBeenCalledOnce(); index.resolve(null); await settle();
    expect(host.workingAction).not.toHaveBeenCalled(); expect(host.action).not.toHaveBeenCalled();
  });

  it('does not execute a staged commit from an earlier A generation after A-B-A while its index request is pending', async () => {
    const host = new FakeHost(); host.repository(A).trusted = true; host.files.set(A, [changedFile('staged.ts', true)]);
    const index = deferred<string | null>(); host.workingIndex.mockImplementationOnce(() => index.promise);
    const { state, candidates, root } = await openMulti(host); await state.activateCandidate(candidates[0]); await settle(); paint();
    const generation = state.openGeneration, message = required(root, '[data-action="local-commit-message"]');
    message.value = 'Do not send stale commit'; message.fire('input');
    required(root, '[data-action="commit-staged"]').fire('click'); await settle();
    expect(host.workingIndex).toHaveBeenCalledOnce(); const indexRequest = host.workingIndex.mock.calls[0][1];
    await state.activateCandidate(candidates[1]); await state.activateCandidate(candidates[0]); await settle(); paint();
    expect(state.openGeneration).toBeGreaterThan(generation); expect(host.cancel).toHaveBeenCalledWith(indexRequest);
    index.resolve('old-index'); await settle(); paint();
    expect(host.workingAction).not.toHaveBeenCalled(); expect(host.action).not.toHaveBeenCalled();
    expect(state.repo?.path).toBe(A); expect(message.value).toBe('Do not send stale commit'); expect(required(root, '[data-action="commit-staged"]').disabled).toBe(false);
  });

  it('restores the graph on both axes after a hidden document and honors newer user scroll instead of deferred restoration', async () => {
    const { state, host, candidates } = await openMulti(); await state.activateCandidate(candidates[0]);
    state.selectCommit(host.repository(A).head!, false); await settle(); paint();
    state.table.scrollTop = 93; state.table.scrollLeft = 47;
    const detail = structuredClone(state.details.view);
    required(node(state.details.element), '[data-path="a.ts"]').fire('click'); await settle(); paint();
    expect(state.graphSurface.hidden).toBe(true); const id = state.historyDocuments.activeId!;
    state.table.scrollTop = 0; state.table.scrollLeft = 0; state.saveView();
    expect(state.store.state.views[host.repository(A).id]).toMatchObject({ scrollTop: 93, scrollLeft: 47 });
    state.historyDocuments.activateGraph(); expect([state.table.scrollTop, state.table.scrollLeft]).toEqual([93, 47]);
    paint(); paint(); expect([state.table.scrollTop, state.table.scrollLeft]).toEqual([93, 47]);
    expect(state.details.view).toMatchObject({ ...detail, path: 'a.ts' });
    await state.historyDocuments.activate(id); await settle(); paint();
    state.historyDocuments.activateGraph();
    // The first scroll event acknowledges the programmatic restoration, the second is a newer real user movement.
    node(state.table.viewport).fire('scroll'); node(state.table.viewport).scrollTop = 121; node(state.table.viewport).scrollLeft = 66; node(state.table.viewport).fire('scroll');
    paint(); paint(); state.saveView();
    expect([state.table.scrollTop, state.table.scrollLeft]).toEqual([121, 66]);
    expect(state.store.state.views[host.repository(A).id]).toMatchObject({ scrollTop: 121, scrollLeft: 66 });
    expect(host.openRepository).toHaveBeenCalledOnce(); expect(host.history).toHaveBeenCalledOnce(); expect(host.commitDetail).toHaveBeenCalledOnce(); expect(host.diff).toHaveBeenCalledOnce();
  });

  it('keeps row-click toggle separate from keyboard ensure-open and does not load first diffs while traversing history', async () => {
    const host = new FakeHost(), base = host.repository(A), commits = [fixtureCommit(base), { ...fixtureCommit(base), oid: oid('d'), subject: 'Second commit' }, { ...fixtureCommit(base), oid: oid('e'), subject: 'Third commit' }];
    host.history.mockResolvedValue({ commits, hasMore: false });
    const { state, candidates } = await openMulti(host); await state.activateCandidate(candidates[0]); paint();
    // Commit rows expose stable ids rather than relying on a fixture-only callback path.
    const row = dom.getElementById(`commit-${base.head}`)!;
    expect(row).not.toBeNull(); row.fire('click'); await settle(); paint(); expect(state.detailsOpen).toBe(true);
    row.fire('click'); await settle(); paint(); expect(state.detailsOpen).toBe(false); expect(state.selected).toBe(base.head);
    node(state.table.element).fire('keydown', { key: 'Enter' }); await settle(); paint(); expect(state.detailsOpen).toBe(true);
    node(state.table.element).fire('keydown', { key: 'Enter' }); await settle(); paint(); expect(state.detailsOpen).toBe(true);
    node(state.table.element).fire('keydown', { key: 'ArrowDown' }); await settle(); paint(); expect(state.selected).toBe(oid('d'));
    node(state.table.element).fire('keydown', { key: 'ArrowDown' }); await settle(); paint(); expect(state.selected).toBe(oid('e'));
    expect(host.openRepository).toHaveBeenCalledOnce(); expect(host.snapshot).toHaveBeenCalledOnce(); expect(host.history).toHaveBeenCalledOnce(); expect(host.diff).not.toHaveBeenCalled();
    expect(state.historyDocuments.size).toBe(0); expect(state.details.view?.path).toBeUndefined();
  });

  it('bounds visible-row summary probes without activating every discovered repository, and rejects their late results after close', async () => {
    const host = new FakeHost(), candidates = Array.from({ length: 12 }, (_, index) => candidate(`${ROOT}/repo-${index}`));
    const probes: { candidate: RepositoryCandidate; gate: ReturnType<typeof deferred<RepositorySummary>>; requestId: string }[] = [];
    const probeRepository = vi.fn((candidate: RepositoryCandidate, _root: string, requestId: string) => {
      const gate = deferred<RepositorySummary>(); probes.push({ candidate, gate, requestId }); return gate.promise;
    });
    Object.assign(host, { probeRepository }); host.discoverRepositories.mockResolvedValueOnce(discovery(ROOT, candidates));
    const { state, root } = await makeApp(host); await state.openDirectory(ROOT); paint(); await settle();
    expectNoGit(host); expect(probeRepository).toHaveBeenCalledTimes(2);
    expect(probeRepository.mock.calls.every(([, root, id]) => root === ROOT && id.startsWith('repository-summary:'))).toBe(true);
    required(root, '[data-repository-key="repo-11"]').fire('click'); await settle(); paint();
    expect(host.openRepository).toHaveBeenCalledExactlyOnceWith(candidates[11].path, expect.any(String), ROOT);
    expect(host.snapshot).toHaveBeenCalledOnce(); expect(host.history).toHaveBeenCalledOnce(); expect(probeRepository).toHaveBeenCalledTimes(2);
    state.closeDirectory(); await settle();
    for (const { candidate, gate, requestId } of probes) {
      expect(host.cancel).toHaveBeenCalledWith(requestId);
      gate.resolve({ path: candidate.path, branch: 'late probe branch', head: oid('a'), trusted: false, bare: false,
        changes: null, staged: null, unstaged: null, untracked: null, ahead: null, behind: null, upstream: null });
    }
    await settle(); paint();
    expect(state.repo).toBeNull(); expect(state.directoryDiscovery).toBeNull(); expect(root.textContent).not.toContain('late probe branch');
    expect(host.openRepository).toHaveBeenCalledOnce(); expect(probeRepository).toHaveBeenCalledTimes(2);
  });
});

describe('App rapid repository switching inside a directory', () => {
  it('publishes only the latest activation when A/B/latest requests finish in reverse order', async () => {
    const { state, host, candidates, root } = await openMulti(), oldA = deferred<Repository>(), oldB = deferred<Repository>(), latestA = deferred<Repository>();
    host.openRepository.mockImplementationOnce(() => oldA.promise).mockImplementationOnce(() => oldB.promise).mockImplementationOnce(() => latestA.promise);
    const first = state.activateCandidate(candidates[0]), second = state.activateCandidate(candidates[1]), latest = state.activateCandidate(candidates[0]);
    const ids = host.openRepository.mock.calls.map(call => call[1]);
    expect(new Set(ids).size).toBe(3); expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(host.cancel).toHaveBeenCalledWith(ids[0]); expect(host.cancel).toHaveBeenCalledWith(ids[1]);
    latestA.resolve(host.repository(A)); await latest; paint(); const currentCommits = state.commits;
    oldB.resolve(host.repository(B)); oldA.resolve({ ...host.repository(A), name: 'stale A' }); await Promise.all([first, second]); paint();
    expect(state.repo?.path).toBe(A); expect(state.repo?.name).toBe('a'); expect(state.commits).toBe(currentCommits);
    expect(root.dataset.repoPath).toBe(A); expect(state.store.state.lastRepo).toBe(A); expect(state.store.state.recent.map(item => item.path)).toEqual([A]);
    expect(host.snapshot).toHaveBeenCalledOnce(); expect(host.history).toHaveBeenCalledOnce();
    expect(state.store.state.directoryScope?.root).toBe(ROOT); expect(state.loadingRepo).toBe(false);
  });

  it('rejects late cancelled history and metadata from A after B has become active', async () => {
    const { state, host, candidates, root } = await openMulti(), oldSnapshot = deferred<RepositorySnapshot>(), oldHistory = deferred<HistoryPage>();
    host.snapshot.mockImplementationOnce(() => oldSnapshot.promise); host.history.mockImplementationOnce(() => oldHistory.promise);
    const openingA = state.activateCandidate(candidates[0]); await settle();
    const snapshotId = host.snapshot.mock.calls[0][1], historyId = host.history.mock.calls[0][0].requestId;
    await state.activateCandidate(candidates[1]); paint();
    expect(host.cancel).toHaveBeenCalledWith(snapshotId); expect(host.cancel).toHaveBeenCalledWith(historyId);
    const oldRepo = host.repository(A);
    oldSnapshot.resolve({ repository: { ...oldRepo, name: 'stale metadata A' }, working: { files: [], head: oldRepo.head, branch: 'stale-branch', ahead: 99, behind: 0, conflicts: 0, operation: null }, refs: [], stashes: [], remotes: [], fingerprint: 'stale' });
    oldHistory.resolve({ commits: [{ ...fixtureCommit(oldRepo), subject: 'stale history A' }], hasMore: true }); await openingA; paint();
    expect(state.repo?.path).toBe(B); expect(state.repo?.branch).toBe('main'); expect(state.commits.map(commit => commit.subject)).toEqual(['Commit b']);
    expect(root.textContent).not.toContain('stale metadata A'); expect(root.textContent).not.toContain('stale history A'); expect(state.store.state.lastRepo).toBe(B);
  });

  it('restores A-B-A query, selection, scroll and real detail/file view without leaking them into B', async () => {
    const { state, host, candidates } = await openMulti(); await state.activateCandidate(candidates[0]);
    state.setScope({ kind: 'head' }); await settle();
    state.searchScope.value = 'search'; node(state.searchScope).fire('change'); await settle();
    state.searchType.value = 'author'; node(state.searchType).fire('change'); await settle();
    state.orderSelect.value = 'author-date'; node(state.orderSelect).fire('change'); await settle();
    state.searchInput.value = 'Author a'; node(state.searchInput).fire('input'); node(state.searchInput).fire('keydown', { key: 'Enter' }); await settle();
    state.selectCommit(host.repository(A).head!, false); await settle(); paint();
    const detail = node(state.details.element);
    expect(host.diff).not.toHaveBeenCalled(); expect(detail.querySelector('.diff-scroll')).toBeNull();
    required(detail, '[data-action="toggle-full-message"]').fire('click');
    required(detail, '[data-path="a.ts"]').fire('click'); await settle(); paint();
    expect(host.diff).toHaveBeenCalledOnce(); expect(state.historyDocuments.currentPath).toBe('a.ts');
    required(node(state.historyDocuments.surface), '.diff-scroll').scrollTop = 41;
    state.historyDocuments.activateGraph(); paint(); paint();
    required(detail, '.file-list').scrollTop = 24; required(detail, '.file-list').scrollLeft = 18;
    state.table.scrollTop = 84; state.table.scrollLeft = 13; state.saveView();
    const aView = structuredClone(state.store.state.views[host.repository(A).id]), aDetail = state.details.view;
    expect(aDetail).toMatchObject({ selection: { kind: 'commit', oid: host.repository(A).head }, path: 'a.ts', scrollTop: 0, filesScrollTop: 24, filesScrollLeft: 18, fullMessage: true });
    expect(aDetail).not.toHaveProperty('diff');
    expect(aView).toMatchObject({ scrollTop: 84, scrollLeft: 13, detail: { path: 'a.ts', filesScrollTop: 24, filesScrollLeft: 18, fullMessage: true, inlineSide: 'below' } });

    await state.activateCandidate(candidates[1]); await settle(); paint();
    expect([state.search, state.searchMode, state.queryMode, state.order, state.selected, state.table.scrollTop]).toEqual(['', 'all', 'filter', 'date', null, 0]);
    expect(state.detailsOpen).toBe(false); expect(state.details.view).toBeNull(); expect(state.historyDocuments.size).toBe(0);
    expect(state.scope).toEqual({ kind: 'all' }); expect(state.store.state.views[host.repository(A).id]).toEqual(aView);
    state.searchInput.value = 'Commit b'; node(state.searchInput).fire('input');
    state.selectCommit(host.repository(B).head!, false); await settle(); paint(); state.table.scrollTop = 28; state.saveView();
    const bView = structuredClone(state.store.state.views[host.repository(B).id]);

    await state.activateCandidate(candidates[0]); await settle(); paint();
    expect([state.search, state.searchMode, state.queryMode, state.order, state.selected, state.table.scrollTop]).toEqual(['Author a', 'author', 'search', 'author-date', host.repository(A).head, 84]);
    expect(state.searchInput.value).toBe('Author a'); expect(state.detailsOpen).toBe(true); expect(state.details.view).toEqual(aDetail);
    expect(state.table.scrollLeft).toBe(13); expect(state.historyDocuments.size).toBe(0); expect(host.diff).toHaveBeenCalledOnce();
    expect(state.store.state.views[host.repository(B).id]).toEqual(bView);
    expect(host.history.mock.calls.at(-1)![0]).toMatchObject({ repoId: host.repository(A).id, search: 'Author a', searchMode: 'author', order: 'author-date' });
    expect(host.commitDetail.mock.calls.at(-1)![0]).toBe(host.repository(A).id); expect(state.store.state.directoryScope?.root).toBe(ROOT);
  });

  it('preserves the previous usable repository and directory scope when a direct candidate open fails', async () => {
    const { state, host, candidates, root } = await openMulti(); await state.activateCandidate(candidates[0]); paint();
    const previousScope = structuredClone(state.store.state.directoryScope), previousRecent = structuredClone(state.store.state.recent), commits = state.commits;
    const gate = deferred<Repository>(); host.openRepository.mockImplementationOnce(() => gate.promise);
    const opening = state.openRepository(C); expect(state.store.state.directoryScope).toEqual(previousScope);
    gate.reject({ code: 'IO', message: 'Fixture candidate unavailable' }); await opening; paint();
    expect(state.repo?.path).toBe(A); expect(host.nativeActive?.path).toBe(A); expect(state.commits).toBe(commits); expect(root.dataset.repoPath).toBe(A);
    expect(state.store.state.directoryScope).toEqual(previousScope); expect(state.store.state.lastRepo).toBe(A); expect(state.store.state.recent).toEqual(previousRecent);
    expect(host.deactivateRepository).not.toHaveBeenCalled(); expect(host.snapshot).toHaveBeenCalledOnce(); expect(host.history).toHaveBeenCalledOnce();
    expect(state.loadingRepo).toBe(false); expect(state.historyOverlay.hidden).toBe(true); expect(node(state.errorbar).textContent).toContain('Fixture candidate unavailable');
  });

  it('preserves the open detail, file filter and saved restoration view when a new candidate fails to open', async () => {
    const { state, host, candidates } = await openMulti(); await state.activateCandidate(candidates[0]);
    state.setScope({ kind: 'head' }); await settle();
    state.searchInput.value = 'Commit a'; node(state.searchInput).fire('input');
    state.selectCommit(host.repository(A).head!, false); await settle(); paint();
    const details = node(state.details.element), filter = required(details, '.file-filter');
    filter.value = 'a.ts'; filter.fire('input');
    required(details, '[data-action="toggle-full-message"]').fire('click');
    required(details, '.file-list').scrollTop = 24; required(details, '.file-list').scrollLeft = 18;
    state.table.scrollTop = 84; state.table.scrollLeft = 13;
    expect(host.diff).not.toHaveBeenCalled();
    required(details, '[data-path="a.ts"]').fire('click'); await settle(); paint();
    const document = state.historyDocuments.activeId, preview = required(node(state.historyDocuments.surface), '.diff-scroll');
    preview.scrollTop = 41; preview.scrollLeft = 17; state.saveView();
    const previousDetail = structuredClone(state.details.view), previousView = structuredClone(state.store.state.views[host.repository(A).id]);
    expect(previousDetail).toMatchObject({ selection: { kind: 'commit', oid: host.repository(A).head }, path: 'a.ts', fileFilter: 'a.ts', scrollTop: 0, filesScrollTop: 24, filesScrollLeft: 18, fullMessage: true });
    expect(previousDetail).not.toHaveProperty('diff'); expect(preview.scrollTop).toBe(41); expect(host.diff).toHaveBeenCalledOnce();
    expect(previousView.filter?.fileFilter).toBe('a.ts'); expect(previousView).toMatchObject({ scrollTop: 84, scrollLeft: 13 });

    const gate = deferred<Repository>(); host.openRepository.mockImplementationOnce(() => gate.promise);
    const opening = state.activateCandidate(candidates[1]);
    gate.reject({ code: 'IO', message: 'Fixture candidate unavailable' }); await opening; await settle(); paint();
    expect(state.repo?.path).toBe(A); expect(host.nativeActive?.path).toBe(A);
    expect({ detailsOpen: state.detailsOpen, detail: state.details.view, savedView: state.store.state.views[host.repository(A).id] })
      .toEqual({ detailsOpen: true, detail: previousDetail, savedView: previousView });
    expect(required(node(state.details.element), '.file-filter').value).toBe('a.ts');
    expect(state.historyDocuments.activeId).toBe(document); expect(state.graphSurface.hidden).toBe(true);
    expect(required(node(state.historyDocuments.surface), '.diff-scroll')).toBe(preview); expect([preview.scrollTop, preview.scrollLeft]).toEqual([41, 17]);
    expect([state.scope, state.search, state.selected, state.table.scrollTop, state.table.scrollLeft]).toEqual([{ kind: 'head' }, 'Commit a', host.repository(A).head, 84, 13]);
    expect(host.unlistenRepository).not.toHaveBeenCalled();
    const watcher = host.onRepositoryChanged.mock.calls[0][0], snapshots = host.snapshot.mock.calls.length, pages = host.history.mock.calls.length;
    watcher(host.repository(B).id); await vi.advanceTimersByTimeAsync(600); expect(host.snapshot).toHaveBeenCalledTimes(snapshots);
    watcher(host.repository(A).id); await vi.advanceTimersByTimeAsync(600); await state.refreshQueue.idle();
    expect(host.snapshot).toHaveBeenCalledTimes(snapshots + 1); expect(host.history).toHaveBeenCalledTimes(pages + 1);
    expect(state.repo?.path).toBe(A); expect(state.historyDocuments.activeId).toBe(document); expect(state.details.view).toEqual(previousDetail);
  });

  it('awaits native deactivation before a subsequent open and transmits scope, cancellation and unique request IDs through DesktopHost', async () => {
    const fake = new FakeHost(), host = new DesktopHost(), deactivated = deferred<void>(), candidates = [candidate(A), candidate(B)];
    const deactivationStarted = deferred<void>(), cancellationReceived = deferred<void>();
    const value = discovery(ROOT, candidates), calls: { name: string; args?: Record<string, unknown> }[] = [];
    nativeInvoke.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args });
      switch (name) {
        case 'load_state': return structuredClone(fake.state);
        case 'diagnostics': return fake.diagnostics();
        case 'discover_repositories': return value;
        case 'open_repository': return fake.openRepository(String(args!.path), String(args!.requestId), args!.scopeRoot as string | undefined);
        case 'deactivate_repository': deactivationStarted.resolve(); await deactivated.promise; return fake.deactivateRepository();
        case 'get_snapshot': return fake.snapshot(String(args!.repoId), String(args!.requestId));
        case 'get_history': return fake.history(args!.query as unknown as HistoryQuery);
        case 'cancel_request': cancellationReceived.resolve(); return;
        case 'save_state': return;
        default: throw new Error(`Unexpected native fixture command ${name}`);
      }
    });
    // Event subscriptions are inert fixtures; every command above still uses the actual DesktopHost IPC wrapper.
    vi.spyOn(host, 'onRepositoryChanged').mockResolvedValue(() => {}); vi.spyOn(host, 'onExternalSession').mockResolvedValue(() => {});
    const { app, state } = constructApp(host); await app.init(); await state.openDirectory(ROOT); await state.activateCandidate(candidates[0]);
    const scan = calls.find(call => call.name === 'discover_repositories')!, firstOpen = calls.find(call => call.name === 'open_repository')!;
    expect(scan.args).toMatchObject({ path: ROOT, depth: 2, requestId: expect.any(String) });
    expect(firstOpen.args).toMatchObject({ path: A, scopeRoot: ROOT, requestId: expect.any(String) });
    const metadata = calls.find(call => call.name === 'get_snapshot')!, page = calls.find(call => call.name === 'get_history')!;
    const ids = [scan.args!.requestId, firstOpen.args!.requestId, metadata.args!.requestId, (page.args!.query as HistoryQuery).requestId];
    expect(ids.every(id => typeof id === 'string' && id.length > 0)).toBe(true); expect(new Set(ids).size).toBe(4);

    state.closeRepository(); const superseded = state.activateCandidate(candidates[0]), next = state.activateCandidate(candidates[1]);
    // Observe actual lazy IPC dispatch; fixed microtask drains cannot guarantee when dynamic imports settle under suite load.
    await Promise.all([deactivationStarted.promise, cancellationReceived.promise]);
    expect(calls.filter(call => call.name === 'deactivate_repository')).toHaveLength(1);
    expect(calls.filter(call => call.name === 'open_repository')).toHaveLength(1); // not even sent while deactivation is pending
    expect(calls.some(call => call.name === 'cancel_request' && typeof call.args?.requestId === 'string')).toBe(true);
    deactivated.resolve(); await Promise.all([superseded, next]);
    expect(calls.filter(call => call.name === 'open_repository').map(call => call.args!.path)).toEqual([A, B]);
    expect(calls.at(-1)?.name).not.toBe('deactivate_repository'); expect(state.repo?.path).toBe(B); expect(fake.nativeActive?.path).toBe(B);
    expect(calls.filter(call => call.name === 'open_repository').at(-1)!.args).toMatchObject({ path: B, scopeRoot: ROOT, requestId: expect.any(String) });
  });
});

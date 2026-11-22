import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit, Host, Repository, RepositorySnapshot, WorkingState } from '../src/shared/protocol';
import { defaultState } from '../src/shared/protocol';
import { App } from '../src/ui/app';
import { CommitTable, type TableModel } from '../src/ui/table';
import { HistoryLayoutCache, RefreshFlags } from '../src/lib/performance-models';

/** Small DOM test double: exercises the real app/table code, without a browser or DOM dependency. */
class TestNode {
  parentElement: TestNode | null = null;
  children: TestNode[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  events = new Map<string, ((event: TestEvent) => void)[]>();
  className = '';
  tagName: string;
  id = '';
  hidden = false;
  disabled = false;
  title = '';
  value = '';
  type = '';
  tabIndex = 0;
  text = '';
  scrollTop = 0;
  scrollLeft = 0;
  clientHeight = 560;
  clientWidth = 900;
  offsetHeight = 100;
  replacements = 0;
  style = { setProperty: vi.fn(), getPropertyValue: () => '', top: '', height: '', minWidth: '', transform: '', colorScheme: '' };
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (...names: string[]) => { names.forEach(name => { this.classList.toggle(name, true); }); },
    remove: (...names: string[]) => { names.forEach(name => { this.classList.toggle(name, false); }); },
    toggle: (name: string, force?: boolean) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean)), enabled = force ?? !names.has(name);
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' '); return enabled;
    },
  };
  constructor(tagName = 'div', text = '') { this.tagName = tagName.toUpperCase(); this.text = text; }
  get firstElementChild(): TestNode | null { return this.children[0] ?? null; }
  get nextElementSibling(): TestNode | null {
    if (!this.parentElement) return null;
    return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] ?? null;
  }
  get isConnected(): boolean { return this === dom.body || Boolean(this.parentElement?.isConnected); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  append(...children: (TestNode | string)[]): void { children.forEach(child => this.appendChild(typeof child === 'string' ? new TestNode('#text', child) : child)); }
  appendChild(child: TestNode): TestNode { return this.insertBefore(child, null); }
  insertBefore(child: TestNode, before: TestNode | null): TestNode {
    child.remove(); const at = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(at < 0 ? this.children.length : at, 0, child); child.parentElement = this; return child;
  }
  replaceChildren(...children: TestNode[]): void {
    this.replacements++; this.children.forEach(child => { child.parentElement = null; }); this.children = []; this.text = ''; this.append(...children);
  }
  replaceWith(next: TestNode): void { const parent = this.parentElement; if (parent) { parent.insertBefore(next, this); this.remove(); } }
  remove(): void {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  contains(node: TestNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, [...(this.events.get(name) ?? []), listener]); }
  removeEventListener(name: string, listener: (event: TestEvent) => void): void { this.events.set(name, (this.events.get(name) ?? []).filter(value => value !== listener)); }
  emit(name: string, extra: Partial<TestEvent> = {}): void {
    const event = { target: this, key: '', preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra };
    this.events.get(name)?.forEach(listener => listener(event));
  }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('[data-')) return Object.hasOwn(this.dataset, selector.slice(6, -1).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll<T extends TestNode = TestNode>(selector: string): T[] {
    const found: T[] = [];
    for (const child of this.children) { if (selector.split(',').some(item => child.matches(item))) found.push(child as T); found.push(...child.querySelectorAll<T>(selector)); }
    return found;
  }
  querySelector<T extends TestNode = TestNode>(selector: string): T | null { return this.querySelectorAll<T>(selector)[0] ?? null; }
  closest(selector: string): TestNode | null { return selector.split(',').some(item => this.matches(item)) ? this : this.parentElement?.closest(selector) ?? null; }
  focus(): void { dom.activeElement = this; }
  select(): void {}
  getBoundingClientRect() { return { top: 0, left: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight }; }
  getContext(): null { return null; }
}
interface TestEvent { target: TestNode; key: string; preventDefault: () => void; stopPropagation: () => void }
const dom = {
  body: new TestNode('body'), documentElement: new TestNode('html'), activeElement: null as TestNode | null, hidden: false,
  createElement: (tag: string) => new TestNode(tag), createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
  createTextNode: (text: string) => new TestNode('#text', text), createDocumentFragment: () => new TestNode('#fragment'),
  getElementById: (id: string): TestNode | null => {
    const find = (node: TestNode): TestNode | null => node.id === id ? node : node.children.map(find).find(Boolean) ?? null;
    return find(dom.body);
  },
  querySelector: (selector: string) => dom.body.querySelector(selector),
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
};
let frames: Map<number, FrameRequestCallback>, nextFrame = 0;
function paint(): void {
  const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(0));
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function microtasks(): Promise<void> { for (let count = 0; count < 10; count++) await Promise.resolve(); }
const commit = (oid: string, parents: string[] = []): Commit => ({ oid, parents, author: 'Author', email: 'a@example.test', subject: oid, authoredAt: 1, committedAt: 2, refs: [] });
const repo: Repository = { id: 'repo', path: 'D:/fixture', name: 'fixture', gitDir: '.git', commonDir: '.git', head: 'a', branch: 'main', trusted: false, bare: false };
const working = (): WorkingState => ({ files: [], branch: 'main', ahead: 0, behind: 0, operation: null, conflicts: 0, head: 'a' });
const snapshot = (head = 'a'): RepositorySnapshot => ({ repository: { ...repo, head }, working: { ...working(), head }, refs: [], stashes: [], remotes: [], fingerprint: 'same-status-fingerprint' });
const liveApps: App[] = [], liveTables: CommitTable[] = [];
function appHost(overrides: Partial<Host> = {}): Host {
  return {
    cancel: vi.fn(async () => undefined), saveState: vi.fn(async () => undefined),
    openRepository: vi.fn(async () => ({ ...repo })), history: vi.fn(async () => ({ commits: [commit('a', ['b']), commit('b')], hasMore: false })),
    snapshot: vi.fn(async () => snapshot()), ...overrides,
  } as Host;
}
type AppInternals = {
  initialized: boolean; repo: Repository | null; commits: Commit[]; selected: string | null; hasMore: boolean;
  actionBusy: boolean; detailsOpen: boolean; details: { show: ReturnType<typeof vi.fn>; refresh: ReturnType<typeof vi.fn>; invalidate: ReturnType<typeof vi.fn>; view: null; element: TestNode; clear: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; updateSettings: ReturnType<typeof vi.fn> };
  graph: HistoryLayoutCache; table: CommitTable; workingDirtyEpoch: number; autoLoadBlocked: boolean;
  intentEpoch: number; historyGeneration: number; openGeneration: number; loadingHistory: boolean; restoringView: boolean;
  searchInput: TestNode; search: string; queryMode: 'filter' | 'search'; working: WorkingState | null;
  store: { state: ReturnType<typeof defaultState>; queue: () => void }; refreshQueue: { request(mask: number): void; idle(): Promise<void>; resume(): void; pendingMask: number };
  openRepository(path: string): Promise<void>; closeRepository(): void; renderTable(reset?: boolean): void;
  refresh(): Promise<void>; selectCommit(oid: string, compare: boolean): void; cancelLoading(): void;
  loadHistory(reset: boolean): Promise<void>; visibleCommits(): Commit[]; windowFocused(): void;
  queryIntent(): void; userIntent(): void; restoreView(view: unknown, generation: number, intent: number): Promise<void>;
};
function makeApp(host = appHost()) {
  const root = new TestNode(); dom.body.append(root);
  const app = new App(host, root as unknown as HTMLElement), state = app as unknown as AppInternals;
  state.initialized = true; state.store.state.settings.autoLoad = false; state.store.state.settings.autoCenterDetails = false;
  const clear = vi.fn(() => { state.details.view = null; });
  state.details.destroy(); state.details = { show: vi.fn(async () => undefined), refresh: vi.fn(), invalidate: vi.fn(), view: null,
    element: new TestNode('section'), clear, destroy: vi.fn(), updateSettings: vi.fn() };
  liveApps.push(app); return { app, state, host };
}
function model(): TableModel {
  const commits = [commit('a', ['b']), commit('b', ['c']), commit('c')];
  const state = defaultState(); state.settings.autoLoad = false;
  return { commits, graph: new HistoryLayoutCache().prepare({ commits, visible: commits, topologyRevision: 0 }), settings: state.settings,
    working: null, selected: 'a', compareBase: null, head: 'a', hasMore: false, loading: false, totalLoaded: commits.length };
}
beforeEach(() => {
  vi.useFakeTimers(); dom.body = new TestNode('body'); dom.documentElement = new TestNode('html'); dom.activeElement = null; dom.hidden = false;
  frames = new Map(); nextFrame = 0;
  vi.stubGlobal('document', dom); vi.stubGlobal('Node', TestNode); vi.stubGlobal('HTMLElement', TestNode); vi.stubGlobal('Element', TestNode);
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn(), devicePixelRatio: 1, innerWidth: 1200, innerHeight: 900 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});
afterEach(() => {
  liveApps.splice(0).forEach(app => app.dispose()); liveTables.splice(0).forEach(table => table.destroy());
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('frontend progressive history and refresh', () => {
  it('shows history before slow snapshot metadata and restores viewport without waiting for a first diff', async () => {
    const status = deferred<RepositorySnapshot>(), diff = deferred<void>();
    const { state, host } = makeApp(appHost({ snapshot: vi.fn(() => status.promise) }));
    state.store.state.views[repo.id] = { scope: { kind: 'all' }, search: '', searchMode: 'all', queryMode: 'filter', order: 'topo', scrollTop: 28, selected: 'b', detail: { selection: { kind: 'commit', oid: 'b' } } };
    state.details.show.mockImplementation(() => diff.promise);
    let opened = false; const open = state.openRepository(repo.path).then(() => { opened = true; });
    await microtasks(); paint();
    expect(host.snapshot).toHaveBeenCalledTimes(1); expect(host.history).toHaveBeenCalledTimes(1);
    expect(state.commits.map(item => item.oid)).toEqual(['a', 'b']); expect(state.working).toBeNull();
    expect(state.table.scrollTop).toBe(28); expect(state.selected).toBe('b'); expect(state.details.show).toHaveBeenCalledTimes(1);
    expect(opened).toBe(false);
    status.resolve(snapshot()); await open;
    expect(opened).toBe(true); expect(state.working).not.toBeNull();
    diff.resolve(); await microtasks();
  });

  it('keeps authoritative snapshot refs when history arrives later', async () => {
    const page = deferred<{ commits: Commit[]; hasMore: boolean }>();
    const { state } = makeApp(appHost({ history: vi.fn(() => page.promise) }));
    const open = state.openRepository(repo.path); await microtasks();
    const stale = commit('a'); stale.refs = [{ name: 'deleted', fullName: 'refs/heads/deleted', oid: 'a', kind: 'branch', current: false, upstream: null, subject: '' }];
    page.resolve({ commits: [stale], hasMore: false }); await open;
    expect(state.commits[0].refs).toEqual([]);
  });

  it('memoizes visible arrays and graph preparation across repeated selections, busy and size updates', async () => {
    const { state } = makeApp(); await state.openRepository(repo.path);
    const visible = state.visibleCommits(), passes = state.graph.preparePasses;
    for (let count = 0; count < 20; count++) { state.selectCommit(count % 2 ? 'a' : 'b', false); state.renderTable(); }
    state.actionBusy = true; state.renderTable(); state.actionBusy = false;
    expect(state.visibleCommits()).toBe(visible); expect(state.graph.preparePasses).toBe(passes);
  });

  it('retains history, selection and scroll while refreshing and skips unchanged history/cache invalidation', async () => {
    const { state, host } = makeApp(); await state.openRepository(repo.path);
    state.selectCommit('b', false); state.table.scrollTop = 28;
    const before = state.commits; state.details.invalidate.mockClear();
    state.refreshQueue.request(RefreshFlags.Working | RefreshFlags.Config); await state.refreshQueue.idle();
    expect(host.history).toHaveBeenCalledTimes(1); expect(state.details.invalidate).not.toHaveBeenCalled();
    expect(state.commits).toBe(before); expect(state.selected).toBe('b'); expect(state.table.scrollTop).toBe(28);
    const status = deferred<RepositorySnapshot>(), page = deferred<{ commits: Commit[]; hasMore: boolean }>();
    vi.mocked(host.snapshot).mockImplementationOnce(() => status.promise); vi.mocked(host.history).mockImplementationOnce(() => page.promise);
    const refresh = state.refresh(); expect(state.commits).toBe(before); expect(state.table.scrollTop).toBe(28);
    status.resolve(snapshot('new')); await microtasks(); expect(state.commits).toBe(before);
    state.selectCommit('a', false); state.table.scrollTop = 56;
    page.resolve({ commits: [commit('new', ['a']), ...before], hasMore: false }); await refresh;
    expect(state.commits[0].oid).toBe('new'); expect(state.selected).toBe('a'); expect(state.table.scrollTop).toBe(56);
  });

  it('publishes explicit refresh history before slow metadata while preserving newer selection and scroll', async () => {
    const { state, host } = makeApp(); await state.openRepository(repo.path);
    state.selectCommit('b', false); state.table.scrollTop = 28;
    const before = state.commits, status = deferred<RepositorySnapshot>(), page = deferred<{ commits: Commit[]; hasMore: boolean }>();
    vi.mocked(host.snapshot).mockImplementationOnce(() => status.promise);
    vi.mocked(host.history).mockImplementationOnce(() => page.promise);
    let finished = false; const refresh = state.refresh().then(() => { finished = true; });
    expect(host.snapshot).toHaveBeenCalledTimes(2); expect(host.history).toHaveBeenCalledTimes(2);
    expect(state.commits).toBe(before); expect(state.selected).toBe('b'); expect(state.table.scrollTop).toBe(28);
    state.selectCommit('a', false); state.table.scrollTop = 56;
    page.resolve({ commits: [commit('new', ['a']), ...before], hasMore: false }); await microtasks(); paint();
    expect(state.commits[0].oid).toBe('new'); expect(finished).toBe(false);
    expect(state.selected).toBe('a'); expect(state.table.scrollTop).toBe(56);
    status.resolve(snapshot('new')); await refresh;
    expect(host.history).toHaveBeenCalledTimes(2); expect(state.selected).toBe('a'); expect(state.table.scrollTop).toBe(56);
  });

  it('rejects cancelled parallel refresh history after a newer query without replaying it after metadata', async () => {
    const { state, host } = makeApp(); await state.openRepository(repo.path);
    const status = deferred<RepositorySnapshot>(), page = deferred<{ commits: Commit[]; hasMore: boolean }>();
    vi.mocked(host.snapshot).mockImplementationOnce(() => status.promise);
    vi.mocked(host.history).mockImplementationOnce(() => page.promise);
    const refresh = state.refresh(); expect(host.history).toHaveBeenCalledTimes(2);
    state.cancelLoading(); expect(state.autoLoadBlocked).toBe(true);
    state.queryIntent(); state.search = 'new query'; await state.loadHistory(true); state.selectCommit('b', false);
    page.resolve({ commits: [commit('stale')], hasMore: false }); status.resolve(snapshot()); await refresh;
    expect(state.commits.some(item => item.oid === 'stale')).toBe(false); expect(state.selected).toBe('b');
    expect(host.history).toHaveBeenCalledTimes(3); expect(state.loadingHistory).toBe(false);
  });

  it('forces explicit history refresh even when HEAD, refs and status fingerprints are unchanged', async () => {
    const { state, host } = makeApp(); await state.openRepository(repo.path);
    vi.mocked(host.history).mockResolvedValueOnce({ commits: [commit('a', ['grafted']), commit('grafted')], hasMore: false });
    await state.refresh();
    expect(host.history).toHaveBeenCalledTimes(2); expect(state.commits.map(item => item.oid)).toEqual(['a', 'grafted']);
  });

  it('refreshes a selected working diff after dirty events even when status fingerprint is identical', async () => {
    const { state } = makeApp(); await state.openRepository(repo.path); state.selectCommit('WORKTREE', false);
    state.details.refresh.mockClear(); await state.refresh(); await state.refresh();
    expect(state.details.refresh).toHaveBeenCalledTimes(2);
  });

  it('queues dirty focus work while hidden or action-blocked, then replays once resumed', async () => {
    const { state, host } = makeApp(); await state.openRepository(repo.path);
    state.actionBusy = true; dom.hidden = true; state.windowFocused(); await vi.advanceTimersByTimeAsync(240);
    expect(host.snapshot).toHaveBeenCalledTimes(1); expect(state.refreshQueue.pendingMask).toBe(RefreshFlags.Working | RefreshFlags.Config);
    state.actionBusy = false; dom.hidden = false; state.refreshQueue.resume(); await state.refreshQueue.idle();
    expect(host.snapshot).toHaveBeenCalledTimes(2); expect(state.refreshQueue.pendingMask).toBe(0);
  });

  it('stops restore paging and automatic load after cancellation until an explicit new query', async () => {
    const pending = deferred<{ commits: Commit[]; hasMore: boolean }>();
    const { state, host } = makeApp(appHost({ history: vi.fn(() => pending.promise) }));
    state.repo = { ...repo }; state.hasMore = true; state.restoringView = true;
    state.store.state.settings.initialLoad = 1;
    const restoring = state.restoreView({ scrollTop: 5000, selected: 'old' }, state.openGeneration, state.intentEpoch);
    await microtasks(); state.cancelLoading(); pending.resolve({ commits: [commit('a')], hasMore: true }); await restoring;
    expect(state.autoLoadBlocked).toBe(true); expect(state.selected).toBeNull();
    await state.loadHistory(false); expect(host.history).toHaveBeenCalledTimes(1);
    state.queryIntent(); await state.loadHistory(true); expect(host.history).toHaveBeenCalledTimes(2);
  });

  it('rejects old query results and clears delayed search work when a repository closes', async () => {
    const old = deferred<{ commits: Commit[]; hasMore: boolean }>();
    const { state, host } = makeApp(); await state.openRepository(repo.path);
    vi.mocked(host.history).mockImplementationOnce(() => old.promise);
    state.queryIntent(); const previous = state.loadHistory(true);
    state.queryIntent(); state.search = 'new'; await state.loadHistory(true);
    old.resolve({ commits: [commit('stale')], hasMore: false }); await previous;
    expect(state.commits.some(item => item.oid === 'stale')).toBe(false);
    state.queryMode = 'search'; state.searchInput.value = 'delayed'; state.searchInput.emit('input');
    const calls = vi.mocked(host.history).mock.calls.length; state.closeRepository(); await vi.advanceTimersByTimeAsync(500);
    expect(host.history).toHaveBeenCalledTimes(calls); expect(state.repo).toBeNull();
  });

  it('does not let a pending restore overwrite a newer selection or scroll intent', async () => {
    const page = deferred<{ commits: Commit[]; hasMore: boolean }>();
    const { state } = makeApp(appHost({ history: vi.fn(() => page.promise) }));
    state.repo = { ...repo }; state.commits = [commit('a')]; state.hasMore = true; state.restoringView = true;
    const restore = state.restoreView({ scrollTop: 5000, selected: 'old' }, state.openGeneration, state.intentEpoch);
    await microtasks(); state.selectCommit('a', false); state.table.scrollTop = 84;
    page.resolve({ commits: [commit('b')], hasMore: false }); await restore;
    expect(state.selected).toBe('a'); expect(state.table.scrollTop).toBe(84); expect(state.restoringView).toBe(false);
  });
});

describe('CommitTable incremental visible rows', () => {
  function makeTable() {
    const table = new CommitTable({ select: vi.fn(), context: vi.fn(), refContext: vi.fn(), loadMore: vi.fn(), widths: vi.fn(), copy: vi.fn() });
    dom.body.append(table.element as unknown as TestNode); liveTables.push(table); return table;
  }
  it('updates only selection classes and ARIA without replacing row/ref DOM or losing focus', () => {
    const table = makeTable(), input = model();
    input.commits[0].refs.push({ name: 'main', fullName: 'refs/heads/main', oid: 'a', kind: 'branch', current: true, upstream: null, subject: '' });
    table.setModel(input); paint();
    const first = dom.getElementById('commit-a')!, second = dom.getElementById('commit-b')!, ref = first.querySelector('[data-ref]')!;
    ref.focus(); table.setModel({ ...input, selected: 'b', compareBase: 'a', loading: true }); paint();
    expect(dom.getElementById('commit-a')).toBe(first); expect(dom.getElementById('commit-b')).toBe(second); expect(dom.activeElement).toBe(ref);
    expect(first.classList.contains('selected')).toBe(false); expect(first.classList.contains('compare-base')).toBe(true);
    expect(second.getAttribute('aria-selected')).toBe('true'); expect((table.element as unknown as TestNode).getAttribute('aria-activedescendant')).toBe('commit-b');
  });
  it('preserves row elements and ref focus across inline movement and resize geometry', () => {
    const table = makeTable(), input = model(), detail = new TestNode('section');
    table.setModel(input); paint(); const before = dom.getElementById('commit-b')!;
    table.setModel({ ...input, inline: { oid: 'a', height: 200, element: detail as unknown as HTMLElement } }); paint();
    expect(dom.getElementById('commit-b')).toBe(before); expect(before.style.top).toBe('228px');
    table.setModel({ ...input, inline: { oid: 'b', height: 360, element: detail as unknown as HTMLElement } }); paint();
    expect(dom.getElementById('commit-b')).toBe(before); expect(before.style.top).toBe('28px');
    expect(dom.getElementById('commit-c')!.style.top).toBe('416px');
  });
  it('reuses unchanged visible rows when a new history page is appended', () => {
    const table = makeTable(), input = model(); table.setModel(input); paint();
    const before = dom.getElementById('commit-a')!;
    table.setModel({ ...input, commits: [...input.commits, commit('d')], totalLoaded: 4 }); paint();
    expect(dom.getElementById('commit-a')).toBe(before); expect(dom.getElementById('commit-d')).not.toBeNull();
  });
});

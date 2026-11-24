import { computed, markRaw, shallowReactive, shallowRef, triggerRef, type ComputedRef, type ShallowRef } from 'vue';
import type {
  AppError, AppSettings, Commit, Diagnostics, DirectoryScopeState, ExternalSession, GitRef, HistoryQuery, HistoryScope,
  Host, PersistedState, Remote, Repository, RepositoryCandidate, RepositoryDiscovery, RepositorySnapshot, SettingsPatch,
  Stash, SubmoduleInfo, ViewState, WorkingState,
} from '../shared/protocol';
import { matchesCommit, type CommitFilter, type SearchMode } from '../lib/format';
import { HistoryLayoutCache, CoalescedRefresh, RefreshFlags } from '../lib/performance-models';
import type { GraphRow } from '../lib/graph';
import { buildRepositoryTree, clampRepositoryDepth, type RepositoryTreeData } from '../lib/repositories';
import {
  RepositorySummaryScheduler, repositorySummaryFromSnapshot, type RepositorySummaryMap,
} from '../lib/repository-summaries';
import { normalizeHistoryScope, normalizeSettingsPatch } from '../lib/settings-schema';
import { effectiveSettings, normalizeDirectoryScope, normalizeState, Requests, StateStore, isImmutableOid } from '../lib/state';
import { countWorkingFiles, deriveStatus, type StatusCounts, type StatusModel, type StatusResult } from '../lib/status';

const MAX_COMMITS = 50_000;
export interface WorkspaceHistoryQuery {
  scope: HistoryScope;
  search: string;
  searchMode: SearchMode;
  queryMode: 'filter' | 'search';
  order: NonNullable<HistoryQuery['order']>;
  filter?: Pick<CommitFilter, 'author' | 'hash' | 'refs' | 'after' | 'before'>;
}
export interface WorkspaceRepositoryState {
  current: Repository | null;
  /** The last successful, unfiltered native observation, never a UI-filtered working state. */
  snapshot: RepositorySnapshot | null;
  generation: number;
  loading: boolean;
  refreshing: boolean;
  openingPath: string | null;
  stale: boolean;
  error: AppError | null;
  lastSuccessfulRefresh: number | null;
}
export interface WorkspaceDirectoryState {
  scope: DirectoryScopeState | null;
  pendingScope: DirectoryScopeState | null;
  discovery: RepositoryDiscovery | null;
  loading: boolean;
  cancelled: boolean;
  error: AppError | null;
}
export interface WorkspaceHistoryState {
  commits: readonly Commit[];
  hasMore: boolean;
  /** Native offset includes duplicate OIDs returned across pages. */
  offset: number;
  query: WorkspaceHistoryQuery;
  loading: boolean;
  ready: boolean;
  stale: boolean;
  cancelled: boolean;
  error: AppError | null;
  selected: string | null;
}
export interface WorkspaceMetadataState {
  submodules: readonly SubmoduleInfo[];
  loading: boolean;
  stale: boolean;
  error: AppError | null;
}
export interface WorkspaceReveal { oid: string; repoId: string; generation: number; sequence: number }
export interface WorkspaceController {
  repo: WorkspaceRepositoryState;
  directory: WorkspaceDirectoryState;
  history: WorkspaceHistoryState;
  metadata: WorkspaceMetadataState;
  state: ShallowRef<PersistedState>;
  /** Shared review/settings store; callers mutating it must call touchState(). */
  readonly store: StateStore;
  touchState(): void;
  markStateDirty(): void;
  settings: ComputedRef<AppSettings>;
  recent: ComputedRef<PersistedState['recent']>;
  view: ComputedRef<ViewState | null>;
  refs: ComputedRef<readonly GitRef[]>;
  stashes: ComputedRef<readonly Stash[]>;
  remotes: ComputedRef<readonly Remote[]>;
  /** Null means not observed/authorized, not a measured clean worktree. */
  working: ComputedRef<WorkingState | null>;
  counts: ComputedRef<StatusCounts | null>;
  submodules: ComputedRef<readonly SubmoduleInfo[]>;
  visibleCommits: ComputedRef<readonly Commit[]>;
  graphRows: ComputedRef<readonly GraphRow[]>;
  repositoryTree: ComputedRef<RepositoryTreeData | null>;
  summaries: ShallowRef<RepositorySummaryMap>;
  diagnostics: ShallowRef<Diagnostics | null>;
  sessions: ShallowRef<readonly ExternalSession[]>;
  initialized: ShallowRef<boolean>;
  busy: ComputedRef<boolean>;
  actionBusy: ShallowRef<boolean>;
  trusting: ShallowRef<boolean>;
  error: ShallowRef<AppError | null>;
  notice: ShallowRef<StatusResult | null>;
  status: ComputedRef<StatusModel>;
  reveal: ShallowRef<WorkspaceReveal | null>;
  init(): Promise<void>;
  openRepository(path: string, scopeRoot?: string): Promise<boolean>;
  openDirectory(path: string, depth?: number): Promise<boolean>;
  pickRepository(): Promise<boolean>;
  pickDirectory(): Promise<boolean>;
  selectRepository(candidate: RepositoryCandidate): Promise<boolean>;
  closeRepository(): Promise<boolean>;
  closeDirectory(): Promise<boolean>;
  deactivate(): Promise<boolean>;
  refresh(): Promise<boolean>;
  loadMore(): Promise<boolean>;
  setQuery(patch: Partial<WorkspaceHistoryQuery>): Promise<boolean>;
  select(oid: string | null): void;
  revealOid(oid: string, resetQuery?: boolean): Promise<boolean>;
  revealHead(): Promise<boolean>;
  cancel(scope?: 'history' | 'directory' | 'open' | 'all'): Promise<boolean>;
  setTrust(trusted: boolean): Promise<boolean>;
  savePreferences(patch: SettingsPatch, scope?: 'global' | 'repository'): Promise<boolean>;
  /** Replaces all overrides for the current repository; an empty patch restores inheritance. */
  replaceRepositoryPreferences(patch: SettingsPatch): Promise<boolean>;
  updateLayout(patch: Partial<PersistedState['layout']>): void;
  saveView(patch: Partial<ViewState>): void;
  setDirectoryPreferences(patch: Partial<Pick<DirectoryScopeState, 'width' | 'collapsed' | 'collapsedPaths'>>): void;
  removeRecent(path: string): void;
  setVisibleCandidates(candidates: readonly RepositoryCandidate[]): void;
  refreshSummaries(path?: string): void;
  setActionBusy(value: boolean): void;
  /** Action completions must carry the generation captured before their asynchronous work. */
  applySnapshot(snapshot: RepositorySnapshot, generation: number): boolean;
  refreshAfterAction(repoId: string, generation: number): Promise<boolean>;
  flush(): Promise<boolean>;
  dismissError(): void;
  dismissNotice(): void;
  dispose(): Promise<void>;
}

function appError(value: unknown): AppError {
  if (value && typeof value === 'object' && 'message' in value) {
    return { code: 'code' in value && typeof value.code === 'string' ? value.code : 'WORKSPACE_ERROR',
      message: String(value.message), ...('detail' in value && value.detail ? { detail: String(value.detail) } : {}) };
  }
  return { code: 'WORKSPACE_ERROR', message: String(value) || 'Workspace operation failed.' };
}
function sameCandidate(a: RepositoryCandidate, b: RepositoryCandidate): boolean {
  return a.path === b.path && a.marker === b.marker && a.components.length === b.components.length
    && a.components.every((part, index) => part === b.components[index]);
}

/** DOM-free owner of one active native repository. Host, stores and caches are never deep-proxied. */
export function createWorkspaceController(host: Host): WorkspaceController {
  const error = shallowRef<AppError | null>(null), notice = shallowRef<StatusResult | null>(null);
  const report = (value: unknown): AppError => { const issue = appError(value); error.value = issue; return issue; };
  const fail = (code: string, message: string): false => { report({ code, message }); return false; };
  const store = markRaw(new StateStore(value => host.saveState(value), report));
  const state = shallowRef(markRaw(store.state));
  const publishState = (): void => { state.value = markRaw(store.state); triggerRef(state); };
  const queueState = (): void => { store.queue(); publishState(); };
  const cancelHost = async (id: string): Promise<void> => { try { await host.cancel(id); } catch (issue) { report(issue); throw issue; } };
  const requests = markRaw(new Requests(cancelHost));
  const repo = shallowReactive<WorkspaceRepositoryState>({ current: null, snapshot: null, generation: 0, loading: false,
    refreshing: false, openingPath: null, stale: false, error: null, lastSuccessfulRefresh: null });
  const directory = shallowReactive<WorkspaceDirectoryState>({ scope: null, pendingScope: null, discovery: null,
    loading: false, cancelled: false, error: null });
  const history = shallowReactive<WorkspaceHistoryState>({ commits: markRaw([]), hasMore: false, offset: 0,
    query: { scope: { kind: 'all' }, search: '', searchMode: 'all', queryMode: 'filter', order: state.value.settings.order },
    loading: false, ready: false, stale: false, cancelled: false, error: null, selected: null });
  const metadata = shallowReactive<WorkspaceMetadataState>({ submodules: markRaw([]), loading: false, stale: false, error: null });
  const diagnostics = shallowRef<Diagnostics | null>(null), initialized = shallowRef(false);
  const sessions = shallowRef<readonly ExternalSession[]>(markRaw([]));
  const actionBusy = shallowRef(false), trusting = shallowRef(false), reveal = shallowRef<WorkspaceReveal | null>(null);
  const settings = computed(() => effectiveSettings(state.value, repo.current?.id));
  const recent = computed(() => {
    const items = [...state.value.recent], sort = settings.value.repositorySort;
    if (sort !== 'recent') items.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : 0) || a.path.localeCompare(b.path));
    return items;
  });
  const view = computed(() => repo.current ? state.value.views[repo.current.id] ?? null : null);
  const refs = computed(() => repo.snapshot?.refs ?? []), stashes = computed(() => repo.snapshot?.stashes ?? []);
  const remotes = computed(() => repo.snapshot?.remotes ?? []);
  const working = computed(() => repo.current?.trusted && !repo.current.bare && repo.snapshot?.repository.trusted ? repo.snapshot.working : null);
  const counts = computed(() => working.value ? countWorkingFiles(working.value.files) : null);
  const submodules = computed(() => metadata.submodules);
  const visibleCommits = computed(() => {
    const query = history.query;
    if (!(query.queryMode === 'filter' && query.search.trim()) && !Object.values(query.filter ?? {}).some(Boolean)) return history.commits;
    return markRaw(history.commits.filter(commit => matchesCommit(commit, { ...query.filter,
      text: query.queryMode === 'filter' ? query.search : '', mode: query.searchMode, dateSource: settings.value.dateSource })));
  });
  const layout = markRaw(new HistoryLayoutCache());
  let topologyRevision = 0;
  const graphRows = computed(() => layout.prepare({ commits: history.commits, visible: visibleCommits.value,
    topologyRevision, workingHead: working.value && counts.value?.changed && settings.value.showUncommitted
      ? working.value.head !== undefined ? working.value.head : repo.current?.head ?? null : undefined }));
  const repositoryTree = computed(() => directory.scope && directory.discovery?.root === directory.scope.root
    ? markRaw(buildRepositoryTree(directory.scope.root, directory.discovery.repositories)) : null);
  const summaries = shallowRef<RepositorySummaryMap>(markRaw(new Map()));
  const scheduler = markRaw(new RepositorySummaryScheduler({
    cancel: cancelHost,
    probeRepository: host.probeRepository ? (candidate, root, id) => host.probeRepository!(candidate, root, id) : undefined,
  }, values => { summaries.value = markRaw(new Map(values)); }));
  const busy = computed(() => repo.loading || repo.refreshing || history.loading || directory.loading || metadata.loading || actionBusy.value || trusting.value);
  const status = computed(() => deriveStatus({ repository: repo.current, initialized: initialized.value, opening: repo.loading,
    working: working.value, workingLoading: repo.refreshing, workingStale: repo.stale, workingError: repo.error?.message,
    lastSuccessfulRefresh: repo.lastSuccessfulRefresh,
    history: { loaded: history.commits.length, visible: visibleCommits.value.length, hasMore: history.hasMore,
      loading: history.loading, ready: history.ready, stale: history.stale, error: history.error?.message },
    sessions: sessions.value, gitVersion: diagnostics.value?.gitVersion, result: error.value
      ? { id: 'workspace-error', kind: 'error', message: error.value.message, repoId: repo.current?.id } : notice.value,
    task: directory.loading ? { id: 'workspace-discovery', kind: 'discover', label: '' } : null,
  }, counts.value ?? undefined));

  let disposed = false, intent = 0, historyGeneration = 0, directoryGeneration = 0, dirtyEpoch = 0, sequence = 0;
  let initFlight: Promise<void> | undefined, deactivationFlight: Promise<boolean> | undefined;
  let discoveryFlight: Promise<RepositoryDiscovery> | undefined, historyFlight: Promise<boolean> | undefined;
  let unlistenRepository: (() => void) | undefined, unlistenExternal: (() => void) | undefined;
  let watcherTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshResult = false;
  const current = (generation: number, target: Repository): boolean => !disposed && generation === repo.generation
    && target.id === repo.current?.id && target.path === repo.current.path;
  const blocked = (): boolean => disposed || actionBusy.value || trusting.value;
  const allowSwitch = (): boolean => !blocked() || fail(disposed ? 'WORKSPACE_DISPOSED' : 'WORKSPACE_BUSY', 'The workspace cannot switch repositories while an operation is active.');
  const result = (kind: StatusResult['kind'], message: string, code: string): void => {
    notice.value = { id: `${code}:${++sequence}`, kind, message, repoId: repo.current?.id, at: Date.now() };
  };
  const refreshQueue = markRaw(new CoalescedRefresh(async mask => { refreshResult = await performRefresh(mask); }, {
    canRun: () => !blocked() && !repo.loading && !repo.refreshing && !history.loading && !metadata.loading && Boolean(repo.current),
    onError: issue => { report(issue); },
  }));
  function summaryScope(): void {
    const discovery = directory.discovery;
    scheduler.setScope(directory.scope?.root ?? null, discovery && discovery.root === directory.scope?.root ? discovery.repositories : []);
  }
  function saveView(patch: Partial<ViewState> = {}): void {
    const active = repo.current; if (!active || disposed) return;
    const previous = store.state.views[active.id], query = history.query;
    const filter = { ...previous?.filter, ...patch.filter };
    for (const key of ['author', 'hash', 'refs', 'after', 'before'] as const) {
      delete filter[key]; if (query.filter?.[key]) filter[key] = query.filter[key]!;
    }
    store.state.views[active.id] = { ...previous, ...patch, scrollTop: patch.scrollTop ?? previous?.scrollTop ?? 0, scope: structuredClone(query.scope),
      search: query.search, searchMode: query.searchMode, queryMode: query.queryMode, order: query.order,
      selected: history.selected, filter };
    queueState();
  }
  function replaceCommits(commits: readonly Commit[]): void { history.commits = markRaw([...commits]); topologyRevision++; }
  function attachRefs(commits: readonly Commit[]): readonly Commit[] {
    if (!repo.snapshot) return commits;
    const byOid = new Map<string, GitRef[]>(), prefs = settings.value;
    for (const ref of repo.snapshot.refs) {
      if (ref.kind === 'remote' && (!prefs.showRemotes || !prefs.showRemoteHeads && ref.fullName.endsWith('/HEAD'))
        || ref.kind === 'tag' && !prefs.showTags || ref.kind === 'stash' && !prefs.showStashes) continue;
      const list = byOid.get(ref.oid) ?? []; list.push(ref); byOid.set(ref.oid, list);
    }
    return commits.map(commit => {
      const next = byOid.get(commit.oid) ?? [];
      return JSON.stringify(next) === JSON.stringify(commit.refs) ? commit : { ...commit, refs: next };
    });
  }
  function applySnapshot(snapshot: RepositorySnapshot, generation: number): boolean {
    const target = repo.current;
    if (!target || !current(generation, target) || snapshot.repository.id !== target.id || snapshot.repository.path !== target.path) return false;
    repo.snapshot = markRaw(snapshot);
    repo.current = markRaw({ ...snapshot.repository, branch: snapshot.working.branch,
      head: snapshot.working.head !== undefined ? snapshot.working.head : snapshot.repository.head });
    repo.error = null; repo.stale = false; repo.lastSuccessfulRefresh = Date.now();
    replaceCommits(attachRefs(history.commits));
    scheduler.override(repositorySummaryFromSnapshot(snapshot));
    return true;
  }
  async function loadSnapshot(): Promise<boolean> {
    const target = repo.current; if (!target || disposed) return false;
    const generation = repo.generation, epoch = dirtyEpoch, request = requests.begin('snapshot');
    repo.refreshing = true; repo.stale = Boolean(repo.snapshot);
    try {
      const snapshot = await host.snapshot(target.id, request.id);
      if (!request.current() || !current(generation, target)) return false;
      if (!applySnapshot(snapshot, generation)) throw new Error('Repository snapshot identity does not match the active repository.');
      repo.stale = epoch !== dirtyEpoch;
      return true;
    } catch (issue) {
      if (request.current() && current(generation, target)) { repo.error = report(issue); repo.stale = Boolean(repo.snapshot); }
      return false;
    } finally { if (request.current()) repo.refreshing = false; request.finish(); refreshQueue.resume(); }
  }
  async function loadSubmodules(): Promise<boolean> {
    const target = repo.current; if (!target || disposed) return false;
    const generation = repo.generation, request = requests.begin('submodules');
    metadata.loading = true; metadata.stale = metadata.submodules.length > 0;
    try {
      const values = target.bare ? [] : await host.submodules(target.id, request.id);
      if (!request.current() || !current(generation, target)) return false;
      metadata.submodules = markRaw(values); metadata.stale = false; metadata.error = null; return true;
    } catch (issue) {
      if (request.current() && current(generation, target)) { metadata.error = report(issue); metadata.stale = metadata.submodules.length > 0; }
      return false;
    } finally { if (request.current()) metadata.loading = false; request.finish(); refreshQueue.resume(); }
  }
  function nativeQueryKey(): string {
    const query = history.query, prefs = settings.value;
    return JSON.stringify([query.scope, query.order, query.queryMode === 'search' ? query.search.trim() : '',
      query.queryMode === 'search' ? query.searchMode : '', prefs.firstParent, prefs.includeReflog, prefs.showRemotes,
      prefs.showTags, prefs.showStashes, prefs.mailmap, prefs.includeTagOnly, prefs.showRemoteHeads,
      prefs.collapseStashAuxiliary, prefs.muteNonAncestors]);
  }
  function loadHistory(reset: boolean, retain = false): Promise<boolean> {
    if (!repo.current || disposed || repo.loading || actionBusy.value || !reset && (history.loading || history.cancelled || !history.hasMore)) return Promise.resolve(false);
    const flight = readHistory(reset, retain); historyFlight = flight;
    void flight.then(() => { if (historyFlight === flight) historyFlight = undefined; });
    return flight;
  }
  async function readHistory(reset: boolean, retain: boolean): Promise<boolean> {
    const target = repo.current!, openGeneration = repo.generation;
    if (reset) {
      ++historyGeneration; history.cancelled = false; history.ready = false;
      if (!retain) { replaceCommits([]); history.offset = 0; history.hasMore = true; }
    }
    const generation = historyGeneration, request = requests.begin('history');
    const valid = (): boolean => request.current() && generation === historyGeneration && current(openGeneration, target);
    history.loading = true; history.stale = history.commits.length > 0;
    const query = structuredClone(history.query), prefs = settings.value;
    const desired = retain ? Math.max(prefs.initialLoad, history.commits.length) : 0;
    const known = new Set(reset ? [] : history.commits.map(commit => commit.oid)), replacement: Commit[] = [];
    let offset = reset ? 0 : history.offset, more = true;
    try {
      do {
        const limit = retain ? Math.min(1000, Math.max(prefs.initialLoad, desired - replacement.length)) : reset ? prefs.initialLoad : prefs.loadMore;
        const page = query.scope.kind === 'refs' && !query.scope.refs?.length ? { commits: [], hasMore: false }
          : await host.history({ repoId: target.id, requestId: request.id, offset, limit, scope: query.scope,
            search: query.queryMode === 'search' ? query.search.trim() || undefined : undefined,
            searchMode: query.queryMode === 'search' ? query.searchMode : undefined, order: query.order,
            firstParent: prefs.firstParent, includeReflog: prefs.includeReflog, showRemotes: prefs.showRemotes,
            showTags: prefs.showTags, showStashes: prefs.showStashes, mailmap: prefs.mailmap,
            includeTagOnly: prefs.includeTagOnly, showRemoteHeads: prefs.showRemoteHeads,
            collapseStashAuxiliary: prefs.collapseStashAuxiliary, markHeadAncestry: prefs.muteNonAncestors });
        if (!valid()) return false;
        const available = MAX_COMMITS - (reset ? replacement.length : history.commits.length + replacement.length);
        const fresh = page.commits.filter(commit => { if (known.has(commit.oid)) return false; known.add(commit.oid); return true; });
        replacement.push(...fresh.slice(0, available)); offset += page.commits.length;
        more = page.hasMore && page.commits.length > 0 && (reset ? replacement.length : history.commits.length + replacement.length) < MAX_COMMITS;
      } while (retain && more && replacement.length < desired);
      if (!valid()) return false;
      replaceCommits(attachRefs(reset ? replacement : [...history.commits, ...replacement]));
      history.offset = offset; history.hasMore = more; history.ready = true; history.stale = false; history.error = null;
      return true;
    } catch (issue) {
      if (valid()) { history.error = report(issue); history.stale = history.commits.length > 0; history.ready = false; history.cancelled = true; }
      return false;
    } finally { if (request.current()) history.loading = false; request.finish(); refreshQueue.resume(); }
  }
  async function performRefresh(mask: number): Promise<boolean> {
    const target = repo.current; if (!target || blocked()) return false;
    const generation = repo.generation;
    const values = await Promise.all([loadSnapshot(), loadSubmodules(),
      mask & RefreshFlags.History && !history.cancelled ? loadHistory(true, true) : Promise.resolve(true)]);
    if (!current(generation, target)) return false;
    saveView(); return values.every(Boolean);
  }
  async function refresh(): Promise<boolean> {
    if (!repo.current || blocked()) return false;
    ++intent; dirtyEpoch++; history.cancelled = false;
    clearTimeout(watcherTimer); watcherTimer = undefined;
    const target = repo.current, generation = repo.generation;
    refreshResult = false;
    refreshQueue.request(RefreshFlags.History | RefreshFlags.Working | RefreshFlags.Config);
    await refreshQueue.idle(); return current(generation, target) && refreshResult;
  }
  function stopHistory(): void {
    ++historyGeneration; requests.cancel('history'); history.loading = false; history.cancelled = true;
    refreshQueue.cancel(); result('cancelled', 'History loading cancelled.', 'history-cancelled');
  }
  function cancelDirectory(): void {
    ++directoryGeneration; requests.cancel('discovery'); directory.loading = false;
    directory.cancelled = true; directory.pendingScope = null;
  }
  function resetActive(preserveOpen = false): void {
    requests.cancelAll(['discovery', 'deactivate', ...(preserveOpen ? ['open'] : [])]); refreshQueue.cancel();
    clearTimeout(watcherTimer); watcherTimer = undefined; ++historyGeneration; dirtyEpoch++;
    repo.snapshot = null; repo.current = null; repo.loading = false; repo.refreshing = false;
    repo.openingPath = null; repo.stale = false; repo.error = null; repo.lastSuccessfulRefresh = null;
    replaceCommits([]); history.hasMore = false; history.offset = 0; history.loading = false;
    history.ready = false; history.stale = false; history.cancelled = false; history.error = null; history.selected = null;
    metadata.submodules = markRaw([]); metadata.loading = false; metadata.stale = false; metadata.error = null;
    reveal.value = null; layout.clear();
  }
  async function closeCurrent(clearLast = true): Promise<boolean> {
    saveView(); ++repo.generation; resetActive();
    if (clearLast) { store.state.lastRepo = null; queueState(); }
    const previous = deactivationFlight;
    const flight = (async (): Promise<boolean> => {
      if (previous) await previous;
      const request = requests.begin('deactivate');
      try {
        if (!host.deactivateRepository) return fail('HOST_UNSUPPORTED', 'This host cannot deactivate the active repository watcher.');
        await host.deactivateRepository(request.id); return true;
      } catch (issue) { report(issue); return false; }
      finally { request.finish(); }
    })();
    deactivationFlight = flight;
    return flight;
  }
  async function closeRepository(): Promise<boolean> {
    if (!allowSwitch()) return false;
    ++intent; if (directory.loading) cancelDirectory(); return closeCurrent();
  }
  async function closeDirectory(): Promise<boolean> {
    if (!allowSwitch()) return false;
    ++intent; cancelDirectory(); directory.scope = null; directory.discovery = null; directory.error = null; directory.cancelled = false;
    store.state.directoryScope = null; queueState(); summaryScope(); return closeCurrent();
  }
  function restoredQuery(saved?: ViewState): WorkspaceHistoryQuery {
    return { scope: structuredClone(saved?.scope ?? settings.value.startupScope), search: saved?.search ?? '',
      searchMode: (['all', 'message', 'author', 'hash', 'date', 'refs'].includes(saved?.searchMode ?? '') ? saved!.searchMode : 'all') as SearchMode,
      queryMode: saved?.queryMode ?? 'filter', order: saved?.order ?? settings.value.order,
      filter: saved?.filter ? { author: saved.filter.author, hash: saved.filter.hash, refs: saved.filter.refs,
        after: saved.filter.after, before: saved.filter.before } : undefined };
  }
  async function openRepository(path: string, scopeRoot?: string): Promise<boolean> {
    if (!allowSwitch()) return false;
    saveView(); const epoch = ++intent, generation = ++repo.generation;
    requests.cancelAll(['deactivate', ...(scopeRoot ? ['discovery'] : [])]); refreshQueue.cancel();
    clearTimeout(watcherTimer); watcherTimer = undefined;
    ++historyGeneration; history.loading = false; history.ready = false; history.stale = history.commits.length > 0;
    repo.refreshing = false; metadata.loading = false;
    if (!scopeRoot) cancelDirectory();
    repo.loading = true; repo.openingPath = path; repo.stale = Boolean(repo.snapshot); error.value = null; notice.value = null;
    const request = requests.begin('open');
    const valid = (): boolean => request.current() && generation === repo.generation && !disposed;
    try {
      if (deactivationFlight && !await deactivationFlight) {
        if (valid()) fail('DEACTIVATION_FAILED', 'The previous repository watcher could not be deactivated. Retry closing it before opening another repository.');
        return false;
      }
      if (!valid()) return false;
      const opened = await host.openRepository(path, request.id, scopeRoot);
      if (!valid()) return false;
      resetActive(true); repo.current = markRaw(opened);
      history.query = restoredQuery(store.state.views[opened.id]);
      const saved = store.state.views[opened.id];
      store.state.lastRepo = opened.path;
      store.state.recent = [{ path: opened.path, name: opened.name }, ...store.state.recent.filter(item => item.path !== opened.path)].slice(0, 30);
      if (!scopeRoot) { directory.scope = null; directory.discovery = null; directory.pendingScope = null; store.state.directoryScope = null; summaryScope(); }
      queueState();
      const reads = [loadSnapshot(), loadHistory(true), loadSubmodules()];
      const restoringHistoryGeneration = historyGeneration;
      const values = await Promise.all(reads);
      if (!current(generation, opened)) return false;
      let restored = true;
      if (intent === epoch && restoringHistoryGeneration === historyGeneration && history.ready && !history.cancelled) {
        const desired = Math.min(MAX_COMMITS, Math.max(settings.value.initialLoad, Math.ceil((saved?.scrollTop ?? 0) / settings.value.rowHeight) + 60));
        while (saved && history.hasMore && history.commits.length < desired && intent === epoch && current(generation, opened)) {
          const before = history.commits.length;
          if (!await loadHistory(false)) { restored = false; break; }
          if (history.commits.length === before) break;
        }
        if (intent === epoch && current(generation, opened)) history.selected = saved?.selected ?? null;
      }
      if (current(generation, opened)) saveView();
      return current(generation, opened) && values.every(Boolean) && restored;
    } catch (issue) { if (valid()) { repo.error = report(issue); repo.stale = Boolean(repo.snapshot); } return false; }
    finally { if (generation === repo.generation) { repo.loading = false; repo.openingPath = null; } request.finish(); refreshQueue.resume(); }
  }
  async function selectRepository(candidate: RepositoryCandidate): Promise<boolean> {
    if (!allowSwitch()) return false;
    const discovery = directory.discovery, scope = directory.scope;
    const selected = discovery?.repositories.find(item => sameCandidate(item, candidate));
    if (!scope || scope.root !== discovery?.root || !selected) return fail('STALE_REPOSITORY_CANDIDATE', 'The repository candidate is no longer in the current directory scan.');
    if (repo.current?.path === selected.path && !repo.loading) { ++intent; return true; }
    return openRepository(selected.path, scope.root);
  }
  async function openDirectory(path: string, depth?: number): Promise<boolean> {
    if (!allowSwitch()) return false;
    ++intent;
    const generation = ++directoryGeneration, activation = repo.generation;
    const previous = directory.pendingScope ?? directory.scope ?? store.state.directoryScope;
    const pending: DirectoryScopeState = { root: path,
      depth: clampRepositoryDepth(depth ?? (previous?.root === path ? previous.depth : state.value.settings.discoveryDepth)),
      width: previous?.width ?? 376, collapsed: previous?.root === path ? previous.collapsed : false,
      collapsedPaths: previous?.root === path ? [...previous.collapsedPaths] : [] };
    const remembered = repo.current?.path ?? store.state.lastRepo, request = requests.begin('discovery');
    const valid = (): boolean => request.current() && generation === directoryGeneration && !disposed;
    directory.pendingScope = pending; directory.loading = true; directory.cancelled = false; directory.error = null;
    try {
      // A superseded native scan keeps its process slot until it actually settles.
      if (discoveryFlight) await discoveryFlight.catch(() => undefined);
      if (!valid()) return false;
      const flight = host.discoverRepositories(path, pending.depth, request.id); discoveryFlight = flight;
      let found: RepositoryDiscovery;
      try { found = await flight; } finally { if (discoveryFlight === flight) discoveryFlight = undefined; }
      if (!valid()) return false;
      const keepActive = Boolean(repo.current && found.repositories.some(item => item.path === repo.current!.path));
      const activationChanged = repo.generation !== activation;
      directory.discovery = markRaw(found); directory.scope = markRaw({ ...pending, root: found.root });
      directory.pendingScope = null; directory.loading = false; store.state.directoryScope = directory.scope; queueState(); summaryScope();
      if (repo.current && !keepActive && !activationChanged && !await closeCurrent()) return false;
      if (!valid()) return false;
      const target = !keepActive && !activationChanged ? found.repositories.find(item => item.path === remembered)
        ?? (found.complete && found.repositories.length === 1 ? found.repositories[0] : undefined) : undefined;
      return target ? await selectRepository(target) : true;
    } catch (issue) { if (valid()) { directory.error = report(issue); directory.pendingScope = null; } return false; }
    finally { if (generation === directoryGeneration) directory.loading = false; request.finish(); }
  }
  async function pick(purpose: 'repository' | 'directory'): Promise<boolean> {
    if (!allowSwitch()) return false;
    const epoch = ++intent;
    try {
      const path = await host.pickRepository(purpose);
      if (!path || disposed || epoch !== intent) return false;
      return purpose === 'directory' ? openDirectory(path) : openRepository(path);
    } catch (issue) { if (!disposed && epoch === intent) report(issue); return false; }
  }
  async function setQuery(patch: Partial<WorkspaceHistoryQuery>): Promise<boolean> {
    if (disposed || actionBusy.value) return false;
    const previous = nativeQueryKey(); ++intent;
    const next = { ...history.query, ...patch };
    const scope = normalizeHistoryScope(next.scope);
    if (!scope) return fail('INVALID_HISTORY_SCOPE', 'The history scope is invalid.');
    history.query = markRaw({ ...next, scope, search: next.search.slice(0, 32768),
      filter: next.filter ? { ...next.filter } : undefined });
    saveView();
    if (previous === nativeQueryKey() && !history.cancelled) return true;
    return loadHistory(true);
  }
  function select(oid: string | null): void { if (disposed) return; ++intent; history.selected = oid; saveView(); }
  async function revealOid(oid: string, resetQuery = false): Promise<boolean> {
    if (!isImmutableOid(oid)) return fail('INVALID_OID', 'A full immutable commit OID is required.');
    const target = repo.current; if (!target || blocked()) return false;
    const generation = repo.generation;
    if (resetQuery) {
      const reset = setQuery({ scope: { kind: 'all' }, search: '', queryMode: 'filter', filter: undefined });
      const queryIntent = intent;
      if (!await reset || queryIntent !== intent || !current(generation, target)) return false;
    }
    const epoch = ++intent;
    const valid = (): boolean => epoch === intent && current(generation, target) && !history.cancelled;
    if (history.loading && historyFlight) await historyFlight;
    while (valid() && !history.commits.some(commit => commit.oid === oid) && history.hasMore) {
      const before = history.commits.length; if (!await loadHistory(false) || history.commits.length === before) break;
    }
    if (!valid()) return false;
    if (!visibleCommits.value.some(commit => commit.oid === oid)) {
      result('info', 'The commit was not found in the current history query.', 'commit-not-visible'); return false;
    }
    history.selected = oid; reveal.value = { oid, repoId: target.id, generation, sequence: ++sequence }; saveView(); return true;
  }
  async function revealHead(): Promise<boolean> {
    const head = repo.current?.head;
    if (!head) { result('info', 'The repository has no HEAD commit.', 'head-unborn'); return false; }
    return revealOid(head, true);
  }
  async function cancel(scope: 'history' | 'directory' | 'open' | 'all' = 'history'): Promise<boolean> {
    ++intent;
    if (scope === 'history' || scope === 'all') stopHistory();
    if (scope === 'directory' || scope === 'all') cancelDirectory();
    if (scope === 'open' || scope === 'all') {
      if (!allowSwitch()) return false;
      return closeCurrent();
    }
    return true;
  }
  async function flush(): Promise<boolean> {
    try { await store.flush(); publishState(); return true; } catch (issue) { report(issue); publishState(); return false; }
  }
  async function setTrust(trusted: boolean): Promise<boolean> {
    const target = repo.current; if (!target || blocked()) return false;
    const generation = repo.generation; ++intent; trusting.value = true;
    requests.cancel('snapshot'); requests.cancel('submodules'); repo.refreshing = false; metadata.loading = false;
    try {
      await host.trustRepository(target.id, trusted);
      if (!current(generation, target)) return false;
      repo.current = markRaw({ ...repo.current!, trusted }); repo.stale = Boolean(repo.snapshot);
      store.state.trusted = store.state.trusted.filter(path => path !== target.path);
      if (trusted) store.state.trusted.push(target.path);
      queueState(); scheduler.refresh(target.path);
    } catch (issue) { if (current(generation, target)) report(issue); return false; }
    finally { trusting.value = false; refreshQueue.resume(); }
    const values = await Promise.all([refresh(), flush()]);
    return values.every(Boolean);
  }
  async function savePreferences(patch: SettingsPatch, scope: 'global' | 'repository' = 'global'): Promise<boolean> {
    if (disposed) return false;
    const target = repo.current, previous = nativeQueryKey(), generation = repo.generation;
    if (scope === 'repository' && !target) return fail('REPOSITORY_REQUIRED', 'Select a repository before saving repository preferences.');
    store.updateSettings(patch, scope === 'repository' ? target!.id : undefined); publishState();
    if (patch.order) history.query = { ...history.query, order: settings.value.order };
    replaceCommits(attachRefs(history.commits)); saveView();
    const saved = flush();
    const loaded = previous !== nativeQueryKey() && target && current(generation, target) ? loadHistory(true, true) : Promise.resolve(true);
    const values = await Promise.all([saved, loaded]); return values.every(Boolean);
  }
  async function replaceRepositoryPreferences(patch: SettingsPatch): Promise<boolean> {
    if (disposed) return false;
    const target = repo.current, generation = repo.generation;
    if (!target) return fail('REPOSITORY_REQUIRED', 'Select a repository before saving repository preferences.');
    const previous = nativeQueryKey(), previousOrder = settings.value.order;
    const clean = normalizeSettingsPatch(patch, { scope: 'repository' });
    ++intent;
    if (Object.keys(clean).length) store.state.repoSettings[target.id] = clean;
    else delete store.state.repoSettings[target.id];
    queueState();
    if (current(generation, target)) {
      if (clean.order || previousOrder !== settings.value.order) history.query = { ...history.query, order: settings.value.order };
      replaceCommits(attachRefs(history.commits)); saveView();
    }
    const saved = flush();
    const loaded = current(generation, target) && previous !== nativeQueryKey() ? loadHistory(true, true) : Promise.resolve(true);
    const values = await Promise.all([saved, loaded]);
    return current(generation, target) && values.every(Boolean);
  }
  function updateLayout(patch: Partial<PersistedState['layout']>): void {
    if (disposed) return;
    store.state.layout = normalizeState({ ...store.state, layout: { ...store.state.layout, ...patch } }).layout; queueState();
  }
  function setDirectoryPreferences(patch: Partial<Pick<DirectoryScopeState, 'width' | 'collapsed' | 'collapsedPaths'>>): void {
    const scope = directory.scope; if (!scope || disposed) return;
    const clean = normalizeDirectoryScope({ ...scope, ...patch }); if (!clean) return;
    directory.scope = markRaw(clean); store.state.directoryScope = clean; queueState();
    if (clean.collapsed) scheduler.setVisible([]);
  }
  function removeRecent(path: string): void {
    if (disposed) return; store.state.recent = store.state.recent.filter(item => item.path !== path); queueState();
  }
  function setActionBusy(value: boolean): void { actionBusy.value = value; if (!value) refreshQueue.resume(); }
  function init(): Promise<void> {
    if (initFlight) return initFlight;
    if (disposed) return Promise.resolve();
    const epoch = intent;
    initFlight = (async () => {
      const [saved, info] = await Promise.allSettled([host.loadState(), host.diagnostics()]);
      if (disposed) return;
      if (saved.status === 'fulfilled') { if (intent === epoch) { store.load(saved.value); publishState(); } } else report(saved.reason);
      if (info.status === 'fulfilled') diagnostics.value = markRaw(info.value); else report(info.reason);
      initialized.value = true;
      const listen = async (subscribe: () => Promise<() => void>, assign: (unlisten: () => void) => void): Promise<void> => {
        try { const unlisten = await subscribe(); if (disposed) unlisten(); else assign(unlisten); } catch (issue) { report(issue); }
      };
      await Promise.all([
        listen(() => host.onRepositoryChanged(id => {
          if (disposed || id !== repo.current?.id) return;
          dirtyEpoch++; repo.stale = Boolean(repo.snapshot); history.stale = history.commits.length > 0;
          clearTimeout(watcherTimer);
          watcherTimer = setTimeout(() => { watcherTimer = undefined;
            refreshQueue.request(RefreshFlags.Working | RefreshFlags.Config | (history.cancelled ? 0 : RefreshFlags.History));
          }, 600);
        }), value => { unlistenRepository = value; }),
        listen(() => host.onExternalSession(session => {
          if (disposed) return;
          sessions.value = markRaw([...sessions.value.filter(item => item.id !== session.id), session].slice(-50));
          if (session.repoId === repo.current?.id && ['completed', 'failed', 'paused'].includes(session.status)) {
            refreshQueue.request(RefreshFlags.Working | RefreshFlags.Config | (history.cancelled ? 0 : RefreshFlags.History));
          }
        }), value => { unlistenExternal = value; }),
      ]);
      if (disposed || intent !== epoch) return;
      const directoryScope = store.state.directoryScope;
      if (directoryScope) await openDirectory(directoryScope.root, directoryScope.depth);
      else if (store.state.lastRepo) await openRepository(store.state.lastRepo);
    })();
    return initFlight;
  }
  async function dispose(): Promise<void> {
    if (disposed) return;
    saveView(); disposed = true; ++intent; ++repo.generation; ++historyGeneration; ++directoryGeneration;
    clearTimeout(watcherTimer); requests.cancelAll(); scheduler.destroy(); refreshQueue.dispose(); layout.clear();
    for (const unlisten of [unlistenRepository, unlistenExternal]) { try { unlisten?.(); } catch (issue) { report(issue); } }
    unlistenRepository = undefined; unlistenExternal = undefined;
    // Preserve lastRepo/directoryScope for the next startup; disposal is not a user close.
    const values = await Promise.allSettled([store.flush(), (async () => {
      if (deactivationFlight) await deactivationFlight;
      if (host.deactivateRepository) await host.deactivateRepository();
    })()]);
    for (const value of values) if (value.status === 'rejected') report(value.reason);
    repo.loading = false; repo.refreshing = false; history.loading = false; directory.loading = false; metadata.loading = false;
  }
  return {
    repo, directory, history, metadata, state, store, touchState: queueState, markStateDirty: queueState, settings, recent, view, refs, stashes, remotes, working, counts, submodules,
    visibleCommits, graphRows, repositoryTree, summaries, diagnostics, sessions, initialized, busy, actionBusy, trusting,
    error, notice, status, reveal, init, openRepository, openDirectory, pickRepository: () => pick('repository'),
    pickDirectory: () => pick('directory'), selectRepository, closeRepository, closeDirectory, deactivate: closeRepository,
    refresh, loadMore: () => loadHistory(false), setQuery, select, revealOid, revealHead, cancel, setTrust, savePreferences, replaceRepositoryPreferences,
    updateLayout, saveView, setDirectoryPreferences, removeRecent, setVisibleCandidates: values => { summaryScope(); scheduler.setVisible(values); },
    refreshSummaries: path => scheduler.refresh(path), setActionBusy, applySnapshot,
    refreshAfterAction: (id, generation) => repo.current?.id === id && repo.generation === generation ? refresh() : Promise.resolve(false),
    flush, dismissError: () => { error.value = null; }, dismissNotice: () => { notice.value = null; }, dispose,
  };
}

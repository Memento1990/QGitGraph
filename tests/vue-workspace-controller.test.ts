import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isProxy, watchEffect } from 'vue';
import { createWorkspaceController, type WorkspaceController } from '../src/controllers/workspace';
import {
  defaultState, type ChangedFile, type Commit, type ExternalSession, type HistoryPage, type Host,
  type PersistedState, type Repository, type RepositoryCandidate, type RepositoryDiscovery, type RepositorySnapshot,
} from '../src/shared/protocol';

// Opaque, controlled data only: no DesktopHost, filesystem, Git process or private repository is used.
const ROOT = 'D:/WorkspaceControllerFixtures';
const A = `${ROOT}/a`, B = `${ROOT}/b`;
const oid = (letter: string): string => letter.repeat(40);
const candidate = (path: string): RepositoryCandidate => ({ path, components: [path.split('/').at(-1)!], marker: 'git-directory' });
function repository(path = A, trusted = false): Repository {
  return { id: `fixture:${path}`, path, name: path.split('/').at(-1)!, gitDir: `${path}/.git`, commonDir: `${path}/.git`,
    head: oid(path === A ? 'a' : 'b'), branch: 'main', trusted, bare: false };
}
function commit(id = oid('a'), parents: string[] = []): Commit {
  return { oid: id, parents, author: 'Fixture', email: 'fixture@example.test', subject: `Commit ${id[0]}`,
    authoredAt: 1, committedAt: 2, refs: [] };
}
function changed(path: string, patch: Partial<ChangedFile> = {}): ChangedFile {
  return { path, oldPath: null, status: ' M', staged: false, unstaged: true, additions: 1, deletions: 0, ...patch };
}
function snapshot(repo = repository(), files: ChangedFile[] = []): RepositorySnapshot {
  return { repository: repo, working: { files, branch: repo.branch, head: repo.head, ahead: 0, behind: 0,
    upstream: null, trackingKnown: false, operation: null, conflicts: 0 }, fingerprint: `snapshot:${repo.path}`,
    refs: [{ name: 'main', fullName: 'refs/heads/main', kind: 'branch', current: true, oid: repo.head!, upstream: null, subject: '' }],
    stashes: [], remotes: [] };
}
function discovery(paths: string[], complete = true): RepositoryDiscovery {
  return { root: ROOT, repositories: paths.map(candidate), complete, limit: complete ? null : 'entries', warnings: [], directories: 3, entries: 10 };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (issue: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> { for (let count = 0; count < 24; count++) await Promise.resolve(); }
function fakeHost(saved: PersistedState = defaultState()) {
  const repositories = new Map<string, Repository>();
  let changedListener: ((id: string) => void) | undefined, externalListener: ((session: ExternalSession) => void) | undefined;
  const get = (id: string): Repository => { const value = repositories.get(id); if (!value) throw new Error(`Unknown fixture ${id}`); return value; };
  const unlistenRepository = vi.fn(), unlistenExternal = vi.fn();
  const methods = {
    diagnostics: vi.fn<Host['diagnostics']>().mockResolvedValue({ appVersion: '0.3.0', gitVersion: 'fixture', gitPath: null, platform: 'fixture' }),
    loadState: vi.fn<Host['loadState']>().mockImplementation(async () => structuredClone(saved)),
    saveState: vi.fn<Host['saveState']>().mockResolvedValue(undefined),
    pickRepository: vi.fn<Host['pickRepository']>().mockResolvedValue(null),
    openRepository: vi.fn<Host['openRepository']>().mockImplementation(async path => {
      const value = repository(path); repositories.set(value.id, value); return value;
    }),
    deactivateRepository: vi.fn<NonNullable<Host['deactivateRepository']>>().mockResolvedValue(undefined),
    cancel: vi.fn<Host['cancel']>().mockResolvedValue(undefined),
    snapshot: vi.fn<Host['snapshot']>().mockImplementation(async id => snapshot(get(id))),
    history: vi.fn<Host['history']>().mockImplementation(async query => ({ commits: [commit(get(query.repoId).head!)], hasMore: false })),
    submodules: vi.fn<Host['submodules']>().mockResolvedValue([]),
    discoverRepositories: vi.fn<Host['discoverRepositories']>().mockResolvedValue(discovery([A, B])),
    probeRepository: vi.fn<NonNullable<Host['probeRepository']>>().mockImplementation(async item => ({ path: item.path,
      branch: 'main', head: repository(item.path).head, trusted: false, bare: false,
      changes: null, staged: null, unstaged: null, untracked: null, ahead: null, behind: null, upstream: null })),
    trustRepository: vi.fn<Host['trustRepository']>().mockImplementation(async (id, trusted) => { repositories.set(id, { ...get(id), trusted }); }),
    onRepositoryChanged: vi.fn<Host['onRepositoryChanged']>().mockImplementation(async listener => { changedListener = listener; return unlistenRepository; }),
    onExternalSession: vi.fn<Host['onExternalSession']>().mockImplementation(async listener => { externalListener = listener; return unlistenExternal; }),
  };
  const host: Host = new Proxy(methods as unknown as Host, { get(target, property, receiver) {
    if (Reflect.has(target, property) || typeof property !== 'string') return Reflect.get(target, property, receiver);
    return undefined;
  } });
  return { host, methods, unlistenRepository, unlistenExternal, emitChange: (id: string) => changedListener?.(id),
    emitSession: (session: ExternalSession) => externalListener?.(session) };
}
const controllers: WorkspaceController[] = [];
function fixture(state?: PersistedState) {
  const fake = fakeHost(state), controller = createWorkspaceController(fake.host); controllers.push(controller);
  return { ...fake, controller };
}
afterEach(async () => { for (const controller of controllers.splice(0)) await controller.dispose(); vi.useRealTimers(); });

describe('Vue workspace controller initialization and state', () => {
  it('is inert at creation and initializes once without opening any repository by default', async () => {
    const { controller: c, methods, unlistenRepository, unlistenExternal } = fixture();
    expect(methods.loadState).not.toHaveBeenCalled(); expect(c.working.value).toBeNull();
    await Promise.all([c.init(), c.init()]);
    expect(methods.loadState).toHaveBeenCalledOnce(); expect(methods.diagnostics).toHaveBeenCalledOnce();
    expect(methods.onRepositoryChanged).toHaveBeenCalledOnce(); expect(methods.onExternalSession).toHaveBeenCalledOnce();
    expect(methods.openRepository).not.toHaveBeenCalled(); expect(methods.discoverRepositories).not.toHaveBeenCalled();
    expect(methods.trustRepository).not.toHaveBeenCalled(); expect(c.initialized.value).toBe(true);
    expect(c.status.value.state).toBe('empty');
    await c.dispose(); expect(unlistenRepository).toHaveBeenCalledOnce(); expect(unlistenExternal).toHaveBeenCalledOnce();
  });
  it('publishes shallow state changes and shares one raw StateStore', async () => {
    const { controller: c, methods } = fixture(); await c.init();
    const scope = effectScope(), observed: string[] = [];
    scope.run(() => watchEffect(() => { observed.push(c.settings.value.theme); }));
    c.state.value.settings = { ...c.state.value.settings, theme: 'light' }; c.touchState(); await settle();
    expect(observed.at(-1)).toBe('light'); expect(c.store.state).toBe(c.state.value);
    expect(isProxy(c.store)).toBe(false); expect(isProxy(c.state.value)).toBe(false);
    expect(await c.savePreferences({ theme: 'dark' })).toBe(true); expect(c.settings.value.theme).toBe('dark');
    expect(methods.saveState).toHaveBeenCalled(); scope.stop();
  });
  it('exposes initialization and preference persistence failures without claiming success', async () => {
    const { controller: c, methods } = fixture();
    methods.loadState.mockRejectedValueOnce({ code: 'LOAD_FAILED', message: 'Cannot load fixture preferences.' });
    await c.init(); expect(c.error.value?.code).toBe('LOAD_FAILED'); expect(c.initialized.value).toBe(true);
    methods.saveState.mockRejectedValueOnce(new Error('Save refused.'));
    expect(await c.savePreferences({ theme: 'light' })).toBe(false);
    expect(c.error.value?.message).toBe('Save refused.'); expect(c.store.dirty).toBe(true);
    expect(await c.flush()).toBe(true); expect(c.store.dirty).toBe(false);
  });
  it('does not let a late startup state overwrite a newer explicit open intent', async () => {
    const saved = defaultState(); saved.lastRepo = B;
    const { controller: c, methods } = fixture(saved), waiting = deferred<PersistedState>();
    methods.loadState.mockReturnValueOnce(waiting.promise); const startup = c.init();
    expect(await c.openRepository(A)).toBe(true); waiting.resolve(saved); await startup;
    expect(c.repo.current?.path).toBe(A); expect(methods.openRepository).toHaveBeenCalledTimes(1);
  });
});

describe('repository preference replacement', () => {
  it('deletes overrides, restores inherited order and reloads history with the effective query', async () => {
    const state = defaultState(); state.settings.order = 'date';
    state.repoSettings[repository(A).id] = { order: 'topo', firstParent: true };
    const { controller: c, methods } = fixture(state); await c.init(); await c.openRepository(A);
    expect(c.history.query.order).toBe('topo'); c.select(oid('a'));
    methods.history.mockClear(); methods.saveState.mockClear();
    expect(await c.replaceRepositoryPreferences({})).toBe(true);
    expect(c.state.value.repoSettings).not.toHaveProperty(repository(A).id);
    expect(c.settings.value.order).toBe('date'); expect(c.history.query.order).toBe('date');
    expect(c.history.selected).toBe(oid('a')); expect(c.history.ready).toBe(true);
    expect(methods.history).toHaveBeenCalledOnce();
    expect(methods.history.mock.calls[0][0]).toMatchObject({ repoId: repository(A).id, offset: 0, order: 'date', firstParent: false });
    expect(methods.saveState.mock.calls.at(-1)![0].repoSettings).not.toHaveProperty(repository(A).id);
  });
  it('publishes a theme-only replacement without querying history or resetting the current query order', async () => {
    const { controller: c, methods } = fixture(); await c.init(); await c.openRepository(A);
    await c.setQuery({ order: 'topo' });
    methods.history.mockClear(); const snapshots = methods.snapshot.mock.calls.length;
    expect(await c.replaceRepositoryPreferences({ theme: 'light' })).toBe(true);
    expect(c.settings.value.theme).toBe('light'); expect(c.state.value.repoSettings[repository(A).id]).toEqual({ theme: 'light' });
    expect(c.history.query.order).toBe('topo'); expect(methods.history).not.toHaveBeenCalled();
    expect(methods.snapshot).toHaveBeenCalledTimes(snapshots); expect(methods.saveState).toHaveBeenCalled();
  });
  it('does not publish late history or report current success after the repository changes and returns', async () => {
    vi.useFakeTimers();
    const state = defaultState(); state.repoSettings[repository(A).id] = { order: 'topo' };
    state.repoSettings[repository(B).id] = { order: 'author-date', theme: 'light' };
    const { controller: c, methods } = fixture(state); await c.init(); await c.openRepository(A);
    const saving = deferred<void>(), reading = deferred<HistoryPage>(), originalGeneration = c.repo.generation;
    methods.saveState.mockReturnValueOnce(saving.promise); methods.history.mockReturnValueOnce(reading.promise);
    const replacing = c.replaceRepositoryPreferences({}); await settle();
    expect(methods.history.mock.calls.at(-1)![0]).toMatchObject({ repoId: repository(A).id, order: 'date' });
    await c.openRepository(B); expect(c.history.query.order).toBe('author-date');
    await c.openRepository(A); c.select(oid('c'));
    const active = c.repo.snapshot, commits = c.history.commits, query = c.history.query, count = methods.history.mock.calls.length;
    reading.resolve({ commits: [commit(oid('d'))], hasMore: true }); saving.resolve(undefined);
    expect(await replacing).toBe(false); expect(c.repo.generation).toBeGreaterThan(originalGeneration);
    expect(c.repo.current?.path).toBe(A); expect(c.repo.snapshot).toBe(active); expect(c.history.commits).toBe(commits);
    expect(c.history.query).toBe(query); expect(c.history.selected).toBe(oid('c')); expect(c.history.loading).toBe(false);
    expect(c.state.value.repoSettings[repository(B).id]).toEqual({ order: 'author-date', theme: 'light' });
    expect(methods.history).toHaveBeenCalledTimes(count); expect(c.error.value).toBeNull();
  });
});

describe('active repository reads, unknown state and generation guards', () => {
  it('starts history independently of a slow snapshot and exposes real metadata without a deep proxy', async () => {
    const { controller: c, methods } = fixture(), waiting = deferred<RepositorySnapshot>();
    methods.snapshot.mockReturnValueOnce(waiting.promise);
    methods.submodules.mockResolvedValueOnce([{ path: 'child', name: 'child', url: '', initialized: true,
      head: oid('c'), indexOid: oid('c'), modified: true, untracked: false }]);
    const opening = c.openRepository(A); await settle();
    expect(methods.history).toHaveBeenCalledOnce(); expect(c.history.ready).toBe(true);
    expect(c.history.commits[0].oid).toBe(oid('a')); expect(c.repo.snapshot).toBeNull(); expect(c.working.value).toBeNull();
    expect(c.submodules.value[0].path).toBe('child');
    const value = snapshot(repository(A, true)); waiting.resolve(value);
    expect(await opening).toBe(true); expect(c.repo.snapshot).toBe(value); expect(isProxy(c.repo.snapshot)).toBe(false);
    expect(isProxy(c.history.commits)).toBe(false); expect(isProxy(c.history.commits[0])).toBe(false);
    expect(c.refs.value).toBe(value.refs); expect(c.history.commits[0].refs).toEqual(value.refs);
    expect(methods.trustRepository).not.toHaveBeenCalled();
  });
  it('counts distinct raw paths even when untracked display is hidden, and leaves tracking unknown', async () => {
    const { controller: c, methods } = fixture();
    methods.snapshot.mockResolvedValueOnce(snapshot(repository(A, true), [
      changed('same', { staged: true, unstaged: false }), changed('same'), changed('new', { status: '??' }),
    ]));
    await c.openRepository(A); await c.savePreferences({ showUntracked: false });
    expect(c.counts.value).toEqual({ changed: 2, staged: 1, unstaged: 1, untracked: 1, conflicts: 0 });
    expect(c.status.value.working.counts?.changed).toBe(2); expect(c.status.value.tracking.ahead).toBeNull();
    expect(c.graphRows.value[0].oid).toBe('WORKTREE'); expect(c.graphRows.value[0].edges.length).toBeGreaterThan(0);
  });
  it('does not interpret an untrusted empty working observation as a clean repository', async () => {
    const { controller: c } = fixture(); await c.openRepository(A);
    expect(c.repo.current?.trusted).toBe(false); expect(c.working.value).toBeNull(); expect(c.counts.value).toBeNull();
    expect(c.status.value.working.kind).toBe('unknown'); expect(c.status.value.tracking.ahead).toBeNull();
  });
  it('keeps the last successful snapshot stale on refresh failure', async () => {
    const { controller: c, methods } = fixture(); methods.snapshot.mockResolvedValueOnce(snapshot(repository(A, true), [changed('one')]));
    await c.openRepository(A); const previous = c.repo.snapshot, timestamp = c.repo.lastSuccessfulRefresh;
    methods.snapshot.mockRejectedValueOnce({ code: 'SNAPSHOT_FAILED', message: 'Snapshot refused.' });
    expect(await c.refresh()).toBe(false); expect(c.repo.snapshot).toBe(previous);
    expect(c.repo.stale).toBe(true); expect(c.status.value.working.stale).toBe(true);
    expect(c.repo.lastSuccessfulRefresh).toBe(timestamp); expect(c.repo.error?.code).toBe('SNAPSHOT_FAILED');
  });
  it('discards late A metadata across an A → B → A activation, including action snapshots', async () => {
    const { controller: c, methods } = fixture(), waiting = deferred<RepositorySnapshot>();
    methods.snapshot.mockReturnValueOnce(waiting.promise);
    const old = c.openRepository(A); await settle(); const oldGeneration = c.repo.generation;
    await c.openRepository(B); await c.openRepository(A); const active = c.repo.snapshot;
    waiting.resolve(snapshot(repository(A, true), [changed('obsolete')]));
    expect(await old).toBe(false); expect(c.repo.snapshot).toBe(active);
    expect(c.applySnapshot(snapshot(repository(A, true), [changed('late-action')]), oldGeneration)).toBe(false);
    expect(await c.refreshAfterAction(repository(A).id, oldGeneration)).toBe(false);
    expect(c.repo.snapshot?.working.files).toEqual([]); expect(c.repo.current?.trusted).toBe(false);
  });
  it('prevents a superseded open completion from replacing the active native identity', async () => {
    const { controller: c, methods } = fixture(), waiting = deferred<Repository>();
    methods.openRepository.mockReturnValueOnce(waiting.promise);
    const old = c.openRepository(A); await c.openRepository(B); waiting.resolve(repository(A));
    expect(await old).toBe(false); expect(c.repo.current?.path).toBe(B);
    expect(methods.cancel).toHaveBeenCalled(); expect(methods.snapshot).toHaveBeenCalledTimes(1);
  });
  it('clears cancelled metadata loading when the replacement repository cannot be opened', async () => {
    const { controller: c, methods } = fixture(), waiting = deferred<RepositorySnapshot>();
    methods.snapshot.mockReturnValueOnce(waiting.promise);
    const old = c.openRepository(A); await settle(); expect(c.repo.refreshing).toBe(true);
    methods.openRepository.mockRejectedValueOnce(new Error('Replacement open failed.'));
    expect(await c.openRepository(B)).toBe(false); expect(c.repo.refreshing).toBe(false); expect(c.metadata.loading).toBe(false);
    expect(c.busy.value).toBe(false); expect(c.error.value?.message).toBe('Replacement open failed.');
    waiting.resolve(snapshot(repository(A))); expect(await old).toBe(false);
  });
  it('waits for deactivation before a new open and does not hide deactivation failure', async () => {
    const { controller: c, methods } = fixture(); await c.openRepository(A);
    const waiting = deferred<void>(); methods.deactivateRepository.mockReturnValueOnce(waiting.promise);
    const closing = c.closeRepository(), opening = c.openRepository(B); await settle();
    expect(c.repo.current).toBeNull(); expect(methods.openRepository).toHaveBeenCalledTimes(1);
    waiting.resolve(undefined); expect(await closing).toBe(true); expect(await opening).toBe(true);
    methods.deactivateRepository.mockRejectedValueOnce(new Error('Cannot release watcher.'));
    expect(await c.closeRepository()).toBe(false); expect(c.error.value?.message).toBe('Cannot release watcher.');
    expect(await c.openRepository(A)).toBe(false); expect(c.error.value?.code).toBe('DEACTIVATION_FAILED');
    expect(await c.closeRepository()).toBe(true); expect(await c.openRepository(A)).toBe(true);
  });
});

describe('history paging, query and intent', () => {
  it('uses native offsets while deduplicating overlapping pages', async () => {
    const { controller: c, methods } = fixture();
    methods.history.mockResolvedValueOnce({ commits: [commit(oid('a'))], hasMore: true })
      .mockResolvedValueOnce({ commits: [commit(oid('a')), commit(oid('b'))], hasMore: true })
      .mockResolvedValueOnce({ commits: [commit(oid('c'))], hasMore: false });
    await c.openRepository(A); expect(await c.loadMore()).toBe(true); expect(c.history.offset).toBe(3);
    expect(await c.loadMore()).toBe(true); expect(c.history.commits.map(item => item.oid)).toEqual([oid('a'), oid('b'), oid('c')]);
    expect(methods.history.mock.calls.map(([query]) => query.offset)).toEqual([0, 1, 3]);
    expect(c.history.hasMore).toBe(false);
  });
  it('cancels paging immediately, ignores late completion and does not resume from watcher events', async () => {
    vi.useFakeTimers();
    const { controller: c, methods, emitChange } = fixture(), waiting = deferred<HistoryPage>();
    await c.init(); methods.history.mockResolvedValueOnce({ commits: [commit()], hasMore: true }).mockReturnValueOnce(waiting.promise);
    await c.openRepository(A); const loading = c.loadMore(); await settle();
    const requestId = methods.history.mock.calls.at(-1)![0].requestId;
    await c.cancel(); expect(c.history.loading).toBe(false); expect(c.history.cancelled).toBe(true);
    expect(methods.cancel).toHaveBeenCalledWith(requestId);
    waiting.resolve({ commits: [commit(oid('b'))], hasMore: true }); expect(await loading).toBe(false);
    emitChange(repository(A).id); await vi.advanceTimersByTimeAsync(600); await settle();
    expect(methods.history).toHaveBeenCalledTimes(2); expect(c.history.commits).toHaveLength(1);
    expect(await c.loadMore()).toBe(false);
    expect(await c.refresh()).toBe(true); expect(c.history.cancelled).toBe(false); expect(methods.history).toHaveBeenCalledTimes(3);
  });
  it('applies loaded filtering without a host query and resets native search/order explicitly', async () => {
    const { controller: c, methods } = fixture();
    methods.history.mockResolvedValueOnce({ commits: [commit(oid('a')), commit(oid('b'))], hasMore: false });
    await c.openRepository(A);
    expect(await c.setQuery({ search: 'Commit b', searchMode: 'message' })).toBe(true);
    expect(methods.history).toHaveBeenCalledTimes(1); expect(c.visibleCommits.value.map(item => item.oid)).toEqual([oid('b')]);
    await c.setQuery({ queryMode: 'search' });
    expect(methods.history.mock.calls.at(-1)![0]).toMatchObject({ offset: 0, search: 'Commit b', searchMode: 'message' });
    await c.setQuery({ order: 'topo' }); expect(methods.history.mock.calls.at(-1)![0].order).toBe('topo');
  });
  it('discards an older query completion and does not let startup restore overwrite a newer selection', async () => {
    const state = defaultState(); state.views[repository(A).id] = { scope: { kind: 'all' }, search: '', searchMode: 'all',
      queryMode: 'filter', order: 'date', scrollTop: 0, selected: oid('c') };
    const { controller: c, methods } = fixture(state), waiting = deferred<HistoryPage>(); await c.init();
    methods.history.mockReturnValueOnce(waiting.promise); const opening = c.openRepository(A); await settle();
    c.select(oid('b')); waiting.resolve({ commits: [commit()], hasMore: false }); await opening;
    expect(c.history.selected).toBe(oid('b'));
    const first = deferred<HistoryPage>(); methods.history.mockReturnValueOnce(first.promise);
    const old = c.setQuery({ queryMode: 'search', search: 'old' }); await settle();
    await c.setQuery({ search: 'new' }); first.resolve({ commits: [commit(oid('d'))], hasMore: true });
    expect(await old).toBe(false); expect(c.history.query.search).toBe('new');
    expect(c.history.commits.map(item => item.oid)).not.toContain(oid('d'));
  });
  it('reveals a real full OID through paging and stops on a competing selection intent', async () => {
    const { controller: c, methods } = fixture();
    methods.history.mockResolvedValueOnce({ commits: [commit()], hasMore: true })
      .mockResolvedValueOnce({ commits: [commit(oid('b'))], hasMore: false });
    await c.openRepository(A); expect(await c.revealOid(oid('b'))).toBe(true); expect(c.history.selected).toBe(oid('b'));
    expect(c.reveal.value).toMatchObject({ oid: oid('b'), generation: c.repo.generation });
    const waiting = deferred<HistoryPage>(); c.history.hasMore = true; methods.history.mockReturnValueOnce(waiting.promise);
    const navigating = c.revealOid(oid('c')); await settle(); c.select(oid('a'));
    waiting.resolve({ commits: [commit(oid('c'))], hasMore: false });
    expect(await navigating).toBe(false); expect(c.history.selected).toBe(oid('a'));
    expect(await c.revealOid('HEAD')).toBe(false); expect(c.error.value?.code).toBe('INVALID_OID');
  });
  it('clears a saved advanced filter rather than restoring it on the next activation', async () => {
    const { controller: c } = fixture(); await c.openRepository(A);
    await c.setQuery({ filter: { author: 'obsolete author' } });
    expect(c.state.value.views[repository(A).id].filter?.author).toBe('obsolete author');
    await c.setQuery({ filter: undefined });
    expect(c.state.value.views[repository(A).id].filter?.author).toBeUndefined();
    await c.openRepository(B); await c.openRepository(A); expect(c.history.query.filter?.author).toBeUndefined();
  });
  it('does not override a selection made while reveal HEAD is resetting a native search', async () => {
    const { controller: c, methods } = fixture(); await c.openRepository(A);
    await c.setQuery({ queryMode: 'search', search: 'old query' });
    const waiting = deferred<HistoryPage>(); methods.history.mockReturnValueOnce(waiting.promise);
    const revealing = c.revealHead(); await settle(); c.select(oid('b'));
    waiting.resolve({ commits: [commit()], hasMore: false });
    expect(await revealing).toBe(false); expect(c.history.selected).toBe(oid('b'));
  });
  it('keeps load failures explicit and prevents zero-length hasMore loops', async () => {
    const { controller: c, methods } = fixture();
    methods.history.mockRejectedValueOnce({ code: 'HISTORY_FAILED', message: 'No history.' });
    expect(await c.openRepository(A)).toBe(false); expect(c.history.ready).toBe(false);
    expect(c.history.error?.code).toBe('HISTORY_FAILED'); expect(c.history.cancelled).toBe(true);
    methods.history.mockResolvedValueOnce({ commits: [], hasMore: true });
    expect(await c.refresh()).toBe(true); expect(c.history.hasMore).toBe(false);
  });
});

describe('directory discovery and read-only summaries', () => {
  it('restores the saved directory depth and never activates every repository for metadata', async () => {
    const state = defaultState(); state.settings.discoveryDepth = 1;
    state.directoryScope = { root: ROOT, depth: 4, width: 410, collapsed: false, collapsedPaths: [] };
    const { controller: c, methods } = fixture(state); await c.init();
    expect(methods.discoverRepositories).toHaveBeenCalledWith(ROOT, 4, expect.any(String));
    expect(methods.openRepository).not.toHaveBeenCalled(); expect(methods.probeRepository).not.toHaveBeenCalled();
    c.setVisibleCandidates([candidate(A)]); await settle();
    expect(methods.probeRepository).toHaveBeenCalledTimes(1); expect(c.summaries.value.get(A)?.summary?.changes).toBeNull();
    expect(await c.selectRepository(candidate(A))).toBe(true);
    expect(methods.openRepository).toHaveBeenCalledExactlyOnceWith(A, expect.any(String), ROOT);
    await c.openDirectory(ROOT); expect(methods.discoverRepositories.mock.calls.at(-1)![1]).toBe(4);
    expect(methods.openRepository).toHaveBeenCalledTimes(1);
  });
  it('uses global saved depth for a new directory picker instead of a hard-coded depth', async () => {
    const state = defaultState(); state.settings.discoveryDepth = 3;
    const { controller: c, methods } = fixture(state); await c.init(); methods.pickRepository.mockResolvedValueOnce(ROOT);
    expect(await c.pickDirectory()).toBe(true); expect(methods.pickRepository).toHaveBeenCalledWith('directory');
    expect(methods.discoverRepositories).toHaveBeenCalledWith(ROOT, 3, expect.any(String));
  });
  it('serializes superseded scans, reports cancellation and rejects stale candidates', async () => {
    const { controller: c, methods } = fixture(), waiting = deferred<RepositoryDiscovery>();
    methods.discoverRepositories.mockReturnValueOnce(waiting.promise);
    const first = c.openDirectory(ROOT, 2); const second = c.openDirectory(ROOT, 3); await settle();
    expect(methods.discoverRepositories).toHaveBeenCalledTimes(1); expect(methods.cancel).toHaveBeenCalled();
    waiting.resolve(discovery([A])); expect(await first).toBe(false); expect(await second).toBe(true);
    expect(c.directory.scope?.depth).toBe(3); expect(methods.openRepository).not.toHaveBeenCalled();
    expect(await c.selectRepository({ ...candidate(A), components: ['different'] })).toBe(false);
    expect(c.error.value?.code).toBe('STALE_REPOSITORY_CANDIDATE');
    const pending = deferred<RepositoryDiscovery>(); methods.discoverRepositories.mockReturnValueOnce(pending.promise);
    const cancelled = c.openDirectory(ROOT, 5); await c.cancel('directory'); pending.resolve(discovery([A]));
    expect(await cancelled).toBe(false); expect(c.directory.cancelled).toBe(true); expect(c.directory.scope?.depth).toBe(3);
  });
  it('does not auto-activate an incomplete sole result or fabricate success after scan failure', async () => {
    const { controller: c, methods } = fixture(); methods.discoverRepositories.mockResolvedValueOnce(discovery([A], false));
    expect(await c.openDirectory(ROOT, 1)).toBe(true); expect(methods.openRepository).not.toHaveBeenCalled();
    methods.discoverRepositories.mockRejectedValueOnce({ code: 'SCAN_FAILED', message: 'Cannot scan fixture.' });
    expect(await c.openDirectory(ROOT, 2)).toBe(false); expect(c.directory.error?.code).toBe('SCAN_FAILED');
    expect(c.directory.discovery?.complete).toBe(false); expect(c.directory.loading).toBe(false);
  });
  it('auto-activates only a complete sole or remembered candidate, not a background repository fan-out', async () => {
    const { controller: c, methods } = fixture(); methods.discoverRepositories.mockResolvedValueOnce(discovery([A]));
    expect(await c.openDirectory(ROOT, 2)).toBe(true); expect(methods.openRepository).toHaveBeenCalledTimes(1);
    expect(c.repo.current?.path).toBe(A); expect(c.directory.scope?.root).toBe(ROOT);
    expect(await c.closeDirectory()).toBe(true); expect(c.directory.scope).toBeNull(); expect(c.repo.current).toBeNull();
  });
  it('does not let a pending discovery auto-open after the user closes the workspace', async () => {
    const { controller: c, methods } = fixture(), waiting = deferred<RepositoryDiscovery>();
    methods.discoverRepositories.mockReturnValueOnce(waiting.promise);
    const scanning = c.openDirectory(ROOT, 2); expect(await c.closeRepository()).toBe(true);
    waiting.resolve(discovery([A])); expect(await scanning).toBe(false);
    expect(methods.openRepository).not.toHaveBeenCalled(); expect(c.repo.current).toBeNull();
  });
  it('ignores late picker results after a newer explicit intent', async () => {
    const { controller: c, methods } = fixture(), waiting = deferred<string | null>(); methods.pickRepository.mockReturnValueOnce(waiting.promise);
    const picker = c.pickRepository(); await c.openRepository(A); waiting.resolve(B);
    expect(await picker).toBe(false); expect(c.repo.current?.path).toBe(A); expect(methods.openRepository).toHaveBeenCalledTimes(1);
  });
});

describe('watcher, trust and action integration', () => {
  it('coalesces active watcher bursts, ignores inactive events and exposes actual external session states', async () => {
    vi.useFakeTimers();
    const { controller: c, methods, emitChange, emitSession } = fixture(); await c.init(); await c.openRepository(A);
    emitChange(repository(B).id); await vi.advanceTimersByTimeAsync(600); expect(methods.snapshot).toHaveBeenCalledTimes(1);
    emitChange(repository(A).id); emitChange(repository(A).id); emitChange(repository(A).id);
    await vi.advanceTimersByTimeAsync(600); await settle(); expect(methods.snapshot).toHaveBeenCalledTimes(2);
    expect(methods.onRepositoryChanged).toHaveBeenCalledOnce();
    emitSession({ id: 'session-a', repoId: repository(A).id, kind: 'rebase', status: 'paused', exitCode: null, operation: 'rebase', message: '' });
    await settle(); expect(c.status.value.sessions[0].status).toBe('paused'); expect(c.status.value.taskState).toBe('paused');
  });
  it('does not trust implicitly and reports a rejected explicit trust decision', async () => {
    const { controller: c, methods } = fixture(); await c.openRepository(A); expect(methods.trustRepository).not.toHaveBeenCalled();
    methods.trustRepository.mockRejectedValueOnce({ code: 'TRUST_FAILED', message: 'Trust decision rejected.' });
    expect(await c.setTrust(true)).toBe(false); expect(c.repo.current?.trusted).toBe(false); expect(c.error.value?.code).toBe('TRUST_FAILED');
    expect(await c.setTrust(true)).toBe(true); expect(c.repo.current?.trusted).toBe(true); expect(c.working.value).not.toBeNull();
    expect(await c.setTrust(false)).toBe(true); expect(c.repo.current?.trusted).toBe(false); expect(c.working.value).toBeNull();
  });
  it('blocks switching during writes and refreshes only a generation-matched action completion', async () => {
    const { controller: c, methods } = fixture(); await c.openRepository(A); c.setActionBusy(true);
    expect(await c.openRepository(B)).toBe(false); expect(await c.closeRepository()).toBe(false);
    expect(c.error.value?.code).toBe('WORKSPACE_BUSY'); c.setActionBusy(false);
    const generation = c.repo.generation; expect(await c.refreshAfterAction(repository(A).id, generation)).toBe(true);
    expect(methods.snapshot).toHaveBeenCalledTimes(2); expect(await c.refreshAfterAction(repository(A).id, generation - 1)).toBe(false);
  });
  it('surfaces cancellation transport failures rather than silently swallowing them', async () => {
    const { controller: c, methods } = fixture(), waiting = deferred<HistoryPage>();
    methods.history.mockReturnValueOnce(waiting.promise); const opening = c.openRepository(A); await settle();
    methods.cancel.mockRejectedValueOnce({ code: 'CANCEL_FAILED', message: 'Cancel transport failed.' });
    await c.cancel('history'); await settle(); expect(c.error.value?.code).toBe('CANCEL_FAILED');
    waiting.resolve({ commits: [], hasMore: false }); await opening;
  });
});

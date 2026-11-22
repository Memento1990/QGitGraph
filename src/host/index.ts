import type {
  ActionResult, ArchiveQuery, ChangedFile, CommitDetail, ComparisonQuery, ConfigImport,
  Containment, Diagnostics, DiffQuery, DiffResult, ExternalSession, GitAction, GitRef, GithubUpdateInfo,
  HistoryPage, HistoryQuery, Host, NativePerformanceData, PersistedState, Remote, RepoConfig, Repository,
  RepositorySnapshot, Stash, StashDetail, SubmoduleInfo, TagDetail, VerificationResult,
  VerifyQuery, WorkingState,
} from '../shared/protocol';
import { defaultState } from '../shared/protocol';
import { configurePerformance, performanceDiagnostics as perf } from '../lib/performance';

export class DesktopHost implements Host {
  private performanceCollection: Promise<void> | undefined;
  private performanceDirty = false;
  private async invoke<T>(name: string, args?: Record<string, unknown>): Promise<T> {
    const query = args?.query as { requestId?: string } | undefined, action = args?.action as { requestId?: string } | undefined;
    const requestId = typeof args?.requestId === 'string' ? args.requestId : query?.requestId ?? action?.requestId;
    const span = perf.span('ipc', name, { requestId }, perf.context(requestId));
    let outcome: 'ok' | 'error' = 'error';
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<T>(name, args); outcome = 'ok'; return result;
    } finally {
      span.end({ outcome });
      if (name !== 'get_performance_data' && perf.isEnabled) this.collectPerformance();
    }
  }
  private collectPerformance(): void {
    this.performanceDirty = true;
    if (this.performanceCollection) return;
    // Coalesce parallel completions; do not await diagnostics on any product/UI critical path.
    this.performanceCollection = Promise.resolve().then(async () => {
      do {
        this.performanceDirty = false;
        try { perf.setNative(await this.getPerformanceData()); } catch { /* Supplemental diagnostics must never change product error handling. */ }
      } while (this.performanceDirty);
    }).finally(() => { this.performanceCollection = undefined; if (this.performanceDirty) this.collectPerformance(); });
  }
  async diagnostics() {
    const value = await this.invoke<Diagnostics>('diagnostics'); configurePerformance(value.performanceEnabled);
    if (value.performanceEnabled) this.collectPerformance(); return value;
  }
  checkForUpdates() { return this.invoke<GithubUpdateInfo>('check_for_updates'); }
  getPerformanceData(clear = false) { return this.invoke<NativePerformanceData>('get_performance_data', { clear }); }
  loadState() { return this.invoke<PersistedState>('load_state'); }
  saveState(value: PersistedState) { return this.invoke<void>('save_state', { value }); }
  pickRepository() { return this.invoke<string | null>('pick_repository'); }
  openRepository(path: string) { return this.invoke<Repository>('open_repository', { path }); }
  trustRepository(repoId: string, trusted: boolean) { return this.invoke<void>('trust_repository', { repoId, trusted }); }
  discoverRepositories(path: string, depth: number) { return this.invoke<string[]>('discover_repositories', { path, depth }); }
  snapshot(repoId: string, requestId: string) { return this.invoke<RepositorySnapshot>('get_snapshot', { repoId, requestId }); }
  refs(repoId: string, requestId: string) { return this.invoke<GitRef[]>('get_refs', { repoId, requestId }); }
  history(query: HistoryQuery) { return this.invoke<HistoryPage>('get_history', { query }); }
  workingState(repoId: string, requestId: string) { return this.invoke<WorkingState>('get_working_state', { repoId, requestId }); }
  commitDetail(repoId: string, oid: string, requestId: string, parent?: string) { return this.invoke<CommitDetail>('get_commit_detail', { repoId, oid, requestId, parent }); }
  compare(query: ComparisonQuery) { return this.invoke<ChangedFile[]>('compare_commits', { query }); }
  diff(query: DiffQuery) { return this.invoke<DiffResult>('get_diff', { query }); }
  diffPatch(query: DiffQuery) { return this.invoke<DiffResult>('get_diff_patch', { query }); }
  fileContent(query: DiffQuery, side: 'old' | 'new') { return this.invoke<DiffResult>('get_file_content', { query, side }); }
  stashes(repoId: string, requestId: string) { return this.invoke<Stash[]>('get_stashes', { repoId, requestId }); }
  stashDetail(repoId: string, selector: string, requestId: string) { return this.invoke<StashDetail>('get_stash_detail', { repoId, selector, requestId }); }
  tagDetail(repoId: string, target: string, requestId: string) { return this.invoke<TagDetail>('get_tag_detail', { repoId, target, requestId }); }
  containment(repoId: string, oid: string, requestId: string) { return this.invoke<Containment>('get_containment', { repoId, oid, requestId }); }
  submodules(repoId: string, requestId: string) { return this.invoke<SubmoduleInfo[]>('get_submodules', { repoId, requestId }); }
  remotes(repoId: string, requestId: string) { return this.invoke<Remote[]>('get_remotes', { repoId, requestId }); }
  repoConfig(repoId: string, requestId: string) { return this.invoke<RepoConfig>('get_repo_config', { repoId, requestId }); }
  action(action: GitAction) { return this.invoke<ActionResult>('git_action', { action }); }
  verify(query: VerifyQuery) { return this.invoke<VerificationResult>('verify_signature', { query }); }
  archive(query: ArchiveQuery) { return this.invoke<boolean>('archive_ref', { query }); }
  cancel(requestId: string) { return this.invoke<void>('cancel_request', { requestId }); }
  openTerminal(repoId: string) { return this.invoke<void>('open_terminal', { repoId }); }
  openEditor(repoId: string, path: string) { return this.invoke<void>('open_editor', { repoId, path }); }
  openSnapshot(query: DiffQuery, side: 'old' | 'new') { return this.invoke<void>('open_snapshot', { query, side }); }
  externalDiff(query: DiffQuery) { return this.invoke<void>('external_diff', { query }); }
  openUrl(url: string) { return this.invoke<void>('open_url', { url }); }
  copy(text: string) { return this.invoke<void>('copy_text', { text }); }
  exportConfig(repoId: string | null) { return this.invoke<boolean>('export_config', { repoId }); }
  importConfig() { return this.invoke<ConfigImport | null>('import_config'); }
  async onRepositoryChanged(callback: (repoId: string) => void) {
    const { listen } = await import('@tauri-apps/api/event'); return listen<string>('repository-changed', event => callback(event.payload));
  }
  async onExternalSession(callback: (session: ExternalSession) => void) {
    const { listen } = await import('@tauri-apps/api/event'); return listen<ExternalSession>('external-session', event => callback(event.payload));
  }
}

class BrowserHost implements Host {
  private state = defaultState();
  diagnostics(): Promise<Diagnostics> { return Promise.resolve({ appVersion: '0.2.2', gitVersion: null, gitPath: null, platform: 'browser · desktop host required' }); }
  checkForUpdates(): Promise<GithubUpdateInfo> { return Promise.resolve({ status: 'unsupported', currentVersion: '0.2.2', latestVersion: null, releaseTag: null, releaseUrl: null, publishedAt: null, releaseNotes: null, notesTruncated: false }); }
  loadState() { return Promise.resolve(structuredClone(this.state)); }
  saveState(value: PersistedState) { this.state = structuredClone(value); return Promise.resolve(); }
  protected unavailable(): never { throw { code: 'DESKTOP_REQUIRED', message: 'Open the QGitGraph desktop application to access local Git repositories. The browser preview cannot read your filesystem.' }; }
  async pickRepository(): Promise<string | null> { return this.unavailable(); }
  async openRepository(_path: string): Promise<Repository> { return this.unavailable(); }
  async trustRepository(_repoId: string, _trusted: boolean): Promise<void> { return this.unavailable(); }
  async discoverRepositories(_path: string, _depth: number): Promise<string[]> { return this.unavailable(); }
  async snapshot(_repoId: string, _requestId: string): Promise<RepositorySnapshot> { return this.unavailable(); }
  async refs(_repoId: string, _requestId: string): Promise<GitRef[]> { return this.unavailable(); }
  async history(_query: HistoryQuery): Promise<HistoryPage> { return this.unavailable(); }
  async workingState(_repoId: string, _requestId: string): Promise<WorkingState> { return this.unavailable(); }
  async commitDetail(_repoId: string, _oid: string, _requestId: string, _parent?: string): Promise<CommitDetail> { return this.unavailable(); }
  async compare(_query: ComparisonQuery): Promise<ChangedFile[]> { return this.unavailable(); }
  async diff(_query: DiffQuery): Promise<DiffResult> { return this.unavailable(); }
  async stashes(_repoId: string, _requestId: string): Promise<Stash[]> { return this.unavailable(); }
  async stashDetail(_repoId: string, _selector: string, _requestId: string): Promise<StashDetail> { return this.unavailable(); }
  async tagDetail(_repoId: string, _target: string, _requestId: string): Promise<TagDetail> { return this.unavailable(); }
  async containment(_repoId: string, _oid: string, _requestId: string): Promise<Containment> { return this.unavailable(); }
  async submodules(_repoId: string, _requestId: string): Promise<SubmoduleInfo[]> { return this.unavailable(); }
  async remotes(_repoId: string, _requestId: string): Promise<Remote[]> { return this.unavailable(); }
  async repoConfig(_repoId: string, _requestId: string): Promise<RepoConfig> { return this.unavailable(); }
  async action(_action: GitAction): Promise<ActionResult> { return this.unavailable(); }
  async verify(_query: VerifyQuery): Promise<VerificationResult> { return this.unavailable(); }
  async archive(_query: ArchiveQuery): Promise<boolean> { return this.unavailable(); }
  cancel(_requestId: string) { return Promise.resolve(); }
  async openTerminal(_repoId: string): Promise<void> { return this.unavailable(); }
  async openEditor(_repoId: string, _path: string): Promise<void> { return this.unavailable(); }
  async openSnapshot(_query: DiffQuery, _side: 'old' | 'new'): Promise<void> { return this.unavailable(); }
  async externalDiff(_query: DiffQuery): Promise<void> { return this.unavailable(); }
  async openUrl(_url: string): Promise<void> { return this.unavailable(); }
  async copy(text: string) { await navigator.clipboard.writeText(text); }
  async exportConfig(_repoId: string | null): Promise<boolean> { return this.unavailable(); }
  async importConfig(): Promise<ConfigImport | null> { return this.unavailable(); }
  onRepositoryChanged(_callback: (repoId: string) => void) { return Promise.resolve(() => {}); }
  onExternalSession(_callback: (session: ExternalSession) => void) { return Promise.resolve(() => {}); }
}

export async function createHost(): Promise<Host> {
  if ('__TAURI_INTERNALS__' in window) return new DesktopHost();
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('demo')) { const { DemoHost } = await import('./demo'); return new DemoHost(); }
  return new BrowserHost();
}

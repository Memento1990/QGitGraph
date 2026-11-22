export interface Repository {
  id: string; path: string; name: string; gitDir: string; commonDir: string;
  head: string | null; branch: string | null; trusted: boolean; bare: boolean;
}

export interface GitRef {
  name: string; fullName: string; oid: string;
  kind: 'branch' | 'remote' | 'tag' | 'stash';
  upstream: string | null; current: boolean; subject: string;
}

export interface Commit {
  oid: string; parents: string[]; author: string; email: string;
  authoredAt: number; committedAt: number; subject: string; refs: GitRef[];
  graphParents?: string[];
  nodeKind?: 'commit' | 'stash';
  inHead?: boolean;
}

export interface BranchGroup { name: string; include: string[]; exclude: string[] }
export interface HistoryScope {
  kind: 'all' | 'head' | 'refs' | 'glob';
  refs?: string[]; include?: string[]; exclude?: string[];
}
export interface HistoryQuery {
  repoId: string; requestId: string; offset: number; limit: number;
  revision?: string; scope?: HistoryScope; search?: string;
  searchMode?: 'all' | 'message' | 'author' | 'hash' | 'date' | 'refs';
  order?: 'topo' | 'date' | 'author-date';
  firstParent?: boolean; includeReflog?: boolean; showRemotes?: boolean;
  showTags?: boolean; showStashes?: boolean; mailmap?: boolean;
  includeTagOnly?: boolean; showRemoteHeads?: boolean; collapseStashAuxiliary?: boolean;
  markHeadAncestry?: boolean;
}
export interface HistoryPage { commits: Commit[]; hasMore: boolean }

export interface ChangedFile {
  path: string; oldPath: string | null; status: string;
  additions: number | null; deletions: number | null; staged: boolean; unstaged: boolean;
  submodule?: { commitChanged: boolean; modified: boolean; untracked: boolean };
}
export interface WorkingState {
  files: ChangedFile[]; branch: string | null; ahead: number; behind: number;
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null; conflicts: number;
  head?: string | null;
}
export interface RepositorySnapshot {
  repository: Repository; refs: GitRef[]; working: WorkingState; stashes: Stash[]; remotes: Remote[];
  fingerprint: string;
}
export interface Signature { status: string; signer: string; key: string }
export interface CommitDetail {
  commit: Commit; body: string; committer: string; committerEmail: string;
  signature: Signature; files: ChangedFile[]; base: string | null;
}
export interface ComparisonQuery { repoId: string; requestId: string; base: string | null; target: string }
export interface DiffQuery extends ComparisonQuery {
  path: string; oldPath?: string; context?: number; encoding?: string; staged?: boolean;
}
export interface DiffResult {
  patch: string; binary: boolean; truncated: boolean;
  oldContent: string | null; newContent: string | null;
}
export interface Stash { selector: string; oid: string; message: string; timestamp: number }
export interface StashDetail {
  selector: string; oid: string; base: string; index: string; untracked: string | null;
  message: string; timestamp: number;
}
export interface TagDetail {
  name: string; ref: string; oid: string; targetOid: string; targetType: string;
  annotated: boolean; tagger: string; email: string; timestamp: number | null;
  message: string; signature: Signature;
}
export interface Containment { oid: string; head: boolean; refs: GitRef[] }
export interface SubmoduleInfo {
  path: string; name: string; url: string; initialized: boolean; head: string | null;
  indexOid: string | null; modified: boolean; untracked: boolean;
}
export interface Remote { name: string; fetchUrl: string; pushUrl: string }
export interface RepoConfig {
  userName: string; userEmail: string; globalUserName: string; globalUserEmail: string;
  signingKey: string; signCommits: boolean;
}
export interface VerifyQuery { repoId: string; requestId: string; kind: 'commit' | 'tag'; target: string }
export interface VerificationResult {
  kind: 'commit' | 'tag'; oid: string;
  status: 'valid' | 'invalid' | 'unknown-key' | 'untrusted' | 'expired' | 'revoked' | 'unsigned' | 'unavailable' | 'error';
  signer: string; key: string; output: string;
}
export interface ExternalSession {
  id: string; repoId: string; kind: string;
  status: 'started' | 'running' | 'paused' | 'failed' | 'completed';
  exitCode: number | null; operation: string | null; message: string;
}

export type ActionKind =
  | 'branch-create' | 'branch-rename' | 'branch-delete' | 'checkout'
  | 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'drop' | 'reset'
  | 'tag-create' | 'tag-delete' | 'tag-push'
  | 'stash-save' | 'stash-apply' | 'stash-pop' | 'stash-drop' | 'stash-branch'
  | 'fetch' | 'pull' | 'push' | 'remote-add' | 'remote-edit' | 'remote-remove' | 'prune'
  | 'set-upstream' | 'clean' | 'continue' | 'abort' | 'commit' | 'identity'
  | 'remote-branch-delete' | 'fetch-into' | 'checkout-remote';
export interface GitAction {
  repoId: string; requestId: string; kind: ActionKind;
  target?: string; name?: string; remote?: string; branch?: string; url?: string;
  message?: string; email?: string; mode?: string; force?: boolean;
  noCommit?: boolean; noFastForward?: boolean; squash?: boolean; sign?: boolean;
  includeUntracked?: boolean; includeIgnored?: boolean; global?: boolean;
  interactive?: boolean; setUpstream?: boolean;
  checkoutAfter?: boolean; tagType?: 'lightweight' | 'annotated'; pushAfter?: boolean;
  reinstateIndex?: boolean; recordOrigin?: boolean; ignoreDate?: boolean;
  prune?: boolean; pruneTags?: boolean; preserveMerges?: boolean;
  squashMessage?: 'default' | 'summary';
}
export interface ActionResult {
  output: string; operation: string | null;
  sessionId?: string; status?: 'started' | 'completed';
}
export interface ArchiveQuery {
  repoId: string; requestId: string; target: string; format: 'zip' | 'tar'; prefix?: string;
}
export type SignaturePolicy = 'git' | 'sign' | 'no-sign';
export interface DialogDefaults {
  tagType: 'lightweight' | 'annotated'; tagPush: boolean; reinstateIndex: boolean;
  recordOrigin: boolean; noCommit: boolean; checkoutAfterCreate: boolean;
  forceDelete: boolean; forceFetch: boolean; fetchPrune: boolean; fetchPruneTags: boolean;
  mergeNoFastForward: boolean; mergeNoCommit: boolean; mergeSquash: boolean;
  pullMode: 'ff-only' | 'merge' | 'rebase'; pullNoFastForward: boolean; pullSquash: boolean;
  squashMessage: 'default' | 'summary'; rebaseIgnoreDate: boolean; rebaseInteractive: boolean;
  rebasePreserveMerges: boolean; resetMode: 'soft' | 'mixed' | 'hard' | 'keep';
  worktreeResetMode: 'mixed' | 'hard'; stashIncludeUntracked: boolean;
}
export interface IssueRule { pattern: string; url: string }
export interface PullRequestProvider {
  name: string; host: string; url: string;
}
export interface ToolProfile { executable: string; args: string[] }
export interface AppSettings {
  theme: 'dark' | 'light' | 'system'; detailPosition: 'inline' | 'bottom' | 'right';
  diffView: 'unified' | 'split'; graphStyle: 'curved' | 'angular';
  dateFormat: 'relative' | 'iso' | 'local' | 'date' | 'iso-date'; dateSource: 'author' | 'committer';
  pageSize: number; initialLoad: number; loadMore: number; order: 'topo' | 'date' | 'author-date';
  rowHeight: number; fontSize: number; graphColors: string[];
  showRemotes: boolean; showTags: boolean; showStashes: boolean; showRemoteHeads: boolean;
  showUncommitted: boolean; showUntracked: boolean; includeTagOnly: boolean;
  collapseStashAuxiliary: boolean; firstParent: boolean; includeReflog: boolean; autoLoad: boolean;
  compactFolders: boolean; fileView: 'tree' | 'list'; avatars: boolean; mailmap: boolean;
  encoding: string; gitPath: string; editorPath: string; terminalPath: string;
  editorArgs: string[]; terminalArgs: string[]; issueUrl: string; pullRequestUrl: string;
  issueRules: IssueRule[]; pullRequestProviders: PullRequestProvider[];
  markdown: boolean; emoji: boolean; customEmoji: Record<string, string>;
  branchGroups: BranchGroup[]; startupScope: HistoryScope; scrollToHead: boolean;
  autoCenterDetails: boolean; muteMerges: boolean; muteNonAncestors: boolean;
  labelAlignment: 'normal' | 'branches' | 'right'; combineLabels: boolean;
  uncommittedStyle: 'open' | 'filled'; signatureDisplay: boolean;
  commitSigning: SignaturePolicy; tagSigning: SignaturePolicy;
  repositorySort: 'recent' | 'name' | 'path'; discoveryDepth: number;
  referenceSpace: 'none' | 'hyphen' | 'underscore';
  shortcuts: { find: string; refresh: string; head: string; stash: string };
  dialogDefaults: DialogDefaults;
  contextActions: Record<string, string[]>;
  columns: { date: boolean; author: boolean; commit: boolean };
  columnWidths: { graph: number; date: number; author: number; commit: number };
  hiddenActions: string[]; defaultRemote: string; confirmCheckout: boolean;
}
export type SettingsPatch = {
  [K in keyof AppSettings]?: AppSettings[K] extends Array<unknown> ? AppSettings[K]
    : AppSettings[K] extends object ? Partial<AppSettings[K]> : AppSettings[K];
};
export interface ReviewTarget { kind: 'commit' | 'compare'; oid?: string; base?: string; target?: string; parent?: string }
export interface ReviewSession {
  key: string; repoId: string; paths: string[]; updatedAt: number;
  selection?: ReviewTarget; startedAt?: number; active?: boolean;
}
export interface ViewState {
  scope: HistoryScope; search: string; searchMode: string; queryMode: 'filter' | 'search';
  order: 'topo' | 'date' | 'author-date'; scrollTop: number; selected: string | null;
  detail?: { selection: ReviewTarget | { kind: 'working' }; path?: string; scrollTop?: number };
  filter?: Record<string, string>; collapsed?: string[];
}
export interface PersistedState {
  version: number; recent: { path: string; name: string }[]; lastRepo: string | null;
  trusted: string[]; settings: AppSettings; repoSettings: Record<string, SettingsPatch>;
  reviews: ReviewSession[]; layout: { detailSize: number; fileSize: number };
  views: Record<string, ViewState>;
}
export interface ConfigImport { version: number; settings: SettingsPatch; warnings: string[] }
export interface Diagnostics {
  appVersion: string; gitVersion: string | null; gitPath: string | null; platform: string;
  configDirectory?: string; warnings?: string[]; performanceEnabled?: boolean;
}
export interface GithubUpdateInfo {
  status: 'available' | 'current' | 'no-release' | 'unsupported';
  currentVersion: string;
  latestVersion: string | null;
  releaseTag: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  releaseNotes: string | null;
  notesTruncated: boolean;
}
export interface NativePerformanceSpan {
  id: number; sequence: number; requestId: string; phase: string; verb: string;
  startedAt: number; durationMs: number; outcome: string;
  stdoutBytes?: number; stderrBytes?: number; status?: number;
}
export interface NativePerformanceData {
  schemaVersion: number; enabled: boolean; capacity: number; sequence: number; dropped: number;
  spans: NativePerformanceSpan[];
  active: { id: number; requestId: string; phase: string; verb: string; startedAt: number; elapsedMs: number }[];
}
export interface AppError { code: string; message: string; detail?: string }

export interface Host {
  diagnostics(): Promise<Diagnostics>;
  /** Manual check of this application's fixed public GitHub release source. */
  checkForUpdates(): Promise<GithubUpdateInfo>;
  /** Opt-in in-memory native diagnostics only; absent in browser/demo hosts. */
  getPerformanceData?(clear?: boolean): Promise<NativePerformanceData>;
  loadState(): Promise<PersistedState>; saveState(state: PersistedState): Promise<void>;
  pickRepository(): Promise<string | null>; openRepository(path: string): Promise<Repository>;
  trustRepository(repoId: string, trusted: boolean): Promise<void>;
  discoverRepositories(path: string, depth: number): Promise<string[]>;
  snapshot(repoId: string, requestId: string): Promise<RepositorySnapshot>;
  refs(repoId: string, requestId: string): Promise<GitRef[]>;
  history(query: HistoryQuery): Promise<HistoryPage>;
  workingState(repoId: string, requestId: string): Promise<WorkingState>;
  commitDetail(repoId: string, oid: string, requestId: string, parent?: string): Promise<CommitDetail>;
  compare(query: ComparisonQuery): Promise<ChangedFile[]>; diff(query: DiffQuery): Promise<DiffResult>;
  /** Patch-first and lazy one-side text paths. Legacy hosts may expose only diff(). */
  diffPatch?(query: DiffQuery): Promise<DiffResult>;
  fileContent?(query: DiffQuery, side: 'old' | 'new'): Promise<DiffResult>;
  stashes(repoId: string, requestId: string): Promise<Stash[]>;
  stashDetail(repoId: string, selector: string, requestId: string): Promise<StashDetail>;
  tagDetail(repoId: string, target: string, requestId: string): Promise<TagDetail>;
  containment(repoId: string, oid: string, requestId: string): Promise<Containment>;
  submodules(repoId: string, requestId: string): Promise<SubmoduleInfo[]>;
  remotes(repoId: string, requestId: string): Promise<Remote[]>;
  repoConfig(repoId: string, requestId: string): Promise<RepoConfig>;
  action(action: GitAction): Promise<ActionResult>;
  verify(query: VerifyQuery): Promise<VerificationResult>;
  archive(query: ArchiveQuery): Promise<boolean>;
  cancel(requestId: string): Promise<void>;
  openTerminal(repoId: string): Promise<void>; openEditor(repoId: string, path: string): Promise<void>;
  openSnapshot(query: DiffQuery, side: 'old' | 'new'): Promise<void>;
  externalDiff(query: DiffQuery): Promise<void>; openUrl(url: string): Promise<void>; copy(text: string): Promise<void>;
  exportConfig(repoId: string | null): Promise<boolean>; importConfig(): Promise<ConfigImport | null>;
  onRepositoryChanged(callback: (repoId: string) => void): Promise<() => void>;
  onExternalSession(callback: (session: ExternalSession) => void): Promise<() => void>;
}
export const DEFAULT_DIALOGS: DialogDefaults = {
  tagType: 'annotated', tagPush: false, reinstateIndex: false, recordOrigin: false,
  noCommit: false, checkoutAfterCreate: false, forceDelete: false, forceFetch: false,
  fetchPrune: false, fetchPruneTags: false, mergeNoFastForward: true,
  mergeNoCommit: false, mergeSquash: false, pullMode: 'merge', pullNoFastForward: false,
  pullSquash: false, squashMessage: 'default', rebaseIgnoreDate: true,
  rebaseInteractive: false, rebasePreserveMerges: false, resetMode: 'mixed',
  worktreeResetMode: 'mixed', stashIncludeUntracked: true,
};
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark', detailPosition: 'inline', diffView: 'unified', graphStyle: 'curved',
  dateFormat: 'local', dateSource: 'author', pageSize: 300, initialLoad: 300, loadMore: 100,
  order: 'date', rowHeight: 28, fontSize: 13,
  graphColors: ['#80b8e5', '#d4a5d9', '#9bc487', '#d9b678', '#74c2bd', '#e09696', '#9caced', '#c4c787'],
  showRemotes: true, showTags: true, showStashes: true, showRemoteHeads: false,
  showUncommitted: true, showUntracked: true, includeTagOnly: true, collapseStashAuxiliary: true,
  firstParent: false, includeReflog: false, autoLoad: true, compactFolders: true, fileView: 'tree',
  avatars: false, mailmap: false, encoding: 'utf-8', gitPath: '', editorPath: '', terminalPath: '',
  editorArgs: ['{file}'], terminalArgs: [], issueUrl: '', pullRequestUrl: '', issueRules: [],
  pullRequestProviders: [], markdown: false, emoji: true, customEmoji: {}, branchGroups: [],
  startupScope: { kind: 'all' }, scrollToHead: false, autoCenterDetails: true,
  muteMerges: true, muteNonAncestors: false, labelAlignment: 'normal', combineLabels: true,
  uncommittedStyle: 'open', signatureDisplay: false, commitSigning: 'git', tagSigning: 'git',
  repositorySort: 'recent', discoveryDepth: 0, referenceSpace: 'none',
  shortcuts: { find: 'Ctrl+F', refresh: 'Ctrl+R', head: 'Ctrl+H', stash: 'Ctrl+S' },
  dialogDefaults: { ...DEFAULT_DIALOGS }, contextActions: {},
  columns: { date: true, author: true, commit: true },
  columnWidths: { graph: 144, date: 154, author: 150, commit: 92 },
  hiddenActions: [], defaultRemote: 'origin', confirmCheckout: true,
};
export function defaultState(): PersistedState {
  return { version: 2, recent: [], lastRepo: null, trusted: [],
    settings: structuredClone(DEFAULT_SETTINGS), repoSettings: {}, reviews: [],
    layout: { detailSize: 360, fileSize: 260 }, views: {} };
}

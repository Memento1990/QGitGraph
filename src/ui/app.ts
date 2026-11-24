import type {
  ActionKind, ActionResult, AppSettings, Commit, Containment, Diagnostics, DirectoryScopeState, ExternalSession, GitAction, GitRef, HistoryQuery,
  HistoryScope, Host, Remote, Repository, RepositoryCandidate, RepositoryDiscovery, RepositorySnapshot, Stash, ViewState, WorkingAction, WorkingState,
} from '../shared/protocol';
import type { GraphRow } from '../lib/graph';
import { CoalescedRefresh, HistoryLayoutCache, RefreshFlags } from '../lib/performance-models';
import { clamp, errorText, fullDateText, LruCache, matchesCommit, numberText, scopeText, shortOid, type CommitFilter, type SearchMode } from '../lib/format';
import { buildPullRequestUrl } from '../lib/providers';
import { effectiveSettings, Requests, StateStore } from '../lib/state';
import { configureLocale, getLanguage, isLocalizedMessage, localized, onLocaleChange, resolveText, type Localizable } from '../lib/i18n';
import { m } from '../i18n/app';
import type { StatusResult, StatusTask } from '../lib/status';
import { configurePerformance, performanceDiagnostics as perf, type PerformanceContext, type PerformanceOutcome } from '../lib/performance';
import { GitActions, ACTION_DATA_IDS, ACTION_GROUPS, ACTION_LABELS, splitRemoteBranch } from './actions';
import { DetailsPane, type DetailSelection, type DetailViewSnapshot } from './details';
import { button, checkbox, closeMenu, confirmDialog, contextMenu, disposeBindings, el, empty, formDialog, input, loading, menuAtButton, resizer, select, setAttribute, setText, textDialog, type MenuItem } from './dom';
import { icon } from './icons';
import { branchNeighbours, editableTarget, matchesShortcut, overlayOpen } from './navigation';
import { renderMessage } from './message';
import { showHistoryScope } from './scope';
import { showSettings } from './settings';
import { CommitTable } from './table';
import { RepositoryTree } from './repository-tree';
import { StatusBar } from './statusbar';
import { RepositoryToolbar } from './repository-toolbar';
import { chooseRepositoryBranch } from './branch-picker';
import { LocalChangesPane } from './local-changes';
import { HistoryDocuments, type HistoryFileRequest } from './history-documents';
import { RepositorySummaryScheduler, repositorySummaryFromSnapshot } from '../lib/repository-summaries';
import { m as wm } from '../i18n/workspace';

const MAX_COMMITS = 50_000;
const HISTORY_SETTING_KEYS: (keyof AppSettings)[] = ['showRemotes', 'showTags', 'showStashes', 'firstParent', 'includeReflog', 'initialLoad', 'loadMore', 'order', 'mailmap', 'includeTagOnly', 'showRemoteHeads', 'collapseStashAuxiliary', 'muteNonAncestors'];
const ACTION_KIND_BY_DATA_ID = new Map<string, ActionKind>((Object.keys(ACTION_LABELS) as ActionKind[]).map(kind => [ACTION_DATA_IDS[kind] ?? kind, kind]));
const ACTION_GROUP_CONTEXT = { branches: 'branch', history: 'commit', tags: 'tag', stashes: 'stash', remotes: 'remote', repository: 'worktree' } as const;
function actionLabel(kind: string): Localizable {
  return Object.hasOwn(ACTION_LABELS, kind) ? ACTION_LABELS[kind as ActionKind] : kind;
}
function signatureText(status: string): Localizable {
  switch (status) {
    case 'valid': case 'invalid': case 'unknown-key': case 'untrusted': case 'expired': case 'revoked': case 'unsigned': case 'unavailable': case 'error': return m(`signature.${status}`);
    default: return status;
  }
}
function operationText(operation: string): Localizable {
  switch (operation) {
    case 'merge': case 'rebase': case 'cherry-pick': case 'revert': return m(`operation.${operation}`);
    default: return operation;
  }
}
/** Keep the original host diagnostic for copying; translated summaries are presentation only. */
function rawErrorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (isLocalizedMessage(error)) return resolveText(error, 'en');
  if (error && typeof error === 'object' && 'localizedMessage' in error && isLocalizedMessage(error.localizedMessage)) return resolveText(error.localizedMessage, 'en');
  if (error && typeof error === 'object' && 'message' in error) return String(error.message) + ('detail' in error && error.detail ? `\n${String(error.detail)}` : '');
  return resolveText(errorText(error), 'en');
}
export class App {
  private store: StateStore;
  private requests: Requests;
  private repo: Repository | null = null;
  private diagnostics: Diagnostics | null = null;
  private refs: GitRef[] = [];
  private working: WorkingState | null = null;
  private stashes: Stash[] = [];
  private remotes: Remote[] = [];
  private commits: Commit[] = [];
  private graphRows: readonly GraphRow[] = [];
  private graph = new HistoryLayoutCache();
  private topologyRevision = 0;
  private visibleMemo?: { source: readonly Commit[]; revision: number; key: string; commits: Commit[] };
  private workingMemo?: { source: WorkingState; untracked: boolean; value: WorkingState };
  private refreshQueue: CoalescedRefresh;
  private refreshDebouncing = false;
  private workingDirtyEpoch = 0;
  private workingAppliedEpoch = -1;
  private historyMetadataKey = '';
  private historyReady = false;
  private autoLoadBlocked = false;
  private intentEpoch = 0;
  private hasMore = false;
  private offset = 0;
  private loadingHistory = false;
  private loadingRepo = false;
  private metadataLoading = false;
  private actionBusy = false;
  private selected: string | null = null;
  private compareBase: string | null = null;
  private scope: HistoryScope = { kind: 'all' };
  private search = '';
  private searchMode: SearchMode = 'all';
  private queryMode: 'filter' | 'search' = 'filter';
  private order: NonNullable<HistoryQuery['order']> = 'topo';
  private filter: CommitFilter = { text: '', mode: 'all' };
  private openGeneration = 0;
  private historyGeneration = 0;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private watcherTimer: ReturnType<typeof setTimeout> | undefined;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;
  private viewTimer: ReturnType<typeof setTimeout> | undefined;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private unlisten?: () => void;
  private disposed = false;
  private initialized = false;
  private detailsOpen = false;
  private detailSize = 360;
  private resizeHandle: HTMLElement;
  private shell = el('div', 'app-shell');
  private toolbar = el('header', 'toolbar');
  private querybar = el('div', 'querybar');
  private trustbar = el('div', 'trustbar');
  private diagnosticsbar = el('div', 'trustbar diagnosticsbar');
  private operationbar = el('div', 'operationbar');
  private errorbar = el('div', 'errorbar');
  private workspace = el('main', 'workspace');
  private repositoryWorkspace = el('section', 'repository-workspace');
  private workspacePanels = el('div', 'workspace-panels');
  private workspaceTabs = el('nav', 'workspace-tabs');
  private graphSurface = el('section', 'graph-surface');
  private documentArea = el('section', 'history-documents');
  private repositoryToolbar: RepositoryToolbar;
  private localChanges: LocalChangesPane;
  private historyDocuments: HistoryDocuments;
  private summaries: RepositorySummaryScheduler;
  private localResizer: HTMLElement;
  private localOpen = false;
  private localDecision: boolean | null = null;
  private activeWorkspaceTab: 'local' | 'history' = 'history';
  private localMemory = new Map<string, { open: boolean; decision: boolean | null; tab: 'local' | 'history' }>();
  private inlineSide: 'before' | 'after' = 'after';
  private measuredDetailHeight = 0;
  private graphScroll = { top: 0, left: 0 };
  private documentGeneration = 0;
  private restoringGraph = false;
  private repositoryActionGeneration = 0;
  private content = el('div', 'app-content');
  private sidebar = el('aside', 'repository-sidebar');
  private sidebarResizer: HTMLElement;
  private repositoryTree: RepositoryTree;
  private directoryDiscovery: RepositoryDiscovery | null = null;
  private directoryPendingScope: DirectoryScopeState | null = null;
  private directoryFlight: Promise<RepositoryDiscovery> | undefined;
  private directoryLoading = false;
  private directoryCancelled = false;
  private directoryError: string | null = null;
  private directoryGeneration = 0;
  private directoryManualVisibility = false;
  private openingPath: string | null = null;
  private deactivationFlight: Promise<void> | undefined;
  private lastSuccessfulRefresh: number | null = null;
  private workingError: string | null = null;
  private historyError: string | null = null;
  private statusResult: StatusResult | null = null;
  private activeWrite: StatusTask | null = null;
  private cancelWrite: (() => void) | null = null;
  private localeDispose: (() => void) | undefined;
  private historyContainer = el('div', 'history-container');
  private historyOverlay = el('div', 'history-overlay');
  private status: StatusBar;
  private toastElement = el('div', 'toast');
  private table: CommitTable;
  private details: DetailsPane;
  private actions: GitActions;
  private repoSelect: HTMLSelectElement | null = null;
  private branchSelect: HTMLButtonElement | null = null;
  private orderSelect!: HTMLSelectElement;
  private unlistenExternal?: () => void;
  private sessions = new Map<string, ExternalSession>();
  private taskSequence = 0;
  private restoringView = false;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  private hoverOid: string | null = null;
  private hoverAnchor: HTMLElement | undefined;
  private containmentCache = new LruCache<Containment>(160, 2 * 1024 * 1024);
  private containmentTip = el('div', 'containment-tooltip');
  private snapshotFingerprint = '';
  private viewMemory = new Map<string, { detail: DetailViewSnapshot | null; loaded: number }>();
  private searchInput = input(m('query.searchCommits'));
  private searchScope!: HTMLSelectElement;
  private searchType!: HTMLSelectElement;
  private filterButton!: HTMLButtonElement;
  private queryCancel!: HTMLButtonElement;
  private settingsButton!: HTMLButtonElement;
  private refreshButton!: HTMLButtonElement;
  private settingsSnapshot: AppSettings | null = null;

  constructor(private readonly host: Host, private readonly root: HTMLElement) {
    this.store = new StateStore(state => host.saveState(state), error => this.showError(error));
    this.requests = new Requests(id => host.cancel(id));
    this.refreshQueue = new CoalescedRefresh(mask => this.runRefresh(mask), {
      canRun: () => Boolean(this.repo) && !this.disposed && !document.hidden && !this.actionBusy
        && !this.loadingRepo && !this.loadingHistory && !this.metadataLoading && !this.restoringView && !this.refreshDebouncing,
      onError: error => this.showError(error),
    });
    this.actions = new GitActions(host, {
      context: () => ({ repo: this.repo, settings: this.settings, refs: this.refs, remotes: this.remotes, stashes: this.stashes, selected: this.selected, working: this.working, generation: this.openGeneration }),
      execute: (action, label) => this.execute(action, label), error: error => this.showError(error),
      changed: () => { this.persistTrust(); this.renderTrust(); this.renderStatus(); }, toast: message => this.toast(message),
    });
    this.table = new CommitTable({
      select: (oid, compare, intent) => this.selectCommit(oid, compare, intent),
      context: (oid, x, y, element) => this.commitMenu(oid, x, y, element),
      refContext: (ref, x, y, element) => this.refMenu(ref, x, y, element),
      loadMore: () => { if (!this.restoringView && !this.autoLoadBlocked) void this.loadHistory(false); },
      loadMoreExplicit: () => { this.userIntent(); this.autoLoadBlocked = false; void this.loadHistory(false); },
      widths: widths => { this.updateSettings({ columnWidths: widths }); }, copy: text => this.copy(text),
      branchNavigate: (oid, direction, alternate) => { void this.navigateBranch(oid, direction, alternate); },
      hover: (oid, anchor) => this.hoverContainment(oid, anchor), openUrl: url => this.openUrl(url),
      scrolled: user => {
        if (this.graphSurface.hidden) return;
        if (user && this.restoringGraph) { ++this.documentGeneration; this.restoringGraph = false; }
        if (!this.restoringGraph) { if (user) this.userIntent(); this.queueViewSave(); }
      },
    });
    this.details = new DetailsPane(host, this.store, {
      context: () => ({ repo: this.repo, settings: this.settings, working: this.working }), settings: patch => this.updateSettings(patch),
      error: error => this.showError(error), copy: text => this.copy(text), action: kind => { void this.actions.show(kind, kind === 'reset' ? { target: 'HEAD', mode: this.settings.dialogDefaults.worktreeResetMode } : {}); },
      close: () => this.closeDetails(), follow: oid => this.followCommit(oid), ensureTrust: () => this.actions.trust(), openUrl: url => this.openUrl(url),
      changed: () => { this.queueViewSave(); if (this.detailsOpen && !this.graphSurface.hidden) this.renderTable(); },
      openHistoryFile: request => this.openHistoryDocument(request),
      heightChanged: height => {
        if (!height || this.graphSurface.hidden || !this.detailsOpen) return;
        if (Math.abs(height - this.measuredDetailHeight) > 1) { this.measuredDetailHeight = height; this.renderTable(); }
      },
    }, { mode: 'history' });
    this.historyDocuments = new HistoryDocuments(host, this.store, {
      context: () => ({ repo: this.repo, settings: this.settings }), settings: patch => this.updateSettings(patch),
      error: error => this.showError(error), copy: text => this.copy(text), ensureTrust: () => this.actions.trust(),
      openUrl: url => this.openUrl(url), activateGraph: () => this.restoreGraphSurface(), changed: () => this.renderDocuments(),
    });
    this.historyDocuments.tabs.addEventListener('click', () => {
      if (this.historyDocuments.activeId === null) { this.activeWorkspaceTab = 'history'; this.renderWorkspace(); }
    });
    this.historyDocuments.surface.addEventListener('focusin', () => { this.activeWorkspaceTab = 'history'; });
    this.repositoryToolbar = new RepositoryToolbar({
      branch: anchor => { void this.chooseBranch(anchor); }, sync: () => { void this.syncRepository(); },
      commit: () => this.showLocalCommit(), refresh: () => { void this.refresh(); }, more: anchor => this.moreMenu(anchor),
    });
    this.localChanges = new LocalChangesPane(host, {
      context: () => ({ repo: this.repo, working: this.working, settings: this.settings, busy: this.actionBusy || this.loadingRepo,
        loading: this.metadataLoading, error: this.workingError, generation: this.openGeneration, listSize: this.store.state.layout.localListSize ?? 230 }),
      execute: action => this.executeWorking(action), error: error => this.showError(error), copy: text => this.copy(text),
      position: next => this.updateSettings({ localChangesPosition: next === 'sidebar' ? 'inline' : 'middle' }),
      close: () => this.setLocalOpen(false), settings: patch => this.updateSettings(patch),
      listSize: (next, final) => { this.store.state.layout.localListSize = Math.round(next); if (final) this.store.queue(); },
    });
    this.summaries = new RepositorySummaryScheduler(host, () => this.renderDirectory());
    this.localResizer = resizer('vertical', () => this.store.state.layout.localWidth ?? 390, (value, final) => {
      this.store.state.layout.localWidth = Math.round(value); this.workspacePanels.style.setProperty('--local-width', `${value}px`);
      if (final) this.store.queue();
    }, 240, () => Math.max(240, Math.min(960, this.workspacePanels.clientWidth - 400)), false, wm('resizeLocal'));
    this.details.element.hidden = true;
    this.resizeHandle = this.createDetailResizer();
    this.repositoryTree = new RepositoryTree({
      onActivate: candidate => { void this.activateCandidate(candidate); },
      onAction: (candidate, anchor, kind) => { void this.repositoryRowAction(candidate, anchor, kind); },
      onVisibleCandidates: candidates => this.summaries.setVisible(candidates),
      onToggle: (key, collapsed) => {
        const scope = this.directoryPendingScope ?? this.store.state.directoryScope; if (!scope) return;
        scope.collapsedPaths = scope.collapsedPaths.filter(value => value !== key);
        if (collapsed) scope.collapsedPaths = [...scope.collapsedPaths, key].slice(-256);
        this.persistDirectoryPreferences(scope); this.renderDirectory();
      },
      onDepthChange: depth => { const scope = this.store.state.directoryScope; if (scope) void this.openDirectory(scope.root, depth, false); },
      onRescan: () => { const scope = this.store.state.directoryScope; if (scope) void this.openDirectory(scope.root, scope.depth, false); },
      onCancel: () => this.cancelDirectoryScan(), onCollapse: () => this.toggleSidebar(false),
      onClose: () => this.closeDirectory(), onCopyPath: path => this.copy(path),
    });
    this.sidebar.id = 'repository-navigation'; this.sidebar.append(this.repositoryTree.element); this.sidebar.hidden = true;
    this.sidebarResizer = this.createSidebarResizer(); this.sidebarResizer.hidden = true;
    this.historyContainer.append(this.table.element, this.historyOverlay);
    this.workspace.append(this.historyContainer, this.resizeHandle, this.details.element);
    this.graphSurface.append(this.querybar, this.workspace);
    this.documentArea.append(this.historyDocuments.tabs, this.graphSurface, this.historyDocuments.surface);
    this.workspaceTabs.append(button(wm('local'), () => { this.activeWorkspaceTab = 'local'; this.setLocalOpen(true); }, 'file'),
      button(wm('history'), () => { this.activeWorkspaceTab = 'history'; this.renderWorkspace(); }, 'branch'));
    setAttribute(this.workspaceTabs, 'aria-label', wm('repository'));
    this.workspacePanels.append(this.localChanges.element, this.localResizer, this.documentArea);
    this.repositoryWorkspace.append(this.repositoryToolbar.element, this.workspaceTabs, this.workspacePanels);
    this.content.append(this.sidebar, this.sidebarResizer, this.repositoryWorkspace);
    this.status = new StatusBar({
      copyPath: path => this.copy(path), changeLanguage: () => { void this.chooseLanguage(); },
      trust: () => { void this.toggleTrust(); }, cancelHistory: () => this.cancelLoading(),
      cancelWrite: () => this.cancelWrite?.(), openWorking: () => this.showLocalCommit(),
    });
    this.trustbar.hidden = true; this.diagnosticsbar.hidden = true; this.operationbar.hidden = true; this.errorbar.hidden = true;
    this.diagnosticsbar.setAttribute('role', 'status'); this.diagnosticsbar.setAttribute('aria-live', 'polite');
    this.errorbar.setAttribute('role', 'alert'); this.toastElement.hidden = true; this.toastElement.setAttribute('role', 'status'); this.toastElement.setAttribute('aria-live', 'polite');
    this.containmentTip.hidden = true; this.containmentTip.id = 'commit-containment'; this.containmentTip.setAttribute('role', 'tooltip');
    this.shell.append(this.toolbar, this.diagnosticsbar, this.trustbar, this.operationbar, this.errorbar, this.content, this.status.element, this.toastElement, this.containmentTip);
    this.root.replaceChildren(this.shell);
    this.buildToolbar(); this.buildQuerybar(); this.applySettings();
    this.localeDispose = onLocaleChange(() => this.updateLocale());
    this.historyOverlay.replaceChildren(loading(m('history.preferencesLoading'))); this.historyOverlay.hidden = false;
    document.addEventListener('keydown', this.keydown);
    window.addEventListener('beforeunload', this.beforeUnload);
    document.addEventListener('visibilitychange', this.visibilityChanged);
    window.addEventListener('focus', this.windowFocused);
  }
  private get settings(): AppSettings { return effectiveSettings(this.store.state, this.repo?.id); }

  async init(): Promise<void> {
    const [stateResult, diagnosticsResult] = await Promise.allSettled([this.host.loadState(), this.host.diagnostics()]);
    if (this.disposed) return;
    if (stateResult.status === 'fulfilled') this.store.load(stateResult.value); else this.showError(stateResult.reason);
    configureLocale(this.store.state.settings.language);
    if (diagnosticsResult.status === 'fulfilled') { this.diagnostics = diagnosticsResult.value; configurePerformance(this.diagnostics.performanceEnabled); this.renderDiagnosticsWarnings(); } else this.showError(diagnosticsResult.reason);
    this.detailSize = this.store.state.layout.detailSize;
    this.initialized = true; this.order = this.settings.order; this.applySettings(); this.buildToolbar(); this.renderStatus();
    this.orderSelect.value = this.order;
    try { this.unlistenExternal = await this.host.onExternalSession(session => this.externalSessionChanged(session)); } catch (error) { this.showError(error); }
    try {
      this.unlisten = await this.host.onRepositoryChanged(repoId => {
        if (repoId !== this.repo?.id || this.disposed) return;
        this.workingDirtyEpoch++; this.refreshDebouncing = true; this.renderStatus();
        this.refreshQueue.request(RefreshFlags.History | RefreshFlags.Working | RefreshFlags.Config);
        clearTimeout(this.watcherTimer);
        this.watcherTimer = setTimeout(() => {
          this.watcherTimer = undefined; this.refreshDebouncing = false; this.refreshQueue.resume();
        }, 600);
      });
    } catch (error) { this.showError(error); }
    const last = this.store.state.lastRepo, directory = this.store.state.directoryScope;
    if (directory) await this.openDirectory(directory.root, directory.depth, true, last);
    else if (last) await this.openRepository(last);
    else this.renderEmpty();
  }

  private renderDiagnosticsWarnings(): void {
    const warnings = this.diagnostics?.warnings?.filter(warning => warning.trim()) ?? [];
    this.diagnosticsbar.hidden = !warnings.length; if (!warnings.length) return;
    const details = button(m('diagnostics.details'), () => this.showDiagnosticsWarnings(), 'info'); details.dataset.action = 'diagnostics-warnings';
    const summary = el('span', 'error-summary', m(warnings.length === 1 ? 'diagnostics.summaryOne' : 'diagnostics.summaryMany', { count: numberText(warnings.length), warning: warnings[0].split(/\r?\n/)[0] })); setAttribute(summary, 'title', warnings[0]);
    this.diagnosticsbar.replaceChildren(icon('warning'), summary, el('span', 'spacer'), details, button(m('diagnostics.dismiss'), () => { this.diagnosticsbar.hidden = true; }, 'close', '', true));
  }
  private showDiagnosticsWarnings(): void {
    const warnings = this.diagnostics?.warnings?.filter(warning => warning.trim()) ?? [];
    if (warnings.length) void textDialog(m('diagnostics.title'), localized(locale => warnings.map((warning, index) => `${resolveText(numberText(index + 1), locale)}. ${warning}`).join('\n\n')));
  }
  private sortedRecentRepositories(includeCurrent = false): { path: string; name: string }[] {
    const recent = [...this.store.state.recent];
    if (includeCurrent && this.repo && !recent.some(item => item.path === this.repo!.path)) recent.unshift({ path: this.repo.path, name: this.repo.name });
    const order = this.settings.repositorySort;
    if (order !== 'recent') recent.sort((a, b) => (order === 'name' ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : 0) || a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
    return recent;
  }
  private async removeRecentRepository(): Promise<void> {
    const recent = this.sortedRecentRepositories(); if (!recent.length) return;
    const values = await formDialog({ title: m('recent.removeTitle'), description: m('recent.removeDescription'), fields: [{ name: 'path', label: m('recent.repository'), type: 'select', value: recent[0].path, options: recent.map(item => ({ value: item.path, label: `${item.name} · ${item.path}` })) }], confirm: m('recent.removeConfirm'), dataAction: 'confirm-remove-recent-repository' });
    if (!values || !recent.some(item => item.path === values.path)) return;
    this.store.state.recent = this.store.state.recent.filter(item => item.path !== values.path); this.store.queue(); this.buildToolbar(); this.toast(m('recent.removed'));
  }
  private buildToolbar(): void {
    this.toolbar.replaceChildren(); setAttribute(this.toolbar, 'aria-label', wm('global'));
    const recents = this.sortedRecentRepositories();
    const options = [...(!this.repo ? [{ value: '', label: m('toolbar.noRepository') }] : []), ...this.sortedRecentRepositories(true).map(item => ({ value: item.path, label: item.name }))];
    this.repoSelect = select(options, this.repo?.path ?? '', m('toolbar.recentRepositories'), path => { if (path) void this.openRepository(path); });
    this.repoSelect.className = 'repo-select'; setAttribute(this.repoSelect, 'title', this.repo?.path ?? m('toolbar.selectRecent'));
    const open = button(m('toolbar.openShortcut', { shortcut: 'Ctrl+O' }), () => { void this.openPicker(); }, 'open', '', true);
    const openDirectory = button(wm('openDirectory'), () => { void this.openDirectoryPicker(); }, 'folder'); openDirectory.dataset.action = 'open-directory';
    const treeToggle = button(m('toolbar.toggleNavigation'), () => this.toggleSidebar(), 'sidebar', '', true); treeToggle.dataset.action = 'toggle-repository-tree';
    treeToggle.setAttribute('aria-controls', this.sidebar.id); treeToggle.setAttribute('aria-expanded', String(!this.sidebar.hidden));
    const openMenu = button(m('toolbar.repositoryOptions'), () => menuAtButton(openMenu, [
      { label: m('repository.openMenu'), icon: 'open', action: () => { void this.openPicker(); } },
      { label: m('repository.openByPath'), dataAction: 'open-repository-by-path', icon: 'folder', action: () => { void this.openByPath(); } },
      { label: m('directory.openMenu'), dataAction: 'open-directory', icon: 'folder', action: () => { void this.openDirectoryPicker(); } },
      { label: m('directory.openByPath'), dataAction: 'open-directory-by-path', icon: 'search', action: () => { void this.discover(); } },
      ...(this.store.state.directoryScope ? [{ label: m('directory.close'), dataAction: 'close-directory', icon: 'close' as const, action: () => this.closeDirectory() }] : []),
      ...(this.repo ? [{ label: m('repository.copyPath'), icon: 'copy' as const, action: () => this.copy(this.repo!.path) }, { label: m('repository.close'), icon: 'close' as const, action: () => this.closeRepository() }] : []),
      ...(recents.length ? [null, { label: m('recent.removeMenu'), dataAction: 'remove-recent-repository', action: () => { void this.removeRecentRepository(); } }, { label: m('recent.clear'), action: () => { this.store.state.recent = this.repo ? [{ path: this.repo.path, name: this.repo.name }] : []; this.store.queue(); this.buildToolbar(); } }] : []),
      ...(this.diagnostics?.warnings?.some(warning => warning.trim()) ? [null, { label: m('diagnostics.menu'), dataAction: 'diagnostics-warnings', icon: 'warning' as const, action: () => this.showDiagnosticsWarnings() }] : []),
    ]), 'down', '', true);
    this.branchSelect = button(scopeText(this.scope), () => { void this.chooseScope(); }, 'branch', 'branch-select'); this.branchSelect.disabled = !this.repo; this.branchSelect.dataset.action = 'scope'; this.branchSelect.setAttribute('aria-haspopup', 'dialog');
    const brand = el('strong', 'application-name', 'QGitGraph');
    this.toolbar.append(treeToggle, brand, open, openDirectory, this.repoSelect, openMenu, el('span', 'spacer'));
    this.refreshButton = this.repositoryToolbar.refreshButton;
    const head = button(m('toolbar.centerHead', { shortcut: this.settings.shortcuts.head }), () => { void this.revealHead(); }, 'commit', '', true); head.disabled = !this.repo; head.dataset.action = 'head';
    this.settingsButton = button(m('toolbar.settings', { shortcut: 'Ctrl+,' }), () => this.openSettings(), 'settings', '', true); this.settingsButton.dataset.action = 'settings'; open.dataset.action = 'open-repository'; openMenu.dataset.action = 'repository-options';
    this.toolbar.append(this.settingsButton);
    const graphActions = el('div', 'graph-toolbar-actions', this.branchSelect, head);
    const remoteVisibility = checkbox(wm('remoteBranchesVisible'), this.settings.showRemotes, checked => this.updateSettings({ showRemotes: checked }));
    graphActions.insertBefore(remoteVisibility, head);
    const graphMore = button(wm('graphOptions'), () => { void this.showGraphOptions(); }, 'more', '', true);
    graphMore.disabled = !this.repo; graphActions.append(graphMore);
    this.querybar.querySelector('.graph-toolbar-actions')?.remove(); this.querybar.append(graphActions);
    this.repositoryToolbar.update({ repository: this.repo, working: this.working, busy: this.actionBusy,
      loading: this.loadingRepo || this.metadataLoading, settings: this.settings,
      refreshLabel: m('toolbar.refresh', { shortcut: this.settings.shortcuts.refresh }) });
    if (this.loadingRepo) { this.repoSelect.disabled = true; open.disabled = true; }
    openDirectory.disabled = this.actionBusy;
  }

  private buildQuerybar(): void {
    this.searchInput.type = 'search'; setAttribute(this.searchInput, 'placeholder', m('query.filterCommits')); this.searchInput.autocomplete = 'off'; this.searchInput.spellcheck = false; this.searchInput.className = 'commit-search';
    this.searchInput.addEventListener('input', () => {
      this.queryIntent(); this.search = this.searchInput.value;
      if (this.queryMode === 'filter') { this.filter.text = this.search; this.filter.mode = this.searchMode; this.renderTable(); }
      else {
        const generation = this.historyGeneration, repoId = this.repo?.id;
        // Do not display the previous Git-side query under a newly typed query header.
        this.commits = []; this.topologyRevision++; this.hasMore = false; this.renderTable(true);
        this.historyOverlay.hidden = false; this.historyOverlay.replaceChildren(loading(m('query.waiting')));
        this.searchTimer = setTimeout(() => {
          this.searchTimer = undefined;
          if (generation === this.historyGeneration && repoId === this.repo?.id) void this.loadHistory(true);
        }, 350);
      }
      this.saveView();
    });
    this.searchInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && this.queryMode === 'search') { this.queryIntent(); void this.loadHistory(true); }
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (this.searchInput.value) {
          this.queryIntent(); this.searchInput.value = ''; this.search = '';
          if (this.queryMode === 'filter') { this.filter.text = ''; this.renderTable(); } else void this.loadHistory(true);
          this.saveView();
        } else this.table.focus();
      }
    });
    this.searchScope = select([{ value: 'filter', label: m('query.filterLoaded') }, { value: 'search', label: m('query.searchHistory') }], this.queryMode, m('query.scope'), value => {
      this.queryIntent(); this.queryMode = value as typeof this.queryMode; setAttribute(this.searchInput, 'placeholder', m(value === 'filter' ? 'query.filterCommits' : 'query.searchEntireHistory'));
      this.filter.text = value === 'filter' ? this.search : ''; this.filter.mode = this.searchMode; this.saveView(); void this.loadHistory(true);
    });
    this.searchType = select([{ value: 'all', label: m('query.allFields') }, { value: 'message', label: m('query.message') }, { value: 'author', label: m('query.authorEmail') }, { value: 'hash', label: m('query.commitHash') }, { value: 'date', label: m('query.date') }, { value: 'refs', label: m('query.refs') }], this.searchMode, m('query.field'), value => {
      this.queryIntent(); this.searchMode = value as SearchMode; this.filter.mode = this.searchMode;
      if (this.queryMode === 'search') void this.loadHistory(true); else this.renderTable(); this.saveView();
    });
    this.filterButton = button(m('query.advanced'), () => { void this.advancedFilter(); }, 'filter');
    this.orderSelect = select([{ value: 'topo', label: m('query.topological') }, { value: 'date', label: m('query.commitDate') }, { value: 'author-date', label: m('query.authorDate') }], this.order, m('query.ordering'), value => { this.queryIntent(); this.order = value as typeof this.order; this.saveView(); void this.loadHistory(true); }); this.orderSelect.className = 'order-select';
    this.queryCancel = button(m('query.cancel'), () => this.cancelLoading(), 'close'); this.queryCancel.hidden = true;
    this.querybar.classList.add('compact-history-query');
    this.querybar.append(icon('search'), this.searchInput, this.searchType, this.searchScope, this.filterButton, el('span', 'spacer'), this.orderSelect, this.queryCancel);
    this.buildToolbar();
  }
  private async showGraphOptions(): Promise<void> {
    const repoId = this.repo?.id, generation = this.openGeneration;
    const options = await formDialog({ title: wm('graphOptions'), fields: [
      { name: 'searchMode', label: m('query.field'), type: 'select', value: this.searchMode,
        options: ['all', 'message', 'author', 'hash', 'date', 'refs'].map(value => ({ value, label: ({ all: m('query.allFields'), message: m('query.message'), author: m('query.authorEmail'), hash: m('query.commitHash'), date: m('query.date'), refs: m('query.refs') })[value]! })) },
      { name: 'queryMode', label: m('query.scope'), type: 'select', value: this.queryMode,
        options: [{ value: 'filter', label: m('query.filterLoaded') }, { value: 'search', label: m('query.searchHistory') }] },
      { name: 'order', label: m('query.ordering'), type: 'select', value: this.order,
        options: [{ value: 'topo', label: m('query.topological') }, { value: 'date', label: m('query.commitDate') }, { value: 'author-date', label: m('query.authorDate') }] },
    ], confirm: m('apply') });
    if (!options || this.repo?.id !== repoId || this.openGeneration !== generation) return;
    this.queryIntent(); this.searchMode = String(options.searchMode) as SearchMode; this.queryMode = options.queryMode === 'search' ? 'search' : 'filter';
    this.order = options.order as typeof this.order; this.filter.mode = this.searchMode;
    this.filter.text = this.queryMode === 'filter' ? this.search : '';
    this.searchType.value = this.searchMode; this.searchScope.value = this.queryMode; this.orderSelect.value = this.order;
    setAttribute(this.searchInput, 'placeholder', m(this.queryMode === 'filter' ? 'query.filterCommits' : 'query.searchEntireHistory'));
    this.saveView(); await this.loadHistory(true);
  }
  private userIntent(): void {
    this.intentEpoch++; this.restoringView = false;
  }
  private queryIntent(): void {
    this.userIntent(); clearTimeout(this.searchTimer); this.searchTimer = undefined;
    this.requests.cancel('history'); this.historyGeneration++; this.loadingHistory = false; this.historyReady = false;
    this.queryCancel.hidden = true; this.autoLoadBlocked = false;
  }
  private resetRepositoryWork(): void {
    this.queryIntent(); this.refreshQueue.cancel();
    clearTimeout(this.watcherTimer); clearTimeout(this.focusTimer); clearTimeout(this.viewTimer);
    this.watcherTimer = undefined; this.focusTimer = undefined; this.viewTimer = undefined; this.refreshDebouncing = false;
  }
  private queueViewSave(): void {
    if (this.viewTimer !== undefined || this.disposed) return;
    this.viewTimer = setTimeout(() => { this.viewTimer = undefined; this.saveView(); }, 160);
  }
  private saveView(): void {
    clearTimeout(this.viewTimer); this.viewTimer = undefined;
    const repo = this.repo; if (!repo || !this.initialized || this.restoringView || this.loadingRepo) return;
    const detail = this.detailsOpen ? this.details.view : null;
    const scroll = this.graphSurface.hidden ? this.graphScroll : { top: this.table.scrollTop, left: this.table.scrollLeft };
    const filter: Record<string, string> = {};
    for (const key of ['author', 'hash', 'refs', 'after', 'before'] as const) if (this.filter[key]) filter[key] = this.filter[key]!;
    if (detail?.fileFilter) filter.fileFilter = detail.fileFilter;
    if (detail?.workingMode) filter.workingMode = detail.workingMode;
    if (detail?.diff) { filter.diffScrollTop = String(detail.diff.scrollTop); filter.diffScrollLeft = String(detail.diff.scrollLeft); filter.diffMode = detail.diff.mode; }
    if (detail?.filesScrollTop) filter.filesScrollTop = String(detail.filesScrollTop);
    const view: ViewState = { scope: structuredClone(this.scope), search: this.search, searchMode: this.searchMode, queryMode: this.queryMode, order: this.order, scrollTop: scroll.top, scrollLeft: scroll.left, selected: this.selected, filter, collapsed: detail?.collapsed ?? [] };
    if (detail) view.detail = { selection: structuredClone(detail.selection), path: detail.path, scrollTop: detail.scrollTop,
      filesScrollTop: detail.filesScrollTop, filesScrollLeft: detail.filesScrollLeft,
      fullMessage: detail.fullMessage, inlineSide: detail.inlineSide };
    this.store.state.views[repo.id] = view; this.viewMemory.set(repo.id, { detail, loaded: this.commits.length }); this.store.queue();
  }
  private restoreQuery(view?: ViewState): void {
    this.scope = structuredClone(view?.scope ?? this.settings.startupScope);
    this.search = view?.search ?? ''; this.searchMode = (['all', 'message', 'author', 'hash', 'date', 'refs'].includes(view?.searchMode ?? '') ? view!.searchMode : 'all') as SearchMode;
    this.queryMode = view?.queryMode ?? 'filter'; this.order = view?.order ?? this.settings.order;
    this.filter = { text: this.queryMode === 'filter' ? this.search : '', mode: this.searchMode, author: view?.filter?.author, hash: view?.filter?.hash, refs: view?.filter?.refs, after: view?.filter?.after, before: view?.filter?.before };
    this.searchInput.value = this.search; setAttribute(this.searchInput, 'placeholder', m(this.queryMode === 'filter' ? 'query.filterCommits' : 'query.searchEntireHistory')); this.searchScope.value = this.queryMode; this.searchType.value = this.searchMode; this.orderSelect.value = this.order;
  }
  private async restoreView(view: ViewState | undefined, generation: number, intent: number, performanceContext?: PerformanceContext): Promise<void> {
    const repo = this.repo; if (!repo) return;
    const current = (): boolean => this.repo?.id === repo.id && generation === this.openGeneration
      && intent === this.intentEpoch && !this.autoLoadBlocked && !this.disposed;
    const memory = this.viewMemory.get(repo.id);
    const desired = Math.min(MAX_COMMITS, Math.max(this.settings.initialLoad, memory?.loaded ?? Math.ceil((view?.scrollTop ?? 0) / this.settings.rowHeight) + 60));
    while (this.hasMore && this.commits.length < desired && current()) {
      const before = this.commits.length; await this.loadHistory(false, performanceContext); if (before === this.commits.length) break;
    }
    if (!current()) return;
    this.selected = view?.selected ?? null;
    const savedDetail = memory?.detail ?? (view?.detail ? {
      ...view.detail, selection: view.detail.selection as DetailSelection, collapsed: view.collapsed ?? [], fileFilter: view.filter?.fileFilter,
      filesScrollTop: view.detail.filesScrollTop ?? (Number(view.filter?.filesScrollTop) || 0),
      workingMode: ['all', 'staged', 'unstaged'].includes(view.filter?.workingMode ?? '') ? view!.filter!.workingMode as 'all' | 'staged' | 'unstaged' : 'all',
      diff: { scrollTop: Number(view.filter?.diffScrollTop) || 0, scrollLeft: Number(view.filter?.diffScrollLeft) || 0, mode: ['diff', 'new', 'old'].includes(view.filter?.diffMode ?? '') ? view!.filter!.diffMode as 'diff' | 'new' | 'old' : 'diff' },
    } : null);
    if (savedDetail) {
      this.inlineSide = savedDetail.inlineSide === 'above' ? 'before' : 'after'; this.details.setInlineSide(this.inlineSide);
      this.compareBase = savedDetail.selection.kind === 'compare' ? savedDetail.selection.base : null;
      this.detailsOpen = true; this.details.element.hidden = false; this.applyLayout();
    } else { this.detailsOpen = false; this.details.clear(); this.applyLayout(); }
    this.renderTable(false, performanceContext);
    // History/viewport restoration must not wait for the selected file's first diff.
    this.table.scrollTop = view?.scrollTop ?? 0; this.table.scrollLeft = view?.scrollLeft ?? 0;
    this.graphScroll = { top: this.table.scrollTop, left: this.table.scrollLeft };
    if (!view && this.settings.scrollToHead && repo.head) { this.selected = repo.head; this.renderTable(false, performanceContext); this.table.reveal(repo.head, true); }
    this.restoringView = false; this.renderTable(false, performanceContext);
    if (savedDetail && this.detailsOpen) {
      void this.details.show(savedDetail.selection, false, savedDetail, performanceContext)
        .then(() => { if (current()) this.queueViewSave(); }).catch(error => { if (current()) this.showError(error); });
    }
  }
  private async chooseScope(): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return;
    const scope = await showHistoryScope(this.scope, this.refs, this.settings); if (!scope || this.repo?.id !== repoId) return;
    this.queryIntent(); this.scope = scope; this.saveView(); this.buildToolbar(); await this.loadHistory(true);
  }
  private setScope(scope: HistoryScope): void { this.queryIntent(); this.scope = structuredClone(scope); this.saveView(); this.buildToolbar(); void this.loadHistory(true); }

  private async openPicker(): Promise<void> {
    if (this.actionBusy) { this.toast(m('repository.waitToSwitch')); return; }
    try { const path = await this.host.pickRepository(); if (path) await this.openRepository(path); } catch (error) { this.showError(error); }
  }
  private async openByPath(): Promise<void> {
    const values = await formDialog({ title: m('repository.openTitle'), description: m('repository.openDescription'), fields: [{ name: 'path', label: m('repository.path'), value: '', required: true }], confirm: m('repository.openTitle'), dataAction: 'confirm-open-repository' });
    if (values) await this.openRepository(String(values.path));
  }
  private async discover(): Promise<void> {
    const values = await formDialog({ title: m('directory.openTitle'), description: m('directory.openDescription'), fields: [{ name: 'path', label: m('directory.parent'), value: '', required: true }, { name: 'depth', label: m('directory.depth'), type: 'number', value: '2', min: 0, max: 5, required: true }], confirm: m('directory.openConfirm'), dataAction: 'confirm-open-directory' });
    if (values) await this.openDirectory(String(values.path), clamp(Number(values.depth), 0, 5));
  }
  private async openDirectoryPicker(): Promise<void> {
    if (this.actionBusy) { this.toast(m('repository.waitToSwitch')); return; }
    try { const path = await this.host.pickRepository('directory'); if (path) await this.openDirectory(path, 2); }
    catch (error) { this.showError(error); }
  }
  private persistDirectoryPreferences(scope: DirectoryScopeState): void {
    const saved = this.store.state.directoryScope;
    if (saved && saved !== scope && saved.root === scope.root) {
      saved.width = scope.width; saved.collapsed = scope.collapsed; saved.collapsedPaths = [...scope.collapsedPaths];
    }
    this.store.queue();
  }
  private async openDirectory(path: string, depth = 2, restore = false, remembered = this.repo?.path ?? this.store.state.lastRepo): Promise<void> {
    if (this.actionBusy || this.disposed) return;
    const generation = ++this.directoryGeneration, previous = this.directoryPendingScope ?? this.store.state.directoryScope, activationGeneration = this.openGeneration;
    const sameRoot = previous?.root === path;
    this.requests.cancel('discovery');
    const request = this.requests.begin('discovery');
    const pending: DirectoryScopeState = { root: path, depth: Math.round(clamp(depth, 0, 5)),
      width: previous?.width ?? 240, collapsed: sameRoot ? previous.collapsed : false,
      collapsedPaths: sameRoot ? [...previous.collapsedPaths] : [] };
    this.directoryPendingScope = pending; this.directoryLoading = true; this.directoryCancelled = false; this.directoryError = null;
    if (restore) this.directoryManualVisibility = true;
    else if (!sameRoot) this.directoryManualVisibility = false;
    this.renderDirectory(); this.buildToolbar(); this.renderStatus();
    try {
      // A cancelled scan retains its worker until it actually exits. Do not
      // accumulate new blocking workers while a slow filesystem call returns.
      const previousFlight = this.directoryFlight;
      if (previousFlight) await previousFlight.catch(() => undefined);
      if (!request.current() || generation !== this.directoryGeneration || this.disposed) return;
      const flight = this.host.discoverRepositories(path, pending.depth, request.id);
      this.directoryFlight = flight;
      let discovery: RepositoryDiscovery;
      try { discovery = await flight; } finally { if (this.directoryFlight === flight) this.directoryFlight = undefined; }
      if (!request.current() || generation !== this.directoryGeneration || this.disposed) return;
      const keepActive = Boolean(this.repo && discovery.repositories.some(candidate => candidate.path === this.repo!.path));
      const activationChanged = activationGeneration !== this.openGeneration;
      if (this.repo && !keepActive && !activationChanged) this.closeRepository();
      this.directoryDiscovery = discovery;
      this.store.state.directoryScope = { ...pending, root: discovery.root };
      this.directoryPendingScope = null; this.directoryLoading = false; this.store.queue();
      this.renderDirectory(); this.buildToolbar(); this.renderStatus();
      const rememberedCandidate = discovery.repositories.find(candidate => candidate.path === remembered);
      const single = discovery.complete && discovery.repositories.length === 1;
      const target = keepActive || activationChanged ? undefined : rememberedCandidate ?? (single ? discovery.repositories[0] : undefined);
      if (target) await this.activateCandidate(target);
      if (generation !== this.directoryGeneration || this.directoryDiscovery !== discovery || this.disposed) return;
      if (single && this.repo?.path === discovery.repositories[0].path && !this.directoryManualVisibility) {
        const scope = this.store.state.directoryScope;
        if (scope?.root === discovery.root) { scope.collapsed = true; this.store.queue(); this.renderDirectory(); this.buildToolbar(); }
      }
      if (!this.repo) this.renderEmpty();
    } catch (error) {
      if (generation === this.directoryGeneration && request.current() && !this.disposed) {
        this.directoryError = rawErrorText(error); this.directoryPendingScope = null;
        this.showError(error); this.renderDirectory();
        if (!this.repo) this.renderEmpty();
      }
    } finally {
      if (generation === this.directoryGeneration) { this.directoryLoading = false; this.renderDirectory(); this.buildToolbar(); this.renderStatus(); }
      request.finish();
    }
  }
  private async activateCandidate(candidate: RepositoryCandidate, toggle = true): Promise<boolean> {
    if (toggle) ++this.repositoryActionGeneration;
    const discovery = this.directoryDiscovery, scope = this.store.state.directoryScope;
    const selected = discovery?.repositories.find(item => item.path === candidate.path && item.marker === candidate.marker
      && item.components.length === candidate.components.length && item.components.every((component, index) => component === candidate.components[index]));
    if (!scope || !discovery || !selected || scope.root !== discovery.root) return false;
    if (this.repo?.path === selected.path && !this.loadingRepo) {
      if (toggle) { if (this.metadataLoading && !this.working) this.localDecision = true; else this.setLocalOpen(!this.localOpen && Boolean(this.working?.files.length)); }
      return true;
    }
    const opened = await this.openRepository(selected.path, scope.root);
    if (opened && this.directoryDiscovery === discovery && discovery.complete && discovery.repositories.length === 1
      && this.repo?.path === candidate.path && !this.directoryManualVisibility) {
      scope.collapsed = true; this.store.queue(); this.renderDirectory(); this.buildToolbar();
    }
    return opened;
  }
  private cancelDirectoryScan(): void {
    ++this.directoryGeneration; this.requests.cancel('discovery'); this.directoryLoading = false;
    this.directoryCancelled = true; this.directoryPendingScope = null; this.renderDirectory(); this.buildToolbar(); this.renderStatus();
  }
  private closeDirectory(): void {
    if (this.actionBusy) { this.toast(m('repository.waitForOperation')); return; }
    this.cancelDirectoryScan(); this.directoryDiscovery = null; this.directoryPendingScope = null;
    this.store.state.directoryScope = null; this.directoryError = null; this.directoryCancelled = false; this.directoryManualVisibility = false;
    this.store.queue(); this.renderDirectory(); this.closeRepository();
  }
  private toggleSidebar(visible?: boolean): void {
    const scope = this.directoryPendingScope ?? this.store.state.directoryScope;
    if (!scope) { void this.openDirectoryPicker(); return; }
    scope.collapsed = visible === undefined ? !scope.collapsed : !visible;
    this.directoryManualVisibility = true;
    if (scope.collapsed) this.summaries.setVisible([]);
    this.persistDirectoryPreferences(scope); this.renderDirectory(); this.buildToolbar(); this.renderWorkspace();
  }
  private createSidebarResizer(): HTMLElement {
    return resizer('vertical', () => Math.max(300, (this.directoryPendingScope ?? this.store.state.directoryScope)?.width ?? 376), (value, final) => {
      const scope = this.directoryPendingScope ?? this.store.state.directoryScope; if (!scope) return;
      scope.width = Math.round(value); this.sidebar.style.setProperty('--repository-width', `${scope.width}px`);
      if (final) this.persistDirectoryPreferences(scope);
    }, 300, () => Math.max(300, Math.min(640, this.content.clientWidth - 400)), false, m('directory.resize'));
  }
  private renderDirectory(): void {
    const scope = this.directoryPendingScope ?? this.store.state.directoryScope;
    const candidates = this.directoryDiscovery && this.directoryDiscovery.root === scope?.root ? this.directoryDiscovery.repositories : [];
    this.summaries.setScope(scope?.root ?? null, candidates);
    const visible = Boolean(scope && !scope.collapsed);
    this.sidebar.hidden = !visible; this.sidebarResizer.hidden = !visible;
    this.content.classList.toggle('has-repository-sidebar', visible);
    if (!scope) return;
    this.sidebar.style.setProperty('--repository-width', `${scope.width}px`);
    const discovery = this.directoryDiscovery?.root === scope.root ? this.directoryDiscovery : null;
    this.repositoryTree.update({ root: scope.root, depth: scope.depth, discovery, loading: this.directoryLoading,
      cancelled: this.directoryCancelled, error: this.directoryError, activePath: this.repo?.path ?? null,
      openingPath: this.openingPath, collapsedPaths: scope.collapsedPaths, summaries: this.summaries.summaries });
  }

  private saveLocalMemory(): void {
    if (!this.repo) return;
    this.localMemory.delete(this.repo.id);
    this.localMemory.set(this.repo.id, { open: this.localOpen, decision: this.localDecision, tab: this.activeWorkspaceTab });
    if (this.localMemory.size > 30) this.localMemory.delete(this.localMemory.keys().next().value!);
  }
  private setLocalOpen(open: boolean): void {
    this.localDecision = open; this.localOpen = open && Boolean(this.repo && !this.repo.bare && (this.working?.files.length || this.metadataLoading));
    if (this.localOpen) this.activeWorkspaceTab = 'local';
    else this.activeWorkspaceTab = 'history';
    this.saveLocalMemory(); this.renderWorkspace();
  }
  private showLocalCommit(): void {
    if (!this.repo || this.repo.bare) return;
    if (this.working && !this.working.files.length) { this.toast(wm('noChanges')); return; }
    this.setLocalOpen(true); this.localChanges.focusMessage();
  }
  private renderWorkspace(): void {
    const inline = this.settings.localChangesPosition === 'inline' && !this.sidebar.hidden;
    const show = this.localOpen && Boolean(this.repo) && !this.repo?.bare;
    this.workspacePanels.dataset.localPosition = inline ? 'inline' : 'middle';
    this.workspacePanels.dataset.activeTab = this.activeWorkspaceTab;
    this.workspacePanels.classList.toggle('has-local-changes', show);
    this.workspacePanels.style.setProperty('--local-width', `${this.store.state.layout.localWidth ?? 390}px`);
    this.localChanges.element.hidden = !show;
    this.localResizer.hidden = !show;
    this.localChanges.setPlacement(inline ? 'sidebar' : 'workspace');
    this.repositoryTree.mountLocal(inline && show ? this.localChanges.listElement : null, inline && show ? this.repo?.path ?? null : null);
    this.localChanges.update();
    this.localChanges.listElement.hidden = !show;
    this.workspaceTabs.classList.toggle('has-local-changes', show);
    const tabs = [...this.workspaceTabs.querySelectorAll<HTMLButtonElement>('button')];
    tabs[0]?.setAttribute('aria-pressed', String(this.activeWorkspaceTab === 'local'));
    tabs[1]?.setAttribute('aria-pressed', String(this.activeWorkspaceTab === 'history'));
    this.repositoryToolbar.update({ repository: this.repo, working: this.working, busy: this.actionBusy,
      loading: this.loadingRepo || this.metadataLoading, settings: this.settings,
      refreshLabel: m('toolbar.refresh', { shortcut: this.settings.shortcuts.refresh }) });
  }
  private async repositoryRowAction(candidate: RepositoryCandidate, anchor: HTMLElement, kind: 'branch' | 'sync' | 'commit' | 'refresh' | 'more'): Promise<void> {
    const intent = ++this.repositoryActionGeneration;
    if (!await this.activateCandidate(candidate, false) || intent !== this.repositoryActionGeneration || this.repo?.path !== candidate.path) return;
    const generation = this.openGeneration;
    if (!this.working && !await this.loadMetadata()) return;
    if (generation !== this.openGeneration || intent !== this.repositoryActionGeneration || this.repo?.path !== candidate.path) return;
    if (kind === 'branch') await this.chooseBranch(anchor.isConnected ? anchor : undefined);
    else if (kind === 'sync') await this.syncRepository();
    else if (kind === 'commit') this.showLocalCommit();
    else if (kind === 'refresh') { this.summaries.refresh(candidate.path); await this.refresh(); }
    else this.moreMenu(anchor.isConnected ? anchor : this.repositoryToolbar.element);
  }
  private async chooseBranch(anchor?: HTMLElement): Promise<void> {
    const repo = this.repo, generation = this.openGeneration; if (!repo || this.actionBusy || this.loadingRepo) return;
    const current = (): boolean => generation === this.openGeneration && this.repo?.id === repo.id && !this.disposed;
    if (!this.refs.length && !await this.loadMetadata() || !current()) return;
    await chooseRepositoryBranch({ repository: repo, refs: this.refs, current, anchor,
      remoteBranch: name => splitRemoteBranch(name, this.remotes),
      checkout: async (kind, preset) => { if (current()) await this.actions.show(kind, preset); },
    });
  }
  private async syncRepository(): Promise<void> {
    const repo = this.repo, generation = this.openGeneration; if (!repo || repo.bare || this.actionBusy) return;
    if (!this.working && !await this.loadMetadata()) return;
    if (this.openGeneration !== generation || this.repo?.id !== repo.id) return;
    if (!this.working?.upstream) {
      if (await confirmDialog(wm('configureUpstream'), wm('noUpstream'), wm('configureUpstream'))
        && generation === this.openGeneration && this.repo?.id === repo.id) await this.actions.show('set-upstream');
      return;
    }
    await this.executeWorking({ kind: 'sync', expectedHead: repo.head, pullMode: this.settings.dialogDefaults.pullMode,
      noFastForward: this.settings.dialogDefaults.pullNoFastForward,
      sign: this.settings.commitSigning === 'git' ? undefined : this.settings.commitSigning === 'sign' });
  }
  private async openHistoryDocument(request: HistoryFileRequest): Promise<void> {
    if (request.repo.id !== this.repo?.id) return;
    this.captureGraphSurface();
    await this.historyDocuments.open(request);
    this.renderDocuments();
  }
  private captureGraphSurface(): void {
    if (this.graphSurface.hidden || this.restoringGraph) return;
    this.graphScroll = { top: this.table.scrollTop, left: this.table.scrollLeft }; this.saveView();
  }
  private renderDocuments(): void {
    const history = this.historyDocuments.activeId !== null;
    if (history && !this.graphSurface.hidden) { this.captureGraphSurface(); ++this.documentGeneration; this.restoringGraph = false; }
    if (history) { this.graphSurface.hidden = true; this.historyDocuments.surface.hidden = false; this.activeWorkspaceTab = 'history'; this.renderWorkspace(); }
    else this.restoreGraphSurface();
  }
  private restoreGraphSurface(): void {
    const hidden = this.graphSurface.hidden; this.graphSurface.hidden = false; this.historyDocuments.surface.hidden = true;
    if (!hidden) return;
    const generation = ++this.documentGeneration; this.restoringGraph = true;
    const restore = (): void => {
      if (generation !== this.documentGeneration || this.graphSurface.hidden || this.disposed) return;
      this.table.scrollTop = this.graphScroll.top; this.table.scrollLeft = this.graphScroll.left;
    };
    restore(); requestAnimationFrame(() => { restore(); requestAnimationFrame(() => { restore(); if (generation === this.documentGeneration) this.restoringGraph = false; }); });
  }

  private async openRepository(path: string, scopeRoot?: string): Promise<boolean> {
    if (this.actionBusy) { this.toast(m('repository.operationRunning')); return false; }
    if (!scopeRoot) { ++this.repositoryActionGeneration; this.cancelDirectoryScan(); }
    const operation = perf.operation('openRepository'); let outcome: PerformanceOutcome = 'ok';
    try {
    this.saveView(); this.resetRepositoryWork(); this.hoverContainment(null); closeMenu();
    const generation = ++this.openGeneration, intent = this.intentEpoch; ++this.historyGeneration;
    this.restoringView = true; this.requests.cancelAll(['discovery']); this.metadataLoading = false; this.loadingRepo = true; this.loadingHistory = false;
    const request = this.requests.begin('open'); operation.request(request.id); this.openingPath = path;
    this.renderDirectory();
    this.historyOverlay.hidden = false; this.historyOverlay.replaceChildren(loading(m('repository.opening'), () => {
      this.userIntent(); this.openGeneration++; this.loadingRepo = false; this.closeRepository();
    }));
    this.buildToolbar(); this.applyLayout(); this.renderStatus();
    try {
      if (this.deactivationFlight) await this.deactivationFlight;
      if (!request.current() || generation !== this.openGeneration || this.disposed) { outcome = 'stale'; return false; }
      const repo = await operation.run(() => this.host.openRepository(path, request.id, scopeRoot));
      if (!request.current() || generation !== this.openGeneration || this.disposed) { outcome = 'stale'; return false; }
      this.saveLocalMemory(); this.historyDocuments.clear(); this.localChanges.clear(); this.measuredDetailHeight = 0;
      this.details.clear(); this.detailsOpen = false;
      this.repo = repo; this.commits = []; this.refs = []; this.stashes = []; this.remotes = []; this.working = null; this.selected = null; this.compareBase = null; this.snapshotFingerprint = ''; this.containmentCache.clear();
      this.graph.clear(); this.graphRows = []; this.topologyRevision++; this.visibleMemo = undefined;
      this.workingMemo = undefined; this.workingDirtyEpoch++; this.workingAppliedEpoch = -1;
      this.lastSuccessfulRefresh = null; this.workingError = null; this.historyError = null; this.statusResult = null;
      const local = this.localMemory.get(repo.id); this.localOpen = false; this.localDecision = local?.decision ?? null;
      this.activeWorkspaceTab = local?.tab ?? 'history'; this.graphSurface.hidden = false;
      this.renderWorkspace();
      if (!scopeRoot) {
        this.cancelDirectoryScan(); this.directoryDiscovery = null; this.store.state.directoryScope = null;
        this.directoryManualVisibility = false; this.renderDirectory();
      }
      this.openingPath = null; this.renderDirectory();
      this.historyMetadataKey = ''; this.historyReady = false; this.offset = 0; this.hasMore = false;
      const view = this.store.state.views[repo.id]; this.restoreQuery(view);
      this.store.state.lastRepo = repo.path; this.store.state.recent = [{ path: repo.path, name: repo.name }, ...this.store.state.recent.filter(item => item.path !== repo.path)].slice(0, 30); this.store.queue();
      this.details.invalidate(); this.detailSize = this.store.state.layout.detailSize; this.applySettings(); this.renderTrust(); this.renderOperation();
      this.loadingRepo = false; this.buildToolbar(); this.renderTable(true, operation.context);
      // Both children inherit open explicitly; metadata/status must not gate first history.
      const metadata = this.loadMetadata(operation.context);
      const history = this.loadHistory(true, operation.context).then(async () => {
        if (generation === this.openGeneration && intent === this.intentEpoch && this.repo?.id === repo.id && this.historyReady) {
          await this.restoreView(view, generation, intent, operation.context);
        }
      });
      await Promise.all([metadata, history]);
      if (generation !== this.openGeneration || this.repo?.id !== repo.id) { outcome = 'stale'; return false; }
      return true;
    } catch (error) {
      outcome = 'error';
      if (generation === this.openGeneration) {
        this.loadingRepo = false; this.showError(error); this.renderTable();
        if (this.repo) {
          this.historyOverlay.hidden = this.commits.length > 0;
          if (!this.commits.length) this.renderEmpty();
        } else this.renderEmpty();
        this.buildToolbar();
      }
      return false;
    } finally { if (generation === this.openGeneration) { this.restoringView = false; this.loadingRepo = false; this.openingPath = null; this.renderDirectory(); this.renderWorkspace(); this.renderTable(false, operation.context); this.renderStatus(); this.saveView(); this.refreshQueue.resume(); } request.finish(); }
    } finally { operation.end({ outcome }); }
  }
  private closeRepository(): void {
    if (this.actionBusy) { this.toast(m('repository.waitForOperation')); return; }
    this.saveView(); this.saveLocalMemory(); this.historyDocuments.clear(); this.localChanges.clear(); this.localOpen = false;
    this.resetRepositoryWork(); this.restoringView = false; this.hoverContainment(null);
    ++this.openGeneration; ++this.historyGeneration; this.requests.cancelAll(['discovery']); this.details.clear(); this.detailsOpen = false;
    this.openingPath = null; this.lastSuccessfulRefresh = null; this.workingError = null; this.historyError = null; this.statusResult = null;
    if (this.host.deactivateRepository) {
      this.deactivationFlight = (this.deactivationFlight ?? Promise.resolve()).catch(() => undefined)
        .then(() => this.host.deactivateRepository!()).catch(error => this.showError(error));
    }
    this.repo = null; this.commits = []; this.refs = []; this.working = null; this.stashes = []; this.remotes = []; this.selected = null; this.compareBase = null;
    this.loadingHistory = false; this.loadingRepo = false; this.metadataLoading = false; this.hasMore = false; this.graph.clear(); this.graphRows = [];
    this.topologyRevision++; this.visibleMemo = undefined; this.workingMemo = undefined; this.historyReady = false; this.snapshotFingerprint = ''; this.historyMetadataKey = '';
    this.store.state.lastRepo = null; this.store.queue(); this.applySettings(); this.buildToolbar(); this.renderDirectory(); this.renderTrust(); this.renderOperation(); this.renderTable(true); this.renderEmpty();
  }

  private metadataHistoryKey(): string {
    // Status fingerprints deliberately say nothing about immutable history/query membership.
    return JSON.stringify([this.repo?.head, this.repo?.branch,
      this.refs.map(ref => [ref.fullName, ref.oid, ref.kind]), this.stashes.map(stash => stash.oid)]);
  }
  private async loadMetadata(performanceContext?: PerformanceContext): Promise<boolean> {
    const repo = this.repo; if (!repo) return false;
    const operation = perf.operation('metadata', undefined, performanceContext); let outcome: PerformanceOutcome = 'ok';
    const generation = this.openGeneration, dirtyEpoch = this.workingDirtyEpoch;
    this.metadataLoading = true; this.renderWorkspace(); this.renderStatus(); const request = this.requests.begin('metadata'); operation.request(request.id);
    try {
      const snapshot = await operation.run(() => this.host.snapshot(repo.id, request.id));
      if (!request.current() || this.repo?.id !== repo.id || generation !== this.openGeneration || this.disposed) { outcome = 'stale'; return false; }
      const previousWorking = this.working;
      operation.run(() => this.applySnapshot(snapshot)); this.taskSequence++; this.lastSuccessfulRefresh = Date.now(); this.workingError = null;
      // Repeated edits can have an identical status fingerprint. Dirty epochs still refresh mutable diffs.
      if (this.workingAppliedEpoch < dirtyEpoch) {
        this.workingAppliedEpoch = dirtyEpoch;
        if (previousWorking === snapshot.working) this.localChanges.update(true);
        else if (this.selected === 'WORKTREE' && this.detailsOpen) this.details.refresh();
      }
      return true;
    } catch (error) { outcome = request.current() ? 'error' : 'cancelled'; if (request.current() && this.repo?.id === repo.id) { this.workingError = rawErrorText(error); this.showError(error); } return false; }
    finally {
      try { if (request.current()) { this.metadataLoading = false; this.renderWorkspace(); this.renderStatus(); } request.finish(); }
      finally { operation.end({ requestId: request.id, outcome }); this.refreshQueue.resume(); }
    }
  }
  private applySnapshot(snapshot: RepositorySnapshot): void {
    const previousKey = this.metadataHistoryKey();
    this.snapshotFingerprint = snapshot.fingerprint; this.repo = { ...snapshot.repository, head: snapshot.working.head !== undefined ? snapshot.working.head : snapshot.repository.head, branch: snapshot.working.branch };
    this.refs = snapshot.refs; this.working = snapshot.working; this.stashes = snapshot.stashes; this.remotes = snapshot.remotes;
    // An authoritative snapshot clears deleted/moved badges, including history that arrived first.
    this.attachRefs();
    if (previousKey !== this.metadataHistoryKey()) { this.containmentCache.clear(); this.hoverContainment(null); }
    this.buildToolbar(); this.renderTrust(); this.renderOperation(); this.renderTable();
    const knownDirty = snapshot.working.files.length > 0;
    this.localOpen = !this.repo.bare && knownDirty && this.localDecision !== false;
    if (!this.localOpen && this.activeWorkspaceTab === 'local') this.activeWorkspaceTab = 'history';
    this.summaries.override(repositorySummaryFromSnapshot(snapshot));
    this.renderWorkspace();
  }
  private attachRefs(): void {
    const settings = this.settings, byOid = new Map<string, GitRef[]>();
    for (const ref of this.refs) {
      if ((ref.kind === 'remote' && (!settings.showRemotes || (!settings.showRemoteHeads && ref.fullName.endsWith('/HEAD'))))
        || (ref.kind === 'tag' && !settings.showTags) || (ref.kind === 'stash' && !settings.showStashes)) continue;
      const list = byOid.get(ref.oid) ?? []; list.push(ref); byOid.set(ref.oid, list);
    }
    let changed = false;
    const next = this.commits.map(commit => {
      const refs = byOid.get(commit.oid) ?? [];
      const same = refs.length === commit.refs.length && refs.every((ref, index) => {
        const old = commit.refs[index]; return ref.fullName === old.fullName && ref.oid === old.oid
          && ref.kind === old.kind && ref.current === old.current && ref.name === old.name && ref.upstream === old.upstream && ref.subject === old.subject;
      });
      if (same) return commit;
      changed = true; return { ...commit, refs };
    });
    if (changed) this.commits = next;
  }
  private async loadHistory(reset: boolean, performanceContext?: PerformanceContext, retain = false): Promise<void> {
    const repo = this.repo; if (!repo || this.loadingRepo || this.actionBusy) return;
    if (!reset && (this.loadingHistory || this.autoLoadBlocked || !this.hasMore || this.commits.length >= MAX_COMMITS)) return;
    const operation = perf.operation('history', undefined, performanceContext); let outcome: PerformanceOutcome = 'ok';
    const openGeneration = this.openGeneration;
    const desired = retain ? Math.max(this.settings.initialLoad, this.commits.length) : 0;
    if (reset) {
      this.requests.cancel('history'); ++this.historyGeneration; this.autoLoadBlocked = false;
      if (!retain) {
        this.offset = 0; this.hasMore = true; this.historyReady = false;
        this.commits = []; this.graph.clear(); this.graphRows = []; this.topologyRevision++;
      }
    }
    const generation = this.historyGeneration, request = this.requests.begin('history'); operation.request(request.id);
    const current = (): boolean => request.current() && generation === this.historyGeneration
      && openGeneration === this.openGeneration && this.repo?.id === repo.id && !this.disposed;
    this.loadingHistory = true; this.queryCancel.hidden = false; this.renderTable(reset && !retain, operation.context); this.renderStatus();
    if (reset && !retain) { this.historyOverlay.hidden = false; this.historyOverlay.replaceChildren(loading(m('history.loading'), () => this.cancelLoading())); }
    const settings = this.settings, scope = structuredClone(this.scope);
    let search: string | undefined; let searchMode: HistoryQuery['searchMode'];
    if (this.queryMode === 'search' && this.search.trim()) { search = this.search.trim(); searchMode = this.searchMode; }
    let offset = reset ? 0 : this.offset, more = true;
    const replacement: Commit[] = [], known = new Set(reset ? [] : this.commits.map(commit => commit.oid));
    try {
      do {
        const limit = retain ? Math.min(1000, Math.max(settings.initialLoad, desired - replacement.length)) : reset ? settings.initialLoad : settings.loadMore;
        const page = scope.kind === 'refs' && !scope.refs?.length ? { commits: [], hasMore: false } : await operation.run(() => this.host.history({ repoId: repo.id, requestId: request.id, offset, limit, scope, search, searchMode, order: this.order, firstParent: settings.firstParent, includeReflog: settings.includeReflog, showRemotes: settings.showRemotes, showTags: settings.showTags, showStashes: settings.showStashes, mailmap: settings.mailmap, includeTagOnly: settings.includeTagOnly, showRemoteHeads: settings.showRemoteHeads, collapseStashAuxiliary: settings.collapseStashAuxiliary, markHeadAncestry: settings.muteNonAncestors }));
        if (!current()) { outcome = 'stale'; return; }
        const fresh = page.commits.filter(commit => { if (known.has(commit.oid)) return false; known.add(commit.oid); return true; });
        replacement.push(...fresh.slice(0, MAX_COMMITS - (reset ? replacement.length : this.commits.length)));
        offset += page.commits.length;
        more = page.hasMore && page.commits.length > 0 && (reset ? replacement.length : this.commits.length + replacement.length) < MAX_COMMITS;
      } while (retain && more && replacement.length < desired);
      if (!current()) { outcome = 'stale'; return; }
      const next = reset ? replacement : [...this.commits, ...replacement];
      const same = next.length === this.commits.length && next.every((commit, index) => JSON.stringify(commit) === JSON.stringify(this.commits[index]));
      if (!same) { this.commits = next; this.topologyRevision++; }
      if (this.snapshotFingerprint) this.attachRefs();
      this.offset = offset; this.hasMore = more; this.historyReady = true; this.historyError = null;
      this.historyMetadataKey = this.snapshotFingerprint ? this.metadataHistoryKey() : '';
      this.taskSequence++; this.loadingHistory = false; this.historyOverlay.hidden = true;
      this.renderTable(reset && !retain, operation.context);
      operation.paint('history-paint-opportunity', { count: this.commits.length });
      if (this.commits.length >= MAX_COMMITS && more) this.toast(m('history.limit', { count: numberText(MAX_COMMITS) }));
      if (!this.commits.length) this.renderEmpty();
    } catch (error) {
      outcome = current() ? 'error' : 'cancelled';
      if (current()) {
        this.loadingHistory = false; this.autoLoadBlocked = true; this.historyError = rawErrorText(error); this.showError(error);
        if (!retain) this.hasMore = false;
        if (!this.commits.length) {
          this.historyOverlay.hidden = false;
          this.historyOverlay.replaceChildren(empty(m('history.loadFailed'), isLocalizedMessage(error) ? error : errorText(error)), button(m('history.retry'), () => { this.queryIntent(); void this.loadHistory(true); }, 'refresh'));
        }
      }
    } finally {
      try {
        if (request.current()) { this.loadingHistory = false; this.queryCancel.hidden = true; this.renderTable(false, operation.context); this.renderStatus(); }
        request.finish();
      } finally { operation.end({ outcome, count: this.commits.length }); this.refreshQueue.resume(); }
    }
  }
  private async refresh(): Promise<void> {
    if (!this.repo || this.disposed) return;
    this.userIntent(); this.autoLoadBlocked = false; this.workingDirtyEpoch++;
    clearTimeout(this.watcherTimer); this.watcherTimer = undefined; this.refreshDebouncing = false;
    this.refreshQueue.request(RefreshFlags.History | RefreshFlags.Working | RefreshFlags.Config);
    await this.refreshQueue.idle();
  }
  private async runRefresh(mask: number): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return;
    const generation = this.openGeneration, historyGeneration = this.historyGeneration;
    const operation = perf.operation('refresh'); let outcome: PerformanceOutcome = 'ok';
    try {
      const metadata = this.loadMetadata(operation.context);
      // A forced refresh already knows history is dirty: do not put it behind slow working status.
      const parallelHistory = (mask & RefreshFlags.History) && !this.autoLoadBlocked && historyGeneration === this.historyGeneration
        ? this.loadHistory(true, operation.context, true) : undefined;
      const [loaded] = await Promise.all([metadata, parallelHistory]);
      if (!loaded || this.repo?.id !== repoId || generation !== this.openGeneration) { outcome = 'stale'; return; }
      if (!parallelHistory && !this.autoLoadBlocked && historyGeneration === this.historyGeneration
        && (!this.historyReady || this.historyMetadataKey !== this.metadataHistoryKey())) {
        // Focus/working-only refreshes still avoid unchanged history. Retain selection and viewport.
        await this.loadHistory(true, operation.context, true);
      }
      this.queueViewSave();
    } catch (error) { outcome = 'error'; throw error; }
    finally { operation.end({ outcome }); }
  }
  private cancelLoading(): void {
    this.userIntent(); clearTimeout(this.searchTimer); this.searchTimer = undefined;
    this.requests.cancel('history'); this.historyGeneration++; this.loadingHistory = false;
    this.autoLoadBlocked = true; this.queryCancel.hidden = true;
    this.statusResult = { id: `history-cancelled-${this.historyGeneration}`, kind: 'cancelled', message: m('history.cancelled'), repoId: this.repo?.id, at: Date.now() };
    this.refreshQueue.cancel();
    this.historyOverlay.hidden = this.commits.length > 0;
    if (!this.commits.length) this.historyOverlay.replaceChildren(empty(m('history.cancelled')), button(m('history.load'), () => { this.queryIntent(); void this.loadHistory(true); }, 'refresh'));
    this.renderTable(); this.renderStatus(); this.saveView(); this.refreshQueue.resume();
  }

  private visibleCommits(): Commit[] {
    const filter = { ...this.filter, text: this.queryMode === 'filter' ? this.search : '', mode: this.searchMode, dateSource: this.settings.dateSource };
    const key = JSON.stringify(filter), memo = this.visibleMemo;
    if (memo?.source === this.commits && memo.revision === this.topologyRevision && memo.key === key) return memo.commits;
    const commits = !filter.text && !this.hasAdvancedFilters() ? this.commits : this.commits.filter(commit => matchesCommit(commit, filter));
    this.visibleMemo = { source: this.commits, revision: this.topologyRevision, key, commits };
    return commits;
  }
  private visibleWorking(): WorkingState | null {
    const settings = this.settings;
    const source = this.repo && !this.repo.bare && settings.showUncommitted && (this.scope.kind === 'all' || this.scope.kind === 'head')
      && !this.search && !this.hasAdvancedFilters() ? this.working : null;
    if (!source) return null;
    if (this.workingMemo?.source === source && this.workingMemo.untracked === settings.showUntracked) return this.workingMemo.value;
    const value = settings.showUntracked ? source : { ...source, files: source.files.filter(file => !file.status.startsWith('?')) };
    this.workingMemo = { source, untracked: settings.showUntracked, value }; return value;
  }
  private renderTable(reset = false, performanceContext = perf.context()): void {
    const modelSpan = perf.span('table', 'model', undefined, performanceContext);
    try {
    const visible = this.visibleCommits();
    const settings = this.settings;
    const working = this.visibleWorking();
    const before = this.graph.preparePasses;
    const graphSpan = perf.span('graph', 'prepare', { count: this.commits.length }, performanceContext);
    try {
      this.graphRows = this.graph.prepare({ commits: this.commits, visible, topologyRevision: this.topologyRevision,
        workingHead: working ? this.repo?.head ?? null : undefined });
    } finally { graphSpan.end({ renderedCount: this.graphRows.length, cacheHit: this.graph.preparePasses === before }); }
    const inline = this.detailsOpen && settings.detailPosition === 'inline' && this.selected && (this.selected === 'WORKTREE' && working || visible.some(commit => commit.oid === this.selected)) ? { oid: this.selected, element: this.details.element, height: Math.max(this.details.preferredHeight, this.measuredDetailHeight), side: this.inlineSide } : undefined;
    const waitingWorking = this.detailsOpen && this.selected === 'WORKTREE' && !this.working;
    perf.run(performanceContext, () => this.table.setModel({ commits: visible, graph: this.graphRows, working, settings, selected: this.selected, compareBase: this.compareBase, head: this.repo?.head ?? null, hasMore: this.hasMore, loading: this.loadingHistory, totalLoaded: this.commits.length, inline, pauseAutoLoad: this.restoringView || this.autoLoadBlocked }, reset));
    if (this.detailsOpen && settings.detailPosition === 'inline' && !inline && !waitingWorking) { this.detailsOpen = false; this.details.clear(); this.applyLayout(); }
    this.filterButton.classList.toggle('active', this.hasAdvancedFilters()); this.filterButton.setAttribute('aria-pressed', String(this.hasAdvancedFilters()));
    this.renderStatus();
    if (this.repo && !this.loadingHistory && this.commits.length && !visible.length) { this.historyOverlay.hidden = false; this.historyOverlay.replaceChildren(empty(m('history.noFilteredCommits'), m(this.hasMore ? 'history.filterMoreHint' : 'history.filterHint')), button(m('history.clearFilters'), () => this.clearFilters(), 'close')); }
    else if (this.repo && visible.length && !this.loadingHistory) this.historyOverlay.hidden = true;
    } finally { modelSpan.end({ count: this.commits.length }); }
  }
  private renderEmpty(): void {
    this.historyOverlay.hidden = false;
    if (!this.initialized) { this.historyOverlay.replaceChildren(loading(m('history.preferencesLoading'))); return; }
    if (!this.repo) {
      const browser = this.diagnostics?.hostMode === 'browser';
      const byPath = button(m('repository.openByPath'), () => { void this.openByPath(); }, 'folder'); byPath.dataset.action = 'open-repository-by-path';
      this.historyOverlay.replaceChildren(empty(m(browser ? 'history.desktopRequired' : 'history.noRepository'), m(browser ? 'history.browserHint' : 'history.openHint')), button(m('repository.openMenu'), () => { void this.openPicker(); }, 'open'), byPath);
    } else if (!this.commits.length) {
      const constrained = Boolean(this.search) || this.scope.kind !== 'all';
      this.historyOverlay.replaceChildren(empty(m(constrained ? 'history.noMatches' : 'history.noCommits'), m(this.search ? 'history.searchHint' : 'history.unbornHint')), button(m('menu.openTerminal'), () => { void this.openTerminal(); }, 'terminal'), ...(constrained ? [button(m('history.clearSearchScope'), () => { this.scope = { kind: 'all' }; this.clearFilters(); this.buildToolbar(); })] : []));
    } else this.historyOverlay.hidden = true;
    this.renderStatus();
  }
  private hasAdvancedFilters(): boolean { return Boolean(this.filter.author || this.filter.hash || this.filter.refs || this.filter.after || this.filter.before); }
  private clearFilters(): void {
    this.queryIntent(); this.search = ''; this.searchInput.value = ''; this.filter = { text: '', mode: this.searchMode }; this.saveView(); void this.loadHistory(true);
  }
  private async advancedFilter(): Promise<void> {
    const values = await formDialog({ title: m('filter.title'), description: m('filter.description'), fields: [
      { name: 'author', label: m('filter.author'), value: this.filter.author ?? '' },
      { name: 'hash', label: m('filter.hash'), value: this.filter.hash ?? '' },
      { name: 'refs', label: m('filter.refs'), value: this.filter.refs ?? '' },
      { name: 'after', label: m('filter.after'), value: this.filter.after ?? '' },
      { name: 'before', label: m('filter.before'), value: this.filter.before ?? '' },
    ], confirm: m('filter.apply'), validate: values => {
      for (const name of ['after', 'before']) if (values[name] && (!/^\d{4}-\d{2}-\d{2}$/.test(String(values[name])) || !Number.isFinite(Date.parse(String(values[name]))))) return m('filter.invalidDate');
      if (values.after && values.before && String(values.after) > String(values.before)) return m('filter.invalidRange');
      return null;
    } });
    if (!values) return;
    this.queryIntent(); this.filter = { text: this.queryMode === 'filter' ? this.search : '', mode: this.searchMode, author: String(values.author), hash: String(values.hash), refs: String(values.refs), after: String(values.after), before: String(values.before) }; this.renderTable(); this.saveView();
  }

  private selectCommit(oid: string, compare: boolean, intent: 'toggle' | 'ensure-open' = 'ensure-open'): void {
    if (!this.repo) return;
    if (oid === 'WORKTREE') { this.showLocalCommit(); return; }
    if (!compare && intent === 'toggle' && this.selected === oid && this.detailsOpen) { this.closeDetails(); return; }
    if (!compare) { this.inlineSide = this.table.chooseInlineSide(oid); this.details.setInlineSide(this.inlineSide); }
    this.userIntent(); this.hoverContainment(null);
    const operation = perf.operation('commitSelection', { oid }); let waitsForDetails = false;
    try {
    let selection: DetailSelection | null = null;
    if (compare && oid !== 'WORKTREE') {
      const base = this.compareBase ?? (this.selected && this.selected !== 'WORKTREE' ? this.selected : null);
      if (base && base !== oid) { this.compareBase = base; this.selected = oid; selection = { kind: 'compare', base, target: oid }; }
      else { this.compareBase = oid; this.selected = oid; this.toast(m('selection.base', { oid: shortOid(oid) })); }
    } else { this.selected = oid; this.compareBase = null; selection = oid === 'WORKTREE' ? { kind: 'working' } : { kind: 'commit', oid }; }
    if (selection) this.openDetails();
    this.renderTable(false, operation.context); operation.paint('selection-feedback');
    if (selection && this.settings.detailPosition !== 'inline' && this.settings.autoCenterDetails) this.table.reveal(oid, true);
    if (selection) {
      waitsForDetails = true;
      void this.details.show(selection, false, undefined, operation.context).then(() => this.queueViewSave())
        .catch(error => this.showError(error)).finally(() => operation.end());
    }
    this.saveView();
    } finally { if (!waitsForDetails) operation.end(); }
  }
  private openDetails(): void { this.detailsOpen = true; this.details.element.hidden = false; this.applyLayout(); }
  private closeDetails(): void { this.userIntent(); this.details.clear(); this.detailsOpen = false; this.compareBase = null; this.applyLayout(); this.renderTable(); this.saveView(); this.table.focus(); }
  private followCommit(oid: string): void {
    if (!this.commits.some(commit => commit.oid === oid) && this.settings.detailPosition === 'inline') this.updateSettings({ detailPosition: 'bottom' });
    this.selectCommit(oid, false);
    if (this.commits.some(commit => commit.oid === oid)) this.table.focus(oid); else this.toast(m('selection.outsideHistory'));
  }
  private async revealHead(): Promise<void> {
    const repo = this.repo, head = repo?.head; if (!repo || !head) { this.toast(m('selection.noHead')); return; }
    this.userIntent(); this.autoLoadBlocked = false;
    if (!this.visibleCommits().some(commit => commit.oid === head)) {
      this.queryIntent(); const intent = this.intentEpoch;
      this.scope = { kind: 'head' }; this.search = ''; this.searchInput.value = ''; this.searchMode = 'all'; this.filter = { text: '', mode: 'all' }; this.queryMode = 'filter'; this.searchScope.value = 'filter'; this.searchType.value = 'all'; this.buildToolbar();
      await this.loadHistory(true);
      while (intent === this.intentEpoch && !this.autoLoadBlocked && this.repo?.id === repo.id && this.hasMore && !this.commits.some(commit => commit.oid === head)) { const count = this.commits.length; await this.loadHistory(false); if (this.commits.length === count) break; }
      if (intent !== this.intentEpoch || this.autoLoadBlocked) return;
    }
    if (this.repo?.id === repo.id && this.commits.some(commit => commit.oid === head)) { this.selectCommit(head, false); this.table.focus(head, true); this.saveView(); }
  }
  private async cycleStash(): Promise<void> {
    if (!this.repo) return;
    if (!this.stashes.length) { this.toast(m('stash.noneInRepository')); return; }
    const index = this.stashes.findIndex(stash => stash.oid === this.selected), stash = this.stashes[(index + 1) % this.stashes.length];
    if (!this.visibleCommits().some(commit => commit.oid === stash.oid)) { await this.showStashDetail(stash.selector); return; }
    this.selectCommit(stash.oid, false); this.table.focus(stash.oid, true);
  }
  private async navigateBranch(oid: string, direction: 'parent' | 'child', alternate: boolean): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return;
    this.userIntent(); const intent = this.intentEpoch;
    let commits = this.commits;
    if (direction === 'parent' && !commits.some(commit => commit.oid === oid)) {
      const request = this.requests.begin('navigation');
      try { const detail = await this.host.commitDetail(repoId, oid, request.id); if (!request.current() || this.repo?.id !== repoId || intent !== this.intentEpoch) return; commits = [...commits, detail.commit]; } catch (error) { if (request.current()) this.showError(error); } finally { request.finish(); }
    }
    const candidates = branchNeighbours(commits, oid, direction, alternate);
    if (!candidates.length) { this.toast(m(direction === 'parent' ? alternate ? 'navigation.noAlternateParent' : 'navigation.noParent' : 'navigation.noChild')); return; }
    let target = candidates[0];
    if (candidates.length > 1) {
      const values = await formDialog({ title: m(direction === 'parent' ? 'navigation.chooseParent' : 'navigation.chooseChild'), fields: [{ name: 'oid', label: m('navigation.commit'), type: 'select', value: target, options: candidates.map(value => ({ value, label: `${shortOid(value)} · ${commits.find(commit => commit.oid === value)?.subject ?? value}` })) }], confirm: m('navigation.go') });
      if (!values || this.repo?.id !== repoId || intent !== this.intentEpoch) return; target = String(values.oid);
    }
    this.followCommit(target); this.table.reveal(target, true);
  }

  private hoverContainment(oid: string | null, anchor?: HTMLElement): void {
    clearTimeout(this.hoverTimer); this.requests.cancel('hover-containment'); this.hoverAnchor?.removeAttribute('aria-describedby'); this.containmentTip.hidden = true; this.hoverOid = oid; this.hoverAnchor = anchor;
    const repoId = this.repo?.id; if (!oid || !repoId || !anchor || overlayOpen()) return;
    this.hoverTimer = setTimeout(() => {
      const request = this.requests.begin('hover-containment'); const key = `${repoId}:${oid}`;
      void (async () => {
        try {
          const data = this.containmentCache.get(key) ?? await this.host.containment(repoId, oid, request.id);
          if (!request.current() || this.repo?.id !== repoId || this.hoverOid !== oid || !anchor.isConnected || overlayOpen()) return;
          this.containmentCache.set(key, data); const names = data.refs.map(ref => ref.name);
          this.containmentTip.replaceChildren(el('strong', '', m('containment.contains', { oid: shortOid(oid) })), el('span', 'muted', m(data.head ? 'containment.inHead' : 'containment.notInHead')), el('span', '', names.length ? names.length > 20 ? m('containment.moreNames', { names: names.slice(0, 20).join(', '), count: numberText(names.length - 20) }) : names.join(', ') : m('containment.noRefs')));
          this.containmentTip.hidden = false; const rect = anchor.getBoundingClientRect(); this.containmentTip.style.left = `${Math.max(8, Math.min(rect.left + this.settings.columnWidths.graph, window.innerWidth - 400))}px`; this.containmentTip.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - this.containmentTip.offsetHeight - 8))}px`; anchor.setAttribute('aria-describedby', this.containmentTip.id);
        } catch { /* Hover lookup is supplemental; the explicit menu offers errors and retry. */ } finally { request.finish(); }
      })();
    }, 450);
  }
  private async showContainment(oid: string): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return; const request = this.requests.begin('containment');
    try { const result = await this.host.containment(repoId, oid, request.id); if (!request.current() || this.repo?.id !== repoId) return; this.containmentCache.set(`${repoId}:${oid}`, result); const list = el('div', 'manager-list', el('p', 'muted', m(result.head ? 'containment.contained' : 'containment.notContained')));
      for (const ref of result.refs) list.append(button(ref.name, () => this.setScope({ kind: 'refs', refs: [ref.fullName] }), ref.kind === 'tag' ? 'tag' : 'branch'));
      if (!result.refs.length) list.append(empty(m('containment.empty'))); await this.managerDialog(m('containment.title', { oid: shortOid(oid) }), list, () => undefined);
    } catch (error) { if (request.current() && this.repo?.id === repoId) this.showError(error); } finally { request.finish(); }
  }
  private openUrl(url: string): void { void this.host.openUrl(url).catch(error => this.showError(error)); }
  private externalSessionChanged(session: ExternalSession): void {
    if (this.disposed) return; this.sessions.set(session.id, session);
    if (this.sessions.size > 100) for (const [id, value] of this.sessions) { if (['completed', 'failed'].includes(value.status)) { this.sessions.delete(id); if (this.sessions.size <= 100) break; } }
    if (session.repoId !== this.repo?.id) return;
    if (session.status === 'paused') {
      this.taskSequence++; this.toast(m('session.pausedToast', { kind: actionLabel(session.kind) }));
      this.workingDirtyEpoch++; this.refreshQueue.request(RefreshFlags.Working);
    }
    if (session.status === 'completed' || session.status === 'failed') {
      this.taskSequence++; this.toast(session.status === 'completed' ? m('session.completedToast', { kind: actionLabel(session.kind) }) : session.exitCode !== null ? m('session.failedCodeToast', { kind: actionLabel(session.kind), code: session.exitCode }) : m('session.failedToast', { kind: actionLabel(session.kind) }));
      this.workingDirtyEpoch++; this.refreshQueue.request(RefreshFlags.History | RefreshFlags.Working | RefreshFlags.Config);
    }
    this.renderOperation(); this.renderStatus();
  }
  private async showStashDetail(selector: string): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return; const request = this.requests.begin('stash-detail');
    try { const detail = await this.host.stashDetail(repoId, selector, request.id); if (!request.current() || this.repo?.id !== repoId) return;
      const body = el('div', 'metadata-dialog-body', renderMessage(detail.message, this.settings, url => this.openUrl(url)), el('pre', 'output-text', m('stash.metadata', { selector: detail.selector, oid: detail.oid, base: detail.base, index: detail.index, untracked: detail.untracked ?? m('none'), created: fullDateText(detail.timestamp) })));
      body.append(button(m('stash.viewChanges'), () => this.followCommit(detail.oid), 'eye')); await this.managerDialog(m('stash.title', { selector: detail.selector }), body, () => undefined);
    } catch (error) { if (request.current() && this.repo?.id === repoId) this.showError(error); } finally { request.finish(); }
  }
  private async showTagDetail(ref: GitRef): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return; const request = this.requests.begin('tag-detail');
    try { const detail = await this.host.tagDetail(repoId, ref.fullName, request.id); if (!request.current() || this.repo?.id !== repoId) return;
      const body = el('div', 'metadata-dialog-body', el('pre', 'output-text', m('tag.metadata', { name: detail.name, ref: detail.ref, oid: detail.oid, target: detail.targetOid, type: detail.targetType, annotated: m(detail.annotated ? 'yes' : 'no'), tagger: detail.tagger, email: detail.email, date: detail.timestamp === null ? '—' : fullDateText(detail.timestamp), signature: signatureText(detail.signature.status), signer: detail.signature.signer, key: detail.signature.key })), renderMessage(detail.message, this.settings, url => this.openUrl(url)));
      const verify = button(m('tag.verify'), () => { void (async () => { if (!await this.actions.trust() || this.repo?.id !== repoId) return; const verifyRequest = this.requests.begin('verify-tag'); try { const result = await this.host.verify({ repoId, requestId: verifyRequest.id, kind: 'tag', target: detail.ref }); if (!verifyRequest.current() || this.repo?.id !== repoId) return; await textDialog(m('tag.verificationTitle'), m('tag.verification', { status: signatureText(result.status), signer: result.signer, key: result.key, output: result.output })); } catch (error) { if (verifyRequest.current()) this.showError(error); } finally { verifyRequest.finish(); } })(); }, 'shield'); verify.dataset.action = 'verify-tag'; body.append(verify); await this.managerDialog(m('tag.title', { name: detail.name }), body, () => undefined);
    } catch (error) { if (request.current() && this.repo?.id === repoId) this.showError(error); } finally { request.finish(); }
  }
  private async showSubmodules(): Promise<void> {
    const repo = this.repo; if (!repo) return; const request = this.requests.begin('submodules');
    try { const modules = await this.host.submodules(repo.id, request.id); if (!request.current() || this.repo?.id !== repo.id) return; const list = el('div', 'manager-list'); let close: (() => void) | undefined;
      for (const module of modules) { const row = el('div', 'manager-row', el('div', 'manager-description', el('strong', '', module.path), el('span', 'mono wrap', module.url), el('small', 'muted', m('submodule.state', { state: module.initialized ? m('submodule.head', { oid: shortOid(module.head ?? '') }) : m('submodule.notInitialized'), modified: module.modified ? m('submodule.modified') : '', untracked: module.untracked ? m('submodule.untracked') : '' })))); const open = button(m('repository.openTitle'), () => { close?.(); void this.openRepository(`${repo.path.replace(/[\\/]$/, '')}/${module.path}`); }, 'open'); open.disabled = !module.initialized; row.append(open); list.append(row); }
      if (!modules.length) list.append(empty(m('submodule.empty'))); await this.managerDialog(m('submodule.title'), list, callback => { close = callback; });
    } catch (error) { if (request.current() && this.repo?.id === repo.id) this.showError(error); } finally { request.finish(); }
  }
  private async archive(target: string): Promise<void> {
    const repoId = this.repo?.id; if (!repoId || !await this.actions.trust()) return;
    const values = await formDialog({ title: m('archive.title'), fields: [{ name: 'target', label: m('archive.target'), value: target, required: true }, { name: 'format', label: m('archive.format'), type: 'select', value: 'zip', options: [{ value: 'zip', label: 'ZIP' }, { value: 'tar', label: 'TAR' }] }, { name: 'prefix', label: m('archive.prefix'), value: '' }], confirm: m('archive.destination') });
    if (!values || this.repo?.id !== repoId) return; const request = this.requests.begin('archive');
    try { const saved = await this.host.archive({ repoId, requestId: request.id, target: String(values.target), format: values.format === 'tar' ? 'tar' : 'zip', prefix: String(values.prefix) || undefined }); if (request.current() && this.repo?.id === repoId && saved) this.toast(m('archive.exported')); } catch (error) { if (request.current()) this.showError(error); } finally { request.finish(); }
  }
  private async createPullRequest(source?: string): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return;
    const values = await formDialog({ title: m('pullRequest.createTitle'), description: m('pullRequest.description'), fields: [{ name: 'remote', label: m('pullRequest.remote'), type: 'select', value: this.settings.defaultRemote, options: this.remotes.map(remote => ({ value: remote.name, label: remote.name })) }, { name: 'source', label: m('pullRequest.source'), value: source ?? this.repo?.branch ?? '', required: true }, { name: 'target', label: m('pullRequest.target'), value: 'main', required: true }, { name: 'provider', label: m('pullRequest.provider'), type: 'select', value: '', options: [{ value: '', label: m('pullRequest.detect') }, ...this.settings.pullRequestProviders.map(provider => ({ value: provider.name, label: provider.name })), { value: 'GitHub', label: 'GitHub' }, { value: 'GitLab', label: 'GitLab' }, { value: 'Bitbucket', label: 'Bitbucket' }] }], confirm: m('pullRequest.openProvider') });
    if (!values || this.repo?.id !== repoId) return; const remote = this.remotes.find(item => item.name === values.remote); const url = remote ? buildPullRequestUrl(remote.fetchUrl, String(values.source), String(values.target), String(values.provider) || undefined, this.settings.pullRequestProviders) : null;
    if (url) this.openUrl(url); else this.showError(m('pullRequest.unsafeUrl'));
  }

  private commitMenu(oid: string, x: number, y: number, restore: HTMLElement): void {
    const commit = this.commits.find(item => item.oid === oid);
    const items: (MenuItem | null)[] = [];
    if (oid === 'WORKTREE') {
      items.push({ label: m('menu.inspectWorking'), icon: 'eye', action: () => this.selectCommit(oid, false) }, this.actions.item('stash-save', {}, 'stash'), this.actions.item('commit', {}, 'commit'), this.actions.item('reset', { target: 'HEAD', mode: this.settings.dialogDefaults.worktreeResetMode }, 'undo'), this.actions.item('clean', {}, 'warning'));
    } else {
      items.push({ label: m('menu.commitDetails'), icon: 'eye', action: () => this.selectCommit(oid, false) }, { label: m('menu.copyCommit'), icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copy(oid) }, { label: m('menu.copyMessage'), action: () => this.copy(commit?.subject ?? oid) }, null,
        { label: m('menu.comparisonBase'), icon: 'compare', action: () => { this.userIntent(); this.compareBase = oid; this.selected = oid; this.renderTable(); this.saveView(); this.toast(m('selection.baseSet')); } },
        { label: m('menu.compareSelected'), icon: 'compare', disabled: !this.selected || this.selected === oid || this.selected === 'WORKTREE', action: () => { this.userIntent(); const base = this.selected!; this.compareBase = base; this.selected = oid; this.openDetails(); void this.details.show({ kind: 'compare', base, target: oid }); this.renderTable(); this.saveView(); } },
        { label: m('menu.compareHead'), icon: 'compare', disabled: !this.repo?.head || this.repo.head === oid, action: () => { this.userIntent(); this.compareBase = this.repo!.head; this.selected = oid; this.openDetails(); void this.details.show({ kind: 'compare', base: this.repo!.head!, target: oid }); this.renderTable(); this.saveView(); } }, null,
        this.actions.item('checkout', { target: oid }, 'branch'), this.actions.item('branch-create', { target: oid }, 'branch'), this.actions.item('tag-create', { target: oid }, 'tag'), null,
        this.actions.item('merge', { target: oid }, 'merge'), this.actions.item('rebase', { target: oid }), this.actions.item('cherry-pick', { target: oid }), this.actions.item('revert', { target: oid }, 'undo'), this.actions.item('reset', { target: oid }), this.actions.item('drop', { target: oid }));
      items.push(null, { label: m('menu.containment'), icon: 'branch', action: () => { void this.showContainment(oid); } }, { label: m('menu.archive'), icon: 'export', action: () => { void this.archive(oid); } });
      if (commit?.nodeKind === 'stash') { const stash = this.stashes.find(item => item.oid === oid); if (stash) items.push({ label: m('menu.stashMetadata'), icon: 'stash', action: () => { void this.showStashDetail(stash.selector); } }, ...(['stash-apply', 'stash-pop', 'stash-branch', 'stash-drop'] as const).map(kind => this.actions.item(kind, { target: stash.selector }, 'stash'))); }
      if (this.settings.pullRequestUrl) items.push(null, { label: m('menu.openPullRequest'), icon: 'external', action: () => { void this.openPrLink(oid); } });
      if (this.remotes.length) items.push({ label: m('menu.createPullRequest'), icon: 'external', action: () => { void this.createPullRequest(); } });
    }
    items.push(null, { label: m('menu.openTerminal'), icon: 'terminal', action: () => { void this.openTerminal(); } });
    contextMenu(this.cleanMenu(items, oid === 'WORKTREE' ? 'worktree' : commit?.nodeKind === 'stash' ? 'stash' : 'commit'), { x, y }, restore);
  }
  private refMenu(ref: GitRef, x: number, y: number, restore: HTMLElement): void {
    const items: (MenuItem | null)[] = [
      { label: m('menu.showHistory', { ref: ref.name }), icon: 'branch', action: () => this.setScope({ kind: 'refs', refs: [ref.fullName] }) },
      { label: m('menu.copyRef'), icon: 'copy', action: () => this.copy(ref.name) }, this.actions.item('checkout', { target: ref.kind === 'branch' ? ref.name : ref.fullName }, 'branch'),
    ];
    if (ref.kind === 'branch') items.push(this.actions.item('branch-create', { target: ref.fullName }), this.actions.item('branch-rename', { target: ref.name }), this.actions.item('branch-delete', { target: ref.name }), this.actions.item('push', { branch: ref.name }, 'arrowUp'), this.actions.item('merge', { target: ref.fullName }), this.actions.item('rebase', { target: ref.fullName }), { label: m('menu.createPullRequest'), icon: 'external', disabled: !this.remotes.length, action: () => { void this.createPullRequest(ref.name); } }, { label: m('menu.branchArchive'), icon: 'export', action: () => { void this.archive(ref.fullName); } });
    else if (ref.kind === 'tag') items.push({ label: m('menu.tagMetadata'), icon: 'tag', action: () => { void this.showTagDetail(ref); } }, this.actions.item('tag-delete', { target: ref.name }), this.actions.item('tag-push', { target: ref.name }), { label: m('menu.tagArchive'), icon: 'export', action: () => { void this.archive(ref.fullName); } });
    else if (ref.kind === 'remote') {
      const remote = [...this.remotes].sort((a, b) => b.name.length - a.name.length).find(item => ref.name.startsWith(`${item.name}/`));
      const branch = remote ? ref.name.slice(remote.name.length + 1) : ref.name;
      if (remote) items.push(this.actions.item('checkout-remote', { remote: remote.name, target: branch, name: branch }, 'branch'), this.actions.item('remote-branch-delete', { remote: remote.name, target: branch }, 'warning'), this.actions.item('fetch-into', { remote: remote.name, target: branch, branch }, 'arrowDown'), this.actions.item('pull', { remote: remote.name, branch }, 'arrowDown'), this.actions.item('merge', { target: ref.fullName }, 'merge'), this.actions.item('set-upstream', { remote: remote.name, target: branch }));
    } else if (ref.kind === 'stash') {
      const stash = this.stashes.find(item => item.oid === ref.oid || item.selector === ref.name); const target = stash?.selector ?? ref.name;
      items.push({ label: m('menu.viewStashMetadata'), icon: 'stash', action: () => { void this.showStashDetail(target); } }, ...(['stash-apply', 'stash-pop', 'stash-branch', 'stash-drop'] as const).map(kind => this.actions.item(kind, { target }, 'stash')));
    }
    contextMenu(this.cleanMenu(items, ref.kind === 'remote' ? 'remoteBranch' : ref.kind), { x, y }, restore);
  }
  private cleanMenu(items: (MenuItem | null)[], context?: 'branch' | 'remote' | 'remoteBranch' | 'commit' | 'tag' | 'stash' | 'worktree'): (MenuItem | null)[] {
    const configured = context ? this.settings.contextActions[context] ?? (context === 'remoteBranch' ? this.settings.contextActions.remote : undefined) : undefined;
    const actionKind = (item: MenuItem): ActionKind | undefined => item.dataAction ? ACTION_KIND_BY_DATA_ID.get(item.dataAction) : undefined;
    let filtered = items.filter(item => !item || !actionKind(item) || !configured || configured.includes(actionKind(item)!));
    if (configured) {
      const ordered = filtered.filter((item): item is MenuItem => Boolean(item && actionKind(item))).sort((a, b) => configured.indexOf(actionKind(a)!) - configured.indexOf(actionKind(b)!));
      let index = 0; filtered = filtered.map(item => item && actionKind(item) ? ordered[index++] : item);
    }
    const cleaned: (MenuItem | null)[] = [];
    for (const item of filtered) { if (item || cleaned.length && cleaned.at(-1) !== null) cleaned.push(item); }
    if (cleaned.at(-1) === null) cleaned.pop(); return cleaned;
  }
  private moreMenu(control: HTMLElement): void {
    const repo = this.repo, generation = this.openGeneration; if (!repo) return;
    const items: (MenuItem | null)[] = [];
    for (const group of ACTION_GROUPS) { const groupItems = group.kinds.filter(kind => !['branch-create', 'branch-rename', 'branch-delete', 'checkout', 'tag-create', 'tag-delete', 'tag-push'].includes(kind)).map(kind => this.actions.item(kind)).filter((item): item is MenuItem => item !== null); const configured = this.cleanMenu(groupItems, ACTION_GROUP_CONTEXT[group.id]); if (configured.length) { if (items.length) items.push(null); items.push(...configured); } }
    items.push(null, { label: m('menu.openTerminal'), icon: 'terminal', action: () => { void this.openTerminal(); } }, ...(this.actions.visible('identity') ? [{ label: m('menu.identity'), icon: 'identity' as const, action: () => { void this.actions.show('identity'); } }] : []), { label: m('menu.exportConfiguration'), icon: 'export', action: () => { void this.host.exportConfig(this.repo?.id ?? null).catch(error => this.showError(error)); } }, { label: m(this.repo?.trusted ? 'menu.revokeTrust' : 'menu.trust'), icon: 'shield', action: () => { void this.toggleTrust(); } });
    items.push(null, { label: m('menu.submodules'), icon: 'folder', dataAction: 'submodules', action: () => { void this.showSubmodules(); } }, { label: m('menu.archive'), icon: 'export', action: () => { void this.archive(this.repo?.head ?? 'HEAD'); } }, { label: m('menu.createPullRequest'), icon: 'external', disabled: !this.remotes.length, action: () => { void this.createPullRequest(); } }, { label: m('menu.resumeReview'), icon: 'eye', action: () => { void this.showReviews(); } }, { label: m('menu.endReviews'), icon: 'stop', action: () => { this.store.endAllReviews(this.repo?.id); this.details.updateSettings(); } });
    items.push(null, { label: m('stashes.title'), icon: 'stash', dataAction: 'stash', action: () => { void this.showStashes(); } },
      { label: m('toolbar.remotes'), icon: 'remote', action: () => { void this.showRemotes(); } });
    const scoped = this.cleanMenu(items).map(item => item ? { ...item, action: () => {
      if (this.repo?.id === repo.id && this.openGeneration === generation) item.action();
    } } : null);
    menuAtButton(control, scoped);
  }
  private async showReviews(): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return;
    const reviews = this.store.state.reviews.filter(review => review.repoId === repoId && review.selection);
    if (!reviews.length) { this.toast(m('review.empty')); return; }
    const values = await formDialog({ title: m('review.title'), fields: [{ name: 'key', label: m('review.session'), type: 'select', value: reviews[0].key, options: reviews.map(review => ({ value: review.key, label: m(review.active ? 'review.activeOption' : 'review.option', { key: review.key, count: numberText(review.paths.length) }) })) }], confirm: m('review.resume') });
    if (!values || this.repo?.id !== repoId) return; const review = reviews.find(item => item.key === values.key); if (!review?.selection) return;
    this.userIntent(); this.store.startReview(review.key, repoId, review.selection);
    const selection = review.selection as DetailSelection; this.selected = selection.kind === 'commit' ? selection.oid : selection.kind === 'compare' ? selection.target : 'WORKTREE'; this.compareBase = selection.kind === 'compare' ? selection.base : null;
    if (this.settings.detailPosition === 'inline' && !this.visibleCommits().some(commit => commit.oid === this.selected)) this.updateSettings({ detailPosition: 'bottom' });
    this.openDetails(); this.renderTable(); await this.details.show(selection); this.saveView();
  }

  private async showStashes(): Promise<void> {
    const repo = this.repo; if (!repo) return;
    const request = this.requests.begin('stash-panel');
    try {
      const stashes = await this.host.stashes(repo.id, request.id); if (!request.current() || this.repo?.id !== repo.id) return; this.stashes = stashes;
      const list = el('div', 'manager-list');
      let close: (() => void) | undefined;
      if (!this.stashes.length) list.append(empty(m('stashes.empty'), m('stashes.hint')));
      for (const stash of this.stashes) {
        const row = el('div', 'manager-row', el('div', 'manager-description', el('strong', 'mono', stash.selector), el('span', '', stash.message), el('small', 'muted mono', shortOid(stash.oid))));
        row.append(button(m('stashes.inspect'), () => { close?.(); void this.showStashDetail(stash.selector); }, 'info', '', true), button(m('stash.viewChanges'), () => { close?.(); this.followCommit(stash.oid); }, 'eye', '', true));
        for (const [kind, label] of [['stash-apply', m('stashes.apply')], ['stash-pop', m('stashes.pop')], ['stash-branch', m('stashes.branch')], ['stash-drop', m('stashes.drop')]] as const) if (this.actions.visible(kind)) row.append(button(label, () => { close?.(); void this.actions.show(kind, { target: stash.selector }); }, undefined, kind === 'stash-drop' ? 'danger-text' : ''));
        list.append(row);
      }
      const footer = el('div', 'inline-actions');
      if (this.actions.visible('stash-save')) footer.append(button(m('stashes.save'), () => { close?.(); void this.actions.show('stash-save'); }, 'plus'));
      list.append(footer);
      await this.managerDialog(m('stashes.title'), list, callback => { close = callback; });
    } catch (error) { if (request.current()) this.showError(error); } finally { request.finish(); }
  }
  private async showRemotes(): Promise<void> {
    const repo = this.repo; if (!repo) return;
    const request = this.requests.begin('remote-panel');
    try {
      const remotes = await this.host.remotes(repo.id, request.id); if (!request.current() || this.repo?.id !== repo.id) return; this.remotes = remotes;
      const list = el('div', 'manager-list'); let close: (() => void) | undefined;
      if (!this.remotes.length) list.append(empty(m('remotes.empty'), m('remotes.hint')));
      for (const remote of this.remotes) {
        const description = el('div', 'manager-description', el('strong', '', remote.name), el('span', 'mono wrap', remote.fetchUrl));
        if (remote.pushUrl !== remote.fetchUrl) description.append(el('small', 'mono muted wrap', m('remotes.pushUrl', { url: remote.pushUrl })));
        const row = el('div', 'manager-row', description);
        for (const [kind, label] of [['fetch', m('remotes.fetch')], ['prune', m('remotes.prune')], ['remote-edit', m('remotes.edit')], ['remote-remove', m('remotes.remove')]] as const) if (this.actions.visible(kind)) row.append(button(label, () => { close?.(); void this.actions.show(kind, { remote: remote.name, url: remote.fetchUrl }); }, undefined, kind === 'remote-remove' ? 'danger-text' : ''));
        row.append(button(m('remotes.copyFetchUrl'), () => this.copy(remote.fetchUrl), 'copy', '', true)); list.append(row);
      }
      const footer = el('div', 'inline-actions'); if (this.actions.visible('remote-add')) footer.append(button(m('remotes.add'), () => { close?.(); void this.actions.show('remote-add'); }, 'plus')); if (this.actions.visible('identity')) footer.append(button(m('menu.identity'), () => { close?.(); void this.actions.show('identity'); }, 'identity')); list.append(footer);
      await this.managerDialog(m('remotes.title'), list, callback => { close = callback; });
    } catch (error) { if (request.current()) this.showError(error); } finally { request.finish(); }
  }
  private managerDialog(titleText: Localizable, body: HTMLElement, register: (close: () => void) => void): Promise<void> {
    const dialog = el('dialog', 'dialog manager-dialog'); const title = el('h2', '', titleText); title.id = 'manager-title'; dialog.setAttribute('aria-labelledby', title.id);
    const previous = document.activeElement as HTMLElement | null;
    return new Promise(resolve => {
      const close = (): void => { disposeBindings(dialog); dialog.close(); dialog.remove(); previous?.focus({ preventScroll: true }); resolve(); };
      register(close); dialog.append(el('header', 'dialog-header', title, button(m('close'), close, 'close', '', true)), el('div', 'dialog-body', body), el('footer', 'dialog-footer', button(m('close'), close)));
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); document.body.append(dialog); dialog.showModal();
    });
  }

  private async executeWorking(input: Omit<WorkingAction, 'repoId' | 'requestId'>): Promise<ActionResult | false> {
    const repo = this.repo, generation = this.openGeneration;
    if (!repo || this.actionBusy || !this.host.workingAction) { if (!this.host.workingAction) this.toast(wm('notSupported')); return false; }
    if (!await this.actions.trust() || generation !== this.openGeneration || this.repo?.id !== repo.id) return false;
    const action: WorkingAction = { ...input, repoId: repo.id, requestId: '' };
    const labels = { stage: wm('stage'), unstage: wm('unstage'), discard: wm('discard'), 'delete-untracked': wm('deleteUntracked'),
      'commit-staged': wm('commitStaged'), sync: wm('sync') };
    const result = await this.execute(action, labels[action.kind], true);
    if (generation === this.openGeneration && this.repo?.id === repo.id) this.renderWorkspace();
    return result ?? false;
  }
  private async execute(action: GitAction | WorkingAction, label: Localizable, workingAction = false): Promise<ActionResult | null> {
    if (this.actionBusy || this.repo?.id !== action.repoId) return null;
    this.actionBusy = true; const request = this.requests.begin('action'); action.requestId = request.id;
    this.buildToolbar(); this.renderWorkspace(); this.renderStatus(); this.operationbar.hidden = false;
    const cancel = button(m('operation.cancel'), async () => {
      if (!await confirmDialog(m('operation.cancelTitle'), m('operation.cancelDescription'), m('operation.cancel'), true)) return;
      try { await this.host.cancel(request.id); this.toast(m('operation.cancellationRequested')); } catch (error) { this.showError(error); }
    }, 'stop');
    this.cancelWrite = () => { cancel.click(); }; this.activeWrite = { id: request.id, label, kind: 'write', repoId: action.repoId, cancelScope: 'write' }; this.renderStatus();
    this.operationbar.replaceChildren(el('span', 'spinner'), el('strong', '', label), el('span', 'muted', m('operation.gitInProgress')), el('span', 'spacer'), cancel);
    let result: ActionResult | null = null;
    try { result = workingAction ? await this.host.workingAction!(action as WorkingAction) : await this.host.action(action as GitAction); if (this.repo?.id === action.repoId) { if (result.status !== 'started') { this.taskSequence++; this.statusResult = { id: request.id, kind: 'success', message: m('operation.completed', { label }), repoId: action.repoId, at: Date.now() }; this.toast(m('operation.completed', { label })); } else if (result.sessionId) { const existing = this.sessions.get(result.sessionId); if (!existing || !['completed', 'failed'].includes(existing.status)) this.sessions.set(result.sessionId, { id: result.sessionId, repoId: action.repoId, kind: action.kind, status: 'started', exitCode: null, operation: result.operation, message: result.output }); } } }
    catch (error) { this.showError(error); }
    finally {
      request.finish(); this.actionBusy = false; this.activeWrite = null; this.cancelWrite = null; this.buildToolbar(); this.renderWorkspace(); this.renderStatus();
      if (this.repo?.id === action.repoId) {
        this.workingDirtyEpoch++; this.refreshQueue.request(RefreshFlags.History | RefreshFlags.Working | RefreshFlags.Config);
        this.refreshQueue.resume(); await this.refreshQueue.idle(); this.renderOperation();
      }
    }
    return result;
  }
  private renderTrust(): void {
    const repo = this.repo; this.trustbar.hidden = !repo || repo.trusted;
    if (!repo || repo.trusted) return;
    this.trustbar.replaceChildren(icon('shield'), el('span', '', m('trust.readOnly')), el('span', 'muted trust-explanation', m('trust.explanation')), el('span', 'spacer'), button(m('menu.trust'), () => { void this.actions.trust(); }, 'shield'));
  }
  private persistTrust(): void {
    if (!this.repo) return;
    this.store.state.trusted = this.store.state.trusted.filter(path => path !== this.repo!.path); if (this.repo.trusted) this.store.state.trusted.push(this.repo.path); this.store.queue();
  }
  private async toggleTrust(): Promise<void> {
    if (!this.repo || this.actionBusy) return;
    if (!this.repo.trusted) { await this.actions.trust(); return; }
    if (!await confirmDialog(m('trust.revokeTitle'), m('trust.revokeDescription'), m('trust.revokeConfirm'))) return;
    try { await this.host.trustRepository(this.repo.id, false); this.repo.trusted = false; this.persistTrust(); this.renderTrust(); this.renderStatus(); } catch (error) { this.showError(error); }
  }
  private renderOperation(): void {
    if (this.actionBusy) return;
    const session = [...this.sessions.values()].reverse().find(item => item.repoId === this.repo?.id && ['started', 'running', 'paused', 'failed'].includes(item.status));
    const working = this.working; this.operationbar.hidden = !working?.operation && !session;
    if (session) {
      this.operationbar.replaceChildren(icon(session.status === 'failed' ? 'warning' : 'terminal'), el('strong', '', m('session.label', { kind: actionLabel(session.kind), status: m(`session.${session.status}`) })), el('span', 'muted', session.message || m('session.external')), el('span', 'spacer'), button(m('session.details'), () => { void textDialog(m('session.title'), m('session.metadata', { kind: actionLabel(session.kind), status: m(`session.${session.status}`), code: session.exitCode ?? '—', operation: session.operation === null ? '—' : operationText(session.operation), message: session.message })); }), button(m('menu.openTerminal'), () => { void this.openTerminal(); }, 'terminal'));
      if (!working?.operation) return;
    }
    if (!working?.operation) return;
    this.operationbar.replaceChildren(icon('warning'), el('strong', '', m('operation.inProgress', { operation: operationText(working.operation) })), el('span', 'muted', working.conflicts ? m('operation.conflicts', { count: numberText(working.conflicts) }) : m('operation.inspectStaged')), el('span', 'spacer'), button(m('menu.openTerminal'), () => { void this.openTerminal(); }, 'terminal'));
    if (this.actions.visible('continue')) this.operationbar.append(button(m('operation.continue'), () => { void this.actions.show('continue'); }, 'play'));
    if (this.actions.visible('abort')) this.operationbar.append(button(m('operation.abort'), () => { void this.actions.show('abort'); }, 'stop', 'danger-text'));
  }
  private async openTerminal(): Promise<void> {
    if (!this.repo || !await this.actions.trust()) return;
    try { await this.host.openTerminal(this.repo.id); } catch (error) { this.showError(error); }
  }
  private async chooseLanguage(): Promise<void> {
    const values = await formDialog({ title: m('language.title'), fields: [{ name: 'language', label: m('language.label'), type: 'select', value: getLanguage(), options: [{ value: 'system', label: m('language.system') }, { value: 'zh-CN', label: m('language.chinese') }, { value: 'en', label: m('language.english') }] }], confirm: m('apply') });
    if (!values || !['system', 'zh-CN', 'en'].includes(String(values.language))) return;
    this.store.updateSettings({ language: values.language as AppSettings['language'] }, null);
    configureLocale(this.store.state.settings.language);
  }
  private updateLocale(): void {
    if (this.disposed) return;
    this.settingsSnapshot = structuredClone(this.settings);
    this.table.updateLocale?.(); this.details.updateLocale?.(); this.historyDocuments.updateLocale(); this.localChanges.updateLocale(); this.repositoryTree.updateLocale(); this.renderStatus();
  }
  private openSettings(): void { void showSettings(this.host, this.store, this.repo, this.diagnostics, () => this.settingsChanged(), error => this.showError(error), () => { this.settingsSnapshot = structuredClone(this.settings); }); }
  private updateSettings(patch: Partial<AppSettings>): void {
    this.store.updateSettings(patch, this.repo?.id); this.settingsChanged();
  }
  private settingsChanged(): void {
    const previous = this.settingsSnapshot;
    const historyChanged = previous && HISTORY_SETTING_KEYS.some(key => JSON.stringify(previous[key]) !== JSON.stringify(this.settings[key]));
    if (historyChanged) this.queryIntent();
    if (previous && previous.order !== this.settings.order) { this.order = this.settings.order; this.orderSelect.value = this.order; }
    this.applySettings(); this.buildToolbar();
    if (historyChanged) void this.loadHistory(true); else this.renderTable();
    if (previous && previous.mailmap !== this.settings.mailmap) { this.details.invalidate(); this.details.refresh(); }
    else this.details.updateSettings();
    this.historyDocuments.updateSettings(); this.localChanges.update();
    this.saveView();
  }
  private applySettings(): void {
    const settings = this.settings; this.settingsSnapshot = structuredClone(settings);
    document.documentElement.dataset.theme = settings.theme; document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
    document.documentElement.style.colorScheme = settings.theme === 'system' ? 'dark light' : settings.theme;
    this.applyLayout(); this.renderWorkspace();
  }
  private createDetailResizer(): HTMLElement {
    const right = this.settings.detailPosition === 'right';
    const handle = resizer(right ? 'vertical' : 'horizontal', () => this.detailSize, (value, final) => {
      this.detailSize = value; this.applyLayout(false); if (this.settings.detailPosition === 'inline') this.renderTable(); if (final) { this.store.state.layout.detailSize = value; this.store.queue(); }
    }, right ? 300 : 140, () => right ? Math.max(300, this.workspace.clientWidth - 340) : Math.max(140, this.workspace.clientHeight - 130), true, m('details.resize'));
    return handle;
  }
  private applyLayout(recreate = true): void {
    const right = this.settings.detailPosition === 'right', inline = this.settings.detailPosition === 'inline';
    this.workspace.classList.toggle('details-right', right); this.workspace.classList.toggle('details-inline', inline); this.workspace.classList.toggle('has-details', this.detailsOpen);
    this.workspace.style.setProperty('--detail-size', `${this.detailSize}px`);
    this.details?.element.classList.toggle('details-right', right); this.details?.element.classList.toggle('details-inline', inline);
    if (!inline && this.details && this.details.element.parentElement !== this.workspace) this.workspace.append(this.details.element);
    if (recreate && this.resizeHandle) { const wanted = right ? 'vertical' : 'horizontal'; if (!this.resizeHandle.classList.contains(wanted)) { const next = this.createDetailResizer(); this.resizeHandle.replaceWith(next); this.resizeHandle = next; } }
    if (this.resizeHandle) this.resizeHandle.hidden = !this.detailsOpen || inline;
  }
  private renderStatus(): void {
    const repo = this.repo;
    const externalRunning = [...this.sessions.values()].some(session => session.repoId === repo?.id && ['started', 'running'].includes(session.status));
    for (const surface of [this.root, this.shell]) { surface.dataset.repoPath = repo?.path ?? ''; surface.dataset.repoHead = repo?.head ?? ''; surface.dataset.taskState = this.actionBusy || this.loadingHistory || this.loadingRepo || this.metadataLoading || externalRunning || this.directoryLoading ? 'running' : 'idle'; surface.dataset.taskSequence = String(this.taskSequence); surface.dataset.configDirectory = this.diagnostics?.configDirectory ?? ''; }
    this.status.update({ repository: repo, initialized: this.initialized, opening: this.loadingRepo,
      working: this.working, workingLoading: this.metadataLoading,
      workingStale: Boolean(this.working) && this.workingAppliedEpoch < this.workingDirtyEpoch,
      workingError: this.workingError, lastSuccessfulRefresh: this.lastSuccessfulRefresh,
      history: { loaded: this.commits.length, visible: this.visibleCommits().length, hasMore: this.hasMore,
        loading: this.loadingHistory, ready: this.historyReady, error: this.historyError, stale: Boolean(this.historyError && this.commits.length) },
      task: this.activeWrite ?? (this.directoryLoading ? { id: `directory-${this.directoryGeneration}`, label: m('directory.finding'), kind: 'discover' } : null),
      result: this.statusResult, compareBase: this.compareBase, sessions: [...this.sessions.values()], gitVersion: this.diagnostics?.gitVersion ?? null,
    });
    if (this.refreshButton) this.refreshButton.classList.toggle('is-loading', this.loadingHistory || this.metadataLoading);
  }
  private showError(error: unknown): void {
    const message = isLocalizedMessage(error) ? error : errorText(error), raw = rawErrorText(error); this.errorbar.hidden = false;
    const summary = localized(locale => resolveText(message, locale).split('\n')[0]);
    this.statusResult = { id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, kind: 'error', message: summary, repoId: this.repo?.id, at: Date.now() };
    if (this.status) this.renderStatus();
    this.errorbar.replaceChildren(icon('warning'), el('span', 'error-summary', summary), el('span', 'spacer'), button(m('error.details'), () => { void textDialog(m('error.title'), message); }), button(m('error.copy'), () => this.copy(raw), 'copy', '', true), button(m('error.dismiss'), () => { this.errorbar.hidden = true; if (this.statusResult?.kind === 'error') this.statusResult = null; this.renderStatus(); }, 'close', '', true));
  }
  private toast(message: Localizable): void {
    clearTimeout(this.toastTimer); setText(this.toastElement, message); this.toastElement.hidden = false;
    this.toastTimer = setTimeout(() => { this.toastElement.hidden = true; }, 5000);
  }
  private copy(text: string): void { void this.host.copy(text).then(() => this.toast(m('clipboard.copied'))).catch(error => this.showError(error)); }
  private makeUrl(template: string, id: string, oid: string): string | null {
    try {
      const url = new URL(template.replaceAll('{id}', encodeURIComponent(id)).replaceAll('{commit}', encodeURIComponent(oid)).replaceAll('{branch}', encodeURIComponent(this.repo?.branch ?? '')));
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  private async openPrLink(oid: string): Promise<void> {
    const values = await formDialog({ title: m('pullRequest.openTitle'), fields: [{ name: 'id', label: m('pullRequest.number'), required: true, value: '' }], confirm: m('pullRequest.openLink'), validate: values => /^\d+$/.test(String(values.id)) ? null : m('pullRequest.invalidId') });
    if (!values) return; const url = this.makeUrl(this.settings.pullRequestUrl, String(values.id), oid);
    if (url) { try { await this.host.openUrl(url); } catch (error) { this.showError(error); } } else this.showError(m('pullRequest.invalidTemplate'));
  }

  private keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || overlayOpen()) return;
    const mod = event.ctrlKey || event.metaKey, editable = editableTarget(event.target), shortcuts = this.settings.shortcuts;
    if (matchesShortcut(event, shortcuts.find)) { event.preventDefault(); this.searchInput.focus(); this.searchInput.select(); }
    else if (matchesShortcut(event, shortcuts.refresh) || (event.key === 'F5' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey)) { event.preventDefault(); void this.refresh(); }
    else if (mod && !event.altKey && !event.shiftKey && event.key === ',') { event.preventDefault(); this.openSettings(); }
    else if (!editable && mod && !event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); void this.openPicker(); }
    else if (!editable && matchesShortcut(event, shortcuts.head)) { event.preventDefault(); void this.revealHead(); }
    else if (!editable && matchesShortcut(event, shortcuts.stash)) { event.preventDefault(); void this.cycleStash(); }
    else if (!editable && event.key === 'Escape') { if (!this.containmentTip.hidden) { event.preventDefault(); this.hoverContainment(null); } else if (this.detailsOpen) { event.preventDefault(); this.closeDetails(); } }
  };
  private beforeUnload = (): void => {
    this.saveView(); void this.store.flush().catch(error => this.showError(error)); this.dispose();
  };
  private windowFocused = (): void => {
    if (!this.initialized || !this.repo || this.disposed) return;
    this.workingDirtyEpoch++; this.renderStatus();
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => {
      this.focusTimer = undefined;
      this.refreshQueue.request(RefreshFlags.Working | RefreshFlags.Config);
    }, 240);
    this.refreshQueue.resume();
  };
  private visibilityChanged = (): void => {
    if (!document.hidden) { this.refreshQueue.resume(); this.windowFocused(); }
  };
  dispose(): void {
    this.saveView(); this.disposed = true; this.refreshQueue.dispose(); this.requests.cancelAll(); this.unlisten?.(); this.unlistenExternal?.(); this.localeDispose?.(); this.table.destroy(); this.details.destroy(); this.historyDocuments.destroy(); this.localChanges.dispose(); this.summaries.destroy(); this.repositoryTree.destroy(); this.status.destroy(); this.hoverContainment(null);
    clearTimeout(this.searchTimer); clearTimeout(this.watcherTimer); clearTimeout(this.focusTimer); clearTimeout(this.viewTimer); clearTimeout(this.toastTimer); clearTimeout(this.hoverTimer);
    disposeBindings(this.shell);
    document.removeEventListener('keydown', this.keydown); window.removeEventListener('beforeunload', this.beforeUnload); document.removeEventListener('visibilitychange', this.visibilityChanged); window.removeEventListener('focus', this.windowFocused);
  }
}

import type {
  ActionResult, AppSettings, Commit, Containment, Diagnostics, ExternalSession, GitAction, GitRef, HistoryQuery,
  HistoryScope, Host, Remote, Repository, RepositorySnapshot, Stash, ViewState, WorkingState,
} from '../shared/protocol';
import type { GraphRow } from '../lib/graph';
import { CoalescedRefresh, HistoryLayoutCache, RefreshFlags } from '../lib/performance-models';
import { clamp, errorMessage, LruCache, matchesCommit, scopeLabel, shortOid, type CommitFilter, type SearchMode } from '../lib/format';
import { buildPullRequestUrl } from '../lib/providers';
import { effectiveSettings, Requests, StateStore } from '../lib/state';
import { configurePerformance, performanceDiagnostics as perf, type PerformanceContext, type PerformanceOutcome } from '../lib/performance';
import { GitActions, ACTION_DATA_IDS, ACTION_GROUPS, ACTION_LABELS } from './actions';
import { DetailsPane, type DetailSelection, type DetailViewSnapshot } from './details';
import { button, closeMenu, confirmDialog, contextMenu, el, empty, formDialog, input, loading, menuAtButton, resizer, select, textDialog, type MenuItem } from './dom';
import { icon } from './icons';
import { branchNeighbours, editableTarget, matchesShortcut, overlayOpen } from './navigation';
import { renderMessage } from './message';
import { showHistoryScope } from './scope';
import { showSettings } from './settings';
import { CommitTable } from './table';

const MAX_COMMITS = 50_000;
const HISTORY_SETTING_KEYS: (keyof AppSettings)[] = ['showRemotes', 'showTags', 'showStashes', 'firstParent', 'includeReflog', 'initialLoad', 'loadMore', 'order', 'mailmap', 'includeTagOnly', 'showRemoteHeads', 'collapseStashAuxiliary', 'muteNonAncestors'];
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
  private historyContainer = el('div', 'history-container');
  private historyOverlay = el('div', 'history-overlay');
  private statusbar = el('footer', 'statusbar');
  private statusText = el('span', 'status-text');
  private taskText = el('span', 'task-text');
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
  private searchInput = input('Search commits');
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
      context: () => ({ repo: this.repo, settings: this.settings, refs: this.refs, remotes: this.remotes, stashes: this.stashes, selected: this.selected, working: this.working }),
      execute: (action, label) => this.execute(action, label), error: error => this.showError(error),
      changed: () => { this.persistTrust(); this.renderTrust(); }, toast: message => this.toast(message),
    });
    this.table = new CommitTable({
      select: (oid, compare) => this.selectCommit(oid, compare),
      context: (oid, x, y, element) => this.commitMenu(oid, x, y, element),
      refContext: (ref, x, y, element) => this.refMenu(ref, x, y, element),
      loadMore: () => { if (!this.restoringView && !this.autoLoadBlocked) void this.loadHistory(false); },
      loadMoreExplicit: () => { this.userIntent(); this.autoLoadBlocked = false; void this.loadHistory(false); },
      widths: widths => { this.updateSettings({ columnWidths: widths }); }, copy: text => this.copy(text),
      branchNavigate: (oid, direction, alternate) => { void this.navigateBranch(oid, direction, alternate); },
      hover: (oid, anchor) => this.hoverContainment(oid, anchor), openUrl: url => this.openUrl(url),
      scrolled: user => { if (user) this.userIntent(); this.queueViewSave(); },
    });
    this.details = new DetailsPane(host, this.store, {
      context: () => ({ repo: this.repo, settings: this.settings, working: this.working }), settings: patch => this.updateSettings(patch),
      error: error => this.showError(error), copy: text => this.copy(text), action: kind => { void this.actions.show(kind, kind === 'reset' ? { target: 'HEAD', mode: this.settings.dialogDefaults.worktreeResetMode } : {}); },
      close: () => this.closeDetails(), follow: oid => this.followCommit(oid), ensureTrust: () => this.actions.trust(), openUrl: url => this.openUrl(url), changed: () => this.queueViewSave(),
    });
    this.details.element.hidden = true;
    this.resizeHandle = this.createDetailResizer();
    this.historyContainer.append(this.table.element, this.historyOverlay);
    this.workspace.append(this.historyContainer, this.resizeHandle, this.details.element);
    this.trustbar.hidden = true; this.diagnosticsbar.hidden = true; this.operationbar.hidden = true; this.errorbar.hidden = true;
    this.diagnosticsbar.setAttribute('role', 'status'); this.diagnosticsbar.setAttribute('aria-live', 'polite');
    this.errorbar.setAttribute('role', 'alert'); this.toastElement.hidden = true; this.toastElement.setAttribute('role', 'status'); this.toastElement.setAttribute('aria-live', 'polite');
    this.statusText.setAttribute('role', 'status'); this.statusText.setAttribute('aria-live', 'polite');
    this.statusbar.append(this.statusText, el('span', 'spacer'), this.taskText);
    this.containmentTip.hidden = true; this.containmentTip.id = 'commit-containment'; this.containmentTip.setAttribute('role', 'tooltip');
    this.shell.append(this.toolbar, this.querybar, this.diagnosticsbar, this.trustbar, this.operationbar, this.errorbar, this.workspace, this.statusbar, this.toastElement, this.containmentTip);
    this.root.replaceChildren(this.shell);
    this.buildToolbar(); this.buildQuerybar(); this.applySettings();
    this.historyOverlay.replaceChildren(loading('Loading local preferences…')); this.historyOverlay.hidden = false;
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
    if (diagnosticsResult.status === 'fulfilled') { this.diagnostics = diagnosticsResult.value; configurePerformance(this.diagnostics.performanceEnabled); this.renderDiagnosticsWarnings(); } else this.showError(diagnosticsResult.reason);
    this.detailSize = this.store.state.layout.detailSize;
    this.initialized = true; this.order = this.settings.order; this.applySettings(); this.buildToolbar(); this.renderStatus();
    this.orderSelect.value = this.order;
    try { this.unlistenExternal = await this.host.onExternalSession(session => this.externalSessionChanged(session)); } catch (error) { this.showError(error); }
    try {
      this.unlisten = await this.host.onRepositoryChanged(repoId => {
        if (repoId !== this.repo?.id || this.disposed) return;
        this.workingDirtyEpoch++; this.refreshDebouncing = true;
        this.refreshQueue.request(RefreshFlags.History | RefreshFlags.Working | RefreshFlags.Config);
        clearTimeout(this.watcherTimer);
        this.watcherTimer = setTimeout(() => {
          this.watcherTimer = undefined; this.refreshDebouncing = false; this.refreshQueue.resume();
        }, 600);
      });
    } catch (error) { this.showError(error); }
    const last = this.store.state.lastRepo;
    if (last) await this.openRepository(last); else this.renderEmpty();
  }

  private renderDiagnosticsWarnings(): void {
    const warnings = this.diagnostics?.warnings?.filter(warning => warning.trim()) ?? [];
    this.diagnosticsbar.hidden = !warnings.length; if (!warnings.length) return;
    const details = button('Warning details', () => this.showDiagnosticsWarnings(), 'info'); details.dataset.action = 'diagnostics-warnings';
    const summary = el('span', 'error-summary', `${warnings.length} environment warning${warnings.length === 1 ? '' : 's'} · ${warnings[0].split(/\r?\n/)[0]}`); summary.title = warnings[0];
    this.diagnosticsbar.replaceChildren(icon('warning'), summary, el('span', 'spacer'), details, button('Dismiss warnings', () => { this.diagnosticsbar.hidden = true; }, 'close', '', true));
  }
  private showDiagnosticsWarnings(): void {
    const warnings = this.diagnostics?.warnings?.filter(warning => warning.trim()) ?? [];
    if (warnings.length) void textDialog('Environment diagnostics warnings', warnings.map((warning, index) => `${index + 1}. ${warning}`).join('\n\n'));
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
    const values = await formDialog({ title: 'Remove recent repository', description: 'Removes only the selected path from the recent-repository list. Repository files on disk, trust settings and saved views are unchanged. An open repository remains open.', fields: [{ name: 'path', label: 'Recent repository', type: 'select', value: recent[0].path, options: recent.map(item => ({ value: item.path, label: `${item.name} · ${item.path}` })) }], confirm: 'Remove from recent', dataAction: 'confirm-remove-recent-repository' });
    if (!values || !recent.some(item => item.path === values.path)) return;
    this.store.state.recent = this.store.state.recent.filter(item => item.path !== values.path); this.store.queue(); this.buildToolbar(); this.toast('Repository removed from the recent list. Files on disk were not changed.');
  }
  private buildToolbar(): void {
    this.toolbar.replaceChildren(); this.toolbar.setAttribute('aria-label', 'Repository tools');
    const recents = this.sortedRecentRepositories();
    const options = [...(!this.repo ? [{ value: '', label: 'No repository' }] : []), ...this.sortedRecentRepositories(true).map(item => ({ value: item.path, label: item.name }))];
    this.repoSelect = select(options, this.repo?.path ?? '', 'Recent repositories', path => { if (path) void this.openRepository(path); });
    this.repoSelect.className = 'repo-select'; this.repoSelect.title = this.repo?.path ?? 'Select a recent repository';
    const open = button('Open repository (Ctrl+O)', () => { void this.openPicker(); }, 'open', '', true);
    const openMenu = button('Repository options', () => menuAtButton(openMenu, [
      { label: 'Open repository…', icon: 'open', action: () => { void this.openPicker(); } },
      { label: 'Open by path…', dataAction: 'open-repository-by-path', icon: 'folder', action: () => { void this.openByPath(); } },
      { label: 'Find repositories in folder…', icon: 'search', action: () => { void this.discover(); } },
      ...(this.repo ? [{ label: 'Copy repository path', icon: 'copy' as const, action: () => this.copy(this.repo!.path) }, { label: 'Close repository', icon: 'close' as const, action: () => this.closeRepository() }] : []),
      ...(recents.length ? [null, { label: 'Remove recent repository…', dataAction: 'remove-recent-repository', action: () => { void this.removeRecentRepository(); } }, { label: 'Clear recent repositories', action: () => { this.store.state.recent = this.repo ? [{ path: this.repo.path, name: this.repo.name }] : []; this.store.queue(); this.buildToolbar(); } }] : []),
      ...(this.diagnostics?.warnings?.some(warning => warning.trim()) ? [null, { label: 'Environment warnings…', dataAction: 'diagnostics-warnings', icon: 'warning' as const, action: () => this.showDiagnosticsWarnings() }] : []),
    ]), 'down', '', true);
    this.branchSelect = button(scopeLabel(this.scope), () => { void this.chooseScope(); }, 'branch', 'branch-select'); this.branchSelect.disabled = !this.repo; this.branchSelect.dataset.action = 'scope'; this.branchSelect.setAttribute('aria-haspopup', 'dialog');
    const branchActions = button('Branch and tag actions', () => menuAtButton(branchActions, [this.actions.item('branch-create', {}, 'branch'), this.actions.item('checkout', {}, 'branch'), this.actions.item('branch-rename'), this.actions.item('branch-delete'), this.actions.item('set-upstream'), null, this.actions.item('tag-create', {}, 'tag'), this.actions.item('tag-delete'), this.actions.item('tag-push')].filter((item, index, array) => item !== null || (index > 0 && array[index - 1] !== null))), 'branch', '', true); branchActions.disabled = !this.repo; branchActions.dataset.action = 'branch-tag-actions';
    this.toolbar.append(el('span', 'toolbar-label', icon('folder')), this.repoSelect, open, openMenu, el('span', 'toolbar-divider'), this.branchSelect, branchActions, el('span', 'spacer'));
    for (const [kind, glyph] of [['fetch', 'remote'], ['pull', 'arrowDown'], ['push', 'arrowUp']] as const) {
      if (this.actions.visible(kind)) { const control = button(kind[0].toUpperCase() + kind.slice(1), () => { void this.actions.show(kind); }, glyph, 'network-action'); control.disabled = !this.repo || this.actionBusy; this.toolbar.append(control); }
    }
    this.refreshButton = button(`Refresh (${this.settings.shortcuts.refresh} / F5)`, () => { void this.refresh(); }, 'refresh', '', true); this.refreshButton.disabled = !this.repo; this.refreshButton.dataset.action = 'refresh';
    const head = button(`Center HEAD (${this.settings.shortcuts.head})`, () => { void this.revealHead(); }, 'commit', '', true); head.disabled = !this.repo; head.dataset.action = 'head';
    const stash = button(`Stashes${this.stashes.length ? ` (${this.stashes.length})` : ''}`, () => { void this.showStashes(); }, 'stash', '', true); stash.disabled = !this.repo; stash.dataset.action = 'stash';
    const remote = button('Remotes', () => { void this.showRemotes(); }, 'remote', '', true); remote.disabled = !this.repo;
    const more = button('More Git actions', () => this.moreMenu(more), 'more', '', true); more.disabled = !this.repo; more.dataset.action = 'more-git-actions';
    this.settingsButton = button('Settings (Ctrl+,)', () => this.openSettings(), 'settings', '', true); this.settingsButton.dataset.action = 'settings'; open.dataset.action = 'open-repository'; openMenu.dataset.action = 'repository-options';
    if (this.stashes.length) stash.append(el('span', 'toolbar-count', this.stashes.length));
    this.toolbar.append(el('span', 'toolbar-divider'), this.refreshButton, head, stash, remote, more, this.settingsButton);
    if (this.loadingRepo) { this.repoSelect.disabled = true; open.disabled = true; }
  }

  private buildQuerybar(): void {
    this.searchInput.type = 'search'; this.searchInput.placeholder = 'Filter commits'; this.searchInput.autocomplete = 'off'; this.searchInput.spellcheck = false; this.searchInput.className = 'commit-search';
    this.searchInput.addEventListener('input', () => {
      this.queryIntent(); this.search = this.searchInput.value;
      if (this.queryMode === 'filter') { this.filter.text = this.search; this.filter.mode = this.searchMode; this.renderTable(); }
      else {
        const generation = this.historyGeneration, repoId = this.repo?.id;
        // Do not display the previous Git-side query under a newly typed query header.
        this.commits = []; this.topologyRevision++; this.hasMore = false; this.renderTable(true);
        this.historyOverlay.hidden = false; this.historyOverlay.replaceChildren(loading('Waiting to search history…'));
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
    this.searchScope = select([{ value: 'filter', label: 'Filter loaded' }, { value: 'search', label: 'Search history' }], this.queryMode, 'Search scope', value => {
      this.queryIntent(); this.queryMode = value as typeof this.queryMode; this.searchInput.placeholder = value === 'filter' ? 'Filter commits' : 'Search entire Git history';
      this.filter.text = value === 'filter' ? this.search : ''; this.filter.mode = this.searchMode; this.saveView(); void this.loadHistory(true);
    });
    this.searchType = select([{ value: 'all', label: 'All fields' }, { value: 'message', label: 'Message' }, { value: 'author', label: 'Author / email' }, { value: 'hash', label: 'Commit hash' }, { value: 'date', label: 'Date (YYYY-MM-DD)' }, { value: 'refs', label: 'Refs' }], this.searchMode, 'Search field', value => {
      this.queryIntent(); this.searchMode = value as SearchMode; this.filter.mode = this.searchMode;
      if (this.queryMode === 'search') void this.loadHistory(true); else this.renderTable(); this.saveView();
    });
    this.filterButton = button('Advanced filters', () => { void this.advancedFilter(); }, 'filter');
    this.orderSelect = select([{ value: 'topo', label: 'Topological order' }, { value: 'date', label: 'Commit date order' }, { value: 'author-date', label: 'Author date order' }], this.order, 'History ordering', value => { this.queryIntent(); this.order = value as typeof this.order; this.saveView(); void this.loadHistory(true); }); this.orderSelect.className = 'order-select';
    this.queryCancel = button('Cancel loading', () => this.cancelLoading(), 'close'); this.queryCancel.hidden = true;
    this.querybar.append(icon('search'), this.searchInput, this.searchType, this.searchScope, this.filterButton, el('span', 'spacer'), this.orderSelect, this.queryCancel);
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
    const filter: Record<string, string> = {};
    for (const key of ['author', 'hash', 'refs', 'after', 'before'] as const) if (this.filter[key]) filter[key] = this.filter[key]!;
    if (detail?.fileFilter) filter.fileFilter = detail.fileFilter;
    if (detail?.workingMode) filter.workingMode = detail.workingMode;
    if (detail?.diff) { filter.diffScrollTop = String(detail.diff.scrollTop); filter.diffScrollLeft = String(detail.diff.scrollLeft); filter.diffMode = detail.diff.mode; }
    if (detail?.filesScrollTop) filter.filesScrollTop = String(detail.filesScrollTop);
    const view: ViewState = { scope: structuredClone(this.scope), search: this.search, searchMode: this.searchMode, queryMode: this.queryMode, order: this.order, scrollTop: this.table.scrollTop, selected: this.selected, filter, collapsed: detail?.collapsed ?? [] };
    if (detail) view.detail = { selection: structuredClone(detail.selection), path: detail.path, scrollTop: detail.scrollTop };
    this.store.state.views[repo.id] = view; this.viewMemory.set(repo.id, { detail, loaded: this.commits.length }); this.store.queue();
  }
  private restoreQuery(view?: ViewState): void {
    this.scope = structuredClone(view?.scope ?? this.settings.startupScope);
    this.search = view?.search ?? ''; this.searchMode = (['all', 'message', 'author', 'hash', 'date', 'refs'].includes(view?.searchMode ?? '') ? view!.searchMode : 'all') as SearchMode;
    this.queryMode = view?.queryMode ?? 'filter'; this.order = view?.order ?? this.settings.order;
    this.filter = { text: this.queryMode === 'filter' ? this.search : '', mode: this.searchMode, author: view?.filter?.author, hash: view?.filter?.hash, refs: view?.filter?.refs, after: view?.filter?.after, before: view?.filter?.before };
    this.searchInput.value = this.search; this.searchInput.placeholder = this.queryMode === 'filter' ? 'Filter commits' : 'Search entire Git history'; this.searchScope.value = this.queryMode; this.searchType.value = this.searchMode; this.orderSelect.value = this.order;
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
      filesScrollTop: Number(view.filter?.filesScrollTop) || 0,
      workingMode: ['all', 'staged', 'unstaged'].includes(view.filter?.workingMode ?? '') ? view!.filter!.workingMode as 'all' | 'staged' | 'unstaged' : 'all',
      diff: { scrollTop: Number(view.filter?.diffScrollTop) || 0, scrollLeft: Number(view.filter?.diffScrollLeft) || 0, mode: ['diff', 'new', 'old'].includes(view.filter?.diffMode ?? '') ? view!.filter!.diffMode as 'diff' | 'new' | 'old' : 'diff' },
    } : null);
    if (savedDetail) {
      this.compareBase = savedDetail.selection.kind === 'compare' ? savedDetail.selection.base : null;
      this.detailsOpen = true; this.details.element.hidden = false; this.applyLayout();
    } else { this.detailsOpen = false; this.details.clear(); this.applyLayout(); }
    this.renderTable(false, performanceContext);
    // History/viewport restoration must not wait for the selected file's first diff.
    this.table.scrollTop = view?.scrollTop ?? 0;
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
    if (this.actionBusy) { this.toast('Wait for the active Git operation before switching repositories.'); return; }
    try { const path = await this.host.pickRepository(); if (path) await this.openRepository(path); } catch (error) { this.showError(error); }
  }
  private async openByPath(): Promise<void> {
    const values = await formDialog({ title: 'Open repository', description: 'Enter an existing working-tree or bare Git repository path.', fields: [{ name: 'path', label: 'Repository path', value: '', required: true }], confirm: 'Open repository', dataAction: 'confirm-open-repository' });
    if (values) await this.openRepository(String(values.path));
  }
  private async discover(): Promise<void> {
    const values = await formDialog({ title: 'Find repositories', description: 'Search a local folder for existing Git repositories. No repositories are cloned or modified.', fields: [{ name: 'path', label: 'Parent folder', value: '', required: true }, { name: 'depth', label: 'Search depth', type: 'number', value: String(this.settings.discoveryDepth), min: 0, max: 5, required: true }], confirm: 'Find repositories' });
    if (!values) return;
    this.taskText.textContent = 'Finding repositories…';
    try {
      const paths = await this.host.discoverRepositories(String(values.path), clamp(Number(values.depth), 0, 5));
      if (!paths.length) { this.toast('No Git repositories found within that depth.'); return; }
      const selection = await formDialog({ title: `Found ${paths.length} repositories`, fields: [{ name: 'path', label: 'Repository', type: 'select', value: paths[0], options: paths.map(path => ({ value: path, label: path })) }], confirm: 'Open repository' });
      if (selection) await this.openRepository(String(selection.path));
    } catch (error) { this.showError(error); } finally { this.renderStatus(); }
  }

  private async openRepository(path: string): Promise<void> {
    if (this.actionBusy) { this.toast('A Git operation is still running.'); return; }
    const operation = perf.operation('openRepository'); let outcome: PerformanceOutcome = 'ok';
    try {
    this.saveView(); this.resetRepositoryWork(); this.hoverContainment(null); closeMenu();
    const generation = ++this.openGeneration, intent = this.intentEpoch; ++this.historyGeneration;
    this.restoringView = true; this.requests.cancelAll(); this.metadataLoading = false; this.details.clear(); this.loadingRepo = true; this.loadingHistory = false; this.detailsOpen = false;
    this.historyOverlay.hidden = false; this.historyOverlay.replaceChildren(loading('Opening repository…', () => {
      this.userIntent(); this.openGeneration++; this.loadingRepo = false; this.closeRepository();
    }));
    this.buildToolbar(); this.applyLayout(); this.renderStatus();
    try {
      const repo = await operation.run(() => this.host.openRepository(path));
      if (generation !== this.openGeneration || this.disposed) { outcome = 'stale'; return; }
      this.repo = repo; this.commits = []; this.refs = []; this.stashes = []; this.remotes = []; this.working = null; this.selected = null; this.compareBase = null; this.snapshotFingerprint = ''; this.containmentCache.clear();
      this.graph.clear(); this.graphRows = []; this.topologyRevision++; this.visibleMemo = undefined;
      this.workingMemo = undefined; this.workingDirtyEpoch++; this.workingAppliedEpoch = -1;
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
      if (generation !== this.openGeneration || this.repo?.id !== repo.id) outcome = 'stale';
    } catch (error) {
      outcome = 'error';
      if (generation === this.openGeneration) { this.loadingRepo = false; this.showError(error); this.renderEmpty(); this.buildToolbar(); }
    } finally { if (generation === this.openGeneration) { this.restoringView = false; this.loadingRepo = false; this.renderTable(false, operation.context); this.renderStatus(); this.saveView(); this.refreshQueue.resume(); } }
    } finally { operation.end({ outcome }); }
  }
  private closeRepository(): void {
    if (this.actionBusy) { this.toast('Wait for the active Git operation.'); return; }
    this.saveView(); this.resetRepositoryWork(); this.restoringView = false; this.hoverContainment(null);
    ++this.openGeneration; ++this.historyGeneration; this.requests.cancelAll(); this.details.clear(); this.detailsOpen = false;
    this.repo = null; this.commits = []; this.refs = []; this.working = null; this.stashes = []; this.remotes = []; this.selected = null; this.compareBase = null;
    this.loadingHistory = false; this.loadingRepo = false; this.metadataLoading = false; this.hasMore = false; this.graph.clear(); this.graphRows = [];
    this.topologyRevision++; this.visibleMemo = undefined; this.workingMemo = undefined; this.historyReady = false; this.snapshotFingerprint = ''; this.historyMetadataKey = '';
    this.store.state.lastRepo = null; this.store.queue(); this.applySettings(); this.buildToolbar(); this.renderTrust(); this.renderOperation(); this.renderTable(true); this.renderEmpty();
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
    this.metadataLoading = true; this.renderStatus(); const request = this.requests.begin('metadata'); operation.request(request.id);
    try {
      const snapshot = await operation.run(() => this.host.snapshot(repo.id, request.id));
      if (!request.current() || this.repo?.id !== repo.id || generation !== this.openGeneration || this.disposed) { outcome = 'stale'; return false; }
      operation.run(() => this.applySnapshot(snapshot)); this.taskSequence++;
      // Repeated edits can have an identical status fingerprint. Dirty epochs still refresh mutable diffs.
      if (this.workingAppliedEpoch < dirtyEpoch) {
        this.workingAppliedEpoch = dirtyEpoch;
        if (this.selected === 'WORKTREE' && this.detailsOpen) this.details.refresh();
      }
      return true;
    } catch (error) { outcome = request.current() ? 'error' : 'cancelled'; if (request.current() && this.repo?.id === repo.id) this.showError(error); return false; }
    finally {
      try { if (request.current()) { this.metadataLoading = false; this.renderStatus(); } request.finish(); }
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
    if (reset && !retain) { this.historyOverlay.hidden = false; this.historyOverlay.replaceChildren(loading('Loading commit history…', () => this.cancelLoading())); }
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
      this.offset = offset; this.hasMore = more; this.historyReady = true;
      this.historyMetadataKey = this.snapshotFingerprint ? this.metadataHistoryKey() : '';
      this.taskSequence++; this.loadingHistory = false; this.historyOverlay.hidden = true;
      this.renderTable(reset && !retain, operation.context);
      operation.paint('history-paint-opportunity', { count: this.commits.length });
      if (this.commits.length >= MAX_COMMITS && more) this.toast('50,000 commits loaded. Narrow the branch or search to inspect more history.');
      if (!this.commits.length) this.renderEmpty();
    } catch (error) {
      outcome = current() ? 'error' : 'cancelled';
      if (current()) {
        this.loadingHistory = false; this.autoLoadBlocked = true; this.showError(error);
        if (!retain) this.hasMore = false;
        if (!this.commits.length) {
          this.historyOverlay.hidden = false;
          this.historyOverlay.replaceChildren(empty('Could not load history', errorMessage(error)), button('Retry', () => { this.queryIntent(); void this.loadHistory(true); }, 'refresh'));
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
    this.refreshQueue.cancel();
    this.historyOverlay.hidden = this.commits.length > 0;
    if (!this.commits.length) this.historyOverlay.replaceChildren(empty('History loading cancelled'), button('Load history', () => { this.queryIntent(); void this.loadHistory(true); }, 'refresh'));
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
    const inline = this.detailsOpen && settings.detailPosition === 'inline' && this.selected && (this.selected === 'WORKTREE' && working || visible.some(commit => commit.oid === this.selected)) ? { oid: this.selected, element: this.details.element, height: this.detailSize } : undefined;
    const waitingWorking = this.detailsOpen && this.selected === 'WORKTREE' && !this.working;
    perf.run(performanceContext, () => this.table.setModel({ commits: visible, graph: this.graphRows, working, settings, selected: this.selected, compareBase: this.compareBase, head: this.repo?.head ?? null, hasMore: this.hasMore, loading: this.loadingHistory, totalLoaded: this.commits.length, inline, pauseAutoLoad: this.restoringView || this.autoLoadBlocked }, reset));
    if (this.detailsOpen && settings.detailPosition === 'inline' && !inline && !waitingWorking) { this.detailsOpen = false; this.details.clear(); this.applyLayout(); }
    this.filterButton.classList.toggle('active', this.hasAdvancedFilters()); this.filterButton.setAttribute('aria-pressed', String(this.hasAdvancedFilters()));
    this.renderStatus();
    if (this.repo && !this.loadingHistory && this.commits.length && !visible.length) { this.historyOverlay.hidden = false; this.historyOverlay.replaceChildren(empty('No commits match the loaded-page filters', this.hasMore ? 'Load more commits, narrow the branch, or switch to Search history to search across Git history.' : 'Change or clear the filters to see commits.'), button('Clear filters', () => this.clearFilters(), 'close')); }
    else if (this.repo && visible.length && !this.loadingHistory) this.historyOverlay.hidden = true;
    } finally { modelSpan.end({ count: this.commits.length }); }
  }
  private renderEmpty(): void {
    this.historyOverlay.hidden = false;
    if (!this.initialized) { this.historyOverlay.replaceChildren(loading('Loading local preferences…')); return; }
    if (!this.repo) {
      const browser = this.diagnostics?.gitVersion === null && this.diagnostics.platform.includes('browser');
      const byPath = button('Open by path…', () => { void this.openByPath(); }, 'folder'); byPath.dataset.action = 'open-repository-by-path';
      this.historyOverlay.replaceChildren(empty(browser ? 'Desktop application required' : 'No repository open', browser ? 'Local Git repositories are available in the Windows desktop application. This browser preview does not access your filesystem or display fabricated repository data.' : 'Open an existing Git repository or choose a recent repository from the toolbar.'), button('Open repository…', () => { void this.openPicker(); }, 'open'), byPath);
    } else if (!this.commits.length) {
      const constrained = Boolean(this.search) || this.scope.kind !== 'all';
      this.historyOverlay.replaceChildren(empty(constrained ? 'No matching commits' : 'No commits yet', this.search ? 'Try another search term, field or range.' : 'This repository may have an unborn branch. Use a terminal to make the first commit.'), button('Open terminal', () => { void this.openTerminal(); }, 'terminal'), ...(constrained ? [button('Clear search and range', () => { this.scope = { kind: 'all' }; this.clearFilters(); this.buildToolbar(); })] : []));
    } else this.historyOverlay.hidden = true;
    this.renderStatus();
  }
  private hasAdvancedFilters(): boolean { return Boolean(this.filter.author || this.filter.hash || this.filter.refs || this.filter.after || this.filter.before); }
  private clearFilters(): void {
    this.queryIntent(); this.search = ''; this.searchInput.value = ''; this.filter = { text: '', mode: this.searchMode }; this.saveView(); void this.loadHistory(true);
  }
  private async advancedFilter(): Promise<void> {
    const values = await formDialog({ title: 'Filter loaded commits', description: 'These filters apply together to loaded pages. Use Search history for an unbounded Git-side message, author, hash or date search. Ref filters here match badges attached to commits.', fields: [
      { name: 'author', label: 'Author or email contains', value: this.filter.author ?? '' },
      { name: 'hash', label: 'Commit hash contains', value: this.filter.hash ?? '' },
      { name: 'refs', label: 'Ref name contains', value: this.filter.refs ?? '' },
      { name: 'after', label: 'On or after (YYYY-MM-DD)', value: this.filter.after ?? '' },
      { name: 'before', label: 'On or before (YYYY-MM-DD)', value: this.filter.before ?? '' },
    ], confirm: 'Apply filters', validate: values => {
      for (const name of ['after', 'before']) if (values[name] && (!/^\d{4}-\d{2}-\d{2}$/.test(String(values[name])) || !Number.isFinite(Date.parse(String(values[name]))))) return 'Dates must use YYYY-MM-DD.';
      if (values.after && values.before && String(values.after) > String(values.before)) return 'The start date must not be after the end date.';
      return null;
    } });
    if (!values) return;
    this.queryIntent(); this.filter = { text: this.queryMode === 'filter' ? this.search : '', mode: this.searchMode, author: String(values.author), hash: String(values.hash), refs: String(values.refs), after: String(values.after), before: String(values.before) }; this.renderTable(); this.saveView();
  }

  private selectCommit(oid: string, compare: boolean): void {
    if (!this.repo) return;
    this.userIntent(); this.hoverContainment(null);
    const operation = perf.operation('commitSelection', { oid }); let waitsForDetails = false;
    try {
    let selection: DetailSelection | null = null;
    if (compare && oid !== 'WORKTREE') {
      const base = this.compareBase ?? (this.selected && this.selected !== 'WORKTREE' ? this.selected : null);
      if (base && base !== oid) { this.compareBase = base; this.selected = oid; selection = { kind: 'compare', base, target: oid }; }
      else { this.compareBase = oid; this.selected = oid; this.toast(`Comparison base: ${shortOid(oid)}. Control / Command or Shift select a target commit.`); }
    } else { this.selected = oid; this.compareBase = null; selection = oid === 'WORKTREE' ? { kind: 'working' } : { kind: 'commit', oid }; }
    if (selection) this.openDetails();
    this.renderTable(false, operation.context); operation.paint('selection-feedback');
    if (selection && this.settings.autoCenterDetails) this.table.reveal(oid, true);
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
    if (this.commits.some(commit => commit.oid === oid)) this.table.focus(oid); else this.toast('Commit details opened. This commit is outside the currently loaded history.');
  }
  private async revealHead(): Promise<void> {
    const repo = this.repo, head = repo?.head; if (!repo || !head) { this.toast('This repository has no HEAD commit yet.'); return; }
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
    if (!this.stashes.length) { this.toast('No stashes in this repository.'); return; }
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
    if (!candidates.length) { this.toast(direction === 'parent' ? alternate ? 'No alternate parent.' : 'This commit has no parent.' : 'No matching child in loaded history.'); return; }
    let target = candidates[0];
    if (candidates.length > 1) {
      const values = await formDialog({ title: direction === 'parent' ? 'Choose parent' : 'Choose child branch', fields: [{ name: 'oid', label: 'Commit', type: 'select', value: target, options: candidates.map(value => ({ value, label: `${shortOid(value)} · ${commits.find(commit => commit.oid === value)?.subject ?? value}` })) }], confirm: 'Go to commit' });
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
          this.containmentTip.replaceChildren(el('strong', '', `Contains ${shortOid(oid)}`), el('span', 'muted', data.head ? 'In current HEAD history' : 'Not in current HEAD history'), el('span', '', names.length ? names.slice(0, 20).join(', ') + (names.length > 20 ? ` (+${names.length - 20})` : '') : 'No branch or tag contains this commit'));
          this.containmentTip.hidden = false; const rect = anchor.getBoundingClientRect(); this.containmentTip.style.left = `${Math.max(8, Math.min(rect.left + this.settings.columnWidths.graph, window.innerWidth - 400))}px`; this.containmentTip.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - this.containmentTip.offsetHeight - 8))}px`; anchor.setAttribute('aria-describedby', this.containmentTip.id);
        } catch { /* Hover lookup is supplemental; the explicit menu offers errors and retry. */ } finally { request.finish(); }
      })();
    }, 450);
  }
  private async showContainment(oid: string): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return; const request = this.requests.begin('containment');
    try { const result = await this.host.containment(repoId, oid, request.id); if (!request.current() || this.repo?.id !== repoId) return; this.containmentCache.set(`${repoId}:${oid}`, result); const list = el('div', 'manager-list', el('p', 'muted', result.head ? 'Contained in current HEAD history.' : 'Not contained in current HEAD history.'));
      for (const ref of result.refs) list.append(button(ref.name, () => this.setScope({ kind: 'refs', refs: [ref.fullName] }), ref.kind === 'tag' ? 'tag' : 'branch'));
      if (!result.refs.length) list.append(empty('No containing branches or tags')); await this.managerDialog(`Branches & tags containing ${shortOid(oid)}`, list, () => undefined);
    } catch (error) { if (request.current() && this.repo?.id === repoId) this.showError(error); } finally { request.finish(); }
  }
  private openUrl(url: string): void { void this.host.openUrl(url).catch(error => this.showError(error)); }
  private externalSessionChanged(session: ExternalSession): void {
    if (this.disposed) return; this.sessions.set(session.id, session);
    if (this.sessions.size > 100) for (const [id, value] of this.sessions) { if (['completed', 'failed'].includes(value.status)) { this.sessions.delete(id); if (this.sessions.size <= 100) break; } }
    if (session.repoId !== this.repo?.id) return;
    if (session.status === 'paused') {
      this.taskSequence++; this.toast(`${session.kind} paused. Resolve and continue or abort in the external terminal.`);
      this.workingDirtyEpoch++; this.refreshQueue.request(RefreshFlags.Working);
    }
    if (session.status === 'completed' || session.status === 'failed') {
      this.taskSequence++; this.toast(session.status === 'completed' ? `${session.kind} completed.` : `${session.kind} failed${session.exitCode !== null ? ` (${session.exitCode})` : ''}.`);
      this.workingDirtyEpoch++; this.refreshQueue.request(RefreshFlags.History | RefreshFlags.Working | RefreshFlags.Config);
    }
    this.renderOperation(); this.renderStatus();
  }
  private async showStashDetail(selector: string): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return; const request = this.requests.begin('stash-detail');
    try { const detail = await this.host.stashDetail(repoId, selector, request.id); if (!request.current() || this.repo?.id !== repoId) return;
      const body = el('div', 'metadata-dialog-body', renderMessage(detail.message, this.settings, url => this.openUrl(url)), el('pre', 'output-text', `Selector: ${detail.selector}\nObject: ${detail.oid}\nBase: ${detail.base}\nIndex: ${detail.index}\nUntracked: ${detail.untracked ?? 'none'}\nCreated: ${new Date(detail.timestamp < 1e11 ? detail.timestamp * 1000 : detail.timestamp).toLocaleString()}`));
      body.append(button('View stash changes', () => this.followCommit(detail.oid), 'eye')); await this.managerDialog(`Stash ${detail.selector}`, body, () => undefined);
    } catch (error) { if (request.current() && this.repo?.id === repoId) this.showError(error); } finally { request.finish(); }
  }
  private async showTagDetail(ref: GitRef): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return; const request = this.requests.begin('tag-detail');
    try { const detail = await this.host.tagDetail(repoId, ref.fullName, request.id); if (!request.current() || this.repo?.id !== repoId) return;
      const body = el('div', 'metadata-dialog-body', el('pre', 'output-text', `Name: ${detail.name}\nReference: ${detail.ref}\nTag object: ${detail.oid}\nTarget: ${detail.targetOid}\nType: ${detail.targetType}\nAnnotated: ${detail.annotated ? 'yes' : 'no'}\nTagger: ${detail.tagger} <${detail.email}>\nDate: ${detail.timestamp === null ? '—' : new Date(detail.timestamp < 1e11 ? detail.timestamp * 1000 : detail.timestamp).toLocaleString()}\nSignature: ${detail.signature.status} (not verified)\nSigner: ${detail.signature.signer}\nKey: ${detail.signature.key}`), renderMessage(detail.message, this.settings, url => this.openUrl(url)));
      const verify = button('Verify tag signature…', () => { void (async () => { if (!await this.actions.trust() || this.repo?.id !== repoId) return; const verifyRequest = this.requests.begin('verify-tag'); try { const result = await this.host.verify({ repoId, requestId: verifyRequest.id, kind: 'tag', target: detail.ref }); if (!verifyRequest.current() || this.repo?.id !== repoId) return; await textDialog('Tag signature verification', `${result.status}\nSigner: ${result.signer}\nKey: ${result.key}\n\n${result.output}`); } catch (error) { if (verifyRequest.current()) this.showError(error); } finally { verifyRequest.finish(); } })(); }, 'shield'); verify.dataset.action = 'verify-tag'; body.append(verify); await this.managerDialog(`Tag ${detail.name}`, body, () => undefined);
    } catch (error) { if (request.current() && this.repo?.id === repoId) this.showError(error); } finally { request.finish(); }
  }
  private async showSubmodules(): Promise<void> {
    const repo = this.repo; if (!repo) return; const request = this.requests.begin('submodules');
    try { const modules = await this.host.submodules(repo.id, request.id); if (!request.current() || this.repo?.id !== repo.id) return; const list = el('div', 'manager-list'); let close: (() => void) | undefined;
      for (const module of modules) { const row = el('div', 'manager-row', el('div', 'manager-description', el('strong', '', module.path), el('span', 'mono wrap', module.url), el('small', 'muted', `${module.initialized ? `HEAD ${shortOid(module.head ?? '')}` : 'Not initialized'}${module.modified ? ' · modified' : ''}${module.untracked ? ' · untracked' : ''}`))); const open = button('Open repository', () => { close?.(); void this.openRepository(`${repo.path.replace(/[\\/]$/, '')}/${module.path}`); }, 'open'); open.disabled = !module.initialized; row.append(open); list.append(row); }
      if (!modules.length) list.append(empty('No submodules')); await this.managerDialog('Submodules', list, callback => { close = callback; });
    } catch (error) { if (request.current() && this.repo?.id === repo.id) this.showError(error); } finally { request.finish(); }
  }
  private async archive(target: string): Promise<void> {
    const repoId = this.repo?.id; if (!repoId || !await this.actions.trust()) return;
    const values = await formDialog({ title: 'Export archive', fields: [{ name: 'target', label: 'Tree or commit', value: target, required: true }, { name: 'format', label: 'Format', type: 'select', value: 'zip', options: [{ value: 'zip', label: 'ZIP' }, { value: 'tar', label: 'TAR' }] }, { name: 'prefix', label: 'Archive path prefix (optional)', value: '' }], confirm: 'Choose destination…' });
    if (!values || this.repo?.id !== repoId) return; const request = this.requests.begin('archive');
    try { const saved = await this.host.archive({ repoId, requestId: request.id, target: String(values.target), format: values.format === 'tar' ? 'tar' : 'zip', prefix: String(values.prefix) || undefined }); if (request.current() && this.repo?.id === repoId && saved) this.toast('Archive exported.'); } catch (error) { if (request.current()) this.showError(error); } finally { request.finish(); }
  }
  private async createPullRequest(source?: string): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return;
    const values = await formDialog({ title: 'Create pull request', description: 'Opens the provider’s real new pull request page. Nothing is pushed automatically.', fields: [{ name: 'remote', label: 'Remote', type: 'select', value: this.settings.defaultRemote, options: this.remotes.map(remote => ({ value: remote.name, label: remote.name })) }, { name: 'source', label: 'Source branch', value: source ?? this.repo?.branch ?? '', required: true }, { name: 'target', label: 'Target branch', value: 'main', required: true }, { name: 'provider', label: 'Provider', type: 'select', value: '', options: [{ value: '', label: 'Detect from remote' }, ...this.settings.pullRequestProviders.map(provider => ({ value: provider.name, label: provider.name })), { value: 'GitHub', label: 'GitHub' }, { value: 'GitLab', label: 'GitLab' }, { value: 'Bitbucket', label: 'Bitbucket' }] }], confirm: 'Open provider' });
    if (!values || this.repo?.id !== repoId) return; const remote = this.remotes.find(item => item.name === values.remote); const url = remote ? buildPullRequestUrl(remote.fetchUrl, String(values.source), String(values.target), String(values.provider) || undefined, this.settings.pullRequestProviders) : null;
    if (url) this.openUrl(url); else this.showError('The remote/provider has no safe pull request URL. Configure a matching provider template in settings.');
  }

  private commitMenu(oid: string, x: number, y: number, restore: HTMLElement): void {
    const commit = this.commits.find(item => item.oid === oid);
    const items: (MenuItem | null)[] = [];
    if (oid === 'WORKTREE') {
      items.push({ label: 'Inspect working tree', icon: 'eye', action: () => this.selectCommit(oid, false) }, this.actions.item('stash-save', {}, 'stash'), this.actions.item('commit', {}, 'commit'), this.actions.item('reset', { target: 'HEAD', mode: this.settings.dialogDefaults.worktreeResetMode }, 'undo'), this.actions.item('clean', {}, 'warning'));
    } else {
      items.push({ label: 'View commit details', icon: 'eye', action: () => this.selectCommit(oid, false) }, { label: 'Copy commit ID', icon: 'copy', shortcut: 'Ctrl+C', action: () => this.copy(oid) }, { label: 'Copy commit message', action: () => this.copy(commit?.subject ?? oid) }, null,
        { label: 'Use as comparison base', icon: 'compare', action: () => { this.userIntent(); this.compareBase = oid; this.selected = oid; this.renderTable(); this.saveView(); this.toast('Comparison base set. Shift-select a target commit.'); } },
        { label: 'Compare with selected commit', icon: 'compare', disabled: !this.selected || this.selected === oid || this.selected === 'WORKTREE', action: () => { this.userIntent(); const base = this.selected!; this.compareBase = base; this.selected = oid; this.openDetails(); void this.details.show({ kind: 'compare', base, target: oid }); this.renderTable(); this.saveView(); } },
        { label: 'Compare HEAD to this commit', icon: 'compare', disabled: !this.repo?.head || this.repo.head === oid, action: () => { this.userIntent(); this.compareBase = this.repo!.head; this.selected = oid; this.openDetails(); void this.details.show({ kind: 'compare', base: this.repo!.head!, target: oid }); this.renderTable(); this.saveView(); } }, null,
        this.actions.item('checkout', { target: oid }, 'branch'), this.actions.item('branch-create', { target: oid }, 'branch'), this.actions.item('tag-create', { target: oid }, 'tag'), null,
        this.actions.item('merge', { target: oid }, 'merge'), this.actions.item('rebase', { target: oid }), this.actions.item('cherry-pick', { target: oid }), this.actions.item('revert', { target: oid }, 'undo'), this.actions.item('reset', { target: oid }), this.actions.item('drop', { target: oid }));
      items.push(null, { label: 'Branches & tags containing this commit…', icon: 'branch', action: () => { void this.showContainment(oid); } }, { label: 'Export archive…', icon: 'export', action: () => { void this.archive(oid); } });
      if (commit?.nodeKind === 'stash') { const stash = this.stashes.find(item => item.oid === oid); if (stash) items.push({ label: 'Stash metadata…', icon: 'stash', action: () => { void this.showStashDetail(stash.selector); } }, ...(['stash-apply', 'stash-pop', 'stash-branch', 'stash-drop'] as const).map(kind => this.actions.item(kind, { target: stash.selector }, 'stash'))); }
      if (this.settings.pullRequestUrl) items.push(null, { label: 'Open pull request link…', icon: 'external', action: () => { void this.openPrLink(oid); } });
      if (this.remotes.length) items.push({ label: 'Create pull request…', icon: 'external', action: () => { void this.createPullRequest(); } });
    }
    items.push(null, { label: 'Open terminal', icon: 'terminal', action: () => { void this.openTerminal(); } });
    contextMenu(this.cleanMenu(items, oid === 'WORKTREE' ? 'worktree' : commit?.nodeKind === 'stash' ? 'stash' : 'commit'), { x, y }, restore);
  }
  private refMenu(ref: GitRef, x: number, y: number, restore: HTMLElement): void {
    const items: (MenuItem | null)[] = [
      { label: `Show history: ${ref.name}`, icon: 'branch', action: () => this.setScope({ kind: 'refs', refs: [ref.fullName] }) },
      { label: 'Copy ref name', icon: 'copy', action: () => this.copy(ref.name) }, this.actions.item('checkout', { target: ref.kind === 'branch' ? ref.name : ref.fullName }, 'branch'),
    ];
    if (ref.kind === 'branch') items.push(this.actions.item('branch-create', { target: ref.fullName }), this.actions.item('branch-rename', { target: ref.name }), this.actions.item('branch-delete', { target: ref.name }), this.actions.item('push', { branch: ref.name }, 'arrowUp'), this.actions.item('merge', { target: ref.fullName }), this.actions.item('rebase', { target: ref.fullName }), { label: 'Create pull request…', icon: 'external', disabled: !this.remotes.length, action: () => { void this.createPullRequest(ref.name); } }, { label: 'Export branch archive…', icon: 'export', action: () => { void this.archive(ref.fullName); } });
    else if (ref.kind === 'tag') items.push({ label: 'View tag metadata…', icon: 'tag', action: () => { void this.showTagDetail(ref); } }, this.actions.item('tag-delete', { target: ref.name }), this.actions.item('tag-push', { target: ref.name }), { label: 'Export tag archive…', icon: 'export', action: () => { void this.archive(ref.fullName); } });
    else if (ref.kind === 'remote') {
      const remote = [...this.remotes].sort((a, b) => b.name.length - a.name.length).find(item => ref.name.startsWith(`${item.name}/`));
      const branch = remote ? ref.name.slice(remote.name.length + 1) : ref.name;
      if (remote) items.push(this.actions.item('checkout-remote', { remote: remote.name, target: branch, name: branch }, 'branch'), this.actions.item('remote-branch-delete', { remote: remote.name, target: branch }, 'warning'), this.actions.item('fetch-into', { remote: remote.name, target: branch, branch }, 'arrowDown'), this.actions.item('pull', { remote: remote.name, branch }, 'arrowDown'), this.actions.item('merge', { target: ref.fullName }, 'merge'), this.actions.item('set-upstream', { remote: remote.name, target: branch }));
    } else if (ref.kind === 'stash') {
      const stash = this.stashes.find(item => item.oid === ref.oid || item.selector === ref.name); const target = stash?.selector ?? ref.name;
      items.push({ label: 'View stash metadata…', icon: 'stash', action: () => { void this.showStashDetail(target); } }, ...(['stash-apply', 'stash-pop', 'stash-branch', 'stash-drop'] as const).map(kind => this.actions.item(kind, { target }, 'stash')));
    }
    contextMenu(this.cleanMenu(items, ref.kind === 'remote' ? 'remoteBranch' : ref.kind), { x, y }, restore);
  }
  private cleanMenu(items: (MenuItem | null)[], context?: 'branch' | 'remote' | 'remoteBranch' | 'commit' | 'tag' | 'stash' | 'worktree'): (MenuItem | null)[] {
    const configured = context ? this.settings.contextActions[context] ?? (context === 'remoteBranch' ? this.settings.contextActions.remote : undefined) : undefined;
    const kinds = Object.keys(ACTION_LABELS) as (keyof typeof ACTION_LABELS)[];
    const actionKind = (item: MenuItem): string | undefined => kinds.find(kind => item.dataAction === (ACTION_DATA_IDS[kind] ?? kind) || item.label === ACTION_LABELS[kind]);
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
    const items: (MenuItem | null)[] = [];
    for (const group of ACTION_GROUPS) { const groupItems = group.kinds.filter(kind => !['branch-create', 'branch-rename', 'branch-delete', 'checkout', 'tag-create', 'tag-delete', 'tag-push'].includes(kind)).map(kind => this.actions.item(kind)).filter((item): item is MenuItem => item !== null); const context = group.label === 'Remotes' ? 'remote' : group.label === 'Stashes' ? 'stash' : group.label === 'History' ? 'commit' : group.label === 'Branches' ? 'branch' : group.label === 'Tags' ? 'tag' : 'worktree'; const configured = this.cleanMenu(groupItems, context); if (configured.length) { if (items.length) items.push(null); items.push(...configured); } }
    items.push(null, { label: 'Open terminal', icon: 'terminal', action: () => { void this.openTerminal(); } }, ...(this.actions.visible('identity') ? [{ label: 'Git identity…', icon: 'identity' as const, action: () => { void this.actions.show('identity'); } }] : []), { label: 'Export configuration…', icon: 'export', action: () => { void this.host.exportConfig(this.repo?.id ?? null).catch(error => this.showError(error)); } }, { label: this.repo?.trusted ? 'Revoke repository trust' : 'Trust repository…', icon: 'shield', action: () => { void this.toggleTrust(); } });
    items.push(null, { label: 'Submodules…', icon: 'folder', dataAction: 'submodules', action: () => { void this.showSubmodules(); } }, { label: 'Export archive…', icon: 'export', action: () => { void this.archive(this.repo?.head ?? 'HEAD'); } }, { label: 'Create pull request…', icon: 'external', disabled: !this.remotes.length, action: () => { void this.createPullRequest(); } }, { label: 'Resume review…', icon: 'eye', action: () => { void this.showReviews(); } }, { label: 'End all reviews', icon: 'stop', action: () => { this.store.endAllReviews(this.repo?.id); this.details.updateSettings(); } });
    menuAtButton(control, this.cleanMenu(items));
  }
  private async showReviews(): Promise<void> {
    const repoId = this.repo?.id; if (!repoId) return;
    const reviews = this.store.state.reviews.filter(review => review.repoId === repoId && review.selection);
    if (!reviews.length) { this.toast('No saved review sessions for this repository.'); return; }
    const values = await formDialog({ title: 'Resume review', fields: [{ name: 'key', label: 'Review session', type: 'select', value: reviews[0].key, options: reviews.map(review => ({ value: review.key, label: `${review.active ? 'Active · ' : ''}${review.key} · ${review.paths.length} read` })) }], confirm: 'Resume' });
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
      if (!this.stashes.length) list.append(empty('No stashes', 'Save tracked local changes in a stash before switching work.'));
      for (const stash of this.stashes) {
        const row = el('div', 'manager-row', el('div', 'manager-description', el('strong', 'mono', stash.selector), el('span', '', stash.message), el('small', 'muted mono', shortOid(stash.oid))));
        row.append(button('Inspect stash metadata', () => { close?.(); void this.showStashDetail(stash.selector); }, 'info', '', true), button('View stash changes', () => { close?.(); this.followCommit(stash.oid); }, 'eye', '', true));
        for (const [kind, label] of [['stash-apply', 'Apply'], ['stash-pop', 'Pop'], ['stash-branch', 'Branch'], ['stash-drop', 'Drop']] as const) if (this.actions.visible(kind)) row.append(button(label, () => { close?.(); void this.actions.show(kind, { target: stash.selector }); }, undefined, kind === 'stash-drop' ? 'danger-text' : ''));
        list.append(row);
      }
      const footer = el('div', 'inline-actions');
      if (this.actions.visible('stash-save')) footer.append(button('Save stash…', () => { close?.(); void this.actions.show('stash-save'); }, 'plus'));
      list.append(footer);
      await this.managerDialog('Stashes', list, callback => { close = callback; });
    } catch (error) { if (request.current()) this.showError(error); } finally { request.finish(); }
  }
  private async showRemotes(): Promise<void> {
    const repo = this.repo; if (!repo) return;
    const request = this.requests.begin('remote-panel');
    try {
      const remotes = await this.host.remotes(repo.id, request.id); if (!request.current() || this.repo?.id !== repo.id) return; this.remotes = remotes;
      const list = el('div', 'manager-list'); let close: (() => void) | undefined;
      if (!this.remotes.length) list.append(empty('No remotes configured', 'Add a remote URL to fetch and publish branches.'));
      for (const remote of this.remotes) {
        const description = el('div', 'manager-description', el('strong', '', remote.name), el('span', 'mono wrap', remote.fetchUrl));
        if (remote.pushUrl !== remote.fetchUrl) description.append(el('small', 'mono muted wrap', `push: ${remote.pushUrl}`));
        const row = el('div', 'manager-row', description);
        for (const [kind, label] of [['fetch', 'Fetch'], ['prune', 'Prune'], ['remote-edit', 'Edit'], ['remote-remove', 'Remove']] as const) if (this.actions.visible(kind)) row.append(button(label, () => { close?.(); void this.actions.show(kind, { remote: remote.name, url: remote.fetchUrl }); }, undefined, kind === 'remote-remove' ? 'danger-text' : ''));
        row.append(button('Copy fetch URL', () => this.copy(remote.fetchUrl), 'copy', '', true)); list.append(row);
      }
      const footer = el('div', 'inline-actions'); if (this.actions.visible('remote-add')) footer.append(button('Add remote…', () => { close?.(); void this.actions.show('remote-add'); }, 'plus')); if (this.actions.visible('identity')) footer.append(button('Git identity…', () => { close?.(); void this.actions.show('identity'); }, 'identity')); list.append(footer);
      await this.managerDialog('Remotes & identity', list, callback => { close = callback; });
    } catch (error) { if (request.current()) this.showError(error); } finally { request.finish(); }
  }
  private managerDialog(titleText: string, body: HTMLElement, register: (close: () => void) => void): Promise<void> {
    const dialog = el('dialog', 'dialog manager-dialog'); const title = el('h2', '', titleText); title.id = 'manager-title'; dialog.setAttribute('aria-labelledby', title.id);
    const previous = document.activeElement as HTMLElement | null;
    return new Promise(resolve => {
      const close = (): void => { dialog.close(); dialog.remove(); previous?.focus({ preventScroll: true }); resolve(); };
      register(close); dialog.append(el('header', 'dialog-header', title, button('Close', close, 'close', '', true)), el('div', 'dialog-body', body), el('footer', 'dialog-footer', button('Close', close)));
      dialog.addEventListener('cancel', event => { event.preventDefault(); close(); }); document.body.append(dialog); dialog.showModal();
    });
  }

  private async execute(action: GitAction, label: string): Promise<ActionResult | null> {
    if (this.actionBusy || this.repo?.id !== action.repoId) return null;
    this.actionBusy = true; const request = this.requests.begin('action'); action.requestId = request.id;
    this.buildToolbar(); this.renderStatus(); this.operationbar.hidden = false;
    const cancel = button('Cancel process', async () => {
      if (!await confirmDialog('Cancel the running Git process?', 'Cancellation stops the process but does not roll back completed changes. Refresh and inspect the repository afterward. Merge/rebase state can be continued or aborted separately.', 'Cancel process', true)) return;
      try { await this.host.cancel(request.id); this.toast('Cancellation requested. Waiting for Git to stop…'); } catch (error) { this.showError(error); }
    }, 'stop');
    this.operationbar.replaceChildren(el('span', 'spinner'), el('strong', '', label), el('span', 'muted', 'Git operation in progress'), el('span', 'spacer'), cancel);
    let result: ActionResult | null = null;
    try { result = await this.host.action(action); if (this.repo?.id === action.repoId) { if (result.status !== 'started') { this.taskSequence++; this.toast(`${label} completed.`); } else if (result.sessionId) { const existing = this.sessions.get(result.sessionId); if (!existing || !['completed', 'failed'].includes(existing.status)) this.sessions.set(result.sessionId, { id: result.sessionId, repoId: action.repoId, kind: action.kind, status: 'started', exitCode: null, operation: result.operation, message: result.output }); } } }
    catch (error) { this.showError(error); }
    finally {
      request.finish(); this.actionBusy = false; this.buildToolbar(); this.renderStatus();
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
    this.trustbar.replaceChildren(icon('shield'), el('span', '', 'Read-only until trusted.'), el('span', 'muted trust-explanation', 'Repository hooks and external tools can execute local code.'), el('span', 'spacer'), button('Trust repository…', () => { void this.actions.trust(); }, 'shield'));
  }
  private persistTrust(): void {
    if (!this.repo) return;
    this.store.state.trusted = this.store.state.trusted.filter(path => path !== this.repo!.path); if (this.repo.trusted) this.store.state.trusted.push(this.repo.path); this.store.queue();
  }
  private async toggleTrust(): Promise<void> {
    if (!this.repo || this.actionBusy) return;
    if (!this.repo.trusted) { await this.actions.trust(); return; }
    if (!await confirmDialog('Revoke repository trust?', 'History and diffs remain readable. Git mutations and external tools will require trust again.', 'Revoke trust')) return;
    try { await this.host.trustRepository(this.repo.id, false); this.repo.trusted = false; this.persistTrust(); this.renderTrust(); } catch (error) { this.showError(error); }
  }
  private renderOperation(): void {
    if (this.actionBusy) return;
    const session = [...this.sessions.values()].reverse().find(item => item.repoId === this.repo?.id && ['started', 'running', 'paused', 'failed'].includes(item.status));
    const working = this.working; this.operationbar.hidden = !working?.operation && !session;
    if (session) {
      this.operationbar.replaceChildren(icon(session.status === 'failed' ? 'warning' : 'terminal'), el('strong', '', `${session.kind} · ${session.status}`), el('span', 'muted', session.message || 'External Git session'), el('span', 'spacer'), button('Session details', () => { void textDialog('External session', `${session.kind} · ${session.status}\nExit code: ${session.exitCode ?? '—'}\nOperation: ${session.operation ?? '—'}\n\n${session.message}`); }), button('Open terminal', () => { void this.openTerminal(); }, 'terminal'));
      if (!working?.operation) return;
    }
    if (!working?.operation) return;
    this.operationbar.replaceChildren(icon('warning'), el('strong', '', `${working.operation} in progress`), el('span', 'muted', working.conflicts ? `${working.conflicts} conflicted files — resolve and stage in your editor/terminal.` : 'Inspect staged changes before continuing.'), el('span', 'spacer'), button('Open terminal', () => { void this.openTerminal(); }, 'terminal'));
    if (this.actions.visible('continue')) this.operationbar.append(button('Continue…', () => { void this.actions.show('continue'); }, 'play'));
    if (this.actions.visible('abort')) this.operationbar.append(button('Abort…', () => { void this.actions.show('abort'); }, 'stop', 'danger-text'));
  }
  private async openTerminal(): Promise<void> {
    if (!this.repo || !await this.actions.trust()) return;
    try { await this.host.openTerminal(this.repo.id); } catch (error) { this.showError(error); }
  }
  private openSettings(): void { void showSettings(this.host, this.store, this.repo, this.diagnostics, () => this.settingsChanged(), error => this.showError(error)); }
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
    this.saveView();
  }
  private applySettings(): void {
    const settings = this.settings; this.settingsSnapshot = structuredClone(settings);
    document.documentElement.dataset.theme = settings.theme; document.documentElement.style.setProperty('--font-size', `${settings.fontSize}px`);
    document.documentElement.style.colorScheme = settings.theme === 'system' ? 'dark light' : settings.theme;
    this.applyLayout();
  }
  private createDetailResizer(): HTMLElement {
    const right = this.settings.detailPosition === 'right';
    const handle = resizer(right ? 'vertical' : 'horizontal', () => this.detailSize, (value, final) => {
      this.detailSize = value; this.applyLayout(false); if (this.settings.detailPosition === 'inline') this.renderTable(); if (final) { this.store.state.layout.detailSize = value; this.store.queue(); }
    }, right ? 300 : 140, () => right ? Math.max(300, this.workspace.clientWidth - 340) : Math.max(140, this.workspace.clientHeight - 130), true, 'Resize commit details');
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
    for (const surface of [this.root, this.shell]) { surface.dataset.repoPath = repo?.path ?? ''; surface.dataset.repoHead = repo?.head ?? ''; surface.dataset.taskState = this.actionBusy || this.loadingHistory || this.loadingRepo || this.metadataLoading || externalRunning ? 'running' : 'idle'; surface.dataset.taskSequence = String(this.taskSequence); surface.dataset.configDirectory = this.diagnostics?.configDirectory ?? ''; }
    this.statusText.replaceChildren();
    if (repo) {
      this.statusText.append(icon(repo.trusted ? 'branch' : 'shield'), el('span', '', repo.branch ?? (repo.head ? `Detached ${shortOid(repo.head)}` : 'Unborn branch')));
      if (this.working) this.statusText.append(el('span', 'muted', `↑${this.working.ahead} ↓${this.working.behind}`), el('span', 'muted', `${this.working.files.length} changed`));
      else this.statusText.append(el('span', 'muted', this.metadataLoading ? 'Working tree status loading…' : 'Working tree status unknown'));
      this.statusText.title = repo.path;
    } else this.statusText.append(el('span', 'muted', this.diagnostics?.platform ?? 'Local Git history'));
    if (!this.actionBusy) this.taskText.textContent = this.loadingRepo ? 'Opening repository…' : this.loadingHistory ? `Loading history · ${this.commits.length.toLocaleString()} commits` : this.metadataLoading ? 'Refreshing repository…' : this.compareBase ? `Compare base ${shortOid(this.compareBase)} · Shift-select target` : this.diagnostics?.gitVersion ?? 'Git unavailable';
    else this.taskText.textContent = 'Git operation running';
    if (this.refreshButton) this.refreshButton.classList.toggle('is-loading', this.loadingHistory || this.metadataLoading);
  }
  private showError(error: unknown): void {
    const message = errorMessage(error); this.errorbar.hidden = false;
    const summary = message.split('\n')[0];
    this.errorbar.replaceChildren(icon('warning'), el('span', 'error-summary', summary), el('span', 'spacer'), button('Details', () => { void textDialog('Operation error', message); }), button('Copy error', () => this.copy(message), 'copy', '', true), button('Dismiss error', () => { this.errorbar.hidden = true; }, 'close', '', true));
  }
  private toast(message: string): void {
    clearTimeout(this.toastTimer); this.toastElement.textContent = message; this.toastElement.hidden = false;
    this.toastTimer = setTimeout(() => { this.toastElement.hidden = true; }, 5000);
  }
  private copy(text: string): void { void this.host.copy(text).then(() => this.toast('Copied to clipboard.')).catch(error => this.showError(error)); }
  private makeUrl(template: string, id: string, oid: string): string | null {
    try {
      const url = new URL(template.replaceAll('{id}', encodeURIComponent(id)).replaceAll('{commit}', encodeURIComponent(oid)).replaceAll('{branch}', encodeURIComponent(this.repo?.branch ?? '')));
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
  private async openPrLink(oid: string): Promise<void> {
    const values = await formDialog({ title: 'Open pull request', fields: [{ name: 'id', label: 'Pull request number', required: true, value: '' }], confirm: 'Open link', validate: values => /^\d+$/.test(String(values.id)) ? null : 'Enter a numeric pull request ID.' });
    if (!values) return; const url = this.makeUrl(this.settings.pullRequestUrl, String(values.id), oid);
    if (url) { try { await this.host.openUrl(url); } catch (error) { this.showError(error); } } else this.showError('Configure a valid pull request URL template in settings.');
  }

  private keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || overlayOpen()) return;
    const mod = event.ctrlKey || event.metaKey, editable = editableTarget(event.target), shortcuts = this.settings.shortcuts;
    if (matchesShortcut(event, shortcuts.find)) { event.preventDefault(); this.searchInput.focus(); this.searchInput.select(); }
    else if (matchesShortcut(event, shortcuts.refresh) || event.key === 'F5') { event.preventDefault(); void this.refresh(); }
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
    this.workingDirtyEpoch++;
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
    this.saveView(); this.disposed = true; this.refreshQueue.dispose(); this.requests.cancelAll(); this.unlisten?.(); this.unlistenExternal?.(); this.table.destroy(); this.details.destroy(); this.hoverContainment(null);
    clearTimeout(this.searchTimer); clearTimeout(this.watcherTimer); clearTimeout(this.focusTimer); clearTimeout(this.viewTimer); clearTimeout(this.toastTimer); clearTimeout(this.hoverTimer);
    document.removeEventListener('keydown', this.keydown); window.removeEventListener('beforeunload', this.beforeUnload); document.removeEventListener('visibilitychange', this.visibilityChanged); window.removeEventListener('focus', this.windowFocused);
  }
}

import type { AppSettings, ChangedFile, CommitDetail, DiffQuery, DiffResult, Host, Repository, ReviewTarget, VerificationResult, WorkingState } from '../shared/protocol';
import { cacheableDiff, detailBytes, diffBytes, diffCacheKey, FileTreeCache, fileWindow, immutableSelection, type ContentSide, type FileNode } from '../lib/diff';
import { commitDate, dateText, errorText, isImmutableOid, LruCache, numberText, shortOid } from '../lib/format';
import { m } from '../i18n/history';
import { m as detailMessage } from '../i18n/commit-details';
import './details.css';
import { Requests, type StateStore } from '../lib/state';
import { performanceDiagnostics as perf, type PerformanceContext, type PerformanceOutcome } from '../lib/performance';
import { badge, button, checkbox, contextMenu, disposeBindings, el, empty, loading, menuAtButton, resizer, select, setAttribute, textDialog, type MenuItem } from './dom';
import { DiffView, type DiffViewState } from './diff-view';
import { icon } from './icons';
import { renderMessage } from './message';

export type DetailSelection = { kind: 'commit'; oid: string; parent?: string } | { kind: 'working' } | { kind: 'compare'; base: string; target: string };
export interface DetailViewSnapshot {
  selection: DetailSelection; path?: string; scrollTop?: number; collapsed?: string[];
  filesScrollTop?: number; filesScrollLeft?: number; fullMessage?: boolean; inlineSide?: 'above' | 'below'; activeNode?: string;
  fileFilter?: string; workingMode?: 'all' | 'staged' | 'unstaged'; diff?: DiffViewState;
}
export interface HistoryFileRequest {
  repo: Repository; selection: Exclude<DetailSelection, { kind: 'working' }>;
  files: readonly ChangedFile[]; path: string; subject?: string;
}
export interface DetailsOptions { mode?: 'legacy' | 'history' }
interface DetailsContext { repo: Repository | null; settings: AppSettings; working: WorkingState | null }
export interface DetailCallbacks {
  context: () => DetailsContext; settings: (patch: Partial<AppSettings>) => void; error: (error: unknown) => void;
  copy: (text: string) => void; action: (name: 'commit' | 'stash-save' | 'reset') => void;
  close: () => void; follow: (oid: string) => void; ensureTrust: () => Promise<boolean>;
  openUrl: (url: string) => void; changed?: () => void;
  /** Metadata/file-tree mode never loads a patch itself. Successful document opens mark review paths. */
  openHistoryFile?: (request: HistoryFileRequest) => void | Promise<void>;
  heightChanged?: (height: number) => void;
}
interface VisibleFileNode { key: string; path: string; name: string; file?: ChangedFile; level: number; parent?: string; expanded?: boolean; position: number; siblings: number }
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error' | 'cancelled';
const FILE_ROW_HEIGHT = 24, VIRTUAL_FILES_THRESHOLD = 200;
interface SideContent { content: string | null; binary: boolean; truncated: boolean }
export class DetailsPane {
  readonly element = el('section', 'details-pane');
  private header = el('div', 'detail-header');
  private metadata = el('div', 'commit-metadata');
  private historyInfo = el('div', 'history-detail-info-content');
  private body = el('div', 'detail-body');
  private filesPane = el('aside', 'files-pane');
  private fileToolbar = el('div', 'file-toolbar');
  private fileList = el('div', 'file-list');
  private diffPane = el('div', 'diff-pane');
  private diffHeader = el('div', 'file-diff-header');
  private diffContainer = el('div', 'diff-container');
  private diffView: DiffView;
  private requests: Requests;
  private detailCache = new LruCache<CommitDetail>(36, 12 * 1024 * 1024, detailBytes);
  private diffCache = new LruCache<DiffResult>(20, 32 * 1024 * 1024, diffBytes);
  private contentCache = new LruCache<SideContent>(24, 16 * 1024 * 1024, side => 64 + (side.content?.length ?? 0) * 2);
  private legacyResults = new WeakSet<DiffResult>();
  private loadedSides = new Set<ContentSide>();
  private sideContents: Partial<Record<ContentSide, SideContent>> = {};
  private contentPending: { side: ContentSide; promise: Promise<SideContent> } | null = null;
  private contentGeneration = 0;
  private detailStatus: LoadStatus = 'idle';
  private diffStatus: LoadStatus = 'idle';
  private showPending: Promise<void> | null = null;
  private diffPending: Promise<void> | null = null;
  private activeDiffKey = '';
  private treeCache = new FileTreeCache<ChangedFile>();
  private filteredCache: { files: ChangedFile[]; filter: string; mode: string; working: boolean; value: ChangedFile[] } | null = null;
  private preparedFiles: { files: ChangedFile[]; view: AppSettings['fileView']; compact: boolean; collapse: number } | null = null;
  private collapseRevision = 0;
  private filesByPath = new Map<string, ChangedFile>();
  private fileIndexSource: ChangedFile[] | null = null;
  private renderedNodes = new Map<string, HTMLElement>();
  private fileRows = el('div', 'file-rows');
  private virtualFiles = false;
  private fileFrame = 0;
  private filesObserver: ResizeObserver;
  private lastWorkingFiles: ChangedFile[] | null = null;
  private workingVisibleFiles: ChangedFile[] = [];
  private lastShowUntracked = true;
  private selection: DetailSelection | null = null;
  private detail: CommitDetail | null = null;
  private files: ChangedFile[] = [];
  private selectedFile: string | null = null;
  private fileFilter = '';
  private workingMode: 'all' | 'staged' | 'unstaged' = 'all';
  private collapsed = new Set<string>();
  private visibleNodes: VisibleFileNode[] = [];
  private activeNode = '';
  private epoch = 0;
  private displayedResult: DiffResult | null = null;
  private fileSize: number;
  private lastRepo = '';
  private verification: VerificationResult['status'] | null = null;
  private legacySplitter: HTMLElement;
  private historySplitter: HTMLElement;
  private heightSplitter: HTMLElement;
  private measureObserver: ResizeObserver;
  private measureFrame = 0;
  private measuredHeight = 320;
  private fullMessage = false;
  private inlineSide: 'above' | 'below' = 'below';
  private historyRatio = 0.55;
  private snapshots = new LruCache<DetailViewSnapshot>(96, 2 * 1024 * 1024);
  private destroyed = false;

  constructor(private readonly host: Host, private readonly store: StateStore, private readonly callbacks: DetailCallbacks, private readonly options: DetailsOptions = {}) {
    this.requests = new Requests(id => host.cancel(id)); this.fileSize = store.state.layout.fileSize;
    this.fileList.tabIndex = 0; this.fileList.setAttribute('role', 'tree'); setAttribute(this.fileList, 'aria-label', m('details.changedFiles'));
    this.fileList.addEventListener('keydown', event => this.fileKeydown(event));
    this.fileList.addEventListener('scroll', () => { this.scheduleFiles(); callbacks.changed?.(); });
    this.filesObserver = new ResizeObserver(() => this.scheduleFiles()); this.filesObserver.observe(this.fileList);
    this.metadata.addEventListener('scroll', () => callbacks.changed?.());
    this.filesPane.append(this.fileToolbar, this.fileList); this.diffPane.append(this.diffHeader, this.diffContainer);
    const splitter = resizer('vertical', () => this.fileSize, (value, final) => {
      this.fileSize = value; this.element.style.setProperty('--files-width', `${value}px`);
      if (final) { store.state.layout.fileSize = value; store.queue(); }
    }, 150, () => Math.min(700, this.element.clientWidth * 0.55), false, m('details.resizeFiles'));
    this.legacySplitter = splitter;
    this.historyRatio = this.store.state.layout.detailRatio ?? 0.55;
    this.historySplitter = resizer('vertical', () => this.historyWidth() * this.historyRatio, (value, final) => {
      this.historyRatio = Math.max(0.25, Math.min(0.8, value / this.historyWidth())); this.applyHistoryRatio(); this.measure();
      if (final) { this.store.state.layout.detailRatio = this.historyRatio; this.store.queue(); this.callbacks.changed?.(); }
    }, 190, () => Math.max(190, this.historyWidth() - 195), false, detailMessage('details.resizeColumns'));
    this.historySplitter.classList.add('history-detail-width-resizer');
    this.heightSplitter = resizer('horizontal', () => this.store.state.layout.detailSize, (value, final) => {
      this.store.state.layout.detailSize = value; this.measure();
      if (final) { this.store.queue(); this.callbacks.changed?.(); }
    }, 190, () => 1200, false, detailMessage('details.resizeHeight'));
    this.heightSplitter.classList.add('history-detail-height-resizer'); this.heightSplitter.hidden = true;
    this.diffView = new DiffView(view => { callbacks.settings({ diffView: view }); }, text => callbacks.copy(text));
    this.diffView.element.addEventListener('scroll', () => callbacks.changed?.(), true);
    this.body.append(this.filesPane, splitter, this.diffPane); this.element.append(this.header, this.metadata, this.body);
    this.measureObserver = new ResizeObserver(() => this.scheduleMeasure()); this.measureObserver.observe(this.historyInfo); this.measureObserver.observe(this.element);
    this.element.style.setProperty('--files-width', `${this.fileSize}px`); setAttribute(this.element, 'aria-label', m('details.label'));
  }
  private get historyMode(): boolean { return this.options.mode === 'history' && this.selection?.kind !== 'working'; }
  private historyWidth(): number { return Math.max(390, this.body.clientWidth || this.element.clientWidth || 720); }
  private applyHistoryRatio(): void { this.element.style.setProperty('--detail-info-width', `${this.historyRatio * 100}%`); }
  private configureLayout(): void {
    const history = this.historyMode; this.element.classList.toggle('history-details', history); this.element.tabIndex = history ? 0 : -1;
    this.heightSplitter.hidden = !history;
    if (history) {
      if (this.metadata.parentElement !== this.body) this.body.replaceChildren(this.metadata, this.historySplitter, this.filesPane);
      if (this.heightSplitter.parentElement !== this.element) this.element.append(this.heightSplitter);
      this.applyHistoryRatio(); this.element.dataset.inlineSide = this.inlineSide; this.scheduleMeasure();
    } else {
      if (this.metadata.parentElement !== this.element) { this.body.replaceChildren(this.filesPane, this.legacySplitter, this.diffPane); this.element.replaceChildren(this.header, this.metadata, this.body); }
      this.body.style.height = ''; this.element.style.removeProperty?.('--history-detail-height');
    }
  }
  /** Stable height owned by history geometry, not a nested metadata scroll area. */
  get preferredHeight(): number { return this.historyMode ? this.measuredHeight : this.store.state.layout.detailSize; }
  measure(): number {
    if (!this.historyMode || this.destroyed || this.element.hidden) return this.preferredHeight;
    const contentHeight = (this.historyInfo.scrollHeight || this.historyInfo.getBoundingClientRect().height || 0) + 20;
    const base = Math.max(190, this.store.state.layout.detailSize || 320), height = Math.ceil(Math.max(base, contentHeight + 37));
    this.body.style.height = `${height - 37}px`; this.element.style.setProperty('--history-detail-height', `${height}px`);
    if (height !== this.measuredHeight) { this.measuredHeight = height; this.callbacks.heightChanged?.(height); }
    return height;
  }
  private scheduleMeasure(): void { if (this.historyMode && !this.measureFrame) this.measureFrame = requestAnimationFrame(() => { this.measureFrame = 0; this.measure(); }); }
  setInlineSide(side: 'before' | 'after' | 'above' | 'below'): void { this.inlineSide = side === 'before' || side === 'above' ? 'above' : 'below'; this.element.dataset.inlineSide = this.inlineSide; }
  private snapshotKey(repoId: string, selection: DetailSelection): string { return JSON.stringify([repoId, selection]); }
  private remember(): void { const snapshot = this.view; if (snapshot && this.lastRepo && this.detailStatus === 'ready') this.snapshots.set(this.snapshotKey(this.lastRepo, snapshot.selection), snapshot); }
  get view(): DetailViewSnapshot | null {
    return this.selection ? { selection: structuredClone(this.selection), path: this.selectedFile ?? undefined, scrollTop: this.metadata.scrollTop, collapsed: [...this.collapsed], filesScrollTop: this.fileList.scrollTop, filesScrollLeft: this.fileList.scrollLeft, fullMessage: this.fullMessage, inlineSide: this.inlineSide, activeNode: this.activeNode, fileFilter: this.fileFilter, workingMode: this.workingMode, ...(this.historyMode ? {} : { diff: this.diffView.getState() }) } : null;
  }
  show(selection: DetailSelection, force = false, restore?: Partial<DetailViewSnapshot>, performanceContext?: PerformanceContext): Promise<void> {
    const repo = this.callbacks.context().repo; if (!repo) return Promise.resolve();
    const same = JSON.stringify(this.selection) === JSON.stringify(selection) && this.lastRepo === repo.id;
    if (!force && same && !restore) {
      if (this.showPending && (this.detailStatus === 'loading' || this.diffStatus === 'loading')) return this.showPending;
      if (this.detailStatus === 'ready') {
        if (this.diffStatus === 'loading' && this.diffPending) return this.diffPending;
        if ((this.diffStatus === 'error' || this.diffStatus === 'cancelled') && this.selectedFile) return this.selectFile(this.selectedFile, undefined, performanceContext);
        const operation = perf.operation('details', undefined, performanceContext);
        operation.paint('file-list-paint-opportunity', { count: this.files.length, cacheHit: true, outcome: 'reused' }); operation.end({ count: this.files.length, cacheHit: true, outcome: 'reused' });
        return Promise.resolve();
      }
    }
    const pending = this.loadSelection(selection, force, restore, performanceContext); this.showPending = pending;
    const finish = (): void => { if (this.showPending === pending) this.showPending = null; }; void pending.then(finish, finish);
    return pending;
  }
  private async loadSelection(selection: DetailSelection, force: boolean, restore?: Partial<DetailViewSnapshot>, performanceContext?: PerformanceContext): Promise<void> {
    const context = this.callbacks.context(), repo = context.repo; if (!repo) return;
    const operation = perf.operation('details', { oid: selection.kind === 'commit' ? selection.oid : selection.kind === 'compare' ? selection.target : undefined }, performanceContext);
    let outcome: PerformanceOutcome = 'ok', cacheHit = false;
    const metadataSpan = operation.span('metadata');
    try {
    const same = JSON.stringify(this.selection) === JSON.stringify(selection) && this.lastRepo === repo.id;
    this.remember();
    const saved = restore ?? (force && same ? this.view ?? undefined : this.snapshots.get(this.snapshotKey(repo.id, selection)));
    this.requests.cancelAll(); this.contentGeneration++; const epoch = ++this.epoch;
    this.detailStatus = 'loading'; this.diffStatus = 'idle'; this.diffPending = null; this.activeDiffKey = ''; this.contentPending = null;
    this.loadedSides.clear(); this.sideContents = {}; this.filteredCache = null; this.preparedFiles = null; this.collapseRevision++;
    this.lastRepo = repo.id; this.selection = structuredClone(selection); this.detail = null; this.displayedResult = null; this.verification = null;
    this.files = []; this.selectedFile = null; this.fileFilter = saved?.fileFilter ?? ''; this.workingMode = saved?.workingMode ?? 'all'; this.collapsed = new Set(saved?.collapsed ?? []); this.activeNode = saved?.activeNode ?? '';
    this.fullMessage = saved?.fullMessage ?? false; if (restore?.inlineSide) this.inlineSide = restore.inlineSide;
    this.configureLayout();
    this.fileSize = this.store.state.layout.fileSize; this.element.style.setProperty('--files-width', `${this.fileSize}px`);
    this.element.hidden = false; this.metadata.hidden = false; this.metadata.replaceChildren(loading(m('details.loading'), () => this.cancel()));
    this.fileList.replaceChildren(); this.renderedNodes.clear(); this.visibleNodes = []; this.fileList.scrollTop = 0; this.diffHeader.replaceChildren(); this.diffView.clear(); this.diffContainer.replaceChildren(); this.renderHeader();
    const request = this.requests.begin('detail'); operation.request(request.id);
    try {
      if (selection.kind === 'commit') {
        const key = `${repo.id}:${selection.oid}:${selection.parent ?? ''}:mailmap=${context.settings.mailmap}`;
        let detail = !force && immutableSelection(selection) ? this.detailCache.get(key) : undefined;
        cacheHit = Boolean(detail);
        if (!detail) detail = await operation.run(() => this.host.commitDetail(repo.id, selection.oid, request.id, selection.parent));
        if (!this.current(request, epoch, repo.id)) { outcome = 'stale'; return; }
        if (!cacheHit && immutableSelection(selection)) this.detailCache.set(key, detail);
        this.detail = detail; this.files = detail.files;
      } else if (selection.kind === 'compare') {
        const files = await operation.run(() => this.host.compare({ repoId: repo.id, requestId: request.id, base: selection.base, target: selection.target }));
        if (!this.current(request, epoch, repo.id)) { outcome = 'stale'; return; }
        this.files = files;
      } else { this.files = this.workingFiles(); }
      if (!this.current(request, epoch, repo.id)) { outcome = 'stale'; return; }
      this.detailStatus = 'ready';
      operation.run(() => { this.renderHeader(); this.renderMetadata(); this.renderFileToolbar(); this.renderFiles(); });
      metadataSpan.end({ requestId: request.id, cacheHit, count: this.files.length, outcome });
      operation.paint('file-list-paint-opportunity', { requestId: request.id, count: this.files.length, cacheHit });
      const filtered = this.filteredFiles(), first = filtered.find(file => file.path === saved?.path) ?? filtered[0];
      if (this.historyMode) {
        this.selectedFile = saved?.path && this.fileAt(saved.path) ? saved.path : null;
        this.activeNode = saved?.activeNode ?? (this.selectedFile ? `file:${this.selectedFile}` : this.visibleNodes[0]?.key ?? ''); this.updateFileRows();
      } else if (first) await this.selectFile(first.path, saved?.diff, operation.context);
      else this.diffContainer.replaceChildren(empty(selection.kind === 'working' ? context.working === null ? m('details.statusNotLoaded') : m('details.clean') : m('details.noChangedFiles'), selection.kind === 'commit' && this.detail?.commit.parents.length ? m('details.chooseParent') : undefined));
      if (this.epoch !== epoch || this.callbacks.context().repo?.id !== repo.id) { outcome = 'stale'; return; }
      const diffStatus = this.currentDiffStatus(); if (diffStatus === 'error' || diffStatus === 'cancelled') outcome = diffStatus;
      this.metadata.scrollTop = this.historyMode ? 0 : saved?.scrollTop ?? 0; this.fileList.scrollTop = saved?.filesScrollTop ?? 0; this.fileList.scrollLeft = saved?.filesScrollLeft ?? 0; this.renderFileWindow();
      if (this.historyMode) this.measure(); this.callbacks.changed?.();
    } catch (error) {
      outcome = this.current(request, epoch, repo.id) ? 'error' : 'cancelled';
      if (this.current(request, epoch, repo.id)) { this.detailStatus = 'error'; this.metadata.replaceChildren(el('div', 'inline-error', errorText(error), button(m('details.retry'), () => { void this.show(selection, true); }, 'refresh'))); this.callbacks.error(error); }
    } finally { request.finish(); }
    } finally { metadataSpan.end({ outcome, cacheHit }); operation.end({ outcome, cacheHit, count: this.files.length }); }
  }
  private current(request: { current: () => boolean }, epoch: number, repoId: string): boolean { return request.current() && this.epoch === epoch && this.callbacks.context().repo?.id === repoId; }
  clear(): void {
    this.remember();
    this.requests.cancelAll(); this.contentGeneration++; this.epoch++; this.detailStatus = 'idle'; this.diffStatus = 'idle'; this.showPending = null; this.diffPending = null; this.contentPending = null;
    this.selection = null; this.detail = null; this.displayedResult = null; this.loadedSides.clear(); this.sideContents = {}; this.diffView.clear(); this.element.hidden = true;
  }
  invalidate(): void { this.detailCache.clear(); this.diffCache.clear(); this.contentCache.clear(); this.treeCache.clear(); this.diffView.clearCache(); this.legacyResults = new WeakSet(); }
  /** Explicit refresh also supports immutable selections after mailmap/config invalidation. */
  refresh(): void { if (this.selection) void this.show(this.selection, true); }
  private currentDiffStatus(): LoadStatus { return this.diffStatus; }
  /** Locale bindings update owned text/attributes in place; never enter selection/settings/load paths. */
  updateLocale(): void { this.diffView.updateLocale(); }
  updateSettings(): void {
    this.fileSize = this.store.state.layout.fileSize; this.element.style.setProperty('--files-width', `${this.fileSize}px`);
    if (!this.selection) return;
    this.historyRatio = this.store.state.layout.detailRatio ?? .55; this.configureLayout();
    const settings = this.callbacks.context().settings;
    this.element.classList.toggle('details-right', settings.detailPosition === 'right');
    if (this.detailStatus !== 'ready') { this.renderHeader(); return; }
    if (this.selection.kind === 'working') this.files = this.workingFiles();
    this.renderHeader(); this.renderMetadata(); this.renderFileToolbar(); this.renderFiles(); this.renderDiffHeader();
    if (this.displayedResult && this.diffStatus === 'ready') this.diffView.set(this.displayedResult, settings, false);
  }
  private workingFiles(): ChangedFile[] {
    const context = this.callbacks.context(), files = context.working?.files ?? null, showUntracked = context.settings.showUntracked;
    if (files === this.lastWorkingFiles && showUntracked === this.lastShowUntracked) return this.workingVisibleFiles;
    this.lastWorkingFiles = files; this.lastShowUntracked = showUntracked;
    return this.workingVisibleFiles = files === null ? [] : showUntracked ? files : files.filter(file => !file.status.startsWith('?'));
  }
  private cancel(): void {
    this.requests.cancelAll(); this.contentGeneration++; this.epoch++; this.detailStatus = 'cancelled'; this.diffStatus = 'cancelled'; this.diffView.clear(); this.displayedResult = null;
    this.metadata.replaceChildren(empty(m('details.cancelled')), button(m('details.retry'), () => { if (this.selection) void this.show(this.selection, true); }, 'refresh'));
  }
  private renderHeader(): void {
    const selection = this.selection; if (!selection) return;
    const title = selection.kind === 'commit' ? m('details.commit', { oid: shortOid(selection.oid) }) : selection.kind === 'working' ? m('table.workingTree') : `${shortOid(selection.base)} → ${shortOid(selection.target)}`;
    const position = this.callbacks.context().settings.detailPosition;
    this.header.replaceChildren(el('strong', 'detail-title', title));
    if (selection.kind === 'compare') this.header.append(badge(m('details.comparison')));
    this.header.append(el('span', 'spacer'));
    if (this.canReview()) {
      const key = this.reviewKey(), session = this.store.state.reviews.find(item => item.key === key && item.repoId === this.lastRepo), active = this.store.isReviewActive(key, this.lastRepo);
      const review = button(active ? m('review.active') : session ? m('review.resume') : m('review.start'), () => {
        if (active) menuAtButton(review, [{ label: m('review.endThis'), icon: 'stop', dataAction: 'end-review', action: () => { this.store.endReview(key, this.lastRepo); this.renderReview(); } }, { label: m('review.endAll'), dataAction: 'end-all-reviews', action: () => { this.store.endAllReviews(this.lastRepo); this.renderReview(); } }]);
        else { this.store.startReview(key, this.lastRepo, this.reviewTarget()!); this.renderReview(); }
      }, active ? 'check' : 'eye', active ? 'active review-control' : 'review-control');
      review.dataset.action = active ? 'review-menu' : session ? 'resume-review' : 'start-review'; review.setAttribute('aria-pressed', String(active)); this.header.append(review);
      if (active) this.header.append(button(m('review.end'), () => { this.store.endReview(key, this.lastRepo); this.renderReview(); }, 'stop', '', true));
    }
    if (selection.kind === 'commit') this.header.append(button(m('details.copyCommit'), () => this.callbacks.copy(selection.oid), 'copy', '', true));
    const move = button(m('details.position'), () => menuAtButton(move, (['inline', 'bottom', 'right'] as const).map(value => ({ label: m(`details.position.${value}`), checked: value === position, action: () => this.callbacks.settings({ detailPosition: value }) }))), position === 'right' ? 'split' : 'unified', '', true);
    this.header.append(move, button(m('details.close'), () => this.callbacks.close(), 'close', '', true));
  }
  private renderMetadata(): void {
    if (this.historyMode) { this.renderHistoryMetadata(); return; }
    const previousScroll = this.metadata.scrollTop; this.metadata.replaceChildren(); this.metadata.hidden = false;
    if (this.selection?.kind === 'commit' && this.detail) {
      const detail = this.detail, commit = detail.commit, settings = this.callbacks.context().settings;
      const subject = renderMessage(commit.subject, settings, this.callbacks.openUrl); subject.classList.add('detail-subject');
      const summary = el('div', 'detail-summary', el('span', '', `${commit.author} <${commit.email}>`), el('span', 'muted', dateText(commitDate(commit, settings.dateSource), settings.dateFormat)), el('span', 'mono muted', commit.oid));
      setAttribute(summary, 'title', m('details.dates', { authored: dateText(commit.authoredAt, 'local'), committed: dateText(commit.committedAt, 'local') }));
      if (detail.committer && (detail.committer !== commit.author || detail.committerEmail !== commit.email)) summary.append(el('span', 'muted', m('details.committer', { name: detail.committer, email: detail.committerEmail })));
      if (settings.signatureDisplay) {
        const present = detail.signature.status && !['N', 'none', 'unsigned'].includes(detail.signature.status);
        summary.append(badge(this.verification ? m('signature.label', { status: m(`signature.${this.verification}`) }) : present ? m('details.signaturePresent') : m('details.unsigned'), '', `${detail.signature.signer} ${detail.signature.key}`));
      }
      const verify = button(m('details.verifySignature'), () => { void this.verifySignature(commit.oid); }, 'shield', 'text-button'); verify.dataset.action = 'verify-commit'; summary.append(verify);
      this.metadata.append(subject, summary);
      if (detail.body && detail.body !== commit.subject) { const body = el('details', 'message-body'); body.append(el('summary', '', m('details.fullMessage')), renderMessage(detail.body, settings, this.callbacks.openUrl)); this.metadata.append(body); }
      if (commit.parents.length) {
        const parentRow = el('div', 'parent-row', el('span', 'muted', commit.parents.length > 1 ? m('details.compareParent') : m('details.parent')));
        if (commit.parents.length > 1) parentRow.append(select(commit.parents.map((parent, index) => ({ value: parent, label: `${index + 1}: ${shortOid(parent)}` })), detail.base ?? commit.parents[0], m('details.mergeParent'), parent => { void this.show({ kind: 'commit', oid: commit.oid, parent }, true); }));
        for (const parent of commit.parents) parentRow.append(button(shortOid(parent), () => this.callbacks.follow(parent), 'commit', 'text-button'));
        this.metadata.append(parentRow);
      }
    } else if (this.selection?.kind === 'compare') this.metadata.append(el('div', 'detail-summary', el('span', 'mono', `${this.selection.base} → ${this.selection.target}`), el('span', 'muted', immutableSelection(this.selection) ? m('details.immutableComparison') : m('details.mutableComparison'))));
    else if (this.selection?.kind === 'working') {
      const working = this.callbacks.context().working;
      this.metadata.append(el('div', 'detail-summary', el('span', '', working === null ? m('details.statusNotLoaded') : m('table.changedFiles', { count: numberText(this.files.length) })), el('span', 'muted', working === null ? m('details.aheadBehindUnknown') : m('details.aheadBehind', { ahead: numberText(working.ahead), behind: numberText(working.behind) })), el('span', 'muted', m('details.readOnlyWorking'))));
      const controls = el('div', 'working-controls', select([{ value: 'all', label: m('details.workingAll') }, { value: 'staged', label: m('details.workingStaged') }, { value: 'unstaged', label: m('details.workingUnstaged') }], this.workingMode, m('details.workingChanges'), value => {
        this.workingMode = value as typeof this.workingMode; this.renderFiles(); const filtered = this.filteredFiles(), first = filtered.find(file => file.path === this.selectedFile) ?? filtered[0];
        if (first) void this.selectFile(first.path); else { this.requests.cancel('diff'); this.cancelContent(); this.diffStatus = 'idle'; this.selectedFile = null; this.displayedResult = null; this.activeDiffKey = ''; this.diffView.clear(); this.diffContainer.replaceChildren(empty(m('details.noFilesInView'))); this.renderDiffHeader(); } this.callbacks.changed?.();
      }), button(m('details.openTerminal'), () => { void this.external(() => this.host.openTerminal(this.lastRepo)); }, 'terminal'));
      const hidden = this.callbacks.context().settings.hiddenActions;
      if (!hidden.includes('commit')) controls.append(button(m('details.commitStaged'), () => this.callbacks.action('commit'), 'commit'));
      if (!hidden.includes('stash-save')) controls.append(button(m('details.stash'), () => this.callbacks.action('stash-save'), 'stash'));
      if (!hidden.includes('reset')) controls.append(button(m('details.resetWorking'), () => this.callbacks.action('reset'), 'undo', 'danger-text'));
      this.metadata.append(controls);
    }
    this.metadata.scrollTop = previousScroll;
  }
  private renderHistoryMetadata(): void {
    this.metadata.hidden = false; this.historyInfo.replaceChildren(); this.metadata.replaceChildren(this.historyInfo);
    const settings = this.callbacks.context().settings;
    if (this.selection?.kind === 'commit' && this.detail) {
      const detail = this.detail, commit = detail.commit;
      const subject = renderMessage(commit.subject, settings, this.callbacks.openUrl); subject.classList.add('detail-subject');
      const facts = el('dl', 'history-detail-facts');
      const fact = (label: 'details.author' | 'details.date' | 'details.oid' | 'details.committer' | 'details.parents', value: HTMLElement): void => { facts.append(el('dt', '', detailMessage(label)), el('dd', '', value)); };
      fact('details.author', el('span', '', `${commit.author} <${commit.email}>`));
      const date = el('span', '', dateText(commitDate(commit, settings.dateSource), settings.dateFormat));
      setAttribute(date, 'title', m('details.dates', { authored: dateText(commit.authoredAt, 'local'), committed: dateText(commit.committedAt, 'local') })); fact('details.date', date);
      fact('details.oid', el('span', 'mono', commit.oid));
      if (detail.committer && (detail.committer !== commit.author || detail.committerEmail !== commit.email)) fact('details.committer', el('span', '', `${detail.committer} <${detail.committerEmail}>`));
      if (commit.parents.length) {
        const parents = el('div', 'parent-row');
        if (commit.parents.length > 1) parents.append(select(commit.parents.map((parent, index) => ({ value: parent, label: `${index + 1}: ${shortOid(parent)}` })), detail.base ?? commit.parents[0], m('details.mergeParent'), parent => { void this.show({ kind: 'commit', oid: commit.oid, parent }, true); }));
        for (const parent of commit.parents) parents.append(button(shortOid(parent), () => this.callbacks.follow(parent), 'commit', 'text-button'));
        fact('details.parents', parents);
      }
      const signature = el('div', 'history-detail-signature');
      if (settings.signatureDisplay) {
        const present = detail.signature.status && !['N', 'none', 'unsigned'].includes(detail.signature.status);
        signature.append(badge(this.verification ? m('signature.label', { status: m(`signature.${this.verification}`) }) : present ? m('details.signaturePresent') : m('details.unsigned'), '', `${detail.signature.signer} ${detail.signature.key}`));
      }
      const verify = button(m('details.verifySignature'), () => { void this.verifySignature(commit.oid); }, 'shield', 'text-button'); verify.dataset.action = 'verify-commit'; signature.append(verify);
      this.historyInfo.append(subject, facts, signature);
      if (detail.body && detail.body !== commit.subject) {
        const message = renderMessage(detail.body, settings, this.callbacks.openUrl); message.classList.add('history-detail-message'); message.hidden = !this.fullMessage; message.id = `commit-message-${encodeURIComponent(commit.oid)}`;
        const expand = button(detailMessage(this.fullMessage ? 'details.collapseMessage' : 'details.expandMessage'), () => {
          this.fullMessage = !this.fullMessage; this.renderHistoryMetadata(); this.measure(); this.callbacks.changed?.();
        }, undefined, 'history-message-toggle');
        expand.setAttribute('aria-expanded', String(this.fullMessage)); expand.setAttribute('aria-controls', message.id); expand.dataset.action = 'toggle-full-message';
        this.historyInfo.append(message, expand);
      }
    } else if (this.selection?.kind === 'compare') {
      this.historyInfo.append(el('div', 'detail-subject mono', `${this.selection.base} → ${this.selection.target}`), el('p', 'muted', immutableSelection(this.selection) ? m('details.immutableComparison') : m('details.mutableComparison')));
    }
    this.scheduleMeasure();
  }
  private async verifySignature(oid: string): Promise<void> {
    const repoId = this.lastRepo, epoch = this.epoch;
    if (!await this.callbacks.ensureTrust() || this.lastRepo !== repoId || this.epoch !== epoch) return;
    const request = this.requests.begin('verify');
    try { const result = await this.host.verify({ repoId, requestId: request.id, kind: 'commit', target: oid }); if (!this.current(request, epoch, repoId)) return; this.verification = result.status; this.renderMetadata(); await textDialog(m('signature.title'), m('signature.result', { status: m(`signature.${result.status}`), signer: result.signer || '—', key: result.key || '—', output: result.output })); }
    catch (error) { if (this.current(request, epoch, repoId)) this.callbacks.error(error); } finally { request.finish(); }
  }
  private canReview(): boolean {
    return immutableSelection(this.selection) && (this.selection.kind !== 'commit' || Boolean(this.detail && isImmutableOid(this.detail.commit.oid) && (this.detail.base === null || isImmutableOid(this.detail.base))));
  }
  private reviewTarget(): ReviewTarget | null {
    if (!this.canReview() || !this.selection || this.selection.kind === 'working') return null;
    return this.selection.kind === 'commit' ? { ...this.selection, parent: this.detail?.base ?? undefined } : { ...this.selection };
  }
  private reviewKey(): string {
    const selection = this.selection; if (!selection || selection.kind === 'working') return '';
    return selection.kind === 'commit' ? `commit:${selection.oid}:${this.detail?.base ?? 'ROOT'}` : `compare:${selection.base}:${selection.target}`;
  }
  private renderReview(): void { this.renderHeader(); this.updateFileRows(); this.renderFileToolbar(); this.renderDiffHeader(); this.callbacks.changed?.(); }
  private setReviewed(path: string, checked: boolean, automatic = false): void {
    if (!this.canReview()) return;
    const key = this.reviewKey();
    if (automatic && (!this.store.isReviewActive(key, this.lastRepo) || this.store.reviewed(key, this.lastRepo).has(path))) return;
    this.store.touchReview(key, this.lastRepo); this.store.review(key, this.lastRepo, path, checked); this.renderReview();
  }
  private filteredFiles(): ChangedFile[] {
    const search = this.fileFilter.toLocaleLowerCase(), working = this.selection?.kind === 'working', cached = this.filteredCache;
    if (cached?.files === this.files && cached.filter === search && cached.mode === this.workingMode && cached.working === working) return cached.value;
    const value = !search && (!working || this.workingMode === 'all') ? this.files : this.files.filter(file => (!search || `${file.path} ${file.oldPath ?? ''}`.toLocaleLowerCase().includes(search)) && (!working || this.workingMode === 'all' || (this.workingMode === 'staged' ? file.staged : file.unstaged)));
    this.filteredCache = { files: this.files, filter: search, mode: this.workingMode, working, value }; return value;
  }
  private fileAt(path: string | null): ChangedFile | undefined {
    if (this.fileIndexSource !== this.files) { this.filesByPath = new Map(this.files.map(file => [file.path, file])); this.fileIndexSource = this.files; }
    return path === null ? undefined : this.filesByPath.get(path);
  }
  private renderFileToolbar(): void {
    const settings = this.callbacks.context().settings;
    const filter = el('input', 'file-filter'); filter.type = 'search'; setAttribute(filter, 'placeholder', m('files.filter')); filter.value = this.fileFilter; setAttribute(filter, 'aria-label', m('files.filterLabel'));
    filter.addEventListener('input', () => { this.fileFilter = filter.value; this.fileList.scrollTop = 0; this.renderFiles(); this.callbacks.changed?.(); });
    filter.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); filter.value = ''; this.fileFilter = ''; this.fileList.scrollTop = 0; this.renderFiles(); this.fileList.focus(); } });
    const toggle = button(settings.fileView === 'tree' ? m('files.showList') : m('files.showTree'), () => this.callbacks.settings({ fileView: settings.fileView === 'tree' ? 'list' : 'tree' }), settings.fileView === 'tree' ? 'list' : 'tree', '', true);
    const reviewed = this.canReview() ? this.store.reviewed(this.reviewKey(), this.lastRepo) : new Set<string>();
    const count = this.canReview() ? m('files.reviewCount', { reviewed: numberText(this.files.filter(file => reviewed.has(file.path)).length), count: numberText(this.files.length) }) : m('table.changedFiles', { count: numberText(this.files.length) });
    this.fileToolbar.replaceChildren(filter, toggle, el('span', 'muted review-count', count));
    if (this.historyMode) this.fileToolbar.append(el('span', 'history-tree-hint muted', detailMessage('details.openHint')));
  }
  private nodeId(key: string): string { return `changed-file-${encodeURIComponent(key)}`; }
  private renderFiles(): void {
    const span = perf.span('details', 'file-list-render');
    try {
      const settings = this.callbacks.context().settings, files = this.filteredFiles(), previous = this.preparedFiles;
      this.fileList.setAttribute('role', settings.fileView === 'tree' ? 'tree' : 'listbox');
      if (previous?.files === files && previous.view === settings.fileView && previous.compact === settings.compactFolders && previous.collapse === this.collapseRevision) { this.updateFileRows(); return; }
      this.preparedFiles = { files, view: settings.fileView, compact: settings.compactFolders, collapse: this.collapseRevision }; this.visibleNodes = [];
      const walk = (nodes: FileNode<ChangedFile>[], level: number, parent?: string): void => {
        nodes.forEach((node, index) => {
          const key = `${node.file ? 'file' : 'folder'}:${node.path}`, expanded = !this.collapsed.has(node.path);
          this.visibleNodes.push({ key, path: node.path, name: node.name, file: node.file, level, parent, ...(node.file ? {} : { expanded }), position: index + 1, siblings: nodes.length });
          if (!node.file && expanded) walk(node.children, level + 1, key);
        });
      };
      if (settings.fileView === 'tree') walk(this.treeCache.get(files, settings.compactFolders), 0);
      else [...files].sort((a, b) => a.path.localeCompare(b.path)).forEach((file, index) => this.visibleNodes.push({ key: `file:${file.path}`, path: file.path, name: file.path, file, level: 0, position: index + 1, siblings: files.length }));
      if (!this.visibleNodes.some(node => node.key === this.activeNode)) this.activeNode = this.visibleNodes.find(node => node.file?.path === this.selectedFile)?.key ?? this.visibleNodes[0]?.key ?? '';
      this.virtualFiles = this.visibleNodes.length > VIRTUAL_FILES_THRESHOLD;
      this.fileRows = el('div', 'file-rows'); this.fileRows.setAttribute('role', 'presentation');
      if (this.historyMode) {
        const longest = this.visibleNodes.reduce((size, node) => Math.max(size, node.name.length + node.level * 2), 0);
        this.fileRows.style.minWidth = `${Math.max(260, Math.min(32768, longest * Math.max(7, settings.fontSize * .58) + 140))}px`;
      }
      if (this.virtualFiles) { this.fileRows.style.position = 'relative'; this.fileRows.style.height = `${this.visibleNodes.length * FILE_ROW_HEIGHT}px`; if (!this.historyMode) this.fileRows.style.minWidth = '100%'; }
      this.renderedNodes.clear(); this.fileList.replaceChildren(this.fileRows);
      if (!files.length) this.fileRows.append(empty(this.fileFilter ? m('files.noMatches') : this.selection?.kind === 'working' && this.callbacks.context().working === null ? m('details.statusNotLoaded') : m('details.noChangedFiles')));
      this.renderFileWindow();
    } finally { span.end({ count: this.files.length, renderedCount: this.renderedNodes.size }); }
  }
  private fileRow(node: VisibleFileNode): HTMLElement {
    const tree = this.callbacks.context().settings.fileView === 'tree', file = node.file;
    let row: HTMLElement;
    if (file) {
      row = el('div', 'file-row'); row.dataset.path = file.path;
      setAttribute(row, 'title', m('files.stats', { path: `${file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}${file.path}`, additions: file.additions === null ? '?' : numberText(file.additions), deletions: file.deletions === null ? '?' : numberText(file.deletions) }));
      row.append(badge(file.status, `file-status status-${file.status[0]}`), el('span', 'file-name', node.name), el('span', 'file-stats', file.additions !== null ? `+${file.additions}` : '', file.deletions !== null ? ` −${file.deletions}` : ''));
      if (file.submodule) row.append(badge(m('files.submodule'), '', m('files.submoduleStatus', { commitChanged: m(file.submodule.commitChanged ? 'files.true' : 'files.false'), modified: m(file.submodule.modified ? 'files.true' : 'files.false'), untracked: m(file.submodule.untracked ? 'files.true' : 'files.false') })));
      if (this.canReview()) { const check = checkbox(m('files.markPathReviewed', { path: file.path }), false, checked => this.setReviewed(file.path, checked)); check.classList.add('review-check'); check.addEventListener('click', event => event.stopPropagation()); row.append(check); }
      row.addEventListener('click', () => { this.activeNode = node.key; void this.selectFile(file.path); this.fileList.focus({ preventScroll: true }); });
      row.addEventListener('dblclick', () => { if (!this.historyMode) void this.openWorkingFile(file); });
      row.addEventListener('contextmenu', event => { event.preventDefault(); this.activeNode = node.key; this.renderActiveNode(); contextMenu(this.fileMenu(file), { x: event.clientX, y: event.clientY }, this.fileList); });
      row.setAttribute('role', tree ? 'treeitem' : 'option');
    } else {
      row = el('div', `file-folder${node.expanded ? '' : ' collapsed'}`, icon('chevron'), icon('folder'), el('span', '', node.name)); row.dataset.folder = node.path;
      row.setAttribute('role', 'treeitem'); row.setAttribute('aria-expanded', String(node.expanded));
      row.addEventListener('click', () => { this.activeNode = node.key; this.toggleFolder(node.path); this.fileList.focus({ preventScroll: true }); });
    }
    row.id = this.nodeId(node.key); row.style.setProperty('--file-depth', String(node.level)); row.dataset.nodeKey = node.key;
    row.setAttribute('aria-posinset', String(node.position)); row.setAttribute('aria-setsize', String(node.siblings)); if (tree) row.setAttribute('aria-level', String(node.level + 1));
    if (this.virtualFiles) { row.style.position = 'absolute'; row.style.left = '0'; row.style.right = '0'; row.style.height = `${FILE_ROW_HEIGHT}px`; row.style.minHeight = `${FILE_ROW_HEIGHT}px`; row.style.boxSizing = 'border-box'; row.style.overflow = 'hidden'; }
    return row;
  }
  private renderFileWindow(): void {
    if (!this.preparedFiles) return;
    const range = this.virtualFiles ? fileWindow(this.visibleNodes.length, this.fileList.scrollTop, this.fileList.clientHeight || FILE_ROW_HEIGHT * 12) : { first: 0, last: this.visibleNodes.length };
    const keep = new Set<string>(), fragment = document.createDocumentFragment();
    for (let index = range.first; index < range.last; index++) {
      const node = this.visibleNodes[index]; keep.add(node.key);
      let row = this.renderedNodes.get(node.key);
      if (!row) { row = this.fileRow(node); this.renderedNodes.set(node.key, row); }
      fragment.append(row); if (this.virtualFiles) row.style.top = `${index * FILE_ROW_HEIGHT}px`;
    }
    for (const [key, row] of this.renderedNodes) if (!keep.has(key)) { row.remove(); this.renderedNodes.delete(key); }
    this.fileRows.append(fragment); this.updateFileRows();
  }
  private updateFileRows(): void {
    const reviewable = this.canReview(), key = reviewable ? this.reviewKey() : '', reviewed = reviewable ? this.store.reviewed(key, this.lastRepo) : new Set<string>(), active = reviewable && this.store.isReviewActive(key, this.lastRepo);
    for (const row of this.renderedNodes.values()) if (row.dataset.path !== undefined) {
      const path = row.dataset.path, selected = path === this.selectedFile, checked = reviewed.has(path);
      row.classList.toggle('selected', selected); row.classList.toggle('reviewed', checked); row.classList.toggle('unread', active && !checked); row.setAttribute('aria-selected', String(selected));
      const check = row.querySelector<HTMLInputElement>('input[type="checkbox"]'); if (check) check.checked = checked;
    }
    this.renderActiveNode();
  }
  private scheduleFiles(): void { if (this.virtualFiles && !this.fileFrame) this.fileFrame = requestAnimationFrame(() => { this.fileFrame = 0; this.renderFileWindow(); }); }
  private renderActiveNode(): void {
    for (const [key, row] of this.renderedNodes) row.classList.toggle('file-active', key === this.activeNode);
    const current = this.renderedNodes.get(this.activeNode);
    for (const row of this.renderedNodes.values()) row.setAttribute('aria-current', String(row.dataset.path !== undefined && row.dataset.path === this.selectedFile));
    if (current) this.fileList.setAttribute('aria-activedescendant', current.id); else this.fileList.removeAttribute('aria-activedescendant');
  }
  private revealActiveNode(): void {
    if (this.virtualFiles || this.historyMode) {
      const index = this.visibleNodes.findIndex(node => node.key === this.activeNode); if (index < 0) return;
      const top = index * FILE_ROW_HEIGHT, height = this.fileList.clientHeight || FILE_ROW_HEIGHT * 12;
      if (top < this.fileList.scrollTop) this.fileList.scrollTop = top;
      else if (top + FILE_ROW_HEIGHT > this.fileList.scrollTop + height) this.fileList.scrollTop = top + FILE_ROW_HEIGHT - height;
      this.renderFileWindow();
    } else if (this.historyMode) {
      this.renderActiveNode(); const row = this.renderedNodes.get(this.activeNode); if (!row) return;
      const bounds = row.getBoundingClientRect(), viewport = this.fileList.getBoundingClientRect();
      if (bounds.top < viewport.top) this.fileList.scrollTop += bounds.top - viewport.top;
      else if (bounds.bottom > viewport.bottom) this.fileList.scrollTop += bounds.bottom - viewport.bottom;
    } else { this.renderActiveNode(); this.renderedNodes.get(this.activeNode)?.scrollIntoView({ block: 'nearest' }); }
  }
  private toggleFolder(path: string, expanded?: boolean): void {
    const expand = expanded ?? this.collapsed.has(path); if (expand) this.collapsed.delete(path); else this.collapsed.add(path); this.collapseRevision++; this.renderFiles(); this.revealActiveNode(); this.callbacks.changed?.();
  }
  private fileMenu(file: ChangedFile): MenuItem[] {
    const query = this.queryFor(file), reviewable = this.canReview(), reviewed = reviewable && this.store.reviewed(this.reviewKey(), this.lastRepo).has(file.path);
    const items: MenuItem[] = [
      { label: m('files.viewDiff'), icon: 'eye', action: () => { void this.selectFile(file.path); } },
      { label: m('files.openWorking'), icon: 'editor', disabled: file.status.startsWith('D'), action: () => { void this.openWorkingFile(file); } },
      { label: m('files.openOld'), icon: 'file', disabled: !query || file.status.startsWith('A') || file.status.startsWith('?'), action: () => { if (query) void this.external(() => this.host.openSnapshot(query, 'old')); } },
      { label: m('files.openNew'), icon: 'file', disabled: !query || file.status.startsWith('D'), action: () => { if (query) void this.external(() => this.host.openSnapshot(query, 'new')); } },
      { label: m('files.externalDiff'), icon: 'external', disabled: !query, action: () => { if (query) void this.external(() => this.host.externalDiff(query)); } },
      { label: m('files.copyPath'), icon: 'copy', action: () => this.callbacks.copy(file.path) },
    ];
    if (reviewable) items.push({ label: reviewed ? m('files.markNotReviewed') : m('files.markReviewed'), icon: 'check', action: () => this.setReviewed(file.path, !reviewed) }); return items;
  }
  private queryFor(file: ChangedFile): DiffQuery | null {
    const context = this.callbacks.context(), repo = context.repo, selection = this.selection; if (!repo || !selection) return null;
    const query: DiffQuery = { repoId: repo.id, requestId: `tool-${Date.now().toString(36)}`, path: file.path, oldPath: file.oldPath ?? undefined, base: null, target: '', context: 3, encoding: context.settings.encoding };
    if (selection.kind === 'commit') { if (!this.detail) return null; query.base = this.detail.base; query.target = this.detail.commit.oid; }
    else if (selection.kind === 'compare') { query.base = selection.base; query.target = selection.target; }
    else if (this.workingMode === 'staged') { query.base = context.repo?.head ?? null; query.target = 'INDEX'; query.staged = true; }
    else { query.base = this.workingMode === 'unstaged' ? 'INDEX' : context.repo?.head ?? null; query.target = 'WORKTREE'; }
    return query;
  }
  private renderDiffHeader(): void {
    const file = this.fileAt(this.selectedFile); this.diffHeader.replaceChildren(); if (!file) return;
    const reviewed = this.canReview() && this.store.reviewed(this.reviewKey(), this.lastRepo).has(file.path);
    const more = button(m('files.actions'), () => menuAtButton(more, this.fileMenu(file)), 'more', '', true);
    this.diffHeader.append(el('span', 'file-path mono', file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path), ...(this.canReview() ? [checkbox(m('files.reviewed'), reviewed, checked => this.setReviewed(file.path, checked))] : []), el('span', 'spacer'), button(m('files.openWorking'), () => { void this.openWorkingFile(file); }, 'editor', '', true), more);
  }
  private selectFile(path: string, restore?: DiffViewState, performanceContext?: PerformanceContext): Promise<void> {
    const repo = this.callbacks.context().repo, file = this.fileAt(path); if (!repo || !this.selection || !file) return Promise.resolve();
    if (this.historyMode && this.selection.kind !== 'working') {
      this.selectedFile = path; this.activeNode = `file:${path}`; this.updateFileRows(); this.callbacks.changed?.();
      const selection = this.selection.kind === 'commit' ? { ...this.selection, parent: this.detail?.base ?? undefined } : { ...this.selection };
      return Promise.resolve(this.callbacks.openHistoryFile?.({ repo, selection, files: this.files, path, subject: this.detail?.commit.subject })).catch(error => this.callbacks.error(error));
    }
    const query = this.queryFor(file); if (!query) return Promise.resolve();
    const key = diffCacheKey(query), same = this.selectedFile === path && this.activeDiffKey === key;
    this.selectedFile = path; this.activeNode = `file:${path}`; this.updateFileRows(); this.renderDiffHeader();
    if (same && this.diffStatus === 'loading' && this.diffPending) return this.diffPending;
    if (same && this.diffStatus === 'ready' && this.displayedResult) {
      const operation = perf.operation('fileSelection', undefined, performanceContext); const span = operation.span('diff-ready', { cacheHit: true });
      if (restore) operation.run(() => this.diffView.restore(restore));
      if (cacheableDiff(query)) operation.run(() => this.setReviewed(path, true, true));
      span.end({ outcome: 'reused', cacheHit: true }); operation.end({ outcome: 'reused', cacheHit: true }); return Promise.resolve();
    }
    this.cancelContent(); this.diffView.clear(); this.displayedResult = null; this.loadedSides.clear(); this.sideContents = {}; this.activeDiffKey = key; this.diffStatus = 'loading';
    const pending = this.loadFile(path, query, key, restore, performanceContext); this.diffPending = pending;
    const finish = (): void => { if (this.diffPending === pending) this.diffPending = null; }; void pending.then(finish, finish); return pending;
  }
  private async loadFile(path: string, query: DiffQuery, key: string, restore?: DiffViewState, performanceContext?: PerformanceContext): Promise<void> {
    const operation = perf.operation('fileSelection', undefined, performanceContext); let outcome: PerformanceOutcome = 'ok';
    const request = this.requests.begin('diff'), epoch = this.epoch, repoId = query.repoId; query.requestId = request.id; operation.request(request.id);
    const cacheable = cacheableDiff(query), cached = cacheable ? this.diffCache.get(key) : undefined, cacheHit = Boolean(cached);
    const diffSpan = operation.span('diff-ready', { requestId: request.id, cacheHit });
    if (!cached) this.diffContainer.replaceChildren(loading(m('diff.loading'), () => {
      if (this.activeDiffKey !== key || this.epoch !== epoch) return;
      this.requests.cancel('diff'); this.diffStatus = 'cancelled'; this.diffContainer.replaceChildren(empty(m('diff.cancelled')), button(m('details.retry'), () => { void this.selectFile(path); }));
    }));
    try {
      const result = cached ?? await operation.run(() => this.host.diffPatch ? this.host.diffPatch(query) : this.host.diff(query));
      if (!this.current(request, epoch, repoId) || this.selectedFile !== path || this.activeDiffKey !== key) { outcome = 'stale'; return; }
      if (!cached && !this.host.diffPatch) this.legacyResults.add(result);
      if (!cached && cacheable) this.diffCache.set(key, result);
      this.displayedResult = result; this.diffStatus = 'ready';
      if (this.legacyResults.has(result)) for (const side of ['old', 'new'] as const) {
        this.loadedSides.add(side); this.sideContents[side] = { content: side === 'old' ? result.oldContent : result.newContent, binary: result.binary, truncated: result.truncated };
      }
      operation.run(() => {
        this.diffContainer.replaceChildren(this.diffView.element);
        this.diffView.set(result, this.callbacks.context().settings, true, { ensureContent: side => this.ensureContent(side, query, key, result, epoch), cancelContent: () => this.cancelContent() });
        if (restore) this.diffView.restore(restore);
      });
      if (cacheable) operation.run(() => this.setReviewed(path, true, true)); this.callbacks.changed?.();
    } catch (error) {
      outcome = this.current(request, epoch, repoId) ? 'error' : 'cancelled';
      if (this.current(request, epoch, repoId) && this.selectedFile === path && this.activeDiffKey === key) { this.diffStatus = 'error'; this.diffContainer.replaceChildren(el('div', 'inline-error', errorText(error), button(m('diff.retry'), () => { void this.selectFile(path); }, 'refresh'))); }
    } finally { request.finish(); diffSpan.end({ outcome, cacheHit }); operation.end({ outcome, cacheHit }); }
  }
  private cancelContent(): void { this.contentGeneration++; this.requests.cancel('content'); this.contentPending = null; }
  private ensureContent(side: ContentSide, query: DiffQuery, key: string, result: DiffResult, epoch: number): Promise<SideContent> {
    if (this.epoch !== epoch || this.activeDiffKey !== key || this.displayedResult !== result || this.callbacks.context().repo?.id !== query.repoId) return Promise.reject(Object.assign(new Error(), { code: 'CANCELLED' }));
    if (this.loadedSides.has(side)) return Promise.resolve(this.sideContents[side]!);
    if (this.contentPending?.side === side) return this.contentPending.promise;
    const cached = cacheableDiff(query) ? this.contentCache.get(`${key}:${side}`) : undefined;
    if (cached) { this.loadedSides.add(side); this.sideContents[side] = cached; return Promise.resolve(cached); }
    this.cancelContent(); const generation = this.contentGeneration;
    const pending = this.loadContent(side, query, key, result, epoch, generation); this.contentPending = { side, promise: pending };
    const finish = (): void => { if (this.contentPending?.promise === pending) this.contentPending = null; }; void pending.then(finish, finish); return pending;
  }
  private async loadContent(side: ContentSide, query: DiffQuery, key: string, patch: DiffResult, epoch: number, generation: number): Promise<SideContent> {
    const operation = perf.operation('fileContent'), request = this.requests.begin('content'); operation.request(request.id);
    const span = operation.span('content-ready', { requestId: request.id }); let outcome: PerformanceOutcome = 'ok';
    try {
      const contentQuery = { ...query, requestId: request.id };
      const result = await operation.run(() => this.host.fileContent ? this.host.fileContent(contentQuery, side) : this.host.diff(contentQuery));
      if (!this.current(request, epoch, query.repoId) || this.contentGeneration !== generation || this.activeDiffKey !== key || this.displayedResult !== patch) { outcome = 'stale'; throw Object.assign(new Error(), { code: 'CANCELLED' }); }
      const data = { content: side === 'old' ? result.oldContent : result.newContent, binary: result.binary, truncated: result.truncated };
      this.loadedSides.add(side); this.sideContents[side] = data;
      if (cacheableDiff(query)) this.contentCache.set(`${key}:${side}`, data);
      return data;
    } catch (error) { if (outcome !== 'stale') outcome = this.current(request, epoch, query.repoId) ? 'error' : 'cancelled'; throw error; }
    finally { request.finish(); span.end({ outcome }); operation.end({ outcome }); }
  }
  private fileKeydown(event: KeyboardEvent): void {
    if ((event.target as HTMLElement).closest('input,button,select,textarea,[contenteditable="true"],[role="separator"]')) return;
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', ' ', 'Enter'].includes(event.key)) event.stopPropagation();
    let index = Math.max(0, this.visibleNodes.findIndex(node => node.key === this.activeNode)); const current = this.visibleNodes[index]; if (!current) return;
    if (event.key === 'ArrowDown') index = Math.min(this.visibleNodes.length - 1, index + 1);
    else if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = this.visibleNodes.length - 1;
    else if (event.key === 'ArrowRight') { event.preventDefault(); if (!current.file && !current.expanded) this.toggleFolder(current.path, true); else if (!current.file) { index = Math.min(this.visibleNodes.length - 1, index + 1); this.activeNode = this.visibleNodes[index].key; this.revealActiveNode(); } return; }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (!current.file && current.expanded) this.toggleFolder(current.path, false); else if (current.parent) { this.activeNode = current.parent; this.revealActiveNode(); } return; }
    else if (event.key === ' ') { event.preventDefault(); if (current.file && this.canReview()) this.setReviewed(current.path, !this.store.reviewed(this.reviewKey(), this.lastRepo).has(current.path)); else if (!current.file) this.toggleFolder(current.path); return; }
    else if (event.key === 'Enter') { event.preventDefault(); if (current.file) void this.selectFile(current.path); else this.toggleFolder(current.path); return; }
    else if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); if (!current.file) return; const rect = document.getElementById(this.nodeId(current.key))?.getBoundingClientRect() ?? this.fileList.getBoundingClientRect(); contextMenu(this.fileMenu(current.file), { x: rect.left + 20, y: rect.bottom }, this.fileList); return; }
    else return;
    event.preventDefault(); const next = this.visibleNodes[index]; this.activeNode = next.key;
    if (next.file && !this.historyMode) void this.selectFile(next.path); this.revealActiveNode(); this.callbacks.changed?.();
  }
  private async openWorkingFile(file: ChangedFile): Promise<void> {
    const epoch = this.epoch, key = this.reviewKey(), repoId = this.lastRepo;
    const success = await this.external(() => this.host.openEditor(repoId, file.path));
    if (success && this.epoch === epoch && this.lastRepo === repoId && key === this.reviewKey()) this.setReviewed(file.path, true, true);
  }
  private async external(action: () => Promise<void>): Promise<boolean> {
    const repoId = this.lastRepo; if (!await this.callbacks.ensureTrust() || this.callbacks.context().repo?.id !== repoId) return false;
    try { await action(); return true; } catch (error) { this.callbacks.error(error); return false; }
  }
  destroy(): void { this.destroyed = true; this.requests.cancelAll(); this.contentGeneration++; this.epoch++; this.filesObserver.disconnect(); this.measureObserver.disconnect(); cancelAnimationFrame(this.fileFrame); cancelAnimationFrame(this.measureFrame); this.snapshots.clear(); this.diffView.destroy(); disposeBindings(this.element); }
}

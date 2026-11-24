import type { AppSettings, ChangedFile, DiffQuery, DiffResult, Host, Repository } from '../shared/protocol';
import { cacheableDiff, diffBytes, diffCacheKey, type ContentSide } from '../lib/diff';
import { errorText, isImmutableOid, LruCache, numberText, shortOid } from '../lib/format';
import { Requests, type StateStore } from '../lib/state';
import { performanceDiagnostics as perf } from '../lib/performance';
import { m } from '../i18n/commit-details';
import { m as history } from '../i18n/history';
import { button, checkbox, disposeBindings, el, empty, loading, menuAtButton, setAttribute, type MenuItem } from './dom';
import type { HistoryFileRequest } from './details';
import { DiffView, type DiffViewState, type LoadedContent } from './diff-view';
import './history-documents.css';

export type { HistoryFileRequest } from './details';
export interface HistoryDocumentCallbacks {
  context: () => { repo: Repository | null; settings: AppSettings };
  settings: (patch: Partial<AppSettings>) => void; error: (error: unknown) => void;
  copy: (text: string) => void; ensureTrust: () => Promise<boolean>; openUrl: (url: string) => void;
  activateGraph: () => void; changed?: () => void;
}
export interface HistoryDocumentsOptions { maxTabs?: number; maxPathStates?: number }
interface HistoryDocument {
  id: string; repo: Repository; selection: HistoryFileRequest['selection'];
  files: readonly ChangedFile[]; path: string; subject: string; used: number;
}
interface MountedFile {
  id: string; path: string; key: string; query: DiffQuery; epoch: number;
  status: 'loading' | 'ready' | 'cancelled' | 'error'; result?: DiffResult; pending?: Promise<void>;
}
const cancelled = (): Error => Object.assign(new Error('Cancelled'), { code: 'CANCELLED' });

/** One active renderer, bounded document descriptors, byte-bounded immutable data and per-tab/path view states.
 * App owns the graph surface and clears this controller before changing repositories. No content is persisted.
 */
export class HistoryDocuments {
  readonly tabs = el('nav', 'history-document-tabs');
  readonly surface = el('section', 'history-document-surface');
  private heading = el('header', 'history-document-heading');
  private identity = el('div', 'history-document-identity');
  private tools = el('div', 'history-document-tools');
  private body = el('div', 'history-document-body');
  private footer = el('footer', 'history-document-footer');
  private view: DiffView;
  private documents = new Map<string, HistoryDocument>();
  private states: LruCache<DiffViewState>;
  private patches = new LruCache<DiffResult>(24, 32 * 1024 * 1024, diffBytes);
  private contents = new LruCache<LoadedContent>(32, 24 * 1024 * 1024, side => 64 + (side.content?.length ?? 0) * 2);
  private legacyResults = new WeakSet<DiffResult>();
  private requests: Requests;
  private mounted: MountedFile | null = null;
  private loaded: Partial<Record<ContentSide, LoadedContent>> = {};
  private contentPending: { side: ContentSide; promise: Promise<LoadedContent> } | null = null;
  private contentGeneration = 0;
  private epoch = 0;
  private sequence = 0;
  private maxTabs: number;
  private active: string | null = null;
  private destroyed = false;

  constructor(private readonly host: Host, private readonly store: StateStore, private readonly callbacks: HistoryDocumentCallbacks, options: HistoryDocumentsOptions = {}) {
    this.requests = new Requests(id => host.cancel(id));
    this.maxTabs = Math.max(1, Math.min(24, Math.floor(options.maxTabs ?? 12)));
    this.states = new LruCache<DiffViewState>(Math.max(1, Math.min(256, Math.floor(options.maxPathStates ?? 96))), 2 * 1024 * 1024);
    this.view = new DiffView(value => callbacks.settings({ diffView: value }), value => callbacks.copy(value));
    this.heading.append(this.identity, this.tools); this.body.append(this.view.element);
    this.surface.append(this.heading, this.body, this.footer); this.surface.hidden = true; this.surface.tabIndex = -1;
    this.tabs.setAttribute('role', 'tablist'); setAttribute(this.tabs, 'aria-label', m('documents.tabs'));
    this.surface.setAttribute('role', 'tabpanel'); this.surface.id = `history-document-${Math.random().toString(36).slice(2)}`;
    this.view.element.addEventListener('scroll', () => { if (this.mounted?.status === 'ready') { this.savePathState(); callbacks.changed?.(); } }, true);
    this.tabs.addEventListener('keydown', event => this.tabsKeydown(event));
    this.renderTabs();
  }
  get activeId(): string | null { return this.active; }
  get size(): number { return this.documents.size; }
  get pathStateCount(): number { return this.states.size; }
  get currentPath(): string | null { return this.active ? this.documents.get(this.active)?.path ?? null : null; }
  private comparisonId(repoId: string, selection: HistoryFileRequest['selection']): string {
    return JSON.stringify(selection.kind === 'commit' ? [repoId, 'commit', selection.oid, selection.parent ?? null] : [repoId, 'compare', selection.base, selection.target]);
  }
  private documentId(request: HistoryFileRequest): string { return JSON.stringify([this.comparisonId(request.repo.id, request.selection), request.path]); }
  private stateKey(id: string, path: string): string { return JSON.stringify([id, path]); }
  private savePathState(): void { if (this.mounted?.status === 'ready') this.states.set(this.stateKey(this.mounted.id, this.mounted.path), this.view.getState()); }

  open(request: HistoryFileRequest): Promise<void> {
    if (this.destroyed || this.callbacks.context().repo?.id !== request.repo.id || !request.files.some(file => file.path === request.path)) return Promise.resolve();
    // Defensive repo boundary as well as the app's explicit clear-on-switch contract.
    if ([...this.documents.values()].some(document => document.repo.id !== request.repo.id)) this.clear();
    const id = this.documentId(request); let document = this.documents.get(id);
    if (!document) {
      document = { id, repo: { ...request.repo }, selection: structuredClone(request.selection), files: request.files, path: request.path, subject: request.subject ?? '', used: ++this.sequence };
      this.documents.set(id, document);
    } else {
      if (document.path !== request.path) this.savePathState();
      document.repo = { ...request.repo }; document.files = request.files; document.path = request.path; document.subject = request.subject ?? document.subject;
    }
    document.used = ++this.sequence;
    while (this.documents.size > this.maxTabs) {
      const oldest = [...this.documents.values()].filter(item => item.id !== id).sort((left, right) => left.used - right.used)[0];
      if (!oldest) break; this.documents.delete(oldest.id);
    }
    return this.activate(id);
  }
  activate(id: string): Promise<void> {
    const document = this.documents.get(id);
    if (this.destroyed || !document || this.callbacks.context().repo?.id !== document.repo.id) return Promise.resolve();
    const same = this.active === id && this.mounted?.path === document.path && this.mounted.key === diffCacheKey(this.query(document));
    if (!same) this.savePathState();
    this.active = id; document.used = ++this.sequence; this.surface.hidden = false;
    this.renderTabs(); this.renderHeading(document); this.callbacks.changed?.();
    if (same && this.mounted?.status === 'loading') return this.mounted.pending ?? Promise.resolve();
    if (same && this.mounted?.status === 'ready') { this.markReviewed(document, document.path, true, true); return Promise.resolve(); }
    return this.load(document);
  }
  activateGraph(): void {
    this.savePathState(); this.cancelMounted(); this.active = null; this.surface.hidden = true; this.renderTabs();
    this.callbacks.activateGraph(); this.callbacks.changed?.();
  }
  close(id: string): void {
    if (!this.documents.has(id)) return;
    const wasActive = this.active === id; if (wasActive) this.savePathState();
    this.documents.delete(id);
    if (!wasActive) { this.renderTabs(); this.callbacks.changed?.(); return; }
    const next = [...this.documents.values()].sort((left, right) => right.used - left.used)[0];
    if (next) void this.activate(next.id); else this.activateGraph();
  }
  /** Drop open documents, path states and cached repository content on repo switch. */
  clear(): void {
    this.cancelMounted(); this.active = null; this.documents.clear(); this.states.clear(); this.patches.clear(); this.contents.clear(); this.legacyResults = new WeakSet();
    this.surface.hidden = true; this.identity.replaceChildren(); this.footer.replaceChildren(); this.renderTabs(); this.callbacks.changed?.();
  }
  private cancelMounted(): void {
    this.epoch++; this.requests.cancelAll(); this.contentGeneration++; this.contentPending = null; this.loaded = {};
    this.view.setNavigation(null); this.view.clear(); this.mounted = null;
  }
  private query(document: HistoryDocument): DiffQuery {
    const file = document.files.find(item => item.path === document.path), settings = this.callbacks.context().settings;
    return { repoId: document.repo.id, requestId: '', path: document.path, oldPath: file?.oldPath ?? undefined, base: document.selection.kind === 'commit' ? document.selection.parent ?? null : document.selection.base, target: document.selection.kind === 'commit' ? document.selection.oid : document.selection.target, context: 3, encoding: settings.encoding };
  }
  private isCurrent(mounted: MountedFile): boolean {
    return !this.destroyed && this.mounted === mounted && this.epoch === mounted.epoch && this.active === mounted.id && this.callbacks.context().repo?.id === mounted.query.repoId;
  }
  private load(document: HistoryDocument, edge?: 'first' | 'last', force = false): Promise<void> {
    this.cancelMounted(); const query = this.query(document), key = diffCacheKey(query);
    const mounted: MountedFile = { id: document.id, path: document.path, key, query, epoch: this.epoch, status: 'loading' }; this.mounted = mounted;
    this.body.replaceChildren(loading(m('documents.loading'), () => this.cancelLoad(mounted)));
    const pending = this.loadPatch(document, mounted, edge, force); mounted.pending = pending;
    void pending.finally(() => { if (mounted.pending === pending) mounted.pending = undefined; }); return pending;
  }
  private async loadPatch(document: HistoryDocument, mounted: MountedFile, edge?: 'first' | 'last', force = false): Promise<void> {
    const operation = perf.operation('fileSelection'), request = this.requests.begin('patch'); operation.request(request.id);
    const query = { ...mounted.query, requestId: request.id }, cacheable = cacheableDiff(query), cached = !force && cacheable ? this.patches.get(mounted.key) : undefined;
    let outcome: 'ok' | 'error' | 'stale' | 'cancelled' = 'ok';
    try {
      const result = cached ?? await operation.run(() => this.host.diffPatch ? this.host.diffPatch(query) : this.host.diff(query));
      if (!request.current() || !this.isCurrent(mounted)) { outcome = 'stale'; return; }
      if (!cached && !this.host.diffPatch) this.legacyResults.add(result);
      if (!cached && cacheable) this.patches.set(mounted.key, result);
      mounted.result = result;
      if (this.legacyResults.has(result)) for (const side of ['old', 'new'] as const) this.loaded[side] = { content: side === 'old' ? result.oldContent : result.newContent, binary: result.binary, truncated: result.truncated };
      const saved = this.states.get(this.stateKey(document.id, mounted.path));
      this.configureNavigation(document); this.body.replaceChildren(this.view.element);
      this.view.set(result, this.callbacks.context().settings, true, { ensureContent: side => this.ensureContent(side, mounted), cancelContent: () => this.cancelContent() });
      if (saved) this.view.restore(saved);
      mounted.status = 'ready';
      if (edge) this.view.navigateChange(edge === 'last' ? -1 : 1, edge);
      this.markReviewed(document, mounted.path, true, true); this.renderHeading(document); this.callbacks.changed?.();
    } catch (error) {
      outcome = request.current() && this.isCurrent(mounted) ? 'error' : 'cancelled';
      if (request.current() && this.isCurrent(mounted)) {
        mounted.status = 'error'; this.body.replaceChildren(el('div', 'inline-error', errorText(error), button(history('diff.retry'), () => { void this.load(document, edge, true); }, 'refresh')));
        this.callbacks.error(error);
      }
    } finally { request.finish(); operation.end({ outcome, cacheHit: Boolean(cached) }); }
  }
  private cancelLoad(mounted: MountedFile): void {
    if (!this.isCurrent(mounted)) return;
    this.requests.cancel('patch'); this.cancelContent(); mounted.status = 'cancelled';
    this.body.replaceChildren(empty(m('documents.cancelled')), button(history('diff.retry'), () => { const document = this.documents.get(mounted.id); if (document) void this.load(document); }, 'refresh'));
  }
  private cancelContent(): void { this.contentGeneration++; this.requests.cancel('content'); this.contentPending = null; }
  private ensureContent(side: ContentSide, mounted: MountedFile): Promise<LoadedContent> {
    if (!this.isCurrent(mounted) || mounted.status !== 'ready') return Promise.reject(cancelled());
    if (this.loaded[side]) return Promise.resolve(this.loaded[side]!);
    if (this.contentPending?.side === side) return this.contentPending.promise;
    const cached = cacheableDiff(mounted.query) ? this.contents.get(`${mounted.key}:${side}`) : undefined;
    if (cached) { this.loaded[side] = cached; return Promise.resolve(cached); }
    this.cancelContent(); const generation = this.contentGeneration;
    const promise = this.loadContent(side, mounted, generation); this.contentPending = { side, promise };
    const finish = (): void => { if (this.contentPending?.promise === promise) this.contentPending = null; }; void promise.then(finish, finish); return promise;
  }
  private async loadContent(side: ContentSide, mounted: MountedFile, generation: number): Promise<LoadedContent> {
    const operation = perf.operation('fileContent'), request = this.requests.begin('content'); operation.request(request.id);
    try {
      const query = { ...mounted.query, requestId: request.id };
      const result = await operation.run(() => this.host.fileContent ? this.host.fileContent(query, side) : this.host.diff(query));
      if (!request.current() || !this.isCurrent(mounted) || generation !== this.contentGeneration) throw cancelled();
      const data = { content: side === 'old' ? result.oldContent : result.newContent, binary: result.binary, truncated: result.truncated };
      this.loaded[side] = data; if (cacheableDiff(query)) this.contents.set(`${mounted.key}:${side}`, data); return data;
    } finally { request.finish(); operation.end(); }
  }
  private configureNavigation(document: HistoryDocument): void {
    const index = document.files.findIndex(file => file.path === document.path), previous = index > 0, next = index >= 0 && index < document.files.length - 1;
    this.view.setNavigation({
      keyboardRoot: this.surface, fileIndex: index, fileCount: document.files.length,
      ...(previous ? { previousFile: () => { void this.moveFile(-1, 'first'); }, previousChangeBoundary: () => { void this.moveFile(-1, 'last'); } } : {}),
      ...(next ? { nextFile: () => { void this.moveFile(1, 'first'); }, nextChangeBoundary: () => { void this.moveFile(1, 'first'); } } : {}),
      onChange: () => { this.savePathState(); this.callbacks.changed?.(); },
    });
    if (this.view.toolbar.parentElement !== this.tools) this.tools.append(this.view.toolbar);
  }
  private moveFile(direction: -1 | 1, edge: 'first' | 'last'): Promise<void> {
    const document = this.active ? this.documents.get(this.active) : undefined; if (!document || this.mounted?.status !== 'ready') return Promise.resolve();
    const index = document.files.findIndex(file => file.path === document.path), file = document.files[index + direction]; if (!file) return Promise.resolve();
    this.savePathState(); document.path = file.path; this.renderHeading(document); this.renderTabs(); this.callbacks.changed?.();
    return this.load(document, edge);
  }
  private reviewKey(document: HistoryDocument): string {
    return document.selection.kind === 'commit' ? `commit:${document.selection.oid}:${document.selection.parent ?? 'ROOT'}` : `compare:${document.selection.base}:${document.selection.target}`;
  }
  private reviewable(document: HistoryDocument): boolean { const query = this.query(document); return isImmutableOid(query.target) && (query.base === null || isImmutableOid(query.base)); }
  private markReviewed(document: HistoryDocument, path: string, checked: boolean, automatic = false): void {
    if (!this.reviewable(document)) return;
    const key = this.reviewKey(document), repoId = document.repo.id;
    if (automatic && (!this.store.isReviewActive(key, repoId) || this.store.reviewed(key, repoId).has(path))) return;
    this.store.touchReview(key, repoId); this.store.review(key, repoId, path, checked);
    if (this.active === document.id) this.renderHeading(document); this.callbacks.changed?.();
  }
  private renderHeading(document: HistoryDocument): void {
    disposeBindings(this.identity); disposeBindings(this.footer);
    const file = document.files.find(item => item.path === document.path), target = document.selection.kind === 'commit' ? shortOid(document.selection.oid) : `${shortOid(document.selection.base)} → ${shortOid(document.selection.target)}`;
    const path = file?.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : document.path;
    const title = el('strong', 'history-document-path mono', path); title.title = path;
    this.identity.replaceChildren(title, el('span', 'history-document-context muted', m('documents.context', { repo: document.repo.name, commit: target, subject: document.subject })));
    const index = document.files.findIndex(item => item.path === document.path);
    const actions = button(history('files.actions'), () => menuAtButton(actions, this.fileMenu(document)), 'more', '', true); actions.disabled = !file;
    this.footer.replaceChildren(el('span', 'muted', m('documents.fileCount', { index: numberText(index + 1), count: numberText(document.files.length) })), el('span', 'muted', m('documents.immutable')), el('span', 'spacer'));
    if (this.reviewable(document)) this.footer.append(checkbox(m('documents.reviewed'), this.store.reviewed(this.reviewKey(document), document.repo.id).has(document.path), checked => this.markReviewed(document, document.path, checked)));
    this.footer.append(actions, button(m('documents.openGraph'), () => this.activateGraph(), 'commit', '', true));
  }
  private fileMenu(document: HistoryDocument): MenuItem[] {
    const file = document.files.find(item => item.path === document.path); if (!file) return [];
    const query = this.query(document);
    return [
      { label: history('files.openWorking'), icon: 'editor', disabled: file.status.startsWith('D'), action: () => { void this.external(document, () => this.host.openEditor(document.repo.id, file.path)); } },
      { label: history('files.openOld'), icon: 'file', disabled: file.status.startsWith('A') || query.base === null, action: () => { void this.external(document, () => this.host.openSnapshot({ ...query, requestId: `history-tool-${Date.now().toString(36)}` }, 'old')); } },
      { label: history('files.openNew'), icon: 'file', disabled: file.status.startsWith('D'), action: () => { void this.external(document, () => this.host.openSnapshot({ ...query, requestId: `history-tool-${Date.now().toString(36)}` }, 'new')); } },
      { label: history('files.externalDiff'), icon: 'external', action: () => { void this.external(document, () => this.host.externalDiff({ ...query, requestId: `history-tool-${Date.now().toString(36)}` })); } },
      { label: history('files.copyPath'), icon: 'copy', action: () => this.callbacks.copy(file.path) },
    ];
  }
  private async external(document: HistoryDocument, action: () => Promise<void>): Promise<void> {
    if (!await this.callbacks.ensureTrust() || this.callbacks.context().repo?.id !== document.repo.id || this.destroyed) return;
    try { await action(); } catch (error) { this.callbacks.error(error); }
  }
  updateSettings(): void {
    if (this.destroyed || !this.active) return;
    const document = this.documents.get(this.active); if (!document) return;
    const mounted = this.mounted;
    if (!mounted || mounted.key !== diffCacheKey(this.query(document))) { this.savePathState(); void this.load(document); return; }
    if (mounted.status === 'ready' && mounted.result) { this.view.set(mounted.result, this.callbacks.context().settings, false); this.renderHeading(document); }
  }
  /** Presentation-only: never reload a patch/content or mutate a view state. */
  updateLocale(): void { this.view.updateLocale(); }
  invalidate(): void {
    this.patches.clear(); this.contents.clear(); this.legacyResults = new WeakSet(); this.view.clearCache();
    const document = this.active ? this.documents.get(this.active) : undefined;
    if (document) { this.savePathState(); void this.load(document, undefined, true); }
  }
  destroy(): void {
    if (this.destroyed) return;
    this.savePathState(); this.cancelMounted(); this.destroyed = true; this.documents.clear(); this.states.clear(); this.patches.clear(); this.contents.clear();
    this.view.destroy(); disposeBindings(this.tabs); disposeBindings(this.surface); this.tabs.replaceChildren(); this.surface.replaceChildren();
  }
  private tabsKeydown(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const target = event.target as HTMLElement, ids = [null, ...this.documents.keys()];
    const current = target.closest<HTMLElement>('[data-document-id]'), at = current?.dataset.documentId === 'graph' ? 0 : ids.indexOf(current?.dataset.documentId ?? this.active);
    let next = Math.max(0, at);
    if (event.key === 'ArrowRight') next = Math.min(ids.length - 1, next + 1);
    else if (event.key === 'ArrowLeft') next = Math.max(0, next - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = ids.length - 1;
    else if (event.key === 'Delete' && this.active) { event.preventDefault(); this.close(this.active); return; }
    else return;
    event.preventDefault(); event.stopPropagation();
    const id = ids[next]; if (id) void this.activate(id); else this.activateGraph();
    const control = [...this.tabs.querySelectorAll<HTMLElement>('[data-document-id]')].find(item => item.dataset.documentId === (id ?? 'graph')); control?.focus({ preventScroll: true });
  }
  private renderTabs(): void {
    disposeBindings(this.tabs);
    const graph = button(m('documents.graph'), () => this.activateGraph(), 'commit', 'history-document-tab'); graph.dataset.documentId = 'graph'; graph.setAttribute('role', 'tab'); graph.setAttribute('aria-selected', String(this.active === null)); graph.tabIndex = this.active === null ? 0 : -1;
    this.tabs.replaceChildren(graph);
    for (const document of this.documents.values()) {
      const target = document.selection.kind === 'commit' ? document.selection.oid : document.selection.target;
      const tab = button(m('documents.file', { path: document.path, commit: shortOid(target) }), () => { void this.activate(document.id); }, 'file', 'history-document-tab');
      tab.title = `${document.repo.name}\n${document.path}\n${document.selection.kind === 'commit' ? `${document.selection.parent ?? 'ROOT'} → ${document.selection.oid}` : `${document.selection.base} → ${document.selection.target}`}`;
      tab.dataset.documentId = document.id; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(this.active === document.id)); tab.setAttribute('aria-controls', this.surface.id); tab.tabIndex = this.active === document.id ? 0 : -1;
      tab.id = `${this.surface.id}-tab-${[...this.documents.keys()].indexOf(document.id)}`;
      if (this.active === document.id) this.surface.setAttribute('aria-labelledby', tab.id);
      const close = button(m('documents.close', { path: document.path }), () => this.close(document.id), 'close', 'history-document-close', true); close.dataset.closeDocumentId = document.id; close.tabIndex = -1;
      this.tabs.append(el('div', 'history-document-tab-group', tab, close));
    }
  }
}

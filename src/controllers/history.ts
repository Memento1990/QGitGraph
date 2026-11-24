import { shallowReactive } from 'vue';
import type { AppError, AppSettings, ChangedFile, Commit, CommitDetail, Host, Repository, ReviewTarget } from '../shared/protocol';
import { cacheableDiff, detailBytes, immutableSelection } from '../lib/diff';
import { isImmutableOid, LruCache } from '../lib/format';
import { Requests, type StateStore } from '../lib/state';
import {
  controllerError, controllerErrorStatus, createDiffController,
  type DiffControllerHooks, type DiffOpen, type DiffStatus, type RepositoryGeneration,
} from './diff';

export type HistorySelection = { kind: 'commit'; oid: string; parent?: string } | { kind: 'compare'; base: string | null; target: string };
export interface HistoryDocument {
  readonly id: string; readonly repositoryId: string; readonly generation: RepositoryGeneration;
  readonly selection: HistorySelection; readonly file: ChangedFile; readonly files: readonly ChangedFile[];
  readonly detail: CommitDetail | null; readonly subject: string; readonly pinned: boolean; readonly used: number;
}
export interface HistoryReview { key: string | null; active: boolean; available: boolean; reviewed: ReadonlySet<string> }
export interface HistoryControllerState {
  repository: Repository | null; generation: RepositoryGeneration;
  selection: HistorySelection | null; selected: string | null; status: DiffStatus;
  detail: CommitDetail | null; files: readonly ChangedFile[]; selectedPath: string | null; error: AppError | null;
  documents: readonly HistoryDocument[]; activeDocument: string | null; review: HistoryReview;
  fullMessage: boolean; fileFilter: string; filesScrollTop: number; filesScrollLeft: number; metadataScrollTop: number;
}
export interface HistoryControllerHooks {
  store?: StateStore; stateStore?: StateStore;
  settings?: () => Pick<AppSettings, 'encoding' | 'diffView' | 'mailmap'>;
  onError?: (error: AppError) => void; onResultError?: (error: AppError) => void;
  onSelect?: (selection: Readonly<HistorySelection>) => void;
  onOpenFile?: (document: Readonly<HistoryDocument>) => void;
  diff?: Omit<DiffControllerHooks, 'onLoaded' | 'onNavigateFile'>;
  maxDocuments?: number; maxDetails?: number; detailByteLimit?: number;
}
export interface WorkingDiffOpen {
  file: ChangedFile; group: string; base: string | null; target: string; staged?: boolean;
}
export interface HistorySelect { oid: string; base?: string | null; parent?: string }
interface InspectorReading { fullMessage: boolean; fileFilter: string; filesScrollTop: number; filesScrollLeft: number; metadataScrollTop: number; selectedPath: string | null }
const emptyReview = (): HistoryReview => ({ key: null, active: false, available: false, reviewed: new Set() });
const selectionKey = (selection: HistorySelection): string => JSON.stringify(selection);
const immutableCommit = (selection: HistorySelection): boolean => selection.kind === 'commit' && immutableSelection(selection);
const fileBytes = (files: readonly ChangedFile[]): number => files.reduce((size, file) => size + 160 + (file.path.length + (file.oldPath?.length ?? 0)) * 2, 128);
function freezeFiles(files: readonly ChangedFile[]): readonly ChangedFile[] { return Object.freeze(files.map(file => Object.freeze({ ...file, ...(file.submodule ? { submodule: Object.freeze({ ...file.submodule }) } : {}) }))); }
function freezeDetail(detail: CommitDetail): CommitDetail {
  return Object.freeze({ ...detail, signature: Object.freeze({ ...detail.signature }),
    commit: Object.freeze({ ...detail.commit, parents: Object.freeze([...detail.commit.parents]) as unknown as string[], refs: Object.freeze(detail.commit.refs.map(ref => Object.freeze({ ...ref }))) as unknown as Commit['refs'] }),
    files: freezeFiles(detail.files) as ChangedFile[],
  });
}

/** Metadata/file documents only. The workspace remains the sole history query/pagination owner. */
export function createHistoryController(host: Host, hooks: HistoryControllerHooks = {}) {
  const state = shallowReactive<HistoryControllerState>({
    repository: null, generation: 0, selection: null, selected: null, status: 'idle', detail: null, files: [], selectedPath: null, error: null,
    documents: [], activeDocument: null, review: emptyReview(), fullMessage: false, fileFilter: '', filesScrollTop: 0, filesScrollLeft: 0, metadataScrollTop: 0,
  });
  const store = hooks.store ?? hooks.stateStore;
  const requests = new Requests(id => typeof host.cancel === 'function' ? host.cancel(id) : Promise.resolve());
  const maxDocuments = Math.max(1, Math.min(24, Math.floor(Number.isFinite(hooks.maxDocuments) ? hooks.maxDocuments! : 12)));
  const detailLimit = Math.max(1, Math.min(96, Math.floor(Number.isFinite(hooks.maxDetails) ? hooks.maxDetails! : 24)));
  const detailByteLimit = Math.max(1024, Math.min(64 * 1024 * 1024, Number.isFinite(hooks.detailByteLimit) ? hooks.detailByteLimit! : 12 * 1024 * 1024));
  const details = new LruCache<CommitDetail>(detailLimit, detailByteLimit, detailBytes);
  const comparisons = new LruCache<readonly ChangedFile[]>(16, 8 * 1024 * 1024, fileBytes);
  const inspectorReadings = new LruCache<InspectorReading>(96, 2 * 1024 * 1024);
  let epoch = 0, disposed = false, used = 0, pending: Promise<void> | null = null;
  function report(error: AppError): void { (hooks.onResultError ?? hooks.onError)?.(error); }
  function reviewTarget(selection: HistorySelection | null): ReviewTarget | null {
    if (!selection) return null;
    if (selection.kind === 'commit') return immutableSelection(selection) ? { ...selection } : null;
    return selection.base !== null && isImmutableOid(selection.base) && isImmutableOid(selection.target) ? { kind: 'compare', base: selection.base, target: selection.target } : null;
  }
  function reviewKey(selection: HistorySelection | null): string | null {
    if (!selection) return null;
    return selection.kind === 'commit' ? `commit:${selection.oid}:${selection.parent ?? 'ROOT'}` : `compare:${selection.base ?? 'ROOT'}:${selection.target}`;
  }
  function syncReview(): void {
    const repository = state.repository, key = reviewKey(state.selection);
    state.review = { key, available: Boolean(store && state.status === 'ready' && repository && reviewTarget(state.selection)),
      active: Boolean(store && repository && key && store.isReviewActive(key, repository.id)),
      reviewed: store && repository && key ? store.reviewed(key, repository.id) : new Set(),
    };
  }
  function markLoaded(selection: Readonly<DiffOpen>): void {
    const repository = state.repository, document = state.documents.find(item => item.id === state.activeDocument);
    if (!store || !repository || !document || document.file.path !== selection.path || document.repositoryId !== repository.id || document.generation !== state.generation || !selection.historical) return;
    const expected = document.selection, target = expected.kind === 'commit' ? expected.oid : expected.target;
    const base = expected.kind === 'commit' ? expected.parent ?? null : expected.base;
    if (selection.target !== target || selection.base !== base) return;
    const key = reviewKey(expected);
    if (!key || !reviewTarget(expected) || !store.isReviewActive(key, repository.id)) return;
    store.touchReview(key, repository.id);
    if (!store.reviewed(key, repository.id).has(selection.path)) store.review(key, repository.id, selection.path, true);
    syncReview();
  }
  const diff = createDiffController(host, { ...hooks.diff,
    mode: hooks.settings?.().diffView ?? hooks.diff?.mode,
    onResultError: report, onLoaded: markLoaded, onNavigateFile: (direction, edge) => moveFile(direction, edge),
  });
  function remember(): void {
    if (!state.repository || !state.selection || state.status !== 'ready') return;
    inspectorReadings.set(JSON.stringify([state.repository.id, selectionKey(state.selection)]), { fullMessage: state.fullMessage, fileFilter: state.fileFilter,
      filesScrollTop: state.filesScrollTop, filesScrollLeft: state.filesScrollLeft, metadataScrollTop: state.metadataScrollTop, selectedPath: state.selectedPath });
  }
  function resetReading(selection: HistorySelection): void {
    const saved = inspectorReadings.get(JSON.stringify([state.repository?.id, selectionKey(selection)]));
    state.fullMessage = saved?.fullMessage ?? false; state.fileFilter = saved?.fileFilter ?? '';
    state.filesScrollTop = saved?.filesScrollTop ?? 0; state.filesScrollLeft = saved?.filesScrollLeft ?? 0; state.metadataScrollTop = saved?.metadataScrollTop ?? 0;
    state.selectedPath = saved?.selectedPath ?? null;
  }
  function isCurrent(request: { current(): boolean }, version: number, repoId: string, generation: RepositoryGeneration, selection: HistorySelection): boolean {
    return !disposed && request.current() && epoch === version && state.repository?.id === repoId && state.generation === generation && state.selection !== null && selectionKey(state.selection) === selectionKey(selection);
  }
  function setRepository(repository: Repository | null, generation: RepositoryGeneration): void {
    if (disposed) return;
    if (state.repository?.id === repository?.id && state.generation === generation) { state.repository = repository; diff.setRepository(repository, generation); return; }
    remember(); epoch++; requests.cancelAll(); pending = null; details.clear(); comparisons.clear();
    state.repository = repository; state.generation = generation; state.selection = null; state.selected = null; state.status = 'idle'; state.detail = null;
    state.files = []; state.selectedPath = null; state.documents = []; state.activeDocument = null; state.error = null; state.review = emptyReview();
    diff.setRepository(repository, generation);
  }
  async function load(selection: HistorySelection, force = false): Promise<void> {
    const repository = state.repository;
    if (!repository || disposed) {
      if (!disposed) { state.status = 'blocked'; state.error = { code: 'NO_REPOSITORY', message: 'Select a repository before inspecting a commit.' }; report(state.error); }
      return;
    }
    remember(); epoch++; requests.cancelAll(); diff.clear(); state.activeDocument = null;
    state.selection = Object.freeze({ ...selection }); state.selected = selection.kind === 'commit' ? selection.oid : selection.target;
    state.detail = null; state.files = []; state.error = null; state.status = 'loading'; resetReading(selection); syncReview();
    const version = epoch, generation = state.generation, request = requests.begin('detail');
    const settings = hooks.settings?.(), key = JSON.stringify([repository.id, selection, Boolean(settings?.mailmap)]);
    try {
      if (selection.kind === 'commit') {
        if (!host.commitDetail) throw { code: 'CAPABILITY_MISSING', message: 'This Host does not provide commit metadata.' };
        const cached = !force && immutableCommit(selection) ? details.get(key) : undefined;
        const value = cached ?? await host.commitDetail(repository.id, selection.oid, request.id, selection.parent);
        if (!isCurrent(request, version, repository.id, generation, selection)) return;
        if (!value?.commit || !Array.isArray(value.files) || typeof value.body !== 'string' || (isImmutableOid(selection.oid) && value.commit.oid.toLowerCase() !== selection.oid.toLowerCase())) throw { code: 'INVALID_COMMIT_DETAIL', message: 'The Host returned metadata for another commit.' };
        const expectedBase = selection.parent ?? value.commit.parents[0] ?? null;
        if (value.base !== expectedBase || (selection.parent && !value.commit.parents.includes(selection.parent))) throw { code: 'INVALID_COMMIT_PARENT', message: 'The Host returned files for another parent comparison.' };
        const detail = cached ?? freezeDetail(value);
        state.detail = detail; state.files = detail.files;
        // Freeze resolved identities: mutable revision names never become cache keys or review targets accidentally.
        const resolved = { kind: 'commit' as const, oid: detail.commit.oid, ...(detail.base ? { parent: detail.base } : {}) };
        state.selection = Object.freeze(resolved); state.selected = detail.commit.oid; resetReading(resolved);
        if (!cached && immutableCommit(selection)) details.set(key, detail);
      } else {
        if (!host.compare) throw { code: 'CAPABILITY_MISSING', message: 'This Host does not provide comparison file lists.' };
        const cacheable = cacheableDiff(selection), cached = !force && cacheable ? comparisons.get(key) : undefined;
        const files = cached ?? await host.compare({ repoId: repository.id, requestId: request.id, base: selection.base, target: selection.target });
        if (!isCurrent(request, version, repository.id, generation, selection)) return;
        if (!Array.isArray(files)) throw { code: 'INVALID_COMPARISON', message: 'The Host returned an invalid changed-file list.' };
        state.files = cached ?? freezeFiles(files); if (!cached && cacheable) comparisons.set(key, state.files);
      }
      state.status = 'ready'; if (state.selectedPath && !state.files.some(file => file.path === state.selectedPath)) state.selectedPath = null;
      syncReview(); hooks.onSelect?.(state.selection!);
    } catch (error) {
      if (!isCurrent(request, version, repository.id, generation, selection)) return;
      state.error = controllerError(error); state.status = controllerErrorStatus(state.error); state.detail = null; state.files = []; syncReview(); report(state.error);
    } finally { request.finish(); }
  }
  function runLoad(selection: HistorySelection, force = false): Promise<void> {
    const promise = load(selection, force); pending = promise;
    void promise.finally(() => { if (pending === promise) pending = null; }); return promise;
  }
  function select(commit: Commit | string | HistorySelect, base?: string | null): Promise<void> {
    const oid = typeof commit === 'string' ? commit : commit.oid;
    const parent = base ?? (typeof commit === 'object' && 'parent' in commit ? commit.parent : undefined) ?? (typeof commit === 'object' && 'base' in commit ? commit.base : undefined);
    const selection: HistorySelection = { kind: 'commit', oid, ...(parent ? { parent } : {}) };
    if (!oid) { state.status = 'error'; state.error = { code: 'INVALID_COMMIT', message: 'A commit object name is required.' }; report(state.error); return Promise.resolve(); }
    const current = state.selection;
    const same = current?.kind === 'commit' && current.oid === oid && (parent === undefined || current.parent === parent);
    if (same && state.status === 'loading' && pending) return pending;
    if (same && state.status === 'ready' && isImmutableOid(oid)) { activateGraph(); return Promise.resolve(); }
    return runLoad(selection);
  }
  function compare(base: string | null, target: string | Commit): Promise<void> { return runLoad({ kind: 'compare', base, target: typeof target === 'string' ? target : target.oid }); }
  function selectParent(parent: string): Promise<void> {
    if (state.selection?.kind !== 'commit' || !state.detail?.commit.parents.includes(parent)) return Promise.resolve();
    return runLoad({ kind: 'commit', oid: state.selection.oid, parent });
  }
  function documentQuery(document: HistoryDocument): DiffOpen {
    return { target: document.selection.kind === 'commit' ? document.selection.oid : document.selection.target,
      base: document.selection.kind === 'commit' ? document.selection.parent ?? null : document.selection.base,
      path: document.file.path, oldPath: document.file.oldPath ?? undefined, file: document.file, group: 'history', historical: true,
      encoding: hooks.settings?.().encoding ?? 'utf-8' };
  }
  function validDocument(document: HistoryDocument): boolean { return Boolean(state.repository && document.repositoryId === state.repository.id && document.generation === state.generation); }
  async function activateDocument(id: string): Promise<void> {
    const document = state.documents.find(item => item.id === id);
    if (!document || !validDocument(document) || disposed) return;
    remember(); epoch++; requests.cancelAll(); pending = null;
    state.documents = state.documents.map(item => item.id === id ? { ...item, used: ++used } : item);
    state.activeDocument = id; resetReading(document.selection); state.selection = document.selection; state.selected = document.selection.kind === 'commit' ? document.selection.oid : document.selection.target;
    state.detail = document.detail; state.files = document.files; state.selectedPath = document.file.path; state.status = 'ready'; state.error = null; syncReview();
    const index = document.files.findIndex(file => file.path === document.file.path);
    diff.setNavigation({ fileIndex: index, fileCount: document.files.length, move: moveFile });
    await diff.open(documentQuery(document));
  }
  async function openFile(value: ChangedFile | string): Promise<void> {
    const path = typeof value === 'string' ? value : value.path, file = state.files.find(item => item.path === path);
    const selection = state.selection, repository = state.repository;
    if (disposed || !repository || !selection || !file || state.status !== 'ready') return;
    const id = JSON.stringify([repository.id, selection, file.path]);
    if (!state.documents.some(document => document.id === id)) {
      let documents = [...state.documents];
      if (documents.length >= maxDocuments) {
        const oldest = documents.filter(document => !document.pinned).sort((a, b) => a.used - b.used)[0];
        if (!oldest) { state.error = { code: 'DOCUMENT_LIMIT', message: 'All document tabs are pinned. Close or unpin a tab before opening another.' }; report(state.error); return; }
        documents = documents.filter(document => document.id !== oldest.id);
      }
      const document: HistoryDocument = Object.freeze({ id, repositoryId: repository.id, generation: state.generation, selection: Object.freeze({ ...selection }), file,
        files: state.files, detail: state.detail, subject: state.detail?.commit.subject ?? '', used: ++used, pinned: false });
      state.documents = [...documents, document]; hooks.onOpenFile?.(document);
    }
    state.selectedPath = file.path; await activateDocument(id);
  }
  function activateGraph(): void { state.activeDocument = null; diff.clear(); }
  function closeDocument(id: string): Promise<void> {
    const active = state.activeDocument === id; state.documents = state.documents.filter(document => document.id !== id);
    if (!active) return Promise.resolve();
    const next = [...state.documents].sort((a, b) => b.used - a.used)[0];
    if (next) return activateDocument(next.id);
    activateGraph(); return Promise.resolve();
  }
  function pinDocument(id: string, pinned = true): void { state.documents = state.documents.map(document => document.id === id ? Object.freeze({ ...document, pinned }) : document); }
  async function moveFile(direction: -1 | 1, edge?: 'first' | 'last'): Promise<boolean> {
    if (!state.activeDocument || !state.selectedPath) return false;
    const document = state.documents.find(item => item.id === state.activeDocument);
    if (!document || !validDocument(document)) return false;
    const index = document.files.findIndex(file => file.path === document.file.path), file = document.files[index + direction];
    if (!file) return false;
    await openFile(file); if (edge) await diff.navigateChange(direction, edge); return true;
  }
  async function openWorking(query: WorkingDiffOpen): Promise<void> {
    state.activeDocument = null;
    diff.setNavigation(null);
    await diff.open({ ...query, path: query.file.path, oldPath: query.file.oldPath ?? undefined, historical: false, encoding: hooks.settings?.().encoding ?? 'utf-8' });
  }
  function startReview(): boolean {
    const repository = state.repository, target = reviewTarget(state.selection), key = reviewKey(state.selection);
    if (!store || !repository || !target || !key || state.status !== 'ready') return false;
    const started = Boolean(store.startReview(key, repository.id, target)); syncReview();
    // The explicit start may mark only an already successfully loaded matching historical document.
    if (started && diff.state.status === 'ready' && diff.state.selection) markLoaded(diff.state.selection);
    return started;
  }
  function stopReview(): void { if (store && state.repository && state.review.key) store.endReview(state.review.key, state.repository.id); syncReview(); }
  function markReviewed(path: string, checked = true): boolean {
    if (!store || !state.repository || !state.review.key || !state.review.active || !state.files.some(file => file.path === path)) return false;
    // Checks require a successful patch for this exact file; unchecking an existing mark is always safe.
    if (checked) {
      const document = state.documents.find(item => item.id === state.activeDocument), selection = diff.state.selection;
      if (diff.state.status !== 'ready' || !document || !selection?.historical || !validDocument(document) || document.file.path !== path || selection.path !== path || selectionKey(document.selection) !== selectionKey(state.selection!)) return false;
      const target = document.selection.kind === 'commit' ? document.selection.oid : document.selection.target;
      const base = document.selection.kind === 'commit' ? document.selection.parent ?? null : document.selection.base;
      if (selection.target !== target || selection.base !== base) return false;
    }
    store.review(state.review.key, state.repository.id, path, checked); syncReview(); return true;
  }
  function updateReading(value: Partial<InspectorReading>): void { Object.assign(state, value); remember(); }
  function cancel(): void {
    epoch++; requests.cancelAll(); pending = null;
    if (state.status === 'loading') { state.status = 'cancelled'; state.error = { code: 'CANCELLED', message: 'Commit read cancelled.' }; state.detail = null; state.files = []; syncReview(); }
  }
  function clear(): void {
    remember(); cancel(); state.selection = null; state.selected = null; state.status = 'idle'; state.error = null; state.detail = null; state.files = []; state.selectedPath = null; state.review = emptyReview(); activateGraph();
  }
  function invalidate(): void { details.clear(); comparisons.clear(); diff.invalidate(); }
  function dispose(): void { if (disposed) return; clear(); state.documents = []; invalidate(); inspectorReadings.clear(); diff.dispose(); disposed = true; }
  return {
    state, diff, setRepository, select, compare, selectParent, openFile, openDocument: openFile, activateDocument, closeDocument, pinDocument, activateGraph,
    openWorking, moveFile, startReview, stopReview, markReviewed, syncReview, updateReading, cancel, clear, invalidate,
    retry: () => state.selection ? runLoad(state.selection, true) : Promise.resolve(), dispose,
    get cacheInfo() { return { details: details.size, detailBytes: details.bytes, comparisons: comparisons.size, documents: state.documents.length }; },
  };
}
export type HistoryController = ReturnType<typeof createHistoryController>;

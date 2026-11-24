import { shallowReactive } from 'vue';
import type { AppError, ChangedFile, DiffQuery, DiffResult, Host, Repository } from '../shared/protocol';
import {
  cacheableDiff, contentRows, diffBytes, diffCacheKey, PatchModelCache, projectDiff,
  type ContentSide, type DiffContextContent, type DiffRows, type DiffViewLine,
} from '../lib/diff';
import { LruCache } from '../lib/format';
import { Requests } from '../lib/state';

export type RepositoryGeneration = string | number;
export type DiffMode = 'unified' | 'split' | 'old' | 'new';
export type DiffStatus = 'idle' | 'loading' | 'ready' | 'binary' | 'truncated' | 'error' | 'cancelled' | 'blocked';
export interface DiffOpen {
  base: string | null; target: string; path: string; oldPath?: string;
  group?: string; staged?: boolean; historical?: boolean; encoding?: string; context?: number;
  file?: ChangedFile;
}
export interface DiffAnchor {
  id?: string; changeId?: string; gapId?: string; old?: number | null; next?: number | null; offset: number;
}
export interface DiffReading {
  scrollTop: number; scrollLeft: number; mode: DiffMode; activeChange: string | null;
  showUnchanged: boolean; expandedGaps: string[]; anchor?: DiffAnchor;
}
export interface DiffSideState {
  status: DiffStatus; data: DiffContextContent | null; error: AppError | null;
}
export interface DiffControllerState {
  repository: Repository | null; generation: RepositoryGeneration; identity: string;
  selection: DiffOpen | null; query: DiffQuery | null; historical: boolean;
  status: DiffStatus; error: AppError | null; result: DiffResult | null;
  sides: Record<ContentSide, DiffSideState>; mode: DiffMode; context: number;
  rows: DiffRows; reading: DiffReading; readingRevision: number;
  fileIndex: number; fileCount: number;
}
export interface DiffControllerHooks {
  onError?: (error: AppError) => void;
  onResultError?: (error: AppError) => void;
  onLoaded?: (selection: Readonly<DiffOpen>) => void;
  onNavigateFile?: (direction: -1 | 1, edge?: 'first' | 'last') => boolean | Promise<boolean>;
  maxPatches?: number; maxContents?: number; maxReadings?: number; byteLimit?: number;
  mode?: DiffMode; encoding?: string;
}
export interface DiffNavigation {
  fileIndex: number; fileCount: number;
  move: (direction: -1 | 1, edge?: 'first' | 'last') => boolean | Promise<boolean>;
}
const emptyRows = (): DiffRows => ({ lines: [], changes: [], limited: false, hunkCount: 0 });
const emptySide = (): DiffSideState => ({ status: 'idle', data: null, error: null });
const initialReading = (mode: DiffMode): DiffReading => ({ scrollTop: 0, scrollLeft: 0, mode, activeChange: null, showUnchanged: false, expandedGaps: [] });
const bound = (value: number | undefined, fallback: number, max: number): number => Math.max(1, Math.min(max, Math.floor(Number.isFinite(value) ? value! : fallback)));
const contextValue = (value: number): number => Math.max(0, Math.min(10000, Math.floor(Number.isFinite(value) ? value : 3)));
export function controllerError(error: unknown): AppError {
  if (error && typeof error === 'object') {
    const value = error as Partial<AppError>;
    return { code: typeof value.code === 'string' ? value.code : 'READ_FAILED', message: typeof value.message === 'string' ? value.message : 'Repository read failed.', ...(typeof value.detail === 'string' ? { detail: value.detail } : {}) };
  }
  return { code: 'READ_FAILED', message: typeof error === 'string' ? error : 'Repository read failed.' };
}
export function controllerErrorStatus(error: AppError): 'error' | 'cancelled' | 'blocked' {
  if (/CANCEL|ABORT/i.test(error.code)) return 'cancelled';
  if (/TRUST|BLOCK|DENIED|DESKTOP_REQUIRED|UNAVAILABLE|UNSUPPORTED|CAPABILITY/i.test(error.code)) return 'blocked';
  return 'error';
}
function resultStatus(result: DiffResult): DiffStatus { return result.binary ? 'binary' : result.truncated ? 'truncated' : 'ready'; }
function validResult(result: DiffResult): boolean {
  return Boolean(result && typeof result.patch === 'string' && typeof result.binary === 'boolean' && typeof result.truncated === 'boolean'
    && (result.oldContent === null || typeof result.oldContent === 'string') && (result.newContent === null || typeof result.newContent === 'string'));
}
function inputElement(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(element?.isContentEditable || element?.closest?.('input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])'));
}
/** No document/window listeners: callers bind this only to the historical surface. */
export function historicalDiffShortcut(event: KeyboardEvent, historical: boolean): 'previous-file' | 'next-file' | 'previous-change' | 'next-change' | null {
  if (!historical || event.defaultPrevented || event.isComposing || event.keyCode === 229 || inputElement(event.target) || !event.altKey || event.ctrlKey || event.metaKey) return null;
  if (event.key === 'F5') return event.shiftKey ? 'previous-change' : 'next-change';
  if (!event.shiftKey && event.key === 'PageUp') return 'previous-file';
  if (!event.shiftKey && event.key === 'PageDown') return 'next-file';
  return null;
}

/** Real Host reads, one active identity, bounded immutable-only caches. Never owns a repository activation. */
export function createDiffController(host: Host, hooks: DiffControllerHooks = {}) {
  const defaultMode = hooks.mode ?? 'unified';
  const state = shallowReactive<DiffControllerState>({
    repository: null, generation: 0, identity: '', selection: null, query: null, historical: false,
    status: 'idle', error: null, result: null, sides: { old: emptySide(), new: emptySide() },
    mode: defaultMode, context: 3, rows: emptyRows(), reading: initialReading(defaultMode), readingRevision: 0,
    fileIndex: -1, fileCount: 0,
  });
  const bytes = bound(hooks.byteLimit, 32 * 1024 * 1024, 128 * 1024 * 1024);
  const patches = new LruCache<DiffResult>(bound(hooks.maxPatches, 20, 64), bytes, diffBytes);
  const contents = new LruCache<DiffContextContent>(bound(hooks.maxContents, 24, 96), bytes, data => 96 + (data.content?.length ?? 0) * 2);
  const readings = new LruCache<DiffReading>(bound(hooks.maxReadings, 96, 256), 2 * 1024 * 1024);
  const models = new PatchModelCache();
  const requests = new Requests(id => typeof host.cancel === 'function' ? host.cancel(id) : Promise.resolve());
  let epoch = 0, disposed = false, navigation: DiffNavigation | null = null;
  let patchPending: Promise<void> | null = null;
  const pending: Partial<Record<ContentSide, Promise<void>>> = {};
  let legacyResult: DiffResult | null = null;

  function report(error: AppError): void { (hooks.onResultError ?? hooks.onError)?.(error); }
  function remember(): void { if (state.identity) readings.set(state.identity, structuredClone(state.reading)); }
  function current(version: number, repoId: string, generation: RepositoryGeneration, identity: string): boolean {
    return !disposed && epoch === version && state.repository?.id === repoId && state.generation === generation && state.identity === identity;
  }
  function key(query: DiffQuery): string { return JSON.stringify([diffCacheKey(query), state.selection?.group ?? 'history', state.historical]); }
  function sideState(side: ContentSide, value: DiffSideState): void { state.sides = { ...state.sides, [side]: value }; }
  function project(): void {
    if (!state.result || state.status === 'binary' || state.status === 'idle' || state.status === 'loading' || state.status === 'error' || state.status === 'cancelled' || state.status === 'blocked') { state.rows = emptyRows(); return; }
    if (state.mode === 'old' || state.mode === 'new') {
      const data = state.sides[state.mode];
      state.rows = data.status === 'ready' && data.data?.content !== null && data.data ? contentRows(data.data.content!, state.mode) : emptyRows();
      return;
    }
    const source = models.prepare(state.result, state.mode === 'split');
    const sideValues = [state.sides.old, state.sides.new];
    const failed = sideValues.find(side => ['error', 'cancelled', 'blocked', 'truncated', 'binary'].includes(side.status));
    const contextStatus: DiffViewLine['gapStatus'] = sideValues.some(side => side.status === 'loading') ? 'loading'
      : failed?.status === 'cancelled' ? 'cancelled' : failed?.status === 'truncated' ? 'limited' : failed ? 'error' : 'unavailable';
    state.rows = projectDiff(source.document!, state.mode === 'split', {
      showUnchanged: state.reading.showUnchanged, expandedGaps: new Set(state.reading.expandedGaps),
      oldContent: state.sides.old.data ?? undefined, newContent: state.sides.new.data ?? undefined, contextStatus,
    });
  }
  function cancelRequests(): void {
    epoch++; requests.cancelAll(); patchPending = null; delete pending.old; delete pending.new;
  }
  function resetSurface(): void {
    if (state.query && (!cacheableDiff(state.query) || state.query.staged)) models.clear();
    state.result = null; state.error = null; state.rows = emptyRows(); state.sides = { old: emptySide(), new: emptySide() }; legacyResult = null;
  }
  function clear(): void {
    remember(); cancelRequests(); resetSurface(); state.identity = ''; state.query = null; state.selection = null; state.status = 'idle'; state.historical = false;
    state.fileIndex = -1; state.fileCount = 0; navigation = null;
  }
  function setRepository(repository: Repository | null, generation: RepositoryGeneration): void {
    if (disposed) return;
    if (state.repository?.id === repository?.id && state.generation === generation) { state.repository = repository; return; }
    clear(); patches.clear(); contents.clear(); models.clear(); state.repository = repository; state.generation = generation;
  }
  function setNavigation(value: DiffNavigation | null): void {
    navigation = value; state.fileIndex = value?.fileIndex ?? -1; state.fileCount = value?.fileCount ?? 0;
  }
  async function loadPatch(force: boolean): Promise<void> {
    const query = state.query, selection = state.selection, repository = state.repository;
    if (!query || !selection || !repository || disposed) return;
    const version = epoch, identity = state.identity, generation = state.generation, request = requests.begin('patch');
    state.query = { ...query, requestId: request.id };
    const cacheKey = key(query), cacheable = cacheableDiff(query) && !query.staged;
    try {
      const cached = !force && cacheable ? patches.get(cacheKey) : undefined;
      const read = host.diffPatch ?? host.diff;
      if (!read) throw { code: 'CAPABILITY_MISSING', message: 'This Host does not provide patch reads.' };
      const raw = cached ?? await read.call(host, { ...query, requestId: request.id });
      if (!request.current() || !current(version, repository.id, generation, identity)) return;
      if (!validResult(raw)) throw { code: 'INVALID_DIFF_RESULT', message: 'The Host returned an invalid diff response.' };
      const result = cached ?? Object.freeze({ ...raw });
      if (!cached && cacheable && resultStatus(result) === 'ready') patches.set(cacheKey, result);
      state.result = result; state.status = resultStatus(result); state.error = null;
      if (!host.diffPatch) {
        legacyResult = result;
        for (const side of ['old', 'new'] as const) {
          const content = side === 'old' ? result.oldContent : result.newContent;
          if (content !== null) sideState(side, { status: resultStatus(result), data: { content, binary: result.binary, truncated: result.truncated }, error: null });
        }
      }
      project();
      if (state.status === 'ready') hooks.onLoaded?.(Object.freeze({ ...selection }));
      if (state.mode === 'old' || state.mode === 'new') await ensureContent(state.mode);
      else if (state.reading.showUnchanged || state.reading.expandedGaps.length) await loadContext();
    } catch (error) {
      if (!request.current() || !current(version, repository.id, generation, identity)) return;
      state.error = controllerError(error); state.status = controllerErrorStatus(state.error); state.result = null; state.rows = emptyRows();
      report(state.error);
    } finally { request.finish(); }
  }
  function open(selection: DiffOpen, force = false): Promise<void> {
    if (disposed) return Promise.resolve();
    const repository = state.repository;
    if (!repository) {
      clear(); state.status = 'blocked'; state.error = { code: 'NO_REPOSITORY', message: 'Select a repository before opening a diff.' }; report(state.error); return Promise.resolve();
    }
    if (!selection.path || !selection.target) {
      clear(); state.status = 'error'; state.error = { code: 'INVALID_DIFF_QUERY', message: 'A diff requires a target and a file path.' }; report(state.error); return Promise.resolve();
    }
    const oldPath = selection.oldPath ?? selection.file?.oldPath ?? undefined;
    const historical = selection.historical ?? ((selection.group === undefined || selection.group === 'history') && cacheableDiff(selection) && !selection.staged);
    const identity = JSON.stringify([repository.id, selection.base, selection.target, selection.path, oldPath ?? '', selection.group ?? 'history', Boolean(selection.staged), historical, selection.encoding ?? hooks.encoding ?? 'utf-8']);
    if (!force && identity === state.identity && state.query?.context === contextValue(selection.context ?? state.context)) {
      if (state.status === 'loading' && patchPending) return patchPending;
      if ((state.status === 'ready' || state.status === 'binary' || state.status === 'truncated') && cacheableDiff(selection) && !selection.staged) {
        if (state.status === 'ready' && state.selection) hooks.onLoaded?.(state.selection);
        return Promise.resolve();
      }
    }
    remember(); cancelRequests(); resetSurface(); state.identity = identity; state.selection = Object.freeze({ ...selection, oldPath, historical }); state.historical = historical;
    state.context = contextValue(selection.context ?? state.context);
    const saved = readings.get(identity); state.reading = saved ? structuredClone(saved) : initialReading(state.mode === 'old' || state.mode === 'new' ? defaultMode : state.mode);
    state.mode = state.reading.mode; state.readingRevision++;
    state.query = { repoId: repository.id, requestId: '', base: selection.base, target: selection.target, path: selection.path, oldPath: selection.oldPath ?? selection.file?.oldPath ?? undefined, staged: selection.staged, context: state.context, encoding: selection.encoding ?? hooks.encoding ?? 'utf-8' };
    state.status = 'loading';
    const promise = loadPatch(force); patchPending = promise;
    void promise.finally(() => { if (patchPending === promise) patchPending = null; }); return promise;
  }
  function ensureContent(side: ContentSide): Promise<void> {
    if (disposed || !state.query || !state.result || !['ready', 'truncated'].includes(state.status)) return Promise.resolve();
    if (state.sides[side].status === 'ready') return Promise.resolve();
    if (pending[side]) return pending[side]!;
    const promise = readContent(side); pending[side] = promise;
    void promise.finally(() => { if (pending[side] === promise) delete pending[side]; }); return promise;
  }
  async function readContent(side: ContentSide): Promise<void> {
    const query = state.query!, version = epoch, identity = state.identity, generation = state.generation;
    const request = requests.begin(`content:${side}`), cacheKey = JSON.stringify([key(query), side]), cacheable = cacheableDiff(query) && !query.staged;
    sideState(side, { status: 'loading', data: null, error: null }); project();
    try {
      let data = cacheable ? contents.get(cacheKey) : undefined;
      if (!data) {
        if (!host.fileContent && !legacyResult) throw { code: 'CAPABILITY_MISSING', message: 'This Host does not provide lazy file content reads.' };
        const result = host.fileContent ? await host.fileContent({ ...query, requestId: request.id }, side) : legacyResult!;
        if (!request.current() || !current(version, query.repoId, generation, identity)) return;
        if (!validResult(result)) throw { code: 'INVALID_DIFF_RESULT', message: 'The Host returned invalid file content.' };
        data = Object.freeze({ content: side === 'old' ? result.oldContent : result.newContent, binary: result.binary, truncated: result.truncated });
      }
      if (!request.current() || !current(version, query.repoId, generation, identity)) return;
      const status: DiffStatus = data.binary ? 'binary' : data.truncated ? 'truncated' : data.content === null ? 'blocked' : 'ready';
      const error = status === 'blocked' ? { code: 'CONTENT_UNAVAILABLE', message: `The ${side} side has no readable text. It may not exist in this comparison.` } : null;
      sideState(side, { status, data, error });
      if (cacheable && status === 'ready') contents.set(cacheKey, data);
    } catch (error) {
      if (!request.current() || !current(version, query.repoId, generation, identity)) return;
      const value = controllerError(error); sideState(side, { status: controllerErrorStatus(value), data: null, error: value }); report(value);
    } finally {
      request.finish();
      if (current(version, query.repoId, generation, identity)) project();
    }
  }
  async function loadContext(): Promise<void> { await Promise.all([ensureContent('old'), ensureContent('new')]); }
  async function setMode(mode: DiffMode): Promise<void> {
    if (disposed) return;
    state.mode = mode; state.reading = { ...state.reading, mode }; project();
    if (mode === 'old' || mode === 'new') await ensureContent(mode);
    else if (state.reading.showUnchanged || state.reading.expandedGaps.length) await loadContext();
  }
  function setContext(context: number): Promise<void> {
    const value = contextValue(context); if (value === state.context) return Promise.resolve();
    state.context = value; return state.selection ? open({ ...state.selection, context: value }) : Promise.resolve();
  }
  async function setShowUnchanged(show: boolean): Promise<void> {
    state.reading = { ...state.reading, showUnchanged: show }; project();
    if (show) await loadContext();
  }
  async function toggleGap(id: string): Promise<void> {
    if (!state.rows.document?.sections.some(section => section.kind === 'gap' && section.id === id)) return;
    const gaps = new Set(state.reading.expandedGaps); if (gaps.has(id)) gaps.delete(id); else gaps.add(id);
    state.reading = { ...state.reading, expandedGaps: [...gaps] }; project(); if (gaps.has(id)) await loadContext();
  }
  function updateReading(value: Partial<Pick<DiffReading, 'scrollTop' | 'scrollLeft' | 'anchor'>>): void {
    state.reading = { ...state.reading, ...value, scrollTop: Math.max(0, value.scrollTop ?? state.reading.scrollTop), scrollLeft: Math.max(0, value.scrollLeft ?? state.reading.scrollLeft) }; remember();
  }
  async function navigateFile(direction: -1 | 1, edge?: 'first' | 'last'): Promise<boolean> {
    if (!state.historical) return false;
    return Boolean(await (navigation?.move ?? hooks.onNavigateFile)?.(direction, edge));
  }
  async function navigateChange(direction: -1 | 1, edge?: 'first' | 'last'): Promise<boolean> {
    if (!state.historical || state.status !== 'ready') return false;
    if (state.mode === 'old' || state.mode === 'new') await setMode(defaultMode === 'split' ? 'split' : 'unified');
    const changes = state.rows.changes ?? [], currentIndex = changes.findIndex(change => change.id === state.reading.activeChange);
    const index = edge ? edge === 'first' ? 0 : changes.length - 1 : currentIndex < 0 ? direction > 0 ? 0 : changes.length - 1 : currentIndex + direction;
    if (index < 0 || index >= changes.length) return edge ? false : navigateFile(direction, direction < 0 ? 'last' : 'first');
    state.reading = { ...state.reading, activeChange: changes[index].id }; state.readingRevision++; remember(); return true;
  }
  function handleKeydown(event: KeyboardEvent): boolean {
    const shortcut = historicalDiffShortcut(event, state.historical); if (!shortcut) return false;
    event.preventDefault(); event.stopPropagation();
    if (shortcut === 'previous-file' || shortcut === 'next-file') void navigateFile(shortcut === 'previous-file' ? -1 : 1);
    else void navigateChange(shortcut === 'previous-change' ? -1 : 1);
    return true;
  }
  function cancelContent(): void {
    for (const side of ['old', 'new'] as const) {
      requests.cancel(`content:${side}`); delete pending[side];
      if (state.sides[side].status === 'loading') sideState(side, { status: 'cancelled', data: null, error: { code: 'CANCELLED', message: 'Content read cancelled.' } });
    }
    project();
  }
  function cancel(): void {
    if (state.status === 'loading') { cancelRequests(); resetSurface(); state.status = 'cancelled'; state.error = { code: 'CANCELLED', message: 'Diff read cancelled.' }; }
    else cancelContent();
  }
  function invalidate(): void { patches.clear(); contents.clear(); models.clear(); }
  function dispose(): void { if (disposed) return; clear(); invalidate(); readings.clear(); disposed = true; }
  return {
    state, setRepository, open, clear, setNavigation, setMode, setContext, setShowUnchanged, toggleGap,
    ensureContent, cancelContent, updateReading, navigateChange, navigateFile, handleKeydown, cancel,
    retry: () => state.selection ? open(state.selection, true) : Promise.resolve(), invalidate, dispose,
    get cacheInfo() { return { patches: patches.size, patchBytes: patches.bytes, contents: contents.size, contentBytes: contents.bytes, readings: readings.size, models: models.size }; },
  };
}
export type DiffController = ReturnType<typeof createDiffController>;

import { DEFAULT_SETTINGS, defaultState, type AppSettings, type DirectoryScopeState, type PersistedState, type ReviewSession, type ReviewTarget, type SettingsPatch, type ViewState } from '../shared/protocol';
import { clamp } from './format';
import { isRecord, mergeSettingsPatches, normalizeHistoryScope, normalizeSettings, normalizeSettingsPatch } from './settings-schema';

export const REVIEW_LIFETIME = 90 * 86400 * 1000;
const MAX_REVIEWS = 500;
const safeKey = (key: string): boolean => Boolean(key) && key.length <= 4096 && !['__proto__', 'prototype', 'constructor'].includes(key) && !/[\u0000-\u001f\u007f]/.test(key);
const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const number = (value: unknown, fallback: number, min: number, max: number): number => typeof value === 'number' && Number.isFinite(value) ? clamp(value, min, max) : fallback;
export function isImmutableOid(value: unknown): value is string { return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value); }

/** Review caches may identify immutable objects only: never HEAD, a ref, worktree, index or a revision expression. */
export function normalizeReviewTarget(value: unknown): ReviewTarget | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'commit' && isImmutableOid(value.oid)) {
    if (value.parent !== undefined && !isImmutableOid(value.parent)) return null;
    if (value.base !== undefined && value.base !== 'ROOT' && !isImmutableOid(value.base)) return null;
    if (value.parent && value.base && value.parent !== value.base) return null;
    const parent = value.parent ?? (value.base === 'ROOT' ? undefined : value.base);
    return { kind: 'commit', oid: value.oid, ...(parent ? { parent: parent as string } : {}) };
  }
  if (value.kind === 'compare' && isImmutableOid(value.base) && isImmutableOid(value.target)) return { kind: 'compare', base: value.base, target: value.target };
  return null;
}
function legacyReviewTarget(key: string): ReviewTarget | null {
  const parts = key.split(':');
  if (parts[0] === 'commit') return normalizeReviewTarget({ kind: 'commit', oid: parts[1], ...(parts[2] && parts[2] !== 'ROOT' ? { base: parts[2] } : {}) });
  if (parts[0] === 'compare') return normalizeReviewTarget({ kind: 'compare', base: parts[1], target: parts[2] });
  return null;
}
function normalizeReviews(value: unknown, now: number): ReviewSession[] {
  if (!Array.isArray(value)) return [];
  const sessions = new Map<string, ReviewSession>();
  for (const entry of value) {
    if (!isRecord(entry) || !text(entry.key) || !entry.key || !text(entry.repoId) || !entry.repoId || !Array.isArray(entry.paths) || typeof entry.updatedAt !== 'number' || !Number.isFinite(entry.updatedAt) || entry.updatedAt < now - REVIEW_LIFETIME) continue;
    const explicitSelection = normalizeReviewTarget(entry.selection);
    const selection = explicitSelection ?? legacyReviewTarget(entry.key);
    // Old manual marks are resumable, not automatically active after migration.
    const active = Boolean(explicitSelection && entry.active === true);
    const review: ReviewSession = {
      key: entry.key, repoId: entry.repoId,
      paths: [...new Set(entry.paths.filter((path): path is string => text(path) && Boolean(path)))].slice(0, 10000),
      updatedAt: Math.min(entry.updatedAt, now), active,
      ...(selection ? { selection } : {}),
      ...(typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt) ? { startedAt: Math.min(entry.startedAt, now) } : {}),
    };
    sessions.set(JSON.stringify([review.repoId, review.key]), review);
  }
  return [...sessions.values()].sort((a, b) => a.updatedAt - b.updatedAt).slice(-MAX_REVIEWS);
}
function normalizeView(value: unknown, settings: AppSettings): ViewState | null {
  if (!isRecord(value)) return null;
  const scope = normalizeHistoryScope(value.scope) ?? structuredClone(settings.startupScope);
  const view: ViewState = {
    scope, search: typeof value.search === 'string' ? value.search.slice(0, 32768) : '',
    searchMode: ['all', 'message', 'author', 'hash', 'date', 'refs'].includes(String(value.searchMode)) ? String(value.searchMode) : 'all',
    queryMode: value.queryMode === 'search' ? 'search' : 'filter',
    order: ['topo', 'date', 'author-date'].includes(String(value.order)) ? value.order as ViewState['order'] : settings.order,
    scrollTop: number(value.scrollTop, 0, 0, 1_000_000_000), selected: text(value.selected) ? value.selected : null,
  };
  if (typeof value.scrollLeft === 'number') view.scrollLeft = number(value.scrollLeft, 0, 0, 1_000_000_000);
  if (isRecord(value.detail)) {
    const selection = isRecord(value.detail.selection) && value.detail.selection.kind === 'working' ? { kind: 'working' as const } : normalizeReviewTarget(value.detail.selection);
    if (selection) {
      const detail: NonNullable<ViewState['detail']> = { selection };
      if (text(value.detail.path)) detail.path = value.detail.path;
      for (const key of ['scrollTop', 'filesScrollTop', 'filesScrollLeft'] as const) {
        if (typeof value.detail[key] === 'number') detail[key] = number(value.detail[key], 0, 0, 1_000_000_000);
      }
      if (typeof value.detail.fullMessage === 'boolean') detail.fullMessage = value.detail.fullMessage;
      if (value.detail.inlineSide === 'above' || value.detail.inlineSide === 'below') detail.inlineSide = value.detail.inlineSide;
      view.detail = detail;
    }
  }
  if (isRecord(value.filter)) {
    const filter: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.filter).slice(0, 64)) if (safeKey(key) && text(item)) filter[key] = item;
    view.filter = filter;
  }
  if (Array.isArray(value.collapsed)) view.collapsed = [...new Set(value.collapsed.filter((item): item is string => text(item)))].slice(0, 10000);
  return view;
}
export function mergeSettings(base: AppSettings, partial?: SettingsPatch | Partial<AppSettings>): AppSettings { return normalizeSettings(partial, base); }
export function normalizeDirectoryScope(value: unknown): DirectoryScopeState | null {
  if (!isRecord(value) || typeof value.root !== 'string' || !value.root
    || /[\u0000-\u001f\u007f-\u009f]/.test(value.root) || new TextEncoder().encode(value.root).length > 32768
    || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/.test(value.root)) return null;
  const collapsedPaths: string[] = [];
  if (Array.isArray(value.collapsedPaths)) for (const key of value.collapsedPaths) {
    if (typeof key !== 'string' || key.length > 32768 || /[\\:\u0000-\u001f\u007f]/.test(key)) continue;
    try {
      if (key && key.split('/').some(segment => !segment || ['.', '..'].includes(segment) || encodeURIComponent(decodeURIComponent(segment)) !== segment)) continue;
    } catch { continue; }
    if (!collapsedPaths.includes(key)) collapsedPaths.push(key);
    if (collapsedPaths.length >= 256) break;
  }
  return { root: value.root, depth: Math.round(number(value.depth, 2, 0, 5)),
    width: Math.round(number(value.width, 376, 180, 640)), collapsed: value.collapsed === true, collapsedPaths };
}
export function normalizeState(input: unknown, now = Date.now()): PersistedState {
  const fallback = defaultState(); const state = isRecord(input) ? input : {};
  const legacyPageSize = !(typeof state.version === 'number' && state.version >= 2);
  const settings = normalizeSettings(state.settings, DEFAULT_SETTINGS, { legacyPageSize });
  const repoSettings: Record<string, SettingsPatch> = {};
  if (isRecord(state.repoSettings)) for (const [repoId, patch] of Object.entries(state.repoSettings).slice(0, 1000)) {
    if (!safeKey(repoId)) continue;
    const clean = normalizeSettingsPatch(patch, { scope: 'repository', legacyPageSize });
    if (Object.keys(clean).length) repoSettings[repoId] = clean;
  }
  const views: Record<string, ViewState> = {};
  if (isRecord(state.views)) for (const [repoId, value] of Object.entries(state.views).slice(0, 1000)) {
    if (!safeKey(repoId)) continue;
    const view = normalizeView(value, mergeSettings(settings, repoSettings[repoId])); if (view) views[repoId] = view;
  }
  const recent = Array.isArray(state.recent) ? state.recent.filter(isRecord).filter(item => text(item.path) && Boolean(item.path)).map(item => ({ path: item.path as string, name: text(item.name) ? item.name : String(item.path).split(/[\\/]/).filter(Boolean).pop() ?? String(item.path) })) : [];
  const seen = new Set<string>();
  const layout = isRecord(state.layout) ? state.layout : {};
  return {
    ...fallback, version: 2, settings, repoSettings, views, directoryScope: normalizeDirectoryScope(state.directoryScope),
    recent: recent.filter(item => { if (seen.has(item.path)) return false; seen.add(item.path); return true; }).slice(0, 30),
    lastRepo: text(state.lastRepo) ? state.lastRepo : null,
    trusted: Array.isArray(state.trusted) ? [...new Set(state.trusted.filter((path): path is string => text(path) && Boolean(path)))].slice(0, 1000) : [],
    reviews: normalizeReviews(state.reviews, now),
    layout: {
      detailSize: number(layout.detailSize, 320, 140, 1200), fileSize: number(layout.fileSize, 260, 150, 700),
      localWidth: Math.round(number(layout.localWidth, 390, 240, 960)), localListSize: Math.round(number(layout.localListSize, 230, 100, 1200)),
      detailRatio: number(layout.detailRatio, 0.55, 0.2, 0.8),
    },
  };
}
export function effectiveSettings(state: PersistedState, repoId?: string | null): AppSettings {
  const patch = repoId ? normalizeSettingsPatch(state.repoSettings[repoId], { scope: 'repository' }) : undefined;
  return mergeSettings(state.settings, patch);
}

export class StateStore {
  state = defaultState();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chain: Promise<void> = Promise.resolve();
  private revision = 0;
  private savedRevision = 0;
  private failed = false;
  get dirty(): boolean { return this.failed || this.revision !== this.savedRevision; }
  constructor(private readonly save: (state: PersistedState) => Promise<void>, private readonly onError: (error: unknown) => void) {}
  load(state: PersistedState): void {
    clearTimeout(this.timer); this.timer = undefined;
    this.state = normalizeState(state); this.revision++; this.savedRevision = this.revision; this.failed = false;
  }
  queue(): void {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(error => { this.onError(error); }); }, 240);
  }
  /** A caller awaiting an explicit save must see failures. The next save retries the newest snapshot. */
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    // Project through the persisted schema: transient working drafts and unknown UI data never reach disk.
    const snapshot = normalizeState(this.state); const revision = this.revision;
    const operation = this.chain.catch(() => undefined).then(async () => {
      try {
        await this.save(snapshot);
        this.savedRevision = revision; this.failed = false;
      } catch (error) { this.failed = true; throw error; }
    });
    this.chain = operation;
    return operation;
  }
  updateSettings(patch: SettingsPatch | Partial<AppSettings>, repoId?: string | null): void {
    if (repoId) {
      if (!safeKey(repoId)) return;
      const clean = normalizeSettingsPatch(patch, { scope: 'repository' });
      this.state.repoSettings[repoId] = mergeSettingsPatches(this.state.repoSettings[repoId] ?? {}, clean);
    } else this.state.settings = mergeSettings(this.state.settings, patch);
    this.queue();
  }
  reviewed(key: string, repoId: string): Set<string> {
    return new Set(this.state.reviews.find(review => review.key === key && review.repoId === repoId)?.paths ?? []);
  }
  isReviewActive(key: string, repoId: string): boolean {
    const review = this.state.reviews.find(item => item.key === key && item.repoId === repoId);
    return Boolean(review?.active === true && normalizeReviewTarget(review.selection) && review.updatedAt >= Date.now() - REVIEW_LIFETIME);
  }
  startReview(key: string, repoId: string, selection: ReviewTarget): ReviewSession | null {
    const target = normalizeReviewTarget(selection);
    if (!target || !safeKey(key) || !safeKey(repoId)) return null;
    const existing = this.state.reviews.find(review => review.key === key && review.repoId === repoId);
    // The cache identity cannot be repurposed to another immutable comparison.
    if (existing?.selection && JSON.stringify(normalizeReviewTarget(existing.selection)) !== JSON.stringify(target)) return null;
    const now = Date.now();
    const session: ReviewSession = { key, repoId, selection: target, paths: [...(existing?.paths ?? [])], startedAt: existing?.startedAt ?? now, updatedAt: now, active: true };
    this.state.reviews = this.state.reviews.filter(review => review.key !== key || review.repoId !== repoId);
    this.state.reviews.push(session); this.trimReviews(now); this.queue(); return structuredClone(session);
  }
  resumeReview(key: string, repoId: string): ReviewSession | null {
    const review = this.state.reviews.find(item => item.key === key && item.repoId === repoId);
    const selection = normalizeReviewTarget(review?.selection) ?? legacyReviewTarget(key);
    return review && selection ? this.startReview(key, repoId, selection) : null;
  }
  touchReview(key: string, repoId: string): boolean {
    const review = this.state.reviews.find(item => item.key === key && item.repoId === repoId);
    if (!review || !this.isReviewActive(key, repoId)) return false;
    review.updatedAt = Date.now(); this.queue(); return true;
  }
  endReview(key: string, repoId: string): void {
    const review = this.state.reviews.find(item => item.key === key && item.repoId === repoId);
    if (!review || review.active !== true) return;
    review.active = false; review.updatedAt = Date.now(); this.queue();
  }
  endAllReviews(repoId?: string): void {
    let changed = false;
    for (const review of this.state.reviews) if (review.active === true && (!repoId || review.repoId === repoId)) { review.active = false; review.updatedAt = Date.now(); changed = true; }
    if (changed) this.queue();
  }
  /** Manual marks retain the old API. They NEVER implicitly start an automatic review session. */
  review(key: string, repoId: string, path: string, checked: boolean): void {
    if (!safeKey(key) || !safeKey(repoId) || !text(path) || !path) return;
    const existing = this.state.reviews.find(review => review.key === key && review.repoId === repoId);
    const paths = new Set(existing?.paths ?? []);
    if (checked) paths.add(path); else paths.delete(path);
    this.state.reviews = this.state.reviews.filter(review => review.key !== key || review.repoId !== repoId);
    if (paths.size || existing?.active) this.state.reviews.push({ ...existing, key, repoId, paths: [...paths], updatedAt: Date.now(), active: existing?.active === true });
    this.trimReviews(Date.now()); this.queue();
  }
  private trimReviews(now: number): void { this.state.reviews = this.state.reviews.filter(review => review.updatedAt >= now - REVIEW_LIFETIME).sort((a, b) => a.updatedAt - b.updatedAt).slice(-MAX_REVIEWS); }
}

export class Requests {
  private active = new Map<string, { id: string; generation: number }>();
  private count = 0;
  constructor(private readonly cancelHost: (requestId: string) => Promise<void>) {}
  begin(channel: string): { id: string; current: () => boolean; finish: () => void } {
    this.cancel(channel);
    const generation = ++this.count;
    const id = `ui-${Date.now().toString(36)}-${generation}-${Math.random().toString(36).slice(2, 8)}`;
    this.active.set(channel, { id, generation });
    return {
      id,
      current: () => this.active.get(channel)?.generation === generation,
      finish: () => { if (this.active.get(channel)?.generation === generation) this.active.delete(channel); },
    };
  }
  cancel(channel: string): void {
    const request = this.active.get(channel);
    this.active.delete(channel);
    if (request) void this.cancelHost(request.id).catch(() => undefined);
  }
  cancelAll(except: string[] = []): void { for (const channel of this.active.keys()) if (!except.includes(channel)) this.cancel(channel); }
}

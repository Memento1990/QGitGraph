import type { Localizable } from './i18n';
import type { ChangedFile, ExternalSession, Repository, WorkingState } from '../shared/protocol';

export type StatusCancelScope = 'history' | 'write';
export interface StatusTask {
  /** Stable identity of this operation, not its changing display label. */
  id: string;
  label: Localizable;
  kind: 'write' | 'discover' | 'refresh' | 'open' | 'history';
  repoId?: string;
  /** Only a live history request or a live write process can be cancelled here. */
  cancelScope?: StatusCancelScope | null;
}
export interface StatusResult {
  id: string;
  kind: 'success' | 'error' | 'cancelled' | 'info';
  message: Localizable;
  repoId?: string;
  /** Epoch milliseconds, supplied by the owner of the completed operation. */
  at?: number;
}
export interface StatusHistoryInput {
  loaded: number;
  visible: number;
  hasMore: boolean;
  loading: boolean;
  ready: boolean;
  stale?: boolean;
  error?: string | null;
}
export interface StatusInput {
  repository: Repository | null;
  initialized?: boolean;
  opening?: boolean;
  /** The unfiltered snapshot. Never pass a show-untracked or path-filtered copy. */
  working: WorkingState | null;
  workingLoading?: boolean;
  workingStale?: boolean;
  workingError?: string | null;
  /** Last successful repository snapshot, never the last attempt or a history-only success. */
  lastSuccessfulRefresh?: number | null;
  history: StatusHistoryInput;
  task?: StatusTask | null;
  result?: StatusResult | null;
  compareBase?: string | null;
  sessions?: readonly ExternalSession[];
  gitVersion?: string | null;
}

export interface StatusCounts {
  /** Distinct paths, not the sum of the overlapping categories below. */
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
}
export interface WslLocation { host: 'wsl.localhost' | 'wsl$'; distribution: string }
export type StatusWorkingKind = 'none' | 'bare' | 'loading' | 'unknown' | 'error' | 'clean' | 'changed' | 'conflict';
export interface StatusWorking {
  kind: StatusWorkingKind;
  counts: StatusCounts | null;
  loading: boolean;
  stale: boolean;
  error: string | null;
  operation: WorkingState['operation'];
}
export interface StatusTracking {
  kind: 'unknown' | 'not-applicable' | 'no-upstream' | 'upstream' | 'counts';
  upstream: string | null;
  /** Null is deliberately different from a measured zero. */
  ahead: number | null;
  behind: number | null;
  stale: boolean;
}
export interface StatusHistory {
  kind: 'none' | 'unknown' | 'loading' | 'error' | 'ready';
  loaded: number;
  visible: number;
  hasMore: boolean;
  loading: boolean;
  stale: boolean;
  error: string | null;
}
export type StatusActivity =
  | { kind: 'task'; task: StatusTask; cancelScope: StatusCancelScope | null }
  | { kind: 'external'; session: ExternalSession }
  | { kind: 'result'; result: StatusResult }
  | { kind: 'compare'; base: string }
  | { kind: 'idle'; gitVersion: string | null };
export interface StatusModel {
  state: 'initializing' | 'opening' | 'empty' | 'ready';
  repository: Repository | null;
  context: {
    branch: string | null;
    head: string | null;
    headKind: 'branch' | 'unborn' | 'detached' | 'unknown';
    wsl: WslLocation | null;
    stale: boolean;
  };
  working: StatusWorking;
  tracking: StatusTracking;
  history: StatusHistory;
  lastSuccessfulRefresh: number | null;
  result: StatusResult | null;
  compareBase: string | null;
  /** Only sessions belonging to the active repository, including their real final states. */
  sessions: readonly ExternalSession[];
  activity: StatusActivity;
  taskState: 'running' | 'paused' | 'idle';
}

const UNMERGED_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
export function isStatusConflict(status: string): boolean {
  return UNMERGED_XY.has(status) || status.includes('U');
}
export function isStatusUntracked(status: string): boolean { return status === '?' || status === '??'; }

/** Porcelain's untracked flag is also "unstaged" in the transport; do not double-count it. */
export function countWorkingFiles(files: readonly ChangedFile[]): StatusCounts {
  const paths = new Map<string, { staged: boolean; unstaged: boolean; untracked: boolean; conflict: boolean }>();
  for (const file of files) {
    if (file.status === '!' || file.status === '!!') continue;
    const previous = paths.get(file.path);
    paths.set(file.path, {
      staged: Boolean(previous?.staged || file.staged),
      unstaged: Boolean(previous?.unstaged || file.unstaged || file.submodule?.modified || file.submodule?.untracked),
      untracked: Boolean(previous?.untracked || isStatusUntracked(file.status)),
      conflict: Boolean(previous?.conflict || isStatusConflict(file.status)),
    });
  }
  const counts: StatusCounts = { changed: paths.size, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
  for (const file of paths.values()) {
    if (file.conflict) counts.conflicts++;
    else if (file.untracked) counts.untracked++;
    else {
      if (file.staged) counts.staged++;
      if (file.unstaged) counts.unstaged++;
    }
  }
  return counts;
}

/** A location hint only. A WSL share does not mean Git itself is running in Linux. */
export function wslLocation(path: string): WslLocation | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//');
  const match = /^\/\/(wsl\.localhost|wsl\$)\/([^/]+)(?:\/|$)/i.exec(normalized);
  if (!match || match[2] === '.' || match[2] === '..' || /[\u0000-\u001f\u007f]/.test(match[2])) return null;
  return { host: match[1].toLowerCase() as WslLocation['host'], distribution: match[2] };
}

function count(value: number): number { return Number.isSafeInteger(value) && value >= 0 ? value : 0; }
function knownCount(value: number): number | null { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function timestamp(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : null;
}
function tracking(working: WorkingState | null, repository: Repository | null, stale: boolean, branch: string | null): StatusTracking {
  const unknown: StatusTracking = { kind: 'unknown', upstream: null, ahead: null, behind: null, stale };
  if (!repository || repository.bare || !working) return unknown;
  if (!branch) return { ...unknown, kind: 'not-applicable' };
  const upstream = typeof working.upstream === 'string' && working.upstream ? working.upstream : null;
  if (upstream && working.trackingKnown === true) {
    const ahead = knownCount(working.ahead), behind = knownCount(working.behind);
    if (ahead !== null && behind !== null) return { kind: 'counts', upstream, ahead, behind, stale };
  }
  if (upstream) return { ...unknown, kind: 'upstream', upstream };
  // An old host omitting upstream is unknown; explicit null from porcelain means no upstream.
  if (working.upstream === null) return { ...unknown, kind: 'no-upstream' };
  return unknown;
}
function cancellation(task: StatusTask): StatusCancelScope | null {
  if (task.kind === 'history' && task.cancelScope === 'history') return 'history';
  if (task.kind === 'write' && task.cancelScope === 'write') return 'write';
  return null;
}

/**
 * Pure projection: no Git calls, timers, network, polling, locale or inferred success events.
 * The default is uncached, including for mutable callers. A snapshot-owning view may supply
 * counts for this exact raw files array; that owner is responsible for cache invalidation.
 */
export function deriveStatus(input: StatusInput, precomputedCounts?: StatusCounts): StatusModel {
  const repository = input.repository;
  const working = repository ? input.working : null;
  const workingError = repository ? input.workingError || null : null;
  const workingLoading = Boolean(repository && input.workingLoading);
  const stale = Boolean(working && (input.workingStale || workingError || workingLoading || input.opening));
  const counts = working && !repository?.bare ? precomputedCounts ?? countWorkingFiles(working.files) : null;
  const workingKind: StatusWorkingKind = !repository ? 'none' : repository.bare ? 'bare'
    : !working ? workingError ? 'error' : workingLoading ? 'loading' : 'unknown'
      : counts!.conflicts ? 'conflict' : counts!.changed ? 'changed' : 'clean';
  const branch = repository ? working ? working.branch : repository.branch : null;
  const head = repository ? working?.head !== undefined ? working.head : repository.head : null;
  const historyInput = input.history;
  const loaded = repository ? count(historyInput.loaded) : 0;
  const historyLoading = Boolean(repository && historyInput.loading);
  const historyError = repository ? historyInput.error || null : null;
  const historyStale = Boolean(repository && (historyInput.stale || historyError || (loaded > 0 && !historyInput.ready) || input.opening));
  const history: StatusHistory = {
    kind: !repository ? 'none' : historyInput.ready ? 'ready' : historyLoading ? 'loading' : historyError ? 'error' : 'unknown',
    loaded, visible: repository ? Math.min(loaded, count(historyInput.visible)) : 0,
    hasMore: Boolean(repository && historyInput.hasMore), loading: historyLoading, stale: historyStale, error: historyError,
  };
  const sessions = repository ? (input.sessions ?? []).filter(session => session.repoId === repository.id) : [];
  const external = sessions.find(session => session.status === 'paused')
    ?? sessions.find(session => session.status === 'running' || session.status === 'started');
  const result = input.result && (!input.result.repoId || input.result.repoId === repository?.id) ? input.result : null;
  const candidate = input.task;
  const task = candidate && (!candidate.repoId || candidate.repoId === repository?.id)
    && (repository || candidate.kind === 'discover' || candidate.kind === 'open') ? candidate : null;
  // Synthetic labels are deliberately empty; the view localizes these well-known kinds.
  const derivedTask = (kind: 'open' | 'history' | 'refresh'): StatusTask => ({
    id: `status:${repository?.id ?? ''}:${kind}`, label: '', kind,
    ...(repository ? { repoId: repository.id } : {}), ...(kind === 'history' ? { cancelScope: 'history' as const } : {}),
  });
  let activity: StatusActivity;
  if (task) activity = { kind: 'task', task, cancelScope: cancellation(task) };
  else if (input.opening) activity = { kind: 'task', task: derivedTask('open'), cancelScope: null };
  else if (external) activity = { kind: 'external', session: external };
  else if (historyLoading) activity = { kind: 'task', task: derivedTask('history'), cancelScope: 'history' };
  else if (workingLoading) activity = { kind: 'task', task: derivedTask('refresh'), cancelScope: null };
  else if (result) activity = { kind: 'result', result };
  else if (repository && input.compareBase) activity = { kind: 'compare', base: input.compareBase };
  else activity = { kind: 'idle', gitVersion: input.gitVersion || null };
  const runningSession = sessions.some(session => session.status === 'running' || session.status === 'started');
  return {
    state: input.initialized === false ? 'initializing' : input.opening ? 'opening' : repository ? 'ready' : 'empty',
    repository,
    context: {
      branch, head, headKind: branch ? head ? 'branch' : 'unborn' : head ? 'detached' : 'unknown',
      wsl: repository ? wslLocation(repository.path) : null, stale,
    },
    working: { kind: workingKind, counts, loading: workingLoading, stale, error: workingError, operation: working?.operation ?? null },
    tracking: tracking(working, repository, stale, branch), history,
    lastSuccessfulRefresh: repository ? timestamp(input.lastSuccessfulRefresh) : null,
    result, compareBase: repository ? input.compareBase || null : null, sessions, activity,
    taskState: activity.kind === 'task' || runningSession ? 'running' : external?.status === 'paused' ? 'paused' : 'idle',
  };
}

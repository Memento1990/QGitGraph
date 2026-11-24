import type { Host, RepositoryCandidate, RepositorySnapshot, RepositorySummary } from '../shared/protocol';
import { buildRepositoryTree, MAX_REPOSITORY_CANDIDATES } from './repositories';
import { countWorkingFiles } from './status';

export interface RepositorySummaryState {
  summary: RepositorySummary | null;
  loading: boolean;
  error: string | null;
  /** A previous observation, not an assertion about the current repository state. */
  stale: boolean;
}
export type RepositorySummaryMap = ReadonlyMap<string, RepositorySummaryState>;
export const REPOSITORY_SUMMARY_CONCURRENCY = 2;
export const REPOSITORY_SUMMARY_CACHE_LIMIT = 256;
export const MAX_VISIBLE_REPOSITORY_SUMMARIES = 64;

type SummaryHost = Pick<Host, 'probeRepository' | 'cancel'>;
interface ProbeTask {
  requestId: string;
  path: string;
  identity: string;
  generation: number;
  cancelled: boolean;
}
function identity(candidate: RepositoryCandidate): string {
  return JSON.stringify([candidate.path, candidate.marker, candidate.components]);
}
function errorText(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message || 'Repository summary failed.';
  return String(error) || 'Repository summary failed.';
}
function knownCount(value: number): number | null { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

/** Project only an already loaded, unfiltered active snapshot; this never opens or probes a repository. */
export function repositorySummaryFromSnapshot(snapshot: RepositorySnapshot): RepositorySummary {
  const { repository, working } = snapshot;
  const counts = repository.bare || !repository.trusted ? null : countWorkingFiles(working.files);
  const tracking = Boolean(counts && working.branch && working.upstream && working.trackingKnown === true);
  return {
    path: repository.path, branch: working.branch,
    head: working.head !== undefined ? working.head : repository.head,
    bare: repository.bare, trusted: repository.trusted,
    changes: counts?.changed ?? null, staged: counts?.staged ?? null,
    unstaged: counts?.unstaged ?? null, untracked: counts?.untracked ?? null,
    ahead: tracking ? knownCount(working.ahead) : null, behind: tracking ? knownCount(working.behind) : null,
    upstream: working.upstream ?? null,
  };
}

let schedulerId = 0;
/**
 * Visible-only, read-only probes. Cancellation invalidates results immediately but
 * retains the concurrency slot until the host settles, so even slow cancellation
 * cannot create an unbounded number of native processes. No openRepository fallback.
 */
export class RepositorySummaryScheduler {
  private readonly values = new Map<string, RepositorySummaryState>();
  private readonly candidates = new Map<string, RepositoryCandidate>();
  private readonly visible = new Set<string>();
  private readonly tasks = new Map<string, ProbeTask>();
  private readonly instanceId = ++schedulerId;
  private requestSequence = 0;
  private generation = 0;
  private mutationDepth = 0;
  private root: string | null = null;
  private candidateSignature = '';
  private destroyed = false;

  constructor(private readonly host: SummaryHost, private readonly onChange: (summaries: RepositorySummaryMap) => void) {}

  get summaries(): RepositorySummaryMap { return this.values; }

  setScope(root: string | null, candidates: readonly RepositoryCandidate[]): void {
    if (this.destroyed) return;
    const signature = JSON.stringify(candidates.slice(0, MAX_REPOSITORY_CANDIDATES).map(candidate => [candidate.path, candidate.marker, candidate.components]));
    const changedRoot = root !== this.root;
    if (!changedRoot && signature === this.candidateSignature) return;
    this.candidateSignature = signature;
    if (changedRoot) {
      this.generation++;
      for (const task of this.tasks.values()) this.cancelTask(task);
      this.values.clear(); this.visible.clear();
    }
    this.root = root;
    const previous = new Map(this.candidates);
    this.candidates.clear();
    if (root !== null) {
      const bounded = buildRepositoryTree(root, candidates);
      for (const node of bounded.nodes.values()) {
        if (node.candidate && !this.candidates.has(node.candidate.path) && this.candidates.size < REPOSITORY_SUMMARY_CACHE_LIMIT) {
          this.candidates.set(node.candidate.path, node.candidate);
        }
      }
    }
    let changed = changedRoot;
    for (const [path, old] of previous) {
      const current = this.candidates.get(path);
      if (current && identity(current) === identity(old)) continue;
      for (const task of this.tasks.values()) if (task.path === path) this.cancelTask(task);
      this.visible.delete(path); changed = this.values.delete(path) || changed;
    }
    if (changed) this.emit();
    this.pump();
  }

  setVisible(candidates: readonly RepositoryCandidate[]): void {
    if (this.destroyed) return;
    const next = new Set<string>();
    for (const candidate of candidates.slice(0, MAX_REPOSITORY_CANDIDATES)) {
      const current = this.candidates.get(candidate.path);
      if (current && identity(current) === identity(candidate)) next.add(candidate.path);
    }
    let changed = false;
    for (const path of this.visible) {
      if (next.has(path)) continue;
      const state = this.values.get(path);
      if (state?.summary && !state.stale) {
        this.values.set(path, { ...state, loading: false, stale: true }); changed = true;
      }
    }
    this.visible.clear(); next.forEach(path => this.visible.add(path));
    for (const task of this.tasks.values()) {
      if (!task.cancelled && !this.visible.has(task.path)) { this.cancelTask(task); changed = true; }
    }
    if (changed) this.emit();
    this.pump();
  }

  /** Invalidate only; offscreen paths are probed when they next become visible. */
  refresh(path?: string): void {
    if (this.destroyed) return;
    const paths = path === undefined ? [...this.visible] : this.candidates.has(path) ? [path] : [];
    this.mutationDepth++;
    for (const target of paths) {
      for (const task of this.tasks.values()) if (task.path === target) this.cancelTask(task);
      const previous = this.values.get(target)?.summary ?? null;
      this.values.set(target, { summary: previous, loading: false, error: null, stale: previous !== null });
    }
    try { if (paths.length) this.emit(); } finally { this.mutationDepth--; }
    this.pump();
  }

  /** Fresh current-repository snapshots win over in-flight summary observations. */
  override(summary: RepositorySummary): void {
    if (this.destroyed || !this.candidates.has(summary.path)) return;
    this.mutationDepth++;
    for (const task of this.tasks.values()) if (task.path === summary.path) this.cancelTask(task);
    this.values.set(summary.path, { summary, loading: false, error: null, stale: false });
    try { this.emit(); } finally { this.mutationDepth--; }
    this.pump();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.generation++;
    for (const task of this.tasks.values()) this.cancelTask(task);
    this.values.clear(); this.candidates.clear(); this.visible.clear();
  }

  private emit(): void { if (!this.destroyed) this.onChange(this.values); }

  private cancelTask(task: ProbeTask): void {
    if (task.cancelled) return;
    task.cancelled = true;
    // A cancelled old generation must not change the state of its replacement.
    if (this.current(task)) {
      const previous = this.values.get(task.path)?.summary ?? null;
      this.values.set(task.path, { summary: previous, loading: false, error: null, stale: previous !== null });
    }
    try { void this.host.cancel(task.requestId).catch(() => {}); } catch { /* Cancellation is best effort; identity remains invalidated. */ }
  }

  private current(task: ProbeTask): boolean {
    const candidate = this.candidates.get(task.path);
    return !this.destroyed && task.generation === this.generation && Boolean(candidate && identity(candidate) === task.identity);
  }

  private pump(): void {
    if (this.destroyed || this.mutationDepth || this.root === null || !this.host.probeRepository) return;
    for (const path of this.visible) {
      if (this.tasks.size >= REPOSITORY_SUMMARY_CONCURRENCY) return;
      const candidate = this.candidates.get(path), state = this.values.get(path);
      if (!candidate || state?.loading || state?.error || state?.summary && !state.stale) continue;
      // A cancelled request for this path may still hold a native process slot.
      if ([...this.tasks.values()].some(task => task.path === path)) continue;
      const task: ProbeTask = {
        path, identity: identity(candidate), generation: this.generation, cancelled: false,
        requestId: `repository-summary:${this.instanceId}:${++this.requestSequence}`,
      };
      this.tasks.set(task.requestId, task);
      const previous = state?.summary ?? null;
      this.values.set(path, { summary: previous, loading: true, error: null, stale: previous !== null });
      this.emit();
      // emit() may synchronously change the scope, visibility, or current snapshot.
      if (task.cancelled || !this.current(task)) { this.tasks.delete(task.requestId); continue; }
      const root = this.root;
      Promise.resolve().then(() => {
        if (task.cancelled || !this.current(task)) return null;
        return this.host.probeRepository!(candidate, root!, task.requestId);
      }).then(summary => {
        if (task.cancelled || !this.current(task)) return;
        if (!summary || summary.path !== path) throw new Error('Repository summary path does not match the requested candidate.');
        this.values.set(path, { summary, loading: false, error: null, stale: false });
        this.emit();
      }).catch(error => {
        if (task.cancelled || !this.current(task)) return;
        const previous = this.values.get(path)?.summary ?? null;
        this.values.set(path, { summary: previous, loading: false, error: errorText(error), stale: previous !== null });
        this.emit();
      }).finally(() => {
        this.tasks.delete(task.requestId);
        this.pump();
      });
    }
  }
}

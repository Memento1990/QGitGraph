import type { Commit } from '../shared/protocol';
import { CommitGraph, graphParents, projectHistory, workingGraphNode, type GraphCommit, type GraphRow } from './graph';

export interface HistoryLayoutInput {
  commits: readonly Commit[];
  /** A subset of commits, in history order. Only OIDs affect the projection. */
  visible: readonly Commit[];
  /** Change this when mutating topology in place (including graphParents/inHead). */
  topologyRevision: string | number;
  /** Undefined omits the working node; null represents an unborn HEAD. */
  workingHead?: string | null;
}
const sameStrings = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index]);
const sameTopology = (a: GraphCommit, b: GraphCommit): boolean => a.oid === b.oid
  && sameStrings(a.parents, b.parents) && sameStrings(graphParents(a), graphParents(b))
  && a.nodeKind === b.nodeKind && a.inHead === b.inHead;
function topology(commit: GraphCommit): GraphCommit {
  return { oid: commit.oid, parents: [...commit.parents], graphParents: [...graphParents(commit)], nodeKind: commit.nodeKind ?? 'commit', inHead: commit.inHead };
}

/** One-entry cache. UI selection, geometry and loading state are deliberately not inputs. */
export class HistoryLayoutCache {
  private graph = new CommitGraph();
  private rows: readonly GraphRow[] = [];
  private previous: GraphCommit[] = [];
  private key?: {
    commits: readonly Commit[]; count: number; revision: string | number;
    visible: readonly Commit[]; visibleCount: number; visibleOids: string[]; workingHead?: string | null;
  };
  preparePasses = 0;
  fullPasses = 0;
  appendPasses = 0;

  prepare(input: HistoryLayoutInput): readonly GraphRow[] {
    const { commits, visible, topologyRevision, workingHead } = input;
    const sameSource = this.key?.commits === commits && this.key.count === commits.length
      && Object.is(this.key.revision, topologyRevision) && this.key.workingHead === workingHead;
    if (sameSource && this.key!.visible === visible && this.key!.visibleCount === visible.length) return this.rows;
    const visibleOids = visible.map(commit => commit.oid);
    if (sameSource && sameStrings(this.key!.visibleOids, visibleOids)) {
      this.key!.visible = visible; this.key!.visibleCount = visible.length; return this.rows;
    }
    this.preparePasses++;
    const projected = visible.length === commits.length ? commits : projectHistory(commits, new Set(visibleOids));
    const next = [...(workingHead !== undefined ? [workingGraphNode(workingHead)] : []), ...projected].map(topology);
    // Re-project first: an appended hidden ancestor can change an earlier visible edge.
    const prefix = this.key !== undefined && next.length >= this.previous.length
      && this.previous.every((commit, index) => sameTopology(commit, next[index]));
    if (!prefix) {
      this.graph.reset(); this.rows = this.graph.append(next); this.fullPasses++;
    } else if (next.length > this.previous.length) {
      this.rows = [...this.rows, ...this.graph.append(next.slice(this.previous.length))]; this.appendPasses++;
    }
    this.previous = next;
    this.key = { commits, count: commits.length, revision: topologyRevision, visible, visibleCount: visible.length, visibleOids, workingHead };
    return this.rows;
  }

  /** Release the cached history; counters remain cumulative. */
  clear(): void { this.key = undefined; this.previous = []; this.rows = []; this.graph.reset(); }
}

export const RefreshFlags = { History: 1, Working: 2, Config: 4 } as const;
export interface CoalescedRefreshOptions {
  canRun?: () => boolean;
  onError?: (error: unknown) => void | Promise<void>;
}

/** A single active pass plus one bitmask of dirty work; no timers or framework state. */
export class CoalescedRefresh {
  private pending = 0;
  private active = false;
  private disposed = false;
  private waiters: (() => void)[] = [];
  constructor(private readonly run: (mask: number) => void | Promise<void>, private readonly options: CoalescedRefreshOptions = {}) {}
  get running(): boolean { return this.active; }
  get pendingMask(): number { return this.pending; }

  /** Fire-and-forget; use idle() to wait. Failed bits are reported, not automatically retried. */
  request(mask: number): void {
    if (this.disposed) return;
    this.pending |= mask & (RefreshFlags.History | RefreshFlags.Working | RefreshFlags.Config);
    this.resume();
  }
  /** Call when visibility/action blocking changes. Blocked dirty bits are retained. */
  resume(): void {
    if (this.disposed || this.active || !this.pending) return;
    this.active = true;
    void this.drain();
  }
  /** Drop pending work only. The current callback is never interrupted. */
  cancel(): void { this.pending = 0; }
  dispose(): void { this.disposed = true; this.cancel(); }

  /** Wait for quiescence: no active pass and no eligible pending work. Blocked work stays dirty.
   * Also attempts to resume eligible work. Errors are delivered only through onError. */
  idle(): Promise<void> {
    this.resume();
    return this.active ? new Promise(resolve => { this.waiters.push(resolve); }) : Promise.resolve();
  }
  private eligible(): boolean {
    try { return this.options.canRun?.() ?? true; }
    catch (error) { this.report(error); return false; }
  }
  private report(error: unknown): void {
    try { void Promise.resolve(this.options.onError?.(error)).catch(() => undefined); }
    catch { /* An error reporter must not break the queue or reject an ignored promise. */ }
  }
  private async drain(): Promise<void> {
    try {
      while (!this.disposed && this.pending && this.eligible()) {
        if (this.disposed || !this.pending) break;
        const mask = this.pending; this.pending = 0;
        try { await this.run(mask); }
        catch (error) { this.report(error); await Promise.resolve(); }
      }
    } finally {
      this.active = false;
      const waiters = this.waiters; this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

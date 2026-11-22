import type { Commit } from '../shared/protocol';

export type GraphCommit = Pick<Commit, 'oid' | 'parents'> & {
  graphParents?: string[]; nodeKind?: 'commit' | 'stash' | 'working'; inHead?: boolean;
};
export function graphParents(commit: GraphCommit): readonly string[] { return commit.graphParents ?? commit.parents; }
/** The working node points at the real HEAD, even if another branch appears first in date order. */
export function workingGraphNode(head: string | null): GraphCommit {
  return { oid: 'WORKTREE', parents: head ? [head] : [], nodeKind: 'working', inHead: true };
}

/** A lane is an expected ancestor, not a branch name. State is kept between pages. */
export interface GraphLane { oid: string; color: number }
export interface GraphEdge {
  from: number;
  to: number;
  color: number;
  start: 0 | 0.5;
  end: 0.5 | 1;
}
export interface GraphRow {
  oid: string;
  lane: number;
  color: number;
  merge: boolean;
  edges: GraphEdge[];
  width: number;
  nodeKind: 'commit' | 'stash' | 'working';
  inHead?: boolean;
}

export class CommitGraph {
  private lanes: GraphLane[] = [];
  private nextColor = 0;
  private seen = new Set<string>();
  width = 1;

  reset(): void {
    this.lanes = [];
    this.nextColor = 0;
    this.seen.clear();
    this.width = 1;
  }

  get continuation(): readonly GraphLane[] { return this.lanes; }

  append(commits: readonly GraphCommit[]): GraphRow[] {
    const rows: GraphRow[] = [];
    for (const commit of commits) {
      if (this.seen.has(commit.oid)) continue;
      this.seen.add(commit.oid);
      const before = this.lanes.slice();
      const incoming = before.findIndex(lane => lane.oid === commit.oid);
      const lane = incoming < 0 ? before.length : incoming;
      const color = incoming < 0 ? this.nextColor++ : before[incoming].color;
      const after = before.filter(item => item.oid !== commit.oid);
      const parents = [...new Set(graphParents(commit))].filter(oid => oid !== commit.oid && !this.seen.has(oid));
      let insertion = Math.min(lane, after.length);
      const existingParents = new Set(after.map(item => item.oid));
      for (let index = 0; index < parents.length; index++) {
        const oid = parents[index];
        if (existingParents.has(oid)) continue;
        after.splice(insertion, 0, { oid, color: index === 0 ? color : this.nextColor++ });
        existingParents.add(oid); insertion++;
      }
      const destinations = new Map(after.map((item, index) => [item.oid, index]));
      const edges: GraphEdge[] = [];
      before.forEach((item, index) => {
        if (item.oid === commit.oid) {
          edges.push({ from: index, to: lane, color: item.color, start: 0, end: 0.5 });
        } else {
          const destination = destinations.get(item.oid) ?? -1;
          if (destination >= 0) edges.push({ from: index, to: destination, color: item.color, start: 0, end: 1 });
        }
      });
      parents.forEach((oid, index) => {
        const destination = destinations.get(oid)!;
        edges.push({ from: lane, to: destination, color: index === 0 ? color : after[destination].color, start: 0.5, end: 1 });
      });
      const width = Math.max(before.length, after.length, lane + 1, 1);
      this.width = Math.max(this.width, width);
      rows.push({ oid: commit.oid, lane, color, merge: new Set(commit.parents).size > 1, edges, width, nodeKind: commit.nodeKind ?? 'commit', inHead: commit.inHead });
      this.lanes = after;
    }
    return rows;
  }
}

/** Connect visible commits through hidden ancestors, without inventing parentage. */
export function projectHistory(commits: readonly Commit[], visible: ReadonlySet<string>): Commit[] {
  const index = new Map(commits.map(commit => [commit.oid, commit]));
  const memo = new Map<string, string[]>();
  function nearest(start: string): string[] {
    if (memo.has(start)) return memo.get(start)!;
    const stack: { oid: string; expanded: boolean }[] = [{ oid: start, expanded: false }];
    const visiting = new Set<string>();
    while (stack.length) {
      const frame = stack[stack.length - 1];
      if (memo.has(frame.oid)) { stack.pop(); continue; }
      const commit = index.get(frame.oid);
      if (visible.has(frame.oid) || !commit) { memo.set(frame.oid, [frame.oid]); stack.pop(); continue; }
      if (!frame.expanded) {
        frame.expanded = true; visiting.add(frame.oid);
        for (const parent of [...graphParents(commit)].reverse()) {
          if (!memo.has(parent) && !visiting.has(parent)) stack.push({ oid: parent, expanded: false });
        }
      } else {
        memo.set(frame.oid, [...new Set(graphParents(commit).flatMap(parent => memo.get(parent) ?? []))]);
        visiting.delete(frame.oid); stack.pop();
      }
    }
    return memo.get(start) ?? [];
  }
  return commits.filter(commit => visible.has(commit.oid)).map(commit => {
    const parents = [...new Set(graphParents(commit).flatMap(nearest))].filter(parent => parent !== commit.oid);
    // Keep semantic parentage whenever the host supplied an explicit graph projection.
    return commit.graphParents ? { ...commit, graphParents: parents } : { ...commit, parents };
  });
}

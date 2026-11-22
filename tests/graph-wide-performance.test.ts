import { describe, expect, it } from 'vitest';
import type { Commit } from '../src/shared/protocol';
import { CommitGraph } from '../src/lib/graph';

const commit = (oid: string, parents: string[] = []): Commit => ({ oid, parents, subject: oid, author: '', email: '', authoredAt: 0, committedAt: 0, refs: [] });

describe('wide commit graph indexed edge destinations', () => {
  it('retains exact lane/color edges for a broad octopus merge across page boundaries', () => {
    const parents = Array.from({ length: 180 }, (_, index) => `topic-${index}`);
    const history = [commit('octopus', [...parents, parents[0]]), ...parents.slice().reverse().map(oid => commit(oid, ['shared'])), commit('shared')];
    const full = new CommitGraph().append(history);
    expect(full[0].edges.filter(edge => edge.start === 0.5).map(edge => edge.to)).toEqual(parents.map((_, index) => index));
    expect(full[0].width).toBe(parents.length);
    for (const split of [1, 20, 90, history.length - 1]) {
      const paged = new CommitGraph();
      expect([...paged.append(history.slice(0, split)), ...paged.append(history.slice(split))]).toEqual(full);
      expect(paged.continuation).toEqual([]);
    }
    for (const row of full) for (const edge of row.edges) {
      expect(edge.to).toBeGreaterThanOrEqual(0); expect(edge.to).toBeLessThan(row.width);
    }
  });
  it('maps untouched lane edges by identity while nearby branch lanes are inserted and removed', () => {
    const history = [commit('root-merge', ['one', 'two', 'three']), commit('three', ['next', 'side']), commit('one', ['shared']), commit('side', ['shared']), commit('two', ['shared']), commit('next', ['shared']), commit('shared')];
    const rows = new CommitGraph().append(history);
    expect(rows[1].lane).toBe(2);
    expect(rows[1].edges.filter(edge => edge.start === 0).map(edge => [edge.from, edge.to, edge.end])).toEqual([[0, 0, 1], [1, 1, 1], [2, 2, 0.5]]);
    expect(rows[1].edges.filter(edge => edge.start === 0.5).map(edge => edge.to)).toEqual([2, 3]);
    const paged = new CommitGraph();
    expect([...paged.append(history.slice(0, 2)), ...paged.append(history.slice(2))]).toEqual(rows);
  });
});

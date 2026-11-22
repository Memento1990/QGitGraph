import { describe, expect, it } from 'vitest';
import { CommitGraph, projectHistory } from '../src/lib/graph';
import type { Commit } from '../src/shared/protocol';

function commit(oid: string, parents: string[] = []): Commit {
  return { oid, parents, author: 'A', email: 'a@example.test', authoredAt: 1, committedAt: 1, subject: oid, refs: [] };
}

describe('independent commit lane layout', () => {
  it('keeps a linear ancestry in a single lane', () => {
    const graph = new CommitGraph();
    const rows = graph.append([commit('a', ['b']), commit('b', ['c']), commit('c')]);
    expect(rows.map(row => row.lane)).toEqual([0, 0, 0]);
    expect(rows.map(row => row.width)).toEqual([1, 1, 1]);
    expect(graph.continuation).toEqual([]);
  });
  it('splits merge parents and rejoins a shared ancestor', () => {
    const graph = new CommitGraph();
    const rows = graph.append([commit('merge', ['main', 'topic']), commit('topic', ['base']), commit('main', ['base']), commit('base')]);
    expect(rows[0].merge).toBe(true);
    expect(rows[0].edges.filter(edge => edge.start === 0.5).map(edge => edge.to)).toEqual([0, 1]);
    expect(rows[1].lane).toBe(1);
    expect(rows[2].lane).toBe(0);
    expect(rows[2].edges.some(edge => edge.start === 0.5 && edge.from === 0 && edge.to === 0)).toBe(true);
    expect(rows[3].lane).toBe(0);
    expect(graph.continuation).toEqual([]);
  });
  it('preserves lane positions and colours across arbitrary page boundaries', () => {
    const history = [commit('m', ['a', 'b']), commit('b', ['d']), commit('a', ['c']), commit('c', ['d']), commit('d', ['e']), commit('e')];
    const full = new CommitGraph().append(history);
    for (let split = 1; split < history.length; split++) {
      const graph = new CommitGraph();
      expect([...graph.append(history.slice(0, split)), ...graph.append(history.slice(split))]).toEqual(full);
    }
  });
  it('handles octopus merges and duplicate parents without duplicate lanes', () => {
    const graph = new CommitGraph();
    const row = graph.append([commit('m', ['a', 'b', 'c', 'a'])])[0];
    expect(row.edges.filter(edge => edge.start === 0.5)).toHaveLength(3);
    expect(graph.continuation.map(lane => lane.oid)).toEqual(['a', 'b', 'c']);
  });
  it('does not shift lanes when duplicate commits appear at a page boundary', () => {
    const graph = new CommitGraph(); graph.append([commit('a', ['b'])]);
    expect(graph.append([commit('a', ['b']), commit('b')])).toHaveLength(1);
    graph.reset();
    expect(graph.append([commit('x')])[0].color).toBe(0);
  });
  it('connects filtered history through hidden ancestors without false edges', () => {
    const history = [commit('m', ['a', 'b']), commit('a', ['c']), commit('b', ['c']), commit('c', ['d']), commit('d')];
    const result = projectHistory(history, new Set(['m', 'c', 'd']));
    expect(result.map(item => [item.oid, item.parents])).toEqual([['m', ['c']], ['c', ['d']], ['d', []]]);
    expect(history[0].parents).toEqual(['a', 'b']);
  });
  it('projects a long hidden chain without recursion or disconnecting it', () => {
    const history = Array.from({ length: 6000 }, (_, index) => commit(String(index), index < 5999 ? [String(index + 1)] : []));
    expect(projectHistory(history, new Set(['0', '5999']))[0].parents).toEqual(['5999']);
  });
});

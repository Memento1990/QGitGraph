import { describe, expect, it } from 'vitest';
import type { Commit, DiffQuery, GitRef } from '../src/shared/protocol';
import { cacheableDiff, diffCacheKey, immutableSelection } from '../src/lib/diff';
import { CommitGraph, projectHistory, workingGraphNode } from '../src/lib/graph';
import { commitDate, formatDate, isImmutableOid, LruCache, matchingRefs, matchesCommit, scopeLabel } from '../src/lib/format';
import { branchNeighbours, matchesShortcut, RowLayout } from '../src/ui/navigation';

const oid = (character: string): string => character.repeat(40);
const commit = (id: string, parents: string[] = [], extra: Partial<Commit> = {}): Commit => ({ oid: id, parents, subject: id, author: 'Author', email: 'author@example.test', authoredAt: 1, committedAt: 2, refs: [], ...extra });
const ref = (name: string, id: string): GitRef => ({ name, oid: id, fullName: `refs/heads/${name}`, kind: 'branch', current: false, upstream: null, subject: '' });
const stroke = (key: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });

describe('desktop parity graph metadata', () => {
  it('uses graphParents for lane topology while retaining real merge parent metadata', () => {
    const item = commit(oid('a'), [oid('b'), oid('c')], { graphParents: [oid('b')], nodeKind: 'stash', inHead: false });
    const row = new CommitGraph().append([item])[0];
    expect(row.merge).toBe(true); expect(row.nodeKind).toBe('stash'); expect(row.inHead).toBe(false);
    expect(row.edges.filter(edge => edge.start === 0.5)).toHaveLength(1);
    expect(item.parents).toEqual([oid('b'), oid('c')]);
  });
  it('connects the virtual working node to actual HEAD, not the newest unrelated ref', () => {
    const history = [workingGraphNode(oid('b')), commit(oid('a')), commit(oid('b'))];
    const rows = new CommitGraph().append(history);
    expect(history[0].parents).toEqual([oid('b')]); expect(rows[0].nodeKind).toBe('working');
    expect(rows[1].lane).not.toBe(rows[0].lane); expect(rows[2].lane).toBe(rows[0].lane);
    expect(workingGraphNode(null).parents).toEqual([]);
  });
  it('projects supplied graph ancestry without rewriting original parents', () => {
    const history = [commit('a', ['real'], { graphParents: ['b'] }), commit('b', ['ignored'], { graphParents: ['c'] }), commit('c')];
    const visible = projectHistory(history, new Set(['a', 'c']));
    expect(visible[0].graphParents).toEqual(['c']); expect(visible[0].parents).toEqual(['real']);
  });
});

describe('inline virtual list geometry', () => {
  it('inserts real height after the selected row and maps subsequent rows consistently', () => {
    const layout = new RowLayout(20, 28, 4, 360);
    expect(layout.slotTop).toBe(140); expect(layout.top(4)).toBe(112); expect(layout.top(5)).toBe(500);
    expect(layout.totalHeight).toBe(920); expect(layout.indexAt(139)).toBe(4); expect(layout.indexAt(300)).toBe(4); expect(layout.indexAt(500)).toBe(5);
    for (let index = 0; index < 20; index++) expect(layout.indexAt(layout.top(index) + 1)).toBe(index);
  });
  it('inserts before the first row at boundary zero and shares round-trip row positions', () => {
    const layout = new RowLayout(8, 28, 0, 320, 'before');
    expect(layout.slotBoundary).toBe(0); expect(layout.slotTop).toBe(0); expect(layout.totalHeight).toBe(544);
    expect(layout.top(0)).toBe(320); expect(layout.top(1)).toBe(348); expect(layout.indexAt(150)).toBe(0); expect(layout.indexAt(320)).toBe(0);
    for (let index = 0; index < 8; index++) expect(layout.indexAt(layout.top(index) + 14)).toBe(index);
  });
  it('places before/after at the same insertion boundary and removes the slot from pure-list coordinates', () => {
    const after = new RowLayout(100, 28, 19, 600, 'after'), before = new RowLayout(100, 28, 20, 600, 'before');
    expect(after.slotBoundary).toBe(before.slotBoundary); expect(after.slotTop).toBe(560);
    for (let index = 0; index < 100; index++) expect(after.top(index)).toBe(before.top(index));
    expect(after.plainScrollTop(100, 400)).toBe(100); expect(after.plainScrollTop(800, 400)).toBe(560); expect(after.plainScrollTop(1400, 400)).toBe(800);
    expect(after.visibleRange(1200, 400)).toEqual(before.visibleRange(1200, 400));
    expect(new RowLayout(0, 28).visibleRange(0, 400)).toEqual({ first: 0, last: 0 });
  });
  it('handles absent / filtered selections, empty lists and trailing slots', () => {
    expect(new RowLayout(0, 28, 0, 300).indexAt(0)).toBe(-1);
    const regular = new RowLayout(10, 28, -1, 300); expect(regular.totalHeight).toBe(280); expect(regular.top(5)).toBe(140);
    const tail = new RowLayout(2, 28, 1, 360); expect(tail.totalHeight).toBe(416); expect(tail.indexAt(415)).toBe(1); expect(tail.indexAt(999)).toBe(1);
  });
});

describe('immutable review and byte-bounded cache', () => {
  it('rejects mutable refs, abbreviations and working/index comparisons', () => {
    expect(isImmutableOid(oid('a'))).toBe(true); expect(isImmutableOid('b'.repeat(64))).toBe(true);
    for (const token of ['HEAD', 'INDEX', 'WORKTREE', 'abcdef12', 'refs/heads/main', '']) expect(isImmutableOid(token)).toBe(false);
    expect(immutableSelection({ kind: 'commit', oid: oid('a') })).toBe(true);
    expect(immutableSelection({ kind: 'compare', base: oid('a'), target: oid('b') })).toBe(true);
    expect(immutableSelection({ kind: 'compare', base: 'HEAD', target: oid('b') })).toBe(false);
    expect(immutableSelection({ kind: 'commit', oid: oid('a'), parent: 'HEAD' })).toBe(false);
    expect(cacheableDiff({ base: null, target: oid('a') })).toBe(true); expect(cacheableDiff({ base: 'HEAD', target: oid('a') })).toBe(false);
  });
  it('evicts least recently used data by both bytes and entries, and skips oversized values', () => {
    const cache = new LruCache<string>(10, 20, value => value.length);
    cache.set('a', '123456'); cache.set('b', '123456'); expect(cache.bytes).toBe(16); cache.get('a'); cache.set('c', '123456');
    expect(cache.get('b')).toBeUndefined(); expect(cache.get('a')).toBe('123456'); expect(cache.bytes).toBeLessThanOrEqual(20);
    cache.set('a', 'x'.repeat(30)); expect(cache.get('a')).toBeUndefined(); expect(cache.size).toBe(1);
    cache.clear(); expect(cache.bytes).toBe(0); expect(cache.size).toBe(0);
  });
  it('keys diffs by content semantics rather than request id', () => {
    const query: DiffQuery = { repoId: 'r', requestId: 'one', base: oid('a'), target: oid('b'), path: 'src/a.ts' };
    expect(diffCacheKey(query)).toBe(diffCacheKey({ ...query, requestId: 'two' }));
    expect(diffCacheKey(query)).not.toBe(diffCacheKey({ ...query, encoding: 'windows-1252' }));
    expect(diffCacheKey(query)).not.toBe(diffCacheKey({ ...query, oldPath: 'src/old.ts' }));
  });
});

describe('range, dates and desktop navigation', () => {
  it('retains all matching refs with deterministic deduplication', () => {
    const refs = [ref('feature/one', 'a'), ref('feature/two', 'b'), ref('main', 'c'), ref('feature/one', 'a')];
    expect(matchingRefs(refs, 'FEATURE')).toEqual(['refs/heads/feature/one', 'refs/heads/feature/two']);
    expect(matchingRefs(refs, 'missing')).toEqual([]); expect(scopeLabel({ kind: 'refs', refs: ['a', 'b'] })).toBe('2 selected refs');
  });
  it('honours committer dates and both date-only formats without throwing on invalid data', () => {
    const authoredAt = Date.parse('2026-01-02T12:00:00Z') / 1000, committedAt = Date.parse('2026-01-03T12:00:00Z') / 1000;
    const item = commit('a', [], { authoredAt, committedAt });
    expect(commitDate(item, 'committer')).toBe(committedAt); expect(formatDate(committedAt, 'iso-date')).toBe('2026-01-03'); expect(formatDate(committedAt, 'date')).not.toContain(':');
    expect(matchesCommit(item, { text: '2026-01-03', mode: 'date', dateSource: 'committer' })).toBe(true);
    expect(matchesCommit({ ...item, authoredAt: NaN }, { text: 'missing', mode: 'date' })).toBe(false);
  });
  it('parses portable shortcuts and does not steal mismatched modifier chords', () => {
    expect(matchesShortcut(stroke('h', { ctrlKey: true }), 'Ctrl+H')).toBe(true);
    expect(matchesShortcut(stroke('h', { metaKey: true }), 'Ctrl+H')).toBe(true);
    expect(matchesShortcut(stroke('h', { ctrlKey: true, shiftKey: true }), 'Ctrl+H')).toBe(false);
    expect(matchesShortcut(stroke('ArrowDown', { ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+ArrowDown')).toBe(true);
    expect(matchesShortcut(stroke('F5'), 'F5')).toBe(true); expect(matchesShortcut(stroke('h', { altKey: true }), 'Ctrl+H')).toBe(false);
  });
  it('follows true first-parent and alternate-parent branch relations rather than adjacent rows', () => {
    const history = [commit('merge', ['main', 'topic']), commit('other', ['base']), commit('topic', ['base']), commit('main', ['base']), commit('base')];
    expect(branchNeighbours(history, 'merge', 'parent')).toEqual(['main']); expect(branchNeighbours(history, 'merge', 'parent', true)).toEqual(['topic']);
    expect(branchNeighbours(history, 'topic', 'child')).toEqual([]); expect(branchNeighbours(history, 'topic', 'child', true)).toEqual(['merge']);
    expect(branchNeighbours(history, 'base', 'child')).toEqual(['other', 'topic', 'main']);
  });
});

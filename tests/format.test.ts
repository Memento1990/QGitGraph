import { describe, expect, it } from 'vitest';
import { dateValue, errorMessage, formatDate, LruCache, matchesCommit, shortOid } from '../src/lib/format';
import type { Commit } from '../src/shared/protocol';

const commit: Commit = { oid: 'a123bc9876543210', parents: [], author: 'Alice Example', email: 'alice@example.test', authoredAt: Date.parse('2026-01-02T12:00:00Z') / 1000, committedAt: Date.parse('2026-01-03T12:00:00Z') / 1000, subject: 'Fix search result stability #48', refs: [{ name: 'feature/search', fullName: 'refs/heads/feature/search', oid: 'a123bc9876543210', kind: 'branch', upstream: null, current: false, subject: '' }] };

describe('format and commit filtering', () => {
  it('accepts Git seconds and JS milliseconds', () => {
    expect(dateValue(commit.authoredAt).getTime()).toBe(dateValue(commit.authoredAt * 1000).getTime());
    expect(formatDate(commit.authoredAt, 'iso')).toBe('2026-01-02 12:00:00');
    expect(shortOid(commit.oid)).toBe('a123bc98');
    expect(formatDate(NaN, 'iso')).toBe('—');
  });
  it('uses authored dates, email, full hashes, messages and refs by mode', () => {
    expect(matchesCommit(commit, { text: 'EXAMPLE.TEST', mode: 'author' })).toBe(true);
    expect(matchesCommit(commit, { text: 'a123bc9', mode: 'hash' })).toBe(true);
    expect(matchesCommit(commit, { text: 'stability', mode: 'message' })).toBe(true);
    expect(matchesCommit(commit, { text: 'refs/heads', mode: 'refs' })).toBe(true);
    expect(matchesCommit(commit, { text: '2026-01-02', mode: 'date' })).toBe(true);
    expect(matchesCommit(commit, { text: '2026-01-03', mode: 'date' })).toBe(false);
    expect(matchesCommit(commit, { text: 'feature/search', mode: 'all' })).toBe(true);
    expect(matchesCommit(commit, { text: 'Alice', mode: 'message' })).toBe(false);
  });
  it('combines advanced filters with inclusive date boundaries', () => {
    expect(matchesCommit(commit, { text: '#48', mode: 'all', author: 'Alice', hash: 'a123', refs: 'search', after: '2026-01-02', before: '2026-01-02' })).toBe(true);
    expect(matchesCommit(commit, { text: '', mode: 'all', before: '2026-01-01' })).toBe(false);
    expect(matchesCommit(commit, { text: '', mode: 'all', after: '2026-01-03' })).toBe(false);
  });
  it('formats structured backend errors and limits LRU cache entries', () => {
    expect(errorMessage({ message: 'Git failed', detail: 'Conflict' })).toBe('Git failed\nConflict');
    expect(errorMessage(new Error('Failure'))).toBe('Failure');
    const cache = new LruCache<number>(2); cache.set('a', 1); cache.set('b', 2); expect(cache.get('a')).toBe(1); cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined(); expect(cache.get('a')).toBe(1); cache.clear(); expect(cache.get('a')).toBeUndefined();
  });
});

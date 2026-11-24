import { describe, expect, it, vi } from 'vitest';
import type { RepositoryCandidate, RepositorySnapshot, RepositorySummary } from '../src/shared/protocol';
import { RepositorySummaryScheduler, repositorySummaryFromSnapshot, type RepositorySummaryMap } from '../src/lib/repository-summaries';

function candidate(name: string, path = `/scope/${name}`): RepositoryCandidate { return { path, components: [name], marker: 'git-directory' }; }
function summary(path: string, patch: Partial<RepositorySummary> = {}): RepositorySummary {
  return { path, branch: 'main', head: '123456789', bare: false, trusted: true,
    changes: 0, staged: 0, unstaged: 0, untracked: 0, ahead: null, behind: null, upstream: null, ...patch };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
function setup() {
  const calls: { candidate: RepositoryCandidate; root: string; id: string; result: ReturnType<typeof deferred<RepositorySummary>> }[] = [];
  const host = {
    probeRepository: vi.fn((candidate: RepositoryCandidate, root: string, id: string) => {
      const result = deferred<RepositorySummary>(); calls.push({ candidate, root, id, result }); return result.promise;
    }),
    cancel: vi.fn(async (_id: string) => {}),
    openRepository: vi.fn(),
  };
  const change = vi.fn((_value: RepositorySummaryMap) => {});
  const scheduler = new RepositorySummaryScheduler(host, change);
  return { scheduler, host, calls, change };
}

describe('read-only repository summary scheduling', () => {
  it('probes visible candidates only with two native slots, no activation, and preserves measured zero vs unknown', async () => {
    const { scheduler, calls, host } = setup();
    const candidates = ['a', 'b', 'c', 'offscreen'].map(name => candidate(name));
    scheduler.setScope('/scope', candidates); await settle(); expect(host.probeRepository).not.toHaveBeenCalled();
    scheduler.setVisible(candidates.slice(0, 3)); await settle();
    expect(calls).toHaveLength(2); expect(calls.map(call => call.candidate.path)).toEqual(['/scope/a', '/scope/b']);
    expect(scheduler.summaries.get('/scope/a')).toEqual({ summary: null, loading: true, error: null, stale: false });
    calls[0].result.resolve(summary('/scope/a')); await settle();
    expect(calls).toHaveLength(3); expect(calls[2].candidate.path).toBe('/scope/c');
    expect(scheduler.summaries.get('/scope/a')?.summary?.changes).toBe(0);
    expect(scheduler.summaries.get('/scope/a')?.summary?.ahead).toBeNull();
    expect(scheduler.summaries.has('/scope/offscreen')).toBe(false); expect(host.openRepository).not.toHaveBeenCalled();
    scheduler.destroy();
  });

  it('cancels offscreen probes, does not overfill native slots while cancellation is pending, and ignores late results', async () => {
    const { scheduler, calls, host } = setup();
    const candidates = ['a', 'b', 'c', 'd'].map(name => candidate(name));
    scheduler.setScope('/scope', candidates); scheduler.setVisible(candidates.slice(0, 2)); await settle();
    scheduler.setVisible(candidates.slice(2)); await settle();
    expect(host.cancel.mock.calls.map(call => call[0])).toEqual([calls[0].id, calls[1].id]);
    expect(calls).toHaveLength(2); expect(scheduler.summaries.get('/scope/a')?.loading).toBe(false);
    calls[0].result.resolve(summary('/scope/a', { branch: 'obsolete' })); await settle();
    expect(calls).toHaveLength(3); expect(calls[2].candidate.path).toBe('/scope/c');
    expect(scheduler.summaries.get('/scope/a')?.summary).toBeNull();
    calls[1].result.reject(new Error('cancelled')); await settle(); expect(calls).toHaveLength(4);
    expect(scheduler.summaries.get('/scope/b')?.error).toBeNull();
    scheduler.destroy();
  });

  it('marks observations stale offscreen and refreshes them only when they become visible again', async () => {
    const { scheduler, calls } = setup(); const current = candidate('a');
    scheduler.setScope('/scope', [current]); scheduler.setVisible([current]); await settle();
    calls[0].result.resolve(summary(current.path)); await settle();
    scheduler.setVisible([]); await settle(); expect(calls).toHaveLength(1);
    expect(scheduler.summaries.get(current.path)).toMatchObject({ loading: false, stale: true, summary: { changes: 0 } });
    scheduler.setVisible([current]); await settle(); expect(calls).toHaveLength(2);
    expect(scheduler.summaries.get(current.path)).toMatchObject({ loading: true, stale: true }); scheduler.destroy();
  });

  it('invalidates scope and candidate generations without accepting matching-path stale results', async () => {
    const { scheduler, calls, host } = setup();
    const original = candidate('a', '/same/native/path');
    scheduler.setScope('/scope', [original]); scheduler.setVisible([original]); await settle();
    const replacement = { ...original, marker: 'git-file' as const };
    scheduler.setScope('/scope', [replacement]); scheduler.setVisible([replacement]);
    calls[0].result.resolve(summary(original.path, { branch: 'old-marker' })); await settle();
    expect(calls).toHaveLength(2); expect(calls[1].candidate.marker).toBe('git-file');
    expect(scheduler.summaries.get(original.path)?.summary).toBeNull();
    scheduler.setScope('/another-root', [replacement]); scheduler.setVisible([replacement]);
    calls[1].result.resolve(summary(original.path, { branch: 'old-root' })); await settle();
    expect(calls).toHaveLength(3); expect(calls[2].root).toBe('/another-root');
    calls[2].result.resolve(summary(original.path, { branch: 'current' })); await settle();
    expect(scheduler.summaries.get(original.path)?.summary?.branch).toBe('current');
    expect(host.cancel).toHaveBeenCalledTimes(2); scheduler.destroy();
  });

  it('keeps previous observations visibly stale on errors, retries only on refresh, and validates returned native path', async () => {
    const { scheduler, calls } = setup(); const current = candidate('a');
    scheduler.setScope('/scope', [current]); scheduler.setVisible([current]); await settle();
    calls[0].result.resolve(summary(current.path, { changes: 3 })); await settle();
    scheduler.refresh(current.path); await settle();
    expect(scheduler.summaries.get(current.path)).toMatchObject({ loading: true, stale: true, summary: { changes: 3 } });
    calls[1].result.reject({ message: 'Original <native> error' }); await settle();
    expect(scheduler.summaries.get(current.path)).toMatchObject({ loading: false, stale: true, error: 'Original <native> error', summary: { changes: 3 } });
    scheduler.setVisible([current]); await settle(); expect(calls).toHaveLength(2);
    scheduler.refresh(current.path); await settle();
    calls[2].result.resolve(summary('/wrong/path')); await settle();
    expect(scheduler.summaries.get(current.path)?.error).toContain('does not match');
    expect(scheduler.summaries.get(current.path)?.summary?.changes).toBe(3); scheduler.destroy();
  });

  it('lets active snapshot overrides win over probes and invalidates only when explicitly refreshed', async () => {
    const { scheduler, calls, host } = setup(); const current = candidate('a');
    scheduler.setScope('/scope', [current]); scheduler.setVisible([current]); await settle();
    scheduler.override(summary(current.path, { branch: 'snapshot', changes: 1 }));
    expect(host.cancel).toHaveBeenCalledWith(calls[0].id);
    calls[0].result.resolve(summary(current.path, { branch: 'obsolete-probe', changes: 0 })); await settle();
    expect(scheduler.summaries.get(current.path)).toMatchObject({ summary: { branch: 'snapshot', changes: 1 }, loading: false, stale: false });
    scheduler.setVisible([current]); await settle(); expect(calls).toHaveLength(1);
    scheduler.refresh(current.path); await settle(); expect(calls).toHaveLength(2); scheduler.destroy();
  });

  it('fastpaths same candidate identities in new arrays and safely tolerates synchronous render callbacks', async () => {
    const host = { probeRepository: vi.fn(async (item: RepositoryCandidate) => summary(item.path)), cancel: vi.fn(async () => {}) };
    const item = candidate('a'); let notifications = 0;
    const scheduler = new RepositorySummaryScheduler(host, () => {
      notifications++;
      scheduler.setScope('/scope', [{ ...item, components: [...item.components] }]);
    });
    scheduler.setScope('/scope', [item]);
    scheduler.setScope('/scope', [{ ...item }]); expect(notifications).toBe(1);
    scheduler.setVisible([item]); await settle();
    expect(host.probeRepository).toHaveBeenCalledTimes(1); expect(notifications).toBe(3);
    scheduler.override(summary(item.path, { changes: 2 })); expect(notifications).toBe(4); scheduler.destroy();
  });

  it('respects an override made synchronously by the loading callback before any probe can start', async () => {
    const item = candidate('a');
    const host = { probeRepository: vi.fn(async () => summary(item.path, { branch: 'probe' })), cancel: vi.fn(async () => {}) };
    const scheduler = new RepositorySummaryScheduler(host, values => {
      if (values.get(item.path)?.loading) scheduler.override(summary(item.path, { branch: 'current-snapshot' }));
    });
    scheduler.setScope('/scope', [item]); scheduler.setVisible([item]); await settle();
    expect(host.probeRepository).not.toHaveBeenCalled();
    expect(scheduler.summaries.get(item.path)?.summary?.branch).toBe('current-snapshot'); scheduler.destroy();
  });

  it('bounds candidate/cache input to 256 and rejects off-scope and changed candidate identities', async () => {
    const { scheduler, host } = setup();
    const candidates = Array.from({ length: 400 }, (_, index) => candidate(`r${index}`));
    scheduler.setScope('/scope', candidates);
    candidates.forEach(item => scheduler.override(summary(item.path)));
    expect(scheduler.summaries.size).toBe(256); expect(scheduler.summaries.has('/scope/r399')).toBe(false);
    scheduler.setVisible([{ ...candidates[0], components: ['different'] }, candidate('outside')]); await settle();
    expect(host.probeRepository).not.toHaveBeenCalled();
    scheduler.setScope('/scope', candidates.slice(0, 1)); expect(scheduler.summaries.size).toBe(1);
    scheduler.setScope(null, []); expect(scheduler.summaries.size).toBe(0); scheduler.destroy();
  });

  it('does not use openRepository when the host cannot probe, and destroy blocks pending notifications', async () => {
    const change = vi.fn(), openRepository = vi.fn();
    const scheduler = new RepositorySummaryScheduler({ cancel: vi.fn(async () => {}), ...{ openRepository } }, change);
    const item = candidate('a'); scheduler.setScope('/scope', [item]); scheduler.setVisible([item]); await settle();
    expect(openRepository).not.toHaveBeenCalled(); expect(scheduler.summaries.size).toBe(0); scheduler.destroy();
    const pending = setup(); pending.scheduler.setScope('/scope', [item]); pending.scheduler.setVisible([item]); await settle();
    pending.scheduler.destroy(); const notifications = pending.change.mock.calls.length;
    pending.calls[0].result.resolve(summary(item.path)); await settle();
    expect(pending.change).toHaveBeenCalledTimes(notifications); expect(pending.scheduler.summaries.size).toBe(0);
  });
});

describe('already active snapshot summary projection', () => {
  function snapshot(): RepositorySnapshot {
    return {
      repository: { id: 'id', path: '/native', name: 'name', gitDir: '/native/.git', commonDir: '/native/.git',
        branch: 'old', head: 'old-head', trusted: true, bare: false },
      working: { branch: null, head: 'detached-head', ahead: 0, behind: 2, upstream: 'origin/main', trackingKnown: true,
        operation: null, conflicts: 0, files: [
          { path: 'a', oldPath: null, status: 'MM', staged: true, unstaged: true, additions: null, deletions: null },
          { path: 'a', oldPath: null, status: ' M', staged: false, unstaged: true, additions: null, deletions: null },
          { path: 'b', oldPath: null, status: '??', staged: false, unstaged: true, additions: null, deletions: null },
          { path: 'ignored', oldPath: null, status: '!!', staged: false, unstaged: true, additions: null, deletions: null },
        ] },
      refs: [], stashes: [], remotes: [], fingerprint: 'fingerprint',
    };
  }
  it('counts distinct changed paths and overlapping categories honestly and uses working detached HEAD', () => {
    expect(repositorySummaryFromSnapshot(snapshot())).toEqual({
      path: '/native', branch: null, head: 'detached-head', trusted: true, bare: false,
      changes: 2, staged: 1, unstaged: 1, untracked: 1, ahead: null, behind: null, upstream: 'origin/main',
    });
    const active = snapshot(); active.working.branch = 'main';
    expect(repositorySummaryFromSnapshot(active)).toMatchObject({ ahead: 0, behind: 2 });
    active.working.trackingKnown = false; expect(repositorySummaryFromSnapshot(active)).toMatchObject({ ahead: null, behind: null });
  });
  it('does not fabricate working counts for bare or untrusted repositories', () => {
    const bare = snapshot(); bare.repository.bare = true;
    expect(repositorySummaryFromSnapshot(bare)).toMatchObject({ changes: null, staged: null, unstaged: null, untracked: null });
    bare.repository.bare = false; bare.repository.trusted = false;
    expect(repositorySummaryFromSnapshot(bare)).toMatchObject({ changes: null, staged: null, unstaged: null, untracked: null });
  });
});

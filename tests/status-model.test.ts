import { describe, expect, it, vi } from 'vitest';
import { countWorkingFiles, deriveStatus, isStatusConflict, wslLocation, type StatusInput } from '../src/lib/status';
import type { ChangedFile, ExternalSession, Repository, WorkingState } from '../src/shared/protocol';
import { localized } from '../src/lib/i18n';

const repository: Repository = {
  id: 'active', name: 'project', path: 'D:/project', gitDir: 'D:/project/.git', commonDir: 'D:/project/.git',
  head: 'a'.repeat(40), branch: 'main', trusted: false, bare: false,
};
function file(path: string, status: string, staged = false, unstaged = false, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status, staged, unstaged, oldPath: null, additions: null, deletions: null, ...extra };
}
function working(extra: Partial<WorkingState> = {}): WorkingState {
  return { files: [], branch: 'main', head: repository.head, upstream: null, trackingKnown: false, ahead: 0, behind: 0, operation: null, conflicts: 0, ...extra };
}
function input(extra: Partial<StatusInput> = {}): StatusInput {
  return { repository, working: working(), history: { loaded: 300, visible: 84, hasMore: true, loading: false, ready: true }, ...extra };
}
const session = (id: string, repoId: string, status: ExternalSession['status']): ExternalSession => ({
  id, repoId, status, kind: 'rebase', exitCode: null, operation: 'rebase', message: 'raw tool output',
});

describe('raw working status counts', () => {
  it('counts distinct paths and allows staged/tracked-unstaged overlap without including untracked or conflicts', () => {
    const files = [
      file('both', 'MM', true, true), file('index', 'A.', true), file('worktree', '.M', false, true),
      file('new', '?', false, true), file('new-v1', '??', true, true),
      ...['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].map(status => file(`conflict-${status}`, status, true, true)),
      file('renamed', 'R.', true, false, { oldPath: 'original' }),
      file('both', '.M', false, true), file('ignored', '!', false, true),
    ];
    expect(countWorkingFiles(files)).toEqual({ changed: 13, staged: 3, unstaged: 2, untracked: 2, conflicts: 7 });
    expect(files[0].status).toBe('MM');
  });

  it('recognizes all standard unmerged XY including AA/DD and deduplicates conflict paths', () => {
    for (const status of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU', 'U']) expect(isStatusConflict(status)).toBe(true);
    for (const status of ['A.', '.D', 'MM', 'D.', '?', '??']) expect(isStatusConflict(status)).toBe(false);
    expect(countWorkingFiles([file('same', 'MM', true, true), file('same', 'AA', true, true)]))
      .toEqual({ changed: 1, staged: 0, unstaged: 0, untracked: 0, conflicts: 1 });
  });

  it('keeps dirty submodules as tracked unstaged, not top-level untracked files', () => {
    const counts = countWorkingFiles([file('module', '.M', false, false, { submodule: { commitChanged: false, modified: false, untracked: true } })]);
    expect(counts).toEqual({ changed: 1, staged: 0, unstaged: 1, untracked: 0, conflicts: 0 });
  });
});

describe('truthful status readiness and freshness', () => {
  it('can use explicitly supplied counts without reading files, but stays uncached by default', () => {
    let status = '.M';
    const statusRead = vi.fn(() => status);
    const changed = file('mutable', '.M', false, true), files = [changed], state = input({ working: working({ files }) });
    Object.defineProperty(changed, 'status', { configurable: true, get: statusRead });
    const counts = countWorkingFiles(files), reads = statusRead.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    expect(deriveStatus(state, counts).working.counts).toBe(counts);
    expect(statusRead).toHaveBeenCalledTimes(reads);
    expect(deriveStatus(input({ repository: null }), counts).working.counts).toBeNull();
    expect(deriveStatus(input({ repository: { ...repository, bare: true } }), counts).working.counts).toBeNull();
    status = 'AA'; changed.staged = true;
    expect(deriveStatus(state).working).toMatchObject({ kind: 'conflict', counts: { changed: 1, staged: 0, unstaged: 0, conflicts: 1 } });
    expect(statusRead.mock.calls.length).toBeGreaterThan(reads);
    files.push(file('untracked', '?', false, true));
    expect(deriveStatus(state).working.counts).toEqual({ changed: 2, staged: 0, unstaged: 0, untracked: 1, conflicts: 1 });
    expect(countWorkingFiles(files)).toEqual({ changed: 2, staged: 0, unstaged: 0, untracked: 1, conflicts: 1 });
  });

  it('never turns missing working data, a bare repository, or no repository into clean', () => {
    expect(deriveStatus(input({ working: null })).working).toMatchObject({ kind: 'unknown', counts: null });
    expect(deriveStatus(input({ working: null, workingLoading: true })).working.kind).toBe('loading');
    expect(deriveStatus(input({ working: null, workingError: 'permission denied' })).working.kind).toBe('error');
    expect(deriveStatus(input({ repository: { ...repository, bare: true } })).working).toMatchObject({ kind: 'bare', counts: null });
    const closed = deriveStatus(input({ repository: null, workingLoading: true, workingError: 'old error', lastSuccessfulRefresh: 1 }));
    expect(closed.state).toBe('empty'); expect(closed.working).toMatchObject({ kind: 'none', counts: null, loading: false, error: null });
    expect(closed.lastSuccessfulRefresh).toBeNull(); expect(closed.history.kind).toBe('none');
  });

  it('shows actual clean only with a snapshot and explicitly marks retained data as stale on load/failure/dirty', () => {
    const fresh = deriveStatus(input({ lastSuccessfulRefresh: 1_700_000_000_000 }));
    expect(fresh.working).toMatchObject({ kind: 'clean', stale: false });
    expect(fresh.lastSuccessfulRefresh).toBe(1_700_000_000_000);
    for (const extra of [{ workingLoading: true }, { workingStale: true }, { workingError: 'status failed' }, { opening: true }]) {
      const model = deriveStatus(input(extra));
      expect(model.working.kind).toBe('clean'); expect(model.working.stale).toBe(true); expect(model.context.stale).toBe(true);
    }
    expect(deriveStatus(input()).lastSuccessfulRefresh).toBeNull();
    expect(deriveStatus(input({ lastSuccessfulRefresh: NaN })).lastSuccessfulRefresh).toBeNull();
  });

  it('uses raw paths rather than summary conflicts or visibility/filter counts', () => {
    const model = deriveStatus(input({ working: working({ files: [file('conflict', 'AA', true, true), file('hidden-untracked', '?', false, true)], conflicts: 0 }), history: { loaded: 10, visible: 0, ready: true, hasMore: true, loading: false } }));
    expect(model.working.kind).toBe('conflict');
    expect(model.working.counts).toEqual({ changed: 2, staged: 0, unstaged: 0, untracked: 1, conflicts: 1 });
    expect(model.history).toMatchObject({ kind: 'ready', loaded: 10, visible: 0, hasMore: true });
    expect(deriveStatus(input({ working: working({ conflicts: 99 }) })).working.kind).toBe('clean');
  });

  it('keeps branch, detached and unborn identities grounded in the current snapshot', () => {
    const detached = deriveStatus(input({ working: working({ branch: null, head: 'b'.repeat(40) }) }));
    expect(detached.context).toMatchObject({ branch: null, head: 'b'.repeat(40), headKind: 'detached' });
    const unborn = deriveStatus(input({ working: working({ branch: 'new', head: null }) }));
    expect(unborn.context).toMatchObject({ branch: 'new', head: null, headKind: 'unborn' });
    expect(deriveStatus(input({ repository: { ...repository, head: null, branch: null }, working: null })).context.headKind).toBe('unknown');
  });

  it('does not fabricate full history totals or readiness from loaded-page counts', () => {
    const model = deriveStatus(input({ history: { loaded: 300, visible: 35, hasMore: true, loading: true, ready: false } }));
    expect(model.history).toMatchObject({ kind: 'loading', loaded: 300, visible: 35, hasMore: true, stale: true });
    const failed = deriveStatus(input({ history: { loaded: 300, visible: 300, hasMore: true, loading: false, ready: true, error: 'load more failed' } }));
    expect(failed.history).toMatchObject({ kind: 'ready', stale: true, error: 'load more failed' });
    const empty = deriveStatus(input({ history: { loaded: 0, visible: 0, hasMore: false, loading: false, ready: true } }));
    expect(empty.history).toMatchObject({ kind: 'ready', loaded: 0, visible: 0 });
    expect(deriveStatus(input({ history: { loaded: 2, visible: 9, hasMore: false, loading: false, ready: true } })).history.visible).toBe(2);
  });
});

describe('upstream counts are observations, not sync guesses', () => {
  it('distinguishes unknown legacy fields, no upstream, and a named upstream without known counts', () => {
    expect(deriveStatus(input({ working: working({ upstream: undefined, trackingKnown: undefined }) })).tracking.kind).toBe('unknown');
    expect(deriveStatus(input()).tracking).toMatchObject({ kind: 'no-upstream', ahead: null, behind: null });
    expect(deriveStatus(input({ working: working({ upstream: 'origin/main', trackingKnown: false, ahead: 12, behind: 4 }) })).tracking)
      .toMatchObject({ kind: 'upstream', upstream: 'origin/main', ahead: null, behind: null });
  });

  it('only exposes ahead/behind when explicitly measured for a real upstream, including known zero', () => {
    expect(deriveStatus(input({ working: working({ upstream: 'origin/main', trackingKnown: true }) })).tracking)
      .toMatchObject({ kind: 'counts', upstream: 'origin/main', ahead: 0, behind: 0 });
    const stale = deriveStatus(input({ working: working({ upstream: 'origin/main', trackingKnown: true, ahead: 12, behind: 3 }), workingError: 'offline' }));
    expect(stale.tracking).toMatchObject({ kind: 'counts', ahead: 12, behind: 3, stale: true });
    expect(deriveStatus(input({ working: working({ upstream: null, trackingKnown: true }) })).tracking.kind).toBe('no-upstream');
    expect(deriveStatus(input({ working: working({ upstream: 'origin/main', trackingKnown: true, ahead: NaN }) })).tracking.kind).toBe('upstream');
    expect(deriveStatus(input({ repository: { ...repository, bare: true }, working: working({ upstream: 'origin/main', trackingKnown: true }) })).tracking.kind).toBe('unknown');
    expect(deriveStatus(input({ working: working({ branch: null, upstream: 'origin/main', trackingKnown: true }) })).tracking.kind).toBe('not-applicable');
  });
});

describe('WSL is a recognized UNC location only', () => {
  it('accepts named distributions on both documented WSL share hosts, case-insensitively', () => {
    expect(wslLocation('\\\\wsl.localhost\\Ubuntu\\home\\example\\repo')).toEqual({ host: 'wsl.localhost', distribution: 'Ubuntu' });
    expect(wslLocation('\\\\WSL$\\Debian\\repo')).toEqual({ host: 'wsl$', distribution: 'Debian' });
    expect(wslLocation('//wsl.localhost/Ubuntu')).toEqual({ host: 'wsl.localhost', distribution: 'Ubuntu' });
    expect(wslLocation('\\\\?\\UNC\\wsl.localhost\\Ubuntu\\repo')).toEqual({ host: 'wsl.localhost', distribution: 'Ubuntu' });
  });
  it('does not label Windows paths, normal UNC hosts, Linux paths, URLs or hostnames without a distribution as WSL', () => {
    for (const path of ['D:/wsl/Ubuntu/repo', '/home/me/repo', '\\\\server\\wsl$\\repo', '//wsl.localhost/', '//wsl$/', '//wsl.localhost.evil/Ubuntu/repo', 'https://wsl.localhost/Ubuntu/repo', '//wsl.localhost/../repo']) expect(wslLocation(path)).toBeNull();
  });
});

describe('activity is scoped and cancellation has a real target', () => {
  it('retains localizable labels without resolving user data and validates cancel scope', () => {
    const label = localized(locale => locale === 'en' ? 'Fetching…' : '正在获取…');
    const model = deriveStatus(input({ task: { id: 'write-1', label, kind: 'write', repoId: repository.id, cancelScope: 'write' } }));
    expect(model.activity).toMatchObject({ kind: 'task', cancelScope: 'write', task: { label } });
    expect(model.taskState).toBe('running');
    expect(deriveStatus(input({ task: { id: 'refresh', label: 'refresh', kind: 'refresh', cancelScope: 'write' } })).activity).toMatchObject({ cancelScope: null });
    expect(deriveStatus(input({ task: { id: 'write', label: 'fetch', kind: 'write', cancelScope: 'history' } })).activity).toMatchObject({ cancelScope: null });
  });

  it('never leaks another repository task, result, comparison or external session into the active footer', () => {
    const model = deriveStatus(input({ task: { id: 'old', label: 'old write', repoId: 'old', kind: 'write', cancelScope: 'write' }, result: { id: 'old-result', message: 'old failed', kind: 'error', repoId: 'old' }, sessions: [session('old', 'old', 'paused')] }));
    expect(model.activity.kind).toBe('idle'); expect(model.sessions).toEqual([]); expect(model.result).toBeNull();
    const closed = deriveStatus(input({ repository: null, compareBase: 'abc', sessions: [session('active', repository.id, 'running')], task: { id: 'old', label: 'write', kind: 'write' } }));
    expect(closed.activity.kind).toBe('idle'); expect(closed.taskState).toBe('idle'); expect(closed.compareBase).toBeNull();
  });

  it('shows external running/paused work without a generic process-cancel control', () => {
    const running = deriveStatus(input({ sessions: [session('terminal', repository.id, 'running')], history: { loaded: 0, visible: 0, loading: true, ready: false, hasMore: true } }));
    expect(running.activity).toMatchObject({ kind: 'external', session: { id: 'terminal', status: 'running' } }); expect(running.taskState).toBe('running');
    const paused = deriveStatus(input({ sessions: [session('terminal', repository.id, 'paused')] }));
    expect(paused.activity.kind).toBe('external'); expect(paused.taskState).toBe('paused'); expect('cancelScope' in paused.activity).toBe(false);
  });

  it('derives history-only cancellation and refresh/open activity without pretending they are write processes', () => {
    expect(deriveStatus(input({ history: { loaded: 12, visible: 12, hasMore: true, loading: true, ready: true } })).activity)
      .toMatchObject({ kind: 'task', cancelScope: 'history', task: { kind: 'history' } });
    expect(deriveStatus(input({ workingLoading: true })).activity).toMatchObject({ kind: 'task', cancelScope: null, task: { kind: 'refresh' } });
    expect(deriveStatus(input({ repository: null, opening: true })).activity).toMatchObject({ kind: 'task', cancelScope: null, task: { kind: 'open' } });
    expect(deriveStatus(input({ repository: null, task: { id: 'discover', label: 'Finding…', kind: 'discover' } })).activity.kind).toBe('task');
    expect(deriveStatus(input({ result: { id: 'result', kind: 'success', message: 'Fetched', repoId: repository.id } })).activity.kind).toBe('result');
    expect(deriveStatus(input({ compareBase: 'abc' })).activity).toEqual({ kind: 'compare', base: 'abc' });
    expect(deriveStatus(input({ repository: null, initialized: false })).state).toBe('initializing');
  });
});

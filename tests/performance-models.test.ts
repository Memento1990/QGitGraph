import { describe, expect, it, vi } from 'vitest';
import { CommitGraph, projectHistory, workingGraphNode } from '../src/lib/graph';
import { CoalescedRefresh, HistoryLayoutCache, RefreshFlags, type HistoryLayoutInput } from '../src/lib/performance-models';
import type { Commit, GitRef } from '../src/shared/protocol';

const commit = (oid: string, parents: string[] = [], extra: Partial<Commit> = {}): Commit => ({
  oid, parents, author: 'Author', email: 'a@example.test', subject: oid, authoredAt: 1, committedAt: 2, refs: [], ...extra,
});
const history = (): Commit[] => [
  commit('m', ['a', 'b']), commit('b', ['d']), commit('a', ['c']), commit('c', ['d']), commit('d', ['e']), commit('e'),
];
function original(input: HistoryLayoutInput) {
  const projected = input.visible.length === input.commits.length ? input.commits
    : projectHistory(input.commits, new Set(input.visible.map(item => item.oid)));
  return new CommitGraph().append([...(input.workingHead !== undefined ? [workingGraphNode(input.workingHead)] : []), ...projected]);
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('HistoryLayoutCache', () => {
  it('reuses rows without reading commit OIDs for selection, geometry, busy or working-file changes', () => {
    let reads = 0;
    const commits = new Proxy(history(), { get: (target, key, receiver) => {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    } });
    const cache = new HistoryLayoutCache();
    const input = { commits, visible: commits, topologyRevision: 0, workingHead: 'a' };
    const view = { selected: 'm', rowHeight: 28, busy: false, files: ['one'] };
    const render = () => ({ ...view, rows: cache.prepare(input) });
    const rows = render().rows; reads = 0;
    view.selected = 'a'; view.rowHeight = 36; view.busy = true; view.files = ['two'];
    expect(render().rows).toBe(rows); expect(render().selected).toBe('a');
    expect(reads).toBe(0); expect(cache.preparePasses).toBe(1); expect(cache.fullPasses).toBe(1);
    expect(cache.prepare({ ...input, visible: [...commits] })).toBe(rows);
    expect(cache.preparePasses).toBe(1);
  });

  it('appends unchanged topology without replacing earlier row objects', () => {
    const commits = history(), cache = new HistoryLayoutCache();
    const first = commits.slice(0, 3);
    const rows = cache.prepare({ commits: first, visible: first, topologyRevision: 0, workingHead: 'a' });
    const input = { commits, visible: commits, topologyRevision: 1, workingHead: 'a' };
    const appended = cache.prepare(input);
    expect(appended).toEqual(original(input));
    rows.forEach((row, index) => { expect(appended[index]).toBe(row); });
    expect(cache.fullPasses).toBe(1); expect(cache.appendPasses).toBe(1);
  });

  it('matches the original graph across all page boundaries, filters, working HEADs and graphParents', () => {
    const supplied = history();
    supplied[0] = commit('m', ['real', 'other'], { graphParents: ['a', 'b'], inHead: true });
    supplied[1] = commit('b', ['ignored'], { graphParents: ['d'], nodeKind: 'stash', inHead: false });
    for (const all of [history(), supplied]) for (const workingHead of [undefined, null, 'a']) {
      for (const visibleIds of [null, new Set(['m', 'd', 'e']), new Set(['b', 'c']), new Set<string>()]) {
        const cache = new HistoryLayoutCache();
        for (let count = 1; count <= all.length; count++) {
          const commits = all.slice(0, count);
          const visible = visibleIds ? commits.filter(item => visibleIds.has(item.oid)) : commits;
          const input = { commits, visible, topologyRevision: count, workingHead };
          expect(cache.prepare(input)).toEqual(original(input));
        }
      }
    }
  });

  it('rebuilds if a newly loaded hidden ancestor changes an earlier projected edge', () => {
    const commits = [commit('a', ['hidden']), commit('hidden', ['base']), commit('base')];
    const cache = new HistoryLayoutCache(), first = commits.slice(0, 1);
    const rows = cache.prepare({ commits: first, visible: first, topologyRevision: 0 });
    const input = { commits, visible: [commits[0], commits[2]], topologyRevision: 1 };
    expect(cache.prepare(input)).toEqual(original(input));
    expect(cache.prepare(input)[0]).not.toBe(rows[0]);
    expect(cache.fullPasses).toBe(2); expect(cache.appendPasses).toBe(0);
  });

  it('retains row identity for ref-only replacement arrays and equivalent visibility arrays', () => {
    const commits = history(), cache = new HistoryLayoutCache();
    const rows = cache.prepare({ commits, visible: commits, topologyRevision: 1 });
    const ref: GitRef = { name: 'main', fullName: 'refs/heads/main', oid: 'm', kind: 'branch', current: true, upstream: null, subject: '' };
    const relabeled = commits.map(item => ({ ...item, refs: item.oid === 'm' ? [ref] : [] }));
    expect(cache.prepare({ commits: relabeled, visible: [...relabeled], topologyRevision: 1 })).toBe(rows);
    expect(cache.preparePasses).toBe(2); expect(cache.fullPasses).toBe(1); expect(cache.appendPasses).toBe(0);
    const input = { commits: relabeled, visible: relabeled.filter(item => item.oid !== 'a'), topologyRevision: 1 };
    expect(cache.prepare(input)).toEqual(original(input));
    expect(cache.prepare(input)).not.toBe(rows);
  });

  it('snapshots parents and rebuilds for in-place topology changes when the revision advances', () => {
    const commits = [commit('m', ['a', 'b'], { graphParents: ['a'] }), commit('a', ['b']), commit('b')];
    const cache = new HistoryLayoutCache();
    const input = { commits, visible: commits, topologyRevision: 0 };
    cache.prepare(input);
    const mutations = [
      () => { commits[0].graphParents![0] = 'b'; },
      () => { commits[0].parents.splice(1, 1); },
      () => { commits[0].nodeKind = 'stash'; },
      () => { commits[0].inHead = true; },
      () => { commits.reverse(); },
    ];
    for (const mutate of mutations) {
      mutate(); input.topologyRevision++;
      expect(cache.prepare(input)).toEqual(original(input));
    }
    expect(cache.fullPasses).toBe(6);
  });

  it('handles in-place page append, working-node changes, truncation and explicit clear', () => {
    const commits = history().slice(0, 2), cache = new HistoryLayoutCache();
    const input: HistoryLayoutInput = { commits, visible: commits, topologyRevision: 0 };
    cache.prepare(input); commits.push(...history().slice(2));
    expect(cache.prepare(input)).toEqual(original(input)); expect(cache.appendPasses).toBe(1);
    for (const workingHead of [null, 'a', 'b', undefined]) {
      input.workingHead = workingHead;
      expect(cache.prepare(input)).toEqual(original(input));
    }
    commits.splice(2);
    const rows = cache.prepare(input); expect(rows).toEqual(original(input));
    cache.clear(); expect(cache.prepare(input)).toEqual(rows); expect(cache.prepare(input)).not.toBe(rows);
  });
});

describe('CoalescedRefresh', () => {
  const { History, Working, Config } = RefreshFlags;

  it('merges repeated dirty requests into one pending pass without overlapping active callbacks', async () => {
    const gates = [deferred(), deferred()], replayStarted = deferred(), calls: number[] = [];
    let active = 0, maxActive = 0;
    const queue = new CoalescedRefresh(async mask => {
      const index = calls.length; calls.push(mask); active++; maxActive = Math.max(maxActive, active);
      if (index === 1) replayStarted.resolve();
      try { await gates[index].promise; } finally { active--; }
    });
    queue.request(History);
    for (const mask of [Working, Working, Config, History, Config]) queue.request(mask);
    expect(calls).toEqual([History]); expect(queue.pendingMask).toBe(History | Working | Config);
    let idle = false; const waiting = queue.idle().then(() => { idle = true; });
    gates[0].resolve(); await replayStarted.promise;
    expect(calls).toEqual([History, History | Working | Config]); expect(idle).toBe(false);
    gates[1].resolve(); await waiting;
    expect(maxActive).toBe(1); expect(queue.running).toBe(false); expect(queue.pendingMask).toBe(0);
  });

  it('keeps blocked bits dirty, resolves blocked idle, and checks eligibility again before replay', async () => {
    let hidden = true, actionBusy = false;
    const gate = deferred(), run = vi.fn((_mask: number) => gate.promise);
    const queue = new CoalescedRefresh(run, { canRun: () => !hidden && !actionBusy });
    queue.request(History); queue.request(Working);
    await queue.idle(); expect(run).not.toHaveBeenCalled(); expect(queue.pendingMask).toBe(History | Working);
    hidden = false; queue.resume(); expect(run).toHaveBeenCalledWith(History | Working);
    actionBusy = true; queue.request(Config); gate.resolve(); await queue.idle();
    expect(run).toHaveBeenCalledTimes(1); expect(queue.pendingMask).toBe(Config); expect(queue.running).toBe(false);
    actionBusy = false; queue.resume(); await queue.idle();
    expect(run.mock.calls.map(([mask]) => mask)).toEqual([History | Working, Config]);
  });

  it.each(['throw', 'reject'] as const)('recovers from a callback %s and a failing error reporter without rejecting idle', async mode => {
    const failure = new Error('refresh failed'), calls: number[] = [], errors: unknown[] = [];
    const queue = new CoalescedRefresh(mask => {
      calls.push(mask);
      if (calls.length === 1) {
        if (mode === 'throw') throw failure;
        return Promise.reject(failure);
      }
    }, { onError: error => {
      errors.push(error);
      if (mode === 'throw') throw new Error('reporter failed');
      return Promise.reject(new Error('reporter failed'));
    } });
    queue.request(History); queue.request(Working); await queue.idle();
    expect(errors).toEqual([failure]); expect(calls).toEqual([History, Working]);
    queue.request(Config); await queue.idle(); expect(calls).toEqual([History, Working, Config]);
    expect(queue.running).toBe(false);
  });

  it('replays work requested reentrantly from the callback', async () => {
    const calls: number[] = []; let active = 0, maxActive = 0;
    const queue = new CoalescedRefresh(mask => {
      active++; maxActive = Math.max(maxActive, active); calls.push(mask);
      if (mask === History) queue.request(Working | Config);
      active--;
    });
    queue.request(History); await queue.idle();
    expect(calls).toEqual([History, Working | Config]); expect(maxActive).toBe(1);
  });

  it('cancels pending work without interrupting the active callback or disabling later requests', async () => {
    const gate = deferred(), calls: number[] = [];
    const queue = new CoalescedRefresh(mask => { calls.push(mask); return calls.length === 1 ? gate.promise : undefined; });
    queue.request(History); queue.request(Working); queue.cancel();
    expect(queue.running).toBe(true); expect(queue.pendingMask).toBe(0);
    queue.request(Config); gate.resolve(); await queue.idle();
    expect(calls).toEqual([History, Config]);
  });

  it('disposes pending and future work while allowing the current callback to settle', async () => {
    const gate = deferred(), run = vi.fn(() => gate.promise), queue = new CoalescedRefresh(run);
    queue.request(History); queue.request(Working); queue.dispose(); queue.dispose();
    queue.request(Config); queue.resume(); expect(queue.pendingMask).toBe(0);
    let settled = false; const waiting = queue.idle().then(() => { settled = true; });
    await Promise.resolve(); expect(settled).toBe(false); expect(queue.running).toBe(true);
    gate.reject(new Error('current callback failed after disposal')); await waiting;
    queue.request(History); queue.resume(); await queue.idle();
    expect(run).toHaveBeenCalledTimes(1); expect(queue.running).toBe(false);
  });

  it('retains dirty work when the eligibility callback throws and ignores unsupported bits', async () => {
    let broken = true;
    const failure = new Error('eligibility failed'), run = vi.fn(), errors = vi.fn();
    const queue = new CoalescedRefresh(run, { canRun: () => { if (broken) throw failure; return true; }, onError: errors });
    queue.request(8); await queue.idle(); expect(run).not.toHaveBeenCalled();
    queue.request(History); await queue.idle();
    expect(errors).toHaveBeenCalledWith(failure); expect(queue.pendingMask).toBe(History); expect(queue.running).toBe(false);
    broken = false; await queue.idle(); expect(run).toHaveBeenCalledWith(History);
  });
});

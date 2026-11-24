import { describe, expect, it, vi } from 'vitest';
import { createDiffController, historicalDiffShortcut, type DiffOpen } from '../src/controllers/diff';
import type { DiffQuery, DiffResult, Host, Repository } from '../src/shared/protocol';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40);
const repo = (id = 'a'): Repository => ({ id, path: `/test/${id}`, name: id, gitDir: '', commonDir: '', head: b, branch: 'main', trusted: true, bare: false });
const patch = '@@ -1,3 +1,3 @@\n same\n-old\n+new\n tail\n';
const result = (extra: Partial<DiffResult> = {}): DiffResult => ({ patch, binary: false, truncated: false, oldContent: null, newContent: null, ...extra });
const query = (extra: Partial<DiffOpen> = {}): DiffOpen => ({ base: a, target: b, path: 'src/a.ts', historical: true, ...extra });
function host(overrides: Partial<Host> = {}): Host {
  return { cancel: vi.fn(async () => {}), diffPatch: vi.fn(async () => result()), diff: vi.fn(async () => result()), fileContent: vi.fn(async (_query: DiffQuery, side: 'old' | 'new') => result({ patch: '', [side === 'old' ? 'oldContent' : 'newContent']: side === 'old' ? 'same\nold\ntail\n' : 'same\nnew\ntail\n' })), ...overrides } as unknown as Host;
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

describe('Vue diff controller real read lifecycle', () => {
  it('uses patch-first with bound IDs and lazily loads only the selected full side', async () => {
    const source = host(), controller = createDiffController(source); controller.setRepository(repo(), 7);
    await controller.open(query({ oldPath: 'old/a.ts', group: 'history' }));
    expect(source.diffPatch).toHaveBeenCalledOnce(); expect(source.diff).not.toHaveBeenCalled(); expect(source.fileContent).not.toHaveBeenCalled();
    const first = vi.mocked(source.diffPatch!).mock.calls[0][0];
    expect(first).toMatchObject({ repoId: 'a', base: a, target: b, path: 'src/a.ts', oldPath: 'old/a.ts', context: 3 }); expect(first.requestId).not.toBe('');
    expect(controller.state.status).toBe('ready'); expect(controller.state.rows.document?.changes).toHaveLength(1);
    await controller.setMode('new');
    expect(source.fileContent).toHaveBeenCalledOnce(); expect(vi.mocked(source.fileContent!).mock.calls[0][1]).toBe('new');
    expect(controller.state.rows.lines.map(row => row.left)).toEqual(['same', 'new', 'tail']);
    expect(vi.mocked(source.fileContent!).mock.calls[0][0].requestId).not.toBe(first.requestId);
    controller.dispose();
  });

  it('discards out-of-order patch and content after repo/generation/path/group/base changes', async () => {
    const one = deferred<DiffResult>(), two = deferred<DiffResult>(), side = deferred<DiffResult>();
    const source = host({ diffPatch: vi.fn().mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise).mockResolvedValue(result()), fileContent: vi.fn(() => side.promise) });
    const controller = createDiffController(source); controller.setRepository(repo(), 1);
    const pendingOne = controller.open(query()), pendingTwo = controller.open(query({ base: c, path: 'b.ts', group: 'compare' }));
    two.resolve(result({ patch: '@@ -1 +1 @@\n-second\n+current\n' })); await pendingTwo;
    one.resolve(result({ patch: '@@ -1 +1 @@\n-stale\n+wrong\n' })); await pendingOne;
    expect(controller.state.result?.patch).toContain('current'); expect(controller.cacheInfo.patches).toBe(1);
    const pendingSide = controller.setMode('old');
    controller.setRepository(repo('b'), 2); await controller.open(query({ path: 'other.ts' }));
    side.resolve(result({ oldContent: 'stale content' })); await pendingSide;
    expect(controller.state.repository?.id).toBe('b'); expect(controller.state.sides.old.data).toBeNull(); expect(controller.cacheInfo.contents).toBe(0);
    controller.setRepository(repo('b'), 3); expect(controller.state.status).toBe('idle'); expect(controller.state.rows.lines).toEqual([]);
    expect(source.cancel).toHaveBeenCalled(); controller.dispose();
  });

  it('bounds immutable LRU and does not cache mutable refs, staged data or failed results', async () => {
    const source = host(), controller = createDiffController(source, { maxPatches: 2, maxContents: 2 }); controller.setRepository(repo(), 1);
    await controller.open(query()); await controller.open(query({ path: 'b.ts' })); await controller.open(query({ path: 'c.ts' }));
    expect(controller.cacheInfo.patches).toBe(2); await controller.open(query()); expect(source.diffPatch).toHaveBeenCalledTimes(4);
    await controller.open(query({ target: 'HEAD', path: 'mutable.ts' })); controller.clear(); await controller.open(query({ target: 'HEAD', path: 'mutable.ts' }));
    expect(source.diffPatch).toHaveBeenCalledTimes(6); expect(controller.cacheInfo.patches).toBe(2);
    controller.setRepository(repo(), 2);
    await controller.open(query({ staged: true })); controller.clear(); await controller.open(query({ staged: true }));
    expect(controller.cacheInfo.patches).toBe(0);
    vi.mocked(source.diffPatch!).mockResolvedValue(result({ binary: true })); controller.clear(); await controller.open(query()); expect(controller.state.status).toBe('binary'); expect(controller.state.rows.lines).toEqual([]); expect(controller.cacheInfo.patches).toBe(0);
    vi.mocked(source.diffPatch!).mockResolvedValue(result({ truncated: true })); controller.clear(); await controller.open(query()); expect(controller.state.status).toBe('truncated'); expect(controller.cacheInfo.patches).toBe(0);
    controller.dispose();
  });

  it('respects byte budgets and does not retain oversized immutable patches', async () => {
    const source = host({ diffPatch: vi.fn(async () => result({ patch: patch.repeat(200) })) });
    const controller = createDiffController(source, { byteLimit: 1024 }); controller.setRepository(repo(), 1); await controller.open(query());
    expect(controller.state.status).toBe('ready'); expect(controller.cacheInfo.patches).toBe(0); controller.dispose();
  });

  it('expands only validated real equal context and never creates body text for binary/truncated/missing content', async () => {
    const source = host(), controller = createDiffController(source); controller.setRepository(repo(), 1); await controller.open(query());
    await controller.setShowUnchanged(true);
    expect(source.fileContent).toHaveBeenCalledTimes(2);
    expect(controller.state.rows.lines.filter(row => row.kind === 'context').map(row => row.left)).toEqual(['same', 'tail']);
    await controller.setMode('split'); expect(controller.state.rows.lines.some(row => row.left === 'same' && row.right === 'same')).toBe(true);
    controller.setRepository(repo(), 2); vi.mocked(source.fileContent!).mockResolvedValue(result({ binary: true, oldContent: 'fake', newContent: 'fake' }));
    await controller.open(query()); await controller.setMode('old'); expect(controller.state.sides.old.status).toBe('binary'); expect(controller.state.rows.lines).toEqual([]);
    vi.mocked(source.fileContent!).mockResolvedValue(result({ truncated: true, oldContent: 'partial', newContent: 'partial' })); await controller.ensureContent('new'); await controller.setMode('new'); expect(controller.state.rows.lines).toEqual([]);
    vi.mocked(source.fileContent!).mockResolvedValue(result()); await controller.ensureContent('new'); expect(controller.state.sides.new.status).toBe('blocked'); expect(controller.state.rows.lines).toEqual([]);
    controller.dispose();
  });

  it('reports unavailable capability, cancellation and errors without replacing them with a successful empty diff', async () => {
    const source = host({ diffPatch: undefined, diff: undefined, fileContent: undefined }), onError = vi.fn();
    const controller = createDiffController(source, { onError }); controller.setRepository(repo(), 1); await controller.open(query());
    expect(controller.state.status).toBe('blocked'); expect(controller.state.result).toBeNull(); expect(onError).toHaveBeenCalled(); controller.dispose();
    const pending = deferred<DiffResult>(), source2 = host({ diffPatch: vi.fn(() => pending.promise) }), second = createDiffController(source2);
    second.setRepository(repo(), 1); const read = second.open(query()); second.cancel(); pending.resolve(result()); await read;
    expect(second.state.status).toBe('cancelled'); expect(second.state.result).toBeNull(); expect(second.cacheInfo.patches).toBe(0); second.dispose();
    const third = createDiffController(host({ diffPatch: vi.fn(async () => { throw { code: 'GIT_FAILED', message: 'read failed' }; }) })); third.setRepository(repo(), 1); await third.open(query());
    expect(third.state.status).toBe('error'); expect(third.state.rows.lines).toEqual([]); third.dispose();
  });

  it('supports actual legacy diff results but never falls back from missing fileContent to a new unrelated read', async () => {
    const source = host({ diffPatch: undefined, fileContent: undefined, diff: vi.fn(async () => result({ oldContent: '', newContent: 'real legacy' })) });
    const controller = createDiffController(source); controller.setRepository(repo(), 1); await controller.open(query()); await controller.setMode('new');
    expect(controller.state.rows.lines[0].left).toBe('real legacy'); expect(source.diff).toHaveBeenCalledOnce(); controller.dispose();
    const second = createDiffController(host({ fileContent: undefined })); second.setRepository(repo(), 1); await second.open(query()); await second.setMode('old');
    expect(second.state.sides.old.status).toBe('blocked'); expect(second.state.rows.lines).toEqual([]); second.dispose();
  });

  it('restores same document reading mode, semantic anchor, gaps and offsets without loading both sides eagerly', async () => {
    const source = host(), controller = createDiffController(source); controller.setRepository(repo(), 1); await controller.open(query());
    await controller.setMode('new'); controller.updateReading({ scrollTop: 87, scrollLeft: 41, anchor: { next: 3, offset: 2 } });
    await controller.open(query({ path: 'b.ts' })); await controller.open(query());
    expect(controller.state.mode).toBe('new'); expect(controller.state.reading).toMatchObject({ scrollTop: 87, scrollLeft: 41, anchor: { next: 3, offset: 2 } });
    expect(source.fileContent).toHaveBeenCalledOnce(); controller.dispose();
  });

  it('rereads mutable selections even when the same path stays open and binds renamed old paths', async () => {
    const source = host(), loaded = vi.fn(), controller = createDiffController(source, { onLoaded: loaded }); controller.setRepository(repo(), 1);
    await controller.open({ base: 'INDEX', target: 'WORKTREE', path: 'same.ts', group: 'unstaged' });
    await controller.open({ base: 'INDEX', target: 'WORKTREE', path: 'same.ts', group: 'unstaged' });
    expect(source.diffPatch).toHaveBeenCalledTimes(2); expect(controller.state.historical).toBe(false); expect(controller.cacheInfo.patches).toBe(0);
    const file = { path: 'same.ts', oldPath: 'old-one.ts', status: 'R', additions: 0, deletions: 0, staged: false, unstaged: false };
    await controller.open(query({ path: file.path, file }));
    const first = controller.state.identity;
    await controller.open(query({ path: file.path, file: { ...file, oldPath: 'old-two.ts' } }));
    expect(controller.state.identity).not.toBe(first); expect(vi.mocked(source.diffPatch!).mock.lastCall?.[0].oldPath).toBe('old-two.ts');
    const count = loaded.mock.calls.length; await controller.open(query({ path: file.path, file: { ...file, oldPath: 'old-two.ts' } }));
    expect(source.diffPatch).toHaveBeenCalledTimes(4); expect(loaded.mock.calls.length).toBe(count + 1); controller.dispose();
  });

  it('separates groups and base identities and cancels parallel old/new content safely', async () => {
    const source = host(), controller = createDiffController(source); controller.setRepository(repo(), 1);
    await controller.open(query({ group: 'staged', historical: false })); await controller.open(query({ group: 'unstaged', historical: false })); await controller.open(query({ base: c }));
    expect(source.diffPatch).toHaveBeenCalledTimes(3);
    const sides = [deferred<DiffResult>(), deferred<DiffResult>()]; vi.mocked(source.fileContent!).mockImplementation((_query, side) => sides[side === 'old' ? 0 : 1].promise);
    const content = controller.setShowUnchanged(true); controller.cancelContent(); sides[0].resolve(result({ oldContent: 'stale' })); sides[1].resolve(result({ newContent: 'stale' })); await content;
    expect(controller.state.sides.old.status).toBe('cancelled'); expect(controller.state.sides.new.status).toBe('cancelled'); expect(controller.cacheInfo.contents).toBe(0); controller.dispose();
  });
});

describe('historical shortcut scope', () => {
  function event(extra: Partial<KeyboardEvent> = {}): KeyboardEvent { return { key: 'F5', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, isComposing: false, keyCode: 0, target: null, ...extra } as KeyboardEvent; }
  it('accepts only history Alt combinations outside editing/IME', () => {
    expect(historicalDiffShortcut(event(), true)).toBe('next-change'); expect(historicalDiffShortcut(event({ shiftKey: true }), true)).toBe('previous-change');
    expect(historicalDiffShortcut(event({ key: 'PageUp' }), true)).toBe('previous-file'); expect(historicalDiffShortcut(event({ key: 'PageDown' }), true)).toBe('next-file');
    for (const value of [event({ isComposing: true }), event({ keyCode: 229 }), event({ ctrlKey: true }), event({ metaKey: true }), event({ defaultPrevented: true }), event({ altKey: false }), event({ target: { closest: () => ({}) } as unknown as EventTarget })]) expect(historicalDiffShortcut(value, true)).toBeNull();
    expect(historicalDiffShortcut(event(), false)).toBeNull();
  });
});

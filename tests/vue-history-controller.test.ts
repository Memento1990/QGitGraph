import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHistoryController } from '../src/controllers/history';
import { StateStore } from '../src/lib/state';
import { defaultState, type ChangedFile, type Commit, type CommitDetail, type DiffResult, type Host, type Repository } from '../src/shared/protocol';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40);
const repo = (id = 'a'): Repository => ({ id, path: `/test/${id}`, name: id, gitDir: '', commonDir: '', head: b, branch: 'main', trusted: true, bare: false });
const file = (path = 'src/a.ts'): ChangedFile => ({ path, oldPath: null, status: 'M', additions: 1, deletions: 1, staged: false, unstaged: false });
const commit = (oid = b, parents = [a]): Commit => ({ oid, parents, author: 'Actual author', email: 'author@example.test', authoredAt: 1, committedAt: 2, subject: 'Actual subject', refs: [] });
const detail = (oid = b, parent: string | null = a, files = [file()]): CommitDetail => ({ commit: commit(oid, oid === b ? [a, c] : parent ? [parent] : []), body: 'Full body\n'.repeat(100), committer: 'Actual committer', committerEmail: 'committer@example.test', signature: { status: 'N', signer: '', key: '' }, files, base: parent });
const diffResult = (extra: Partial<DiffResult> = {}): DiffResult => ({ patch: '@@ -1 +1 @@\n-old\n+new\n', binary: false, truncated: false, oldContent: null, newContent: null, ...extra });
function host(overrides: Partial<Host> = {}): Host {
  return { cancel: vi.fn(async () => {}), commitDetail: vi.fn(async (_repo: string, oid: string, _id: string, parent?: string) => detail(oid, parent ?? a)), compare: vi.fn(async () => [file()]), diffPatch: vi.fn(async () => diffResult()), diff: vi.fn(async () => diffResult()), ...overrides } as unknown as Host;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
afterEach(() => { vi.useRealTimers(); });

describe('Vue history controller', () => {
  it('loads real metadata and parent file lists without opening a repository or querying history', async () => {
    const source = host({ openRepository: vi.fn(), history: vi.fn() }), controller = createHistoryController(source);
    controller.setRepository(repo(), 1); await controller.select(commit());
    expect(source.openRepository).not.toHaveBeenCalled(); expect(source.history).not.toHaveBeenCalled(); expect(source.diffPatch).not.toHaveBeenCalled();
    expect(controller.state.detail).toMatchObject({ committer: 'Actual committer', body: 'Full body\n'.repeat(100) });
    expect(controller.state.selection).toEqual({ kind: 'commit', oid: b, parent: a }); expect(controller.state.status).toBe('ready');
    vi.mocked(source.commitDetail).mockResolvedValueOnce(detail(b, c, [file('second-parent.ts')]));
    await controller.selectParent(c);
    expect(source.commitDetail).toHaveBeenLastCalledWith('a', b, expect.any(String), c);
    expect(controller.state.files.map(item => item.path)).toEqual(['second-parent.ts']);
    expect(controller.state.selection).toEqual({ kind: 'commit', oid: b, parent: c }); controller.dispose();
  });

  it('ignores stale metadata for a changed OID, parent, repository and generation', async () => {
    const old = deferred<CommitDetail>(), current = deferred<CommitDetail>(), source = host({ commitDetail: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise).mockResolvedValue(detail(d, a)) });
    const controller = createHistoryController(source); controller.setRepository(repo(), 1);
    const one = controller.select(b), two = controller.select(d); current.resolve(detail(d, a)); await two; old.resolve(detail(b, a)); await one;
    expect(controller.state.selected).toBe(d); expect(controller.cacheInfo.details).toBe(1);
    const stale = deferred<CommitDetail>(); vi.mocked(source.commitDetail).mockReturnValueOnce(stale.promise); const read = controller.select(b);
    controller.setRepository(repo('other'), 2); stale.resolve(detail(b, a)); await read;
    expect(controller.state.status).toBe('idle'); expect(controller.state.files).toEqual([]); expect(controller.state.documents).toEqual([]); expect(controller.cacheInfo.details).toBe(0);
    controller.dispose();
  });

  it('opens typed documents from actual file lists, restores reading and bounds/pins tabs', async () => {
    const source = host({ commitDetail: vi.fn(async () => detail(b, a, [file('a.ts'), file('b.ts'), file('c.ts')])) });
    const controller = createHistoryController(source, { maxDocuments: 2 }); controller.setRepository(repo(), 1); await controller.select(b);
    await controller.openFile('not-present'); expect(source.diffPatch).not.toHaveBeenCalled();
    await controller.openFile('a.ts'); const first = controller.state.activeDocument!; controller.pinDocument(first);
    controller.diff.updateReading({ scrollTop: 420, scrollLeft: 23, anchor: { old: 8, offset: 2 } });
    await controller.openFile('b.ts'); const second = controller.state.activeDocument!;
    await controller.openFile('c.ts'); expect(controller.state.documents).toHaveLength(2); expect(controller.state.documents.some(item => item.id === second)).toBe(false);
    await controller.activateDocument(first); expect(controller.diff.state.reading.scrollTop).toBe(420); expect(controller.diff.state.reading.scrollLeft).toBe(23);
    const remaining = controller.state.documents.find(item => item.id !== first)!;
    controller.pinDocument(remaining.id); await controller.openFile('b.ts'); expect(controller.state.error?.code).toBe('DOCUMENT_LIMIT'); expect(controller.state.documents).toHaveLength(2);
    await controller.closeDocument(first); expect(controller.state.activeDocument).toBe(remaining.id);
    await controller.closeDocument(remaining.id); expect(controller.state.activeDocument).toBeNull(); expect(controller.diff.state.status).toBe('idle'); controller.dispose();
  });

  it('requires explicit review start and successful exact-file load, never error/binary/truncated loads', async () => {
    vi.useFakeTimers(); const store = new StateStore(async () => {}, vi.fn()); store.load(defaultState());
    const source = host({ commitDetail: vi.fn(async () => detail(b, a, [file('good'), file('bad'), file('binary'), file('truncated')])) });
    const controller = createHistoryController(source, { store }); controller.setRepository(repo(), 1);
    expect(controller.startReview()).toBe(false); await controller.select(b); await controller.openFile('good');
    expect(store.state.reviews).toEqual([]); expect(controller.markReviewed('good')).toBe(false);
    expect(controller.startReview()).toBe(true); expect(controller.state.review.reviewed.has('good')).toBe(true);
    vi.mocked(source.diffPatch!).mockRejectedValueOnce({ code: 'GIT_FAILED', message: 'real error' }); await controller.openFile('bad');
    expect(controller.diff.state.status).toBe('error'); expect(controller.state.review.reviewed.has('bad')).toBe(false); expect(controller.markReviewed('bad')).toBe(false);
    vi.mocked(source.diffPatch!).mockResolvedValueOnce(diffResult({ binary: true })); await controller.openFile('binary'); expect(controller.state.review.reviewed.has('binary')).toBe(false);
    vi.mocked(source.diffPatch!).mockResolvedValueOnce(diffResult({ truncated: true })); await controller.openFile('truncated'); expect(controller.state.review.reviewed.has('truncated')).toBe(false);
    controller.stopReview(); expect(controller.state.review.active).toBe(false); expect(controller.markReviewed('good')).toBe(false); controller.dispose(); await store.flush();
  });

  it('keeps review identity separate when merge parent or comparison base changes', async () => {
    vi.useFakeTimers(); const store = new StateStore(async () => {}, vi.fn()), source = host();
    const controller = createHistoryController(source, { store }); controller.setRepository(repo(), 1); await controller.select(b); controller.startReview(); await controller.openFile(file());
    expect(controller.state.review.reviewed.size).toBe(1);
    await controller.selectParent(c); expect(controller.state.review.active).toBe(false); expect(controller.state.review.reviewed.size).toBe(0);
    await controller.compare(a, b); expect(source.compare).toHaveBeenCalledWith(expect.objectContaining({ repoId: 'a', base: a, target: b }));
    expect(controller.state.detail).toBeNull(); expect(controller.startReview()).toBe(true); await controller.openFile(file()); expect(controller.state.review.reviewed.size).toBe(1);
    await controller.compare(c, b); expect(controller.state.review.reviewed.size).toBe(0);
    controller.dispose(); await store.flush();
  });

  it('keeps working diffs mutable, unreviewable, and outside historical shortcut/document semantics', async () => {
    const source = host(), controller = createHistoryController(source); controller.setRepository(repo(), 1);
    await controller.openWorking({ file: file(), group: 'unstaged', base: 'INDEX', target: 'WORKTREE', staged: false });
    expect(controller.state.documents).toEqual([]); expect(controller.state.activeDocument).toBeNull(); expect(controller.diff.state.historical).toBe(false);
    expect(vi.mocked(source.diffPatch!).mock.calls[0][0]).toMatchObject({ target: 'WORKTREE', base: 'INDEX', path: file().path, staged: false });
    expect(controller.diff.cacheInfo.patches).toBe(0); expect(controller.startReview()).toBe(false); controller.dispose();
  });

  it('preserves bounded pure reading state over A→B→A while invalidating repository content and stale tabs', async () => {
    const source = host(), controller = createHistoryController(source); controller.setRepository(repo('a'), 1); await controller.select(b);
    controller.updateReading({ fullMessage: true, fileFilter: 'src/', filesScrollTop: 82, filesScrollLeft: 15, metadataScrollTop: 64 });
    await controller.openFile(file()); controller.diff.updateReading({ scrollTop: 123, scrollLeft: 7 });
    controller.setRepository(repo('b'), 2); await controller.select(d); controller.setRepository(repo('a'), 3); await controller.select(b);
    expect(controller.state).toMatchObject({ fullMessage: true, fileFilter: 'src/', filesScrollTop: 82, filesScrollLeft: 15, metadataScrollTop: 64 });
    expect(controller.state.documents).toEqual([]); expect(source.commitDetail).toHaveBeenCalledTimes(3);
    await controller.openFile(file()); expect(controller.diff.state.reading).toMatchObject({ scrollTop: 123, scrollLeft: 7 }); expect(source.diffPatch).toHaveBeenCalledTimes(2); controller.dispose();
  });

  it('rejects host metadata mismatch and missing capabilities, and preserves cancel/error status without mock data', async () => {
    const source = host({ commitDetail: vi.fn(async () => detail(d, a)) }), controller = createHistoryController(source);
    controller.setRepository(repo(), 1); await controller.select(b); expect(controller.state.status).toBe('error'); expect(controller.state.files).toEqual([]); expect(controller.state.detail).toBeNull();
    vi.mocked(source.commitDetail).mockResolvedValueOnce(detail(b, c)); await controller.select({ oid: b, parent: a }); expect(controller.state.status).toBe('error'); expect(controller.state.error?.code).toBe('INVALID_COMMIT_PARENT');
    controller.dispose(); const second = createHistoryController(host({ commitDetail: undefined })); second.setRepository(repo(), 1); await second.select(b); expect(second.state.status).toBe('blocked'); expect(second.state.files).toEqual([]); second.dispose();
    const pending = deferred<CommitDetail>(), third = createHistoryController(host({ commitDetail: vi.fn(() => pending.promise) })); third.setRepository(repo(), 1); const load = third.select(b); third.cancel(); pending.resolve(detail()); await load;
    expect(third.state.status).toBe('cancelled'); expect(third.state.detail).toBeNull(); third.dispose();
  });

  it('uses immutable-only detail LRU and never caches mutable comparison refs', async () => {
    const source = host(), controller = createHistoryController(source, { maxDetails: 1 }); controller.setRepository(repo(), 1);
    await controller.select(b); await controller.select(d); await controller.select(b); expect(source.commitDetail).toHaveBeenCalledTimes(3); expect(controller.cacheInfo.details).toBe(1);
    await controller.compare('HEAD~1', 'HEAD'); await controller.compare('HEAD~1', 'HEAD'); expect(source.compare).toHaveBeenCalledTimes(2); expect(controller.cacheInfo.comparisons).toBe(0);
    controller.dispose();
  });

  it('navigates real sibling files and changes, including last-change boundary across files', async () => {
    const controller = createHistoryController(host({ commitDetail: vi.fn(async () => detail(b, a, [file('a.ts'), file('b.ts')])) }));
    controller.setRepository(repo(), 1); await controller.select(b); await controller.openFile('a.ts');
    expect(controller.diff.state.fileIndex).toBe(0); expect(await controller.diff.navigateChange(1)).toBe(true);
    expect(await controller.diff.navigateChange(1)).toBe(true); expect(controller.state.selectedPath).toBe('b.ts'); expect(controller.diff.state.reading.activeChange).not.toBeNull();
    expect(await controller.diff.navigateChange(-1)).toBe(true); expect(controller.state.selectedPath).toBe('a.ts'); controller.dispose();
  });
});

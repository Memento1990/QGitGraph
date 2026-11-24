import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionsController, type ActionControllerDeps } from '../src/controllers/actions';
import { createLocalChangesController } from '../src/controllers/local-changes';
import { initI18n, resolveText } from '../src/lib/i18n';
import { localChangeKey, type LocalChangeGroup } from '../src/lib/local-changes';
import { DEFAULT_SETTINGS, type ActionResult, type ChangedFile, type Host, type Repository, type RepositorySnapshot } from '../src/shared/protocol';
import LocalChangesPanel from '../src/components/LocalChangesPanel.vue';

vi.mock('reka-ui', async () => {
  const { defineComponent, h } = await import('vue');
  const primitive = (tag: string) => defineComponent({ inheritAttrs: false, setup: (_, { attrs, slots }) => () => h(tag, attrs, slots.default?.()) });
  return {
    DialogRoot: defineComponent({ props: { open: Boolean }, setup: (props, { slots }) => () => props.open ? slots.default?.() : null }),
    DialogPortal: defineComponent({ setup: (_, { slots }) => () => slots.default?.() }),
    DialogContent: primitive('section'), DialogOverlay: primitive('aside'), DialogTitle: primitive('h2'), DialogDescription: primitive('p'),
  };
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function repository(id = 'A'): Repository { return { id, name: id, path: `D:/test/${id}`, gitDir: `D:/test/${id}/.git`, commonDir: `D:/test/${id}/.git`, head: '1'.repeat(40), branch: 'main', trusted: true, bare: false }; }
function file(path: string, status: string, staged: boolean, unstaged: boolean, oldPath: string | null = null): ChangedFile {
  return { path, oldPath, status, staged, unstaged, additions: 1, deletions: 1 };
}
function fixture(files = [file('both.txt', 'MM', true, true), file('staged.txt', 'M.', true, false), file('working.txt', '.M', false, true), file(' new name.txt ', '?', false, true)]) {
  const context = { repo: repository(), generation: 1, busy: false, loading: false, error: null as unknown,
    settings: structuredClone(DEFAULT_SETTINGS), snapshot: null as RepositorySnapshot | null };
  context.snapshot = { repository: { ...context.repo }, fingerprint: 'snapshot-1', refs: [], remotes: [], stashes: [],
    working: { files, branch: 'main', operation: null, conflicts: 0, ahead: 0, behind: 0 } };
  const result: ActionResult = { output: 'Actual native result', operation: null };
  const host = {
    action: vi.fn<Host['action']>().mockResolvedValue(result),
    workingAction: vi.fn<NonNullable<Host['workingAction']>>().mockResolvedValue(result),
    workingIndex: vi.fn<NonNullable<Host['workingIndex']>>().mockResolvedValue(`index-v1:${'a'.repeat(40)}`),
    snapshot: vi.fn<Host['snapshot']>().mockImplementation(async () => structuredClone(context.snapshot!)),
    cancel: vi.fn<Host['cancel']>().mockResolvedValue(undefined),
  };
  const callbacks = {
    onRefresh: vi.fn<ActionControllerDeps['onRefresh']>(async (snapshot, binding) => { if (context.generation === binding.generation) { context.snapshot = snapshot; context.repo = snapshot.repository; } }),
    onResult: vi.fn<NonNullable<ActionControllerDeps['onResult']>>(), onError: vi.fn<NonNullable<ActionControllerDeps['onError']>>(),
  };
  const deps: ActionControllerDeps = { host: host as unknown as Host, getRepository: () => context.repo, getGeneration: () => context.generation,
    getSnapshot: () => context.snapshot, getSettings: () => context.settings, getBusy: () => context.busy, getLoading: () => context.loading, getError: () => context.error, ...callbacks };
  const local = createLocalChangesController(deps);
  function activate(id: string): void {
    context.repo = repository(id); context.generation++; context.snapshot = { ...structuredClone(context.snapshot!), repository: { ...context.repo } }; local.update();
  }
  return { local, context, host, callbacks, deps, activate, result };
}
afterEach(() => { initI18n('en'); vi.restoreAllMocks(); });

describe('local Vue state, whole-file groups and controlled preview', () => {
  it('restores independent draft caret, selection direction and scroll per repository', () => {
    const { local, activate, context } = fixture();
    local.setDraft('Repository A multiline\nsecond line');
    const readingA = { start: 3, end: 14, direction: 'backward' as const, scrollTop: 45, scrollLeft: 12 };
    local.updateDraftReading(readingA); expect(local.state.draftReading).toEqual(readingA);
    activate('B'); expect(local.state.draftReading).toMatchObject({ start: 0, end: 0, scrollTop: 0 });
    local.setDraft('Repository B'); local.updateDraftReading({ start: 2, end: 5, direction: 'forward', scrollTop: 8 });
    activate('A'); expect(local.state.draft).toContain('Repository A'); expect(local.state.draftReading).toEqual(readingA);
    context.generation++; local.update(); expect(local.state.draftReading).toEqual(readingA);
    activate('B'); expect(local.state.draftReading).toMatchObject({ start: 2, end: 5, direction: 'forward', scrollTop: 8 });
  });

  it('clamps invalid reading positions and ignores late events from a departing repository activation', () => {
    const { local, context } = fixture(); local.setDraft('Draft');
    local.updateDraftReading({ start: -4, end: 20, direction: 'none', scrollTop: -20, scrollLeft: Number.NaN });
    expect(local.state.draftReading).toEqual({ start: 0, end: 5, direction: 'none', scrollTop: 0, scrollLeft: 0 });
    context.generation++;
    local.updateDraftReading({ start: 4, end: 4, direction: 'forward', scrollTop: 20 });
    expect(local.state.draftReading.start).toBe(0); local.update(); expect(local.state.draftReading.end).toBe(5);
    local.setDraft('X'); expect(local.state.draftReading.end).toBe(1);
  });

  it('does not invalidate commit index capture when update observes the same unchanged snapshot', async () => {
    const { local, host } = fixture(), index = deferred<string>(); local.setDraft('Commit'); host.workingIndex.mockReturnValueOnce(index.promise);
    const pending = local.commit(); local.update(); index.resolve(`index-v1:${'a'.repeat(40)}`);
    expect(await pending).toBe(true); expect(host.workingAction).toHaveBeenCalledOnce();
  });

  it('keeps untrusted file lists read-only, rather than hiding them as an unknown snapshot', async () => {
    const { local, context } = fixture(); context.repo.trusted = false;
    const html = await renderToString(createSSRApp({ render: () => h(LocalChangesPanel, { controller: local }) }));
    expect(local.stale).toBe(false); expect(local.canWrite).toBe(false); expect(html).toContain('both.txt');
    expect(html).toContain('read-only'); expect(html).toContain('data-action="stage-file"');
  });

  it('masks both visual and aria stale counts and composer counts when status is blocked', async () => {
    const { local, context } = fixture(); context.error = { code: 'UNTRUSTED_FILTER', message: 'Cannot read working state' };
    const html = await renderToString(createSSRApp({ render: () => h(LocalChangesPanel, { controller: local }) }));
    expect(html).toContain('aria-label="Working tree status is not loaded"'); expect(html).not.toContain('4 changed files');
    expect(html).not.toContain('Only 2 staged files'); expect(html).not.toContain('data-action="stage-file"');
    expect(html).toMatch(/ch-commit-count[^>]*>—/); expect(html).toContain('not known to be clean');
  });

  it('uses distinct path counts rather than transport row count', async () => {
    const changed = file('duplicate.txt', 'MM', true, true), { local } = fixture([changed, { ...changed }]);
    const html = await renderToString(createSSRApp({ render: () => h(LocalChangesPanel, { controller: local }) }));
    expect(html).toContain('aria-label="1 changed files"'); expect(html).toContain('Only 1 staged files');
  });

  it('keeps one mixed path in two distinct group+path entries', () => {
    const { local } = fixture();
    expect(local.state.groups.map(group => group.entries.length)).toEqual([2, 2, 1]);
    expect(local.state.groups[0].entries[0].key).toBe(localChangeKey('staged', 'both.txt'));
    expect(local.state.groups[1].entries[0].key).toBe(localChangeKey('unstaged', 'both.txt'));
    expect(local.state.groups[0].entries[0].file).toBe(local.state.groups[1].entries[0].file);
    expect(local.select('staged', 'both.txt')).toMatchObject({ base: '1'.repeat(40), target: 'INDEX', staged: true });
    expect(local.state.selected).toMatchObject({ group: 'staged', path: 'both.txt' });
    expect(local.select('unstaged', 'both.txt')).toMatchObject({ base: 'INDEX', target: 'WORKTREE', staged: false });
    expect(local.state.selected).toMatchObject({ group: 'unstaged', path: 'both.txt' });
    expect(local.select('untracked', ' new name.txt ')).toMatchObject({ base: 'ROOT', target: 'WORKTREE', staged: false });
  });

  it('preserves rename comparison direction and does not confuse index oldPath with unstaged content', () => {
    const { local } = fixture([file('new.txt', 'RM', true, true, 'old.txt')]);
    expect(local.select('staged', 'new.txt')!.query).toMatchObject({ oldPath: 'old.txt', target: 'INDEX' });
    expect(local.select('unstaged', 'new.txt')!.query).not.toHaveProperty('oldPath');
  });

  it('keeps drafts isolated by repository+path and preserves them across activation generations', () => {
    const { local, context, activate } = fixture(); local.setDraft('Draft A'); local.toggleGroup('staged');
    activate('B'); expect(local.state.draft).toBe(''); expect(local.state.collapsed.size).toBe(0); local.setDraft('Draft B');
    activate('A'); expect(local.state.draft).toBe('Draft A');
    context.repo.path = 'D:/same-id-different-location'; context.snapshot!.repository.path = context.repo.path; context.generation++; local.update();
    expect(local.state.draft).toBe('');
    local.setDraft('x'.repeat(70_000)); expect(local.state.draft).toHaveLength(65_536);
  });

  it('localizes every group/path action label for mixed entries without label collision', () => {
    const { local } = fixture();
    const staged = local.ariaLabel('preview', 'staged', 'both.txt'), unstaged = local.ariaLabel('preview', 'unstaged', 'both.txt');
    expect(resolveText(staged, 'en')).not.toBe(resolveText(unstaged, 'en'));
    expect(resolveText(staged, 'en')).toContain('Staged changes'); expect(resolveText(unstaged, 'zh-CN')).toContain('更改');
    expect(resolveText(local.ariaLabel('discard', 'unstaged', 'both.txt'), 'zh-CN')).toContain('丢弃');
  });

  it('invalidates vanished selections and stale confirmation when a new real snapshot is applied', () => {
    const { local, context } = fixture(); local.select('unstaged', 'both.txt'); local.stageAll('unstaged');
    context.snapshot = { ...structuredClone(context.snapshot!), fingerprint: 'new', working: { ...context.snapshot!.working, files: [] } }; local.update();
    expect(local.state.selected).toBeNull(); expect(local.state.confirmation).toBeNull(); expect(local.state.groups.flatMap(group => group.entries)).toHaveLength(0);
  });

  it('renders real mixed group buttons and bilingual controlled draft in the SFC', async () => {
    const { local } = fixture(); local.setDraft('Do not lose this draft'); initI18n('zh-CN');
    const html = await renderToString(createSSRApp({ render: () => h(LocalChangesPanel, { controller: local }) }));
    expect(html).toContain('ch-panel'); expect(html).toContain('Do not lose this draft'); expect(html).toContain('提交已暂存');
    expect(html).toContain('data-group="staged"'); expect(html).toContain('data-group="unstaged"');
    expect(html).toContain('data-action="unstage-file"'); expect(html).toContain('data-action="stage-file"');
    expect(html).toContain('已暂存的更改 · both.txt'); expect(html).toContain('更改 · both.txt');
  });
});

describe('literal whole-file writes and intent confirmations', () => {
  it.each([
    ['stage', 'unstaged', 'both.txt'], ['stage', 'untracked', ' new name.txt '], ['unstage', 'staged', 'both.txt'],
  ] as const)('sends %s for exactly %s/%s without hunk or stage-all sentinel', async (kind, group, path) => {
    const { local, host, callbacks } = fixture();
    expect(await local.request(kind, group, path)).toBe(true);
    expect(host.workingAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind, repoId: 'A', requestId: expect.stringMatching(/^vue-/), files: [{ path, status: group === 'untracked' ? '?' : 'MM' }] }));
    expect(host.action).not.toHaveBeenCalled(); expect(host.snapshot).toHaveBeenCalledTimes(2);
    expect(callbacks.onRefresh).toHaveBeenCalledBefore(callbacks.onResult);
  });

  it('stage-all lists each literal path for review and does not include later additions', async () => {
    const { local, host, context } = fixture(); expect(local.stageAll()).toBe(true);
    expect(local.state.confirmation!.files.map(target => target.path)).toEqual(['both.txt', 'working.txt', ' new name.txt ']);
    expect(host.workingAction).not.toHaveBeenCalled();
    context.snapshot!.working.files.push(file('later.txt', '?', false, true));
    expect(await local.confirm()).toBe(false); expect(host.workingAction).not.toHaveBeenCalled();
  });

  it.each(['staged', 'unstaged', 'untracked'] as LocalChangeGroup[])('reviews all targets for group %s and executes just the frozen list', async group => {
    const { local, host } = fixture(); expect(local.stageAll(group)).toBe(true);
    const expected = structuredClone(local.state.confirmation!.files);
    expect(await local.confirm()).toBe(true); expect(host.workingAction.mock.calls[0][0]).toMatchObject({ kind: group === 'staged' ? 'unstage' : 'stage', files: expected });
    expect(local.state.confirmation).toBeNull();
  });

  it('requires discard text and restores only the selected worktree path from index', async () => {
    const { local, host } = fixture(); expect(await local.discard('both.txt')).toBe(false);
    expect(local.state.confirmation).toMatchObject({ kind: 'discard', expected: 'discard', danger: true, files: [{ path: 'both.txt', status: 'MM' }] });
    expect(await local.confirm(' discard')).toBe(false); expect(host.workingAction).not.toHaveBeenCalled();
    local.setConfirmation('discard'); expect(await local.confirm()).toBe(true);
    expect(host.workingAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'discard', confirmation: 'discard', files: [{ path: 'both.txt', status: 'MM' }] }));
  });

  it('requires the exact untrimmed untracked path and never widens deletion to a rename/source path', async () => {
    const { local, host } = fixture(); await local.deleteUntracked(' new name.txt ');
    expect(local.state.confirmation!.expected).toBe(' new name.txt ');
    expect(await local.confirm('new name.txt')).toBe(false); expect(host.workingAction).not.toHaveBeenCalled();
    expect(await local.confirm(' new name.txt ')).toBe(true);
    expect(host.workingAction.mock.calls[0][0]).toMatchObject({ kind: 'delete-untracked', files: [{ path: ' new name.txt ', status: '?' }], confirmation: ' new name.txt ' });
  });

  it('rejects invalid group/action pairs, absent/empty targets and empty group-all requests', async () => {
    const { local, host } = fixture();
    expect(await local.request('stage', 'staged', 'both.txt')).toBe(false);
    expect(await local.request('discard', 'untracked', ' new name.txt ')).toBe(false);
    expect(await local.request('delete-untracked', 'unstaged', 'both.txt')).toBe(false);
    expect(await local.stage('unstaged', '')).toBe(false); expect(host.workingAction).not.toHaveBeenCalled();
    const empty = fixture([]); expect(empty.local.stageAll()).toBe(false); expect(empty.host.workingAction).not.toHaveBeenCalled();
  });

  it.each(['fingerprint', 'snapshot', 'head', 'path', 'generation', 'trust', 'busy', 'loading', 'error', 'status'] as const)('rejects a confirmation after %s changes', async mode => {
    const { local, context, host } = fixture(); await local.discard('both.txt');
    if (mode === 'fingerprint') context.snapshot!.fingerprint = 'new';
    else if (mode === 'snapshot') context.snapshot = structuredClone(context.snapshot!);
    else if (mode === 'head') context.repo.head = '2'.repeat(40);
    else if (mode === 'path') context.repo.path = 'D:/other';
    else if (mode === 'generation') context.generation++;
    else if (mode === 'trust') context.repo.trusted = false;
    else if (mode === 'busy') context.busy = true;
    else if (mode === 'loading') context.loading = true;
    else if (mode === 'error') context.error = Error('Failed to refresh');
    else context.snapshot!.working.files[0].status = 'DM';
    expect(await local.confirm('discard')).toBe(false); expect(host.workingAction).not.toHaveBeenCalled();
  });

  it('keeps discard/rename targets literal, including Git-significant punctuation', async () => {
    const path = 'src/[literal]* file.txt', oldPath = 'src/old:name.txt';
    const { local, host } = fixture([file(path, 'RM', true, true, oldPath)]);
    expect(await local.stage('unstaged', path)).toBe(true);
    expect(host.workingAction.mock.calls[0][0].files).toEqual([{ path, oldPath, status: 'RM' }]);
  });

  it('stages and unstages a literal parent gitlink without opening or mutating the child worktree', async () => {
    const submodule = { ...file('modules/tool', 'MM', true, true), submodule: { commitChanged: true, modified: true, untracked: true } };
    const { local, host } = fixture([submodule]);
    expect(local.select('staged', 'modules/tool')).toMatchObject({ file: submodule, base: '1'.repeat(40) });
    expect(await local.stage('unstaged', 'modules/tool')).toBe(true);
    expect(await local.unstage('modules/tool')).toBe(true);
    expect(host.workingAction.mock.calls.map(([action]) => ({ repoId: action.repoId, kind: action.kind, files: action.files }))).toEqual([
      { repoId: 'A', kind: 'stage', files: [{ path: 'modules/tool', status: 'MM' }] },
      { repoId: 'A', kind: 'unstage', files: [{ path: 'modules/tool', status: 'MM' }] },
    ]);
    expect(host.action).not.toHaveBeenCalled();
    expect(await local.discard('modules/tool')).toBe(false); expect(await local.deleteUntracked('modules/tool')).toBe(false);
    expect(host.workingAction).toHaveBeenCalledTimes(2);
    expect(local.stageAll('unstaged')).toBe(true);
    expect(local.state.confirmation!.files).toEqual([{ path: 'modules/tool', status: 'MM' }]);
  });

  it('can cancel an intention without calling host and cannot confirm it later', async () => {
    const { local, host } = fixture(); local.stageAll(); local.cancelConfirmation();
    expect(await local.confirm()).toBe(false); expect(host.workingAction).not.toHaveBeenCalled();
  });
});

describe('staged-only commits, expected HEAD/index capture and fingerprint guards', () => {
  it('captures expectedHead + native index fingerprint before committing staged files only', async () => {
    const { local, host } = fixture(); local.setDraft('  Commit staged only  ');
    expect(await local.commit()).toBe(true);
    expect(host.workingIndex).toHaveBeenCalledExactlyOnceWith('A', expect.stringMatching(/^vue-commit-staged-/));
    expect(host.workingAction).toHaveBeenCalledExactlyOnceWith({ repoId: 'A', requestId: expect.stringMatching(/^vue-commit-staged-/), kind: 'commit-staged', message: 'Commit staged only', expectedHead: '1'.repeat(40), expectedIndex: `index-v1:${'a'.repeat(40)}` });
    expect(host.workingAction.mock.calls[0][0]).not.toHaveProperty('files'); expect(host.action).not.toHaveBeenCalled();
    expect(local.state.draft).toBe('');
  });

  it('sets expectedHead=null explicitly for an unborn repository and preserves signing=false', async () => {
    const { local, context, host } = fixture([file('new.txt', 'A.', true, false)]);
    context.repo.head = null; context.snapshot!.repository.head = null; context.settings.commitSigning = 'no-sign'; local.update(); local.setDraft('Initial commit');
    expect(await local.commit()).toBe(true); expect(host.workingAction.mock.calls[0][0]).toMatchObject({ expectedHead: null, sign: false });
  });

  it.each(['no-staged', 'no-message', 'no-index-host', 'empty-index', 'no-working-host'] as const)('rejects commit when %s', async mode => {
    const { local, context, host } = fixture(); local.setDraft('Commit'); const workingAction = host.workingAction;
    if (mode === 'no-staged') { context.snapshot!.working.files = [file('only-working.txt', '.M', false, true)]; local.update(); }
    else if (mode === 'no-message') local.setDraft('   ');
    else if (mode === 'no-index-host') delete (host as Partial<typeof host>).workingIndex;
    else if (mode === 'no-working-host') delete (host as Partial<typeof host>).workingAction;
    else host.workingIndex.mockResolvedValue('');
    expect(await local.commit()).toBe(false); expect(workingAction).not.toHaveBeenCalled();
  });

  it.each(['snapshot', 'fingerprint', 'head', 'path', 'generation', 'trust', 'message', 'roundTrip'] as const)('rejects state changed during workingIndex preparation: %s', async mode => {
    const { local, context, host, activate } = fixture(), index = deferred<string>(); local.setDraft('Commit'); host.workingIndex.mockReturnValueOnce(index.promise);
    const pending = local.commit(); expect(local.state.busy).toBe(true); expect(local.state.requestId).toMatch(/^vue-commit-staged-/);
    if (mode === 'snapshot') context.snapshot = structuredClone(context.snapshot!);
    else if (mode === 'fingerprint') context.snapshot!.fingerprint = 'new';
    else if (mode === 'head') context.repo.head = '2'.repeat(40);
    else if (mode === 'path') context.repo.path = 'D:/other';
    else if (mode === 'generation') context.generation++;
    else if (mode === 'trust') context.repo.trusted = false;
    else if (mode === 'message') local.setDraft('Edited while preparing');
    else { activate('B'); activate('A'); }
    index.resolve(`index-v1:${'b'.repeat(40)}`); expect(await pending).toBe(false); expect(host.workingAction).not.toHaveBeenCalled();
  });

  it('checks real snapshot again after index capture and refuses a changed native fingerprint', async () => {
    const { local, host, context } = fixture(); local.setDraft('Commit');
    host.snapshot.mockResolvedValueOnce({ ...context.snapshot!, fingerprint: 'different-native-fingerprint' });
    expect(await local.commit()).toBe(false); expect(host.workingAction).not.toHaveBeenCalled(); expect(local.state.draft).toBe('Commit');
  });

  it('blocks concurrent commit/stage and shared Git controller writes before the first await', async () => {
    const { local, host, deps } = fixture(); const index = deferred<string>(); host.workingIndex.mockReturnValueOnce(index.promise); local.setDraft('Commit');
    const pending = local.commit(); expect(local.state.busy).toBe(true); expect(local.canCommit).toBe(false);
    expect(await local.commit()).toBe(false); expect(await local.stage('unstaged', 'both.txt')).toBe(false);
    const git = createActionsController(deps); expect(await git.open('checkout', { target: 'topic' })).toBe(false);
    index.resolve(`index-v1:${'b'.repeat(40)}`); expect(await pending).toBe(true); expect(host.workingAction).toHaveBeenCalledOnce();
  });

  it('keeps an edited draft when the actual commit finishes and never clears it before refresh', async () => {
    const { local, host, result, context } = fixture(), write = deferred<ActionResult>(), refresh = deferred<RepositorySnapshot>();
    local.setDraft('Commit'); host.workingAction.mockReturnValueOnce(write.promise);
    const pending = local.commit(); await settle(); local.setDraft('Next commit draft');
    host.snapshot.mockReturnValueOnce(refresh.promise); write.resolve(result); await settle();
    expect(local.state.draft).toBe('Next commit draft'); expect(local.state.busy).toBe(true);
    refresh.resolve(structuredClone(context.snapshot!)); expect(await pending).toBe(true); expect(local.state.draft).toBe('Next commit draft');
  });
});

describe('busy/trust/bare gates and real write results', () => {
  it.each(['untrusted', 'bare', 'busy', 'loading', 'error'] as const)('disables every file mutation in %s context without disabling drafts', async mode => {
    const { local, context, host } = fixture();
    if (mode === 'untrusted') context.repo.trusted = false;
    else if (mode === 'bare') context.repo.bare = true;
    else if (mode === 'busy') context.busy = true;
    else if (mode === 'loading') context.loading = true;
    else context.error = Error('Snapshot failed');
    expect(local.canWrite).toBe(false); local.setDraft('Editable'); expect(local.state.draft).toBe('Editable');
    expect(await local.stage('unstaged', 'both.txt')).toBe(false); expect(await local.commit()).toBe(false); expect(await local.sync()).toBe(false);
    expect(host.workingAction).not.toHaveBeenCalled();
  });

  it('refreshes after native failure and retains draft, forwarding raw error codes', async () => {
    const { local, host, callbacks } = fixture(), error = { code: 'STALE_INDEX', message: 'Native refused changed index' };
    host.workingAction.mockRejectedValue(error); local.setDraft('Retain me');
    expect(await local.commit()).toBe(false); expect(callbacks.onRefresh).toHaveBeenCalledOnce(); expect(callbacks.onResult).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith(error, expect.objectContaining({ repoId: 'A' })); expect(local.state.draft).toBe('Retain me');
  });

  it('refreshes after cancellation, prevents success and does not auto-push', async () => {
    const { local, host, callbacks, result } = fixture(), write = deferred<ActionResult>(); host.workingAction.mockReturnValueOnce(write.promise);
    const pending = local.stage('unstaged', 'both.txt'); await settle(); const id = local.state.requestId;
    await local.cancel(); expect(host.cancel).toHaveBeenCalledExactlyOnceWith(id);
    write.resolve(result); expect(await pending).toBe(false); expect(callbacks.onRefresh).toHaveBeenCalledOnce(); expect(callbacks.onResult).not.toHaveBeenCalled(); expect(host.action).not.toHaveBeenCalled();
  });

  it('suppresses stale completion and never refreshes a reopened repository from an old request', async () => {
    const { local, host, callbacks, result, activate } = fixture(), write = deferred<ActionResult>(); host.workingAction.mockReturnValueOnce(write.promise);
    const pending = local.stage('unstaged', 'both.txt'); await settle(); activate('B'); activate('A'); write.resolve(result);
    expect(await pending).toBe(false); expect(callbacks.onRefresh).not.toHaveBeenCalled(); expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it('refuses success when the displayed snapshot changes during an in-flight request but still refreshes', async () => {
    const { local, host, callbacks, context, result } = fixture(), write = deferred<ActionResult>(); host.workingAction.mockReturnValueOnce(write.promise);
    const pending = local.stage('unstaged', 'both.txt'); await settle(); context.snapshot = structuredClone(context.snapshot!); local.update(); write.resolve(result);
    expect(await pending).toBe(false); expect(callbacks.onRefresh).toHaveBeenCalledOnce(); expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it.each(['completed', 'started', 'conflict', 'failed'] as const)('uses one native sync call and no extra push after %s', async mode => {
    const { local, host, callbacks } = fixture();
    if (mode === 'failed') host.workingAction.mockRejectedValue({ code: 'GIT_FAILED', message: 'Pull failed' });
    else host.workingAction.mockResolvedValue({ output: 'Native sync result', operation: mode === 'conflict' ? 'merge' : null, ...(mode === 'started' ? { status: 'started', sessionId: 'session' } : {}) });
    expect(await local.sync()).toBe(mode === 'completed');
    expect(host.workingAction).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'sync', pullMode: 'merge' }));
    expect(host.action).not.toHaveBeenCalled(); expect(callbacks.onRefresh).toHaveBeenCalledOnce();
    if (mode === 'started' || mode === 'conflict') expect(callbacks.onResult.mock.calls[0][0].status).toBe(mode === 'started' ? 'started' : 'paused');
  });

  it('does not call onResult or clear a draft if the mandatory post-write refresh fails', async () => {
    const { local, host, callbacks } = fixture(); local.setDraft('Keep draft');
    host.snapshot.mockImplementationOnce(async () => structuredClone(local.snapshot!)).mockRejectedValueOnce({ code: 'GIT_FAILED', message: 'Cannot refresh' });
    expect(await local.commit()).toBe(false); expect(local.state.draft).toBe('Keep draft'); expect(callbacks.onResult).not.toHaveBeenCalled();
  });
});

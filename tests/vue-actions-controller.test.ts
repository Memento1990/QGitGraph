import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionsController, ACTION_LABELS, type ActionControllerDeps } from '../src/controllers/actions';
import { createLocalChangesController } from '../src/controllers/local-changes';
import { initI18n, resolveText } from '../src/lib/i18n';
import { DEFAULT_SETTINGS, type ActionKind, type ActionResult, type CommitDetail, type GitAction, type Host, type Repository, type RepositorySnapshot } from '../src/shared/protocol';
import ActionDialog from '../src/components/ActionDialog.vue';

// Only the browser portal/focus primitive is replaced; controller and Vue SFC rendering are real.
// This suite does not claim browser focus or native Git integration coverage.
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
function detail(oid = 'a'.repeat(40), parents = ['b'.repeat(40)]): CommitDetail {
  return { commit: { oid, parents, author: 'Test', email: 'test@example.com', authoredAt: 0, committedAt: 0, subject: 'Inspected commit', refs: [] }, body: '', committer: 'Test', committerEmail: 'test@example.com', signature: { status: '', signer: '', key: '' }, files: [], base: parents[0] ?? null };
}
function repository(id = 'A'): Repository {
  return { id, name: id, path: `D:/test/${id}`, gitDir: `D:/test/${id}/.git`, commonDir: `D:/test/${id}/.git`, head: '1'.repeat(40), branch: 'main', trusted: true, bare: false };
}
function fixture({ nativeCleanPreview = false, cleanOutput = 'Would remove literal.txt\n' }: { nativeCleanPreview?: boolean; cleanOutput?: string } = {}) {
  const context = {
    repo: repository(), generation: 1, busy: false, loading: false, error: null as unknown,
    settings: structuredClone(DEFAULT_SETTINGS), snapshot: null as RepositorySnapshot | null,
  };
  context.snapshot = {
    repository: { ...context.repo }, fingerprint: 'real-snapshot-1',
    working: { files: [], branch: 'main', operation: null, conflicts: 0, ahead: 0, behind: 0 },
    refs: [
      { name: 'main', fullName: 'refs/heads/main', oid: '1'.repeat(40), kind: 'branch', upstream: 'origin/main', current: true, subject: '' },
      { name: 'topic', fullName: 'refs/heads/topic', oid: '2'.repeat(40), kind: 'branch', upstream: null, current: false, subject: '' },
    ],
    remotes: [{ name: 'origin', fetchUrl: 'https://example.com/repo', pushUrl: 'https://example.com/push' }],
    stashes: [{ selector: 'stash@{0}', oid: '3'.repeat(40), message: 'Test stash', timestamp: 0 }],
  };
  const result: ActionResult = { output: 'Actual host result', operation: null };
  // Clean capability is explicit. Non-capable fake hosts never issue a token or accept unsafe deletion.
  let cleanPreviewSequence = 0, currentCleanToken: string | null = null;
  const fakeHostAction: Host['action'] = async action => {
    if (action.kind !== 'clean') return result;
    if (action.mode === 'preview') {
      if (!nativeCleanPreview) return { output: cleanOutput, operation: null };
      currentCleanToken = `native-clean-preview-${++cleanPreviewSequence}`;
      return { output: cleanOutput, operation: null, previewToken: currentCleanToken };
    }
    if (!currentCleanToken || action.cleanPreviewToken !== currentCleanToken) throw { code: 'CLEAN_PREVIEW_REQUIRED', message: 'A current native preview token is required.' };
    currentCleanToken = null; return result;
  };
  const host = {
    action: vi.fn<Host['action']>().mockImplementation(fakeHostAction),
    snapshot: vi.fn<Host['snapshot']>().mockImplementation(async () => structuredClone(context.snapshot!)),
    commitDetail: vi.fn<Host['commitDetail']>().mockResolvedValue(detail()),
    repoConfig: vi.fn<Host['repoConfig']>().mockResolvedValue({ userName: 'Test', userEmail: 'test@example.com', globalUserName: 'Global', globalUserEmail: 'global@example.com', signingKey: '', signCommits: false }),
    workingAction: vi.fn<NonNullable<Host['workingAction']>>().mockResolvedValue(result),
    workingIndex: vi.fn<NonNullable<Host['workingIndex']>>().mockResolvedValue(`index-v1:${'a'.repeat(40)}`),
    cancel: vi.fn<Host['cancel']>().mockResolvedValue(undefined),
    openTerminal: vi.fn<Host['openTerminal']>().mockResolvedValue(undefined),
  };
  const callbacks = {
    onRefresh: vi.fn<ActionControllerDeps['onRefresh']>(async (snapshot, binding) => { if (binding.generation === context.generation) { context.snapshot = snapshot; context.repo = snapshot.repository; } }),
    onResult: vi.fn<NonNullable<ActionControllerDeps['onResult']>>(),
    onError: vi.fn<NonNullable<ActionControllerDeps['onError']>>(),
  };
  const deps: ActionControllerDeps = { host: host as unknown as Host, getRepository: () => context.repo, getGeneration: () => context.generation,
    getSnapshot: () => context.snapshot, getSettings: () => context.settings, getBusy: () => context.busy,
    getLoading: () => context.loading, getError: () => context.error, ...callbacks };
  const actions = createActionsController(deps);
  function roundTrip(): void { context.repo = repository('B'); context.generation++; context.repo = repository(); context.generation++; }
  return { actions, context, host, callbacks, deps, roundTrip, result };
}
afterEach(() => { initI18n('en'); vi.restoreAllMocks(); });

const initial: Record<ActionKind, Partial<GitAction>> = {
  'branch-create': { name: 'new-topic', target: 'HEAD' }, 'branch-rename': { target: 'topic', name: 'renamed' }, 'branch-delete': { target: 'topic' }, checkout: { target: 'topic' },
  merge: { target: 'topic' }, rebase: { target: 'topic' }, 'cherry-pick': { target: 'topic' }, revert: { target: 'topic' }, drop: { target: 'topic' }, reset: { target: 'HEAD', mode: 'soft' },
  'tag-create': { name: 'v1.0', target: 'HEAD' }, 'tag-delete': { target: 'v1.0' }, 'tag-push': { target: 'v1.0', remote: 'origin' },
  'stash-save': { message: 'Save it', includeIgnored: true }, 'stash-apply': {}, 'stash-pop': {}, 'stash-drop': {}, 'stash-branch': { name: 'from-stash' },
  fetch: { remote: '' }, pull: { remote: 'origin', mode: 'ff-only' }, push: { remote: 'origin', branch: 'main' },
  'remote-add': { remote: 'backup', url: 'https://example.com/backup' }, 'remote-edit': { remote: 'origin', url: 'https://example.com/new' }, 'remote-remove': { remote: 'origin' }, prune: { remote: 'origin' },
  'set-upstream': { branch: 'main', target: 'main', remote: 'origin' }, clean: {}, continue: {}, abort: {}, commit: { message: 'Staged only' }, identity: {},
  'remote-branch-delete': { target: 'topic', remote: 'origin' }, 'fetch-into': { target: 'topic', branch: 'new-topic', remote: 'origin' }, 'checkout-remote': { target: 'origin/other', name: 'new-local' },
};

describe('production Vue Git action controller coverage', () => {
  it('honors confirmCheckout=false only for an explicitly preset local branch', async () => {
    const { actions, host, context } = fixture(); context.settings.confirmCheckout = false;
    expect(await actions.open('checkout', { target: 'topic' })).toBe(true);
    expect(host.action).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ target: 'topic', kind: 'checkout' }));
    actions.close(); await actions.open('checkout', { target: 'a'.repeat(40) });
    expect(actions.state.phase).toBe('form'); expect(host.action).toHaveBeenCalledOnce();
  });

  it('classifies an operation/conflicts observed in the refreshed snapshot as paused, even if action output omitted it', async () => {
    const { actions, host, context, callbacks } = fixture();
    await actions.open('checkout', { target: 'topic' });
    host.snapshot.mockResolvedValueOnce(structuredClone(context.snapshot!)).mockResolvedValueOnce({
      ...structuredClone(context.snapshot!), working: { ...context.snapshot!.working, operation: 'merge', conflicts: 1 },
    });
    expect(await actions.submit()).toBe(false);
    expect(callbacks.onResult.mock.calls[0][0].status).toBe('paused');
  });

  it('rejects success if the displayed state changes while the mandatory refresh is in flight', async () => {
    const { actions, host, context, callbacks } = fixture(), refresh = deferred<RepositorySnapshot>();
    host.snapshot.mockResolvedValueOnce(structuredClone(context.snapshot!)).mockReturnValueOnce(refresh.promise);
    await actions.open('checkout', { target: 'topic' }); const pending = actions.submit(); await settle();
    context.snapshot = structuredClone(context.snapshot!); refresh.resolve(structuredClone(context.snapshot!));
    expect(await pending).toBe(false); expect(callbacks.onRefresh).toHaveBeenCalledOnce(); expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it.each(Object.keys(initial) as ActionKind[])('builds and sends the real protocol kind %s', async kind => {
    const { actions, host, context, callbacks } = fixture({ nativeCleanPreview: kind === 'clean' });
    if (kind === 'continue' || kind === 'abort') context.snapshot!.working.operation = 'merge';
    expect(await actions.open(kind, initial[kind])).toBe(true);
    await actions.submit();
    if (actions.state.phase === 'confirm') await actions.confirm();
    const writes = host.action.mock.calls.map(([action]) => action).filter(action => action.kind !== 'clean' || action.mode === 'delete');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind, repoId: 'A', requestId: expect.stringMatching(/^vue-action-/) });
    expect(callbacks.onRefresh).toHaveBeenCalledOnce(); expect(callbacks.onResult).toHaveBeenCalledOnce();
    expect(host.snapshot).toHaveBeenCalledTimes(kind === 'clean' ? 5 : 2);
    if (kind === 'commit') expect(writes[0]).toMatchObject({ message: 'Staged only', mode: 'follow-up', force: true });
    if (kind === 'remote-branch-delete') expect(writes[0].force).toBe(true);
    if (kind === 'checkout-remote') expect(writes[0]).toMatchObject({ target: 'other', remote: 'origin', name: 'new-local' });
    if (kind === 'cherry-pick' || kind === 'revert' || kind === 'drop') expect(writes[0].target).toBe('a'.repeat(40));
    expect(actions.state.busy).toBe(false); expect(actions.state.requestId).toBeNull();
  });

  it('has a type-exhaustive available list, hides configured actions and localizes labels', () => {
    const { actions, context } = fixture();
    expect(Object.keys(ACTION_LABELS).sort()).toEqual(Object.keys(initial).sort());
    expect(actions.available).toHaveLength(34);
    context.settings.hiddenActions = ['push'];
    expect(actions.available.some(item => item.kind === 'push')).toBe(false);
    const label = actions.available.find(item => item.kind === 'reset')!.label;
    expect(resolveText(label, 'en')).toBe('Reset current branch'); expect(resolveText(label, 'zh-CN')).toBe('重置当前分支');
  });

  it('immediately exposes busy + requestId, blocks duplicates and waits for real refresh before result', async () => {
    const { actions, host, callbacks, result, deps } = fixture();
    const write = deferred<ActionResult>(), refresh = deferred<RepositorySnapshot>();
    host.action.mockReturnValueOnce(write.promise);
    await actions.open('checkout', { target: 'topic' });
    const submitting = actions.submit();
    expect(actions.state.busy).toBe(true); expect(actions.state.requestId).toMatch(/^vue-action-/);
    expect(await actions.submit()).toBe(false);
    const local = createLocalChangesController(deps); expect(local.canWrite).toBe(false);
    await settle(); host.snapshot.mockReturnValueOnce(refresh.promise); write.resolve(result); await settle();
    expect(callbacks.onResult).not.toHaveBeenCalled(); expect(actions.state.busy).toBe(true);
    refresh.resolve(structuredClone(local.snapshot!)); expect(await submitting).toBe(true);
    expect(callbacks.onRefresh).toHaveBeenCalledBefore(callbacks.onResult); expect(actions.state.busy).toBe(false);
  });

  it.each(['repository', 'path', 'generation', 'roundTrip'] as const)('invalidates a retained menu binding after %s changes', async mode => {
    const { actions, context, roundTrip, host } = fixture(), item = actions.bind('checkout', { target: 'topic' });
    if (mode === 'repository') context.repo.id = 'B';
    else if (mode === 'path') context.repo.path = 'D:/another';
    else if (mode === 'generation') context.generation++;
    else roundTrip();
    expect(await item.open()).toBe(false); expect(host.action).not.toHaveBeenCalled();
  });

  it.each(['fingerprint', 'snapshot', 'generation', 'path', 'trust'] as const)('rejects a dangerous confirmation after %s changes', async mode => {
    const { actions, context, host } = fixture();
    await actions.open('reset', { target: 'HEAD', mode: 'hard' }); await actions.submit();
    expect(actions.state.phase).toBe('confirm'); expect(host.action).not.toHaveBeenCalled();
    if (mode === 'fingerprint') context.snapshot!.fingerprint = 'new';
    else if (mode === 'snapshot') context.snapshot = structuredClone(context.snapshot!);
    else if (mode === 'generation') context.generation++;
    else if (mode === 'path') context.repo.path = 'D:/another';
    else context.repo.trusted = false;
    expect(await actions.confirm()).toBe(false); expect(host.action).not.toHaveBeenCalled();
  });

  it.each(['untrusted', 'bare', 'busy', 'loading', 'operation', 'detached'] as const)('blocks checkout/history writes in %s context', async mode => {
    const { actions, context, host } = fixture();
    let kind: ActionKind = 'checkout';
    if (mode === 'untrusted') context.repo.trusted = false;
    else if (mode === 'bare') context.repo.bare = true;
    else if (mode === 'busy') context.busy = true;
    else if (mode === 'loading') context.loading = true;
    else if (mode === 'operation') context.snapshot!.working.operation = 'merge';
    else { context.repo.branch = null; context.snapshot!.working.branch = null; kind = 'merge'; }
    expect(await actions.open(kind)).toBe(false); expect(host.action).not.toHaveBeenCalled();
  });

  it('permits bare-compatible ref operations, but not blind continue or unresolved conflicts', async () => {
    const { actions, context } = fixture(); context.repo.bare = true;
    expect(await actions.open('branch-create', { name: 'topic' })).toBe(true); actions.close();
    context.repo.bare = false; expect(await actions.open('continue')).toBe(false);
    context.snapshot!.working.operation = 'merge'; context.snapshot!.working.conflicts = 1;
    expect(await actions.open('continue')).toBe(false);
  });

  it('does not execute an initial form whose real pre-write snapshot differs', async () => {
    const { actions, host, context, callbacks } = fixture();
    await actions.open('checkout', { target: 'topic' });
    host.snapshot.mockResolvedValueOnce({ ...context.snapshot!, fingerprint: 'changed-in-native' });
    expect(await actions.submit()).toBe(false); expect(host.action).not.toHaveBeenCalled(); expect(callbacks.onError).toHaveBeenCalled();
  });
});

describe('dynamic commit inspection and parameter semantics', () => {
  it('requires an actual merge mainline and pins execution to the inspected OID', async () => {
    const { actions, host } = fixture(); host.commitDetail.mockResolvedValue(detail('c'.repeat(40), ['d'.repeat(40), 'e'.repeat(40)]));
    await actions.open('cherry-pick', { target: 'topic' });
    expect(await actions.submit()).toBe(false); expect(host.action).not.toHaveBeenCalled();
    await actions.setValue('mode', 'mainline:3'); expect(await actions.submit()).toBe(false);
    await actions.setValue('mode', 'mainline:2'); expect(await actions.submit()).toBe(true);
    expect(host.action).toHaveBeenCalledWith(expect.objectContaining({ target: 'c'.repeat(40), mode: 'mainline:2' }));
  });

  it('invalidates previous parents immediately and ignores out-of-order detail responses', async () => {
    const { actions, host } = fixture(); await actions.open('revert', { target: 'topic' });
    const first = deferred<CommitDetail>(), second = deferred<CommitDetail>();
    host.commitDetail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const old = actions.setValue('target', 'old-target');
    expect(actions.state.inspecting).toBe(true); expect(await actions.submit()).toBe(false);
    const newest = actions.setValue('target', 'new-target');
    second.resolve(detail('d'.repeat(40), ['e'.repeat(40), 'f'.repeat(40)])); await newest;
    first.resolve(detail('0'.repeat(40))); await old;
    expect(actions.state.detail!.commit.oid).toBe('d'.repeat(40)); expect(actions.state.inspectedTarget).toBe('new-target');
    expect(actions.fields.find(field => field.name === 'mode')?.options).toHaveLength(3);
  });

  it('does not continue a stale commit-inspector or identity read after A → B → A', async () => {
    const { actions, host, roundTrip, callbacks } = fixture(); const read = deferred<CommitDetail>();
    host.commitDetail.mockReturnValueOnce(read.promise);
    const opening = actions.open('drop', { target: 'topic' }); roundTrip(); read.resolve(detail()); await opening;
    expect(actions.state.detail).toBeNull(); expect(host.action).not.toHaveBeenCalled(); expect(callbacks.onError).not.toHaveBeenCalled();
    actions.close();
    // A stale completion must not create a new form or issue any write.
    expect(actions.state.open).toBe(false);
  });

  it('offers a real external terminal, never fake drop success for roots or merges', async () => {
    const { actions, host, callbacks } = fixture(); host.commitDetail.mockResolvedValue(detail('c'.repeat(40), []));
    await actions.open('drop', { target: 'root' }); expect(actions.state.phase).toBe('external');
    expect(actions.state.externalCommand).toContain('--root');
    await actions.openTerminal(); expect(host.openTerminal).toHaveBeenCalledExactlyOnceWith('A');
    expect(host.action).not.toHaveBeenCalled(); expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it.each([
    ['merge', { target: 'topic', squash: true, noFastForward: true }],
    ['pull', { pruneTags: true, prune: false }],
    ['branch-delete', { target: 'main' }],
    ['fetch-into', { target: 'topic', branch: 'main' }],
    ['checkout-remote', { target: 'origin/other', name: 'topic' }],
    ['tag-create', { name: 'v1', tagType: 'lightweight', message: 'annotation' }],
    ['cherry-pick', { target: 'topic', recordOrigin: true, noCommit: true }],
    ['branch-create', { name: 'invalid..name' }],
    ['checkout', { target: '--dangerous' }],
    ['remote-branch-delete', { target: 'HEAD' }],
  ] as [ActionKind, Partial<GitAction>][])('validates incompatible/unsafe parameters for %s', async (kind, preset) => {
    const { actions, host } = fixture(); await actions.open(kind, preset); expect(await actions.submit()).toBe(false); expect(host.action).not.toHaveBeenCalled();
  });

  it('transforms reference whitespace, signing and conditional fields without losing false values', async () => {
    const { actions, host, context } = fixture(); context.settings.referenceSpace = 'hyphen';
    await actions.open('tag-create', { name: 'my tag', pushAfter: false, sign: false });
    expect(actions.fields.some(field => field.name === 'remote')).toBe(false);
    await actions.submit(); expect(host.action).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-tag', tagType: 'annotated', sign: false, pushAfter: false }));
    expect(host.action.mock.calls[0][0]).not.toHaveProperty('remote');
    actions.close(); await actions.open('pull', { mode: 'merge', squash: true }); await actions.setValue('noFastForward', false);
    await actions.setValue('mode', 'rebase'); await actions.submit();
    expect(host.action.mock.calls.at(-1)![0]).toMatchObject({ mode: 'rebase', ignoreDate: true, preserveMerges: false });
    expect(host.action.mock.calls.at(-1)![0]).not.toHaveProperty('squash');
  });

  it('loads real identity defaults and separately confirms global configuration', async () => {
    const { actions, host } = fixture(); await actions.open('identity');
    expect(actions.state.values).toMatchObject({ name: 'Test', email: 'test@example.com', global: false });
    await actions.setValue('global', true); await actions.submit(); expect(host.action).not.toHaveBeenCalled();
    await actions.confirm(); expect(host.action).toHaveBeenCalledWith(expect.objectContaining({ kind: 'identity', global: true, mode: 'confirmed-global' }));
  });
});

describe('real clean preview, external sessions and failure refresh', () => {
  it('saves the native preview token and deletes only with the latest revalidated native token', async () => {
    const { actions, host, callbacks } = fixture({ nativeCleanPreview: true, cleanOutput: 'Would remove exact name.txt\n' });
    await actions.open('clean'); await actions.submit();
    const token = actions.state.cleanPreview!.token;
    expect(token).toBe('native-clean-preview-1');
    expect(host.action).toHaveBeenCalledWith(expect.objectContaining({ mode: 'preview', force: false }));
    expect(callbacks.onResult).not.toHaveBeenCalled(); expect(callbacks.onRefresh).not.toHaveBeenCalled();
    expect(await actions.confirm(token)).toBe(true);
    expect(host.action.mock.calls.map(([value]) => value.mode)).toEqual(['preview', 'preview', 'delete']);
    expect(host.action.mock.calls[2][0]).toMatchObject({ mode: 'delete', force: true, cleanPreviewToken: 'native-clean-preview-2' });
    expect(host.action.mock.calls[0][0]).not.toHaveProperty('cleanPreviewToken');
    expect(host.action.mock.calls[1][0]).not.toHaveProperty('cleanPreviewToken');
    expect(callbacks.onRefresh).toHaveBeenCalledOnce();
    expect(await actions.confirm(token)).toBe(false); expect(host.action).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, '', '   '])('fails closed when the initial native preview has no usable token: %s', async previewToken => {
    const { actions, host, callbacks } = fixture();
    host.action.mockResolvedValueOnce({ output: 'Would remove A\n', operation: null, previewToken });
    await actions.open('clean'); expect(await actions.submit()).toBe(false);
    expect(actions.state.cleanPreview).toBeNull(); expect(actions.state.confirmation).toBeNull();
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'CLEAN_PREVIEW_UNAVAILABLE' }), expect.objectContaining({ repoId: 'A' }));
    expect(await actions.confirm()).toBe(false);
    expect(host.action.mock.calls.map(([action]) => action.mode)).toEqual(['preview']);
    expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '   '])('never falls back to the first token if the second native preview has no usable token: %s', async previewToken => {
    const { actions, host, callbacks } = fixture({ nativeCleanPreview: true });
    await actions.open('clean'); await actions.submit(); const token = actions.state.cleanPreview!.token;
    host.action.mockResolvedValueOnce({ output: 'Would remove literal.txt\n', operation: null, previewToken });
    expect(await actions.confirm(token)).toBe(false);
    expect(host.action.mock.calls.map(([action]) => action.mode)).toEqual(['preview', 'preview']);
    expect(actions.state.cleanPreview).toBeNull();
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'CLEAN_PREVIEW_UNAVAILABLE' }), expect.objectContaining({ repoId: 'A' }));
    expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it('forwards native token rejection and refreshes without retrying unsafe deletion', async () => {
    const { actions, host, callbacks } = fixture({ nativeCleanPreview: true });
    await actions.open('clean'); await actions.submit();
    const error = { code: 'CLEAN_PREVIEW_EXPIRED', message: 'Native preview grant expired' };
    host.action.mockResolvedValueOnce({ output: 'Would remove literal.txt\n', operation: null, previewToken: 'latest-native-token' }).mockRejectedValueOnce(error);
    expect(await actions.confirm()).toBe(false);
    expect(host.action.mock.calls[2][0]).toMatchObject({ mode: 'delete', cleanPreviewToken: 'latest-native-token' });
    expect(host.action).toHaveBeenCalledTimes(3); expect(callbacks.onRefresh).toHaveBeenCalledOnce(); expect(callbacks.onResult).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith(error, expect.objectContaining({ repoId: 'A' }));
  });

  it.each(['wrong-token', 'changed-output', 'changed-fingerprint', 'back-and-retry'] as const)('never deletes clean targets after %s', async mode => {
    const { actions, host, context } = fixture({ nativeCleanPreview: true, cleanOutput: 'Would remove A\n' });
    await actions.open('clean'); await actions.submit(); const token = actions.state.cleanPreview!.token;
    if (mode === 'changed-output') host.action.mockResolvedValueOnce({ output: 'Would remove B\n', operation: null, previewToken: 'native-changed-preview' });
    else if (mode === 'changed-fingerprint') context.snapshot!.fingerprint = 'new';
    else if (mode === 'back-and-retry') actions.back();
    expect(await actions.confirm(mode === 'wrong-token' ? 'forged' : token)).toBe(false);
    expect(host.action.mock.calls.some(([value]) => value.mode === 'delete')).toBe(false);
  });

  it('does not turn an empty dry-run into an irreversible action', async () => {
    const { actions, host } = fixture({ nativeCleanPreview: true, cleanOutput: '' });
    await actions.open('clean'); await actions.submit(); expect(actions.state.confirmation).toBeNull(); expect(host.action).toHaveBeenCalledOnce();
  });

  it.each([{ status: 'started', sessionId: 'native-session', operation: null }, { sessionId: 'native-session', operation: null }, { operation: 'rebase' }] as const)('reports external/paused result as non-success %#', async result => {
    const { actions, host, callbacks } = fixture(); host.action.mockResolvedValue({ output: 'Native session', ...result });
    await actions.open('rebase', { target: 'topic', interactive: true }); await actions.submit();
    expect(await actions.confirm()).toBe(false);
    expect(callbacks.onResult.mock.calls[0][0].status).toBe(result.operation ? 'paused' : 'started');
    expect(actions.state.phase).toBe('result'); expect(callbacks.onRefresh).toHaveBeenCalledOnce();
  });

  it('refreshes real state after a rejected action and forwards the original error code', async () => {
    const { actions, host, callbacks } = fixture(); const error = { code: 'GIT_FAILED', message: 'Native conflict' };
    host.action.mockRejectedValue(error); await actions.open('pull', { mode: 'ff-only' }); expect(await actions.submit()).toBe(false);
    expect(callbacks.onRefresh).toHaveBeenCalledOnce(); expect(callbacks.onResult).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith(error, expect.objectContaining({ repoId: 'A' }));
    expect(host.action).toHaveBeenCalledOnce();
  });

  it('cancels by the in-flight requestId, refreshes and never reports completed', async () => {
    const { actions, host, callbacks, result } = fixture(); const write = deferred<ActionResult>(); host.action.mockReturnValueOnce(write.promise);
    await actions.open('checkout', { target: 'topic' }); const pending = actions.submit(); await settle();
    const requestId = actions.state.requestId; await actions.cancel(); expect(host.cancel).toHaveBeenCalledExactlyOnceWith(requestId);
    write.resolve(result); expect(await pending).toBe(false); expect(callbacks.onRefresh).toHaveBeenCalledOnce(); expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it('ignores stale write completion after activation changes without applying old state', async () => {
    const { actions, host, callbacks, result, roundTrip } = fixture(); const write = deferred<ActionResult>(); host.action.mockReturnValueOnce(write.promise);
    await actions.open('checkout', { target: 'topic' }); const pending = actions.submit(); await settle();
    roundTrip(); write.resolve(result); expect(await pending).toBe(false); expect(callbacks.onRefresh).not.toHaveBeenCalled(); expect(callbacks.onResult).not.toHaveBeenCalled();
  });

  it('renders refreshed success without a spurious stale-intent warning', async () => {
    const { actions } = fixture(); await actions.open('checkout', { target: 'topic' }); await actions.submit();
    expect(actions.state.phase).toBe('result');
    const html = await renderToString(createSSRApp({ render: () => h(ActionDialog, { controller: actions }) }));
    expect(html).toContain('Operation completed and repository refreshed.');
    expect(html).not.toContain('The repository, activation or displayed snapshot changed.');
  });

  it('renders controlled dialog fields without old DOM mounting or hardcoded-only labels', async () => {
    const { actions } = fixture(); await actions.open('branch-create', { name: 'topic' }); initI18n('zh-CN');
    const html = await renderToString(createSSRApp({ render: () => h(ActionDialog, { controller: actions }) }));
    expect(html).toContain('workflow-dialog'); expect(html).toContain('新分支名称');
    expect(html).toContain('name="target"'); expect(html).toContain('D:/test/A');
    expect(resolveText(actions.title)).toBe('创建分支');
    expect(resolveText(actions.fields[0].label)).toBe('新分支名称');
  });
});

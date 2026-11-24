import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ActionKind, type ActionResult, type CommitDetail, type Host, type Repository } from '../src/shared/protocol';
import { GitActions, type ActionCallbacks, type ActionContext } from '../src/ui/actions';
import { button, confirmDialog, el, formDialog, textDialog, type FormValues } from '../src/ui/dom';

vi.mock('../src/ui/dom', () => ({ button: vi.fn(), confirmDialog: vi.fn(), el: vi.fn(), formDialog: vi.fn(), textDialog: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function repository(id = 'A', trusted = true): Repository {
  return { id, name: id, path: `D:/${id}`, gitDir: `D:/${id}/.git`, commonDir: `D:/${id}/.git`, head: '1'.repeat(40), branch: 'main', bare: false, trusted };
}
function detail(parents = ['2'.repeat(40)]): CommitDetail {
  return { commit: { oid: '1'.repeat(40), parents, author: 'Test', email: 'test@example.com', authoredAt: 0, committedAt: 0, subject: 'Test', refs: [] }, body: '', committer: 'Test', committerEmail: 'test@example.com', signature: { status: '', signer: '', key: '' }, files: [], base: parents[0] ?? null };
}
const result: ActionResult = { output: '', operation: null };
function fixture(trusted = true) {
  const context: ActionContext = {
    repo: repository('A', trusted), generation: 1, settings: structuredClone(DEFAULT_SETTINGS), selected: '1'.repeat(40),
    refs: [{ name: 'main', fullName: 'refs/heads/main', oid: '1'.repeat(40), kind: 'branch', upstream: 'origin/main', current: true, subject: '' }],
    remotes: [{ name: 'origin', fetchUrl: 'https://example.com/repo', pushUrl: 'https://example.com/repo' }], stashes: [],
    working: { files: [], branch: 'main', ahead: 0, behind: 0, conflicts: 0, operation: null },
  };
  // Only fake host methods are reachable: these tests never invoke Git, trust storage or a real terminal.
  const host = {
    action: vi.fn<Host['action']>().mockResolvedValue(result),
    trustRepository: vi.fn<Host['trustRepository']>().mockResolvedValue(undefined),
    commitDetail: vi.fn<Host['commitDetail']>().mockResolvedValue(detail()),
    repoConfig: vi.fn<Host['repoConfig']>().mockResolvedValue({ userName: 'Test', userEmail: 'test@example.com', globalUserName: '', globalUserEmail: '', signingKey: '', signCommits: false }),
    openTerminal: vi.fn<Host['openTerminal']>().mockResolvedValue(undefined),
  };
  const callbacks = { context: () => context, execute: vi.fn<ActionCallbacks['execute']>((action, _label) => host.action(action)), error: vi.fn(), changed: vi.fn(), toast: vi.fn() };
  const actions = new GitActions(host as unknown as Host, callbacks);
  function activate(id: string, nextTrusted = trusted): Repository {
    context.repo = repository(id, nextTrusted);
    if (context.generation !== undefined) context.generation++;
    return context.repo;
  }
  function roundTrip(): Repository { activate('B'); return activate('A'); }
  return { actions, context, host, callbacks, activate, roundTrip };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('document', { querySelector: vi.fn(() => null) });
  vi.mocked(el).mockImplementation(() => ({ value: '' }) as unknown as HTMLElement);
  vi.mocked(button).mockReturnValue({} as HTMLButtonElement);
  vi.mocked(formDialog).mockResolvedValue(null);
  vi.mocked(confirmDialog).mockResolvedValue(false);
  vi.mocked(textDialog).mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('action menu bindings', () => {
  it.each(['repository', 'path', 'generation', 'A → B → A'] as const)('ignores an item after its %s changes', async change => {
    const { actions, context, callbacks, host, activate, roundTrip } = fixture();
    const item = actions.item('branch-create', { name: 'topic' })!;
    const show = vi.spyOn(actions, 'show').mockResolvedValue(undefined);
    if (change === 'repository') activate('B');
    else if (change === 'path') context.repo!.path = 'D:/different-path-with-the-same-id';
    else if (change === 'generation') context.generation!++;
    else roundTrip();
    item.action(); await settle();
    expect(show).not.toHaveBeenCalled(); expect(callbacks.execute).not.toHaveBeenCalled();
    expect(host.trustRepository).not.toHaveBeenCalled(); expect(formDialog).not.toHaveBeenCalled();
  });
  it('does not turn an item created without a repository into an action for a later repository', () => {
    const { actions, context, activate } = fixture(); context.repo = null;
    const item = actions.item('branch-create')!; expect(item.disabled).toBe(true);
    const show = vi.spyOn(actions, 'show').mockResolvedValue(undefined);
    activate('A'); item.action(); expect(show).not.toHaveBeenCalled();
  });
  it('keeps a current legacy item usable when generation is not supplied', () => {
    const { actions, context } = fixture(); delete context.generation;
    const item = actions.item('branch-create', { name: 'topic' })!;
    const show = vi.spyOn(actions, 'show').mockResolvedValue(undefined);
    item.action(); expect(show).toHaveBeenCalledExactlyOnceWith('branch-create', { name: 'topic' });
  });
});

describe('trust confirmation and late completion', () => {
  it('rechecks identity and generation after confirmation, even after returning to the same repository', async () => {
    const { actions, context, callbacks, host, roundTrip } = fixture(false), confirmation = deferred<boolean>();
    const original = context.repo!; vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    const trusting = actions.trust(); const reopened = roundTrip(); confirmation.resolve(true);
    expect(await trusting).toBe(false); expect(host.trustRepository).not.toHaveBeenCalled();
    expect(original.trusted).toBe(false); expect(reopened.trusted).toBe(false); expect(callbacks.changed).not.toHaveBeenCalled();
  });
  it('does not mark either stale or reopened objects trusted or continue a dialog after late trust', async () => {
    const { actions, context, callbacks, host, roundTrip } = fixture(false), pending = deferred<void>();
    const original = context.repo!; vi.mocked(confirmDialog).mockResolvedValueOnce(true); host.trustRepository.mockReturnValueOnce(pending.promise);
    const showing = actions.show('branch-create'); await settle();
    expect(host.trustRepository).toHaveBeenCalledExactlyOnceWith('A', true);
    const reopened = roundTrip(); pending.resolve(undefined); await showing;
    expect(original.trusted).toBe(false); expect(reopened.trusted).toBe(false);
    expect(callbacks.changed).not.toHaveBeenCalled(); expect(callbacks.execute).not.toHaveBeenCalled(); expect(formDialog).not.toHaveBeenCalled();
  });
  it('marks the current validated object, not a replaced snapshot with the same identity and generation', async () => {
    const { actions, context, callbacks, host } = fixture(false), pending = deferred<void>();
    const original = context.repo!; vi.mocked(confirmDialog).mockResolvedValueOnce(true); host.trustRepository.mockReturnValueOnce(pending.promise);
    const trusting = actions.trust(); await settle(); context.repo = { ...original }; pending.resolve(undefined);
    expect(await trusting).toBe(true); expect(original.trusted).toBe(false); expect(context.repo.trusted).toBe(true); expect(callbacks.changed).toHaveBeenCalledOnce();
  });
  it('ignores a trust failure belonging to an obsolete activation', async () => {
    const { actions, callbacks, host, roundTrip } = fixture(false), pending = deferred<void>();
    vi.mocked(confirmDialog).mockResolvedValueOnce(true); host.trustRepository.mockReturnValueOnce(pending.promise);
    const trusting = actions.trust(); await settle(); roundTrip(); pending.reject(new Error('late trust failure'));
    expect(await trusting).toBe(false); expect(callbacks.error).not.toHaveBeenCalled(); expect(callbacks.changed).not.toHaveBeenCalled();
  });
});

describe('dialog and read await boundaries', () => {
  it('stops after the trust await even when the repository was already trusted', async () => {
    const { actions, callbacks, roundTrip } = fixture();
    const showing = actions.show('branch-create'); roundTrip(); await showing;
    expect(formDialog).not.toHaveBeenCalled(); expect(callbacks.execute).not.toHaveBeenCalled();
  });
  it.each(['generation', 'path'] as const)('rejects a submitted form after its %s changes', async change => {
    const { actions, context, callbacks, roundTrip } = fixture(), dialog = deferred<FormValues | null>();
    if (change === 'path') delete context.generation;
    vi.mocked(formDialog).mockReturnValueOnce(dialog.promise);
    const showing = actions.show('branch-create'); await settle(); expect(formDialog).toHaveBeenCalledOnce();
    if (change === 'path') context.repo!.path = 'D:/another-path'; else roundTrip();
    dialog.resolve({ name: 'topic', target: 'HEAD' }); await showing;
    expect(callbacks.execute).not.toHaveBeenCalled(); expect(callbacks.error).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'] as const)('discards a late commit detail %s after A → B → A', async outcome => {
    const { actions, host, callbacks, roundTrip } = fixture(), pending = deferred<CommitDetail>();
    host.commitDetail.mockReturnValueOnce(pending.promise);
    const showing = actions.show('cherry-pick'); await settle(); expect(host.commitDetail).toHaveBeenCalledOnce();
    roundTrip(); if (outcome === 'resolve') pending.resolve(detail()); else pending.reject(new Error('old detail failure'));
    await showing; expect(formDialog).not.toHaveBeenCalled(); expect(callbacks.execute).not.toHaveBeenCalled(); expect(callbacks.error).not.toHaveBeenCalled();
  });
  it('discards late repository identity config before opening its form', async () => {
    const { actions, host, callbacks, roundTrip } = fixture(), pending = deferred<Awaited<ReturnType<Host['repoConfig']>>>();
    host.repoConfig.mockReturnValueOnce(pending.promise);
    const showing = actions.show('identity'); await settle(); expect(host.repoConfig).toHaveBeenCalledOnce();
    roundTrip(); pending.resolve({ userName: 'Old', userEmail: 'old@example.com', globalUserName: '', globalUserEmail: '', signingKey: '', signCommits: false });
    await showing; expect(formDialog).not.toHaveBeenCalled(); expect(callbacks.execute).not.toHaveBeenCalled();
  });
  it.each(['input', 'timer', 'resolve', 'reject'] as const)('ignores obsolete dynamic parents at the %s boundary', async boundary => {
    vi.useFakeTimers();
    const { actions, host, callbacks, roundTrip } = fixture(), dialog = deferred<FormValues | null>(), pending = deferred<CommitDetail>();
    let input!: () => void;
    const target = { value: 'edited-target', addEventListener: vi.fn((_event: string, listener: () => void) => { input = listener; }) };
    const parents = { disabled: false, replaceChildren: vi.fn() }, submit = { dataset: {} };
    const form = { dataset: {}, querySelector: (selector: string) => selector === '[name="target"]' ? target : selector === '[name="mode"]' ? parents : submit };
    vi.mocked(document.querySelector).mockReturnValue(form as unknown as HTMLDialogElement);
    vi.mocked(formDialog).mockReturnValueOnce(dialog.promise); host.commitDetail.mockReturnValueOnce(Promise.resolve(detail())).mockReturnValueOnce(pending.promise);
    const showing = actions.show('cherry-pick'); await settle();
    if (boundary === 'input') { roundTrip(); input(); }
    else {
      input(); parents.replaceChildren.mockClear();
      if (boundary === 'timer') roundTrip();
      await vi.advanceTimersByTimeAsync(220);
      if (boundary === 'resolve' || boundary === 'reject') {
        expect(host.commitDetail).toHaveBeenCalledTimes(2); roundTrip();
        if (boundary === 'resolve') pending.resolve(detail(['2'.repeat(40), '3'.repeat(40)])); else pending.reject(new Error('old parents failure'));
        await settle();
      }
    }
    await vi.advanceTimersByTimeAsync(220);
    expect(host.commitDetail).toHaveBeenCalledTimes(boundary === 'resolve' || boundary === 'reject' ? 2 : 1);
    expect(parents.replaceChildren).not.toHaveBeenCalled(); expect(callbacks.error).not.toHaveBeenCalled();
    dialog.resolve(null); await showing; expect(callbacks.execute).not.toHaveBeenCalled();
  });
});

const confirmations: [ActionKind, FormValues][] = [
  ['push', { remote: 'origin', branch: 'main', force: true }],
  ['branch-delete', { target: 'topic', force: true }],
  ['fetch', { remote: 'origin', force: true, prune: true }],
  ['fetch-into', { remote: 'origin', target: 'topic', branch: 'topic', force: true }],
  ['remote-branch-delete', { remote: 'origin', target: 'topic' }],
  ['fetch', { remote: 'origin', prune: true }],
  ['fetch', { remote: 'origin', prune: true, pruneTags: true }],
  ['pull', { remote: 'origin', prune: true }],
  ['reset', { target: 'HEAD', mode: 'hard' }],
  ['identity', { name: 'Test', email: 'test@example.com', global: true }],
  ['commit', { message: 'Existing staged changes' }],
];
describe('confirmation and execute await boundaries', () => {
  it.each(confirmations)('rechecks %s confirmation before continuing or executing', async (kind, values) => {
    const { actions, callbacks, roundTrip } = fixture(), confirmation = deferred<boolean>();
    vi.mocked(formDialog).mockResolvedValueOnce(values); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    const showing = actions.show(kind); await settle(); expect(confirmDialog).toHaveBeenCalledOnce();
    roundTrip(); confirmation.resolve(true); await showing;
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(callbacks.execute).not.toHaveBeenCalled(); expect(callbacks.error).not.toHaveBeenCalled();
  });
  it('does not open clean confirmation after a late preview result', async () => {
    const { actions, callbacks, host, roundTrip } = fixture(), preview = deferred<ActionResult>();
    vi.mocked(formDialog).mockResolvedValueOnce({ includeIgnored: false }); host.action.mockReturnValueOnce(preview.promise);
    const showing = actions.show('clean'); await settle();
    expect(callbacks.execute).toHaveBeenCalledOnce(); expect(host.action.mock.calls[0][0]).toMatchObject({ repoId: 'A', kind: 'clean', mode: 'preview', force: false });
    roundTrip(); preview.resolve({ ...result, output: 'Would remove old-file.txt' }); await showing;
    expect(formDialog).toHaveBeenCalledOnce(); expect(callbacks.execute).toHaveBeenCalledOnce(); expect(callbacks.toast).not.toHaveBeenCalled();
  });
  it('does not delete files after a stale clean preview confirmation', async () => {
    const { actions, callbacks, host, roundTrip } = fixture(), confirmation = deferred<FormValues | null>();
    vi.mocked(formDialog).mockResolvedValueOnce({ includeIgnored: false }).mockReturnValueOnce(confirmation.promise);
    host.action.mockResolvedValueOnce({ ...result, output: 'Would remove old-file.txt' });
    const showing = actions.show('clean'); await settle(); expect(formDialog).toHaveBeenCalledTimes(2);
    roundTrip(); confirmation.resolve({}); await showing;
    expect(callbacks.execute).toHaveBeenCalledOnce(); expect(host.action).toHaveBeenCalledOnce();
  });
  it.each([null, { ...result, output: 'old result' }, { ...result, output: 'old session', status: 'started' as const, sessionId: 'old-session' }])('ignores late action results and drop fallback (%j)', async output => {
    const { actions, host, callbacks, roundTrip } = fixture(), pending = deferred<ActionResult | null>();
    vi.mocked(formDialog).mockResolvedValueOnce({ target: 'HEAD' }); callbacks.execute.mockReturnValueOnce(pending.promise);
    const showing = actions.show('drop'); await settle(); expect(callbacks.execute).toHaveBeenCalledOnce();
    roundTrip(); pending.resolve(output); await showing;
    expect(formDialog).toHaveBeenCalledOnce(); expect(host.openTerminal).not.toHaveBeenCalled(); expect(textDialog).not.toHaveBeenCalled(); expect(callbacks.toast).not.toHaveBeenCalled();
  });
  it('ignores a late fast-checkout result without opening a form or showing a stale toast', async () => {
    const { actions, context, host, callbacks, roundTrip } = fixture(), pending = deferred<ActionResult>();
    context.settings.confirmCheckout = false; host.action.mockReturnValueOnce(pending.promise);
    const showing = actions.show('checkout', { target: 'main' }); await settle(); expect(host.action).toHaveBeenCalledOnce();
    roundTrip(); pending.resolve({ ...result, output: 'Old checkout' }); await showing;
    expect(formDialog).not.toHaveBeenCalled(); expect(callbacks.toast).not.toHaveBeenCalled();
  });
});

describe('bound terminal callbacks', () => {
  it('does not open a terminal from an old commit dialog', async () => {
    const { actions, host, roundTrip } = fixture(), dialog = deferred<FormValues | null>();
    vi.mocked(formDialog).mockReturnValueOnce(dialog.promise);
    const showing = actions.show('commit'); await settle(); expect(button).toHaveBeenCalledOnce();
    roundTrip(); vi.mocked(button).mock.calls[0][1](); await settle(); expect(host.openTerminal).not.toHaveBeenCalled();
    dialog.resolve(null); await showing;
  });
  it('ignores late terminal errors from a previously current commit callback', async () => {
    const { actions, host, callbacks, roundTrip } = fixture(), dialog = deferred<FormValues | null>(), pending = deferred<void>();
    vi.mocked(formDialog).mockReturnValueOnce(dialog.promise); host.openTerminal.mockReturnValueOnce(pending.promise);
    const showing = actions.show('commit'); await settle(); vi.mocked(button).mock.calls[0][1]();
    expect(host.openTerminal).toHaveBeenCalledExactlyOnceWith('A'); roundTrip(); pending.reject(new Error('old terminal failure')); await settle();
    expect(callbacks.error).not.toHaveBeenCalled(); dialog.resolve(null); await showing;
  });
  it.each(['unsupported', 'failed'] as const)('rechecks an external drop %s confirmation', async source => {
    const { actions, host, callbacks, roundTrip } = fixture(), dialog = deferred<FormValues | null>();
    if (source === 'unsupported') { host.commitDetail.mockResolvedValueOnce(detail([])); vi.mocked(formDialog).mockReturnValueOnce(dialog.promise); }
    else { callbacks.execute.mockResolvedValueOnce(null); vi.mocked(formDialog).mockResolvedValueOnce({ target: 'HEAD' }).mockReturnValueOnce(dialog.promise); }
    const showing = actions.show('drop'); await settle(); expect(formDialog).toHaveBeenCalledTimes(source === 'unsupported' ? 1 : 2);
    roundTrip(); dialog.resolve({}); await showing; expect(host.openTerminal).not.toHaveBeenCalled(); expect(callbacks.toast).not.toHaveBeenCalled();
  });
  it('does not toast for a terminal whose opening completed after activation changed', async () => {
    const { actions, host, callbacks, roundTrip } = fixture(), pending = deferred<void>();
    host.commitDetail.mockResolvedValueOnce(detail([])); vi.mocked(formDialog).mockResolvedValueOnce({}); host.openTerminal.mockReturnValueOnce(pending.promise);
    const showing = actions.show('drop'); await settle(); expect(host.openTerminal).toHaveBeenCalledExactlyOnceWith('A');
    roundTrip(); pending.resolve(undefined); await showing; expect(callbacks.toast).not.toHaveBeenCalled();
  });
});

describe('unchanged current and legacy action contracts', () => {
  it('executes an ordinary legacy action with no generation', async () => {
    const { actions, context, host, callbacks } = fixture(); delete context.generation;
    vi.mocked(formDialog).mockResolvedValueOnce({ name: 'topic', target: 'HEAD', checkoutAfter: false });
    await actions.show('branch-create'); expect(host.action).toHaveBeenCalledExactlyOnceWith({ repoId: 'A', requestId: '', kind: 'branch-create', name: 'topic', target: 'HEAD', checkoutAfter: false });
    expect(callbacks.error).not.toHaveBeenCalled();
  });
  it('preserves ordinary commit follow-up mode and explicit signing without adding a local workflow', async () => {
    const { actions, host } = fixture();
    vi.mocked(formDialog).mockResolvedValueOnce({ message: 'Existing staged changes', signaturePolicy: 'no-sign' }); vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    await actions.show('commit'); expect(host.action).toHaveBeenCalledExactlyOnceWith({ repoId: 'A', requestId: '', kind: 'commit', message: 'Existing staged changes', sign: false, mode: 'follow-up', force: true });
  });
  it('still previews and deletes clean files when both confirmations remain current', async () => {
    const { actions, host } = fixture();
    vi.mocked(formDialog).mockResolvedValueOnce({ includeIgnored: true }).mockResolvedValueOnce({}); host.action.mockResolvedValueOnce({ ...result, output: 'Would remove file.txt' });
    await actions.show('clean'); expect(host.action.mock.calls.map(([action]) => action)).toEqual([
      { repoId: 'A', requestId: '', kind: 'clean', includeIgnored: true, mode: 'preview', force: false },
      { repoId: 'A', requestId: '', kind: 'clean', includeIgnored: true, mode: 'delete', force: true },
    ]);
  });
});

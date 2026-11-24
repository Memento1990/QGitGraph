import { shallowReactive } from 'vue';
import type {
  ActionKind, ActionResult, AppSettings, CommitDetail, GitAction, Host, Repository,
  RepositorySnapshot, SignaturePolicy, WorkingAction,
} from '../shared/protocol';
import { actionLabel, m } from '../i18n/actions';
import { errorText } from '../lib/format';
import { defineMessages, localized, LocalizedError, resolveText, type Localizable } from '../lib/i18n';

const localizedFailure = (message: Localizable): LocalizedError => new LocalizedError(localized(locale => resolveText(message, locale)));

/** An activation, not just a repository ID: reopening A after A → B → A is a different binding. */
export interface ActionBinding { repoId: string; path: string; generation: number }
export interface ControllerResult {
  binding: ActionBinding; action: GitAction | WorkingAction; result: ActionResult;
  status: 'completed' | 'started' | 'paused'; snapshot: RepositorySnapshot;
}
export interface ActionControllerDeps {
  host: Host;
  getRepository: () => Repository | null;
  getGeneration: () => number;
  getSnapshot: () => RepositorySnapshot | null;
  getSettings: () => AppSettings;
  /** Owner-side loading/write gates, excluding this controller's own busy flag. */
  getBusy?: () => boolean;
  getLoading?: () => boolean;
  getError?: () => unknown;
  /** Receives a real host.snapshot, including after failed/cancelled writes. Must apply it before resolving. */
  onRefresh: (snapshot: RepositorySnapshot, binding: ActionBinding) => void | Promise<void>;
  /** Called only after refresh; a started external session is never reported as completed. */
  onResult?: (result: ControllerResult) => void | Promise<void>;
  onError?: (error: unknown, binding: ActionBinding | null) => void;
}
export const controllerMessages = defineMessages('vue.actions', {
  cancel: 'Cancel', back: 'Back', confirm: 'Confirm operation', close: 'Close', running: 'Running Git operation…',
  busy: 'Another repository operation is running. Wait for it to finish.',
  stale: 'The repository, activation or displayed snapshot changed. Review the current state and try again.',
  untrusted: 'Trust this repository explicitly before running Git operations.',
  required: 'Complete every required field.', invalidChoice: 'Choose one of the available options.',
  confirmTitle: 'Review this operation', confirmHint: 'Review the exact repository, target and parameters before continuing.',
  completed: 'Operation completed and repository refreshed.', paused: 'Git stopped for review or conflict resolution. The workflow is not complete.',
  cancelled: 'Cancellation requested. Refresh and inspect the repository before retrying.',
  refreshing: 'Refreshing the real repository…', noSnapshot: 'Refresh the repository before running an operation.',
  cleanChanged: 'The clean preview changed or expired. Run a new dry-run preview; no deletion was requested.',
  cleanUnavailable: 'This host did not return a native Clean preview token. Safe deletion is unavailable; no deletion was requested.',
  target: 'Target', repository: 'Repository', parameters: 'Parameters', output: 'Git output',
  inspect: 'Inspected commit', preview: 'Dry-run preview',
}, {
  cancel: '取消', back: '返回', confirm: '确认操作', close: '关闭', running: '正在执行 Git 操作…',
  busy: '另一个仓库操作正在进行，请等待其结束。',
  stale: '仓库、激活代次或显示的快照已变化，请检查当前状态后重试。',
  untrusted: '执行 Git 操作前，请先明确信任此仓库。',
  required: '请填写所有必填字段。', invalidChoice: '请选择列表中的有效选项。',
  confirmTitle: '检查本次操作', confirmHint: '继续前请核对确切的仓库、目标和参数。',
  completed: '操作已完成，仓库已刷新。', paused: 'Git 已暂停，需检查或解决冲突；工作流尚未完成。',
  cancelled: '已请求取消，请刷新并检查仓库后再重试。',
  refreshing: '正在刷新真实仓库…', noSnapshot: '执行操作前请先刷新仓库。',
  cleanChanged: '清理预览已变化或失效，请重新试运行；未请求删除。',
  cleanUnavailable: '当前宿主未返回原生 Clean 预览令牌，无法安全删除；未请求删除。',
  target: '目标', repository: '仓库', parameters: '参数', output: 'Git 输出',
  inspect: '已检查的提交', preview: '试运行预览',
});

let requestSequence = 0;
export function controllerRequestId(prefix: string): string { return `vue-${prefix}-${Date.now()}-${++requestSequence}`; }
const writeLocks = new WeakMap<Host, { owner: symbol | null }>();
function lockFor(host: Host): { owner: symbol | null } {
  let lock = writeLocks.get(host);
  if (!lock) { lock = shallowReactive({ owner: null as symbol | null }); writeLocks.set(host, lock); }
  return lock;
}
export function controllerWriteBusy(deps: ActionControllerDeps, owner?: symbol): boolean {
  const active = lockFor(deps.host).owner;
  return Boolean(deps.getBusy?.() || active && active !== owner);
}
export function acquireControllerWrite(deps: ActionControllerDeps, owner: symbol): boolean {
  if (controllerWriteBusy(deps, owner)) return false;
  lockFor(deps.host).owner = owner; return true;
}
export function releaseControllerWrite(deps: ActionControllerDeps, owner: symbol): void {
  if (lockFor(deps.host).owner === owner) lockFor(deps.host).owner = null;
}
export function captureActionBinding(deps: ActionControllerDeps): ActionBinding | null {
  const repo = deps.getRepository();
  return repo ? { repoId: repo.id, path: repo.path, generation: deps.getGeneration() } : null;
}
export function actionBindingCurrent(deps: ActionControllerDeps, binding: ActionBinding): boolean {
  const repo = deps.getRepository();
  return repo?.id === binding.repoId && repo.path === binding.path && deps.getGeneration() === binding.generation;
}
/** Retain both identity and a value signature: even in-place DTO edits invalidate an intent. */
export interface ActionSnapshotCapture { binding: ActionBinding; snapshot: RepositorySnapshot; signature: string }
export function snapshotSignature(snapshot: RepositorySnapshot): string {
  return JSON.stringify([snapshot.fingerprint, snapshot.repository.id, snapshot.repository.path, snapshot.repository.head,
    snapshot.repository.branch, snapshot.repository.bare, snapshot.working, snapshot.refs, snapshot.remotes, snapshot.stashes]);
}
export function captureActionSnapshot(deps: ActionControllerDeps): ActionSnapshotCapture | null {
  const binding = captureActionBinding(deps), snapshot = deps.getSnapshot(), repo = deps.getRepository();
  return binding && snapshot && snapshot.repository.id === binding.repoId && snapshot.repository.path === binding.path
    && snapshot.repository.head === repo?.head ? { binding, snapshot, signature: snapshotSignature(snapshot) } : null;
}
export function actionSnapshotMatches(deps: ActionControllerDeps, capture: ActionSnapshotCapture): boolean {
  const repo = deps.getRepository(), snapshot = deps.getSnapshot();
  return actionBindingCurrent(deps, capture.binding) && snapshot === capture.snapshot && snapshotSignature(snapshot) === capture.signature
    && repo?.head === snapshot.repository.head && repo.branch === snapshot.repository.branch && repo.bare === snapshot.repository.bare;
}
export function actionSnapshotCurrent(deps: ActionControllerDeps, capture: ActionSnapshotCapture): boolean {
  return actionSnapshotMatches(deps, capture) && Boolean(deps.getRepository()?.trusted) && !deps.getLoading?.() && !deps.getError?.();
}
export async function verifyActionSnapshot(deps: ActionControllerDeps, capture: ActionSnapshotCapture, requestId: string): Promise<void> {
  if (!actionSnapshotCurrent(deps, capture)) throw new LocalizedError(controllerMessages.m('stale'));
  const fresh = await deps.host.snapshot(capture.binding.repoId, requestId);
  if (!actionSnapshotCurrent(deps, capture) || snapshotSignature(fresh) !== capture.signature) throw new LocalizedError(controllerMessages.m('stale'));
}
/** Never refresh a newly activated repository with the result of an obsolete request. */
export async function runControllerWrite(
  deps: ActionControllerDeps, capture: ActionSnapshotCapture, action: GitAction | WorkingAction,
  execute: () => Promise<ActionResult>, cancelled: () => boolean,
): Promise<ControllerResult | null> {
  if (!actionSnapshotCurrent(deps, capture) || cancelled()) throw new LocalizedError(controllerMessages.m('stale'));
  let result: ActionResult | undefined, failure: unknown, failed = false, changed = false;
  try { result = await execute(); changed = !actionSnapshotCurrent(deps, capture); }
  catch (error) { failed = true; failure = error; }
  if (!actionBindingCurrent(deps, capture.binding)) return null;
  let snapshot: RepositorySnapshot | undefined;
  try {
    // Watcher refresh is normally paused during a write, but a manually replaced DTO must also invalidate its result.
    changed ||= !actionSnapshotCurrent(deps, capture);
    snapshot = await deps.host.snapshot(capture.binding.repoId, controllerRequestId('refresh'));
    if (!actionBindingCurrent(deps, capture.binding)) return null;
    changed ||= !actionSnapshotCurrent(deps, capture);
    if (snapshot.repository.id !== capture.binding.repoId || snapshot.repository.path !== capture.binding.path) throw new LocalizedError(controllerMessages.m('stale'));
    await deps.onRefresh(snapshot, capture.binding);
  } catch (error) { if (!failed) { failed = true; failure = error; } }
  if (!actionBindingCurrent(deps, capture.binding)) return null;
  if (failed) throw failure;
  if (cancelled()) throw new LocalizedError(controllerMessages.m('cancelled'));
  if (changed) throw new LocalizedError(controllerMessages.m('stale'));
  if (!result || !snapshot) return null;
  const event: ControllerResult = {
    binding: capture.binding, action, result, snapshot,
    status: result.status === 'started' || result.sessionId ? 'started' : result.operation || snapshot.working.operation || snapshot.working.conflicts ? 'paused' : 'completed',
  };
  await deps.onResult?.(event);
  return actionBindingCurrent(deps, capture.binding) ? event : null;
}

export const ACTION_LABELS: Record<ActionKind, Localizable> = {
  'branch-create': actionLabel('branch-create'), 'branch-rename': actionLabel('branch-rename'), 'branch-delete': actionLabel('branch-delete'), checkout: actionLabel('checkout'),
  merge: actionLabel('merge'), rebase: actionLabel('rebase'), 'cherry-pick': actionLabel('cherry-pick'), revert: actionLabel('revert'), drop: actionLabel('drop'), reset: actionLabel('reset'),
  'tag-create': actionLabel('tag-create'), 'tag-delete': actionLabel('tag-delete'), 'tag-push': actionLabel('tag-push'),
  'stash-save': actionLabel('stash-save'), 'stash-apply': actionLabel('stash-apply'), 'stash-pop': actionLabel('stash-pop'), 'stash-drop': actionLabel('stash-drop'), 'stash-branch': actionLabel('stash-branch'),
  fetch: actionLabel('fetch'), pull: actionLabel('pull'), push: actionLabel('push'), 'remote-add': actionLabel('remote-add'), 'remote-edit': actionLabel('remote-edit'), 'remote-remove': actionLabel('remote-remove'), prune: actionLabel('prune'),
  'set-upstream': actionLabel('set-upstream'), clean: actionLabel('clean'), continue: actionLabel('continue'), abort: actionLabel('abort'), commit: actionLabel('commit'), identity: actionLabel('identity'),
  'remote-branch-delete': actionLabel('remote-branch-delete'), 'fetch-into': actionLabel('fetch-into'), 'checkout-remote': actionLabel('checkout-remote'),
};
export const ACTION_GROUPS: { id: string; label: Localizable; kinds: ActionKind[] }[] = [
  { id: 'branches', label: m('branches'), kinds: ['branch-create', 'branch-rename', 'branch-delete', 'checkout', 'checkout-remote', 'set-upstream'] },
  { id: 'history', label: m('history'), kinds: ['merge', 'rebase', 'cherry-pick', 'revert', 'drop', 'reset', 'commit'] },
  { id: 'tags', label: m('tags'), kinds: ['tag-create', 'tag-delete', 'tag-push'] },
  { id: 'stashes', label: m('stashes'), kinds: ['stash-save', 'stash-apply', 'stash-pop', 'stash-drop', 'stash-branch'] },
  { id: 'remotes', label: m('remotes'), kinds: ['fetch', 'fetch-into', 'pull', 'push', 'remote-branch-delete', 'prune', 'remote-add', 'remote-edit', 'remote-remove'] },
  { id: 'repository', label: m('repository'), kinds: ['clean', 'continue', 'abort', 'identity'] },
];
const DANGEROUS = new Set<ActionKind>(['branch-delete', 'remote-branch-delete', 'tag-delete', 'stash-drop', 'drop', 'reset', 'clean', 'abort', 'remote-remove', 'prune']);
const WORKTREE = new Set<ActionKind>(['checkout', 'checkout-remote', 'merge', 'rebase', 'cherry-pick', 'revert', 'drop', 'reset', 'pull', 'commit', 'clean', 'continue', 'abort', 'stash-save', 'stash-apply', 'stash-pop', 'stash-branch']);
const IDLE = new Set<ActionKind>(['checkout', 'checkout-remote', 'merge', 'rebase', 'cherry-pick', 'revert', 'drop', 'reset', 'pull', 'stash-save', 'stash-apply', 'stash-pop', 'stash-branch']);
const DYNAMIC = new Set<ActionKind>(['cherry-pick', 'revert', 'drop']);
export type ActionInitial = Partial<Omit<GitAction, 'repoId' | 'requestId' | 'kind'>>;
export type ActionValues = Record<string, string | boolean>;
export interface ActionOption { value: string; label: Localizable }
export interface ActionField {
  name: string; label: Localizable; type: 'text' | 'textarea' | 'checkbox' | 'select';
  value: string | boolean; required?: boolean; hint?: Localizable; options?: ActionOption[]; disabled?: boolean;
}
export interface ActionConfirmation { title: Localizable; descriptions: Localizable[]; action: GitAction; danger: boolean }
export interface ActionsState {
  open: boolean; kind: ActionKind | null; binding: ActionBinding | null;
  phase: 'closed' | 'form' | 'confirm' | 'running' | 'result' | 'external';
  busy: boolean; requestId: string | null; fields: ActionField[]; values: ActionValues;
  descriptions: Localizable[]; error: Localizable | null; notice: Localizable | null;
  inspecting: boolean; inspectedTarget: string; detail: CommitDetail | null;
  confirmation: ActionConfirmation | null; cleanPreview: { token: string; output: string } | null;
  result: ControllerResult | null; externalCommand: string | null;
}
export interface AvailableAction {
  kind: ActionKind; label: Localizable; group: string; danger: boolean; disabled: boolean; reason: Localizable | null;
  /** The closure retains its original repository/path/generation even when a menu remains open. */
  open: () => Promise<boolean>;
}
const text = (name: string, label: Localizable, value = '', required = false, hint?: Localizable): ActionField => ({ name, label, value, required, hint, type: 'text' });
const check = (name: string, label: Localizable, value = false, hint?: Localizable): ActionField => ({ name, label, value, hint, type: 'checkbox' });
const choice = (name: string, label: Localizable, options: ActionOption[], value: string, hint?: Localizable): ActionField => ({ name, label, options, value, hint, type: 'select', required: !options.some(option => option.value === '') });
const signature = (policy: SignaturePolicy, preset?: boolean): ActionField => choice('signaturePolicy', m('signing'), [
  { value: 'git', label: m('git') }, { value: 'sign', label: m('sign') }, { value: 'no-sign', label: m('noSign') },
], preset === undefined ? policy : preset ? 'sign' : 'no-sign');
export function signingValue(policy: string): boolean | undefined { return policy === 'sign' ? true : policy === 'no-sign' ? false : undefined; }

export function actionPreflight(kind: ActionKind, deps: ActionControllerDeps): Localizable | null {
  const repo = deps.getRepository(), snapshot = deps.getSnapshot();
  if (!repo) return m('openFirst');
  if (!repo.trusted) return controllerMessages.m('untrusted');
  if (!snapshot || snapshot.repository.id !== repo.id || snapshot.repository.path !== repo.path || snapshot.repository.head !== repo.head || deps.getLoading?.() || deps.getError?.()) return controllerMessages.m('noSnapshot');
  if (repo.bare && WORKTREE.has(kind)) return m('bare');
  const { working, refs, stashes, remotes } = snapshot;
  if (working.operation && IDLE.has(kind)) return m('busy', { operation: ACTION_LABELS[working.operation], action: ACTION_LABELS[kind] });
  if ((kind === 'continue' || kind === 'abort') && !working.operation) return m('noOperation');
  if (kind === 'continue' && working.conflicts) return m('conflicts');
  if (['merge', 'rebase', 'drop', 'pull', 'push'].includes(kind) && !repo.branch && !working.branch) return m('detached');
  if (['branch-rename', 'branch-delete', 'set-upstream'].includes(kind) && !refs.some(ref => ref.kind === 'branch')) return m('noBranches');
  if (['stash-apply', 'stash-pop', 'stash-drop', 'stash-branch'].includes(kind) && !stashes.length) return m('noStashes');
  if (['fetch', 'fetch-into', 'pull', 'push', 'tag-push', 'checkout-remote', 'remote-branch-delete', 'remote-edit', 'remote-remove', 'prune', 'set-upstream'].includes(kind) && !remotes.length) return m('noRemotes');
  return null;
}
function splitRemoteBranch(value: string, snapshot: RepositorySnapshot): { remote: string; branch: string } | null {
  const name = value.replace(/^refs\/remotes\//, '');
  const remote = [...snapshot.remotes].sort((a, b) => b.name.length - a.name.length).find(entry => name.startsWith(`${entry.name}/`));
  return remote ? { remote: remote.name, branch: name.slice(remote.name.length + 1) } : null;
}
function mainlineOptions(detail: CommitDetail | null): ActionOption[] {
  return detail && detail.commit.parents.length > 1 ? [{ value: '', label: m('chooseParent') }, ...detail.commit.parents.map((oid, index) => ({ value: `mainline:${index + 1}`, label: m('parent', { number: index + 1, oid: oid.slice(0, 12) }) }))] : [{ value: '', label: m('notMerge') }];
}

/** Vue state only. No DOM mounting and no imports from the isolated workflow prototype. */
export function createActionsController(deps: ActionControllerDeps) {
  const owner = Symbol('git-actions');
  const state = shallowReactive<ActionsState>({
    open: false, kind: null, binding: null, phase: 'closed', busy: false, requestId: null,
    fields: [], values: {}, descriptions: [], error: null, notice: null,
    inspecting: false, inspectedTarget: '', detail: null, confirmation: null, cleanPreview: null,
    result: null, externalCommand: null,
  });
  let capture: ActionSnapshotCapture | null = null, inspectionSequence = 0, cancelled = false, disposed = false;
  let prepared: GitAction | null = null;
  let cleanToken: { token: string; output: string; signature: string; action: GitAction } | null = null;
  function report(error: unknown, binding = state.binding): void {
    if (disposed || binding && !actionBindingCurrent(deps, binding)) return;
    state.error = errorText(error); deps.onError?.(error, binding);
  }
  function preflight(kind: ActionKind): Localizable | null {
    return deps.getSettings().hiddenActions.includes(kind) ? controllerMessages.m('invalidChoice')
      : controllerWriteBusy(deps, owner) ? controllerMessages.m('busy') : actionPreflight(kind, deps);
  }
  function assertCurrent(): ActionSnapshotCapture {
    if (disposed || !capture || !actionSnapshotCurrent(deps, capture) || cancelled) throw new LocalizedError(controllerMessages.m('stale'));
    const failure = state.kind && preflight(state.kind); if (failure) throw localizedFailure(failure);
    return capture;
  }
  function buildFields(kind: ActionKind, preset: ActionInitial, snapshot: RepositorySnapshot): ActionField[] {
    const repo = snapshot.repository, settings = deps.getSettings(), defaults = settings.dialogDefaults;
    const target = preset.target ?? 'HEAD', current = repo.branch ?? snapshot.working.branch ?? '';
    const branches = snapshot.refs.filter(ref => ref.kind === 'branch').map(ref => ({ value: ref.name, label: ref.name }));
    const remotes = snapshot.remotes.map(remote => ({ value: remote.name, label: remote.name }));
    const split = splitRemoteBranch(preset.target ?? '', snapshot);
    const remote = preset.remote ?? split?.remote ?? (remotes.some(entry => entry.value === settings.defaultRemote) ? settings.defaultRemote : remotes[0]?.value ?? settings.defaultRemote);
    const remoteTarget = preset.target ? split?.branch ?? preset.target : preset.branch ?? current;
    const stashes = snapshot.stashes.map(stash => ({ value: stash.selector, label: `${stash.selector} · ${stash.message}` }));
    const descriptions: Localizable[] = [current ? m('repoBranch', { name: repo.name, branch: current }) : m('repoDetached', { name: repo.name })];
    const fields: ActionField[] = [];
    switch (kind) {
      case 'branch-create': fields.push(text('name', m('newBranch'), preset.name ?? '', true), text('target', m('start'), target, true), check('checkoutAfter', m('checkoutAfter'), preset.checkoutAfter ?? defaults.checkoutAfterCreate)); break;
      case 'branch-rename': fields.push(choice('target', m('localBranch'), branches, preset.target?.replace(/^refs\/heads\//, '') ?? current), text('name', m('newBranch'), preset.name ?? '', true)); break;
      case 'branch-delete': fields.push(choice('target', m('localBranch'), branches, preset.target?.replace(/^refs\/heads\//, '') ?? current), check('force', m('deleteUnmerged'), preset.force ?? defaults.forceDelete, m('unmergedHint'))); break;
      case 'checkout': fields.push(text('target', m('checkoutTarget'), target, true, m('checkoutHint'))); break;
      case 'checkout-remote': fields.push(choice('remote', m('remote'), remotes, remote), text('target', m('sourceRemote'), remoteTarget, true), text('name', m('newLocal'), preset.name ?? split?.branch ?? remoteTarget, true, m('newLocalHint'))); break;
      case 'fetch-into': fields.push(choice('remote', m('remote'), remotes, remote), text('target', m('sourceRemote'), remoteTarget, true), text('branch', m('destination'), preset.branch ?? preset.name ?? split?.branch ?? '', true, m('destinationHint')), check('force', m('forceDestination'), preset.force ?? defaults.forceFetch)); break;
      case 'remote-branch-delete': fields.push(choice('remote', m('remote'), remotes, remote), text('target', m('deleteRemote'), remoteTarget, true)); descriptions.push(m('deleteRemoteHint')); break;
      case 'merge': fields.push(text('target', m('mergeFrom'), target, true), check('noFastForward', m('noFastForward'), preset.noFastForward ?? defaults.mergeNoFastForward), check('squash', m('squash'), preset.squash ?? defaults.mergeSquash), check('noCommit', m('noMergeCommit'), preset.noCommit ?? defaults.mergeNoCommit), choice('squashMessage', m('squashMessage'), [{ value: 'default', label: m('gitDefault') }, { value: 'summary', label: m('summary') }], preset.squashMessage ?? defaults.squashMessage), signature(settings.commitSigning, preset.sign)); break;
      case 'rebase': fields.push(text('target', m('rebaseOnto'), target, true), check('interactive', m('interactive'), preset.interactive ?? defaults.rebaseInteractive, m('interactiveHint')), check('ignoreDate', m('ignoreDate'), preset.ignoreDate ?? defaults.rebaseIgnoreDate), check('preserveMerges', m('preserveMerges'), preset.preserveMerges ?? defaults.rebasePreserveMerges), signature(settings.commitSigning, preset.sign)); descriptions.push(m('rebaseHint')); break;
      case 'cherry-pick': case 'revert':
        fields.push(text('target', m('commit'), target, true), choice('mode', m('mainline'), mainlineOptions(null), preset.mode ?? '', m('mainlineHint')), check('noCommit', m('noCommit'), preset.noCommit ?? defaults.noCommit));
        if (kind === 'cherry-pick') fields.push(check('recordOrigin', m('recordOrigin'), preset.recordOrigin ?? defaults.recordOrigin));
        fields.push(signature(settings.commitSigning, preset.sign)); descriptions.push(m(kind === 'revert' ? 'revertHint' : 'cherryHint')); break;
      case 'drop': fields.push(text('target', m('dropTarget'), target, true)); descriptions.push(m('dropHint')); break;
      case 'reset': fields.push(text('target', m('resetTarget'), target, true), choice('mode', m('resetMode'), [{ value: 'soft', label: m('soft') }, { value: 'mixed', label: m('mixed') }, { value: 'hard', label: m('hard') }, { value: 'keep', label: m('keep') }], preset.mode ?? defaults.resetMode)); break;
      case 'tag-create': fields.push(text('name', m('tagName'), preset.name ?? '', true), text('target', m('targetCommit'), target, true), choice('tagType', m('tagType'), [{ value: 'annotated', label: m('annotated') }, { value: 'lightweight', label: m('lightweight') }], preset.tagType ?? defaults.tagType), { ...text('message', m('annotation'), preset.message ?? ''), type: 'textarea' }, signature(settings.tagSigning, preset.sign), check('pushAfter', m('pushAfter'), preset.pushAfter ?? defaults.tagPush), choice('remote', m('pushRemote'), remotes, remote)); break;
      case 'tag-delete': case 'tag-push': fields.push(text('target', m('tagName'), preset.target ?? '', true)); if (kind === 'tag-push') fields.push(choice('remote', m('remote'), remotes, remote)); break;
      case 'stash-save': fields.push(text('message', m('stashMessage'), preset.message ?? ''), check('includeUntracked', m('includeUntracked'), preset.includeUntracked ?? defaults.stashIncludeUntracked), check('includeIgnored', m('includeIgnored'), preset.includeIgnored ?? false, m('ignoredHint'))); break;
      case 'stash-apply': case 'stash-pop': case 'stash-drop': case 'stash-branch': fields.push(choice('target', m('stash'), stashes, preset.target ?? stashes[0]?.value ?? '')); if (kind === 'stash-branch') fields.push(text('name', m('newBranch'), preset.name ?? '', true)); if (kind !== 'stash-drop') fields.push(check('reinstateIndex', m('reinstateIndex'), preset.reinstateIndex ?? defaults.reinstateIndex)); if (kind === 'stash-pop') descriptions.push(m('popHint')); break;
      case 'fetch': fields.push(choice('remote', m('remote'), [{ value: '', label: m('allRemotes') }, ...remotes], preset.remote ?? remote), check('force', m('forceRefs'), preset.force ?? defaults.forceFetch), check('prune', m('prune'), preset.prune ?? defaults.fetchPrune), check('pruneTags', m('pruneTags'), preset.pruneTags ?? defaults.fetchPruneTags, m('pruneTagsHint'))); break;
      case 'pull': fields.push(choice('remote', m('remote'), remotes, remote), text('branch', m('remoteBranch'), preset.branch ?? ''), choice('mode', m('integration'), [{ value: 'ff-only', label: m('ffOnly') }, { value: 'merge', label: m('merge') }, { value: 'rebase', label: m('rebase') }], preset.mode ?? defaults.pullMode), check('noFastForward', m('pullMerge'), preset.noFastForward ?? defaults.pullNoFastForward), check('squash', m('pullSquash'), preset.squash ?? defaults.pullSquash), choice('squashMessage', m('squashMessage'), [{ value: 'default', label: m('gitDefault') }, { value: 'summary', label: m('summary') }], preset.squashMessage ?? defaults.squashMessage), check('ignoreDate', m('pullDate'), preset.ignoreDate ?? defaults.rebaseIgnoreDate), check('preserveMerges', m('pullPreserve'), preset.preserveMerges ?? defaults.rebasePreserveMerges), check('prune', m('prune'), preset.prune ?? defaults.fetchPrune), check('pruneTags', m('pruneTags'), preset.pruneTags ?? defaults.fetchPruneTags), signature(settings.commitSigning, preset.sign)); break;
      case 'push': fields.push(choice('remote', m('remote'), remotes, remote), text('branch', m('localBranch'), preset.branch ?? current, true), check('setUpstream', m('setUpstream'), preset.setUpstream ?? false), check('force', m('forceLease'), preset.force ?? false, m('forceLeaseHint'))); break;
      case 'remote-add': fields.push(text('remote', m('remoteName'), preset.remote ?? '', true), text('url', m('fetchUrl'), preset.url ?? '', true)); break;
      case 'remote-edit': fields.push(choice('remote', m('remote'), remotes, remote), choice('mode', m('urlType'), [{ value: 'fetch', label: m('fetchUrl') }, { value: 'push', label: m('pushUrl') }], preset.mode ?? 'fetch'), text('url', m('newUrl'), preset.url ?? snapshot.remotes.find(entry => entry.name === remote)?.fetchUrl ?? '', true)); break;
      case 'remote-remove': case 'prune': fields.push(choice('remote', m('remote'), remotes, remote)); descriptions.push(m(kind === 'remote-remove' ? 'removeRemoteHint' : 'pruneRemoteHint')); break;
      case 'set-upstream': fields.push(choice('branch', m('localBranch'), branches, preset.branch ?? current), choice('remote', m('remote'), remotes, remote), text('target', m('remoteTarget'), split?.branch ?? preset.target ?? current, true)); break;
      case 'clean': fields.push(check('includeIgnored', m('cleanIgnored'), preset.includeIgnored ?? false, m('cleanIgnoredHint'))); descriptions.push(m('cleanHint')); break;
      case 'continue': descriptions.push(m('continueHint', { operation: snapshot.working.operation ? ACTION_LABELS[snapshot.working.operation] : 'Git' })); break;
      case 'abort': descriptions.push(m('abortHint', { operation: snapshot.working.operation ? ACTION_LABELS[snapshot.working.operation] : 'Git' })); break;
      case 'commit': fields.push({ ...text('message', m('commitMessage'), preset.message ?? '', true), type: 'textarea' }, signature(settings.commitSigning, preset.sign)); descriptions.push(m('commitDescription')); break;
      case 'identity': fields.push(text('name', m('name'), preset.name ?? '', true), text('email', m('email'), preset.email ?? '', true, m('emailHint')), check('global', m('globalIdentity'), preset.global ?? false)); descriptions.push(m('identityHint')); break;
      default: { const exhaustive: never = kind; throw new Error(String(exhaustive)); }
    }
    state.descriptions = descriptions; return fields;
  }
  function visibleFields(): ActionField[] {
    return state.fields.filter(field => {
      if (state.kind === 'tag-create' && field.name === 'remote') return Boolean(state.values.pushAfter);
      if (field.name === 'squashMessage') return Boolean(state.values.squash) && (state.kind !== 'pull' || state.values.mode === 'merge');
      if (state.kind === 'pull' && ['noFastForward', 'squash'].includes(field.name)) return state.values.mode === 'merge';
      if (state.kind === 'pull' && ['ignoreDate', 'preserveMerges'].includes(field.name)) return state.values.mode === 'rebase';
      return true;
    });
  }
  async function inspectTarget(): Promise<void> {
    if (!capture || !state.kind || !DYNAMIC.has(state.kind)) return;
    const saved = capture, sequence = ++inspectionSequence, target = String(state.values.target ?? '').trim();
    state.inspecting = true; state.detail = null; state.inspectedTarget = ''; state.error = null;
    state.fields = state.fields.map(field => field.name === 'mode' ? { ...field, disabled: true, options: [{ value: '', label: m('inspecting') }] } : field);
    try {
      const detail = await deps.host.commitDetail(saved.binding.repoId, target, controllerRequestId('inspect'));
      if (disposed || sequence !== inspectionSequence || !state.open || !actionSnapshotCurrent(deps, saved)) return;
      state.detail = detail; state.inspectedTarget = target;
      state.fields = state.fields.map(field => field.name === 'mode' ? { ...field, disabled: false, options: mainlineOptions(detail) } : field);
      if (state.kind === 'drop' && detail.commit.parents.length !== 1) showExternalDrop(detail, m('unsupportedDrop'));
    } catch (error) {
      if (!disposed && sequence === inspectionSequence && actionSnapshotCurrent(deps, saved)) state.error = m('cannotInspect', { detail: errorText(error) });
    } finally { if (sequence === inspectionSequence) state.inspecting = false; }
  }
  function showExternalDrop(detail: CommitDetail, reason: Localizable): void {
    state.phase = 'external'; state.notice = reason;
    state.externalCommand = detail.commit.parents[0] ? `git rebase --interactive --rebase-merges ${detail.commit.parents[0]}` : 'git rebase --interactive --root --rebase-merges';
  }
  async function open(kind: ActionKind, initial: ActionInitial = {}): Promise<boolean> {
    if (disposed || state.busy || state.open && !['result', 'closed'].includes(state.phase)) return false;
    const failure = preflight(kind); if (failure) { report(localizedFailure(failure), captureActionBinding(deps)); return false; }
    capture = captureActionSnapshot(deps); if (!capture) return false;
    cancelled = false; inspectionSequence++; prepared = null; cleanToken = null;
    Object.assign(state, { open: true, kind, binding: capture.binding, phase: 'form', error: null, notice: null, result: null,
      confirmation: null, cleanPreview: null, externalCommand: null, detail: null, inspectedTarget: '', inspecting: false });
    state.fields = buildFields(kind, initial, capture.snapshot);
    state.values = Object.fromEntries(state.fields.map(field => [field.name, field.value]));
    if (DYNAMIC.has(kind)) { await inspectTarget(); return Boolean(capture && actionSnapshotCurrent(deps, capture)); }
    if (kind === 'identity') {
      const saved = capture;
      state.busy = true; state.requestId = controllerRequestId('identity');
      try {
        const config = await deps.host.repoConfig(saved.binding.repoId, state.requestId);
        assertCurrent();
        state.values = { ...state.values, name: initial.name ?? (config.userName || config.globalUserName), email: initial.email ?? (config.userEmail || config.globalUserEmail) };
      } catch (error) { report(error, saved.binding); return false; }
      finally { state.busy = false; state.requestId = null; }
    }
    if (kind === 'checkout' && !deps.getSettings().confirmCheckout && initial.target
      && capture.snapshot.refs.some(ref => ref.kind === 'branch' && (ref.name === initial.target || ref.fullName === initial.target))) {
      return submit();
    }
    return true;
  }
  async function setValue(name: string, value: string | boolean): Promise<void> {
    if (state.busy || state.phase !== 'form' || !state.fields.some(field => field.name === name)) return;
    const field = state.fields.find(entry => entry.name === name)!;
    if (field.type === 'checkbox' ? typeof value !== 'boolean' : typeof value !== 'string') return;
    state.values = { ...state.values, [name]: value }; state.error = null; cleanToken = null; state.cleanPreview = null;
    if (state.kind === 'pull' && name === 'mode' && value !== 'merge') state.values = { ...state.values, noFastForward: false, squash: false };
    if (state.kind === 'remote-edit' && (name === 'remote' || name === 'mode')) {
      const remote = deps.getSnapshot()?.remotes.find(entry => entry.name === state.values.remote);
      if (remote) state.values = { ...state.values, url: state.values.mode === 'push' ? remote.pushUrl : remote.fetchUrl };
    }
    if (DYNAMIC.has(state.kind!) && name === 'target') { state.values = { ...state.values, mode: '' }; await inspectTarget(); }
  }
  function validate(): Localizable | null {
    const kind = state.kind, values = state.values, detail = state.detail, snapshot = capture?.snapshot;
    if (!kind || !snapshot) return controllerMessages.m('stale');
    for (const field of visibleFields()) {
      const value = values[field.name];
      if (field.required && !String(value ?? '').trim()) return controllerMessages.m('required');
      if (field.type === 'select' && !field.disabled && !field.options?.some(option => option.value === value)) return controllerMessages.m('invalidChoice');
    }
    if (DYNAMIC.has(kind) && (state.inspecting || !detail || state.inspectedTarget !== String(values.target).trim())) return m('stillInspecting');
    const current = snapshot.repository.branch ?? snapshot.working.branch ?? '';
    if (kind === 'merge' && values.squash && values.noFastForward) return m('squashConflict');
    if (kind === 'pull' && values.mode === 'merge' && values.squash && values.noFastForward) return m('pullSquashConflict');
    if ((kind === 'fetch' || kind === 'pull') && values.pruneTags && !values.prune) return m('pruneRequired');
    if (kind === 'branch-delete' && String(values.target).replace(/^refs\/heads\//, '') === current) return m('deleteCurrent');
    if (kind === 'fetch-into' && values.branch === current) return m('fetchCurrent');
    if (kind === 'checkout-remote' && snapshot.refs.some(ref => ref.kind === 'branch' && ref.name === normalizeName(String(values.name)))) return m('branchExists');
    if (kind === 'tag-create' && values.tagType === 'lightweight' && (values.signaturePolicy === 'sign' || values.message)) return m('lightweightError');
    if (kind === 'tag-create' && values.pushAfter && !snapshot.remotes.length) return m('tagRemoteRequired');
    if (kind === 'cherry-pick' && values.recordOrigin && values.noCommit) return m('originCommit');
    if (kind === 'cherry-pick' || kind === 'revert') {
      const count = detail?.commit.parents.length ?? 0, mode = /^mainline:(\d+)$/.exec(String(values.mode ?? ''));
      if (count > 1 && (!mode || Number(mode[1]) < 1 || Number(mode[1]) > count)) return m('actualParent');
      if (count <= 1 && values.mode) return m('mergeParentOnly');
    }
    if (kind === 'identity' && !/^[^\s@]+@[^\s@]+$/.test(String(values.email))) return m('invalidEmail');
    if (['branch-create', 'branch-rename', 'stash-branch', 'checkout-remote', 'tag-create'].includes(kind)) {
      const name = normalizeName(String(values.name ?? ''));
      if (!name || name === '@' || /[\s\u0000-\u001f\u007f~^:?*\[\\]|\.\.|@\{|^[-/]|[/.]$|\/\//.test(name) || name.split('/').some(part => part.startsWith('.') || /\.lock$/i.test(part))) return m('invalidName');
    }
    for (const key of ['target', 'remote', 'branch'] as const) if (String(values[key] ?? '').startsWith('-') || /[\u0000-\u001f\u007f]/.test(String(values[key] ?? ''))) return m('invalidArgument', { field: m(key === 'target' ? 'fieldTarget' : key === 'remote' ? 'fieldRemote' : 'fieldBranch') });
    if (['remote-branch-delete', 'checkout-remote', 'fetch-into'].includes(kind) && String(values.target).replace(/^refs\/remotes\//, '').replace(`${String(values.remote)}/`, '') === 'HEAD') return m('actualRemote');
    return null;
  }
  function normalizeName(name: string): string {
    const mode = deps.getSettings().referenceSpace;
    return mode === 'none' ? name : name.replace(/\s+/g, mode === 'hyphen' ? '-' : '_');
  }
  function buildAction(): GitAction {
    const kind = state.kind!, values = state.values;
    const action: GitAction = { repoId: state.binding!.repoId, requestId: '', kind };
    const strings = ['target', 'name', 'remote', 'branch', 'url', 'message', 'email', 'mode'] as const;
    const booleans = ['force', 'noCommit', 'noFastForward', 'squash', 'includeUntracked', 'includeIgnored', 'global', 'interactive', 'setUpstream', 'checkoutAfter', 'pushAfter', 'reinstateIndex', 'recordOrigin', 'ignoreDate', 'preserveMerges', 'prune', 'pruneTags'] as const;
    for (const key of strings) if (typeof values[key] === 'string' && (values[key] !== '' || key === 'remote')) action[key] = String(values[key]).trim();
    for (const key of booleans) if (typeof values[key] === 'boolean') action[key] = Boolean(values[key]);
    const sign = signingValue(String(values.signaturePolicy ?? 'git')); if (sign !== undefined) action.sign = sign;
    if (kind === 'tag-create') { action.tagType = values.tagType === 'lightweight' ? 'lightweight' : 'annotated'; if (!action.pushAfter) delete action.remote; }
    if ((kind === 'merge' || kind === 'pull') && action.squash) action.squashMessage = values.squashMessage === 'summary' ? 'summary' : 'default';
    if (kind === 'pull' && action.mode !== 'rebase') { delete action.ignoreDate; delete action.preserveMerges; }
    if (kind === 'pull' && action.mode !== 'merge') { delete action.noFastForward; delete action.squash; delete action.squashMessage; }
    if (['branch-create', 'branch-rename', 'stash-branch', 'checkout-remote', 'tag-create'].includes(kind) && action.name) action.name = normalizeName(action.name);
    if (DYNAMIC.has(kind) && state.detail) action.target = state.detail.commit.oid;
    if (kind === 'remote-branch-delete' || kind === 'reset' && action.mode === 'hard') action.force = true;
    if (kind === 'identity' && action.global) action.mode = 'confirmed-global';
    if (kind === 'commit') { action.mode = 'follow-up'; action.force = true; }
    return action;
  }
  function confirmations(action: GitAction): Localizable[] {
    const descriptions: Localizable[] = [];
    if (action.force && ['push', 'branch-delete', 'fetch', 'fetch-into'].includes(action.kind)) descriptions.push(action.kind === 'push' ? m('forcePush', { branch: action.branch, remote: action.remote }) : action.kind === 'branch-delete' ? m('unmergedBranch', { branch: action.target }) : m('forceFetch'));
    if (action.kind === 'remote-branch-delete') descriptions.push(m('deleteRemoteDescription', { remote: action.remote, branch: action.target }));
    if ((action.kind === 'fetch' || action.kind === 'pull') && (action.prune || action.pruneTags)) descriptions.push(m(action.pruneTags ? 'pruneTagsDescription' : 'pruneDescription'));
    if (action.kind === 'reset' && action.mode === 'hard') descriptions.push(m('hardDescription', { target: action.target }));
    if (action.kind === 'identity' && action.global) descriptions.push(m('identityDescription', { name: action.name, email: action.email }));
    if (action.kind === 'commit') descriptions.push(m('commitDescription'));
    if (action.kind === 'rebase') descriptions.push(m('rebaseHint'));
    if (DANGEROUS.has(action.kind) && !descriptions.length) descriptions.push(...state.descriptions, controllerMessages.m('confirmHint'));
    return descriptions;
  }
  function begin(prefix: string): boolean {
    if (state.busy || !acquireControllerWrite(deps, owner)) return false;
    state.busy = true; state.requestId = controllerRequestId(prefix); cancelled = false; state.error = null;
    return true;
  }
  function finish(): void { releaseControllerWrite(deps, owner); state.busy = false; state.requestId = null; }
  function nativeCleanToken(result: ActionResult): string {
    if (typeof result.previewToken !== 'string' || !result.previewToken.trim()) {
      throw Object.assign(new LocalizedError(controllerMessages.m('cleanUnavailable')), { code: 'CLEAN_PREVIEW_UNAVAILABLE' });
    }
    return result.previewToken;
  }
  async function previewClean(action: GitAction): Promise<boolean> {
    if (!begin('clean-preview')) return false;
    const saved = capture!;
    try {
      assertCurrent();
      await verifyActionSnapshot(deps, saved, state.requestId!); assertCurrent();
      const preview = await deps.host.action({ ...action, requestId: state.requestId!, mode: 'preview', force: false });
      assertCurrent();
      const token = nativeCleanToken(preview);
      await verifyActionSnapshot(deps, saved, state.requestId!); assertCurrent();
      if (!preview.output.trim()) { state.notice = m('noUntracked'); return false; }
      cleanToken = { token, output: preview.output, signature: saved.signature, action: { ...action } };
      state.cleanPreview = { token, output: preview.output };
      prepared = { ...action, mode: 'delete', force: true };
      state.confirmation = { title: m('deleteFilesTitle'), descriptions: [m('deleteFilesDescription')], danger: true, action: { ...prepared } };
      state.phase = 'confirm'; return true;
    } catch (error) { report(error, saved.binding); return false; }
    finally { finish(); }
  }
  async function execute(action: GitAction, token?: string): Promise<boolean> {
    if (!begin('action')) return false;
    const saved = capture!; state.phase = 'running';
    try {
      assertCurrent();
      await verifyActionSnapshot(deps, saved, state.requestId!); assertCurrent();
      if (action.kind === 'clean') {
        const preview = cleanToken; cleanToken = null; state.cleanPreview = null;
        if (!preview || preview.token !== token || preview.signature !== saved.signature
          || preview.action.includeIgnored !== action.includeIgnored || preview.action.includeUntracked !== action.includeUntracked) {
          throw new LocalizedError(controllerMessages.m('cleanChanged'));
        }
        const fresh = await deps.host.action({ ...preview.action, requestId: state.requestId!, mode: 'preview', force: false });
        assertCurrent();
        const freshToken = nativeCleanToken(fresh);
        if (fresh.output !== preview.output) throw new LocalizedError(controllerMessages.m('cleanChanged'));
        await verifyActionSnapshot(deps, saved, state.requestId!); assertCurrent();
        // A new native preview may invalidate the first token. Only the latest native grant authorizes deletion.
        action = { ...action, cleanPreviewToken: freshToken };
      }
      const submitted = { ...action, requestId: state.requestId! };
      const result = await runControllerWrite(deps, saved, submitted, () => deps.host.action(submitted), () => cancelled || disposed);
      if (!result) return false;
      state.result = result; state.phase = 'result'; state.confirmation = null;
      state.notice = result.status === 'started' ? m('externalStarted') : controllerMessages.m(result.status === 'paused' ? 'paused' : 'completed');
      return result.status === 'completed';
    } catch (error) {
      report(error, saved.binding);
      if (state.kind === 'drop' && state.detail && actionBindingCurrent(deps, saved.binding) && !cancelled) showExternalDrop(state.detail, m('dropFailed'));
      else if (!disposed) state.phase = 'form';
      return false;
    } finally { finish(); }
  }
  async function submit(): Promise<boolean> {
    if (state.busy || state.phase !== 'form') return false;
    try {
      assertCurrent(); const failure = validate(); if (failure) throw localizedFailure(failure);
      const action = buildAction();
      if (action.kind === 'clean') return await previewClean(action);
      const descriptions = confirmations(action);
      if (descriptions.length) {
        prepared = { ...action }; state.confirmation = { title: controllerMessages.m('confirmTitle'), descriptions, action: { ...action }, danger: DANGEROUS.has(action.kind) || Boolean(action.force || action.global) };
        state.phase = 'confirm'; state.error = null; return false;
      }
      return await execute(action);
    } catch (error) { report(error); return false; }
  }
  async function confirm(token = state.cleanPreview?.token): Promise<boolean> {
    if (state.busy || state.phase !== 'confirm' || !prepared) return false;
    try { assertCurrent(); return await execute({ ...prepared }, token); }
    catch (error) { cleanToken = null; state.cleanPreview = null; prepared = null; state.phase = 'form'; state.confirmation = null; report(error); return false; }
  }
  function back(): void {
    if (state.busy) return;
    prepared = null; cleanToken = null; state.cleanPreview = null; state.confirmation = null; state.phase = 'form'; state.error = null;
  }
  function close(): boolean {
    if (state.busy) return false;
    inspectionSequence++; state.open = false; state.phase = 'closed'; state.inspecting = false;
    cleanToken = null; prepared = null; capture = null; return true;
  }
  async function cancel(): Promise<void> {
    if (!state.busy || !state.requestId) { close(); return; }
    cancelled = true; cleanToken = null;
    try { await deps.host.cancel(state.requestId); } catch (error) { report(error); }
  }
  async function openTerminal(): Promise<void> {
    if (state.busy || !capture) return;
    const saved = capture;
    try {
      assertCurrent(); state.busy = true; state.requestId = controllerRequestId('terminal');
      await deps.host.openTerminal(saved.binding.repoId);
      if (!disposed && actionBindingCurrent(deps, saved.binding)) { state.notice = m('terminalOpened'); state.externalCommand = null; }
    } catch (error) { report(error, saved.binding); }
    finally { state.busy = false; state.requestId = null; }
  }
  function bind(kind: ActionKind, initial: ActionInitial = {}): AvailableAction {
    const binding = captureActionBinding(deps), preset = { ...initial }, reason = preflight(kind);
    return { kind, label: ACTION_LABELS[kind], group: ACTION_GROUPS.find(group => group.kinds.includes(kind))!.id, danger: DANGEROUS.has(kind), disabled: Boolean(reason || state.busy), reason,
      open: async () => binding && actionBindingCurrent(deps, binding) ? open(kind, preset) : false };
  }
  function dispose(): void { disposed = true; inspectionSequence++; cleanToken = null; prepared = null; state.open = false; if (state.requestId) { cancelled = true; void deps.host.cancel(state.requestId).catch(() => undefined); } }
  return {
    state: state as Readonly<ActionsState>, open, show: open, bind, setValue, submit, confirm, back, close, cancel, openTerminal, dispose,
    get available(): AvailableAction[] { return (Object.keys(ACTION_LABELS) as ActionKind[]).filter(kind => !deps.getSettings().hiddenActions.includes(kind)).map(kind => bind(kind)); },
    get fields(): ActionField[] { return visibleFields(); },
    get title(): Localizable { return state.kind ? ACTION_LABELS[state.kind] : controllerMessages.m('confirmTitle'); },
    get repository(): Repository | null { return deps.getRepository(); },
    get snapshot(): RepositorySnapshot | null { return deps.getSnapshot(); },
    get generation(): number { return deps.getGeneration(); },
    get busy(): boolean { return state.busy; },
    get stale(): boolean { return Boolean(capture && !actionSnapshotMatches(deps, capture)); },
  };
}
export type ActionsController = ReturnType<typeof createActionsController>;
export type GitActionsController = ActionsController;
export const createGitActionsController = createActionsController;

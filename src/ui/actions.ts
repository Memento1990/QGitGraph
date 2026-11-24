import type { ActionKind, ActionResult, AppSettings, CommitDetail, GitAction, GitRef, Host, Remote, Repository, SignaturePolicy, Stash, WorkingState } from '../shared/protocol';
import { errorMessage, errorText, numberText } from '../lib/format';
import { localized, LocalizedError, resolveText, type Localizable, type LocalizedMessage } from '../lib/i18n';
import { actionLabel, m } from '../i18n/actions';
import { button, confirmDialog, el, formDialog, textDialog, type FormField, type FormValues, type MenuItem } from './dom';
import type { IconName } from './icons';

export const ACTION_LABELS: Record<ActionKind, LocalizedMessage> = {
  'branch-create': actionLabel('branch-create'), 'branch-rename': actionLabel('branch-rename'), 'branch-delete': actionLabel('branch-delete'), checkout: actionLabel('checkout'),
  merge: actionLabel('merge'), rebase: actionLabel('rebase'), 'cherry-pick': actionLabel('cherry-pick'), revert: actionLabel('revert'), drop: actionLabel('drop'), reset: actionLabel('reset'),
  'tag-create': actionLabel('tag-create'), 'tag-delete': actionLabel('tag-delete'), 'tag-push': actionLabel('tag-push'),
  'stash-save': actionLabel('stash-save'), 'stash-apply': actionLabel('stash-apply'), 'stash-pop': actionLabel('stash-pop'), 'stash-drop': actionLabel('stash-drop'), 'stash-branch': actionLabel('stash-branch'),
  fetch: actionLabel('fetch'), pull: actionLabel('pull'), push: actionLabel('push'), 'remote-add': actionLabel('remote-add'), 'remote-edit': actionLabel('remote-edit'), 'remote-remove': actionLabel('remote-remove'), prune: actionLabel('prune'),
  'set-upstream': actionLabel('set-upstream'), clean: actionLabel('clean'), continue: actionLabel('continue'), abort: actionLabel('abort'), commit: actionLabel('commit'), identity: actionLabel('identity'),
  'remote-branch-delete': actionLabel('remote-branch-delete'), 'fetch-into': actionLabel('fetch-into'), 'checkout-remote': actionLabel('checkout-remote'),
};
export type ActionGroupId = 'branches' | 'history' | 'tags' | 'stashes' | 'remotes' | 'repository';
export const ACTION_GROUPS: { id: ActionGroupId; label: LocalizedMessage; kinds: ActionKind[] }[] = [
  { id: 'branches', label: m('branches'), kinds: ['branch-create', 'branch-rename', 'branch-delete', 'checkout', 'checkout-remote', 'set-upstream'] },
  { id: 'history', label: m('history'), kinds: ['merge', 'rebase', 'cherry-pick', 'revert', 'drop', 'reset', 'commit'] },
  { id: 'tags', label: m('tags'), kinds: ['tag-create', 'tag-delete', 'tag-push'] },
  { id: 'stashes', label: m('stashes'), kinds: ['stash-save', 'stash-apply', 'stash-pop', 'stash-drop', 'stash-branch'] },
  { id: 'remotes', label: m('remotes'), kinds: ['fetch', 'fetch-into', 'pull', 'push', 'remote-branch-delete', 'prune', 'remote-add', 'remote-edit', 'remote-remove'] },
  { id: 'repository', label: m('repository'), kinds: ['clean', 'continue', 'abort', 'identity'] },
];
export const ACTION_DATA_IDS: Partial<Record<ActionKind, string>> = {
  'branch-create': 'create-branch', 'branch-delete': 'delete-branch', 'branch-rename': 'rename-branch',
  'tag-create': 'create-tag', 'tag-delete': 'delete-tag', 'tag-push': 'push-tag',
};
const DANGEROUS = new Set<ActionKind>(['branch-delete', 'remote-branch-delete', 'tag-delete', 'stash-drop', 'drop', 'reset', 'clean', 'abort', 'remote-remove', 'prune']);
const NEEDS_WORKTREE = new Set<ActionKind>(['checkout', 'checkout-remote', 'merge', 'rebase', 'cherry-pick', 'revert', 'drop', 'reset', 'pull', 'commit', 'clean', 'continue', 'abort', 'stash-save', 'stash-apply', 'stash-pop', 'stash-branch']);
const NEEDS_IDLE = new Set<ActionKind>(['checkout', 'checkout-remote', 'merge', 'rebase', 'cherry-pick', 'revert', 'drop', 'reset', 'pull', 'stash-save', 'stash-apply', 'stash-pop', 'stash-branch']);
export interface ActionContext {
  repo: Repository | null; settings: AppSettings; refs: GitRef[]; remotes: Remote[]; stashes: Stash[];
  selected: string | null; working: WorkingState | null; generation?: number;
}
export interface ActionCallbacks {
  context: () => ActionContext;
  execute: (action: GitAction, label: Localizable) => Promise<ActionResult | null>;
  error: (error: unknown) => void;
  changed: () => void;
  toast: (message: Localizable) => void;
}
const text = (name: string, label: Localizable, value = '', required = false, hint?: Localizable): FormField => ({ name, label, value, required, hint });
const check = (name: string, label: Localizable, value = false, hint?: Localizable): FormField => ({ name, label, type: 'checkbox', value, hint });
const choice = (name: string, label: Localizable, options: { value: string; label: Localizable }[], value: string, hint?: Localizable): FormField => ({ name, label, type: 'select', value, options, hint });
const signature = (policy: SignaturePolicy, preset?: boolean): FormField => choice('signaturePolicy', m('signing'), [
  { value: 'git', label: m('git') }, { value: 'sign', label: m('sign') }, { value: 'no-sign', label: m('noSign') },
], preset === undefined ? policy : preset ? 'sign' : 'no-sign');
export function signingValue(policy: string): boolean | undefined { return policy === 'sign' ? true : policy === 'no-sign' ? false : undefined; }
export function actionPreflightText(kind: ActionKind, context: ActionContext): LocalizedMessage | null {
  if (!context.repo) return m('openFirst');
  if (context.repo.bare && NEEDS_WORKTREE.has(kind)) return m('bare');
  if (context.working?.operation && NEEDS_IDLE.has(kind)) return m('busy', { operation: ACTION_LABELS[context.working.operation], action: ACTION_LABELS[kind] });
  if ((kind === 'continue' || kind === 'abort') && !context.working?.operation) return m('noOperation');
  if (kind === 'continue' && context.working?.conflicts) return m('conflicts');
  if (['merge', 'rebase', 'drop', 'pull', 'push'].includes(kind) && !context.repo.branch && !context.working?.branch) return m('detached');
  if (['branch-rename', 'branch-delete', 'set-upstream'].includes(kind) && !context.refs.some(ref => ref.kind === 'branch')) return m('noBranches');
  if (['stash-apply', 'stash-pop', 'stash-drop', 'stash-branch'].includes(kind) && !context.stashes.length) return m('noStashes');
  if (['fetch', 'fetch-into', 'pull', 'push', 'tag-push', 'checkout-remote', 'remote-branch-delete', 'remote-edit', 'remote-remove', 'prune', 'set-upstream'].includes(kind) && !context.remotes.length) return m('noRemotes');
  return null;
}
export function actionPreflight(kind: ActionKind, context: ActionContext): string | null { const failure = actionPreflightText(kind, context); return failure ? resolveText(failure) : null; }
export function splitRemoteBranch(value: string, remotes: Remote[]): { remote: string; branch: string } | null {
  const name = value.replace(/^refs\/remotes\//, '');
  const remote = [...remotes].sort((a, b) => b.name.length - a.name.length).find(entry => name.startsWith(`${entry.name}/`));
  return remote ? { remote: remote.name, branch: name.slice(remote.name.length + 1) } : null;
}

interface ActionBinding { id: string; path: string; generation?: number }

export class GitActions {
  private showing = false;
  constructor(private readonly host: Host, private readonly callbacks: ActionCallbacks) {}
  private capture(context: ActionContext): ActionBinding | null {
    return context.repo ? { id: context.repo.id, path: context.repo.path, generation: context.generation } : null;
  }
  private current(binding: ActionBinding | null): Repository | null {
    const { repo, generation } = this.callbacks.context();
    // Legacy callers omit generation; an assigned generation must still match, including after A → B → A.
    return binding && repo?.id === binding.id && repo.path === binding.path && (binding.generation === undefined || generation === binding.generation) ? repo : null;
  }
  visible(kind: ActionKind): boolean { return !this.callbacks.context().settings.hiddenActions.includes(kind); }
  item(kind: ActionKind, preset: Partial<GitAction> = {}, glyph?: IconName): MenuItem | null {
    const context = this.callbacks.context();
    if (context.settings.hiddenActions.includes(kind)) return null;
    const binding = this.capture(context);
    return { label: ACTION_LABELS[kind], action: () => { if (!this.current(binding)) return; void this.show(kind, preset); }, icon: glyph, danger: DANGEROUS.has(kind), disabled: !binding, dataAction: ACTION_DATA_IDS[kind] ?? kind };
  }
  async trust(): Promise<boolean> {
    const binding = this.capture(this.callbacks.context());
    return binding ? this.trustBound(binding) : false;
  }
  private async trustBound(binding: ActionBinding): Promise<boolean> {
    const repo = this.current(binding); if (!repo) return false;
    if (repo.trusted) return true;
    try {
      if (!await confirmDialog(m('trustTitle'), m('trustDescription', { path: binding.path }), m('trust')) || !this.current(binding)) return false;
      await this.host.trustRepository(binding.id, true);
      const current = this.current(binding); if (!current) return false;
      current.trusted = true; this.callbacks.changed(); return true;
    } catch (error) { if (this.current(binding)) this.callbacks.error(error); return false; }
  }
  async show(kind: ActionKind, preset: Partial<GitAction> = {}): Promise<void> {
    if (this.showing) return;
    const context = this.callbacks.context(), binding = this.capture(context);
    this.showing = true;
    try { await this.showInner(kind, preset, context, binding); } catch (error) { if (!binding || this.current(binding)) this.callbacks.error(error); }
    finally { this.showing = false; }
  }
  private async showInner(kind: ActionKind, preset: Partial<GitAction>, context: ActionContext, binding: ActionBinding | null): Promise<void> {
    const repo = context.repo;
    const preflight = actionPreflightText(kind, context); if (preflight) throw new LocalizedError(preflight);
    if (!repo || !binding || !await this.trustBound(binding) || !this.current(binding)) return;
    const settings = context.settings; const defaults = settings.dialogDefaults;
    if (kind === 'checkout' && !settings.confirmCheckout && preset.target && context.refs.some(ref => ref.kind === 'branch' && (ref.name === preset.target || ref.fullName === preset.target))) {
      if (!this.current(binding)) return;
      const result = await this.callbacks.execute({ repoId: binding.id, requestId: '', kind, target: preset.target }, ACTION_LABELS.checkout);
      if (!this.current(binding)) return;
      if (result?.output) this.callbacks.toast(result.output); return;
    }
    const target = preset.target ?? (context.selected && context.selected !== 'WORKTREE' ? context.selected : 'HEAD');
    const current = repo.branch ?? context.working?.branch ?? '';
    const localBranches = context.refs.filter(ref => ref.kind === 'branch').map(ref => ({ value: ref.name, label: ref.name }));
    const remotes = context.remotes.map(remote => ({ value: remote.name, label: remote.name }));
    const presetRemote = splitRemoteBranch(preset.target ?? '', context.remotes);
    const remoteDefault = preset.remote ?? presetRemote?.remote ?? (remotes.some(remote => remote.value === settings.defaultRemote) ? settings.defaultRemote : remotes[0]?.value ?? settings.defaultRemote);
    const remoteTarget = preset.target ? (presetRemote?.branch ?? preset.target) : preset.branch ?? current;
    const stashOptions = context.stashes.map(stash => ({ value: stash.selector, label: `${stash.selector} · ${stash.message}` }));
    const fields: FormField[] = [];
    const descriptions: Localizable[] = [current ? m('repoBranch', { name: repo.name, branch: current }) : m('repoDetached', { name: repo.name })];
    let body: HTMLElement | undefined;
    let targetDetail: CommitDetail | undefined;
    if (kind === 'cherry-pick' || kind === 'revert' || kind === 'drop') {
      try { targetDetail = await this.host.commitDetail(binding.id, target, `action-detail-${Date.now()}-${Math.random().toString(36).slice(2)}`); }
      catch (failure) { if (!this.current(binding)) return; throw new LocalizedError(m('inspectError', { action: ACTION_LABELS[kind], detail: errorText(failure) })); }
      if (!this.current(binding)) return;
      if (kind === 'drop' && targetDetail.commit.parents.length !== 1) { await this.externalDrop(binding, targetDetail, m('unsupportedDrop')); return; }
    }
    switch (kind) {
      case 'branch-create': fields.push(text('name', m('newBranch'), preset.name ?? '', true), text('target', m('start'), target, true), check('checkoutAfter', m('checkoutAfter'), preset.checkoutAfter ?? defaults.checkoutAfterCreate)); break;
      case 'branch-rename': fields.push(choice('target', m('localBranch'), localBranches, preset.target ?? current), text('name', m('newBranch'), preset.name ?? '', true)); break;
      case 'branch-delete': fields.push(choice('target', m('localBranch'), localBranches, preset.target ?? current), check('force', m('deleteUnmerged'), preset.force ?? defaults.forceDelete, m('unmergedHint'))); break;
      case 'checkout': fields.push(text('target', m('checkoutTarget'), target, true, m('checkoutHint'))); break;
      case 'checkout-remote': fields.push(choice('remote', m('remote'), remotes, remoteDefault), text('target', m('sourceRemote'), remoteTarget, true), text('name', m('newLocal'), preset.name ?? presetRemote?.branch ?? remoteTarget, true, m('newLocalHint'))); break;
      case 'fetch-into': fields.push(choice('remote', m('remote'), remotes, remoteDefault), text('target', m('sourceRemote'), remoteTarget, true), text('branch', m('destination'), preset.branch ?? preset.name ?? presetRemote?.branch ?? '', true, m('destinationHint')), check('force', m('forceDestination'), preset.force ?? defaults.forceFetch)); break;
      case 'remote-branch-delete': fields.push(choice('remote', m('remote'), remotes, remoteDefault), text('target', m('deleteRemote'), remoteTarget, true)); descriptions.push(m('deleteRemoteHint')); break;
      case 'merge': fields.push(text('target', m('mergeFrom'), target, true), check('noFastForward', m('noFastForward'), preset.noFastForward ?? defaults.mergeNoFastForward), check('squash', m('squash'), preset.squash ?? defaults.mergeSquash), check('noCommit', m('noMergeCommit'), preset.noCommit ?? defaults.mergeNoCommit), choice('squashMessage', m('squashMessage'), [{ value: 'default', label: m('gitDefault') }, { value: 'summary', label: m('summary') }], preset.squashMessage ?? defaults.squashMessage), signature(settings.commitSigning, preset.sign)); break;
      case 'rebase': fields.push(text('target', m('rebaseOnto'), target, true), check('interactive', m('interactive'), preset.interactive ?? defaults.rebaseInteractive, m('interactiveHint')), check('ignoreDate', m('ignoreDate'), preset.ignoreDate ?? defaults.rebaseIgnoreDate), check('preserveMerges', m('preserveMerges'), preset.preserveMerges ?? defaults.rebasePreserveMerges), signature(settings.commitSigning, preset.sign)); descriptions.push(m('rebaseHint')); break;
      case 'cherry-pick': case 'revert': {
        fields.push(text('target', m('commit'), target, true), choice('mode', m('mainline'), this.mainlineOptions(targetDetail!), preset.mode ?? '', m('mainlineHint')), check('noCommit', m('noCommit'), preset.noCommit ?? defaults.noCommit));
        if (kind === 'cherry-pick') fields.push(check('recordOrigin', m('recordOrigin'), preset.recordOrigin ?? defaults.recordOrigin));
        fields.push(signature(settings.commitSigning, preset.sign)); descriptions.push(m(kind === 'revert' ? 'revertHint' : 'cherryHint')); break;
      }
      case 'drop': fields.push(text('target', m('dropTarget'), targetDetail?.commit.oid ?? target, true)); descriptions.push(m('dropHint')); break;
      case 'reset': fields.push(text('target', m('resetTarget'), target, true), choice('mode', m('resetMode'), [{ value: 'soft', label: m('soft') }, { value: 'mixed', label: m('mixed') }, { value: 'hard', label: m('hard') }, { value: 'keep', label: m('keep') }], preset.mode ?? (preset.target === 'HEAD' && context.selected === 'WORKTREE' ? defaults.worktreeResetMode : defaults.resetMode))); break;
      case 'tag-create': fields.push(text('name', m('tagName'), preset.name ?? '', true), text('target', m('targetCommit'), target, true), choice('tagType', m('tagType'), [{ value: 'annotated', label: m('annotated') }, { value: 'lightweight', label: m('lightweight') }], preset.tagType ?? defaults.tagType), { ...text('message', m('annotation'), preset.message ?? ''), type: 'textarea' }, signature(settings.tagSigning, preset.sign), check('pushAfter', m('pushAfter'), preset.pushAfter ?? defaults.tagPush), choice('remote', m('pushRemote'), remotes, remoteDefault)); break;
      case 'tag-delete': case 'tag-push': fields.push(text('target', m('tagName'), preset.target ?? '', true)); if (kind === 'tag-push') fields.push(choice('remote', m('remote'), remotes, remoteDefault)); break;
      case 'stash-save': fields.push(text('message', m('stashMessage'), preset.message ?? ''), check('includeUntracked', m('includeUntracked'), preset.includeUntracked ?? defaults.stashIncludeUntracked), check('includeIgnored', m('includeIgnored'), preset.includeIgnored ?? false, m('ignoredHint'))); break;
      case 'stash-apply': case 'stash-pop': case 'stash-drop': case 'stash-branch': fields.push(choice('target', m('stash'), stashOptions, preset.target ?? stashOptions[0]?.value ?? '')); if (kind === 'stash-branch') fields.push(text('name', m('newBranch'), preset.name ?? '', true)); if (kind !== 'stash-drop') fields.push(check('reinstateIndex', m('reinstateIndex'), preset.reinstateIndex ?? defaults.reinstateIndex)); if (kind === 'stash-pop') descriptions.push(m('popHint')); break;
      case 'fetch': fields.push(choice('remote', m('remote'), [{ value: '', label: m('allRemotes') }, ...remotes], preset.remote ?? remoteDefault), check('force', m('forceRefs'), preset.force ?? defaults.forceFetch), check('prune', m('prune'), preset.prune ?? defaults.fetchPrune), check('pruneTags', m('pruneTags'), preset.pruneTags ?? defaults.fetchPruneTags, m('pruneTagsHint'))); break;
      case 'pull': fields.push(choice('remote', m('remote'), remotes, remoteDefault), text('branch', m('remoteBranch'), preset.branch ?? ''), choice('mode', m('integration'), [{ value: 'ff-only', label: m('ffOnly') }, { value: 'merge', label: m('merge') }, { value: 'rebase', label: m('rebase') }], preset.mode ?? defaults.pullMode), check('noFastForward', m('pullMerge'), preset.noFastForward ?? defaults.pullNoFastForward), check('squash', m('pullSquash'), preset.squash ?? defaults.pullSquash), choice('squashMessage', m('squashMessage'), [{ value: 'default', label: m('gitDefault') }, { value: 'summary', label: m('summary') }], preset.squashMessage ?? defaults.squashMessage), check('ignoreDate', m('pullDate'), preset.ignoreDate ?? defaults.rebaseIgnoreDate), check('preserveMerges', m('pullPreserve'), preset.preserveMerges ?? defaults.rebasePreserveMerges), check('prune', m('prune'), preset.prune ?? defaults.fetchPrune), check('pruneTags', m('pruneTags'), preset.pruneTags ?? defaults.fetchPruneTags), signature(settings.commitSigning, preset.sign)); break;
      case 'push': fields.push(choice('remote', m('remote'), remotes, remoteDefault), text('branch', m('localBranch'), preset.branch ?? current, true), check('setUpstream', m('setUpstream'), preset.setUpstream ?? false), check('force', m('forceLease'), preset.force ?? false, m('forceLeaseHint'))); break;
      case 'remote-add': fields.push(text('remote', m('remoteName'), preset.remote ?? '', true), text('url', m('fetchUrl'), preset.url ?? '', true)); break;
      case 'remote-edit': fields.push(choice('remote', m('remote'), remotes, remoteDefault), choice('mode', m('urlType'), [{ value: 'fetch', label: m('fetchUrl') }, { value: 'push', label: m('pushUrl') }], preset.mode ?? 'fetch'), text('url', m('newUrl'), preset.url ?? context.remotes.find(remote => remote.name === remoteDefault)?.fetchUrl ?? '', true)); break;
      case 'remote-remove': case 'prune': fields.push(choice('remote', m('remote'), remotes, remoteDefault)); descriptions.push(m(kind === 'remote-remove' ? 'removeRemoteHint' : 'pruneRemoteHint')); break;
      case 'set-upstream': fields.push(choice('branch', m('localBranch'), localBranches, preset.branch ?? current), choice('remote', m('remote'), remotes, remoteDefault), text('target', m('remoteTarget'), presetRemote?.branch ?? preset.target ?? current, true)); break;
      case 'clean': fields.push(check('includeIgnored', m('cleanIgnored'), preset.includeIgnored ?? false, m('cleanIgnoredHint'))); descriptions.push(m('cleanHint')); break;
      case 'continue': descriptions.push(m('continueHint', { operation: context.working?.operation ? ACTION_LABELS[context.working.operation] : 'Git' })); break;
      case 'abort': descriptions.push(m('abortHint', { operation: context.working?.operation ? ACTION_LABELS[context.working.operation] : 'Git' })); break;
      case 'commit': fields.push({ ...text('message', m('commitMessage'), preset.message ?? '', true), type: 'textarea' }, signature(settings.commitSigning, preset.sign)); descriptions.push(m('commitHint')); body = el('div', 'inline-actions', button(m('terminal'), () => { if (!this.current(binding)) return; void this.host.openTerminal(binding.id).catch(error => { if (this.current(binding)) this.callbacks.error(error); }); }, 'terminal')); break;
      case 'identity': {
        const config = await this.host.repoConfig(binding.id, `identity-${Date.now()}`);
        if (!this.current(binding)) return;
        fields.push(text('name', m('name'), config.userName || config.globalUserName, true), text('email', m('email'), config.userEmail || config.globalUserEmail, true, m('emailHint')), check('global', m('globalIdentity'), preset.global ?? false));
        descriptions.push(m('identityHint')); break;
      }
    }
    if (!this.current(binding)) return;
    const dynamic = kind === 'cherry-pick' || kind === 'revert' || kind === 'drop';
    let resolvedTarget = target; let loadingParents = false; let parentError: Localizable | null = null;
    const promise = formDialog({ title: ACTION_LABELS[kind], description: localized(locale => descriptions.map(value => resolveText(value, locale)).join('\n')), fields, body, confirm: kind === 'clean' ? m('previewFiles') : ACTION_LABELS[kind], danger: DANGEROUS.has(kind), dataAction: ACTION_DATA_IDS[kind] ?? kind, validate: data => {
      if (dynamic && (loadingParents || String(data.target) !== resolvedTarget)) return parentError ?? m('stillInspecting');
      if (dynamic && parentError) return parentError;
      return this.validate(kind, data, current, targetDetail, context);
    } });
    // formDialog creates its controls synchronously. Scope listeners to this dialog and dispose them on close.
    const form = document.querySelector<HTMLDialogElement>('dialog:last-of-type');
    if (form) { form.dataset.action = ACTION_DATA_IDS[kind] ?? kind; const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]'); if (submit) submit.dataset.action = ACTION_DATA_IDS[kind] ?? kind; }
    let parentGeneration = 0; let parentTimer: ReturnType<typeof setTimeout> | undefined; let closed = false;
    const targetControl = form?.querySelector<HTMLInputElement>('[name="target"]');
    if (dynamic && targetControl) targetControl.addEventListener('input', () => {
      if (closed || !this.current(binding)) return;
      const inputTarget = targetControl.value.trim(); const sequence = ++parentGeneration; loadingParents = true; parentError = null;
      clearTimeout(parentTimer);
      const parentSelect = form?.querySelector<HTMLSelectElement>('[name="mode"]');
      if (parentSelect) { const option = el('option', '', m('inspecting')); option.value = ''; parentSelect.replaceChildren(option); parentSelect.disabled = true; }
      parentTimer = setTimeout(() => {
        if (closed || sequence !== parentGeneration || !this.current(binding)) return;
        void this.host.commitDetail(binding.id, inputTarget, `action-parent-${Date.now()}-${sequence}`).then(detail => {
          if (closed || sequence !== parentGeneration || !this.current(binding)) return;
          targetDetail = detail; resolvedTarget = inputTarget; loadingParents = false;
          if (parentSelect) { parentSelect.replaceChildren(...this.mainlineOptions(detail).map(item => { const option = el('option', '', item.label); option.value = item.value; return option; })); parentSelect.disabled = false; }
        }).catch(failure => {
          if (closed || sequence !== parentGeneration || !this.current(binding)) return;
          loadingParents = false; parentError = m('cannotInspect', { detail: errorText(failure) });
          if (parentSelect) { const option = el('option', '', m('cannotResolve')); option.value = ''; parentSelect.replaceChildren(option); parentSelect.disabled = true; }
        });
      }, 220);
    });
    const values = await promise; closed = true; clearTimeout(parentTimer);
    if (!values || !this.current(binding)) return;
    if (kind === 'drop' && targetDetail && targetDetail.commit.parents.length !== 1) { await this.externalDrop(binding, targetDetail, m('newUnsupportedDrop')); return; }
    const action: GitAction = { repoId: binding.id, requestId: '', kind };
    const strings = ['target', 'name', 'remote', 'branch', 'url', 'message', 'email', 'mode'] as const;
    const booleans = ['force', 'noCommit', 'noFastForward', 'squash', 'includeUntracked', 'includeIgnored', 'global', 'interactive', 'setUpstream', 'checkoutAfter', 'pushAfter', 'reinstateIndex', 'recordOrigin', 'ignoreDate', 'preserveMerges', 'prune', 'pruneTags'] as const;
    for (const key of strings) if (typeof values[key] === 'string' && (values[key] !== '' || key === 'remote')) action[key] = String(values[key]);
    for (const key of booleans) if (typeof values[key] === 'boolean') action[key] = Boolean(values[key]);
    const sign = signingValue(String(values.signaturePolicy ?? 'git')); if (sign !== undefined) action.sign = sign;
    if (kind === 'tag-create') { action.tagType = values.tagType === 'lightweight' ? 'lightweight' : 'annotated'; if (!action.pushAfter) delete action.remote; }
    if ((kind === 'merge' || kind === 'pull') && action.squash) action.squashMessage = values.squashMessage === 'summary' ? 'summary' : 'default';
    if (kind === 'pull' && action.mode !== 'rebase') { delete action.ignoreDate; delete action.preserveMerges; }
    if (kind === 'pull' && action.mode === 'rebase') { delete action.noFastForward; delete action.squash; delete action.squashMessage; }
    if (kind === 'branch-create' || kind === 'branch-rename' || kind === 'stash-branch' || kind === 'checkout-remote' || kind === 'tag-create') {
      if (action.name && settings.referenceSpace !== 'none') action.name = action.name.replace(/\s+/g, settings.referenceSpace === 'hyphen' ? '-' : '_');
    }
    // Resolve interactive targets to the object inspected in this dialog; the backend still performs authoritative preflight.
    if (dynamic && targetDetail) action.target = targetDetail.commit.oid;
    if (['push', 'branch-delete', 'fetch', 'fetch-into'].includes(kind) && action.force) {
      const message = kind === 'push' ? m('forcePush', { branch: action.branch, remote: action.remote }) : kind === 'branch-delete' ? m('unmergedBranch', { branch: action.target }) : m('forceFetch');
      if (!await confirmDialog(m(kind === 'push' ? 'replaceHistory' : kind === 'branch-delete' ? 'deleteUnmergedTitle' : 'forceRefsTitle'), message, m('understand'), true) || !this.current(binding)) return;
    }
    if (kind === 'remote-branch-delete') {
      if (!await confirmDialog(m('deleteRemoteTitle'), m('deleteRemoteDescription', { remote: action.remote, branch: action.target }), ACTION_LABELS['remote-branch-delete'], true) || !this.current(binding)) return;
      action.force = true;
    }
    if ((kind === 'fetch' || kind === 'pull') && (action.prune || action.pruneTags)) {
      if (!await confirmDialog(m(action.pruneTags ? 'pruneTagsTitle' : 'pruneTitle'), m(action.pruneTags ? 'pruneTagsDescription' : 'pruneDescription'), m('pruneContinue'), true) || !this.current(binding)) return;
    }
    if (kind === 'reset' && action.mode === 'hard') {
      if (!await confirmDialog(m('hardTitle'), m('hardDescription', { target: action.target }), m('hardConfirm'), true) || !this.current(binding)) return;
      action.force = true;
    }
    if (kind === 'identity' && action.global) {
      if (!await confirmDialog(m('identityTitle'), m('identityDescription', { name: action.name, email: action.email }), m('identityConfirm'), true) || !this.current(binding)) return;
      action.mode = 'confirmed-global';
    }
    if (kind === 'commit') {
      if (!await confirmDialog(m('commitTitle'), m('commitDescription'), ACTION_LABELS.commit) || !this.current(binding)) return;
      action.mode = 'follow-up'; action.force = true;
    }
    if (kind === 'clean') {
      if (!this.current(binding)) return;
      const preview = await this.callbacks.execute({ ...action, mode: 'preview', force: false }, m('previewUntracked'));
      if (!preview || !this.current(binding)) return;
      const output = preview.output.trim();
      if (!output) { this.callbacks.toast(m('noUntracked')); return; }
      const confirmed = await formDialog({ title: m('deleteFilesTitle'), description: m('deleteFilesDescription'), body: el('pre', 'output-text', output), confirm: m('deleteFiles'), danger: true });
      if (!confirmed || !this.current(binding)) return;
      action.force = true; action.mode = 'delete';
    }
    if (!this.current(binding)) return;
    const result = await this.callbacks.execute(action, ACTION_LABELS[kind]);
    if (!this.current(binding)) return;
    if (!result && kind === 'drop' && targetDetail) { await this.externalDrop(binding, targetDetail, m('dropFailed')); return; }
    if (result?.status === 'started' || result?.sessionId) { this.callbacks.toast(m('externalStarted')); if (result.output) await textDialog(m('externalTitle'), result.output); return; }
    if (result?.output) await textDialog(m('result', { action: ACTION_LABELS[kind] }), result.output);
  }
  private mainlineOptions(detail: CommitDetail): { value: string; label: Localizable }[] {
    return detail.commit.parents.length > 1 ? [{ value: '', label: m('chooseParent') }, ...detail.commit.parents.map((oid, index) => ({ value: `mainline:${index + 1}`, label: m('parent', { number: numberText(index + 1), oid: oid.slice(0, 12) }) }))] : [{ value: '', label: m('notMerge') }];
  }
  private async externalDrop(binding: ActionBinding, detail: CommitDetail, reason: Localizable): Promise<void> {
    if (!this.current(binding)) return;
    const upstream = detail.commit.parents[0];
    const command = upstream ? `git rebase --interactive --rebase-merges ${upstream}` : 'git rebase --interactive --root --rebase-merges';
    const body = el('div', '', el('p', '', reason), el('p', '', m('externalDropHint')), el('pre', 'output-text', command));
    if (!await formDialog({ title: m('externalDropTitle'), body, confirm: m('externalDropConfirm'), danger: true }) || !this.current(binding)) return;
    await this.host.openTerminal(binding.id);
    if (!this.current(binding)) return;
    this.callbacks.toast(m('terminalOpened'));
  }
  private validate(kind: ActionKind, values: FormValues, current: string, detail: CommitDetail | undefined, context: ActionContext): Localizable | null {
    if (kind === 'merge' && values.squash && values.noFastForward) return m('squashConflict');
    if (kind === 'pull' && values.mode === 'merge' && values.squash && values.noFastForward) return m('pullSquashConflict');
    if (kind === 'pull' && values.mode !== 'merge' && (values.squash || values.noFastForward)) return m('mergeOptions');
    if ((kind === 'fetch' || kind === 'pull') && values.pruneTags && !values.prune) return m('pruneRequired');
    if (kind === 'branch-delete' && String(values.target).replace(/^refs\/heads\//, '') === current) return m('deleteCurrent');
    if (kind === 'fetch-into' && values.branch === current) return m('fetchCurrent');
    if (kind === 'checkout-remote' && context.refs.some(ref => ref.kind === 'branch' && ref.name === values.name)) return m('branchExists');
    if (kind === 'tag-create' && values.tagType === 'lightweight' && (values.signaturePolicy === 'sign' || values.message)) return m('lightweightError');
    if (kind === 'tag-create' && values.pushAfter && !context.remotes.length) return m('tagRemoteRequired');
    if (kind === 'cherry-pick' && values.recordOrigin && values.noCommit) return m('originCommit');
    if (kind === 'cherry-pick' || kind === 'revert') {
      const count = detail?.commit.parents.length ?? 0; const mode = /^mainline:(\d+)$/.exec(String(values.mode ?? ''));
      if (count > 1 && (!mode || Number(mode[1]) < 1 || Number(mode[1]) > count)) return m('actualParent');
      if (count <= 1 && values.mode) return m('mergeParentOnly');
    }
    if (kind === 'identity' && !/^[^\s@]+@[^\s@]+$/.test(String(values.email))) return m('invalidEmail');
    if (['branch-create', 'branch-rename', 'stash-branch', 'checkout-remote', 'tag-create'].includes(kind)) {
      const name = String(values.name ?? '').replace(/\s+/g, context.settings.referenceSpace === 'hyphen' ? '-' : context.settings.referenceSpace === 'underscore' ? '_' : ' ');
      if (!name || name === '@' || /[\s\u0000-\u001f\u007f~^:?*\[\\]|\.\.|@\{|^[-/]|[/.]$|\/\//.test(name) || name.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) return m('invalidName');
    }
    if (kind === 'checkout' && !String(values.target ?? '').trim()) return m('chooseTarget');
    for (const key of ['target', 'remote', 'branch'] as const) if (String(values[key] ?? '').startsWith('-') || /[\u0000-\u001f\u007f]/.test(String(values[key] ?? ''))) return m('invalidArgument', { field: m(key === 'target' ? 'fieldTarget' : key === 'remote' ? 'fieldRemote' : 'fieldBranch') });
    if (['remote-branch-delete', 'checkout-remote', 'fetch-into'].includes(kind) && String(values.target).replace(/^refs\/remotes\//, '').replace(`${String(values.remote)}/`, '') === 'HEAD') return m('actualRemote');
    return null;
  }
}

export function actionFailure(error: unknown): string { return errorMessage(error); }

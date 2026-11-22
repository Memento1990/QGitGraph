import type { ActionKind, ActionResult, AppSettings, CommitDetail, GitAction, GitRef, Host, Remote, Repository, SignaturePolicy, Stash, WorkingState } from '../shared/protocol';
import { errorMessage } from '../lib/format';
import { button, confirmDialog, el, formDialog, textDialog, type FormField, type FormValues, type MenuItem } from './dom';
import type { IconName } from './icons';

export const ACTION_LABELS: Record<ActionKind, string> = {
  'branch-create': 'Create branch', 'branch-rename': 'Rename branch', 'branch-delete': 'Delete branch', checkout: 'Checkout',
  merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert', drop: 'Drop commit', reset: 'Reset current branch',
  'tag-create': 'Create tag', 'tag-delete': 'Delete tag', 'tag-push': 'Push tag',
  'stash-save': 'Save stash', 'stash-apply': 'Apply stash', 'stash-pop': 'Pop stash', 'stash-drop': 'Drop stash', 'stash-branch': 'Create branch from stash',
  fetch: 'Fetch', pull: 'Pull', push: 'Push', 'remote-add': 'Add remote', 'remote-edit': 'Edit remote', 'remote-remove': 'Remove remote', prune: 'Prune remote',
  'set-upstream': 'Set upstream', clean: 'Clean untracked files', continue: 'Continue operation', abort: 'Abort operation', commit: 'Commit staged changes', identity: 'Git identity',
  'remote-branch-delete': 'Delete remote branch', 'fetch-into': 'Fetch into local branch', 'checkout-remote': 'Checkout remote branch',
};
export const ACTION_GROUPS: { label: string; kinds: ActionKind[] }[] = [
  { label: 'Branches', kinds: ['branch-create', 'branch-rename', 'branch-delete', 'checkout', 'checkout-remote', 'set-upstream'] },
  { label: 'History', kinds: ['merge', 'rebase', 'cherry-pick', 'revert', 'drop', 'reset', 'commit'] },
  { label: 'Tags', kinds: ['tag-create', 'tag-delete', 'tag-push'] },
  { label: 'Stashes', kinds: ['stash-save', 'stash-apply', 'stash-pop', 'stash-drop', 'stash-branch'] },
  { label: 'Remotes', kinds: ['fetch', 'fetch-into', 'pull', 'push', 'remote-branch-delete', 'prune', 'remote-add', 'remote-edit', 'remote-remove'] },
  { label: 'Repository', kinds: ['clean', 'continue', 'abort', 'identity'] },
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
  selected: string | null; working: WorkingState | null;
}
export interface ActionCallbacks {
  context: () => ActionContext;
  execute: (action: GitAction, label: string) => Promise<ActionResult | null>;
  error: (error: unknown) => void;
  changed: () => void;
  toast: (message: string) => void;
}
const text = (name: string, label: string, value = '', required = false, hint?: string): FormField => ({ name, label, value, required, hint });
const check = (name: string, label: string, value = false, hint?: string): FormField => ({ name, label, type: 'checkbox', value, hint });
const choice = (name: string, label: string, options: { value: string; label: string }[], value: string, hint?: string): FormField => ({ name, label, type: 'select', value, options, hint });
const signature = (policy: SignaturePolicy, preset?: boolean): FormField => choice('signaturePolicy', 'Signing', [
  { value: 'git', label: 'Follow Git configuration' }, { value: 'sign', label: 'Sign' }, { value: 'no-sign', label: 'Do not sign' },
], preset === undefined ? policy : preset ? 'sign' : 'no-sign');
export function signingValue(policy: string): boolean | undefined { return policy === 'sign' ? true : policy === 'no-sign' ? false : undefined; }
export function actionPreflight(kind: ActionKind, context: ActionContext): string | null {
  if (!context.repo) return 'Open a repository before running a Git operation.';
  if (context.repo.bare && NEEDS_WORKTREE.has(kind)) return 'This is a bare repository. This operation requires a working tree; no changes were made.';
  if (context.working?.operation && NEEDS_IDLE.has(kind)) return `A ${context.working.operation} operation is already in progress. Continue or abort it before starting ${ACTION_LABELS[kind].toLowerCase()}.`;
  if ((kind === 'continue' || kind === 'abort') && !context.working?.operation) return 'No merge, rebase, cherry-pick or revert operation is in progress.';
  if (kind === 'continue' && context.working?.conflicts) return 'Resolve every conflict and stage the resolutions in your editor or terminal before continuing.';
  if (['merge', 'rebase', 'drop', 'pull', 'push'].includes(kind) && !context.repo.branch && !context.working?.branch) return 'HEAD is detached. Check out a local branch before running this operation.';
  if (['branch-rename', 'branch-delete', 'set-upstream'].includes(kind) && !context.refs.some(ref => ref.kind === 'branch')) return 'This repository has no local branches to select.';
  if (['stash-apply', 'stash-pop', 'stash-drop', 'stash-branch'].includes(kind) && !context.stashes.length) return 'This repository has no stashes to select.';
  if (['fetch', 'fetch-into', 'pull', 'push', 'tag-push', 'checkout-remote', 'remote-branch-delete', 'remote-edit', 'remote-remove', 'prune', 'set-upstream'].includes(kind) && !context.remotes.length) return 'This repository has no configured remote. Add a remote first.';
  return null;
}
export function splitRemoteBranch(value: string, remotes: Remote[]): { remote: string; branch: string } | null {
  const name = value.replace(/^refs\/remotes\//, '');
  const remote = [...remotes].sort((a, b) => b.name.length - a.name.length).find(entry => name.startsWith(`${entry.name}/`));
  return remote ? { remote: remote.name, branch: name.slice(remote.name.length + 1) } : null;
}

export class GitActions {
  private showing = false;
  constructor(private readonly host: Host, private readonly callbacks: ActionCallbacks) {}
  visible(kind: ActionKind): boolean { return !this.callbacks.context().settings.hiddenActions.includes(kind); }
  item(kind: ActionKind, preset: Partial<GitAction> = {}, glyph?: IconName): MenuItem | null {
    if (!this.visible(kind)) return null;
    const item: MenuItem & { dataAction: string } = { label: ACTION_LABELS[kind], action: () => { void this.show(kind, preset); }, icon: glyph, danger: DANGEROUS.has(kind), disabled: !this.callbacks.context().repo, dataAction: ACTION_DATA_IDS[kind] ?? kind };
    return item;
  }
  async trust(): Promise<boolean> {
    const repo = this.callbacks.context().repo; if (!repo) return false;
    if (repo.trusted) return true;
    if (!await confirmDialog('Trust this repository?', `Git operations can invoke repository-configured hooks, filters, credential helpers and external tools. Only trust repositories whose content and configuration you recognize.\n\n${repo.path}`, 'Trust repository')) return false;
    if (this.callbacks.context().repo?.id !== repo.id) return false;
    try { await this.host.trustRepository(repo.id, true); repo.trusted = true; this.callbacks.changed(); return true; }
    catch (error) { this.callbacks.error(error); return false; }
  }
  async show(kind: ActionKind, preset: Partial<GitAction> = {}): Promise<void> {
    if (this.showing) return;
    this.showing = true;
    try { await this.showInner(kind, preset); } catch (error) { this.callbacks.error(error); }
    finally { this.showing = false; }
  }
  private async showInner(kind: ActionKind, preset: Partial<GitAction>): Promise<void> {
    const context = this.callbacks.context(); const repo = context.repo;
    const preflight = actionPreflight(kind, context); if (preflight) throw new Error(preflight);
    if (!repo || !await this.trust() || this.callbacks.context().repo?.id !== repo.id) return;
    const settings = context.settings; const defaults = settings.dialogDefaults;
    if (kind === 'checkout' && !settings.confirmCheckout && preset.target && context.refs.some(ref => ref.kind === 'branch' && (ref.name === preset.target || ref.fullName === preset.target))) {
      const result = await this.callbacks.execute({ repoId: repo.id, requestId: '', kind, target: preset.target }, 'Checkout');
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
    let description = `Repository: ${repo.name}${current ? ` · current branch ${current}` : ' · detached HEAD'}`;
    let body: HTMLElement | undefined;
    let targetDetail: CommitDetail | undefined;
    if (kind === 'cherry-pick' || kind === 'revert' || kind === 'drop') {
      try { targetDetail = await this.host.commitDetail(repo.id, target, `action-detail-${Date.now()}-${Math.random().toString(36).slice(2)}`); }
      catch (failure) { throw new Error(`Cannot inspect the selected commit before ${ACTION_LABELS[kind].toLowerCase()}: ${errorMessage(failure)}. No changes were made.`); }
      if (this.callbacks.context().repo?.id !== repo.id) return;
      if (kind === 'drop' && targetDetail.commit.parents.length !== 1) { await this.externalDrop(repo, targetDetail, 'Automatic drop does not support root or merge commits.'); return; }
    }
    switch (kind) {
      case 'branch-create': fields.push(text('name', 'New branch name', preset.name ?? '', true), text('target', 'Start point', target, true), check('checkoutAfter', 'Check out branch after creation', preset.checkoutAfter ?? defaults.checkoutAfterCreate)); break;
      case 'branch-rename': fields.push(choice('target', 'Local branch', localBranches, preset.target ?? current), text('name', 'New branch name', preset.name ?? '', true)); break;
      case 'branch-delete': fields.push(choice('target', 'Local branch', localBranches, preset.target ?? current), check('force', 'Delete even if not merged', preset.force ?? defaults.forceDelete, 'Unmerged commits may become unreachable.')); break;
      case 'checkout': fields.push(text('target', 'Branch, tag or commit', target, true, 'Checking out a tag or commit detaches HEAD. Local changes are never discarded automatically.')); break;
      case 'checkout-remote': fields.push(choice('remote', 'Remote', remotes, remoteDefault), text('target', 'Source remote branch (without remote prefix)', remoteTarget, true), text('name', 'New local branch name', preset.name ?? presetRemote?.branch ?? remoteTarget, true, 'An existing local branch is never overwritten. The new branch tracks this exact remote branch.')); break;
      case 'fetch-into': fields.push(choice('remote', 'Remote', remotes, remoteDefault), text('target', 'Source remote branch (without remote prefix)', remoteTarget, true), text('branch', 'Destination local branch', preset.branch ?? preset.name ?? presetRemote?.branch ?? '', true, 'Cannot update a branch checked out in this or another worktree.'), check('force', 'Allow non-fast-forward destination update', preset.force ?? defaults.forceFetch)); break;
      case 'remote-branch-delete': fields.push(choice('remote', 'Remote', remotes, remoteDefault), text('target', 'Remote branch to delete (without remote prefix)', remoteTarget, true)); description += '\nDeletes the branch on the remote server, not just the local tracking reference. A reviewed lease and separate destructive confirmation are required.'; break;
      case 'merge': fields.push(text('target', 'Merge into current branch from', target, true), check('noFastForward', 'Always create a merge commit', preset.noFastForward ?? defaults.mergeNoFastForward), check('squash', 'Squash into staged changes', preset.squash ?? defaults.mergeSquash), check('noCommit', 'Stop before creating a commit', preset.noCommit ?? defaults.mergeNoCommit), choice('squashMessage', 'Squash message format (when squashing)', [{ value: 'default', label: 'Git default' }, { value: 'summary', label: 'Summarize commits' }], preset.squashMessage ?? defaults.squashMessage), signature(settings.commitSigning, preset.sign)); break;
      case 'rebase': fields.push(text('target', 'Rebase current branch onto', target, true), check('interactive', 'Interactive rebase in a separate Git console', preset.interactive ?? defaults.rebaseInteractive, 'Opens an external Git console. A started session is not a completed rebase; finish or abort it there.'), check('ignoreDate', 'Use current time for author date', preset.ignoreDate ?? defaults.rebaseIgnoreDate), check('preserveMerges', 'Preserve merge topology (--rebase-merges)', preset.preserveMerges ?? defaults.rebasePreserveMerges), signature(settings.commitSigning, preset.sign)); description += '\nRebase rewrites the current branch. Do not rewrite shared history without agreement.'; break;
      case 'cherry-pick': case 'revert': {
        fields.push(text('target', 'Commit', target, true), choice('mode', 'Merge mainline parent', this.mainlineOptions(targetDetail!), preset.mode ?? '', 'Only actual parents of the selected commit are shown. A merge commit requires an explicit parent.'), check('noCommit', 'Apply changes without committing', preset.noCommit ?? defaults.noCommit));
        if (kind === 'cherry-pick') fields.push(check('recordOrigin', 'Record original commit (-x)', preset.recordOrigin ?? defaults.recordOrigin));
        fields.push(signature(settings.commitSigning, preset.sign)); description += kind === 'revert' ? '\nRevert adds a new commit that undoes the selected commit.' : '\nApply the selected commit to the current branch.'; break;
      }
      case 'drop': fields.push(text('target', 'Commit to drop', targetDetail?.commit.oid ?? target, true)); description += '\nRewrites subsequent commits on the checked-out branch to remove one non-merge ancestor. The backend refuses roots, merge commits and merge-containing suffixes; an external interactive entry is available if automatic drop is unsupported.'; break;
      case 'reset': fields.push(text('target', 'Reset current branch to', target, true), choice('mode', 'Reset mode', [{ value: 'soft', label: 'Soft · keep index and working files' }, { value: 'mixed', label: 'Mixed · unstage, keep working files' }, { value: 'hard', label: 'Hard · discard tracked local changes' }, { value: 'keep', label: 'Keep · abort if local files would change' }], preset.mode ?? (preset.target === 'HEAD' && context.selected === 'WORKTREE' ? defaults.worktreeResetMode : defaults.resetMode))); break;
      case 'tag-create': fields.push(text('name', 'Tag name', preset.name ?? '', true), text('target', 'Target commit', target, true), choice('tagType', 'Tag type', [{ value: 'annotated', label: 'Annotated tag' }, { value: 'lightweight', label: 'Lightweight tag' }], preset.tagType ?? defaults.tagType), { ...text('message', 'Annotation (annotated tags only)', preset.message ?? ''), type: 'textarea' }, signature(settings.tagSigning, preset.sign), check('pushAfter', 'Push tag after creation', preset.pushAfter ?? defaults.tagPush), choice('remote', 'Push remote (used only when pushing)', remotes, remoteDefault)); break;
      case 'tag-delete': case 'tag-push': fields.push(text('target', 'Tag name', preset.target ?? '', true)); if (kind === 'tag-push') fields.push(choice('remote', 'Remote', remotes, remoteDefault)); break;
      case 'stash-save': fields.push(text('message', 'Stash message', preset.message ?? ''), check('includeUntracked', 'Include untracked files', preset.includeUntracked ?? defaults.stashIncludeUntracked), check('includeIgnored', 'Include ignored files', preset.includeIgnored ?? false, 'Also stashes untracked files. Review generated files before enabling.')); break;
      case 'stash-apply': case 'stash-pop': case 'stash-drop': case 'stash-branch': fields.push(choice('target', 'Stash', stashOptions, preset.target ?? stashOptions[0]?.value ?? '')); if (kind === 'stash-branch') fields.push(text('name', 'New branch name', preset.name ?? '', true)); if (kind !== 'stash-drop') fields.push(check('reinstateIndex', 'Restore the stash index', preset.reinstateIndex ?? defaults.reinstateIndex)); if (kind === 'stash-pop') description += '\nApplies the stash and removes it only if application succeeds.'; break;
      case 'fetch': fields.push(choice('remote', 'Remote', [{ value: '', label: 'All remotes' }, ...remotes], preset.remote ?? remoteDefault), check('force', 'Allow non-fast-forward ref updates', preset.force ?? defaults.forceFetch), check('prune', 'Prune stale remote-tracking branches', preset.prune ?? defaults.fetchPrune), check('pruneTags', 'Prune stale local tags (destructive)', preset.pruneTags ?? defaults.fetchPruneTags, 'Requires branch pruning. May delete local tags absent on the remote.')); break;
      case 'pull': fields.push(choice('remote', 'Remote', remotes, remoteDefault), text('branch', 'Remote branch (empty uses upstream)', preset.branch ?? ''), choice('mode', 'Integration', [{ value: 'ff-only', label: 'Fast-forward only' }, { value: 'merge', label: 'Merge' }, { value: 'rebase', label: 'Rebase' }], preset.mode ?? defaults.pullMode), check('noFastForward', 'Create merge commit (merge integration only)', preset.noFastForward ?? defaults.pullNoFastForward), check('squash', 'Squash pulled changes (merge integration only)', preset.squash ?? defaults.pullSquash), choice('squashMessage', 'Squash message format (when squashing)', [{ value: 'default', label: 'Git default' }, { value: 'summary', label: 'Summarize commits' }], preset.squashMessage ?? defaults.squashMessage), check('ignoreDate', 'Use current author date (rebase integration only)', preset.ignoreDate ?? defaults.rebaseIgnoreDate), check('preserveMerges', 'Preserve merge topology (rebase integration only)', preset.preserveMerges ?? defaults.rebasePreserveMerges), check('prune', 'Prune stale remote-tracking branches', preset.prune ?? defaults.fetchPrune), check('pruneTags', 'Prune stale local tags (destructive)', preset.pruneTags ?? defaults.fetchPruneTags), signature(settings.commitSigning, preset.sign)); break;
      case 'push': fields.push(choice('remote', 'Remote', remotes, remoteDefault), text('branch', 'Local branch', preset.branch ?? current, true), check('setUpstream', 'Set upstream', preset.setUpstream ?? false), check('force', 'Force with lease', preset.force ?? false, 'Can replace published history. Uses a reviewed lease, never unconditional force.')); break;
      case 'remote-add': fields.push(text('remote', 'Remote name', preset.remote ?? '', true), text('url', 'Fetch URL', preset.url ?? '', true)); break;
      case 'remote-edit': fields.push(choice('remote', 'Remote', remotes, remoteDefault), choice('mode', 'URL type', [{ value: 'fetch', label: 'Fetch URL' }, { value: 'push', label: 'Push URL' }], preset.mode ?? 'fetch'), text('url', 'New URL', preset.url ?? context.remotes.find(remote => remote.name === remoteDefault)?.fetchUrl ?? '', true)); break;
      case 'remote-remove': case 'prune': fields.push(choice('remote', 'Remote', remotes, remoteDefault)); description += kind === 'remote-remove' ? '\nRemoves remote configuration and remote-tracking references, not local branches.' : '\nDeletes stale remote-tracking references. The backend selects only the configured remote namespace.'; break;
      case 'set-upstream': fields.push(choice('branch', 'Local branch', localBranches, preset.branch ?? current), choice('remote', 'Remote', remotes, remoteDefault), text('target', 'Remote branch name (without remote prefix)', presetRemote?.branch ?? preset.target ?? current, true)); break;
      case 'clean': fields.push(check('includeIgnored', 'Also include ignored files', preset.includeIgnored ?? false, 'Ignored build output and local configuration may be deleted.')); description += '\nFirst shows a dry-run preview. Deleting files requires a separate confirmation. Tracked files are not removed.'; break;
      case 'continue': description += `\nContinue the active ${context.working?.operation ?? 'Git'} operation after resolving conflicts and staging the resolutions externally.`; break;
      case 'abort': description += `\nAbort the active ${context.working?.operation ?? 'Git'} operation. Changes made during conflict resolution may be lost.`; break;
      case 'commit': fields.push({ ...text('message', 'Commit message', preset.message ?? '', true), type: 'textarea' }, signature(settings.commitSigning, preset.sign)); description += '\nFollow-up commit of already staged changes only. This client does not stage files. Inspect the staged diff first; use your terminal to stage or unstage.'; body = el('div', 'inline-actions', button('Open terminal', () => { void this.host.openTerminal(repo.id).catch(this.callbacks.error); }, 'terminal')); break;
      case 'identity': {
        const config = await this.host.repoConfig(repo.id, `identity-${Date.now()}`);
        if (this.callbacks.context().repo?.id !== repo.id) return;
        fields.push(text('name', 'Name', config.userName || config.globalUserName, true), text('email', 'Email', config.userEmail || config.globalUserEmail, true, 'Recorded in new commits. Existing commits are not modified.'), check('global', 'Change global identity for all repositories', preset.global ?? false));
        description += '\nDefaults to this repository only. Global changes require an additional confirmation.'; break;
      }
    }
    const dynamic = kind === 'cherry-pick' || kind === 'revert' || kind === 'drop';
    let resolvedTarget = target; let loadingParents = false; let parentError: string | null = null;
    const promise = formDialog({ title: ACTION_LABELS[kind], description, fields, body, confirm: kind === 'clean' ? 'Preview files' : ACTION_LABELS[kind], danger: DANGEROUS.has(kind), dataAction: ACTION_DATA_IDS[kind] ?? kind, validate: data => {
      if (dynamic && (loadingParents || String(data.target) !== resolvedTarget)) return parentError ?? 'The target is still being inspected. Wait for the parent list before submitting.';
      if (dynamic && parentError) return parentError;
      return this.validate(kind, data, current, targetDetail, context);
    } });
    // formDialog creates its controls synchronously. Scope listeners to this dialog and dispose them on close.
    const form = document.querySelector<HTMLDialogElement>('dialog:last-of-type');
    if (form) { form.dataset.action = ACTION_DATA_IDS[kind] ?? kind; const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]'); if (submit) submit.dataset.action = ACTION_DATA_IDS[kind] ?? kind; }
    let parentGeneration = 0; let parentTimer: ReturnType<typeof setTimeout> | undefined; let closed = false;
    const targetControl = form?.querySelector<HTMLInputElement>('[name="target"]');
    if (dynamic && targetControl) targetControl.addEventListener('input', () => {
      const inputTarget = targetControl.value.trim(); const sequence = ++parentGeneration; loadingParents = true; parentError = null;
      clearTimeout(parentTimer);
      const parentSelect = form?.querySelector<HTMLSelectElement>('[name="mode"]');
      if (parentSelect) { parentSelect.replaceChildren(new Option('Inspecting target…', '')); parentSelect.disabled = true; }
      parentTimer = setTimeout(() => {
        void this.host.commitDetail(repo.id, inputTarget, `action-parent-${Date.now()}-${sequence}`).then(detail => {
          if (closed || sequence !== parentGeneration || this.callbacks.context().repo?.id !== repo.id) return;
          targetDetail = detail; resolvedTarget = inputTarget; loadingParents = false;
          if (parentSelect) { parentSelect.replaceChildren(...this.mainlineOptions(detail).map(option => new Option(option.label, option.value))); parentSelect.disabled = false; }
        }).catch(failure => {
          if (closed || sequence !== parentGeneration) return;
          loadingParents = false; parentError = `Cannot inspect this commit: ${errorMessage(failure)}. No operation will be run.`;
          if (parentSelect) { parentSelect.replaceChildren(new Option('Cannot resolve target', '')); parentSelect.disabled = true; }
        });
      }, 220);
    });
    const values = await promise; closed = true; clearTimeout(parentTimer);
    if (!values || this.callbacks.context().repo?.id !== repo.id) return;
    if (kind === 'drop' && targetDetail && targetDetail.commit.parents.length !== 1) { await this.externalDrop(repo, targetDetail, 'The newly selected target is a root or merge commit.'); return; }
    const action: GitAction = { repoId: repo.id, requestId: '', kind };
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
      const message = kind === 'push' ? `Force-with-lease push of ${action.branch} to ${action.remote}. Other people may depend on this history.` : kind === 'branch-delete' ? `The branch ${action.target} may contain commits not reachable from another branch.` : 'Non-fast-forward fetch updates can make previously visible commits unreachable. Inspect the source and destination before continuing.';
      if (!await confirmDialog(kind === 'push' ? 'Replace published branch history?' : kind === 'branch-delete' ? 'Delete an unmerged branch?' : 'Force reference updates?', message, 'I understand — continue', true)) return;
    }
    if (kind === 'remote-branch-delete') {
      if (!await confirmDialog('Delete this branch on the remote server?', `Delete ${action.remote}/${action.target}. Other people may depend on this branch. The backend requires the exact reviewed tracking OID as a lease.`, 'Delete remote branch', true)) return;
      action.force = true;
    }
    if ((kind === 'fetch' || kind === 'pull') && (action.prune || action.pruneTags)) {
      if (!await confirmDialog(action.pruneTags ? 'Prune stale branches and local tags?' : 'Prune stale remote-tracking branches?', action.pruneTags ? 'This can permanently delete local tags that are absent from the remote. Local tags may not be recoverable. Verify the selected remote before continuing.' : 'Remote-tracking references absent on the remote will be deleted. Local branches are not deleted.', 'Prune and continue', true)) return;
    }
    if (kind === 'reset' && action.mode === 'hard') {
      if (!await confirmDialog('Discard tracked local changes?', `Hard reset to ${action.target} overwrites the index and tracked working files. Uncommitted tracked changes cannot be recovered through this app.`, 'Discard and reset', true)) return;
      action.force = true;
    }
    if (kind === 'identity' && action.global) {
      if (!await confirmDialog('Change global Git identity?', `This changes the identity used by all repositories that do not override it.\n\n${action.name} <${action.email}>`, 'Change global identity', true)) return;
      action.mode = 'confirmed-global';
    }
    if (kind === 'commit') {
      if (!await confirmDialog('Commit already staged changes?', 'Only the current index is committed. Unstaged and untracked files are not included. Confirm that you have inspected the staged diff.', 'Commit staged changes')) return;
      action.mode = 'follow-up'; action.force = true;
    }
    if (kind === 'clean') {
      const preview = await this.callbacks.execute({ ...action, mode: 'preview', force: false }, 'Preview untracked files');
      if (!preview || this.callbacks.context().repo?.id !== repo.id) return;
      const output = preview.output.trim();
      if (!output) { this.callbacks.toast('No matching untracked files to delete.'); return; }
      const confirmed = await formDialog({ title: 'Permanently delete these files?', description: 'This cannot be undone by Git. Verify every path in the dry-run output.', body: el('pre', 'output-text', output), confirm: 'Delete listed files', danger: true });
      if (!confirmed || this.callbacks.context().repo?.id !== repo.id) return;
      action.force = true; action.mode = 'delete';
    }
    if (this.callbacks.context().repo?.id !== repo.id) return;
    const result = await this.callbacks.execute(action, ACTION_LABELS[kind]);
    if (!result && kind === 'drop' && targetDetail && this.callbacks.context().repo?.id === repo.id) { await this.externalDrop(repo, targetDetail, 'No successful automatic drop was reported. Inspect the repository before retrying a complex rewrite.'); return; }
    if (result?.status === 'started' || result?.sessionId) { this.callbacks.toast('External Git session started. The operation is not complete; finish or abort it in that console.'); if (result.output) await textDialog('External Git session — started, not completed', result.output); return; }
    if (result?.output) await textDialog(`${ACTION_LABELS[kind]} — result`, result.output);
  }
  private mainlineOptions(detail: CommitDetail): { value: string; label: string }[] {
    return detail.commit.parents.length > 1 ? [{ value: '', label: 'Choose a mainline parent…' }, ...detail.commit.parents.map((oid, index) => ({ value: `mainline:${index + 1}`, label: `Parent ${index + 1} · ${oid.slice(0, 12)}` }))] : [{ value: '', label: 'Not a merge commit' }];
  }
  private async externalDrop(repo: Repository, detail: CommitDetail, reason: string): Promise<void> {
    const upstream = detail.commit.parents[0];
    const command = upstream ? `git rebase --interactive --rebase-merges ${upstream}` : 'git rebase --interactive --root --rebase-merges';
    const body = el('div', '', el('p', '', reason), el('p', '', 'Open an external terminal, inspect the branch and todo list, and explicitly choose which commit to drop. Opening the terminal does not drop any commit or start a rewrite automatically.'), el('pre', 'output-text', command));
    if (!await formDialog({ title: 'Review complex history externally', body, confirm: 'Open terminal — no commits dropped', danger: true })) return;
    if (this.callbacks.context().repo?.id !== repo.id) return;
    await this.host.openTerminal(repo.id); this.callbacks.toast('Terminal opened. No successful drop is claimed; review and run the interactive rewrite yourself.');
  }
  private validate(kind: ActionKind, values: FormValues, current: string, detail: CommitDetail | undefined, context: ActionContext): string | null {
    if (kind === 'merge' && values.squash && values.noFastForward) return 'Squash and “always create a merge commit” cannot be used together.';
    if (kind === 'pull' && values.mode === 'merge' && values.squash && values.noFastForward) return 'Squash and “create merge commit” cannot be used together.';
    if (kind === 'pull' && values.mode !== 'merge' && (values.squash || values.noFastForward)) return 'Squash and no-fast-forward are merge integration options. Disable them or choose Merge.';
    if ((kind === 'fetch' || kind === 'pull') && values.pruneTags && !values.prune) return 'Pruning tags requires “Prune stale remote-tracking branches” to be enabled explicitly.';
    if (kind === 'branch-delete' && String(values.target).replace(/^refs\/heads\//, '') === current) return 'You cannot delete the checked-out branch. Check out another branch first.';
    if (kind === 'fetch-into' && values.branch === current) return 'Cannot fetch directly into the checked-out branch. Check out another branch first.';
    if (kind === 'checkout-remote' && context.refs.some(ref => ref.kind === 'branch' && ref.name === values.name)) return 'That local branch already exists. Choose a new name or explicitly check out the existing branch.';
    if (kind === 'tag-create' && values.tagType === 'lightweight' && (values.signaturePolicy === 'sign' || values.message)) return 'A lightweight tag has no annotation and cannot be signed. Choose Annotated or clear the annotation and signing option.';
    if (kind === 'tag-create' && values.pushAfter && !context.remotes.length) return 'Add a remote before enabling “Push tag after creation”.';
    if (kind === 'cherry-pick' && values.recordOrigin && values.noCommit) return 'Recording origin requires creating a cherry-pick commit. Disable “without committing” or “Record original commit”.';
    if (kind === 'cherry-pick' || kind === 'revert') {
      const count = detail?.commit.parents.length ?? 0; const mode = /^mainline:(\d+)$/.exec(String(values.mode ?? ''));
      if (count > 1 && (!mode || Number(mode[1]) < 1 || Number(mode[1]) > count)) return 'Choose one of the actual mainline parents of this merge commit.';
      if (count <= 1 && values.mode) return 'A mainline parent is valid only for a merge commit.';
    }
    if (kind === 'identity' && !/^[^\s@]+@[^\s@]+$/.test(String(values.email))) return 'Enter a valid Git identity email.';
    if (['branch-create', 'branch-rename', 'stash-branch', 'checkout-remote', 'tag-create'].includes(kind)) {
      const name = String(values.name ?? '').replace(/\s+/g, context.settings.referenceSpace === 'hyphen' ? '-' : context.settings.referenceSpace === 'underscore' ? '_' : ' ');
      if (!name || name === '@' || /[\s\u0000-\u001f\u007f~^:?*\[\\]|\.\.|@\{|^[-/]|[/.]$|\/\//.test(name) || name.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) return 'The name contains characters not allowed in a Git reference.';
    }
    if (kind === 'checkout' && !String(values.target ?? '').trim()) return 'Choose a branch, tag or commit.';
    for (const key of ['target', 'remote', 'branch'] as const) if (String(values[key] ?? '').startsWith('-') || /[\u0000-\u001f\u007f]/.test(String(values[key] ?? ''))) return `The ${key} must not start with a dash or contain control characters.`;
    if (['remote-branch-delete', 'checkout-remote', 'fetch-into'].includes(kind) && String(values.target).replace(/^refs\/remotes\//, '').replace(`${String(values.remote)}/`, '') === 'HEAD') return 'Choose an actual remote branch, not a symbolic remote HEAD alias.';
    return null;
  }
}

export function actionFailure(error: unknown): string { return errorMessage(error); }

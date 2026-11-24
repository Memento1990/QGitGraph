import { shallowReactive } from 'vue';
import type { ChangedFile, DiffQuery, Repository, RepositorySnapshot, WorkingAction, WorkingFileTarget } from '../shared/protocol';
import { m } from '../i18n/local-changes';
import { errorText } from '../lib/format';
import { defineMessages, LocalizedError, type Localizable } from '../lib/i18n';
import {
  groupLocalChanges, localChangeKey, localDiffQuery, localFileTargets, LocalChangeDrafts, LOCAL_DRAFT_LIMIT,
  type LocalChangeEntry, type LocalChangeGroup, type LocalChangesGroup,
} from '../lib/local-changes';
import {
  acquireControllerWrite, actionBindingCurrent, actionSnapshotCurrent, actionSnapshotMatches, captureActionSnapshot,
  controllerMessages, controllerRequestId, controllerWriteBusy, releaseControllerWrite, runControllerWrite,
  signingValue, snapshotSignature, verifyActionSnapshot,
  type ActionBinding, type ActionControllerDeps, type ActionSnapshotCapture, type ControllerResult,
} from './actions';

export type LocalChangesControllerDeps = ActionControllerDeps;
export type LocalFileActionKind = 'stage' | 'unstage' | 'discard' | 'delete-untracked';
export interface LocalSelection { key: string; group: LocalChangeGroup; path: string }
export interface LocalDiffSelection {
  file: ChangedFile; group: LocalChangeGroup; base: string | null; target: string; staged: boolean; query: DiffQuery;
}
export interface LocalChangesConfirmation {
  kind: LocalFileActionKind; title: Localizable; description: Localizable; hint: Localizable | null;
  files: WorkingFileTarget[]; expected: string | null; value: string; danger: boolean;
}
export interface LocalDraftReading {
  start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrollTop: number; scrollLeft?: number;
}
export interface LocalChangesControllerState {
  binding: ActionBinding | null; snapshot: RepositorySnapshot | null;
  draft: string; draftReading: LocalDraftReading; groups: LocalChangesGroup[]; selected: LocalSelection | null; collapsed: ReadonlySet<LocalChangeGroup>;
  busy: boolean; requestId: string | null; pendingKind: WorkingAction['kind'] | null;
  confirmation: LocalChangesConfirmation | null; error: Localizable | null; result: ControllerResult | null;
}
export const localControllerMessages = defineMessages('vue.local-changes', {
  reviewStage: 'Stage exactly these files?', reviewUnstage: 'Unstage exactly these files?',
  reviewFiles: 'Repository: {repo}. Only these listed whole files will be changed. New paths that appear later are not included.',
  stageAll: 'Stage all listed changes', localOnly: 'Local only · no automatic push', draft: 'Repository-specific draft',
  trust: 'Repository is read-only until explicitly trusted. Drafts remain editable.',
  groupPath: '{action} · {group} · {path}', root: 'Repository root', stagedOnly: 'Only staged files are committed. Unstaged and untracked files are never added automatically.',
  commitChanged: 'The message or repository state changed while preparing the commit. Review it and retry.',
  submodule: 'This path is a submodule/gitlink. Manage its working tree separately; no file mutation was requested.',
  blocked: 'The working-tree status is unavailable. It is not known to be clean.',
}, {
  reviewStage: '暂存这些确切的文件？', reviewUnstage: '取消这些确切文件的暂存？',
  reviewFiles: '目标仓库：{repo}。仅修改下方列出的整文件，不包含稍后出现的新路径。',
  stageAll: '暂存所有列出的更改', localOnly: '仅本地 · 不自动推送', draft: '仓库独立草稿',
  trust: '明确信任仓库前只读；仍可编辑草稿。',
  groupPath: '{action} · {group} · {path}', root: '仓库根目录', stagedOnly: '仅提交已暂存文件，绝不自动加入未暂存或未跟踪文件。',
  commitChanged: '准备提交期间说明或仓库状态已变化，请检查后重试。',
  submodule: '此路径是子模块/gitlink，请单独管理其工作区；未请求修改文件。',
  blocked: '工作区状态不可用，不能认定仓库干净。',
});
interface LocalIntent {
  capture: ActionSnapshotCapture; kind: LocalFileActionKind; files: WorkingFileTarget[]; keys: string[]; expected: string | null;
}

/** State/intent controller. The Vue panel only calls this API; no UI code calls Host or writes a repository. */
export function createLocalChangesController(deps: LocalChangesControllerDeps) {
  const owner = Symbol('local-changes'), drafts = new LocalChangeDrafts();
  const state = shallowReactive<LocalChangesControllerState>({
    binding: null, snapshot: null, draft: '', draftReading: { start: 0, end: 0, direction: 'none', scrollTop: 0, scrollLeft: 0 }, groups: groupLocalChanges(null), selected: null, collapsed: new Set(),
    busy: false, requestId: null, pendingKind: null, confirmation: null, error: null, result: null,
  });
  let displayed: ActionSnapshotCapture | null = null, intent: LocalIntent | null = null;
  let draftKey = '', draftVersion = 0, disposed = false, cancelled = false;
  function repositoryKey(repo: Repository | null): string { return repo ? JSON.stringify([repo.id, repo.path]) : ''; }
  function saveDraft(): void {
    if (draftKey) drafts.set(draftKey, { message: state.draft, ...state.draftReading });
  }
  function report(error: unknown, binding = state.binding): void {
    if (disposed || binding && !actionBindingCurrent(deps, binding)) return;
    state.error = errorText(error); deps.onError?.(error, binding);
  }
  /** Call from the root's snapshot/activation watcher; does not fetch, mount, or mutate owner DTOs. */
  function update(): void {
    if (disposed) return;
    const next = captureActionSnapshot(deps), repo = deps.getRepository(), key = repositoryKey(repo);
    const ownerChanged = key !== draftKey || state.binding?.generation !== deps.getGeneration();
    const snapshotChanged = displayed?.snapshot !== next?.snapshot || displayed?.signature !== next?.signature;
    if (ownerChanged) {
      saveDraft(); draftKey = key;
      const draft = drafts.get(key); state.draft = draft?.message ?? '';
      state.draftReading = { start: draft?.start ?? 0, end: draft?.end ?? 0, direction: draft?.direction ?? 'none', scrollTop: draft?.scrollTop ?? 0, scrollLeft: draft?.scrollLeft ?? 0 };
      draftVersion++;
      state.selected = null; state.collapsed = new Set(); state.error = null; state.result = null;
    }
    if (intent && (ownerChanged || snapshotChanged || !actionSnapshotCurrent(deps, intent.capture))) {
      intent = null; state.confirmation = null;
      if (!ownerChanged) state.error = m('indexChanged');
    }
    displayed = next; state.binding = next?.binding ?? null; state.snapshot = next?.snapshot ?? null;
    if (ownerChanged || snapshotChanged) {
      state.groups = groupLocalChanges(repo && !repo.bare ? next?.snapshot.working ?? null : null);
      if (state.selected && !entry(state.selected.group, state.selected.path)) state.selected = null;
    }
  }
  function entry(group: LocalChangeGroup, path: string): LocalChangeEntry | undefined {
    return state.groups.find(value => value.id === group)?.entries.find(value => value.file.path === path);
  }
  function allEntries(): LocalChangeEntry[] { return state.groups.flatMap(group => group.entries); }
  function currentCapture(): ActionSnapshotCapture {
    const repo = deps.getRepository();
    if (disposed || !repo || !displayed || !state.snapshot) throw new LocalizedError(m('stale'));
    if (repo.bare) throw new LocalizedError(m('bareHint'));
    if (!repo.trusted) throw new LocalizedError(controllerMessages.m('untrusted'));
    if (!deps.host.workingAction) throw new LocalizedError(m('workingUnavailable'));
    if (controllerWriteBusy(deps, owner)) throw new LocalizedError(controllerMessages.m('busy'));
    if (!actionSnapshotCurrent(deps, displayed)) throw new LocalizedError(m('indexChanged'));
    return displayed;
  }
  function validCapture(capture: ActionSnapshotCapture): void {
    const current = currentCapture();
    if (cancelled || current.snapshot !== capture.snapshot || current.signature !== capture.signature || !actionSnapshotCurrent(deps, capture)) throw new LocalizedError(m('indexChanged'));
  }
  function setDraft(message: string): void {
    if (disposed) return;
    if (repositoryKey(deps.getRepository()) !== draftKey) update();
    state.draft = message.slice(0, LOCAL_DRAFT_LIMIT); draftVersion++;
    const start = Math.min(state.draft.length, state.draftReading.start), end = Math.max(start, Math.min(state.draft.length, state.draftReading.end));
    state.draftReading = { ...state.draftReading, start, end }; saveDraft(); state.error = null;
  }
  /** Memory-only per-repository reading position. An event from a departing DOM activation cannot update another draft. */
  function updateDraftReading(reading: LocalDraftReading): void {
    if (disposed || repositoryKey(deps.getRepository()) !== draftKey || state.binding?.generation !== deps.getGeneration()) return;
    const finite = (value: number, fallback = 0): number => Number.isFinite(value) ? value : fallback;
    const start = Math.max(0, Math.min(state.draft.length, finite(reading.start)));
    state.draftReading = {
      start, end: Math.max(start, Math.min(state.draft.length, finite(reading.end, start))),
      direction: ['forward', 'backward', 'none'].includes(reading.direction) ? reading.direction : 'none',
      scrollTop: Math.max(0, finite(reading.scrollTop)), scrollLeft: Math.max(0, finite(reading.scrollLeft ?? 0)),
    };
    saveDraft();
  }
  function select(group: LocalChangeGroup, path: string): LocalDiffSelection | null {
    if (disposed || !displayed || !actionBindingCurrent(deps, displayed.binding)) return null;
    const selected = entry(group, path), repo = deps.getRepository();
    if (!selected || !repo || repo.bare) return null;
    state.selected = { key: localChangeKey(group, path), group, path };
    const query = localDiffQuery(repo, selected, deps.getSettings());
    return { file: selected.file, group, base: query.base, target: query.target, staged: Boolean(query.staged), query };
  }
  function toggleGroup(group: LocalChangeGroup): void {
    const collapsed = new Set(state.collapsed);
    if (collapsed.has(group)) collapsed.delete(group); else collapsed.add(group);
    state.collapsed = collapsed;
  }
  function ariaLabel(kind: 'preview' | LocalFileActionKind, group: LocalChangeGroup, path: string): Localizable {
    const action = kind === 'preview' ? m('filePreview', { path, group: m(group) })
      : m(kind === 'delete-untracked' ? 'delete' : kind, { path });
    return localControllerMessages.m('groupPath', { action, group: m(group), path });
  }
  function makeIntent(kind: LocalFileActionKind, selected: readonly LocalChangeEntry[]): LocalIntent {
    const capture = currentCapture();
    if (!selected.length || kind === 'delete-untracked' && selected.length !== 1) throw new LocalizedError(m('stale'));
    for (const item of selected) {
      if (entry(item.group, item.file.path) !== item) throw new LocalizedError(m('indexChanged'));
      if (item.file.submodule && (kind === 'discard' || kind === 'delete-untracked')) throw new LocalizedError(localControllerMessages.m('submodule'));
      if (kind === 'unstage' ? item.group !== 'staged' : kind === 'discard' ? item.group !== 'unstaged' : kind === 'delete-untracked' ? item.group !== 'untracked' : item.group === 'staged') throw new LocalizedError(m('stale'));
    }
    const files = localFileTargets(selected);
    if (!files.length || files.some(file => !file.path)) throw new LocalizedError(m('stale'));
    return { capture, kind, files, keys: selected.map(item => item.key), expected: kind === 'discard' ? 'discard' : kind === 'delete-untracked' ? files[0].path : null };
  }
  function begin(kind: WorkingAction['kind']): boolean {
    if (state.busy || !acquireControllerWrite(deps, owner)) return false;
    cancelled = false; state.busy = true; state.pendingKind = kind; state.requestId = controllerRequestId(kind); state.error = null;
    return true;
  }
  function finish(): void { releaseControllerWrite(deps, owner); state.busy = false; state.requestId = null; state.pendingKind = null; }
  async function executeIntent(pending: LocalIntent): Promise<boolean> {
    if (!begin(pending.kind)) return false;
    try {
      validCapture(pending.capture);
      if (pending.keys.some(key => !allEntries().some(item => item.key === key))) throw new LocalizedError(m('indexChanged'));
      await verifyActionSnapshot(deps, pending.capture, state.requestId!); validCapture(pending.capture);
      const action: WorkingAction = { repoId: pending.capture.binding.repoId, requestId: state.requestId!, kind: pending.kind,
        files: pending.files.map(file => ({ ...file })), ...(pending.expected !== null ? { confirmation: pending.expected } : {}) };
      const result = await runControllerWrite(deps, pending.capture, action, () => deps.host.workingAction!(action), () => cancelled || disposed);
      if (!result) return false;
      state.result = result; return result.status === 'completed';
    } catch (error) { report(error, pending.capture.binding); return false; }
    finally { finish(); update(); }
  }
  function showConfirmation(pending: LocalIntent): void {
    intent = pending;
    const deleting = pending.kind === 'delete-untracked', discarding = pending.kind === 'discard';
    state.confirmation = {
      kind: pending.kind, files: pending.files.map(file => ({ ...file })), expected: pending.expected, value: '',
      title: deleting ? m('deleteTitle') : discarding ? m('discardTitle') : localControllerMessages.m(pending.kind === 'unstage' ? 'reviewUnstage' : 'reviewStage'),
      description: deleting || discarding ? m(deleting ? 'deleteDescription' : 'discardDescription', { repo: deps.getRepository()!.name }) : localControllerMessages.m('reviewFiles', { repo: deps.getRepository()!.name }),
      hint: deleting ? m('deleteHint') : discarding ? m('discardHint') : null, danger: deleting || discarding,
    };
  }
  async function request(kind: LocalFileActionKind, group: LocalChangeGroup, path: string): Promise<boolean> {
    if (state.busy || intent) return false;
    try {
      const item = entry(group, path); if (!item) throw new LocalizedError(m('stale'));
      const pending = makeIntent(kind, [item]);
      if (kind === 'discard' || kind === 'delete-untracked') { showConfirmation(pending); return false; }
      return await executeIntent(pending);
    } catch (error) { report(error); return false; }
  }
  /** A group/all action lists literal targets for review; it never sends [] or a wildcard/all sentinel. */
  function stageAll(group?: LocalChangeGroup): boolean {
    if (state.busy || intent) return false;
    try {
      const selected = group ? state.groups.find(item => item.id === group)?.entries ?? [] : allEntries().filter(item => item.group !== 'staged');
      const pending = makeIntent(group === 'staged' ? 'unstage' : 'stage', selected);
      showConfirmation(pending); return true;
    } catch (error) { report(error); return false; }
  }
  function setConfirmation(value: string): void {
    if (state.confirmation && !state.busy) state.confirmation = { ...state.confirmation, value };
  }
  async function confirm(value = state.confirmation?.value ?? ''): Promise<boolean> {
    if (!intent || !state.confirmation || state.busy) return false;
    const pending = intent;
    try {
      validCapture(pending.capture);
      // Do not trim: repository-relative names can contain leading/trailing spaces.
      if (pending.expected !== null && value !== pending.expected) throw new LocalizedError(m('confirmationMismatch'));
      intent = null; state.confirmation = null;
      return await executeIntent(pending);
    } catch (error) { report(error, pending.capture.binding); if (!actionSnapshotCurrent(deps, pending.capture)) cancelConfirmation(); return false; }
  }
  function cancelConfirmation(): void { if (!state.busy) { intent = null; state.confirmation = null; } }
  async function commit(): Promise<boolean> {
    if (state.busy || intent) return false;
    let capture: ActionSnapshotCapture;
    try {
      capture = currentCapture();
      if (!state.groups[0].entries.length) throw new LocalizedError(m('noStaged'));
      if (!state.draft.trim()) throw new LocalizedError(m('messageRequired'));
      if (!deps.host.workingIndex) throw new LocalizedError(m('commitUnavailable'));
    } catch (error) { report(error); return false; }
    if (!begin('commit-staged')) return false;
    const raw = state.draft, version = draftVersion, key = draftKey;
    const expectedHead = capture.snapshot.repository.head, signing = deps.getSettings().commitSigning;
    try {
      validCapture(capture);
      const expectedIndex = await deps.host.workingIndex!(capture.binding.repoId, state.requestId!);
      validCapture(capture);
      if (!expectedIndex) throw new LocalizedError(m('commitUnavailable'));
      if (version !== draftVersion || state.draft !== raw) throw new LocalizedError(localControllerMessages.m('commitChanged'));
      await verifyActionSnapshot(deps, capture, state.requestId!); validCapture(capture);
      if (version !== draftVersion || state.draft !== raw) throw new LocalizedError(localControllerMessages.m('commitChanged'));
      // Native verifies this index fingerprint atomically with the commit; no stage action is issued here.
      const sign = signingValue(signing);
      const action: WorkingAction = { repoId: capture.binding.repoId, requestId: state.requestId!, kind: 'commit-staged',
        message: raw.trim(), expectedHead, expectedIndex, ...(sign === undefined ? {} : { sign }) };
      const result = await runControllerWrite(deps, capture, action, () => deps.host.workingAction!(action), () => cancelled || disposed);
      if (!result) return false;
      state.result = result;
      if (result.status === 'completed' && key === draftKey && state.draft === raw && version === draftVersion) {
        state.draft = ''; state.draftReading = { start: 0, end: 0, direction: 'none', scrollTop: 0, scrollLeft: 0 }; draftVersion++; drafts.delete(key);
      }
      return result.status === 'completed';
    } catch (error) { report(error, capture.binding); return false; }
    finally { finish(); update(); }
  }
  /** Native sync is one guarded pull→push workflow; never chain a second push in UI/controller code. */
  async function sync(): Promise<boolean> {
    if (state.busy || intent) return false;
    let capture: ActionSnapshotCapture;
    try { capture = currentCapture(); } catch (error) { report(error); return false; }
    if (!begin('sync')) return false;
    try {
      validCapture(capture); await verifyActionSnapshot(deps, capture, state.requestId!); validCapture(capture);
      const settings = deps.getSettings(), sign = signingValue(settings.commitSigning);
      const action: WorkingAction = { repoId: capture.binding.repoId, requestId: state.requestId!, kind: 'sync',
        pullMode: settings.dialogDefaults.pullMode, noFastForward: settings.dialogDefaults.pullNoFastForward,
        ...(sign === undefined ? {} : { sign }) };
      const result = await runControllerWrite(deps, capture, action, () => deps.host.workingAction!(action), () => cancelled || disposed);
      if (result) state.result = result;
      return result?.status === 'completed';
    } catch (error) { report(error, capture.binding); return false; }
    finally { finish(); update(); }
  }
  async function cancel(): Promise<void> {
    if (!state.busy || !state.requestId) { cancelConfirmation(); return; }
    cancelled = true;
    try { await deps.host.cancel(state.requestId); } catch (error) { report(error); }
  }
  function dispose(): void {
    disposed = true; intent = null; state.confirmation = null; drafts.clear();
    if (state.requestId) { cancelled = true; void deps.host.cancel(state.requestId).catch(() => undefined); }
  }
  update();
  return {
    state: state as Readonly<LocalChangesControllerState>, update, setDraft, updateDraftReading, select, toggleGroup, ariaLabel, request,
    stage: (group: 'unstaged' | 'untracked', path: string) => request('stage', group, path),
    unstage: (path: string) => request('unstage', 'staged', path),
    discard: (path: string) => request('discard', 'unstaged', path),
    deleteUntracked: (path: string) => request('delete-untracked', 'untracked', path),
    stageAll, setConfirmation, confirm, cancelConfirmation, commit, sync, cancel, dispose,
    get repository(): Repository | null { return deps.getRepository(); },
    get generation(): number { return deps.getGeneration(); },
    get snapshot(): RepositorySnapshot | null { return deps.getSnapshot(); },
    get busy(): boolean { return state.busy; },
    get blocked(): boolean { return !state.snapshot || Boolean(deps.getError?.()); },
    get canWrite(): boolean { try { currentCapture(); return !state.busy && !intent; } catch { return false; } },
    get canCommit(): boolean { return this.canWrite && Boolean(deps.host.workingIndex && state.groups[0].entries.length && state.draft.trim()); },
    get stale(): boolean { return Boolean(displayed && (!actionSnapshotMatches(deps, displayed) || snapshotSignature(displayed.snapshot) !== displayed.signature)); },
  };
}
export type LocalChangesController = ReturnType<typeof createLocalChangesController>;

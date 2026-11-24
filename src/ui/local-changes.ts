import type { AppSettings, DiffQuery, DiffResult, Host, Repository, WorkingAction, WorkingState } from '../shared/protocol';
import { errorText, numberText } from '../lib/format';
import { LocalizedError } from '../lib/i18n';
import {
  groupLocalChanges, localChangesLayout, localChangesWindow, localDiffQuery, localFileStatus, localFileTargets,
  LocalChangeDrafts, LOCAL_DRAFT_LIMIT, LOCAL_VIRTUAL_THRESHOLD,
  type LocalChangeEntry, type LocalChangeGroup, type LocalChangeLayout, type LocalChangeLayoutRow, type LocalChangesGroup, type LocalChangesPosition,
} from '../lib/local-changes';
import { Requests } from '../lib/state';
import { m } from '../i18n/local-changes';
import { button, disposeBindings, el, empty, field, formDialog, input, loading, resizer, setAttribute, setText } from './dom';
import { DiffView, type LoadedContent } from './diff-view';
import { icon } from './icons';
import './local-changes.css';

export type { LocalChangesPosition } from '../lib/local-changes';
export interface LocalChangesContext {
  repo: Repository | null; working: WorkingState | null; settings: AppSettings;
  busy: boolean; loading: boolean; error?: unknown; listSize?: number; generation?: number;
}
export type LocalChangesAction = Omit<WorkingAction, 'repoId' | 'requestId'>;
export interface LocalChangesCallbacks {
  context: () => LocalChangesContext;
  /** The owner binds the repository, performs trust/write checks, and refreshes its real snapshot before resolving. False means no successful write. */
  execute: (action: LocalChangesAction) => Promise<unknown>;
  error: (error: unknown) => void; copy: (text: string) => void;
  position: (next: LocalChangesPosition) => void; close: () => void;
  listSize?: (next: number, final: boolean) => void;
  settings?: (patch: Partial<AppSettings>) => void; changed?: () => void;
}
interface RowElement {
  element: HTMLDivElement; item: LocalChangeLayoutRow;
  state?: HTMLSpanElement; name?: HTMLSpanElement; directory?: HTMLSpanElement;
  toggle?: HTMLButtonElement; count?: HTMLSpanElement;
  actions: HTMLButtonElement[];
}
interface ActionCapture { repoId: string; head: string | null; working: WorkingState; generation: number; ownerGeneration?: number }
interface PlacementDraftViewport {
  repoId: string; ownerGeneration?: number; value: string;
  start: number; end: number; direction: 'forward' | 'backward' | 'none';
  scrollTop: number; scrollLeft: number; filesTop: number; filesLeft: number;
  frames: number;
}
type DiffStatus = 'idle' | 'loading' | 'ready' | 'error' | 'cancelled';
let paneSequence = 0;

/** Independent working-tree surface. It never writes through Host or changes a history selection. */
export class LocalChangesPane {
  readonly element = el('section', 'local-changes local-changes-pane local-panel');
  /** Move this exact node (composer + list), not a second rendered copy, into a repository sidebar. */
  readonly listElement = el('section', 'local-changes-list-surface');
  /** The preview is independent of the list surface and may be mounted separately by the owner. */
  readonly previewElement = el('section', 'local-changes-preview');
  private readonly id = `local-changes-${++paneSequence}`;
  private readonly headingTitle = el('strong', 'local-changes-title', m('title'));
  private readonly headingCount = el('span', 'local-changes-count count-badge');
  private readonly composer = el('section', 'local-changes-composer composer');
  private readonly message = el('textarea', 'local-changes-message');
  private readonly composerTip = el('span', 'local-changes-composer-tip composer-tip');
  private readonly composerError = el('p', 'local-changes-composer-error composer-error');
  private readonly listNotice = el('div', 'local-changes-notice');
  private readonly viewport = el('div', 'local-changes-files local-file-list');
  private readonly rowsElement = el('div', 'local-changes-rows');
  private readonly placeholder = el('div', 'local-changes-empty');
  private readonly previewPath = el('span', 'local-changes-preview-path mono');
  private readonly previewState = el('span', 'local-changes-file-state file-state');
  private readonly previewScope = el('span', 'local-changes-preview-scope diff-scope-tag');
  private readonly diffContainer = el('div', 'local-changes-diff-container');
  private readonly commitButton: HTMLButtonElement;
  private readonly moveButton: HTMLButtonElement;
  private readonly copyButton: HTMLButtonElement;
  private readonly splitter: HTMLElement;
  private readonly diffView: DiffView;
  private readonly requests: Requests;
  private readonly drafts = new LocalChangeDrafts();
  private readonly rows = new Map<string, RowElement>();
  private readonly collapsed = new Set<LocalChangeGroup>();
  private readonly observer: ResizeObserver;
  private groups: LocalChangesGroup[] = groupLocalChanges(null);
  private entries = new Map<string, LocalChangeEntry>();
  private layout: LocalChangeLayout = { rows: [], height: 0, files: 0 };
  private rowPositions = new Map<string, number>();
  private filePositions = new Map<string, number>();
  private groupPositions: number[] = [];
  private placement: LocalChangesPosition = 'workspace';
  private listSize = 225;
  private repoId = '';
  private working: WorkingState | null | undefined;
  private repoHead: string | null = null;
  private encoding = '';
  private generation = 0;
  private ownerGeneration: number | undefined;
  private viewVersion = 0;
  private contentVersion = 0;
  private selectedKey: string | null = null;
  private activeKey: string | null = null;
  private diffKey = '';
  private diffStatus: DiffStatus = 'idle';
  private diffPending: Promise<void> | null = null;
  private result: DiffResult | null = null;
  private sideContents: Partial<Record<'old' | 'new', LoadedContent>> = {};
  private contentPending: { side: 'old' | 'new'; promise: Promise<LoadedContent> } | null = null;
  private localDiffView: AppSettings['diffView'] | undefined;
  private pendingAction: { repoId: string; kind: WorkingAction['kind'] } | null = null;
  private confirmationDialog: HTMLDialogElement | null = null;
  private placementDraft: PlacementDraftViewport | null = null;
  private placementFrame = 0;
  private frame = 0;
  private nextRowId = 0;
  private destroyed = false;

  constructor(private readonly host: Host, private readonly callbacks: LocalChangesCallbacks) {
    this.requests = new Requests(requestId => host.cancel(requestId));
    setAttribute(this.element, 'aria-label', m('title')); setAttribute(this.listElement, 'aria-label', m('title')); setAttribute(this.previewElement, 'aria-label', m('previewTitle'));
    this.moveButton = button(m('moveSidebar'), () => {
      if (!this.destroyed) callbacks.position(this.placement === 'workspace' ? 'sidebar' : 'workspace');
    }, 'sidebar', '', true);
    this.moveButton.dataset.action = 'move-local-changes';
    const close = button(m('close'), () => { if (!this.destroyed) callbacks.close(); }, 'close', '', true); close.dataset.action = 'close-local-changes';
    const header = el('header', 'local-changes-heading panel-heading', icon('file'), this.headingTitle, this.headingCount, el('span', 'spacer'), this.moveButton, close);
    const label = el('label', 'local-changes-message-label', m('message')); label.htmlFor = `${this.id}-message`;
    this.message.id = `${this.id}-message`; this.message.name = 'commit-message'; this.message.rows = 2; this.message.maxLength = LOCAL_DRAFT_LIMIT;
    this.message.dataset.action = 'local-commit-message'; setAttribute(this.message, 'aria-label', m('message')); setAttribute(this.message, 'title', m('shortcut'));
    this.message.addEventListener('input', () => {
      if (this.destroyed) return;
      this.cancelPlacementDraft();
      if (this.callbacks.context().repo?.id !== this.repoId) { this.update(); return; }
      this.saveDraft(); this.hideComposerError(); this.callbacks.changed?.();
    });
    this.message.addEventListener('keydown', event => {
      if (!event.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void this.commit(); }
    });
    this.message.addEventListener('select', () => { if (!this.placementDraft) this.saveDraft(); });
    this.message.addEventListener('blur', () => { if (!this.placementDraft) this.saveDraft(); });
    const userDraftInteraction = (): void => this.cancelPlacementDraft();
    for (const target of [this.message, this.viewport]) {
      target.addEventListener('pointerdown', userDraftInteraction);
      target.addEventListener('wheel', userDraftInteraction, { passive: true });
      target.addEventListener('keydown', userDraftInteraction);
    }
    this.commitButton = button(m('commit'), () => { void this.commit(); }, 'check', 'primary local-changes-commit');
    this.commitButton.dataset.action = 'commit-staged'; setAttribute(this.commitButton, 'aria-keyshortcuts', 'Control+Enter Meta+Enter');
    this.composerError.id = `${this.id}-message-error`; this.composerError.hidden = true; this.composerError.setAttribute('role', 'alert');
    this.composerTip.id = `${this.id}-message-tip`; this.message.setAttribute('aria-describedby', `${this.composerTip.id} ${this.composerError.id}`);
    this.composer.append(label, this.message, el('div', 'local-changes-composer-bottom composer-bottom', this.commitButton, this.composerTip), this.composerError);
    this.listNotice.hidden = true; this.listNotice.setAttribute('role', 'status'); this.listNotice.setAttribute('aria-live', 'polite');
    this.viewport.tabIndex = 0; this.viewport.setAttribute('role', 'tree'); setAttribute(this.viewport, 'aria-label', m('fileList')); setAttribute(this.viewport, 'title', m('keyboardHint'));
    this.viewport.addEventListener('keydown', event => this.listKeydown(event));
    this.viewport.addEventListener('scroll', () => { this.scheduleRows(); this.callbacks.changed?.(); });
    this.viewport.append(this.rowsElement, this.placeholder); this.listElement.append(this.composer, this.listNotice, this.viewport);
    this.copyButton = button(m('copyPath'), () => { const entry = this.currentEntry(); if (entry) callbacks.copy(entry.file.path); }, 'copy', '', true);
    this.copyButton.dataset.action = 'copy-local-file-path'; this.copyButton.hidden = true;
    const previewHeading = el('header', 'local-changes-diff-heading local-diff-heading', this.previewState, this.previewPath, el('span', 'spacer'), this.previewScope, this.copyButton);
    setAttribute(previewHeading, 'aria-label', m('selectedPath'));
    this.diffView = new DiffView(view => {
      if (this.callbacks.settings) this.callbacks.settings({ diffView: view }); else this.localDiffView = view;
      if (this.result && this.diffStatus === 'ready') this.diffView.set(this.result, this.diffSettings(), false);
      this.callbacks.changed?.();
    }, text => callbacks.copy(text));
    this.diffView.element.addEventListener('scroll', () => this.callbacks.changed?.(), true);
    this.previewElement.append(previewHeading, this.diffContainer);
    this.splitter = resizer('horizontal', () => this.listSize, (next, final) => {
      this.listSize = next; this.applyListSize(); this.callbacks.listSize?.(next, final); this.callbacks.changed?.();
    }, 70, () => Math.min(500, Math.max(140, this.element.clientHeight - this.composer.clientHeight - 150)), false, m('resizeList'));
    this.splitter.classList.add('local-changes-list-resizer'); this.splitter.dataset.action = 'resize-local-file-list';
    this.element.append(header, this.listElement, this.splitter, this.previewElement);
    this.observer = new ResizeObserver(() => {
      this.restorePlacementDraft(); this.schedulePlacementDraft(); this.scheduleRows();
    });
    this.observer.observe(this.viewport); this.observer.observe(this.message);
    this.applyListSize(); this.applyPlacement(); this.renderEmptyPreview();
  }

  /** New real snapshots invalidate local previews, even when paths/counts are unchanged. No mutable diff cache exists. */
  update(force = false): void {
    if (this.destroyed) return;
    const context = this.callbacks.context(), repo = context.repo;
    const nextRepo = repo?.id ?? '', repoChanged = this.repoId !== nextRepo;
    const ownerChanged = repoChanged || this.ownerGeneration !== context.generation;
    const snapshotChanged = force || ownerChanged || this.working !== context.working || this.repoHead !== (repo?.head ?? null);
    const queryChanged = this.encoding !== context.settings.encoding;
    if (ownerChanged) { this.cancelPlacementDraft(); this.cancelConfirmation(); this.pendingAction = null; }
    if (repoChanged) {
      this.saveDraft(); this.repoId = nextRepo; this.restoreDraft(); this.selectedKey = null; this.activeKey = null; this.collapsed.clear(); this.viewport.scrollTop = 0; this.hideComposerError();
    }
    // Workspace visibility belongs to the owner; update() must not reopen a closed panel.
    this.listElement.hidden = false; this.previewElement.hidden = false;
    this.element.dataset.repo = nextRepo; this.listElement.dataset.repo = nextRepo; this.previewElement.dataset.repo = nextRepo;
    this.working = context.working; this.repoHead = repo?.head ?? null; this.encoding = context.settings.encoding; this.ownerGeneration = context.generation;
    if (typeof context.listSize === 'number' && Number.isFinite(context.listSize)) this.listSize = Math.max(70, Math.min(500, context.listSize));
    this.applyListSize();
    if (snapshotChanged) {
      const selectedPath = this.currentEntry()?.file.path;
      this.generation++; this.requests.cancel('index');
      this.groups = groupLocalChanges(repo && !repo.bare ? context.working : null);
      this.entries = new Map(this.groups.flatMap(group => group.entries.map(entry => [entry.key, entry] as const)));
      if (!this.selectedKey || !this.entries.has(this.selectedKey)) {
        const counterpart = selectedPath ? this.groups.flatMap(group => group.entries).find(entry => entry.file.path === selectedPath) : undefined;
        this.selectedKey = counterpart?.key ?? this.groups[1].entries[0]?.key ?? this.groups[0].entries[0]?.key ?? this.groups[2].entries[0]?.key ?? null;
      }
      if (!this.activeKey || !this.entries.has(this.activeKey) && !this.layout.rows.some(row => row.key === this.activeKey && !row.entry)) this.activeKey = this.selectedKey;
      this.prepareLayout();
    }
    this.updatePresentation(); this.renderRows(); this.renderPreviewHeading();
    const selected = this.currentEntry();
    if (!repo || repo.bare || !selected) { this.resetDiff(); this.renderEmptyPreview(); return; }
    if (snapshotChanged || queryChanged || force || this.diffStatus === 'idle') void this.selectEntry(selected, true);
    else if (this.result && this.diffStatus === 'ready') this.diffView.set(this.result, this.diffSettings(), false);
  }

  /** Presentation-only localization: DOM bindings update in place, without requests or draft/focus changes. */
  updateLocale(): void { if (!this.destroyed) this.diffView.updateLocale(); }
  focusMessage(): void {
    if (this.destroyed) return;
    if (this.callbacks.context().repo?.id !== this.repoId) this.update();
    this.message.focus({ preventScroll: true });
    if (this.groups[0].entries.length === 0 && this.callbacks.context().repo) this.showComposerError(m('noStaged'));
  }

  /** Does not invoke position(): the owner calls this after applying its placement state. */
  setPlacement(position: LocalChangesPosition, mount?: HTMLElement): void {
    if (this.destroyed) return;
    const focus = document.activeElement as HTMLElement | null, ownsFocus = Boolean(focus && this.listElement.contains(focus));
    const target = mount ?? (position === 'workspace' ? this.element : undefined);
    const moving = position !== this.placement || Boolean(target && this.listElement.parentElement !== target);
    if (moving) {
      // Capture before changing data-placement or detaching the editor; either can clamp browser scroll offsets.
      this.restorePlacementDraft();
      this.placementDraft ??= {
        repoId: this.repoId, ownerGeneration: this.ownerGeneration, value: this.message.value,
        start: this.message.selectionStart, end: this.message.selectionEnd, direction: this.message.selectionDirection,
        scrollTop: this.message.scrollTop, scrollLeft: this.message.scrollLeft,
        filesTop: this.viewport.scrollTop, filesLeft: this.viewport.scrollLeft, frames: 2,
      };
    }
    this.placement = position; this.applyPlacement();
    if (target && this.listElement.parentElement !== target) {
      if (target === this.element) target.insertBefore(this.listElement, this.splitter); else target.append(this.listElement);
    }
    if (ownsFocus && focus?.isConnected && document.activeElement !== focus) focus.focus({ preventScroll: true });
    this.restorePlacementDraft();
    if (moving) {
      const captured = this.placementDraft;
      // App's tree.mountLocal() runs after this method and may restore selection after focus, scrolling the textarea again.
      queueMicrotask(() => { if (captured && this.placementDraft === captured) this.restorePlacementDraft(); });
      this.schedulePlacementDraft();
    }
    this.scheduleRows();
  }

  clear(): void {
    if (this.destroyed) return;
    this.restorePlacementDraft(); this.cancelPlacementDraft(); this.cancelConfirmation(); this.saveDraft(); this.generation++; this.requests.cancelAll(); this.pendingAction = null; this.resetDiff(); this.repoId = ''; this.working = undefined;
    this.groups = groupLocalChanges(null); this.entries.clear(); this.selectedKey = null; this.activeKey = null; this.collapsed.clear(); this.prepareLayout(); this.renderRows();
    this.message.value = ''; this.hideComposerError(); this.element.hidden = true; this.listElement.hidden = true; this.previewElement.hidden = true;
  }
  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true; this.cancelPlacementDraft(); this.cancelConfirmation(); this.generation++; this.viewVersion++; this.requests.cancelAll(); this.observer.disconnect(); cancelAnimationFrame(this.frame);
    this.diffView.destroy(); this.drafts.clear(); this.rows.clear(); this.entries.clear(); this.sideContents = {}; this.contentPending = null; this.diffPending = null; this.result = null;
    disposeBindings(this.listElement); disposeBindings(this.previewElement); disposeBindings(this.element);
    this.listElement.remove(); this.previewElement.remove(); this.element.remove();
  }
  destroy(): void { this.dispose(); }

  private cancelPlacementDraft(): void {
    this.placementDraft = null; cancelAnimationFrame(this.placementFrame); this.placementFrame = 0;
  }
  private restorePlacementDraft(): void {
    const draft = this.placementDraft; if (!draft) return;
    const context = this.callbacks.context();
    if (this.destroyed || this.repoId !== draft.repoId || context.repo?.id !== draft.repoId || context.generation !== draft.ownerGeneration || this.message.value !== draft.value) { this.cancelPlacementDraft(); return; }
    if (!this.message.isConnected || this.message.clientHeight <= 0) return;
    // Selection/focus restoration itself may scroll the edit control. The saved viewport always wins last.
    if (this.message.selectionStart !== draft.start || this.message.selectionEnd !== draft.end || this.message.selectionDirection !== draft.direction) this.message.setSelectionRange(draft.start, draft.end, draft.direction);
    this.message.scrollTop = draft.scrollTop; this.message.scrollLeft = draft.scrollLeft;
    this.viewport.scrollTop = draft.filesTop; this.viewport.scrollLeft = draft.filesLeft;
  }
  private schedulePlacementDraft(): void {
    if (this.destroyed || !this.placementDraft || this.placementFrame) return;
    this.placementFrame = requestAnimationFrame(() => {
      this.placementFrame = 0;
      const draft = this.placementDraft; if (!draft) return;
      this.restorePlacementDraft();
      if (this.placementDraft !== draft) return;
      // Two paint turns cover the owner's synchronous reparent plus the subsequent ResizeObserver/layout pass.
      if (--draft.frames > 0) this.schedulePlacementDraft();
      else { this.placementDraft = null; this.saveDraft(); }
    });
  }
  private cancelConfirmation(): void {
    const dialog = this.confirmationDialog; this.confirmationDialog = null;
    if (dialog?.isConnected) dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
  }
  private applyPlacement(): void {
    for (const element of [this.element, this.listElement, this.previewElement]) element.dataset.placement = this.placement;
    this.splitter.hidden = this.placement === 'sidebar';
    setText(this.headingTitle, this.placement === 'sidebar' ? m('previewTitle') : m('title'));
    setAttribute(this.moveButton, 'title', this.placement === 'workspace' ? m('moveSidebar') : m('moveWorkspace'));
    setAttribute(this.moveButton, 'aria-label', this.placement === 'workspace' ? m('moveSidebar') : m('moveWorkspace'));
  }
  private applyListSize(): void {
    this.listElement.style.setProperty('--local-list-size', `${this.listSize}px`);
    this.element.style.setProperty('--local-list-size', `${this.listSize}px`);
    this.splitter?.setAttribute('aria-valuenow', String(Math.round(this.listSize)));
  }
  private saveDraft(): void {
    if (!this.repoId || this.destroyed) return;
    this.drafts.set(this.repoId, { message: this.message.value, start: this.message.selectionStart, end: this.message.selectionEnd, direction: this.message.selectionDirection, scrollTop: this.message.scrollTop, scrollLeft: this.message.scrollLeft });
  }
  private restoreDraft(): void {
    const draft = this.drafts.get(this.repoId); this.message.value = draft?.message ?? '';
    this.message.setSelectionRange(draft?.start ?? 0, draft?.end ?? 0, draft?.direction ?? 'none'); this.message.scrollTop = draft?.scrollTop ?? 0; this.message.scrollLeft = draft?.scrollLeft ?? 0;
  }
  private showComposerError(message: Parameters<typeof setText>[1]): void { setText(this.composerError, message); this.composerError.hidden = false; this.message.setAttribute('aria-invalid', 'true'); }
  private hideComposerError(): void { this.composerError.hidden = true; this.message.removeAttribute('aria-invalid'); }
  private canWrite(context = this.callbacks.context()): boolean {
    return !this.destroyed && Boolean(context.repo && !context.repo.bare && context.working) && context.repo?.id === this.repoId && context.working === this.working && context.repo.head === this.repoHead && context.generation === this.ownerGeneration && !context.busy && !context.loading && !context.error && !this.pendingAction;
  }
  private capture(): ActionCapture | null {
    const context = this.callbacks.context();
    return this.canWrite(context) && context.repo?.id === this.repoId && context.working ? { repoId: context.repo.id, head: context.repo.head, working: context.working, generation: this.generation, ownerGeneration: context.generation } : null;
  }
  private captureCurrent(capture: ActionCapture): boolean {
    const context = this.callbacks.context();
    return !this.destroyed && this.repoId === capture.repoId && context.repo?.id === capture.repoId && context.repo.head === capture.head && context.working === capture.working && this.generation === capture.generation && context.generation === capture.ownerGeneration && !context.loading && !context.busy && !context.error;
  }
  private updatePresentation(): void {
    const context = this.callbacks.context(), repo = context.repo, staged = this.groups[0].entries.length;
    this.headingCount.hidden = !repo || repo.bare || !context.working;
    if (!this.headingCount.hidden) { setText(this.headingCount, numberText(context.working!.files.length)); setAttribute(this.headingCount, 'title', m('changed', { count: numberText(context.working!.files.length) })); }
    setAttribute(this.message, 'aria-label', repo ? m('messageFor', { repo: repo.name }) : m('message'));
    setAttribute(this.message, 'placeholder', repo ? m('messagePlaceholder', { repo: repo.name }) : m('message'));
    this.message.disabled = !repo || repo.bare;
    const committing = this.pendingAction?.repoId === repo?.id && this.pendingAction?.kind === 'commit-staged';
    setText(this.commitButton.querySelector('span')!, committing ? m('committing') : m('commit'));
    this.commitButton.disabled = !this.canWrite(context) || !this.host.workingIndex;
    setAttribute(this.commitButton, 'title', !this.host.workingIndex ? m('commitUnavailable') : m('shortcut'));
    setText(this.composerTip, staged ? m('stagedOnly', { count: numberText(staged) }) : m('stageFirst'));
    this.viewport.setAttribute('aria-busy', String(context.loading)); this.element.dataset.busy = String(context.busy || Boolean(this.pendingAction));
    this.listNotice.hidden = !context.loading && !context.error;
    if (context.error) setText(this.listNotice, m('stale'));
    else if (context.loading) setText(this.listNotice, context.working ? m('refreshing') : m('loading'));
    this.placeholder.hidden = this.layout.files > 0;
    if (!this.placeholder.hidden) {
      const [title, hint] = this.emptyLabels();
      this.placeholder.replaceChildren(empty(title, hint));
      if (context.error) this.placeholder.append(el('pre', 'local-changes-raw-error', errorText(context.error)));
    }
  }
  private emptyLabels(): [Parameters<typeof empty>[0], Parameters<typeof empty>[1]] {
    const context = this.callbacks.context();
    if (!context.repo) return [m('noRepository'), m('chooseRepository')];
    if (context.repo.bare) return [m('bare'), m('bareHint')];
    if (context.error) return [m('failed'), m('stale')];
    if (context.loading) return [context.working ? m('refreshing') : m('loading'), undefined];
    if (!context.working) return [m('unknown'), m('unknownHint')];
    return [m('clean'), m('cleanHint')];
  }
  private prepareLayout(): void {
    if (this.activeKey && !this.entries.has(this.activeKey) && !this.activeKey.startsWith('group:')) this.activeKey = this.selectedKey;
    this.layout = localChangesLayout(this.groups, this.collapsed);
    this.rowPositions = new Map(this.layout.rows.map((row, index) => [row.key, index]));
    this.filePositions = new Map(this.groups.flatMap(group => group.entries.map((entry, index) => [entry.key, index + 1] as const)));
    this.groupPositions = this.layout.rows.flatMap((row, index) => row.entry ? [] : [index]);
    if (this.activeKey && !this.rowPositions.has(this.activeKey)) {
      const group = this.entries.get(this.activeKey)?.group; this.activeKey = group ? `group:${group}` : this.selectedKey;
    }
  }
  private scheduleRows(): void { if (!this.destroyed && !this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.renderRows(); }); }
  private renderRows(): void {
    if (this.destroyed) return;
    const virtual = this.layout.files >= LOCAL_VIRTUAL_THRESHOLD;
    this.viewport.classList.toggle('is-virtual', virtual); this.rowsElement.style.height = `${this.layout.height}px`;
    const range = virtual ? localChangesWindow(this.layout.rows, this.viewport.scrollTop, this.viewport.clientHeight || this.listSize) : { first: 0, last: this.layout.rows.length };
    const indexes = new Set<number>(); for (let index = range.first; index < range.last; index++) indexes.add(index);
    const active = this.activeKey ? this.rowPositions.get(this.activeKey) : undefined; if (active !== undefined) indexes.add(active);
    const focused = document.activeElement as HTMLElement | null;
    for (const row of this.rows.values()) if (focused && row.element.contains(focused)) { const index = this.rowPositions.get(row.item.key); if (index !== undefined) indexes.add(index); }
    // Keep the current group heading visible in a virtual window, without mounting its whole group.
    if (virtual) for (const index of this.groupPositions) {
      const row = this.layout.rows[index]; if (row.top <= this.viewport.scrollTop && row.end > this.viewport.scrollTop) { indexes.add(index); break; }
    }
    const items = [...indexes].sort((a, b) => a - b).map(index => this.layout.rows[index]);
    const wanted = new Set(items.map(item => item.key));
    for (const [key, row] of this.rows) if (!wanted.has(key)) { disposeBindings(row.element); row.element.remove(); this.rows.delete(key); }
    for (let index = 0; index < items.length; index++) {
      const item = items[index]; let row = this.rows.get(item.key);
      if (!row) { row = this.createRow(item); this.rows.set(item.key, row); }
      row.item = item; this.updateRow(row, virtual);
      if (this.rowsElement.children[index] !== row.element) this.rowsElement.insertBefore(row.element, this.rowsElement.children[index] ?? null);
    }
    const activeRow = this.activeKey ? this.rows.get(this.activeKey) : undefined;
    if (activeRow) this.viewport.setAttribute('aria-activedescendant', activeRow.element.id); else this.viewport.removeAttribute('aria-activedescendant');
    if (focused && focused !== document.activeElement && focused.isConnected) focused.focus({ preventScroll: true });
  }
  private createRow(item: LocalChangeLayoutRow): RowElement {
    const element = el('div', item.entry ? 'local-changes-file changed-file' : 'local-changes-group change-group-heading');
    element.id = `${this.id}-row-${++this.nextRowId}`; element.setAttribute('role', 'treeitem'); element.tabIndex = -1;
    const row: RowElement = { element, item, actions: [] };
    element.dataset.group = item.group; element.dataset.fileGroup = item.group;
    if (item.entry) {
      row.state = el('span', 'local-changes-file-state file-state'); row.state.setAttribute('aria-hidden', 'true');
      row.name = el('span', 'local-changes-file-name file-name'); row.directory = el('span', 'local-changes-file-directory file-directory');
      const actions = el('span', 'local-changes-file-actions file-actions');
      const stage = button(item.group === 'staged' ? m('unstage', { path: item.entry.file.path }) : m('stage', { path: item.entry.file.path }), () => {
        if (row.item.entry) void this.fileAction(row.item.group === 'staged' ? 'unstage' : 'stage', [row.item.entry]);
      }, item.group === 'staged' ? 'minus' : 'plus', '', true);
      stage.dataset.action = item.group === 'staged' ? 'unstage-file' : 'stage-file'; actions.append(stage); row.actions.push(stage);
      if (item.group !== 'staged') {
        const remove = button(item.group === 'untracked' ? m('delete', { path: item.entry.file.path }) : m('discard', { path: item.entry.file.path }), () => {
          if (row.item.entry) void this.fileAction(row.item.group === 'untracked' ? 'delete-untracked' : 'discard', [row.item.entry]);
        }, item.group === 'untracked' ? 'close' : 'undo', item.group === 'untracked' ? 'danger-text' : '', true);
        remove.dataset.action = item.group === 'untracked' ? 'delete-untracked-file' : 'discard-file'; actions.append(remove); row.actions.push(remove);
      }
      element.append(row.state, row.name, row.directory, actions);
      element.addEventListener('click', event => {
        if (this.destroyed || event.button > 0 || (event.target as Element).closest('button')) return;
        this.activeKey = row.item.key; this.viewport.focus({ preventScroll: true }); if (row.item.entry) void this.selectEntry(row.item.entry);
      });
    } else {
      row.toggle = button(m('collapseGroup', { group: m(item.group) }), () => this.toggleGroup(row.item.group), 'down', 'local-changes-group-toggle', true);
      row.name = el('strong'); row.count = el('span', 'local-changes-count count-badge');
      const all = button(item.group === 'staged' ? m('unstageGroup', { count: numberText(item.count) }) : m('stageGroup', { count: numberText(item.count) }), () => {
        const entries = this.groups.find(group => group.id === row.item.group)?.entries ?? [];
        if (entries.length) void this.fileAction(row.item.group === 'staged' ? 'unstage' : 'stage', entries);
      }, item.group === 'staged' ? 'minus' : 'plus', 'local-changes-group-action', true);
      all.dataset.action = item.group === 'staged' ? 'unstage-group' : 'stage-group'; all.dataset.group = item.group; row.actions.push(all);
      element.append(row.toggle, row.name, row.count, el('span', 'spacer'), all);
      element.addEventListener('click', event => { if (!this.destroyed && !(event.target as Element).closest('button')) this.toggleGroup(row.item.group); });
    }
    return row;
  }
  private updateRow(row: RowElement, virtual: boolean): void {
    const { item, element } = row;
    element.style.position = 'absolute'; element.style.height = `${item.height}px`;
    const pinnedTop = virtual && !item.entry ? Math.max(item.top, Math.min(this.viewport.scrollTop, item.end - item.height)) : item.top;
    element.style.top = `${pinnedTop}px`;
    if (item.entry) {
      const file = item.entry.file, slash = file.path.lastIndexOf('/'), status = localFileStatus(item.entry);
      element.dataset.path = file.path; element.dataset.file = file.path;
      element.classList.toggle('selected', this.selectedKey === item.key); element.setAttribute('aria-selected', String(this.selectedKey === item.key));
      element.setAttribute('aria-level', '2'); element.setAttribute('aria-setsize', String(item.count));
      element.setAttribute('aria-posinset', String(this.filePositions.get(item.key) ?? 1));
      setAttribute(element, 'aria-label', m('filePreview', { path: file.path, group: m(item.group) }));
      setAttribute(element, 'title', m('filePreview', { path: file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path, group: m(item.group === 'staged' ? 'scopeStaged' : item.group === 'unstaged' ? 'scopeUnstaged' : 'scopeUntracked') }));
      setText(row.state!, status); row.state!.classList.toggle('added', status === 'A' || item.group === 'untracked'); row.state!.classList.toggle('deleted', status === 'D');
      setText(row.name!, file.path.slice(slash + 1)); setText(row.directory!, slash >= 0 ? file.path.slice(0, slash) : '');
    } else {
      const expanded = !this.collapsed.has(item.group); element.setAttribute('aria-expanded', String(expanded)); element.setAttribute('aria-level', '1');
      setText(row.name!, m(item.group)); setText(row.count!, numberText(item.count));
      setAttribute(row.toggle!, 'title', m(expanded ? 'collapseGroup' : 'expandGroup', { group: m(item.group) })); setAttribute(row.toggle!, 'aria-label', m(expanded ? 'collapseGroup' : 'expandGroup', { group: m(item.group) })); row.toggle!.setAttribute('aria-expanded', String(expanded));
      element.classList.toggle('is-collapsed', !expanded);
      const label = m(item.group === 'staged' ? 'unstageGroup' : 'stageGroup', { count: numberText(item.count) }); setAttribute(row.actions[0], 'title', label); setAttribute(row.actions[0], 'aria-label', label);
    }
    row.actions.forEach(control => { control.disabled = !this.canWrite(); });
  }
  private toggleGroup(group: LocalChangeGroup): void {
    if (this.destroyed) return;
    if (this.collapsed.has(group)) this.collapsed.delete(group); else this.collapsed.add(group);
    this.activeKey = `group:${group}`; this.prepareLayout(); this.renderRows(); this.callbacks.changed?.();
  }
  private listKeydown(event: KeyboardEvent): void {
    if (this.destroyed || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || (event.target as Element).closest('button,input,textarea,select')) return;
    let index = this.activeKey ? this.rowPositions.get(this.activeKey) ?? 0 : 0;
    const current = this.layout.rows[index]; if (!current) return;
    if (event.key === 'ArrowDown') index = Math.min(this.layout.rows.length - 1, index + 1);
    else if (event.key === 'ArrowUp') index = Math.max(0, index - 1);
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = this.layout.rows.length - 1;
    else if ((event.key === 'Enter' || event.key === ' ') && current.entry) { event.preventDefault(); event.stopPropagation(); void this.selectEntry(current.entry); return; }
    else if ((event.key === 'Enter' || event.key === ' ') && !current.entry) { event.preventDefault(); event.stopPropagation(); this.toggleGroup(current.group); return; }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); if (!current.entry && !this.collapsed.has(current.group)) this.toggleGroup(current.group); else { this.activeKey = `group:${current.group}`; this.revealActive(); } return; }
    else if (event.key === 'ArrowRight' && !current.entry) { event.preventDefault(); event.stopPropagation(); if (this.collapsed.has(current.group)) this.toggleGroup(current.group); else { this.activeKey = this.layout.rows[Math.min(index + 1, this.layout.rows.length - 1)].key; this.revealActive(); } return; }
    else return;
    event.preventDefault(); event.stopPropagation(); const next = this.layout.rows[index]; this.activeKey = next.key;
    if (next.entry) void this.selectEntry(next.entry); this.revealActive();
  }
  private revealActive(): void {
    const position = this.activeKey ? this.rowPositions.get(this.activeKey) : undefined, row = position === undefined ? undefined : this.layout.rows[position]; if (!row) return;
    if (row.top < this.viewport.scrollTop) this.viewport.scrollTop = row.top;
    else if (row.top + row.height > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = Math.max(0, row.top + row.height - this.viewport.clientHeight);
    this.renderRows();
  }
  private currentEntry(): LocalChangeEntry | undefined { return this.selectedKey ? this.entries.get(this.selectedKey) : undefined; }
  private diffSettings(): AppSettings { const settings = this.callbacks.context().settings; return this.localDiffView ? { ...settings, diffView: this.localDiffView } : settings; }
  private renderPreviewHeading(): void {
    const entry = this.currentEntry(); this.previewState.hidden = !entry; this.previewScope.hidden = !entry; this.copyButton.hidden = !entry;
    if (!entry) { setText(this.previewPath, m('chooseFile')); setText(this.previewState, ''); setText(this.previewScope, ''); this.previewPath.removeAttribute('title'); return; }
    const path = entry.file.oldPath && entry.file.oldPath !== entry.file.path ? `${entry.file.oldPath} → ${entry.file.path}` : entry.file.path;
    setText(this.previewPath, path); setAttribute(this.previewPath, 'title', path); setText(this.previewState, localFileStatus(entry));
    setText(this.previewScope, m(entry.group === 'staged' ? 'scopeStaged' : entry.group === 'unstaged' ? 'scopeUnstaged' : 'scopeUntracked'));
    this.previewElement.dataset.path = entry.file.path; this.previewElement.dataset.group = entry.group;
  }
  private renderEmptyPreview(): void {
    this.renderPreviewHeading();
    delete this.previewElement.dataset.path; delete this.previewElement.dataset.group;
    const labels = this.layout.files ? [m('chooseFile'), m('chooseFileHint')] as const : this.emptyLabels(); this.diffContainer.replaceChildren(empty(labels[0], labels[1]));
  }
  private resetDiff(): void {
    this.requests.cancel('diff'); this.cancelContent(); this.viewVersion++; this.diffStatus = 'idle'; this.diffKey = ''; this.diffPending = null; this.result = null; this.sideContents = {};
    this.diffView.clear(); this.diffView.clearCache();
  }
  private async selectEntry(entry: LocalChangeEntry, force = false): Promise<void> {
    const context = this.callbacks.context(), repo = context.repo;
    if (this.destroyed || !repo || repo.id !== this.repoId || !this.entries.has(entry.key)) return;
    const query = localDiffQuery(repo, entry, context.settings), key = JSON.stringify([this.generation, entry.key, query]);
    const same = this.selectedKey === entry.key && this.diffKey === key;
    this.selectedKey = entry.key; this.activeKey = entry.key; this.renderRows(); this.renderPreviewHeading();
    if (same && !force && this.diffStatus === 'loading' && this.diffPending) return this.diffPending;
    if (same && !force && this.diffStatus === 'ready') return;
    this.resetDiff(); this.diffKey = key; this.diffStatus = 'loading';
    const version = this.viewVersion, generation = this.generation;
    const pending = this.loadDiff(query, key, entry.key, version, generation); this.diffPending = pending;
    const finish = (): void => { if (this.diffPending === pending) this.diffPending = null; }; void pending.then(finish, finish); return pending;
  }
  private viewCurrent(repoId: string, key: string, entryKey: string, version: number, generation: number): boolean {
    const context = this.callbacks.context();
    return !this.destroyed && this.repoId === repoId && context.repo?.id === repoId && context.repo.head === this.repoHead && context.generation === this.ownerGeneration && context.working === this.working && context.settings.encoding === this.encoding && this.diffKey === key && this.selectedKey === entryKey && this.viewVersion === version && this.generation === generation;
  }
  private async loadDiff(query: DiffQuery, key: string, entryKey: string, version: number, generation: number): Promise<void> {
    const request = this.requests.begin('diff'); query.requestId = request.id;
    const current = (): boolean => this.viewCurrent(query.repoId, key, entryKey, version, generation) && request.current();
    this.diffContainer.replaceChildren(loading(m('loadingDiff'), () => {
      if (!current()) return;
      this.resetDiff(); this.diffStatus = 'cancelled';
      this.diffContainer.replaceChildren(empty(m('cancelledDiff')), button(m('retry'), () => { const entry = this.currentEntry(); if (entry) void this.selectEntry(entry); }, 'refresh'));
    }));
    try {
      const legacy = !this.host.diffPatch, result = await (this.host.diffPatch ? this.host.diffPatch(query) : this.host.diff(query));
      if (!current()) return;
      this.result = result; this.diffStatus = 'ready';
      if (legacy) for (const side of ['old', 'new'] as const) this.sideContents[side] = { content: side === 'old' ? result.oldContent : result.newContent, binary: result.binary, truncated: result.truncated };
      this.diffContainer.replaceChildren(this.diffView.element);
      this.diffView.updateLocale();
      this.diffView.set(result, this.diffSettings(), true, {
        ensureContent: side => this.ensureContent(side, query, key, entryKey, result, version, generation),
        cancelContent: () => this.cancelContent(),
      });
      this.callbacks.changed?.();
    } catch (error) {
      if (!current()) return;
      this.diffStatus = 'error'; this.diffContainer.replaceChildren(el('div', 'inline-error', errorText(error), button(m('retry'), () => { const entry = this.currentEntry(); if (entry) void this.selectEntry(entry); }, 'refresh'))); this.callbacks.error(error);
    } finally { request.finish(); }
  }
  private cancelContent(): void { this.contentVersion++; this.requests.cancel('content'); this.contentPending = null; }
  private ensureContent(side: 'old' | 'new', query: DiffQuery, key: string, entryKey: string, patch: DiffResult, version: number, generation: number): Promise<LoadedContent> {
    if (!this.viewCurrent(query.repoId, key, entryKey, version, generation) || this.result !== patch) return Promise.reject(Object.assign(new Error(), { code: 'CANCELLED' }));
    const loaded = this.sideContents[side]; if (loaded) return Promise.resolve(loaded);
    if (this.contentPending?.side === side) return this.contentPending.promise;
    this.cancelContent(); const contentVersion = this.contentVersion;
    const promise = this.loadContent(side, query, key, entryKey, patch, version, generation, contentVersion); this.contentPending = { side, promise };
    const finish = (): void => { if (this.contentPending?.promise === promise) this.contentPending = null; }; void promise.then(finish, finish); return promise;
  }
  private async loadContent(side: 'old' | 'new', query: DiffQuery, key: string, entryKey: string, patch: DiffResult, version: number, generation: number, contentVersion: number): Promise<LoadedContent> {
    const request = this.requests.begin('content');
    try {
      const contentQuery = { ...query, requestId: request.id }, result = await (this.host.fileContent ? this.host.fileContent(contentQuery, side) : this.host.diff(contentQuery));
      if (!request.current() || !this.viewCurrent(query.repoId, key, entryKey, version, generation) || this.result !== patch || this.contentVersion !== contentVersion) throw Object.assign(new Error(), { code: 'CANCELLED' });
      const content = { content: side === 'old' ? result.oldContent : result.newContent, binary: result.binary, truncated: result.truncated };
      this.sideContents[side] = content; return content;
    } finally { request.finish(); }
  }

  private async fileAction(kind: 'stage' | 'unstage' | 'discard' | 'delete-untracked', entries: readonly LocalChangeEntry[]): Promise<void> {
    if (!entries.length || kind === 'delete-untracked' && entries.length !== 1) return;
    const capture = this.capture(); if (!capture) return;
    const files = localFileTargets(entries), pending = { repoId: capture.repoId, kind };
    if (!files.length) return;
    this.pendingAction = pending; this.updatePresentation(); this.renderRows();
    let success = false;
    try {
      let confirmation: string | undefined;
      if (kind === 'discard' || kind === 'delete-untracked') {
        const deleting = kind === 'delete-untracked', expected = deleting ? files[0].path : 'discard';
        const repo = this.callbacks.context().repo!;
        const confirmationInput = input(m('confirmation')); confirmationInput.name = 'confirmation'; confirmationInput.autocomplete = 'off'; confirmationInput.spellcheck = false;
        // formDialog trims standard fields; a local input preserves literal paths containing edge whitespace.
        const body = el('div', '', el('pre', 'local-changes-confirm-paths mono', files.map(file => file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path).join('\n')),
          field(m('confirmation'), confirmationInput, m(deleting ? 'deleteHint' : 'discardHint')));
        const confirmationPending = formDialog({
          title: m(deleting ? 'deleteTitle' : 'discardTitle'), description: m(deleting ? 'deleteDescription' : 'discardDescription', { repo: repo.name }),
          body, confirm: m(deleting ? 'confirmDelete' : 'confirmDiscard'), danger: true, dataAction: deleting ? 'confirm-delete-untracked' : 'confirm-discard-working',
          validate: () => confirmationInput.value === expected ? null : m('confirmationMismatch'),
        });
        const dialog = confirmationInput.closest('dialog'); this.confirmationDialog = dialog;
        queueMicrotask(() => { if (confirmationInput.isConnected) confirmationInput.focus({ preventScroll: true }); });
        const values = await confirmationPending;
        if (this.confirmationDialog === dialog) this.confirmationDialog = null;
        if (!values) return;
        confirmation = expected;
      }
      if (!this.captureCurrent(capture)) { if (!this.destroyed && this.callbacks.context().repo?.id === capture.repoId) this.callbacks.error(new LocalizedError(m('indexChanged'))); return; }
      success = await this.callbacks.execute({ kind, files, ...(confirmation ? { confirmation } : {}) }) !== false;
    } catch (error) { if (!this.destroyed && this.callbacks.context().repo?.id === capture.repoId) this.callbacks.error(error); }
    finally {
      if (this.pendingAction === pending) this.pendingAction = null;
      if (!this.destroyed) { this.update(success); this.callbacks.changed?.(); }
    }
  }
  private async commit(): Promise<void> {
    const capture = this.capture(); if (!capture) return;
    if (!this.groups[0].entries.length) { this.showComposerError(m('noStaged')); return; }
    const raw = this.message.value, message = raw.trim();
    if (!message) { this.showComposerError(m('messageRequired')); this.message.focus({ preventScroll: true }); return; }
    if (!this.host.workingIndex) { this.showComposerError(m('commitUnavailable')); return; }
    this.hideComposerError(); this.saveDraft();
    const pending = { repoId: capture.repoId, kind: 'commit-staged' as const }; this.pendingAction = pending; this.updatePresentation(); this.renderRows();
    const request = this.requests.begin('index'), signing = this.callbacks.context().settings.commitSigning;
    let success = false;
    try {
      const expectedIndex = await this.host.workingIndex(capture.repoId, request.id);
      if (!request.current() || !this.captureCurrent(capture)) return;
      if (!expectedIndex) throw new LocalizedError(m('commitUnavailable'));
      request.finish();
      success = await this.callbacks.execute({ kind: 'commit-staged', message, expectedHead: capture.head, expectedIndex, ...(signing === 'git' ? {} : { sign: signing === 'sign' }) }) !== false;
      if (success && !this.destroyed) {
        if (this.repoId === capture.repoId && this.message.value === raw) { this.message.value = ''; this.drafts.delete(capture.repoId); this.hideComposerError(); }
        else if (this.repoId !== capture.repoId && this.drafts.get(capture.repoId)?.message === raw) this.drafts.delete(capture.repoId);
      }
    } catch (error) { if (!this.destroyed && this.callbacks.context().repo?.id === capture.repoId) this.callbacks.error(error); }
    finally {
      request.finish(); if (this.pendingAction === pending) this.pendingAction = null;
      if (!this.destroyed) { this.update(success); this.callbacks.changed?.(); }
    }
  }
}

import type { AppSettings, DiffResult } from '../shared/protocol';
import { contentRows, DiffRowLayout, minimalDiffScrollTop, PatchModelCache, projectDiff, type ContentSide, type DiffChangeRange, type DiffDocument, type DiffRows, type DiffViewLine } from '../lib/diff';
import { errorText } from '../lib/format';
import { m } from '../i18n/history';
import { m as nav } from '../i18n/diff-navigation';
import { performanceDiagnostics as perf, type PerformanceContext, type PerformanceOutcome, type PerformanceSpan } from '../lib/performance';
import { button, disposeBindings, el, empty, loading, select, setAttribute, setText } from './dom';
import './diff-view.css';

export interface DiffSemanticAnchor {
  id?: string; changeId?: string; gapId?: string; old?: number | null; next?: number | null; offset: number;
}
export interface DiffViewState {
  scrollTop: number; scrollLeft: number; mode: 'diff' | 'new' | 'old';
  activeChange?: string; showUnchanged?: boolean; expandedGaps?: string[]; anchor?: DiffSemanticAnchor;
}
export interface DiffNavigationState { changeCount: number; activeChange: number; activeChangeId: string | null }
export interface DiffNavigation {
  /** Zero-based path index in the controller's currently navigable file set. */
  fileIndex?: number; fileCount?: number;
  previousFile?: () => void; nextFile?: () => void;
  previousChangeBoundary?: () => void; nextChangeBoundary?: () => void;
  /** Explicit opt-in, scoped to the historical document. Never binds to document/window. */
  keyboardRoot?: HTMLElement;
  onChange?: (state: DiffNavigationState) => void;
}
export interface LoadedContent { content: string | null; binary: boolean; truncated: boolean }
export interface DiffContentAccess { ensureContent: (side: ContentSide) => Promise<LoadedContent>; cancelContent: () => void }
interface SideView { status: 'idle' | 'loading' | 'ready' | 'error' | 'cancelled'; data?: LoadedContent; rows?: DiffRows; error?: unknown }
interface PendingPosition { top: number; left: number; anchor?: DiffSemanticAnchor }
interface Projection {
  source: DiffRows; split: boolean; show: boolean; gaps: string; old?: LoadedContent; next?: LoadedContent;
  status?: DiffViewLine['gapStatus']; rows: DiffRows;
}

export class DiffView {
  readonly element = el('section', 'diff-view');
  /** May be moved into a controller-owned header slot; subsequent builds never reparent it. */
  readonly toolbar = el('div', 'diff-toolbar');
  private viewport = el('div', 'diff-scroll');
  private content = el('div', 'diff-content');
  private rows = el('div', 'diff-rows');
  private mode: 'diff' | 'new' | 'old' = 'diff';
  private result: DiffResult | null = null;
  private settings: AppSettings | null = null;
  private lines: DiffViewLine[] = [];
  private models = new PatchModelCache();
  private patchRows: { result: DiffResult; unified?: DiffRows; split?: DiffRows } | null = null;
  private document: DiffDocument | null = null;
  private changes: DiffChangeRange[] = [];
  private changeIndexes = new Map<string, number>();
  private activeId: string | null = null;
  private navigation: DiffNavigation | null = null;
  private notified = '';
  private showUnchanged = false;
  private expandedGaps = new Set<string>();
  private projection: Projection | null = null;
  private pendingPosition: PendingPosition | null = null;
  private pendingReveal: string | null = null;
  private lastVisiblePosition: PendingPosition | null = null;
  private layout: DiffRowLayout | null = null;
  private layoutSource: DiffViewLine[] | null = null;
  private layoutWidth = 0;
  private layoutLineHeight = 0;
  private layoutFontSize = 0;
  private mountedRows = new Map<Element, number>();
  private rowObserver: ResizeObserver;
  private characterWidth = 0;
  private contentAccess: DiffContentAccess | undefined;
  private sides: Record<ContentSide, SideView> = { old: { status: 'idle' }, new: { status: 'idle' } };
  private contentVersion = 0;
  private loadingSide: ContentSide | null = null;
  private loadingPromise: Promise<void> | null = null;
  private frame = 0;
  private lineHeight = 20;
  private observer: ResizeObserver;
  private split = false;
  private info = el('span', 'muted');
  private counter: HTMLElement | null = null;
  private previousChange: HTMLButtonElement | null = null;
  private nextChange: HTMLButtonElement | null = null;
  private selectionRange = '';
  private performanceContext: PerformanceContext | undefined;
  private scheduledSpan: PerformanceSpan | undefined;

  constructor(private readonly changeView: (view: AppSettings['diffView']) => void, private readonly copy: (text: string) => void) {
    this.viewport.tabIndex = 0; this.viewport.setAttribute('role', 'region'); setAttribute(this.viewport, 'aria-label', m('diff.label'));
    this.content.append(this.rows); this.viewport.append(this.content); this.element.append(this.toolbar, this.viewport);
    this.viewport.addEventListener('scroll', () => { if (this.visible() && !this.pendingPosition) this.lastVisiblePosition = { top: this.viewport.scrollTop, left: this.viewport.scrollLeft, anchor: this.captureAnchor() }; this.schedule(); });
    this.observer = new ResizeObserver(() => this.schedule()); this.observer.observe(this.viewport);
    this.rowObserver = new ResizeObserver(entries => this.measureRows(entries));
    this.viewport.addEventListener('keydown', event => {
      if (event.isComposing || this.isInput(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault(); this.selectionRange = this.displayedContent();
        setAttribute(this.viewport, 'aria-label', m('diff.allSelected')); this.viewport.classList.add('all-selected');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && this.selectionRange) { event.preventDefault(); this.copy(this.selectionRange); }
      if (event.key === 'Escape' && this.selectionRange) { event.preventDefault(); event.stopPropagation(); this.clearSelection(); }
    });
    this.viewport.addEventListener('pointerdown', () => this.clearSelection());
    this.viewport.addEventListener('focusout', () => this.clearSelection());
    this.viewport.addEventListener('copy', this.copySelection);
  }

  get changeCount(): number { return this.result?.binary ? 0 : this.document?.changes.length ?? 0; }
  get activeChange(): number { return this.activeId === null ? -1 : this.changeIndexes.get(this.activeId) ?? -1; }
  get activeChangeId(): string | null { return this.activeChange < 0 ? null : this.activeId; }

  setNavigation(navigation: DiffNavigation | null): void {
    this.navigation?.keyboardRoot?.removeEventListener('keydown', this.navigationKeydown);
    const position = this.capturePosition();
    this.navigation = navigation; this.notified = ''; this.projection = null;
    this.navigation?.keyboardRoot?.addEventListener('keydown', this.navigationKeydown);
    this.element.classList.toggle('historical-diff', Boolean(navigation));
    this.toolbar.classList.toggle('historical-diff-toolbar', Boolean(navigation));
    if (navigation) { this.toolbar.setAttribute('role', 'toolbar'); setAttribute(this.toolbar, 'aria-label', nav('toolbar')); }
    else { this.toolbar.removeAttribute('role'); setAttribute(this.toolbar, 'aria-label', null); }
    this.build(position); this.notifyNavigation();
  }
  private isInput(target: EventTarget | null): boolean {
    const node = target as HTMLElement | null;
    return Boolean(node?.isContentEditable || node?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
  }
  private navigationKeydown = (event: KeyboardEvent): void => {
    if (!this.navigation || event.defaultPrevented || event.isComposing || event.keyCode === 229 || this.isInput(event.target) || !event.altKey || event.ctrlKey || event.metaKey) return;
    let action: (() => unknown) | undefined;
    if (event.key === 'F5') action = () => this.navigateChange(event.shiftKey ? -1 : 1);
    else if (!event.shiftKey && event.key === 'PageUp') action = this.navigation.previousFile;
    else if (!event.shiftKey && event.key === 'PageDown') action = this.navigation.nextFile;
    if (!action) return;
    event.preventDefault(); event.stopPropagation(); action();
  };
  navigateChange(direction: -1 | 1, edge?: 'first' | 'last'): boolean {
    if (!this.result) return false;
    const count = this.changeCount;
    const index = edge ? edge === 'first' ? 0 : count - 1 : this.activeChange < 0 ? direction === 1 ? 0 : count - 1 : this.activeChange + direction;
    if (!count || index < 0 || index >= count) {
      if (edge) return false;
      const boundary = direction < 0 ? this.navigation?.previousChangeBoundary : this.navigation?.nextChangeBoundary;
      if (!boundary) return false;
      boundary(); return true;
    }
    if (this.mode !== 'diff') { this.cancelPendingContent(); this.mode = 'diff'; this.build(this.capturePosition()); }
    this.activeId = this.document!.changes[index].id; this.pendingReveal = this.activeId;
    this.notifyNavigation(); this.render(); return true;
  }
  setShowUnchanged(show: boolean): void {
    if (this.showUnchanged === show) return;
    const position = this.capturePosition(); this.showUnchanged = show; this.projection = null;
    if (!show && !this.expandedGaps.size && this.mode === 'diff') this.cancelPendingContent();
    this.clearSelection(); this.build(position);
  }
  toggleGap(id: string): void {
    if (!this.document?.sections.some(section => section.kind === 'gap' && section.id === id)) return;
    const position = this.capturePosition();
    if (this.expandedGaps.has(id)) this.expandedGaps.delete(id); else this.expandedGaps.add(id);
    this.projection = null;
    if (!this.showUnchanged && !this.expandedGaps.size && this.mode === 'diff') this.cancelPendingContent();
    this.clearSelection(); this.build(position);
  }
  private notifyNavigation(): void {
    const count = this.changeCount, active = this.activeChange;
    if (this.counter) setText(this.counter, nav('changes', { active: active + 1, count }));
    if (this.previousChange) this.previousChange.disabled = !count ? !this.navigation?.previousChangeBoundary : active <= 0 && !this.navigation?.previousChangeBoundary;
    if (this.nextChange) this.nextChange.disabled = !count ? !this.navigation?.nextChangeBoundary : active >= count - 1 && !this.navigation?.nextChangeBoundary;
    const signature = `${count}:${active}:${this.activeChangeId}`;
    if (signature === this.notified) return;
    this.notified = signature; this.navigation?.onChange?.({ changeCount: count, activeChange: active, activeChangeId: this.activeChangeId });
  }
  private displayedContent(): string { return this.mode === 'diff' ? this.result?.patch ?? '' : this.sides[this.mode].data?.content ?? ''; }
  /** Locale changes are presentation-only: no model, scrolling, or content requests. */
  updateLocale(): void { setAttribute(this.viewport, 'aria-label', this.viewport.classList.contains('all-selected') ? m('diff.allSelected') : m('diff.label')); }
  private clearSelection(): void { this.selectionRange = ''; this.viewport.classList.remove('all-selected'); setAttribute(this.viewport, 'aria-label', m('diff.label')); }
  private copySelection = (event: ClipboardEvent): void => {
    if (this.selectionRange) { event.preventDefault(); event.clipboardData?.setData('text/plain', this.selectionRange); return; }
    const selection = window.getSelection(); if (!selection?.rangeCount || !selection.toString()) return;
    const range = selection.getRangeAt(0);
    if (!this.viewport.contains(range.commonAncestorContainer)) return;
    const fragment = range.cloneContents();
    fragment.querySelectorAll('.line-number,.line-sign,.diff-gap,.diff-gap-status').forEach(node => node.remove());
    const rows = [...fragment.querySelectorAll<HTMLElement>('.diff-line')];
    const text = rows.length ? rows.map(row => {
      if (row.classList.contains('split-line')) return [...row.querySelectorAll<HTMLElement>('.line-text')].map(node => node.textContent ?? '').join('\t');
      return row.querySelector('.line-text,.diff-hunk-text')?.textContent ?? row.textContent ?? '';
    }).join('\n') : fragment.textContent ?? '';
    event.preventDefault(); event.clipboardData?.setData('text/plain', text);
  };

  private visible(): boolean { return this.viewport.clientHeight > 0 && this.viewport.clientWidth > 0; }
  private captureAnchor(): DiffSemanticAnchor | undefined {
    if (!this.visible() || !this.lines.length) return;
    const index = Math.min(this.lines.length - 1, this.rowIndex(this.viewport.scrollTop)), line = this.lines[index];
    return { id: line.id, changeId: line.changeId, gapId: line.gapId, old: line.old, next: line.next, offset: this.viewport.scrollTop - this.rowOffset(index) };
  }
  private capturePosition(): PendingPosition {
    // A hidden tab's clamped 0/0 is not a new user position.
    if (this.pendingPosition) return this.pendingPosition;
    if (!this.visible() && this.lastVisiblePosition) return this.lastVisiblePosition;
    const position = { top: this.viewport.scrollTop, left: this.viewport.scrollLeft, anchor: this.captureAnchor() };
    if (this.visible()) this.lastVisiblePosition = position;
    return position;
  }
  private anchorIndex(anchor: DiffSemanticAnchor): number {
    let index = anchor.id ? this.lines.findIndex(line => line.id === anchor.id) : -1;
    if (index >= 0) return index;
    const numbered = (line: DiffViewLine): boolean => (anchor.old !== null && anchor.old !== undefined && line.old === anchor.old) || (anchor.next !== null && anchor.next !== undefined && line.next === anchor.next);
    index = this.lines.findIndex(line => numbered(line) && (!anchor.changeId || line.changeId === anchor.changeId));
    if (index >= 0) return index;
    if (anchor.changeId) { index = this.lines.findIndex(line => line.changeId === anchor.changeId); if (index >= 0) return index; }
    if (anchor.gapId) { index = this.lines.findIndex(line => line.gapId === anchor.gapId); if (index >= 0) return index; }
    // Context settings change gap boundaries but not source line coordinates.
    if (anchor.old != null || anchor.next != null) return this.lines.findIndex(line => line.kind === 'gap' && this.document?.sections.some(section => section.kind === 'gap' && section.id === line.gapId && ((anchor.old != null && anchor.old >= section.oldStart && (section.oldEnd === null || anchor.old < section.oldEnd)) || (anchor.next != null && anchor.next >= section.newStart && (section.newEnd === null || anchor.next < section.newEnd)))));
    return -1;
  }
  private applyPendingPosition(): void {
    const pending = this.pendingPosition;
    if (!pending || !this.visible() || !this.lines.length) return;
    const index = pending.anchor ? this.anchorIndex(pending.anchor) : -1;
    const top = index < 0 ? pending.top : this.rowOffset(index) + Math.min((this.layout?.heightAt(index) ?? this.lineHeight) - 1, Math.max(0, pending.anchor!.offset));
    this.pendingPosition = null;
    if (this.viewport.scrollTop !== top) this.viewport.scrollTop = Math.max(0, top);
    if (this.viewport.scrollLeft !== pending.left) this.viewport.scrollLeft = Math.max(0, pending.left);
    this.lastVisiblePosition = { top: this.viewport.scrollTop, left: this.viewport.scrollLeft, anchor: this.captureAnchor() };
  }
  private revealActive(): void {
    if (!this.pendingReveal || !this.visible()) return;
    const range = this.changes.find(change => change.id === this.pendingReveal);
    if (!range) return;
    this.pendingReveal = null;
    const top = minimalDiffScrollTop(this.viewport.scrollTop, this.viewport.clientHeight, this.rowOffset(range.first), this.rowOffset(range.last), this.lineHeight);
    if (top !== this.viewport.scrollTop) this.viewport.scrollTop = top;
  }
  getState(): DiffViewState {
    const position = this.capturePosition();
    return { scrollTop: position.top, scrollLeft: position.left, mode: this.mode, ...(this.navigation ? { activeChange: this.activeChangeId ?? undefined, showUnchanged: this.showUnchanged, expandedGaps: [...this.expandedGaps], anchor: position.anchor } : {}) };
  }
  restore(state: Partial<DiffViewState>): void {
    const position: PendingPosition = { top: Math.max(0, state.scrollTop ?? 0), left: Math.max(0, state.scrollLeft ?? 0), anchor: state.anchor };
    let rebuild = false;
    if (state.mode && state.mode !== this.mode) { this.cancelPendingContent(); this.mode = state.mode; this.clearSelection(); rebuild = true; }
    if (state.showUnchanged !== undefined) { this.showUnchanged = state.showUnchanged; rebuild = true; }
    if (state.expandedGaps) { this.expandedGaps = new Set(state.expandedGaps); rebuild = true; }
    if (state.activeChange !== undefined) this.activeId = state.activeChange;
    this.pendingPosition = position;
    if (rebuild) { this.projection = null; this.build(position); }
    else { this.applyPendingPosition(); this.notifyNavigation(); }
    this.schedule();
  }
  clear(): void {
    this.cancelPendingContent(); this.clearSelection(); this.result = null; this.patchRows = null; this.contentAccess = undefined;
    this.sides = { old: { status: 'idle' }, new: { status: 'idle' } }; this.lines = []; this.document = null; this.changes = []; this.changeIndexes.clear(); this.activeId = null;
    this.projection = null; this.pendingPosition = null; this.pendingReveal = null; this.lastVisiblePosition = null; this.layout = null; this.layoutSource = null; this.rowObserver.disconnect(); this.mountedRows.clear();
    this.rows.replaceChildren(); this.content.style.height = '0px'; this.viewport.removeAttribute('aria-busy'); this.notifyNavigation();
  }
  clearCache(): void { this.models.clear(); this.patchRows = null; this.projection = null; }
  set(result: DiffResult, settings: AppSettings, reset = true, contentAccess?: DiffContentAccess): void {
    this.performanceContext = perf.context();
    const position = !reset ? this.capturePosition() : undefined;
    if (this.result !== result || reset) {
      this.cancelPendingContent(); this.clearSelection(); this.contentAccess = contentAccess;
      this.sides = contentAccess ? { old: { status: 'idle' }, new: { status: 'idle' } } : {
        old: { status: 'ready', data: { content: result.oldContent, binary: result.binary, truncated: result.truncated } },
        new: { status: 'ready', data: { content: result.newContent, binary: result.binary, truncated: result.truncated } },
      };
      this.projection = null;
    }
    if (this.patchRows?.result !== result) this.patchRows = { result };
    this.result = result; this.settings = settings;
    if (reset) {
      this.mode = 'diff'; this.activeId = null; this.showUnchanged = false; this.expandedGaps.clear(); this.pendingPosition = null; this.pendingReveal = null; this.lastVisiblePosition = null;
      if (this.viewport.scrollTop !== 0) this.viewport.scrollTop = 0;
      if (this.viewport.scrollLeft !== 0) this.viewport.scrollLeft = 0;
    }
    this.build(position);
  }
  private cancelPendingContent(cancelled = false): void {
    this.contentVersion++;
    if (this.loadingSide) { this.contentAccess?.cancelContent(); this.sides[this.loadingSide].status = cancelled ? 'cancelled' : 'idle'; }
    this.loadingSide = null; this.loadingPromise = null;
  }
  private requestContent(side: ContentSide): void {
    if (!this.contentAccess || this.loadingSide || this.sides[side].status !== 'idle') return;
    const result = this.result, version = ++this.contentVersion, state = this.sides[side], access = this.contentAccess, parent = perf.context() ?? this.performanceContext;
    state.status = 'loading'; this.loadingSide = side;
    this.loadingPromise = Promise.resolve().then(() => {
      if (version !== this.contentVersion || result !== this.result) throw Object.assign(new Error(), { code: 'CANCELLED' });
      return perf.run(parent, () => access.ensureContent(side));
    }).then(data => {
      if (version !== this.contentVersion || result !== this.result) return;
      state.status = 'ready'; state.data = data;
    }, error => {
      if (version !== this.contentVersion || result !== this.result) return;
      state.status = 'error'; state.error = error;
    }).then(() => {
      if (version !== this.contentVersion || result !== this.result) return;
      const position = this.capturePosition(); this.loadingSide = null; this.loadingPromise = null; this.projection = null; this.build(position);
    });
  }
  private contextStatus(): DiffViewLine['gapStatus'] {
    const sides = [this.sides.old, this.sides.new];
    if (sides.some(state => state.status === 'error')) return 'error';
    if (sides.some(state => state.status === 'cancelled')) return 'cancelled';
    if (sides.some(state => state.status === 'idle' || state.status === 'loading')) return 'loading';
    return undefined;
  }
  private ensureContext(): void {
    // One content-access cancellation token is shared by both sides: never race those requests.
    for (const side of ['old', 'new'] as const) {
      const state = this.sides[side];
      if (state.status === 'idle') { this.requestContent(side); return; }
      if (state.status !== 'ready') return;
    }
  }
  private retryContext(): void {
    const position = this.capturePosition();
    for (const side of ['old', 'new'] as const) if (this.sides[side].status === 'error' || this.sides[side].status === 'cancelled') this.sides[side] = { status: 'idle' };
    this.projection = null; this.build(position);
  }
  private async changeMode(mode: DiffViewState['mode']): Promise<void> {
    if (mode === this.mode) return;
    const operation = perf.operation('diffMode'); this.performanceContext = operation.context; let outcome: PerformanceOutcome = 'ok';
    const position = this.navigation ? this.capturePosition() : { top: 0, left: 0 };
    try {
      operation.run(() => { this.cancelPendingContent(); this.mode = mode; this.clearSelection(); this.build(position); });
      const version = this.contentVersion; await this.loadingPromise;
      outcome = version !== this.contentVersion ? 'cancelled' : mode !== 'diff' && this.sides[mode].status === 'error' ? 'error' : 'ok';
    } finally { operation.end({ outcome }); }
  }
  private buildToolbar(settings: AppSettings): void {
    const mode = select([{ value: 'diff', label: m('diff.changes') }, { value: 'new', label: m('diff.newFile') }, { value: 'old', label: m('diff.oldFile') }], this.mode, m('diff.contentView'), value => { void this.changeMode(value as DiffViewState['mode']); });
    this.info = el('span', 'muted'); this.counter = null; this.previousChange = null; this.nextChange = null;
    const unified = button(m('diff.unified'), () => this.changeDiffView('unified'), 'unified', settings.diffView === 'unified' ? 'active' : '', true); unified.setAttribute('aria-pressed', String(settings.diffView === 'unified'));
    const split = button(m('diff.split'), () => this.changeDiffView('split'), 'split', settings.diffView === 'split' ? 'active' : '', true); split.setAttribute('aria-pressed', String(settings.diffView === 'split'));
    const copy = button(m('diff.copy'), () => this.copy(this.displayedContent()), 'copy', '', true);
    copy.disabled = this.mode !== 'diff' && (this.sides[this.mode].status !== 'ready' || this.sides[this.mode].data?.content === null);
    const controls: HTMLElement[] = [];
    if (this.navigation) {
      const previousFile = button(nav('previousFileShort'), () => this.navigation?.previousFile?.(), 'arrowUp'), nextFile = button(nav('nextFileShort'), () => this.navigation?.nextFile?.(), 'arrowDown');
      setAttribute(previousFile, 'title', nav('previousFile')); setAttribute(nextFile, 'title', nav('nextFile'));
      previousFile.disabled = !this.navigation.previousFile; nextFile.disabled = !this.navigation.nextFile;
      previousFile.dataset.action = 'previous-file'; nextFile.dataset.action = 'next-file';
      this.previousChange = button(nav('previousChangeShort'), () => this.navigateChange(-1), 'arrowUp');
      this.nextChange = button(nav('nextChangeShort'), () => this.navigateChange(1), 'arrowDown');
      setAttribute(this.previousChange, 'title', nav('previousChange')); setAttribute(this.nextChange, 'title', nav('nextChange'));
      this.previousChange.dataset.action = 'previous-change'; this.nextChange.dataset.action = 'next-change';
      this.counter = el('span', 'diff-change-counter'); this.counter.setAttribute('role', 'status'); this.counter.setAttribute('aria-live', 'polite');
      const show = button(nav('showUnchanged'), () => this.setShowUnchanged(!this.showUnchanged), 'eye', 'diff-context-toggle');
      show.setAttribute('role', 'switch'); show.setAttribute('aria-checked', String(this.showUnchanged)); show.dataset.action = 'show-unchanged';
      const fileCounter = this.navigation.fileCount === undefined ? null : el('span', 'diff-file-counter', nav('files', { active: Math.max(0, (this.navigation.fileIndex ?? -1) + 1), count: this.navigation.fileCount }));
      controls.push(el('div', 'button-group diff-file-navigation', previousFile, fileCounter, nextFile), el('div', 'button-group diff-change-navigation', this.previousChange, this.counter, this.nextChange), show);
    }
    disposeBindings(this.toolbar);
    if (this.navigation) {
      const more = el('details', 'diff-secondary-menu');
      const summary = el('summary', 'button icon-button');
      setAttribute(summary, 'title', nav('more')); setAttribute(summary, 'aria-label', nav('more')); summary.textContent = '···';
      more.append(summary, el('div', 'diff-secondary-popover', mode, copy));
      const secondary = el('div', 'diff-secondary-controls', el('div', 'button-group', unified, split), more);
      this.toolbar.replaceChildren(...controls, this.info, secondary);
    } else this.toolbar.replaceChildren(mode, el('div', 'button-group', unified, split), this.info, el('span', 'spacer'), copy);
  }
  private build(position?: PendingPosition): void {
    if (position) this.pendingPosition = position;
    if (!this.result || !this.settings) return;
    const span = perf.span('diff', 'model', undefined, perf.context() ?? this.performanceContext);
    try {
      const result = this.result, settings = this.settings;
      this.lineHeight = Math.max(18, Math.round(settings.fontSize * 1.55));
      this.element.style.setProperty('--diff-line-height', `${this.lineHeight}px`);
      this.buildToolbar(settings);
      this.split = this.mode === 'diff' && settings.diffView === 'split'; this.viewport.classList.toggle('is-split', this.split); this.viewport.removeAttribute('aria-busy'); this.lines = []; this.changes = [];
      if (result.binary && this.mode === 'diff') { this.document = null; this.activeId = null; this.changeIndexes.clear(); this.placeholder(empty(m('diff.binary'), m('diff.binaryHint'))); return; }
      let model: DiffRows;
      const variant = settings.diffView === 'split' ? 'split' : 'unified';
      if (!this.patchRows) this.patchRows = { result };
      const patchModel = this.patchRows[variant] ??= this.models.prepare(result, settings.diffView === 'split');
      if (this.document !== patchModel.document) {
        this.document = patchModel.document ?? null; this.changeIndexes = new Map(this.document?.changes.map((change, index) => [change.id, index]));
      }
      if (!this.activeId || !this.changeIndexes.has(this.activeId)) this.activeId = this.document?.changes[0]?.id ?? null;
      if (this.mode !== 'diff') {
        const side = this.mode, state = this.sides[side];
        if (state.status === 'idle') this.requestContent(side);
        if (state.status === 'loading') {
          const label = side === 'new' ? m('diff.loadingNew') : m('diff.loadingOld');
          this.viewport.setAttribute('aria-busy', 'true'); setText(this.info, label);
          this.placeholder(loading(label, () => { this.cancelPendingContent(true); this.build(); })); return;
        }
        if (state.status === 'error' || state.status === 'cancelled') {
          setText(this.info, state.status === 'cancelled' ? m('diff.contentCancelled') : m('diff.contentFailed'));
          this.placeholder(el('div', 'inline-error', state.status === 'error' ? errorText(state.error) : m('diff.contentCancelled'), button(m('diff.retryContent'), () => { state.status = 'idle'; this.build(); }, 'refresh'))); return;
        }
        if (!state.data || state.data.content === null || state.data.binary) {
          this.placeholder(empty(m('diff.contentUnavailable'), state.data?.binary || result.binary ? m('diff.binaryContentHint') : m('diff.missingContentHint'))); return;
        }
        model = state.rows ??= contentRows(state.data.content, side); setText(this.info, m('diff.readOnly'));
        if (state.data.truncated) setText(this.info, m('diff.limited'));
      } else {
        model = patchModel;
        if (!model.hunkCount) {
          if (result.truncated || model.limited) { setText(this.info, m('diff.limited')); this.placeholder(empty(m('diff.limitedUnavailable'), m('diff.limitedHint'))); }
          else this.placeholder(empty(result.patch ? m('diff.noHunks') : m('diff.noDifferences'), result.patch || m('diff.chooseSide')));
          return;
        }
        if (this.navigation && this.document) {
          if (this.showUnchanged || this.expandedGaps.size) this.ensureContext();
          const status = this.contextStatus(), gaps = [...this.expandedGaps].sort().join('|'), old = this.sides.old.data, next = this.sides.new.data, cached = this.projection;
          if (cached?.source === patchModel && cached.split === this.split && cached.show === this.showUnchanged && cached.gaps === gaps && cached.old === old && cached.next === next && cached.status === status) model = cached.rows;
          else {
            model = projectDiff(this.document, this.split, { showUnchanged: this.showUnchanged, expandedGaps: this.expandedGaps, oldContent: old, newContent: next, contextStatus: status });
            this.projection = { source: patchModel, split: this.split, show: this.showUnchanged, gaps, old, next, status, rows: model };
          }
          this.changes = model.changes ?? [];
          if (this.loadingSide) { this.viewport.setAttribute('aria-busy', 'true'); setText(this.info, nav('loading')); }
        }
      }
      this.lines = model.lines;
      this.prepareLayout();
      if (result.truncated || model.limited) setText(this.info, m('diff.limited'));
      if (!this.lines.length) { this.placeholder(empty(m('diff.emptyFile'))); return; }
      this.content.style.height = `${this.totalHeight()}px`; this.render();
    } finally { span.end({ count: this.lines.length }); this.notifyNavigation(); }
  }
  private rowOffset(index: number): number { return this.layout?.offsetAt(index) ?? index * this.lineHeight; }
  private rowIndex(offset: number): number { return this.layout?.indexAt(offset) ?? Math.max(0, Math.floor(offset / this.lineHeight)); }
  private totalHeight(): number { return this.layout?.height ?? this.lines.length * this.lineHeight; }
  private measureCharacterWidth(): number {
    const probe = el('span', 'diff-font-probe', '00000000000000000000000000000000'); this.viewport.append(probe);
    const width = probe.getBoundingClientRect?.().width ?? 0; probe.remove();
    return width > 0 ? width / 32 : (this.settings?.fontSize ?? 13) * .56;
  }
  private prepareLayout(): void {
    if (!this.navigation || !this.split) { this.layout = null; this.layoutSource = null; this.content.style.width = ''; return; }
    const width = this.viewport.clientWidth, fontSize = this.settings?.fontSize ?? 13;
    if (this.layoutSource === this.lines && this.layoutWidth === width && this.layoutLineHeight === this.lineHeight && this.layoutFontSize === fontSize) return;
    // Never replace a restored/previous visible geometry with estimates for a zero-size tab.
    if (width <= 0 || !this.visible()) return;
    const position = this.pendingPosition ?? this.lastVisiblePosition ?? this.capturePosition();
    if (this.layoutFontSize !== fontSize || !this.characterWidth) this.characterWidth = this.measureCharacterWidth();
    this.layoutWidth = width; this.layoutLineHeight = this.lineHeight; this.layoutFontSize = fontSize; this.layoutSource = this.lines;
    const columns = Math.max(1, Math.floor((width / 2 - 45 - 21 - 19) / this.characterWidth));
    const estimate = (text: string): number => {
      // Fast ASCII path; full-width and tab-heavy rows are measured without allocating grapheme arrays.
      let cells = text.length;
      if (/[^\x20-\x7e]/.test(text)) {
        cells = 0;
        for (let index = 0; index < text.length; index++) {
          const code = text.codePointAt(index)!;
          if (code === 9) cells += 4 - cells % 4;
          else if (code >= 0x300 && code <= 0x36f) continue;
          else cells += code >= 0x1100 && (code <= 0x115f || code >= 0x2e80) ? 2 : 1;
          if (code > 0xffff) index++;
        }
      }
      return Math.max(1, Math.ceil(cells / columns));
    };
    this.layout = new DiffRowLayout(this.lines.map(line => line.kind === 'split-line' ? Math.max(estimate(line.left), estimate(line.right ?? '')) * this.lineHeight : this.lineHeight));
    this.content.style.width = '100%'; this.content.style.height = `${this.layout.height}px`;
    this.pendingPosition = position;
  }
  private measureRows(entries: readonly ResizeObserverEntry[] | undefined): void {
    if (!entries?.length || !this.layout || !this.visible()) return;
    const position = this.capturePosition(); let changed = false;
    for (const entry of entries) {
      const index = this.mountedRows.get(entry.target); if (index === undefined) continue;
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect?.height ?? 0;
      changed = this.layout.measure(index, height) || changed;
    }
    if (!changed) return;
    this.pendingPosition = position; this.content.style.height = `${this.layout.height}px`; this.applyPendingPosition(); this.schedule();
  }
  private placeholder(node: HTMLElement): void {
    this.layout = null; this.layoutSource = null; this.rowObserver.disconnect(); this.mountedRows.clear();
    this.content.style.height = '100%'; disposeBindings(this.rows); this.rows.replaceChildren(node);
  }
  private changeDiffView(view: AppSettings['diffView']): void {
    const operation = perf.operation('diffMode'); this.performanceContext = operation.context;
    try { operation.run(() => this.changeView(view)); } finally { operation.end(); }
  }
  private schedule(): void {
    if (!this.frame) {
      this.scheduledSpan = perf.span('diff', 'scheduled-render', undefined, perf.context() ?? this.performanceContext);
      this.frame = requestAnimationFrame(() => {
        this.frame = 0; const span = this.scheduledSpan; this.scheduledSpan = undefined;
        try { if (this.lines.length) perf.run(this.performanceContext, () => this.render()); } finally { span?.end(); }
      });
    }
  }
  private gapRow(row: HTMLElement, line: DiffViewLine): void {
    if (line.kind === 'gap') {
      row.classList.add('diff-gap');
      const control = button(line.gapCount === undefined ? nav('context') : nav('gap', { count: line.gapCount }), () => this.toggleGap(line.gapId!), line.expanded ? 'minus' : 'plus', 'diff-gap-toggle');
      control.setAttribute('aria-expanded', String(line.expanded)); control.dataset.gapId = line.gapId; row.append(control);
    } else {
      row.classList.add('diff-gap-status');
      const status = line.gapStatus ?? 'unavailable';
      row.append(el('span', 'diff-context-status', nav(status === 'error' ? 'failed' : status)));
      if (status === 'loading') row.append(button(nav('cancel'), () => { const position = this.capturePosition(); this.cancelPendingContent(true); this.projection = null; this.build(position); }, 'close', '', true));
      if (status === 'error' || status === 'cancelled') row.append(button(nav('retry'), () => this.retryContext(), 'refresh', '', true));
    }
  }
  private render(): void {
    const span = perf.span('diff', 'render', { count: this.lines.length }, perf.context() ?? this.performanceContext); let renderedCount = 0;
    try {
      this.prepareLayout(); this.applyPendingPosition();
      const revealing = this.pendingReveal; this.revealActive();
      const first = Math.min(this.lines.length, Math.max(0, this.rowIndex(this.viewport.scrollTop) - 8));
      const last = Math.min(this.lines.length, this.rowIndex(this.viewport.scrollTop + this.viewport.clientHeight) + 9); renderedCount = Math.max(0, last - first);
      const fragment = document.createDocumentFragment(), mounted: { row: HTMLElement; index: number }[] = [];
      for (let index = first; index < last; index++) {
        const line = this.lines[index], row = el('div', `diff-line ${line.kind}`); row.style.top = `${this.rowOffset(index)}px`;
        if (this.layout && line.kind === 'split-line') row.classList.add('is-wrapped');
        mounted.push({ row, index });
        if (line.id) row.dataset.rowId = line.id;
        if (line.changeId) {
          row.dataset.changeId = line.changeId; row.classList.toggle('is-active-change', line.changeId === this.activeId);
          row.addEventListener('click', () => { this.activeId = line.changeId!; this.notifyNavigation(); this.render(); });
        }
        if (line.kind === 'gap' || line.kind === 'gap-status') this.gapRow(row, line);
        else if (line.kind === 'change') {
          const title = el('span', 'diff-hunk-text', nav('change', { active: (this.changeIndexes.get(line.changeId!) ?? 0) + 1, count: this.changeCount, range: line.left }));
          row.classList.add('diff-change-title'); row.setAttribute('role', 'heading'); row.setAttribute('aria-level', '3'); row.append(title);
        } else if (line.kind === 'hunk' || line.kind === 'meta') row.append(el('span', 'diff-hunk-text', line.left));
        else if (this.split) {
          const left = el('div', `diff-side ${line.sign?.[0] === '-' ? 'deletion' : ''}`, el('span', 'line-number', line.old ?? ''), el('span', 'line-sign', line.sign?.[0] ?? ''), el('span', 'line-text', line.left));
          const right = el('div', `diff-side ${line.sign?.[1] === '+' ? 'addition' : ''}`, el('span', 'line-number', line.next ?? ''), el('span', 'line-sign', line.sign?.[1] ?? ''), el('span', 'line-text', line.right ?? '')); row.append(left, right);
        } else row.append(el('span', 'line-number', line.old ?? ''), el('span', 'line-number', line.next ?? ''), el('span', 'line-sign', line.sign ?? ''), el('span', 'line-text', line.left));
        fragment.append(row);
      }
      this.rowObserver.disconnect(); this.mountedRows.clear(); disposeBindings(this.rows); this.rows.replaceChildren(fragment);
      if (this.layout && this.visible()) {
        const position = this.capturePosition(); let changed = false;
        for (const { row, index } of mounted) {
          this.mountedRows.set(row, index); this.rowObserver.observe(row);
          const height = row.getBoundingClientRect?.().height ?? 0;
          if (height > 0) changed = this.layout.measure(index, height) || changed;
        }
        if (changed) {
          this.pendingPosition = position; this.content.style.height = `${this.layout.height}px`; this.applyPendingPosition();
          if (revealing) { this.pendingReveal = revealing; this.revealActive(); }
          for (const { row, index } of mounted) row.style.top = `${this.rowOffset(index)}px`;
          this.schedule();
        }
      }
      if (this.visible() && !this.pendingPosition) this.lastVisiblePosition = this.capturePosition();
    } finally { span.end({ renderedCount }); }
  }
  destroy(): void {
    this.cancelPendingContent(); this.navigation?.keyboardRoot?.removeEventListener('keydown', this.navigationKeydown); this.navigation = null;
    this.models.clear(); this.observer.disconnect(); this.rowObserver.disconnect(); this.mountedRows.clear(); cancelAnimationFrame(this.frame); this.scheduledSpan?.end({ outcome: 'cancelled' }); this.scheduledSpan = undefined;
    disposeBindings(this.element); disposeBindings(this.toolbar);
  }
}

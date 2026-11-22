import type { AppSettings, DiffResult } from '../shared/protocol';
import { contentRows, PatchModelCache, type ContentSide, type DiffRows, type DiffViewLine } from '../lib/diff';
import { errorMessage } from '../lib/format';
import { performanceDiagnostics as perf, type PerformanceContext, type PerformanceOutcome, type PerformanceSpan } from '../lib/performance';
import { button, el, empty, loading, select } from './dom';

export interface DiffViewState { scrollTop: number; scrollLeft: number; mode: 'diff' | 'new' | 'old' }
export interface LoadedContent { content: string | null; binary: boolean; truncated: boolean }
export interface DiffContentAccess { ensureContent: (side: ContentSide) => Promise<LoadedContent>; cancelContent: () => void }
interface SideView { status: 'idle' | 'loading' | 'ready' | 'error' | 'cancelled'; data?: LoadedContent; rows?: DiffRows; error?: unknown }
const DIFF_LABEL = 'Read-only diff, scroll to read. Control A selects content; Control C copies without line numbers.';
export class DiffView {
  readonly element = el('section', 'diff-view');
  private toolbar = el('div', 'diff-toolbar');
  private viewport = el('div', 'diff-scroll');
  private content = el('div', 'diff-content');
  private rows = el('div', 'diff-rows');
  private mode: 'diff' | 'new' | 'old' = 'diff';
  private result: DiffResult | null = null;
  private settings: AppSettings | null = null;
  private lines: DiffViewLine[] = [];
  private models = new PatchModelCache();
  private patchRows: { result: DiffResult; unified?: DiffRows; split?: DiffRows } | null = null;
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
  private selectionRange = '';
  private performanceContext: PerformanceContext | undefined;
  private scheduledSpan: PerformanceSpan | undefined;

  constructor(private readonly changeView: (view: AppSettings['diffView']) => void, private readonly copy: (text: string) => void) {
    this.viewport.tabIndex = 0; this.viewport.setAttribute('role', 'region'); this.viewport.setAttribute('aria-label', DIFF_LABEL);
    this.content.append(this.rows); this.viewport.append(this.content); this.element.append(this.toolbar, this.viewport);
    this.viewport.addEventListener('scroll', () => this.schedule());
    this.observer = new ResizeObserver(() => this.schedule()); this.observer.observe(this.viewport);
    this.viewport.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault(); this.selectionRange = this.displayedContent();
        this.viewport.setAttribute('aria-label', 'All diff content selected. Press Control C to copy.'); this.viewport.classList.add('all-selected');
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && this.selectionRange) { event.preventDefault(); this.copy(this.selectionRange); }
      if (event.key === 'Escape' && this.selectionRange) { event.preventDefault(); event.stopPropagation(); this.clearSelection(); }
    });
    this.viewport.addEventListener('pointerdown', () => this.clearSelection());
    this.viewport.addEventListener('focusout', () => this.clearSelection());
    this.viewport.addEventListener('copy', this.copySelection);
  }
  private displayedContent(): string { return this.mode === 'diff' ? this.result?.patch ?? '' : this.sides[this.mode].data?.content ?? ''; }
  private clearSelection(): void { this.selectionRange = ''; this.viewport.classList.remove('all-selected'); this.viewport.setAttribute('aria-label', DIFF_LABEL); }
  private copySelection = (event: ClipboardEvent): void => {
    if (this.selectionRange) { event.preventDefault(); event.clipboardData?.setData('text/plain', this.selectionRange); return; }
    const selection = window.getSelection(); if (!selection?.rangeCount || !selection.toString()) return;
    const range = selection.getRangeAt(0);
    if (!this.viewport.contains(range.commonAncestorContainer)) return;
    const fragment = range.cloneContents();
    fragment.querySelectorAll('.line-number,.line-sign').forEach(node => node.remove());
    const rows = [...fragment.querySelectorAll<HTMLElement>('.diff-line')];
    const text = rows.length ? rows.map(row => {
      if (row.classList.contains('split-line')) return [...row.querySelectorAll<HTMLElement>('.line-text')].map(node => node.textContent ?? '').join('\t');
      return row.querySelector('.line-text,.diff-hunk-text')?.textContent ?? row.textContent ?? '';
    }).join('\n') : fragment.textContent ?? '';
    event.preventDefault(); event.clipboardData?.setData('text/plain', text);
  };
  getState(): DiffViewState { return { scrollTop: this.viewport.scrollTop, scrollLeft: this.viewport.scrollLeft, mode: this.mode }; }
  restore(state: Partial<DiffViewState>): void {
    if (state.mode && state.mode !== this.mode) { this.cancelPendingContent(); this.mode = state.mode; this.clearSelection(); this.build(); }
    this.viewport.scrollTop = Math.max(0, state.scrollTop ?? 0); this.viewport.scrollLeft = Math.max(0, state.scrollLeft ?? 0); this.schedule();
  }
  clear(): void {
    this.cancelPendingContent(); this.clearSelection(); this.result = null; this.patchRows = null; this.contentAccess = undefined;
    this.sides = { old: { status: 'idle' }, new: { status: 'idle' } }; this.lines = []; this.rows.replaceChildren(); this.content.style.height = '0px'; this.viewport.removeAttribute('aria-busy');
  }
  clearCache(): void { this.models.clear(); this.patchRows = null; }
  set(result: DiffResult, settings: AppSettings, reset = true, contentAccess?: DiffContentAccess): void {
    this.performanceContext = perf.context();
    if (this.result !== result || reset) {
      this.cancelPendingContent(); this.clearSelection(); this.contentAccess = contentAccess;
      this.sides = contentAccess ? { old: { status: 'idle' }, new: { status: 'idle' } } : {
        old: { status: 'ready', data: { content: result.oldContent, binary: result.binary, truncated: result.truncated } },
        new: { status: 'ready', data: { content: result.newContent, binary: result.binary, truncated: result.truncated } },
      };
    }
    if (this.patchRows?.result !== result) this.patchRows = { result };
    this.result = result; this.settings = settings;
    if (reset) { this.mode = 'diff'; this.viewport.scrollTop = 0; this.viewport.scrollLeft = 0; }
    this.build();
  }
  private cancelPendingContent(cancelled = false): void {
    this.contentVersion++;
    if (this.loadingSide) { this.contentAccess?.cancelContent(); this.sides[this.loadingSide].status = cancelled ? 'cancelled' : 'idle'; }
    this.loadingSide = null; this.loadingPromise = null;
  }
  private requestContent(side: ContentSide): void {
    if (!this.contentAccess || this.sides[side].status !== 'idle') return;
    const result = this.result, version = ++this.contentVersion, state = this.sides[side], access = this.contentAccess, parent = perf.context() ?? this.performanceContext;
    state.status = 'loading'; this.loadingSide = side;
    this.loadingPromise = Promise.resolve().then(() => {
      if (version !== this.contentVersion || result !== this.result) throw new Error('Content loading cancelled.');
      return perf.run(parent, () => access.ensureContent(side));
    }).then(data => {
      if (version !== this.contentVersion || result !== this.result) return;
      state.status = 'ready'; state.data = data;
    }, error => {
      if (version !== this.contentVersion || result !== this.result) return;
      state.status = 'error'; state.error = error;
    }).then(() => {
      if (version !== this.contentVersion || result !== this.result) return;
      this.loadingSide = null; this.loadingPromise = null; this.build();
    });
  }
  private async changeMode(mode: DiffViewState['mode']): Promise<void> {
    if (mode === this.mode) return;
    const operation = perf.operation('diffMode'); this.performanceContext = operation.context; let outcome: PerformanceOutcome = 'ok';
    try {
      operation.run(() => { this.cancelPendingContent(); this.mode = mode; this.clearSelection(); this.viewport.scrollTop = 0; this.viewport.scrollLeft = 0; this.build(); });
      const version = this.contentVersion; await this.loadingPromise;
      outcome = version !== this.contentVersion ? 'cancelled' : mode !== 'diff' && this.sides[mode].status === 'error' ? 'error' : 'ok';
    } finally { operation.end({ outcome }); }
  }
  private build(): void {
    if (!this.result || !this.settings) return;
    const span = perf.span('diff', 'model', undefined, perf.context() ?? this.performanceContext);
    try {
      const result = this.result, settings = this.settings;
      this.lineHeight = Math.max(18, Math.round(settings.fontSize * 1.55));
      this.element.style.setProperty('--diff-line-height', `${this.lineHeight}px`);
      const mode = select([{ value: 'diff', label: 'Changes' }, { value: 'new', label: 'New file · read only' }, { value: 'old', label: 'Old file · read only' }], this.mode, 'Content view', value => { void this.changeMode(value as DiffViewState['mode']); });
      this.info = el('span', 'muted');
      const unified = button('Unified diff', () => this.changeDiffView('unified'), 'unified', settings.diffView === 'unified' ? 'active' : '', true); unified.setAttribute('aria-pressed', String(settings.diffView === 'unified'));
      const split = button('Side-by-side diff', () => this.changeDiffView('split'), 'split', settings.diffView === 'split' ? 'active' : '', true); split.setAttribute('aria-pressed', String(settings.diffView === 'split'));
      const copy = button('Copy displayed content', () => this.copy(this.displayedContent()), 'copy', '', true);
      copy.disabled = this.mode !== 'diff' && (this.sides[this.mode].status !== 'ready' || this.sides[this.mode].data?.content === null);
      this.toolbar.replaceChildren(mode, el('div', 'button-group', unified, split), this.info, el('span', 'spacer'), copy);
      this.split = this.mode === 'diff' && settings.diffView === 'split'; this.viewport.classList.toggle('is-split', this.split); this.viewport.removeAttribute('aria-busy'); this.lines = [];
      if (result.binary && this.mode === 'diff') { this.placeholder(empty('Binary file', 'Use the configured external diff tool or open the working file in your editor.')); return; }
      let model: DiffRows;
      if (this.mode !== 'diff') {
        const side = this.mode, state = this.sides[side];
        if (state.status === 'idle') this.requestContent(side);
        if (state.status === 'loading') {
          this.viewport.setAttribute('aria-busy', 'true'); this.info.textContent = `Loading ${side} file…`;
          this.placeholder(loading(`Loading ${side} file…`, () => { this.cancelPendingContent(true); this.build(); })); return;
        }
        if (state.status === 'error' || state.status === 'cancelled') {
          this.info.textContent = state.status === 'cancelled' ? 'Content loading cancelled' : 'Content could not be loaded';
          this.placeholder(el('div', 'inline-error', state.status === 'error' ? errorMessage(state.error) : 'Content loading cancelled', button('Retry content', () => { state.status = 'idle'; this.build(); }, 'refresh'))); return;
        }
        if (!state.data || state.data.content === null) {
          this.placeholder(empty('Content unavailable', state.data?.binary || result.binary ? 'Binary file content is not decoded as text.' : 'This side does not exist, or its content exceeds the backend text limit.')); return;
        }
        model = state.rows ??= contentRows(state.data.content, side); this.info.textContent = 'Read only';
        if (state.data.truncated) this.info.textContent = 'Limited preview — use external diff for the full file';
      } else {
        const variant = this.split ? 'split' : 'unified';
        if (!this.patchRows) this.patchRows = { result };
        model = this.patchRows[variant] ??= this.models.prepare(result, this.split);
        if (!model.hunkCount) {
          if (result.truncated || model.limited) { this.info.textContent = 'Limited preview — use external diff for the full file'; this.placeholder(empty('Limited preview · content unavailable', 'The text preview limit was reached; an empty patch does not mean there are no changes. Use external diff to inspect the file.')); }
          else this.placeholder(empty(result.patch ? 'No text hunks' : 'No textual differences', result.patch || 'Choose “New file” or “Old file” to inspect the complete read-only content.'));
          return;
        }
      }
      this.lines = model.lines;
      if (result.truncated || model.limited) this.info.textContent = 'Limited preview — use external diff for the full file';
      if (!this.lines.length) { this.placeholder(empty('Empty file')); return; }
      this.content.style.height = `${this.lines.length * this.lineHeight}px`; this.render();
    } finally { span.end({ count: this.lines.length }); }
  }
  private placeholder(node: HTMLElement): void { this.content.style.height = '100%'; this.rows.replaceChildren(node); }
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
  private render(): void {
    const span = perf.span('diff', 'render', { count: this.lines.length }, perf.context() ?? this.performanceContext); let renderedCount = 0;
    try {
      const first = Math.max(0, Math.floor(this.viewport.scrollTop / this.lineHeight) - 8);
      const last = Math.min(this.lines.length, Math.ceil((this.viewport.scrollTop + this.viewport.clientHeight) / this.lineHeight) + 8); renderedCount = last - first;
      const fragment = document.createDocumentFragment();
      for (let index = first; index < last; index++) {
        const line = this.lines[index], row = el('div', `diff-line ${line.kind}`); row.style.top = `${index * this.lineHeight}px`;
        if (line.kind === 'hunk' || line.kind === 'meta') row.append(el('span', 'diff-hunk-text', line.left));
        else if (this.split) {
          const left = el('div', `diff-side ${line.sign?.[0] === '-' ? 'deletion' : ''}`, el('span', 'line-number', line.old ?? ''), el('span', 'line-sign', line.sign?.[0] ?? ''), el('span', 'line-text', line.left));
          const right = el('div', `diff-side ${line.sign?.[1] === '+' ? 'addition' : ''}`, el('span', 'line-number', line.next ?? ''), el('span', 'line-sign', line.sign?.[1] ?? ''), el('span', 'line-text', line.right ?? '')); row.append(left, right);
        } else row.append(el('span', 'line-number', line.old ?? ''), el('span', 'line-number', line.next ?? ''), el('span', 'line-sign', line.sign ?? ''), el('span', 'line-text', line.left));
        fragment.append(row);
      }
      this.rows.replaceChildren(fragment);
    } finally { span.end({ renderedCount }); }
  }
  destroy(): void { this.cancelPendingContent(); this.models.clear(); this.observer.disconnect(); cancelAnimationFrame(this.frame); this.scheduledSpan?.end({ outcome: 'cancelled' }); this.scheduledSpan = undefined; }
}

import type { AppSettings, Commit, GitRef, WorkingState } from '../shared/protocol';
import type { GraphRow } from '../lib/graph';
import { clamp, commitDate, dateText, fullDateText, numberText, shortOid } from '../lib/format';
import { m } from '../i18n/history';
import { performanceDiagnostics as perf, type PerformanceContext, type PerformanceSpan } from '../lib/performance';
import { button, disposeBindings, el, resizer, setAttribute, setText, type Localizable } from './dom';
import { icon } from './icons';
import { renderMessage } from './message';
import { RowLayout, type InlineSide } from './navigation';

export interface HistoryScrollAnchor { oid: string; offset: number; scrollLeft: number; detailOffset?: number; detailOid?: string }
export type TableSelectionIntent = 'toggle' | 'ensure-open';

export interface TableModel {
  commits: readonly Commit[]; graph: readonly GraphRow[]; working: WorkingState | null;
  settings: AppSettings; selected: string | null; compareBase: string | null;
  head: string | null; hasMore: boolean; loading: boolean; totalLoaded: number;
  inline?: { oid: string; element: HTMLElement; height: number; side?: InlineSide };
  pauseAutoLoad?: boolean;
}
export interface TableCallbacks {
  select: (oid: string, compare: boolean, intent?: TableSelectionIntent) => void;
  context: (oid: string, x: number, y: number, element: HTMLElement) => void;
  refContext: (ref: GitRef, x: number, y: number, element: HTMLElement) => void;
  loadMore: () => void; loadMoreExplicit?: () => void;
  widths: (widths: AppSettings['columnWidths']) => void; copy: (oid: string) => void;
  branchNavigate?: (oid: string, direction: 'parent' | 'child', alternate: boolean) => void;
  hover?: (oid: string | null, anchor?: HTMLElement) => void;
  openUrl?: (url: string) => void; scrolled?: (user: boolean) => void;
}
const avatarHashes = new Map<string, Promise<string>>();
function avatar(email: string): HTMLImageElement {
  const image = el('img', 'avatar'); image.alt = ''; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
  const key = email.trim().toLowerCase(); let promise = avatarHashes.get(key);
  if (!promise) {
    promise = crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then(buffer => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join(''));
    if (avatarHashes.size > 1000) avatarHashes.clear(); avatarHashes.set(key, promise);
  }
  void promise.then(hash => { if (image.isConnected) image.src = `https://www.gravatar.com/avatar/${hash}?s=32&d=identicon`; }).catch(() => undefined);
  return image;
}
export function visibleRefs(refs: readonly GitRef[], settings: AppSettings): GitRef[] {
  return refs.filter(ref => !(ref.kind === 'remote' && (!settings.showRemotes || (!settings.showRemoteHeads && /\/HEAD$/.test(ref.name)))) && !(ref.kind === 'tag' && !settings.showTags) && !(ref.kind === 'stash' && !settings.showStashes));
}
export function combinedRefs(refs: readonly GitRef[], combine: boolean): GitRef[][] {
  const groups: GitRef[][] = []; const used = new Set<string>();
  for (const ref of refs) {
    if (used.has(ref.fullName)) continue;
    const group = [ref]; used.add(ref.fullName);
    if (combine && ref.kind === 'branch' && ref.upstream) {
      const remote = refs.find(item => item.kind === 'remote' && item.oid === ref.oid && (item.name === ref.upstream || item.fullName === ref.upstream));
      if (remote && !used.has(remote.fullName)) { group.push(remote); used.add(remote.fullName); }
    }
    groups.push(group);
  }
  return groups;
}

interface RenderedRow {
  element: HTMLElement; commit: Commit | null; styleRevision: number; workingKey: string; head: boolean;
}
const rowStyleKey = (settings: AppSettings): string => JSON.stringify([
  settings.columns, settings.dateFormat, settings.dateSource, settings.avatars, settings.labelAlignment,
  settings.combineLabels, settings.showRemotes, settings.showRemoteHeads, settings.showTags, settings.showStashes,
  settings.muteMerges, settings.muteNonAncestors, settings.markdown, settings.emoji, settings.customEmoji,
  settings.issueUrl, settings.issueRules,
]);
const widthKey = (settings: AppSettings): string => JSON.stringify([settings.columnWidths, settings.columns, settings.rowHeight]);
const graphStyleKey = (settings: AppSettings): string => JSON.stringify([
  settings.columnWidths.graph, settings.graphStyle, settings.graphColors, settings.uncommittedStyle,
  settings.muteMerges, settings.muteNonAncestors, settings.theme,
]);

export class CommitTable {
  readonly element = el('section', 'history-pane');
  readonly viewport = el('div', 'table-scroll');
  private header = el('div', 'table-header');
  private content = el('div', 'table-content');
  private canvas = el('canvas', 'graph-canvas');
  private rowLayer = el('div', 'commit-rows');
  private inlineSlot = el('div', 'inline-detail-slot');
  private inlineCell = el('div', 'inline-detail-cell');
  private footer = el('div', 'table-footer');
  private loadButton: HTMLButtonElement;
  private model: TableModel | null = null;
  private frame = 0;
  private observer: ResizeObserver;
  private renderedKey = '';
  private version = 0;
  private geometryRevision = 0;
  private styleRevision = 0;
  private rows = new Map<string, RenderedRow>();
  private indices = new Map<string, number>();
  private styleKey = '';
  private widthsKey = '';
  private graphKey = '';
  private drawnKey = '';
  private graphRevision = 0;
  private programmaticScroll: { top: number; left: number } | undefined;
  private loadRequested = false;
  private layout = new RowLayout(0, 28);
  private performanceContext: PerformanceContext | undefined;
  private scheduledSpans: PerformanceSpan[] = [];

  constructor(private readonly callbacks: TableCallbacks) {
    this.element.tabIndex = 0; this.element.setAttribute('role', 'grid'); setAttribute(this.element, 'aria-label', m('table.history'));
    this.element.setAttribute('aria-multiselectable', 'true'); this.viewport.setAttribute('role', 'rowgroup'); this.rowLayer.setAttribute('role', 'presentation');
    this.viewport.style.overflowAnchor = 'none';
    this.canvas.setAttribute('aria-hidden', 'true'); this.inlineSlot.hidden = true; this.inlineSlot.setAttribute('role', 'row'); this.inlineCell.setAttribute('role', 'gridcell'); this.inlineCell.setAttribute('aria-colindex', '1'); this.inlineSlot.append(this.inlineCell);
    this.content.append(this.rowLayer, this.canvas, this.inlineSlot); this.viewport.append(this.content);
    this.loadButton = button(m('table.loadMore'), () => (callbacks.loadMoreExplicit ?? callbacks.loadMore)(), 'arrowDown'); this.loadButton.dataset.action = 'load-more';
    this.footer.append(el('span', 'history-count'), this.loadButton); this.footer.setAttribute('role', 'presentation');
    this.element.append(this.header, this.viewport, this.footer);
    this.viewport.addEventListener('scroll', () => {
      const expected = this.programmaticScroll;
      const user = !expected || Math.abs(expected.top - this.viewport.scrollTop) > 1 || Math.abs(expected.left - this.viewport.scrollLeft) > 1;
      this.programmaticScroll = undefined;
      this.updateInlineSlotGeometry(); this.schedule(); this.callbacks.scrolled?.(user); this.callbacks.hover?.(null);
    });
    this.element.addEventListener('keydown', event => this.keydown(event));
    this.observer = new ResizeObserver(() => { this.updateInlineSlotGeometry(); this.schedule(); }); this.observer.observe(this.viewport);
  }
  get scrollTop(): number { return this.viewport.scrollTop; }
  set scrollTop(value: number) { this.setScrollTop(value); this.schedule(); }
  get scrollLeft(): number { return this.viewport.scrollLeft; }
  set scrollLeft(value: number) {
    this.viewport.scrollLeft = Math.max(0, value); this.programmaticScroll = { top: this.viewport.scrollTop, left: this.viewport.scrollLeft }; this.updateInlineSlotGeometry(); this.schedule();
  }
  captureAnchor(oid?: string): HistoryScrollAnchor | null {
    const model = this.model; if (!model || !this.layout.count) return null;
    const top = this.viewport.scrollTop, index = oid ? this.rowIndex(oid) : this.layout.indexAt(top); if (index < 0) return null;
    const rowOid = model.working && index === 0 ? 'WORKTREE' : model.commits[index - Number(Boolean(model.working))]?.oid; if (!rowOid) return null;
    const insideDetail = !oid && this.layout.slotIndex >= 0 && top >= this.layout.slotTop && top < this.layout.slotTop + this.layout.slotHeight;
    return { oid: rowOid, offset: insideDetail ? 0 : top - this.layout.top(index), scrollLeft: this.viewport.scrollLeft, ...(insideDetail ? { detailOffset: top - this.layout.slotTop, detailOid: model.inline?.oid } : {}) };
  }
  restoreAnchor(anchor: HistoryScrollAnchor | null): void {
    if (!anchor) return;
    const index = this.rowIndex(anchor.oid); if (index < 0) return;
    const inSameDetail = anchor.detailOffset !== undefined && index === this.layout.slotIndex && (!anchor.detailOid || anchor.detailOid === this.model?.inline?.oid);
    this.viewport.scrollLeft = Math.max(0, anchor.scrollLeft);
    this.setScrollTop(inSameDetail ? this.layout.slotTop + Math.min(anchor.detailOffset!, Math.max(0, this.layout.slotHeight - 1)) : this.layout.top(index) + anchor.offset);
    this.updateInlineSlotGeometry(); this.schedule();
  }
  /** Decide from pure-list position, with the existing insertion removed before measuring the viewport. */
  chooseInlineSide(oid: string): InlineSide {
    const model = this.model, index = this.rowIndex(oid); if (!model || index < 0) return 'after';
    const plainTop = this.layout.plainScrollTop(this.viewport.scrollTop, this.viewport.clientHeight);
    return index * model.settings.rowHeight - plainTop + model.settings.rowHeight / 2 < this.viewport.clientHeight / 2 ? 'after' : 'before';
  }
  private setScrollTop(value: number): void {
    this.viewport.scrollTop = Math.max(0, value);
    this.programmaticScroll = { top: this.viewport.scrollTop, left: this.viewport.scrollLeft };
  }
  setModel(model: TableModel, resetScroll = false): void {
    this.performanceContext = perf.context();
    const span = perf.span('table', 'set-model', { count: model.commits.length });
    try {
    const old = this.model;
    const inlineChanged = old?.inline?.oid !== model.inline?.oid || old?.inline?.side !== model.inline?.side;
    const rowToAnchor = inlineChanged ? model.inline?.oid ?? old?.inline?.oid : undefined;
    const rowIndexToAnchor = rowToAnchor ? this.rowIndex(rowToAnchor) : -1;
    const rowTop = rowIndexToAnchor >= 0 ? this.layout.top(rowIndexToAnchor) : -1;
    const rowVisible = rowIndexToAnchor >= 0 && rowTop + (old?.settings.rowHeight ?? 0) > this.viewport.scrollTop && rowTop < this.viewport.scrollTop + this.viewport.clientHeight;
    const anchor = resetScroll ? null : this.captureAnchor(rowVisible ? rowToAnchor : undefined);
    this.model = model;
    const dataChanged = !old || old.commits !== model.commits || Boolean(old.working) !== Boolean(model.working);
    if (dataChanged) {
      this.version++; this.indices.clear();
      model.commits.forEach((commit, index) => this.indices.set(commit.oid, index));
    }
    const style = rowStyleKey(model.settings), widths = widthKey(model.settings), graph = graphStyleKey(model.settings);
    if (style !== this.styleKey) { this.styleKey = style; this.styleRevision++; this.version++; }
    if (graph !== this.graphKey || old?.graph !== model.graph || old?.head !== model.head) {
      this.graphKey = graph; this.graphRevision++;
    }
    if (resetScroll) this.setScrollTop(0);
    if (widths !== this.widthsKey) { this.widthsKey = widths; this.applyWidths(); }
    if (!old || JSON.stringify(old.settings.columns) !== JSON.stringify(model.settings.columns)) this.renderHeader();
    const count = model.commits.length + (model.working ? 1 : 0);
    const inlineIndex = model.inline ? this.rowIndex(model.inline.oid) : -1;
    const geometryChanged = !old || count !== this.layout.count || model.settings.rowHeight !== this.layout.rowHeight
      || inlineIndex !== this.layout.slotIndex || (model.inline?.height ?? 0) !== this.layout.slotHeight || (model.inline?.side ?? 'after') !== this.layout.side;
    if (geometryChanged) {
      this.geometryRevision++; this.layout = new RowLayout(count, model.settings.rowHeight, inlineIndex, model.inline?.height ?? 0, model.inline?.side ?? 'after');
      this.content.style.height = `${this.layout.totalHeight}px`;
      if (anchor) this.restoreAnchor(anchor);
    }
    if (dataChanged || old?.hasMore !== model.hasMore || old?.loading !== model.loading || old?.pauseAutoLoad !== model.pauseAutoLoad) this.loadRequested = false;
    if (old?.head !== model.head || old?.working !== model.working) this.version++;
    const columnCount = 2 + Number(model.settings.columns.date) + Number(model.settings.columns.author) + Number(model.settings.columns.commit);
    this.element.setAttribute('aria-rowcount', String(count + 1 + Number(inlineIndex >= 0)));
    this.element.setAttribute('aria-colcount', String(columnCount)); this.inlineCell.setAttribute('aria-colspan', String(columnCount));
    this.element.setAttribute('aria-busy', String(model.loading));
    this.inlineSlot.hidden = inlineIndex < 0;
    if (model.inline && inlineIndex >= 0) {
      this.inlineSlot.style.top = `${this.layout.slotTop}px`; this.inlineSlot.style.height = `${model.inline.height}px`;
      if (this.inlineCell.firstElementChild !== model.inline.element) this.inlineCell.replaceChildren(model.inline.element);
      this.inlineSlot.setAttribute('aria-rowindex', String(this.layout.slotBoundary + 2)); this.inlineSlot.dataset.side = model.inline.side ?? 'after'; setAttribute(this.inlineSlot, 'aria-label', m('table.inlineDetails'));
    } else { this.inlineSlot.removeAttribute('aria-rowindex'); if (this.inlineCell.childElementCount) this.inlineCell.replaceChildren(); }
    this.updateInlineSlotGeometry();
    this.updateSelection(old);
    this.updateFooter();
    this.loadButton.hidden = !model.hasMore; this.loadButton.disabled = model.loading;
    this.schedule();
    } finally { span.end(); }
  }
  /** The insertion shares row Y geometry, but its X/width belong to the visible viewport, not the wide columns. */
  private updateInlineSlotGeometry(): void {
    if (this.inlineSlot.hidden) return;
    // clientWidth already excludes borders and the vertical scrollbar; subtract the slot's own border via border-box.
    this.inlineSlot.style.left = `${this.viewport.scrollLeft}px`;
    this.inlineSlot.style.right = 'auto';
    this.inlineSlot.style.width = `${this.viewport.clientWidth}px`;
    this.inlineSlot.style.boxSizing = 'border-box';
  }
  /** Rebind presentation only: never schedule history rendering, graph drawing, or auto-loading. */
  updateLocale(): void { if (this.model) this.updateFooter(); }
  private updateFooter(): void {
    const model = this.model!;
    let count = m('table.shown', { count: numberText(model.commits.length) });
    if (model.totalLoaded !== model.commits.length) count = m('table.loaded', { shown: count, count: numberText(model.totalLoaded) });
    if (model.hasMore) count = m('table.moreAvailable', { count });
    setText(this.footer.firstElementChild!, count);
    const label = model.loading ? m('table.loading') : m('table.loadMore');
    setText(this.loadButton.querySelector('span')!, label); setAttribute(this.loadButton, 'title', label);
  }
  private applyWidths(): void {
    const settings = this.model!.settings, widths = settings.columnWidths;
    this.element.style.setProperty('--commit-columns', `${widths.graph}px minmax(220px, 1fr)${settings.columns.date ? ` ${widths.date}px` : ''}${settings.columns.author ? ` ${widths.author}px` : ''}${settings.columns.commit ? ` ${widths.commit}px` : ''}`);
    this.element.style.setProperty('--row-height', `${settings.rowHeight}px`);
    this.content.style.minWidth = `${widths.graph + 220 + (settings.columns.date ? widths.date : 0) + (settings.columns.author ? widths.author : 0) + (settings.columns.commit ? widths.commit : 0)}px`;
    this.header.style.minWidth = this.content.style.minWidth;
  }
  private rowIndex(oid: string): number {
    if (!this.model) return -1;
    if (oid === 'WORKTREE') return this.model.working ? 0 : -1;
    const index = this.indices.get(oid);
    return index === undefined ? -1 : index + (this.model.working ? 1 : 0);
  }
  focus(oid?: string, center = false): void { if (oid) this.reveal(oid, center); this.element.focus({ preventScroll: true }); }
  reveal(oid: string, center = false): void {
    if (!this.model) return;
    const index = this.rowIndex(oid); if (index < 0) return;
    const top = this.layout.top(index), height = this.model.settings.rowHeight;
    if (center) this.setScrollTop(top - (this.viewport.clientHeight - height) / 2);
    else if (top < this.viewport.scrollTop) this.setScrollTop(top);
    else if (top + height > this.viewport.scrollTop + this.viewport.clientHeight) this.setScrollTop(top + height - this.viewport.clientHeight);
    this.schedule();
  }
  private renderHeader(): void {
    const model = this.model!; this.header.replaceChildren(); this.header.setAttribute('role', 'row'); this.header.setAttribute('aria-rowindex', '1');
    let col = 0;
    const cell = (label: Localizable, key?: keyof AppSettings['columnWidths'], resizeLabel?: Localizable): HTMLElement => {
      const node = el('div', 'header-cell', label); node.setAttribute('role', 'columnheader'); node.setAttribute('aria-colindex', String(++col));
      if (key) node.append(resizer('vertical', () => this.model!.settings.columnWidths[key], (value, final) => {
        const next = { ...this.model!.settings.columnWidths, [key]: clamp(value, 60, key === 'graph' ? 640 : 400) };
        this.model!.settings = { ...this.model!.settings, columnWidths: next }; this.applyWidths(); this.graphRevision++; this.schedule();
        if (final) this.callbacks.widths(next);
      }, 60, () => key === 'graph' ? 640 : 400, false, resizeLabel));
      return node;
    };
    this.header.append(cell(m('table.graph'), 'graph', m('table.resizeGraph')), cell(m('table.description')));
    if (model.settings.columns.date) this.header.append(cell(m('table.date'), 'date', m('table.resizeDate')));
    if (model.settings.columns.author) this.header.append(cell(m('table.author'), 'author', m('table.resizeAuthor')));
    if (model.settings.columns.commit) this.header.append(cell(m('table.commit'), 'commit', m('table.resizeCommit')));
  }
  private updateSelection(old: TableModel | null): void {
    const model = this.model!;
    for (const oid of new Set([old?.selected, old?.compareBase, model.selected, model.compareBase])) {
      if (!oid) continue;
      const row = this.rows.get(oid)?.element; if (!row) continue;
      row.classList.toggle('selected', oid === model.selected); row.classList.toggle('compare-base', oid === model.compareBase);
      row.setAttribute('aria-selected', String(oid === model.selected || oid === model.compareBase));
    }
    this.updateActiveDescendant();
  }
  private updateActiveDescendant(): void {
    const active = this.model?.selected ? this.rows.get(this.model.selected)?.element : undefined;
    if (active && this.rowLayer.contains(active)) this.element.setAttribute('aria-activedescendant', active.id);
    else this.element.removeAttribute('aria-activedescendant');
  }
  private schedule(): void {
    if (perf.isEnabled && this.scheduledSpans.length < 2000) this.scheduledSpans.push(perf.span('table', 'scheduled-render', undefined, perf.context() ?? this.performanceContext));
    if (!this.frame) this.frame = requestAnimationFrame(() => {
      this.frame = 0; const spans = this.scheduledSpans; this.scheduledSpans = [];
      try { perf.run(this.performanceContext, () => this.render()); } finally { for (const span of spans) span.end(); }
    });
  }
  private render(): void {
    const model = this.model; if (!model) return;
    const span = perf.span('table', 'render', { count: model.commits.length });
    let renderedCount = 0;
    try {
    this.updateInlineSlotGeometry();
    const rowHeight = model.settings.rowHeight, offset = model.working ? 1 : 0, top = this.viewport.scrollTop;
    const { first, last } = this.layout.visibleRange(top, this.viewport.clientHeight);
    const key = `${this.version}:${this.geometryRevision}:${first}:${last}`;
    renderedCount = last - first;
    if (key !== this.renderedKey) {
      this.renderedKey = key;
      const focusedRef = document.activeElement instanceof HTMLElement && this.rowLayer.contains(document.activeElement) ? document.activeElement.dataset.ref : undefined;
      const wanted = new Set<string>();
      let cursor = this.rowLayer.firstElementChild;
      const workingKey = model.working ? `${model.working.files.length}:${model.working.operation}:${model.working.conflicts}` : '';
      for (let index = first; index < last; index++) {
        const commit = index >= offset ? model.commits[index - offset] : null, oid = commit?.oid ?? 'WORKTREE';
        wanted.add(oid);
        const cached = this.rows.get(oid);
        if (cached && cached.commit === commit && cached.styleRevision === this.styleRevision
          && cached.head === (oid === model.head) && (commit !== null || cached.workingKey === workingKey)) {
          const row = cached.element;
          row.style.top = `${this.layout.top(index)}px`;
          row.setAttribute('aria-rowindex', String(index + 2 + Number(this.layout.slotBoundary >= 0 && index >= this.layout.slotBoundary)));
          row.classList.toggle('selected', oid === model.selected); row.classList.toggle('compare-base', oid === model.compareBase);
          row.setAttribute('aria-selected', String(oid === model.selected || oid === model.compareBase));
          if (row === cursor) cursor = cursor.nextElementSibling;
          else this.rowLayer.insertBefore(row, cursor);
          continue;
        }
        const row = el('div', `commit-row${oid === model.selected ? ' selected' : ''}${oid === model.compareBase ? ' compare-base' : ''}${!commit ? ' working-row' : ''}${commit && model.settings.muteMerges && commit.parents.length > 1 ? ' muted-merge' : ''}${commit?.inHead === false && model.settings.muteNonAncestors ? ' non-ancestor' : ''}`);
        row.style.top = `${this.layout.top(index)}px`; row.id = `commit-${oid}`; row.dataset.oid = oid;
        row.setAttribute('role', 'row'); row.setAttribute('aria-rowindex', String(index + 2 + Number(this.layout.slotBoundary >= 0 && index >= this.layout.slotBoundary))); row.setAttribute('aria-selected', String(oid === model.selected || oid === model.compareBase));
        const graphCell = el('div', 'graph-cell'); graphCell.setAttribute('role', 'gridcell'); setAttribute(graphCell, 'aria-label', commit ? commit.nodeKind === 'stash' ? m('table.stash') : commit.parents.length > 1 ? m('table.mergeCommit') : m('table.commit') : m('table.uncommittedChanges'));
        const description = el('div', `commit-description labels-${model.settings.labelAlignment}`); description.setAttribute('role', 'gridcell');
        if (commit) {
          const refs = el('span', 'ref-badges');
          for (const group of combinedRefs(visibleRefs(commit.refs, model.settings), model.settings.combineLabels)) {
            const chipGroup = el('span', group.length > 1 ? 'combined-ref' : 'single-ref');
            for (const ref of group) {
              const chip = button(ref.name, () => { const rect = chip.getBoundingClientRect(); this.callbacks.refContext(ref, rect.left, rect.bottom, chip); }, undefined, `badge ref-${ref.kind}${ref.current ? ' current' : ''}`);
              chip.title = `${ref.fullName}${ref.upstream ? ` → ${ref.upstream}` : ''}`; chip.tabIndex = -1; chip.dataset.ref = ref.fullName; chip.setAttribute('aria-haspopup', 'menu');
              chip.addEventListener('click', event => event.stopPropagation());
              chip.addEventListener('dblclick', event => event.stopPropagation());
              chip.addEventListener('contextmenu', event => { event.preventDefault(); event.stopPropagation(); this.callbacks.refContext(ref, event.clientX, event.clientY, chip); });
              chip.addEventListener('keydown', event => {
                if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey || event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); const rect = chip.getBoundingClientRect(); this.callbacks.refContext(ref, rect.left, rect.bottom, chip); }
                else if (event.key === 'Escape' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); this.focus(); }
              });
              chipGroup.append(chip);
            }
            refs.append(chipGroup);
          }
          const message = commit.subject ? renderMessage(commit.subject, model.settings, url => this.callbacks.openUrl?.(url), true) : el('span', 'linked-message message-content message-inline', m('table.noSubject')); message.classList.add('commit-subject');
          description.append(refs, message); description.title = commit.subject;
          if (commit.oid === model.head) description.append(el('span', 'badge head-badge', 'HEAD'));
          row.addEventListener('pointerenter', () => this.callbacks.hover?.(oid, row)); row.addEventListener('pointerleave', () => this.callbacks.hover?.(null));
        } else {
          description.append(icon('editor'), el('strong', '', m('table.workingTree')), el('span', 'muted', m('table.changedFiles', { count: numberText(model.working!.files.length) })));
          if (model.working!.operation) description.append(el('span', 'badge operation-badge', m(`operation.${model.working!.operation}`)));
          if (model.working!.conflicts) description.append(el('span', 'badge conflict-badge', m('table.conflicts', { count: numberText(model.working!.conflicts) })));
        }
        row.append(graphCell, description);
        if (model.settings.columns.date) { const value = commit ? commitDate(commit, model.settings.dateSource) : 0; const date = el('div', 'commit-cell date-cell', commit ? dateText(value, model.settings.dateFormat) : m('table.uncommitted')); setAttribute(date, 'title', commit ? fullDateText(value) : ''); date.setAttribute('role', 'gridcell'); row.append(date); }
        if (model.settings.columns.author) { const author = el('div', 'commit-cell author-cell', commit && model.settings.avatars ? avatar(commit.email) : null, commit?.author ?? ''); author.title = commit ? `${commit.author} <${commit.email}>` : ''; author.setAttribute('role', 'gridcell'); row.append(author); }
        if (model.settings.columns.commit) { const hash = el('div', 'commit-cell mono hash-cell', commit ? shortOid(commit.oid) : ''); hash.title = commit?.oid ?? ''; hash.setAttribute('role', 'gridcell'); row.append(hash); }
        row.addEventListener('click', event => { if ((event.target as Element).closest('a,button')) return; this.callbacks.select(oid, event.shiftKey || event.ctrlKey || event.metaKey, 'toggle'); this.focus(); });
        row.addEventListener('contextmenu', event => { event.preventDefault(); this.callbacks.context(oid, event.clientX, event.clientY, this.element); });
        this.rows.set(oid, { element: row, commit, styleRevision: this.styleRevision, workingKey, head: oid === model.head });
        if (cached) {
          if (cached.element === cursor) cursor = cursor.nextElementSibling;
          cached.element.remove();
        }
        this.rowLayer.insertBefore(row, cursor);
      }
      for (const [oid, row] of this.rows) if (!wanted.has(oid)) { row.element.remove(); this.rows.delete(oid); }
      if (focusedRef && !(document.activeElement instanceof HTMLElement && this.rowLayer.contains(document.activeElement))) {
        [...this.rowLayer.querySelectorAll<HTMLElement>('[data-ref]')].find(item => item.dataset.ref === focusedRef)?.focus({ preventScroll: true });
      }
    }
    this.updateActiveDescendant();
    const drawKey = `${this.graphRevision}:${this.geometryRevision}:${first}:${last}:${top}:${this.viewport.clientHeight}:${window.devicePixelRatio}`;
    if (drawKey !== this.drawnKey) { this.drawnKey = drawKey; this.drawGraph(first, last, top); }
    this.header.style.transform = `translateX(${-this.viewport.scrollLeft}px)`;
    if (model.settings.autoLoad && !model.pauseAutoLoad && model.hasMore && !model.loading && !this.loadRequested && this.layout.totalHeight - top - this.viewport.clientHeight < rowHeight * 12) { this.loadRequested = true; this.callbacks.loadMore(); }
    } finally { span.end({ renderedCount }); }
  }
  private drawGraph(first: number, last: number, scrollTop: number): void {
    const span = perf.span('graph', 'draw', { renderedCount: last - first });
    try {
    const model = this.model!, width = model.settings.columnWidths.graph, height = this.viewport.clientHeight, ratio = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.ceil(width * ratio) || this.canvas.height !== Math.ceil(height * ratio)) { this.canvas.width = Math.ceil(width * ratio); this.canvas.height = Math.ceil(height * ratio); }
    this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`; this.canvas.style.top = `${scrollTop}px`;
    const context = this.canvas.getContext('2d'); if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    const rh = model.settings.rowHeight, highContrast = matchMedia('(forced-colors: active)').matches;
    const colors = model.settings.graphColors.length ? model.settings.graphColors : ['#80b8e5'];
    const color = (index: number): string => highContrast ? 'CanvasText' : colors[index % colors.length];
    const x = (lane: number): number => 19 + lane * 17;
    const surface = getComputedStyle(this.element).getPropertyValue('--surface').trim() || '#202226'; context.lineWidth = 1.7;
    for (let index = first; index < last; index++) {
      const graph = model.graph[index]; if (!graph) continue;
      const top = this.layout.top(index) - scrollTop;
      context.globalAlpha = model.settings.muteNonAncestors && graph.inHead === false ? 0.35 : model.settings.muteMerges && graph.merge ? 0.65 : 1;
      context.setLineDash(graph.nodeKind === 'working' ? [3, 3] : []);
      this.canvas.style.pointerEvents = 'none';
      const previousEdgeY = index > 0 ? this.layout.top(index - 1) + rh - scrollTop : top;
      for (const edge of graph.edges) {
        context.strokeStyle = color(edge.color); context.beginPath();
        const fromX = x(edge.from), toX = x(edge.to), fromY = edge.start === 0 ? previousEdgeY : top + edge.start * rh, toY = top + edge.end * rh;
        context.moveTo(fromX, fromY);
        if (fromX === toX) context.lineTo(toX, toY);
        else if (model.settings.graphStyle === 'angular') { context.lineTo(fromX, fromY + (toY - fromY) * 0.25); context.lineTo(toX, toY - (toY - fromY) * 0.25); context.lineTo(toX, toY); }
        else { const middle = (fromY + toY) / 2; context.bezierCurveTo(fromX, middle, toX, middle, toX, toY); }
        context.stroke();
      }
      context.setLineDash([]); context.beginPath();
      const nodeX = x(graph.lane), nodeY = top + rh / 2;
      if (graph.nodeKind === 'stash') { context.moveTo(nodeX, nodeY - 5); context.lineTo(nodeX + 5, nodeY); context.lineTo(nodeX, nodeY + 5); context.lineTo(nodeX - 5, nodeY); context.closePath(); }
      else context.arc(nodeX, nodeY, graph.merge ? 4.6 : graph.nodeKind === 'working' ? 4.2 : 3.7, 0, Math.PI * 2);
      context.fillStyle = graph.merge || graph.nodeKind === 'working' && model.settings.uncommittedStyle === 'open' ? surface : color(graph.color); context.fill(); context.strokeStyle = color(graph.color); context.stroke();
      if (graph.oid === model.head) { context.beginPath(); context.arc(nodeX, nodeY, 6.4, 0, Math.PI * 2); context.lineWidth = 1; context.stroke(); context.lineWidth = 1.7; }
    }
    context.globalAlpha = 1;
    } finally { span.end(); }
  }
  private keydown(event: KeyboardEvent): void {
    const model = this.model; if (!model || (event.target as HTMLElement).closest('button,input,select,textarea,a,[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="tree"],[role="listbox"],[role="separator"],.file-list,.diff-view')) return;
    const withinDetails = Boolean((event.target as HTMLElement).closest('.inline-detail-slot'));
    if (withinDetails && !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) return;
    const count = model.commits.length + Number(Boolean(model.working)); if (!count) return;
    let index = model.selected ? this.rowIndex(model.selected) : -1, target = index < 0 ? 0 : index;
    const oidAt = (at: number): string => model.working && at === 0 ? 'WORKTREE' : model.commits[at - Number(Boolean(model.working))].oid;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === 'ArrowUp' || event.key === 'ArrowDown') && model.selected && model.selected !== 'WORKTREE') { event.preventDefault(); event.stopPropagation(); this.callbacks.branchNavigate?.(model.selected, event.key === 'ArrowDown' ? 'parent' : 'child', event.shiftKey); return; }
    const page = Math.max(1, Math.floor(this.viewport.clientHeight / model.settings.rowHeight));
    switch (event.key) {
      case 'ArrowDown': target = index < 0 ? 0 : Math.min(count - 1, index + 1); break;
      case 'ArrowUp': target = Math.max(0, index - 1); break;
      case 'PageDown': target = Math.min(count - 1, Math.max(0, index) + page); break;
      case 'PageUp': target = Math.max(0, index - page); break;
      case 'Home': target = 0; break;
      case 'End': target = count - 1; break;
      case 'ArrowRight': case 'F2': { event.preventDefault(); if (model.selected) document.getElementById(`commit-${model.selected}`)?.querySelector<HTMLElement>('[data-ref]')?.focus(); return; }
      case 'Enter': case ' ': this.callbacks.select(oidAt(target), event.key === ' ' || event.shiftKey || mod, 'ensure-open'); event.preventDefault(); event.stopPropagation(); return;
      case 'c': if (mod && model.selected && model.selected !== 'WORKTREE') { event.preventDefault(); this.callbacks.copy(model.selected); } return;
      case 'ContextMenu': case 'F10': {
        if (event.key === 'F10' && !event.shiftKey) return;
        event.preventDefault(); const rect = this.viewport.getBoundingClientRect(); this.callbacks.context(oidAt(target), rect.left + model.settings.columnWidths.graph + 16, rect.top + this.layout.top(target) - this.viewport.scrollTop + model.settings.rowHeight, this.element); return;
      }
      default: return;
    }
    event.preventDefault(); event.stopPropagation(); index = target; this.callbacks.select(oidAt(index), event.shiftKey, 'ensure-open'); this.reveal(oidAt(index));
  }
  destroy(): void { this.observer.disconnect(); cancelAnimationFrame(this.frame); disposeBindings(this.element); this.rows.clear(); this.indices.clear(); for (const span of this.scheduledSpans) span.end({ outcome: 'cancelled' }); this.scheduledSpans = []; }
}

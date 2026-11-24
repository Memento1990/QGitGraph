import type { RepositoryCandidate, RepositoryDiscovery, RepositorySummary } from '../shared/protocol';
import { MAX_VISIBLE_REPOSITORY_SUMMARIES, type RepositorySummaryMap, type RepositorySummaryState } from '../lib/repository-summaries';
import {
  buildRepositoryTree, clampRepositoryDepth, repositoryScopeName, repositoryTreeFocusKey, repositoryTreeKeyAction, visibleRepositoryRows,
  type RepositoryTreeData, type RepositoryTreeNode, type RepositoryTreeRow,
} from '../lib/repositories';
import { localized, resolveText, type Localizable, type LocalizedMessage } from '../lib/i18n';
import { numberText } from '../lib/format';
import { m } from '../i18n/repositories';
import { m as actionMessage } from '../i18n/repository-actions';
import { button, disposeBindings, el, menuAtButton, select, setAttribute, setText } from './dom';
import { icon, type IconName } from './icons';
import './repository-tree.css';

export interface RepositoryTreeModel {
  root: string;
  /** Optional native/display name; otherwise a display-only basename is used. */
  rootName?: string;
  depth: number;
  discovery: RepositoryDiscovery | null;
  loading: boolean;
  cancelled?: boolean;
  error?: string | null;
  activePath: string | null;
  openingPath: string | null;
  /** Encoded relative component keys, never filesystem paths. The root key is ''. */
  collapsedPaths: readonly string[];
  /** Read-only observations keyed by the exact native candidate path, never an activation side effect. */
  summaries?: RepositorySummaryMap;
}

export type RepositoryRowActionKind = 'branch' | 'sync' | 'commit' | 'refresh' | 'more';

export interface RepositoryTreeCallbacks {
  onActivate(candidate: RepositoryCandidate): void;
  onToggle(key: string, collapsed: boolean): void;
  onDepthChange(depth: number): void;
  onRescan(): void;
  onCancel(): void;
  onCollapse(): void;
  onClose(): void;
  onCopyPath(path: string): void;
  onAction?(candidate: RepositoryCandidate, anchor: HTMLElement, kind: RepositoryRowActionKind): void;
  /** Bounded viewport candidates only; no activation or Git reads occur in this component. */
  onVisibleCandidates?(candidates: RepositoryCandidate[]): void;
}

interface TreeRowElement {
  element: HTMLDivElement;
  disclosure: HTMLSpanElement;
  glyph: HTMLSpanElement;
  label: HTMLSpanElement;
  branchControl: HTMLButtonElement;
  branchLabel: HTMLSpanElement;
  status: HTMLSpanElement;
  actions: HTMLDivElement;
  controls: Map<RepositoryRowActionKind, HTMLButtonElement>;
  summarySignature: string | null;
  candidate: boolean;
  node: RepositoryTreeNode;
  name: string | null;
  path: string | null;
  marker: RepositoryCandidate['marker'] | null;
  active: boolean | null;
  opening: boolean | null;
  expanded: boolean | null;
  branch: boolean | null;
}

let nextTreeId = 0;
function numberLabel(value: number): LocalizedMessage {
  return numberText(Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));
}
function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every(key => right.has(key));
}
function limitLabel(code: string): LocalizedMessage {
  switch (code) {
    case 'candidates': return m('limitCandidates');
    case 'directories': return m('limitDirectories');
    case 'entries': return m('limitEntries');
    case 'queue': return m('limitQueue');
    case 'output': return m('limitOutput');
    case 'time': return m('limitTime');
    default: return m('limitUnknown', { code });
  }
}
function warningLabel(code: string, count: number): LocalizedMessage {
  const value = numberLabel(count);
  switch (code) {
    case 'permission-denied': return m('warningPermission', { count: value });
    case 'io': return m('warningIo', { count: value });
    case 'outside-root': return m('warningOutsideRoot', { count: value });
    case 'link-skipped': return m('warningLink', { count: value });
    case 'invalid-path': return m('warningInvalidPath', { count: value });
    default: return m('warningUnknown', { code, count: value });
  }
}

function preserveFocus(container: HTMLElement | null): (() => void) | null {
  const target = document.activeElement as HTMLElement | null;
  if (!target || !container?.contains(target)) return null;
  const input = target as HTMLInputElement;
  const start = typeof input.selectionStart === 'number' ? input.selectionStart : null;
  const end = typeof input.selectionEnd === 'number' ? input.selectionEnd : null;
  const direction = input.selectionDirection;
  return () => {
    if (document.activeElement !== target) target.focus({ preventScroll: true });
    if (start !== null && end !== null && typeof input.setSelectionRange === 'function') {
      try { input.setSelectionRange(start, end, direction ?? undefined); } catch { /* Input types without selection support. */ }
    }
  };
}
function summaryBranch(summary: RepositorySummary | null): Localizable {
  if (!summary) return '—';
  if (summary.branch) return summary.branch;
  return summary.head ? actionMessage('detached', { head: summary.head.slice(0, 7) }) : actionMessage('headUnknown');
}
function summaryDescription(state: RepositorySummaryState | undefined): LocalizedMessage {
  return localized(locale => {
    if (!state?.summary) return resolveText(state?.error ? actionMessage('error', { error: state.error })
      : actionMessage(state?.loading ? 'loading' : 'unknown'), locale);
    const summary = state.summary;
    const count = (value: number | null): Localizable => value === null ? actionMessage('countUnknown') : numberLabel(value);
    const lines: Localizable[] = [];
    if (state.loading) lines.push(actionMessage('refreshing'));
    else if (state.stale) lines.push(actionMessage('stale'));
    if (state.error) lines.push(actionMessage('error', { error: state.error }));
    if (summary.branch && !summary.head) lines.push(actionMessage('unborn', { branch: summary.branch }));
    if (summary.bare) lines.push(actionMessage('bare'));
    else if (!summary.trusted) lines.push(actionMessage('untrusted'));
    else if (summary.changes === null) lines.push(actionMessage('changesUnknown'));
    else if (summary.changes === 0) lines.push(actionMessage('clean'));
    else lines.push(actionMessage('changes', { changes: count(summary.changes), staged: count(summary.staged),
      unstaged: count(summary.unstaged), untracked: count(summary.untracked) }));
    if (!summary.bare && summary.branch) {
      if (summary.upstream) lines.push(actionMessage('upstream', { upstream: summary.upstream }));
      else if (summary.trusted && summary.changes !== null) lines.push(actionMessage('noUpstream'));
      lines.push(summary.upstream && summary.ahead !== null && summary.behind !== null
        ? actionMessage('tracking', { ahead: count(summary.ahead), behind: count(summary.behind) }) : actionMessage('trackingUnknown'));
    }
    return lines.map(line => resolveText(line, locale)).join('\n');
  });
}

/**
 * Read-only navigation. The parent owns scope persistence, width/collapse,
 * scanner cancellation, summary probing, activation, and the single-active-repo policy.
 * This component deliberately has no Host, filesystem, or Git dependency.
 */
export class RepositoryTree {
  readonly element = el('aside', 'repository-tree');
  private readonly count = el('span', 'repository-tree-count');
  private readonly rootTitle = el('span', 'repository-tree-root-name');
  private readonly depth: HTMLSelectElement;
  private readonly rescan: HTMLButtonElement;
  private readonly cancel: HTMLButtonElement;
  private readonly spinner = el('span', 'spinner');
  private readonly statusText = el('span', 'repository-tree-status-text');
  private readonly status = el('div', 'repository-tree-status', this.spinner, this.statusText);
  private readonly controls = el('div', 'repository-tree-controls');
  private readonly tree = el('div', 'repository-tree-rows');
  private readonly emptyHint = el('p', 'repository-tree-empty-hint');
  private readonly hint = el('p', 'repository-tree-keyboard-hint', m('openHint'));
  private readonly metrics = el('p', 'repository-tree-metrics');
  private readonly errorDetail = el('pre', 'repository-tree-error');
  private readonly diagnostics = el('ul', 'repository-tree-diagnostics');
  private readonly details = el('details', 'repository-tree-details', el('summary', '', m('details')),
    this.metrics, this.errorDetail, this.diagnostics, el('p', 'repository-tree-candidate-hint', m('candidateOnly')));
  private readonly rows = new Map<string, TreeRowElement>();
  private readonly diagnosticRows = new Map<string, HTMLLIElement>();
  private model: RepositoryTreeModel | null = null;
  private data: RepositoryTreeData | null = null;
  private candidates: readonly RepositoryCandidate[] | null = null;
  private visible: RepositoryTreeRow[] = [];
  private collapsed = new Set<string>();
  private focusedKey: string | null = null;
  private diagnosticsSignature = '';
  private readonly local = el('div', 'repository-tree-local');
  private localElement: HTMLElement | null = null;
  private localPath: string | null = null;
  private localRoot: string | null = null;
  private visibilityFrame: number | null = null;
  private visibilitySignature = '';
  private resizeObserver: ResizeObserver | null = null;
  private readonly visibilityChanged = (): void => { this.scheduleVisibleCandidates(); };
  private destroyed = false;

  constructor(private readonly callbacks: RepositoryTreeCallbacks) {
    const id = `repository-tree-${++nextTreeId}`;
    setAttribute(this.element, 'aria-label', m('title'));
    this.tree.setAttribute('role', 'tree');
    // Independent sibling region: local forms/lists never live inside a treeitem.
    this.local.setAttribute('role', 'region'); this.local.hidden = true;
    this.tree.addEventListener('scroll', this.visibilityChanged, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.visibilityChanged); this.resizeObserver.observe(this.tree);
    } else if (typeof window !== 'undefined') window.addEventListener?.('resize', this.visibilityChanged);
    this.hint.id = `${id}-hint`; this.tree.setAttribute('aria-describedby', this.hint.id);
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite'); this.status.setAttribute('aria-atomic', 'true');
    this.spinner.setAttribute('aria-hidden', 'true'); this.spinner.hidden = true;
    this.cancel = button(m('cancel'), () => { if (!this.destroyed) this.callbacks.onCancel(); }, 'stop', 'repository-tree-cancel', true);
    this.cancel.dataset.action = 'cancel-repository-scan'; this.cancel.hidden = true;
    this.rescan = button(m('rescan'), () => { if (!this.destroyed) this.callbacks.onRescan(); }, 'refresh', '', true);
    this.rescan.dataset.action = 'rescan-repositories';
    const collapse = button(m('collapse'), () => { if (!this.destroyed) this.callbacks.onCollapse(); }, 'chevron', 'repository-tree-collapse', true);
    collapse.dataset.action = 'collapse-repository-tree';
    const close = button(m('close'), () => { if (!this.destroyed) this.callbacks.onClose(); }, 'close', '', true);
    close.dataset.action = 'close-directory-scope';
    const copy = button(m('copyPath'), () => { if (!this.destroyed && this.model) this.callbacks.onCopyPath(this.rootPath()); }, 'copy', '', true);
    copy.dataset.action = 'copy-directory-scope-path';
    const options = button(m('details'), () => menuAtButton(options, [
      { label: m('copyPath'), icon: 'copy', action: () => { if (this.model) this.callbacks.onCopyPath(this.rootPath()); } },
      ...Array.from({ length: 6 }, (_, value) => ({ label: m('depthOption', { depth: numberLabel(value) }),
        checked: clampRepositoryDepth(this.model?.depth ?? 0) === value,
        action: () => { if (!this.destroyed) this.callbacks.onDepthChange(value); } })),
      null, { label: m('collapse'), icon: 'sidebar', action: () => this.callbacks.onCollapse() },
      { label: m('close'), icon: 'close', action: () => this.callbacks.onClose() },
    ]), 'more', 'repository-tree-options', true);
    options.dataset.action = 'repository-tree-options';
    const heading = el('div', 'repository-tree-heading', el('strong', '', m('title')), this.count, el('span', 'spacer'), this.rescan, options);
    collapse.hidden = true; close.hidden = true;
    const root = el('div', 'repository-tree-root', icon('folder'), this.rootTitle, copy);
    this.depth = select(Array.from({ length: 6 }, (_, depth) => ({ value: String(depth), label: m('depthOption', { depth: numberLabel(depth) }) })), '0', m('depth'), value => {
      if (!this.destroyed) this.callbacks.onDepthChange(clampRepositoryDepth(Number(value)));
    });
    this.depth.dataset.action = 'repository-scan-depth';
    setAttribute(this.depth, 'title', m('depthHint'));
    const depthLabel = el('label', 'repository-tree-depth', el('span', '', m('depth')), this.depth);
    this.controls.append(depthLabel, el('span', 'spacer'), this.cancel, collapse, close);
    this.controls.hidden = true; root.hidden = true;
    this.element.append(el('header', 'repository-tree-header', heading, root, this.controls), this.status, this.tree, this.emptyHint, this.details, this.hint);
    this.errorDetail.hidden = true; this.emptyHint.hidden = true; this.details.hidden = true;
    setText(this.statusText, m('idle'));
  }

  update(model: RepositoryTreeModel): void {
    if (this.destroyed) return;
    const rootPath = model.discovery?.root ?? model.root;
    const candidates = model.discovery?.repositories ?? null;
    const rootChanged = this.data?.rootPath !== rootPath;
    const newData = rootChanged || candidates !== this.candidates || !this.data;
    const collapsed = new Set(model.collapsedPaths);
    const disclosureChanged = !sameKeys(this.collapsed, collapsed);
    const previousComponents = !rootChanged && this.focusedKey !== null ? this.data?.nodes.get(this.focusedKey)?.components ?? null : null;
    const hadFocus = this.visible.some(item => this.rows.get(item.node.key)?.element.contains(document.activeElement));
    this.model = model; this.collapsed = collapsed;
    if (newData) {
      this.candidates = candidates;
      this.data = buildRepositoryTree(rootPath, candidates ?? []);
      for (const [key, row] of this.rows) {
        if (!rootChanged && this.data.nodes.has(key)) continue;
        disposeBindings(row.element); row.element.remove(); this.rows.delete(key);
      }
    }
    if (newData || disclosureChanged) this.renderRows(previousComponents, hadFocus);
    this.updatePresentation();
    this.scheduleVisibleCandidates();
  }

  /** Move the owner's one local editor/list; never clone, rebuild, or dispose its bindings. */
  mountLocal(element: HTMLElement | null, path: string | null): void {
    if (this.destroyed) return;
    const restoreFocus = preserveFocus(element);
    if (this.localElement !== element) {
      if (this.localElement && this.local.contains(this.localElement)) this.localElement.remove();
      this.localElement = element;
    }
    if (element && !this.local.contains(element)) this.local.append(element);
    this.localPath = element ? path : null;
    this.localRoot = this.model ? this.rootPath() : null;
    this.placeLocal();
    if (!this.local.hidden) restoreFocus?.();
    this.scheduleVisibleCandidates();
  }

  /** Mutates labels/attributes only: no scan, activation, tree rebuild, or focus change. */
  updateLocale(): void {
    if (!this.destroyed && this.model) this.updatePresentation();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.visibilityFrame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.visibilityFrame);
    this.visibilityFrame = null; this.resizeObserver?.disconnect();
    if (typeof window !== 'undefined') window.removeEventListener?.('resize', this.visibilityChanged);
    this.tree.removeEventListener?.('scroll', this.visibilityChanged);
    // The owner will either remount or dispose the local editor/list itself.
    if (this.localElement && this.local.contains(this.localElement)) this.localElement.remove();
    this.localElement = null; this.local.remove();
    disposeBindings(this.local);
    disposeBindings(this.element);
    for (const row of this.rows.values()) if (!this.tree.contains(row.element)) disposeBindings(row.element);
    this.rows.clear(); this.diagnosticRows.clear(); this.visible = []; this.model = null; this.data = null; this.candidates = null;
    this.element.remove();
  }

  private rootPath(): string { return this.model?.discovery?.root ?? this.model?.root ?? ''; }
  private rootName(): string { return this.model?.rootName || repositoryScopeName(this.rootPath()); }
  private nodeName(node: RepositoryTreeNode): string { return node.parentKey === null ? this.rootName() : node.name; }

  private createRow(node: RepositoryTreeNode): TreeRowElement {
    const disclosure = el('span', 'repository-tree-disclosure', icon('chevron'));
    disclosure.setAttribute('aria-hidden', 'true');
    const glyph = el('span', 'repository-tree-glyph', icon(node.candidate ? 'branch' : 'folder'));
    glyph.setAttribute('aria-hidden', 'true');
    const label = el('span', 'repository-tree-label');
    const branchLabel = el('span', 'repository-tree-branch-label', '—');
    const branchControl = el('button', 'button repository-tree-branch', icon('branch'), branchLabel);
    branchControl.type = 'button'; branchControl.dataset.action = 'repository-branch';
    const status = el('span', 'repository-tree-row-status');
    status.setAttribute('role', 'img');
    const actions = el('div', 'repository-tree-actions'); actions.setAttribute('role', 'group');
    const controls = new Map<RepositoryRowActionKind, HTMLButtonElement>([['branch', branchControl]]);
    for (const [kind, glyph] of [['sync', 'compare'], ['commit', 'commit'], ['refresh', 'refresh'], ['more', 'more']] as const satisfies readonly (readonly [RepositoryRowActionKind, IconName])[]) {
      const control = el('button', 'button icon-button repository-tree-action', icon(glyph));
      control.type = 'button'; control.dataset.action = `repository-${kind}`;
      controls.set(kind, control); actions.append(control);
    }
    const element = el('div', 'repository-tree-row', disclosure, glyph, label, branchControl, status, actions);
    element.setAttribute('role', 'treeitem'); element.tabIndex = -1; element.dataset.repositoryKey = node.key;
    const row: TreeRowElement = { element, disclosure, glyph, label, branchControl, branchLabel, status, actions, controls,
      summarySignature: null, candidate: Boolean(node.candidate), node,
      name: null, path: null, marker: null, active: null, opening: null, expanded: null, branch: null };
    for (const [kind, control] of controls) {
      control.addEventListener('focus', () => { if (!this.destroyed && this.isCurrentRow(row)) this.setFocusedKey(row.node.key); });
      control.addEventListener('keydown', event => { event.stopPropagation(); });
      control.addEventListener('click', event => {
        event.stopPropagation();
        if (this.destroyed || event.button !== 0 || control.disabled || !this.isCurrentRow(row)) return;
        const candidate = row.node.candidate;
        if (candidate) this.callbacks.onAction?.(candidate, control, kind);
      });
    }
    element.addEventListener('focus', () => { if (!this.destroyed && this.isCurrentRow(row)) this.setFocusedKey(row.node.key); });
    element.addEventListener('click', event => {
      if (this.destroyed || !this.isCurrentRow(row) || event.button !== 0 || this.isControlTarget(row, event.target as Node)) return;
      this.focusRow(row.node.key, false);
      if (row.node.children.length && disclosure.contains(event.target as Node)) this.toggle(row.node.key, !this.collapsed.has(row.node.key));
      else if (row.node.candidate) this.activate(row.node);
      else if (row.node.children.length) this.toggle(row.node.key, !this.collapsed.has(row.node.key));
    });
    element.addEventListener('keydown', event => {
      if (this.destroyed || !this.isCurrentRow(row) || this.isControlTarget(row, event.target as Node) || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      if (event.shiftKey) { if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); event.stopPropagation(); } return; }
      const action = repositoryTreeKeyAction(this.visible, row.node.key, this.collapsed, event.key);
      if (!action) return;
      event.preventDefault(); event.stopPropagation();
      switch (action.type) {
        case 'focus': this.focusRow(action.key, true); break;
        case 'toggle': this.toggle(action.key, action.collapsed); break;
        case 'activate': this.activate(row.node); break;
        case 'none': break;
      }
    });
    return row;
  }

  private isControlTarget(row: TreeRowElement, target: Node): boolean {
    return row.branchControl.contains(target) || row.actions.contains(target);
  }

  private isCurrentRow(row: TreeRowElement): boolean {
    const current = this.data?.nodes.get(row.node.key);
    return this.rows.get(row.node.key) === row && current === row.node
      && this.visible.some(item => item.node === current) && this.tree.contains(row.element);
  }

  private placeLocal(): void {
    const item = this.localElement && this.localPath === this.model?.activePath && this.localRoot === this.rootPath()
      ? this.visible.find(item => item.node.candidate?.path === this.localPath) : undefined;
    const row = item ? this.rows.get(item.node.key) : undefined;
    if (!row || !this.localElement) { this.local.hidden = true; this.local.remove(); return; }
    this.local.hidden = false;
    setAttribute(this.local, 'aria-label', actionMessage('local', { name: this.nodeName(row.node) }));
    this.local.dataset.repositoryPath = this.localPath!;
    if (row.element.nextElementSibling !== this.local) {
      const restoreFocus = preserveFocus(this.local);
      this.tree.insertBefore(this.local, row.element.nextElementSibling);
      restoreFocus?.();
    }
  }

  private scheduleVisibleCandidates(): void {
    if (this.destroyed || !this.callbacks.onVisibleCandidates || this.visibilityFrame !== null) return;
    if (typeof requestAnimationFrame !== 'function') { this.publishVisibleCandidates(); return; }
    this.visibilityFrame = requestAnimationFrame(() => {
      this.visibilityFrame = null;
      this.publishVisibleCandidates();
    });
  }

  private publishVisibleCandidates(): void {
    if (this.destroyed || !this.callbacks.onVisibleCandidates || !this.model) return;
    const viewport = this.tree.getBoundingClientRect();
    const candidates: RepositoryCandidate[] = [];
    const measurable = Number.isFinite(viewport.top) && viewport.bottom > viewport.top;
    for (const item of this.visible) {
      if (!measurable || !item.node.candidate) continue;
      const row = this.rows.get(item.node.key);
      if (!row) continue;
      const bounds = measurable ? row.element.getBoundingClientRect() : null;
      if (bounds && (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom || bounds.bottom <= bounds.top)) continue;
      candidates.push(item.node.candidate);
      if (candidates.length >= MAX_VISIBLE_REPOSITORY_SUMMARIES) break;
    }
    const signature = JSON.stringify([this.rootPath(), candidates.map(candidate => [candidate.path, candidate.marker, candidate.components])]);
    if (signature === this.visibilitySignature) return;
    this.visibilitySignature = signature;
    this.callbacks.onVisibleCandidates(candidates);
  }

  private renderRows(preferredComponents: readonly string[] | null, restoreFocus: boolean): void {
    if (!this.data) return;
    const previousFocus = document.activeElement;
    const restorePreviousFocus = restoreFocus ? preserveFocus(this.tree) : null;
    this.visible = visibleRepositoryRows(this.data, this.collapsed);
    this.focusedKey = repositoryTreeFocusKey(this.visible, preferredComponents);
    let next = this.tree.firstElementChild;
    for (const item of this.visible) {
      let row = this.rows.get(item.node.key);
      if (!row) { row = this.createRow(item.node); this.rows.set(item.node.key, row); }
      row.node = item.node;
      row.element.tabIndex = item.node.key === this.focusedKey ? 0 : -1;
      for (const control of row.controls.values()) control.tabIndex = item.node.candidate && item.node.key === this.focusedKey ? 0 : -1;
      row.element.style.setProperty('--repository-tree-level', String(item.level - 1));
      row.element.setAttribute('aria-level', String(item.level));
      row.element.setAttribute('aria-posinset', String(item.position));
      row.element.setAttribute('aria-setsize', String(item.setSize));
      if (row.element !== next) this.tree.insertBefore(row.element, next);
      next = row.element.nextElementSibling;
      if (next === this.local) next = this.local.nextElementSibling;
    }
    while (next) { const old = next; next = old.nextElementSibling; if (old !== this.local) old.remove(); }
    this.placeLocal();
    this.scheduleVisibleCandidates();
    if (restorePreviousFocus && this.tree.contains(previousFocus)) restorePreviousFocus();
    else if (restoreFocus && this.focusedKey !== null && !this.tree.contains(document.activeElement)) this.focusRow(this.focusedKey, false);
  }

  private setFocusedKey(key: string): void {
    if (key === this.focusedKey) return;
    if (this.focusedKey !== null) {
      const previous = this.rows.get(this.focusedKey);
      if (previous) { previous.element.tabIndex = -1; for (const control of previous.controls.values()) control.tabIndex = -1; }
    }
    this.focusedKey = key;
    const row = this.rows.get(key);
    if (row) {
      row.element.tabIndex = 0;
      for (const control of row.controls.values()) control.tabIndex = row.node.candidate ? 0 : -1;
    }
  }

  private focusRow(key: string, scroll: boolean): void {
    const row = this.rows.get(key);
    if (!row || !this.visible.some(item => item.node.key === key)) return;
    this.setFocusedKey(key); row.element.focus({ preventScroll: true });
    if (scroll) {
      const bounds = row.element.getBoundingClientRect(), viewport = this.tree.getBoundingClientRect();
      if (bounds.top < viewport.top) this.tree.scrollTop -= viewport.top - bounds.top;
      else if (bounds.bottom > viewport.bottom) this.tree.scrollTop += bounds.bottom - viewport.bottom;
    }
  }

  private toggle(key: string, collapsed: boolean): void {
    const node = this.data?.nodes.get(key);
    if (!node?.children.length || this.collapsed.has(key) === collapsed) return;
    const components = this.focusedKey === null ? null : this.data?.nodes.get(this.focusedKey)?.components ?? null;
    const hadFocus = this.visible.some(item => this.rows.get(item.node.key)?.element.contains(document.activeElement));
    if (collapsed) this.collapsed.add(key); else this.collapsed.delete(key);
    this.renderRows(components, hadFocus);
    for (const item of this.visible) this.updateRow(this.rows.get(item.node.key)!);
    this.callbacks.onToggle(key, collapsed);
  }

  private activate(node: RepositoryTreeNode): void {
    if (node.candidate && node.candidate.path !== this.model?.openingPath) this.callbacks.onActivate(node.candidate);
  }

  private updateRow(row: TreeRowElement): void {
    const { node, element } = row;
    const name = this.nodeName(node);
    const active = Boolean(node.candidate && node.candidate.path === this.model?.activePath);
    const opening = Boolean(node.candidate && node.candidate.path === this.model?.openingPath);
    const branch = node.children.length > 0;
    const expanded = branch && !this.collapsed.has(node.key);
    const candidate = Boolean(node.candidate);
    if (row.active !== active) {
      element.classList.toggle('is-active', active); element.setAttribute('aria-selected', String(active));
      if (active) element.setAttribute('aria-current', 'true'); else element.removeAttribute('aria-current');
    }
    if (row.opening !== opening) {
      element.classList.toggle('is-opening', opening);
      if (opening) element.setAttribute('aria-busy', 'true'); else element.removeAttribute('aria-busy');
    }
    if (row.branch !== branch || row.expanded !== expanded) {
      element.classList.toggle('is-expanded', expanded); row.disclosure.classList.toggle('is-leaf', !branch);
      if (branch) element.setAttribute('aria-expanded', String(expanded)); else element.removeAttribute('aria-expanded');
    }
    if (row.name !== name) setText(row.label, name);
    const path = node.candidate?.path ?? (node.parentKey === null ? this.rootPath() : node.components.join(' / '));
    const marker = node.candidate?.marker ?? null;
    const state = node.candidate ? this.model?.summaries?.get(node.candidate.path) : undefined;
    // Never render another scope/candidate's data under a matching relative tree key.
    const summary = state?.summary && state.summary.path === node.candidate?.path ? state.summary : null;
    const safeState = state?.summary && !summary ? undefined : state;
    const summarySignature = JSON.stringify([summary, safeState?.loading, safeState?.error, safeState?.stale]);
    if (row.summarySignature !== summarySignature || row.name !== name || row.candidate !== candidate || row.opening !== opening || row.path !== path) {
      const description = summaryDescription(safeState);
      setText(row.branchLabel, summaryBranch(summary));
      const branchDescription = actionMessage('branchObservation', {
        action: actionMessage('branch', { name }), branch: summary ? summaryBranch(summary) : actionMessage('headUnknown'), status: description,
      });
      setAttribute(row.branchControl, 'title', branchDescription);
      setAttribute(row.branchControl, 'aria-label', branchDescription);
      for (const [kind, control] of row.controls) {
        control.disabled = !candidate || opening || !this.callbacks.onAction;
        control.tabIndex = candidate && node.key === this.focusedKey ? 0 : -1;
        if (kind !== 'branch') {
          setAttribute(control, 'title', actionMessage(kind, { name }));
          setAttribute(control, 'aria-label', actionMessage(kind, { name }));
        }
      }
      setAttribute(row.actions, 'aria-label', actionMessage('actions', { name }));
      if (candidate) { row.branchControl.removeAttribute('aria-hidden'); row.actions.removeAttribute('aria-hidden'); }
      else { row.branchControl.setAttribute('aria-hidden', 'true'); row.actions.setAttribute('aria-hidden', 'true'); }
      const statusKind = opening || safeState?.loading ? 'loading' : safeState?.error ? 'error' : safeState?.stale ? 'stale'
        : !summary ? 'unknown' : summary.bare ? 'bare' : !summary.trusted ? 'untrusted'
          : summary.changes === null ? 'unknown' : summary.changes ? 'changed' : 'clean';
      const glyph = statusKind === 'error' ? 'warning' : statusKind === 'stale' ? 'clock' : statusKind === 'clean' ? 'check'
        : statusKind === 'bare' ? 'folder' : statusKind === 'untrusted' ? 'shield' : statusKind === 'unknown' ? 'minus' : 'info';
      if (row.status.dataset.status !== statusKind) {
        row.status.dataset.status = statusKind;
        row.status.replaceChildren(statusKind === 'loading' ? el('span', 'spinner') : icon(glyph));
      }
      const statusLabel = opening ? m('opening') : description;
      setAttribute(row.status, 'aria-label', statusLabel); setAttribute(row.status, 'title', statusLabel);
      row.summarySignature = summarySignature;
    }
    if (row.candidate !== candidate || row.name === null) element.classList.toggle('is-repository', candidate);
    if (row.candidate !== candidate) row.glyph.replaceChildren(icon(candidate ? 'branch' : 'folder'));
    if (row.name !== name || row.active !== active || row.opening !== opening || row.candidate !== candidate) {
      const label = opening ? m('openingLabel', { name }) : active ? m('activeLabel', { name }) : node.candidate
        ? node.parentKey === null ? m('rootCandidateLabel', { name }) : m('candidateLabel', { name }) : m('groupLabel', { name });
      setAttribute(element, 'aria-label', label);
    }
    if (row.path !== path || row.marker !== marker) {
      const markerLabel = marker === 'bare' ? m('markerBare') : marker === 'git-file' ? m('markerGitFile') : m('markerGitDirectory');
      setAttribute(element, 'title', node.candidate ? localized(locale => `${path}\n${resolveText(markerLabel, locale)}\n${resolveText(m('candidateHint'), locale)}`) : path);
    }
    row.name = name; row.path = path; row.marker = marker; row.active = active; row.opening = opening;
    row.candidate = candidate; row.branch = branch; row.expanded = expanded;
  }

  private updatePresentation(): void {
    if (!this.model || !this.data) return;
    const model = this.model, discovery = model.discovery;
    const count = this.data.candidateCount, countValue = numberLabel(count);
    const incomplete = Boolean(discovery && (!discovery.complete || discovery.limit || this.data.omittedCount));
    setText(this.count, incomplete ? m('countValuePartial', { count: countValue }) : m('countValue', { count: countValue }));
    const countLabel = incomplete ? m('countPartial', { count: countValue }) : count === 1 ? m('countOne', { count: countValue }) : m('countMany', { count: countValue });
    setAttribute(this.count, 'title', countLabel); setAttribute(this.count, 'aria-label', countLabel);
    setText(this.rootTitle, this.rootName());
    setAttribute(this.rootTitle, 'title', this.rootPath());
    setAttribute(this.rootTitle, 'aria-label', m('rootLabel', { name: this.rootPath() }));
    setAttribute(this.tree, 'aria-label', m('treeLabel', { name: this.rootName() }));
    this.tree.setAttribute('aria-busy', String(model.loading));
    this.depth.value = String(clampRepositoryDepth(model.depth));
    this.rescan.disabled = model.loading; this.cancel.hidden = !model.loading; this.spinner.hidden = !model.loading;
    const failed = model.error !== undefined && model.error !== null;
    let status: Localizable;
    if (model.loading) status = m(discovery ? 'scanningPrevious' : 'scanning');
    else if (failed) status = m(discovery ? 'failedPrevious' : 'failed');
    else if (model.cancelled) status = m(discovery ? 'cancelledPrevious' : 'cancelled');
    else if (!discovery) status = m('idle');
    else if (incomplete) status = count ? count === 1 ? m('partialOne', { count: countValue }) : m('partialMany', { count: countValue }) : m('partialEmpty');
    else if (discovery.warnings.length) status = count === 1 ? m('completeWarningsOne', { count: countValue }) : m('completeWarningsMany', { count: countValue });
    else if (!count) status = m('empty');
    else status = count === 1 ? m('completeOne', { count: countValue }) : m('completeMany', { count: countValue });
    setText(this.statusText, status);
    this.status.classList.toggle('is-error', failed && !model.loading);
    this.status.classList.toggle('is-partial', !model.loading && !failed && (incomplete || Boolean(model.cancelled)));
    this.status.hidden = Boolean(discovery && !model.loading && !failed && !incomplete && !model.cancelled && !discovery.warnings.length);
    this.controls.hidden = !model.loading;
    this.emptyHint.hidden = !discovery || count > 0 || model.loading || failed || Boolean(model.cancelled);
    setText(this.emptyHint, incomplete ? m('partialHint') : m('emptyHint'));
    this.details.hidden = !discovery && !failed;
    const diagnosticsSignature = JSON.stringify([failed && !model.loading, incomplete, discovery?.limit, discovery?.warnings, this.data.omittedCount]);
    if (this.diagnosticsSignature !== diagnosticsSignature) {
      this.diagnosticsSignature = diagnosticsSignature;
      this.details.open = Boolean((failed && !model.loading) || incomplete || discovery?.warnings.length);
    }
    this.metrics.hidden = !discovery;
    if (discovery) setText(this.metrics, m('scanMetrics', { directories: numberLabel(discovery.directories), entries: numberLabel(discovery.entries) }));
    this.errorDetail.hidden = !failed || model.loading;
    setText(this.errorDetail, failed ? model.error ?? '' : '');
    const diagnostics: { key: string; label: Localizable }[] = [];
    if (discovery?.limit) diagnostics.push({ key: 'limit', label: limitLabel(discovery.limit) });
    discovery?.warnings.forEach((warning, index) => diagnostics.push({ key: `warning:${index}:${warning.code}`, label: warningLabel(warning.code, warning.count) }));
    if (this.data.omittedCount) diagnostics.push({ key: 'omitted', label: m('omitted', { count: numberLabel(this.data.omittedCount) }) });
    this.updateDiagnostics(diagnostics);
    for (const item of this.visible) this.updateRow(this.rows.get(item.node.key)!);
    this.placeLocal();
  }

  private updateDiagnostics(items: readonly { key: string; label: Localizable }[]): void {
    const present = new Set(items.map(item => item.key));
    for (const [key, row] of this.diagnosticRows) if (!present.has(key)) { disposeBindings(row); row.remove(); this.diagnosticRows.delete(key); }
    let next = this.diagnostics.firstElementChild;
    for (const item of items) {
      let row = this.diagnosticRows.get(item.key);
      if (!row) { row = el('li'); this.diagnosticRows.set(item.key, row); }
      setText(row, item.label);
      if (row !== next) this.diagnostics.insertBefore(row, next);
      next = row.nextElementSibling;
    }
    this.diagnostics.hidden = !items.length;
  }
}

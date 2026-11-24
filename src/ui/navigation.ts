import type { Commit } from '../shared/protocol';

export interface KeyStroke { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }
/** Ctrl bindings are portable primary-modifier bindings; explicit Cmd/Meta bindings remain explicit. */
export function matchesShortcut(event: KeyStroke, binding: string): boolean {
  const parts = binding.toLowerCase().replace(/command/g, 'cmd').replace(/control/g, 'ctrl').split('+').map(part => part.trim()).filter(Boolean);
  const key = parts.pop(); if (!key) return false;
  const primary = parts.includes('ctrl') || parts.includes('mod') || parts.includes('primary');
  const meta = parts.includes('cmd') || parts.includes('meta');
  const alt = parts.includes('alt') || parts.includes('option');
  const shift = parts.includes('shift');
  if (parts.some(part => !['ctrl', 'mod', 'primary', 'cmd', 'meta', 'alt', 'option', 'shift'].includes(part))) return false;
  const actualKey = event.key.toLowerCase() === ' ' ? 'space' : event.key.toLowerCase();
  const expectedKey = key === 'esc' ? 'escape' : key === 'return' ? 'enter' : key;
  const modifier = primary ? event.ctrlKey || event.metaKey : meta ? event.metaKey && !event.ctrlKey : !event.ctrlKey && !event.metaKey;
  return modifier && event.altKey === alt && event.shiftKey === shift && actualKey === expectedKey;
}
export function editableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""],[role="textbox"]'));
}
export function overlayOpen(): boolean { return Boolean(document.querySelector('dialog[open],[role="menu"]')); }

/** Direct parent/child navigation never uses row adjacency as a proxy for branch ancestry. */
export function branchNeighbours(commits: readonly Commit[], oid: string, direction: 'parent' | 'child', alternate = false): string[] {
  const commit = commits.find(item => item.oid === oid);
  if (!commit) return [];
  if (direction === 'parent') return [...new Set(alternate ? commit.parents.slice(1) : commit.parents.slice(0, 1))];
  return commits.filter(item => alternate ? item.parents.slice(1).includes(oid) : item.parents[0] === oid).map(item => item.oid);
}

export type InlineSide = 'before' | 'after';
/** Variable-height history geometry. The insertion boundary may be zero (before the first row). */
export class RowLayout {
  readonly slotIndex: number;
  readonly slotBoundary: number;
  readonly slotHeight: number;
  constructor(readonly count: number, readonly rowHeight: number, slotIndex = -1, slotHeight = 0, readonly side: InlineSide = 'after') {
    this.slotIndex = slotIndex >= 0 && slotIndex < count && Number.isFinite(slotHeight) && slotHeight > 0 ? slotIndex : -1;
    this.slotBoundary = this.slotIndex < 0 ? -1 : this.slotIndex + Number(side === 'after');
    this.slotHeight = this.slotIndex < 0 ? 0 : slotHeight;
  }
  get totalHeight(): number { return this.count * this.rowHeight + this.slotHeight; }
  get slotTop(): number { return this.slotBoundary >= 0 ? this.slotBoundary * this.rowHeight : -1; }
  top(index: number): number { return index * this.rowHeight + (this.slotBoundary >= 0 && index >= this.slotBoundary ? this.slotHeight : 0); }
  indexAt(y: number): number {
    if (!this.count) return -1;
    const position = Math.max(0, y);
    if (this.slotBoundary >= 0 && position >= this.slotTop) {
      if (position < this.slotTop + this.slotHeight) return this.slotIndex;
      return Math.min(this.count - 1, Math.floor((position - this.slotHeight) / this.rowHeight));
    }
    return Math.min(this.count - 1, Math.floor(position / this.rowHeight));
  }
  /** Remove only the portion of the insertion preceding the viewport; independent of selected row. */
  plainScrollTop(scrollTop: number, viewportHeight = 0): number {
    const inserted = this.slotBoundary < 0 ? 0 : Math.max(0, Math.min(this.slotHeight, scrollTop - this.slotTop));
    return Math.max(0, Math.min(Math.max(0, this.count * this.rowHeight - viewportHeight), scrollTop - inserted));
  }
  visibleRange(scrollTop: number, viewportHeight: number, before = 5, after = 7): { first: number; last: number } {
    if (!this.count) return { first: 0, last: 0 };
    return { first: Math.max(0, this.indexAt(scrollTop) - before), last: Math.min(this.count, this.indexAt(scrollTop + viewportHeight) + after) };
  }
}

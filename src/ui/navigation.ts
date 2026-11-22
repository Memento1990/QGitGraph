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

/** Variable-height virtual list with one actual inline details slot after a commit row. */
export class RowLayout {
  readonly slotIndex: number;
  constructor(readonly count: number, readonly rowHeight: number, slotIndex = -1, readonly slotHeight = 0) {
    this.slotIndex = slotIndex >= 0 && slotIndex < count && slotHeight > 0 ? slotIndex : -1;
  }
  get totalHeight(): number { return this.count * this.rowHeight + (this.slotIndex >= 0 ? this.slotHeight : 0); }
  get slotTop(): number { return this.slotIndex >= 0 ? (this.slotIndex + 1) * this.rowHeight : -1; }
  top(index: number): number { return index * this.rowHeight + (this.slotIndex >= 0 && index > this.slotIndex ? this.slotHeight : 0); }
  indexAt(y: number): number {
    if (!this.count) return -1;
    const position = Math.max(0, y);
    if (this.slotIndex >= 0 && position >= this.slotTop) {
      if (position < this.slotTop + this.slotHeight) return this.slotIndex;
      return Math.min(this.count - 1, Math.floor((position - this.slotHeight) / this.rowHeight));
    }
    return Math.min(this.count - 1, Math.floor(position / this.rowHeight));
  }
}

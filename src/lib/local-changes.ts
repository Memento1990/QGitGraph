import type { AppSettings, ChangedFile, DiffQuery, Repository, WorkingFileTarget, WorkingState } from '../shared/protocol';

export type LocalChangesPosition = 'workspace' | 'sidebar';
export type LocalChangeGroup = 'staged' | 'unstaged' | 'untracked';
export interface LocalChangeEntry { key: string; group: LocalChangeGroup; file: ChangedFile }
export interface LocalChangesGroup { id: LocalChangeGroup; entries: LocalChangeEntry[] }
export const LOCAL_CHANGE_GROUPS = ['staged', 'unstaged', 'untracked'] as const;
export const LOCAL_FILE_HEIGHT = 27;
export const LOCAL_GROUP_HEIGHT = 28;
export const LOCAL_VIRTUAL_THRESHOLD = 200;
export const LOCAL_DRAFT_LIMIT = 65_536;

export function localChangeKey(group: LocalChangeGroup, path: string): string { return JSON.stringify([group, path]); }
export function isUntrackedFile(file: Pick<ChangedFile, 'status'>): boolean { return file.status.startsWith('?'); }

/** A partially staged path deliberately has two independent entries, never two copies of its DTO. */
export function groupLocalChanges(working: Pick<WorkingState, 'files'> | null): LocalChangesGroup[] {
  const groups = LOCAL_CHANGE_GROUPS.map(id => ({ id, entries: [] as LocalChangeEntry[] }));
  for (const file of working?.files ?? []) {
    if (isUntrackedFile(file)) groups[2].entries.push({ key: localChangeKey('untracked', file.path), group: 'untracked', file });
    else {
      if (file.staged) groups[0].entries.push({ key: localChangeKey('staged', file.path), group: 'staged', file });
      if (file.unstaged) groups[1].entries.push({ key: localChangeKey('unstaged', file.path), group: 'unstaged', file });
    }
  }
  return groups;
}

export function localFileStatus(entry: LocalChangeEntry): string {
  if (entry.group === 'untracked') return '?';
  const status = entry.file.status;
  return (status.length > 1 ? status[entry.group === 'staged' ? 0 : 1] : status)?.replace(/[. ]/, '') || 'M';
}

/** Explicit literal paths only. No empty-files/all sentinel and no caller-owned objects escape. */
export function localFileTargets(entries: readonly LocalChangeEntry[]): WorkingFileTarget[] {
  const seen = new Set<string>();
  return entries.flatMap(({ file }) => {
    if (seen.has(file.path)) return [];
    seen.add(file.path);
    return [{ path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}), status: file.status }];
  });
}

/** Renames in the index must not make an unstaged content read look up the pre-rename index path. */
export function localDiffQuery(repo: Repository, entry: LocalChangeEntry, settings: Pick<AppSettings, 'encoding'>, requestId = ''): DiffQuery {
  const staged = entry.group === 'staged';
  const renamedOnThisSide = /[RC]/.test(localFileStatus(entry));
  return {
    repoId: repo.id, requestId, path: entry.file.path,
    ...(entry.file.oldPath && renamedOnThisSide ? { oldPath: entry.file.oldPath } : {}),
    base: staged ? repo.head : entry.group === 'untracked' ? 'ROOT' : 'INDEX',
    target: staged ? 'INDEX' : 'WORKTREE', staged, context: 3, encoding: settings.encoding,
  };
}

export interface LocalChangeLayoutRow {
  key: string; group: LocalChangeGroup; top: number; height: number;
  entry?: LocalChangeEntry; count: number; end: number;
}
export interface LocalChangeLayout { rows: LocalChangeLayoutRow[]; height: number; files: number }
export function localChangesLayout(groups: readonly LocalChangesGroup[], collapsed: ReadonlySet<LocalChangeGroup> = new Set()): LocalChangeLayout {
  const rows: LocalChangeLayoutRow[] = []; let top = 0, files = 0;
  for (const group of groups) {
    files += group.entries.length;
    if (!group.entries.length) continue;
    const heading: LocalChangeLayoutRow = { key: `group:${group.id}`, group: group.id, top, height: LOCAL_GROUP_HEIGHT, count: group.entries.length, end: top };
    rows.push(heading); top += heading.height;
    if (!collapsed.has(group.id)) for (const entry of group.entries) {
      rows.push({ key: entry.key, group: group.id, top, height: LOCAL_FILE_HEIGHT, entry, count: group.entries.length, end: top + LOCAL_FILE_HEIGHT });
      top += LOCAL_FILE_HEIGHT;
    }
    heading.end = top;
  }
  return { rows, height: top, files };
}

/** Binary-search the mixed-height layout; preparation is O(n), each scroll window is O(log n). */
export function localChangesWindow(rows: readonly LocalChangeLayoutRow[], scrollTop: number, height: number, overscan = 6): { first: number; last: number } {
  const offset = Math.max(0, scrollTop), bottom = offset + Math.max(0, height);
  const locate = (value: number): number => {
    let low = 0, high = rows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].top + rows[middle].height <= value) low = middle + 1; else high = middle; }
    return low;
  };
  return { first: Math.max(0, locate(offset) - overscan), last: Math.min(rows.length, locate(bottom) + overscan + 1) };
}

export interface LocalChangeDraft { message: string; start: number; end: number; direction: 'forward' | 'backward' | 'none'; scrollTop: number; scrollLeft?: number }
/** Component-lifetime memory only: bounded by repository count and total UTF-16 characters; never persisted. */
export class LocalChangeDrafts {
  private readonly drafts = new Map<string, LocalChangeDraft>();
  private characters = 0;
  constructor(private readonly capacity = 20, private readonly budget = 512 * 1024) {}
  get size(): number { return this.drafts.size; }
  get length(): number { return this.characters; }
  get(repoId: string): LocalChangeDraft | undefined {
    const value = this.drafts.get(repoId);
    if (!value) return undefined;
    this.drafts.delete(repoId); this.drafts.set(repoId, value); return { ...value };
  }
  set(repoId: string, value: LocalChangeDraft): void {
    this.delete(repoId);
    if (!value.message || this.capacity <= 0 || this.budget <= 0) return;
    const message = value.message.slice(0, Math.min(LOCAL_DRAFT_LIMIT, this.budget));
    const start = Math.max(0, Math.min(message.length, value.start)), end = Math.max(start, Math.min(message.length, value.end));
    this.drafts.set(repoId, { message, start, end, direction: value.direction, scrollTop: Math.max(0, value.scrollTop), scrollLeft: Math.max(0, value.scrollLeft ?? 0) }); this.characters += message.length;
    while (this.drafts.size > this.capacity || this.characters > this.budget) this.delete(this.drafts.keys().next().value!);
  }
  delete(repoId: string): void { const value = this.drafts.get(repoId); if (value) { this.characters -= value.message.length; this.drafts.delete(repoId); } }
  clear(): void { this.drafts.clear(); this.characters = 0; }
}

import type { CommitDetail, DiffQuery, DiffResult, ReviewTarget } from '../shared/protocol';
import { isImmutableOid, LruCache } from './format';

export type DiffLineKind = 'context' | 'addition' | 'deletion' | 'meta';
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}
export interface ParsedDiff { headers: string[]; hunks: DiffHunk[]; limited?: boolean }
export interface SplitLine { left: DiffLine | null; right: DiffLine | null }
export const MAX_DIFF_LINES = 100_000;

/** Iterate only the requested prefix; never split/copy a multi-megabyte patch first. */
export function textLines(content: string, maxLines = Infinity): { lines: string[]; limited: boolean } {
  const lines: string[] = [], limit = Math.max(0, Math.floor(maxLines));
  let offset = 0;
  while (offset < content.length && lines.length < limit) {
    const end = content.indexOf('\n', offset), next = end < 0 ? content.length : end;
    const stop = end >= 0 && content.charCodeAt(next - 1) === 13 ? next - 1 : next;
    lines.push(content.slice(offset, stop)); offset = end < 0 ? content.length : end + 1;
  }
  return { lines, limited: offset < content.length };
}

/** Parse unified output, including zero-length ranges and no-final-newline markers.
 * The optional budget counts input lines (headers included), so even header-only output is bounded.
 */
export function parsePatch(patch: string, maxLines = Infinity): ParsedDiff {
  const result: ParsedDiff = { headers: [], hunks: [] };
  let hunk: DiffHunk | null = null, oldLine = 0, newLine = 0, offset = 0, count = 0;
  const limit = Math.max(0, Math.floor(maxLines));
  while (offset < patch.length && count++ < limit) {
    const end = patch.indexOf('\n', offset), next = end < 0 ? patch.length : end;
    const stop = end >= 0 && patch.charCodeAt(next - 1) === 13 ? next - 1 : next;
    const raw = patch.slice(offset, stop); offset = end < 0 ? patch.length : end + 1;
    const match = raw.startsWith('@@ ') ? /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw) : null;
    if (match) {
      oldLine = Number(match[1]); newLine = Number(match[2]);
      hunk = { header: raw, oldStart: oldLine, newStart: newLine, lines: [] };
      result.hunks.push(hunk); continue;
    }
    if (!hunk || raw.startsWith('diff --git ') || raw.startsWith('diff --cc ')) {
      result.headers.push(raw); hunk = null; continue;
    }
    const prefix = raw[0];
    if (prefix === '+') hunk.lines.push({ kind: 'addition', text: raw.slice(1), oldLine: null, newLine: newLine++ });
    else if (prefix === '-') hunk.lines.push({ kind: 'deletion', text: raw.slice(1), oldLine: oldLine++, newLine: null });
    else if (prefix === ' ') hunk.lines.push({ kind: 'context', text: raw.slice(1), oldLine: oldLine++, newLine: newLine++ });
    else hunk.lines.push({ kind: 'meta', text: raw, oldLine: null, newLine: null });
  }
  if (offset < patch.length) result.limited = true;
  return result;
}

/** Align each change block once; an insertion never consumes an old-side number. */
export function splitLines(lines: readonly DiffLine[]): SplitLine[] {
  const result: SplitLine[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = (): void => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) {
      result.push({ left: removed[index] ?? null, right: added[index] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === 'deletion') {
      if (added.length) flush();
      removed.push(line);
    } else if (line.kind === 'addition') added.push(line);
    else {
      flush();
      result.push({ left: line, right: line });
    }
  }
  flush();
  return result;
}

export function contentLines(content: string | null): string[] { return content === null ? [] : textLines(content).lines; }

export type ContentSide = 'old' | 'new';
export interface DiffViewLine { kind: string; left: string; right?: string; old: number | null; next: number | null; sign?: string }
export interface DiffRows { lines: DiffViewLine[]; limited: boolean; hunkCount: number }
interface PatchModel { parsed: ParsedDiff; unified?: DiffRows; split?: DiffRows; bytes: number }

/** Patch-only, identity-keyed models. Settings and side-content changes never reparse the patch. */
export class PatchModelCache {
  private identities = new WeakMap<DiffResult, string>();
  private sequence = 0;
  private cache: LruCache<PatchModel>;
  parsePasses = 0;
  rowPasses = 0;
  constructor(private readonly maxLines = MAX_DIFF_LINES, limit = 8, byteLimit = 24 * 1024 * 1024) {
    this.cache = new LruCache(limit, byteLimit, model => model.bytes);
  }
  get size(): number { return this.cache.size; }
  get bytes(): number { return this.cache.bytes; }
  prepare(result: DiffResult, split: boolean): DiffRows {
    let key = this.identities.get(result);
    if (!key) { key = String(++this.sequence); this.identities.set(result, key); }
    let model = this.cache.get(key);
    if (!model) {
      const parsed = parsePatch(result.patch, this.maxLines); this.parsePasses++;
      // Include the source allocation: substring implementations may retain it.
      let bytes = result.patch.length * 2 + 128;
      for (const header of parsed.headers) bytes += header.length * 2 + 16;
      for (const hunk of parsed.hunks) { bytes += hunk.header.length * 2 + 64; for (const line of hunk.lines) bytes += line.text.length * 2 + 64; }
      model = { parsed, bytes };
    }
    const variant = split ? 'split' : 'unified';
    const cached = model[variant]; if (cached) return cached;
    const lines: DiffViewLine[] = [];
    let limited = Boolean(model.parsed.limited);
    for (const hunk of model.parsed.hunks) {
      if (lines.length >= this.maxLines) { limited = true; break; }
      lines.push({ kind: 'hunk', left: hunk.header, old: null, next: null });
      const source = split ? splitLines(hunk.lines) : hunk.lines;
      for (const item of source) {
        if (lines.length >= this.maxLines) { limited = true; break; }
        if (split) {
          const pair = item as SplitLine;
          lines.push({ kind: pair.left?.kind === 'meta' || pair.right?.kind === 'meta' ? 'meta' : 'split-line', left: pair.left?.text ?? '', right: pair.right?.text ?? '', old: pair.left?.oldLine ?? null, next: pair.right?.newLine ?? null, sign: `${pair.left?.kind === 'deletion' ? '-' : ' '}${pair.right?.kind === 'addition' ? '+' : ' '}` });
        } else {
          const line = item as DiffLine;
          lines.push({ kind: line.kind, left: line.text, old: line.oldLine, next: line.newLine, sign: line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' ' });
        }
      }
    }
    const rows = { lines, limited, hunkCount: model.parsed.hunks.length };
    model[variant] = rows; model.bytes += lines.length * 96; this.rowPasses++;
    this.cache.set(key, model); return rows;
  }
  clear(): void { this.cache.clear(); this.identities = new WeakMap(); }
}
export function contentRows(content: string, side: ContentSide, maxLines = MAX_DIFF_LINES): DiffRows {
  const preview = textLines(content, maxLines);
  return { lines: preview.lines.map((left, index) => ({ kind: 'context', left, old: side === 'old' ? index + 1 : null, next: side === 'new' ? index + 1 : null })), limited: preview.limited, hunkCount: 0 };
}
/** Constant-time conservative weights, without serializing multi-megabyte strings. */
export function diffBytes(result: DiffResult): number { return 128 + (result.patch.length + (result.oldContent?.length ?? 0) + (result.newContent?.length ?? 0)) * 2; }
export function detailBytes(detail: CommitDetail): number {
  const commit = detail.commit;
  let bytes = 512 + (detail.body.length + detail.committer.length + detail.committerEmail.length + commit.subject.length + commit.author.length + commit.email.length + commit.oid.length + (detail.base?.length ?? 0) + detail.signature.status.length + detail.signature.signer.length + detail.signature.key.length) * 2;
  for (const parent of commit.parents) bytes += parent.length * 2 + 16;
  for (const ref of commit.refs) bytes += 128 + (ref.name.length + ref.fullName.length + ref.oid.length + ref.subject.length + (ref.upstream?.length ?? 0)) * 2;
  for (const file of detail.files) bytes += 160 + (file.path.length + (file.oldPath?.length ?? 0) + file.status.length) * 2;
  return bytes;
}

export interface FileNode<T> { name: string; path: string; file?: T; children: FileNode<T>[] }
const fileCollator = new Intl.Collator(undefined, { numeric: true });
export function fileTree<T extends { path: string }>(files: readonly T[], compact = true): FileNode<T>[] {
  const root: FileNode<T> = { name: '', path: '', children: [] }, index = new Map<string, FileNode<T>>();
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root, path = '';
    for (let part = 0; part < parts.length; part++) {
      path = part ? `${path}/${parts[part]}` : parts[part];
      let child = index.get(path);
      if (!child) { child = { name: parts[part], path, children: [] }; index.set(path, child); current.children.push(child); }
      if (part === parts.length - 1) child.file = file;
      current = child;
    }
  }
  const prepare = (nodes: FileNode<T>[]): FileNode<T>[] => nodes
    .sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || fileCollator.compare(a.name, b.name))
    .map(node => {
      let next = { ...node, children: prepare(node.children) };
      if (compact) {
        while (!next.file && next.children.length === 1 && !next.children[0].file) {
          const child = next.children[0]; next = { ...child, name: `${next.name}/${child.name}` };
        }
      }
      return next;
    });
  return prepare(root.children);
}
/** A file set is immutable for its published lifetime; selection/review are not tree inputs. */
export class FileTreeCache<T extends { path: string }> {
  private values = new WeakMap<readonly T[], { compact?: FileNode<T>[]; expanded?: FileNode<T>[] }>();
  buildPasses = 0;
  get(files: readonly T[], compact: boolean): FileNode<T>[] {
    let entry = this.values.get(files); if (!entry) { entry = {}; this.values.set(files, entry); }
    const key = compact ? 'compact' : 'expanded';
    if (!entry[key]) { entry[key] = fileTree(files, compact); this.buildPasses++; }
    return entry[key];
  }
  clear(): void { this.values = new WeakMap(); }
}
export function fileWindow(count: number, scrollTop: number, height: number, rowHeight = 24, overscan = 8): { first: number; last: number } {
  const first = Math.min(count, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  return { first, last: Math.min(count, Math.max(first, Math.ceil((scrollTop + height) / rowHeight) + overscan)) };
}

export function immutableSelection(selection: ReviewTarget | { kind: 'working' } | null): selection is ReviewTarget {
  if (!selection || selection.kind === 'working') return false;
  return selection.kind === 'commit' ? isImmutableOid(selection.oid) && (!selection.parent || isImmutableOid(selection.parent)) : isImmutableOid(selection.base) && isImmutableOid(selection.target);
}
/** Null base represents the immutable empty tree, not a mutable HEAD token. */
export function cacheableDiff(query: Pick<DiffQuery, 'base' | 'target'>): boolean {
  return isImmutableOid(query.target) && (query.base === null || isImmutableOid(query.base));
}
export function diffCacheKey(query: DiffQuery): string {
  return JSON.stringify({ repoId: query.repoId, base: query.base, target: query.target, path: query.path, oldPath: query.oldPath ?? '', context: query.context ?? 3, encoding: query.encoding ?? 'utf-8', staged: Boolean(query.staged) });
}

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
  oldCount?: number;
  newCount?: number;
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
    const match = raw.startsWith('@@ ') ? /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw) : null;
    if (match) {
      const oldStart = Number(match[1]), newStart = Number(match[3]);
      const oldCount = Number(match[2] ?? 1), newCount = Number(match[4] ?? 1);
      // In a zero-length range Git names the preceding line, not the next line.
      oldLine = oldStart + Number(oldCount === 0); newLine = newStart + Number(newCount === 0);
      hunk = { header: raw, oldStart, newStart, oldCount, newCount, lines: [] };
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
export interface DiffViewLine {
  kind: string; left: string; right?: string; old: number | null; next: number | null; sign?: string;
  id?: string; changeId?: string; gapId?: string; gapCount?: number; expanded?: boolean;
  gapStatus?: 'unavailable' | 'limited' | 'loading' | 'error' | 'cancelled';
}
export interface DiffChange {
  kind: 'change'; id: string; oldStart: number; newStart: number; oldCount: number; newCount: number; lines: DiffLine[];
}
export interface DiffGap {
  kind: 'gap'; id: string; oldStart: number; newStart: number; oldEnd: number | null; newEnd: number | null; lines: DiffLine[];
}
export interface DiffDocument { sections: (DiffChange | DiffGap)[]; changes: DiffChange[]; limited: boolean }
export interface DiffChangeRange { id: string; first: number; last: number }
export interface DiffRows { lines: DiffViewLine[]; limited: boolean; hunkCount: number; document?: DiffDocument; changes?: DiffChangeRange[] }
interface PatchModel { parsed: ParsedDiff; document: DiffDocument; unified?: DiffRows; split?: DiffRows; bytes: number }

/** Semantic coordinates, not hunk indexes: changing context or display mode leaves block identities intact. */
export function diffDocument(parsed: ParsedDiff): DiffDocument {
  const sections: DiffDocument['sections'] = [], changes: DiffChange[] = [];
  let old = 1, next = 1, gapOld = 1, gapNew = 1, context: DiffLine[] = [], pending: DiffChange | null = null;
  const flushChange = (): void => {
    if (!pending) return;
    pending.id = `change:${pending.oldStart}:${pending.oldCount}:${pending.newStart}:${pending.newCount}`;
    sections.push(pending); changes.push(pending);
    gapOld = pending.oldStart + pending.oldCount; gapNew = pending.newStart + pending.newCount; pending = null;
  };
  const flushGap = (oldEnd: number | null, newEnd: number | null): void => {
    if (context.length || oldEnd === null || oldEnd > gapOld || (newEnd !== null && newEnd > gapNew)) {
      sections.push({ kind: 'gap', id: `gap:${gapOld}:${gapNew}:${oldEnd ?? 'end'}:${newEnd ?? 'end'}`, oldStart: gapOld, newStart: gapNew, oldEnd, newEnd, lines: context });
    }
    context = [];
  };
  for (const hunk of parsed.hunks) {
    const hunkOld = hunk.oldStart + Number(hunk.oldCount === 0), hunkNew = hunk.newStart + Number(hunk.newCount === 0);
    if (pending && (hunkOld !== old || hunkNew !== next)) flushChange();
    old = hunkOld; next = hunkNew;
    for (const line of hunk.lines) {
      if (line.kind === 'addition' || line.kind === 'deletion') {
        if (!pending) {
          flushGap(old, next);
          pending = { kind: 'change', id: '', oldStart: old, newStart: next, oldCount: 0, newCount: 0, lines: [] };
        }
        pending.lines.push(line);
        if (line.kind === 'deletion') { pending.oldCount++; old = (line.oldLine ?? old) + 1; }
        else { pending.newCount++; next = (line.newLine ?? next) + 1; }
      } else if (line.kind === 'meta' && pending) pending.lines.push(line);
      else {
        flushChange(); context.push(line);
        if (line.oldLine !== null) old = line.oldLine + 1;
        if (line.newLine !== null) next = line.newLine + 1;
      }
    }
  }
  flushChange(); flushGap(null, null);
  return { sections, changes, limited: Boolean(parsed.limited) };
}

export interface DiffContextContent { content: string | null; binary: boolean; truncated: boolean }
export interface DiffProjectionOptions {
  showUnchanged?: boolean; expandedGaps?: ReadonlySet<string>;
  oldContent?: DiffContextContent; newContent?: DiffContextContent;
  contextStatus?: DiffViewLine['gapStatus']; maxLines?: number;
}
/** Prepared once per side; importantly this cache does not keep a result/patch alive. */
const contextPreviews = new WeakMap<DiffContextContent, ReturnType<typeof textLines>>();
function contextPreview(data: DiffContextContent | undefined): ReturnType<typeof textLines> | undefined {
  if (!data || data.content === null || data.binary || data.truncated) return;
  let preview = contextPreviews.get(data);
  if (!preview) { preview = textLines(data.content, MAX_DIFF_LINES); contextPreviews.set(data, preview); }
  return preview;
}
function rowId(old: number | null, next: number | null): string { return `line:${old ?? ''}:${next ?? ''}`; }
function unifiedLine(line: DiffLine, changeId?: string): DiffViewLine {
  return { kind: line.kind, left: line.text, old: line.oldLine, next: line.newLine, sign: line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '−' : ' ', id: rowId(line.oldLine, line.newLine), changeId };
}
function pairedLine(pair: SplitLine, changeId?: string): DiffViewLine {
  const old = pair.left?.oldLine ?? null, next = pair.right?.newLine ?? null;
  return { kind: pair.left?.kind === 'meta' || pair.right?.kind === 'meta' ? 'meta' : 'split-line', left: pair.left?.text ?? '', right: pair.right?.text ?? '', old, next, sign: `${pair.left?.kind === 'deletion' ? '-' : ' '}${pair.right?.kind === 'addition' ? '+' : ' '}`, id: rowId(old, next), changeId };
}

/** Project bounded semantic blocks. Full text only fills gaps after an explicit, successful two-side read. */
export function projectDiff(document: DiffDocument, split: boolean, options: DiffProjectionOptions = {}): DiffRows {
  const lines: DiffViewLine[] = [], changes: DiffChangeRange[] = [], limit = Math.max(0, options.maxLines ?? MAX_DIFF_LINES);
  let limited = document.limited;
  const expanding = options.showUnchanged || Boolean(options.expandedGaps?.size);
  const old = expanding ? contextPreview(options.oldContent) : undefined, next = expanding ? contextPreview(options.newContent) : undefined;
  const complete = old && next && !old.limited && !next.limited && !document.limited;
  const push = (line: DiffViewLine): boolean => { if (lines.length >= limit) { limited = true; return false; } lines.push(line); return true; };
  for (const section of document.sections) {
    if (section.kind === 'change') {
      const first = lines.length;
      if (!push({ kind: 'change', id: section.id, changeId: section.id, left: `@@ -${section.oldStart},${section.oldCount} +${section.newStart},${section.newCount} @@`, old: null, next: null })) break;
      if (split) {
        for (const pair of splitLines(section.lines)) if (!push(pairedLine(pair, section.id))) break;
      } else {
        for (const line of section.lines) if (!push(unifiedLine(line, section.id))) break;
      }
      changes.push({ id: section.id, first, last: lines.length });
    } else {
      const expanded = Boolean(options.showUnchanged || options.expandedGaps?.has(section.id));
      const oldEnd = section.oldEnd ?? (complete ? old.lines.length + 1 : null), newEnd = section.newEnd ?? (complete ? next.lines.length + 1 : null);
      const oldCount = oldEnd === null ? null : oldEnd - section.oldStart, newCount = newEnd === null ? null : newEnd - section.newStart;
      const count = oldCount !== null && oldCount === newCount && oldCount >= 0 ? oldCount : undefined;
      // A loaded empty tail is not a gap. Unknown tails are labelled as context, never as invented lines.
      if (complete && count === 0 && !section.lines.length) continue;
      if (!push({ kind: 'gap', id: section.id, gapId: section.id, left: '', old: null, next: null, gapCount: count, expanded })) break;
      if (!expanded) continue;
      let filled = false;
      if (complete && count !== undefined && oldEnd! <= old.lines.length + 1 && newEnd! <= next.lines.length + 1) {
        // Validate before emitting: a stale/inconsistent response cannot manufacture unchanged content.
        let valid = true;
        for (let index = 0; index < count; index++) if (old.lines[section.oldStart + index - 1] !== next.lines[section.newStart + index - 1]) { valid = false; break; }
        if (valid) {
          filled = true;
          for (let index = 0; index < count; index++) {
            const oldLine = section.oldStart + index, newLine = section.newStart + index;
            if (!push({ kind: split ? 'split-line' : 'context', id: rowId(oldLine, newLine), gapId: section.id, left: old.lines[oldLine - 1], right: split ? next.lines[newLine - 1] : undefined, old: oldLine, next: newLine, sign: split ? '  ' : ' ' })) break;
          }
        }
      }
      if (!filled) {
        for (const line of section.lines) {
          const row = split ? pairedLine({ left: line, right: line }) : unifiedLine(line); row.gapId = section.id;
          if (!push(row)) break;
        }
        const status = options.contextStatus ?? (document.limited || options.oldContent?.truncated || options.newContent?.truncated || old?.limited || next?.limited ? 'limited' : 'unavailable');
        if (!push({ kind: 'gap-status', id: `${section.id}:status`, gapId: section.id, left: '', old: null, next: null, gapStatus: status })) break;
      }
    }
    if (lines.length >= limit) { limited = true; break; }
  }
  return { lines, changes, limited, hunkCount: 0, document };
}

/** Mutable measured row heights with O(log n) prefix offsets and viewport lookup.
 * Only the active projection owns one index; no DOM nodes or unbounded width variants are cached.
 */
export class DiffRowLayout {
  private heights: Float64Array;
  private prefix: Float64Array;
  constructor(heights: ArrayLike<number>) {
    this.heights = Float64Array.from(heights, height => Math.max(1, height));
    this.prefix = new Float64Array(this.heights.length + 1);
    for (let index = 1; index < this.prefix.length; index++) {
      this.prefix[index] += this.heights[index - 1];
      const parent = index + (index & -index);
      if (parent < this.prefix.length) this.prefix[parent] += this.prefix[index];
    }
  }
  get length(): number { return this.heights.length; }
  get height(): number { return this.offsetAt(this.length); }
  heightAt(index: number): number { return this.heights[index] ?? 0; }
  offsetAt(index: number): number {
    let total = 0;
    for (let current = Math.min(this.length, Math.max(0, Math.floor(index))); current > 0; current -= current & -current) total += this.prefix[current];
    return total;
  }
  /** Returns length at/after the end; exact row boundaries belong to the following row. */
  indexAt(offset: number): number {
    let index = 0, sum = 0, step = 2 ** Math.floor(Math.log2(Math.max(1, this.length)));
    for (; step >= 1; step = Math.floor(step / 2)) {
      const next = index + step;
      if (next <= this.length && sum + this.prefix[next] <= Math.max(0, offset)) { index = next; sum += this.prefix[next]; }
    }
    return index;
  }
  measure(index: number, height: number): boolean {
    if (index < 0 || index >= this.length || !Number.isFinite(height) || height <= 0) return false;
    const next = Math.max(1, height), delta = next - this.heights[index];
    if (Math.abs(delta) < .5) return false;
    this.heights[index] = next;
    for (let current = index + 1; current < this.prefix.length; current += current & -current) this.prefix[current] += delta;
    return true;
  }
}

/** The closed interval is deliberate: a block flush against either viewport edge is already visible. */
export function minimalDiffScrollTop(scrollTop: number, viewportHeight: number, top: number, bottom: number, lineHeight = 20): number {
  if (viewportHeight <= 0 || (top >= scrollTop && bottom <= scrollTop + viewportHeight)) return scrollTop;
  const revealBottom = bottom - top > viewportHeight ? Math.min(bottom, top + Math.min(viewportHeight, lineHeight * 4)) : bottom;
  if (top < scrollTop) return Math.max(0, top);
  if (revealBottom > scrollTop + viewportHeight) return Math.max(0, revealBottom - viewportHeight);
  return scrollTop;
}

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
      const document = diffDocument(parsed); document.limited ||= result.truncated;
      bytes += document.sections.length * 160 + document.changes.reduce((size, change) => size + change.lines.length * 8, 0);
      model = { parsed, document, bytes };
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
    const rows: DiffRows = { lines, limited, hunkCount: model.parsed.hunks.length, document: model.document };
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

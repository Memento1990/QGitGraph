import type { AppSettings, Commit, GitRef, HistoryScope } from '../shared/protocol';
import { getLocale, isLocalizedMessage, localized, resolveText, type Locale, type LocalizedMessage } from './i18n';
import { m as common } from '../i18n/common';
import { m as scopeMessage } from '../i18n/scope';
import { ERROR_CODES, m as errorSummary, type KnownErrorCode } from '../i18n/errors';

export function shortOid(oid: string, length = 8): string { return oid.slice(0, length); }
/** Only complete SHA-1/SHA-256 object names are immutable. Refs, abbreviations and worktree tokens are not. */
export function isImmutableOid(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value);
}
export function dateValue(value: number): Date { return new Date(Math.abs(value) < 100_000_000_000 ? value * 1000 : value); }
const relativeTimes = new Map<Locale, Intl.RelativeTimeFormat>();
const localDates = new Map<string, Intl.DateTimeFormat>();
const numbers = new Map<string, Intl.NumberFormat>();
function localDateFormat(mode: 'date' | 'local' | 'full', locale: Locale): Intl.DateTimeFormat {
  const key = `${locale}:${mode}`;
  let formatter = localDates.get(key);
  if (!formatter) { formatter = new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit', ...(mode !== 'date' ? { hour: '2-digit', minute: '2-digit', ...(mode === 'full' ? { second: '2-digit' } as const : {}) } as const : {}) }); localDates.set(key, formatter); }
  return formatter;
}
function relativeFormat(locale: Locale): Intl.RelativeTimeFormat {
  let formatter = relativeTimes.get(locale);
  if (!formatter) { formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }); relativeTimes.set(locale, formatter); }
  return formatter;
}
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}, locale: Locale = getLocale()): string {
  const key = `${locale}:${JSON.stringify(Object.entries(options).sort(([a], [b]) => a.localeCompare(b)))}`;
  let formatter = numbers.get(key);
  if (!formatter) { formatter = new Intl.NumberFormat(locale, options); if (numbers.size >= 64) numbers.delete(numbers.keys().next().value!); numbers.set(key, formatter); }
  return formatter.format(value);
}
export function numberText(value: number, options?: Intl.NumberFormatOptions): LocalizedMessage { return localized(locale => formatNumber(value, options, locale)); }
export function formatFullDate(value: number, locale: Locale = getLocale()): string {
  const date = dateValue(value); return Number.isFinite(date.getTime()) ? localDateFormat('full', locale).format(date) : '—';
}
export function fullDateText(value: number): LocalizedMessage { return localized(locale => formatFullDate(value, locale)); }
export function dateText(value: number, mode: AppSettings['dateFormat'], now?: number): LocalizedMessage { return localized(locale => formatDate(value, mode, now, locale)); }
export function formatDate(value: number, mode: AppSettings['dateFormat'], now = Date.now(), locale: Locale = getLocale()): string {
  const date = dateValue(value);
  if (!Number.isFinite(date.getTime())) return '—';
  if (mode === 'iso') return date.toISOString().replace('T', ' ').slice(0, 19);
  if (mode === 'iso-date') return date.toISOString().slice(0, 10);
  if (mode === 'date' || mode === 'local') return localDateFormat(mode, locale).format(date);
  const relativeTime = relativeFormat(locale);
  const seconds = Math.round((date.getTime() - now) / 1000);
  if (Math.abs(seconds) < 60) return relativeTime.format(seconds, 'second');
  if (Math.abs(seconds) < 3600) return relativeTime.format(Math.round(seconds / 60), 'minute');
  if (Math.abs(seconds) < 86400) return relativeTime.format(Math.round(seconds / 3600), 'hour');
  if (Math.abs(seconds) < 86400 * 30) return relativeTime.format(Math.round(seconds / 86400), 'day');
  if (Math.abs(seconds) < 86400 * 365) return relativeTime.format(Math.round(seconds / (86400 * 30)), 'month');
  return relativeTime.format(Math.round(seconds / (86400 * 365)), 'year');
}
export function commitDate(commit: Pick<Commit, 'authoredAt' | 'committedAt'>, source: AppSettings['dateSource']): number {
  return source === 'committer' ? commit.committedAt : commit.authoredAt;
}
/** Preserve the complete original diagnostic. Only precise machine codes select translated summaries. */
export function errorText(error: unknown): LocalizedMessage {
  return localized(locale => {
    if (error && typeof error === 'object' && 'localizedMessage' in error && isLocalizedMessage(error.localizedMessage)) return resolveText(error.localizedMessage, locale);
    let raw = '';
    if (typeof error === 'string') raw = error;
    else if (error && typeof error === 'object' && 'message' in error) raw = String(error.message) + ('detail' in error && error.detail ? `\n${String(error.detail)}` : '');
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
    if ((ERROR_CODES as readonly string[]).includes(code)) {
      const summary = resolveText(errorSummary(code as KnownErrorCode), locale);
      return raw && raw !== summary ? `${summary}\n${raw}` : summary;
    }
    return raw || resolveText(common('operationFailed'), locale);
  });
}
export function errorMessage(error: unknown): string { return resolveText(errorText(error)); }
export function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

export type SearchMode = 'all' | 'message' | 'author' | 'hash' | 'date' | 'refs';
export interface CommitFilter {
  text: string; mode: SearchMode; author?: string; hash?: string; refs?: string;
  after?: string; before?: string; dateSource?: AppSettings['dateSource'];
}
export function matchesCommit(commit: Commit, filter: CommitFilter): boolean {
  const query = filter.text.trim();
  if (!query && !filter.author && !filter.hash && !filter.refs && !filter.after && !filter.before) return true;
  const includes = (value: string, text: string | undefined): boolean => !text || value.toLocaleLowerCase().includes(text.toLocaleLowerCase());
  let refs: string | undefined;
  const refText = (): string => refs ??= commit.refs.map(ref => `${ref.name} ${ref.fullName}`).join(' ');
  if ((filter.author && !includes(`${commit.author} ${commit.email}`, filter.author)) || (filter.hash && !includes(commit.oid, filter.hash)) || (filter.refs && !includes(refText(), filter.refs))) return false;
  let date: Date | undefined;
  const commitDay = (): Date => date ??= dateValue(commitDate(commit, filter.dateSource ?? 'author'));
  if (filter.after || filter.before) {
    const timestamp = commitDay().getTime();
    const after = filter.after ? new Date(`${filter.after}T00:00:00`).getTime() : NaN;
    const before = filter.before ? new Date(`${filter.before}T23:59:59.999`).getTime() : NaN;
    if (Number.isFinite(after) && (!Number.isFinite(timestamp) || timestamp < after)) return false;
    if (Number.isFinite(before) && (!Number.isFinite(timestamp) || timestamp > before)) return false;
  }
  if (!query) return true;
  switch (filter.mode) {
    case 'message': return includes(commit.subject, query);
    case 'author': return includes(`${commit.author} ${commit.email}`, query);
    case 'hash': return includes(commit.oid, query);
    case 'refs': return includes(refText(), query);
    case 'date': return includes(Number.isFinite(commitDay().getTime()) ? commitDay().toISOString().slice(0, 10) : '', query);
    default: {
      const dateText = Number.isFinite(commitDay().getTime()) ? commitDay().toISOString().slice(0, 10) : '';
      return includes(`${commit.oid} ${commit.subject} ${commit.author} ${commit.email} ${refText()} ${dateText}`, query);
    }
  }
}

/** Ref searches retain every match, rather than arbitrarily choosing a single branch. */
export function matchingRefs(refs: readonly GitRef[], query: string): string[] {
  const text = query.trim().toLocaleLowerCase();
  return [...new Set(refs.filter(ref => `${ref.name} ${ref.fullName}`.toLocaleLowerCase().includes(text)).map(ref => ref.fullName))];
}
export function scopeText(scope: HistoryScope): LocalizedMessage {
  switch (scope.kind) {
    case 'all': return scopeMessage('all');
    case 'head': return scopeMessage('head');
    case 'refs': return scope.refs?.length === 1 ? localized(() => scope.refs![0].replace(/^refs\/(heads|remotes|tags)\//, '')) : scopeMessage('selectedRefs', { count: numberText(scope.refs?.length ?? 0) });
    case 'glob': return scope.exclude?.length ? scopeMessage('except', { include: scope.include?.join(', ') || '*', exclude: scope.exclude.join(', ') }) : localized(() => scope.include?.join(', ') || '*');
  }
}
export function scopeLabel(scope: HistoryScope): string { return resolveText(scopeText(scope)); }

/** Conservative in-memory weight, including UTF-16 text. No repository content is persisted. */
export function valueBytes(value: unknown): number {
  if (typeof value === 'string') return value.length * 2;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try { return (JSON.stringify(value)?.length ?? 0) * 2; } catch { return 1024; }
}
/** Both entry and byte limits are enforced. Oversized values are deliberately not retained. */
export class LruCache<T> {
  private values = new Map<string, { value: T; bytes: number }>();
  private usedBytes = 0;
  constructor(private readonly limit: number, private readonly byteLimit = 16 * 1024 * 1024, private readonly measure: (value: T) => number = valueBytes) {}
  get size(): number { return this.values.size; }
  get bytes(): number { return this.usedBytes; }
  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (entry) { this.values.delete(key); this.values.set(key, entry); }
    return entry?.value;
  }
  set(key: string, value: T): void {
    this.delete(key);
    const measured = this.measure(value);
    const bytes = key.length * 2 + (Number.isFinite(measured) ? Math.max(0, measured) : this.byteLimit + 1);
    if (this.limit <= 0 || bytes > this.byteLimit) return;
    this.values.set(key, { value, bytes }); this.usedBytes += bytes;
    while (this.values.size > this.limit || this.usedBytes > this.byteLimit) this.delete(this.values.keys().next().value!);
  }
  delete(key: string): boolean {
    const old = this.values.get(key);
    if (!old) return false;
    this.usedBytes -= old.bytes; return this.values.delete(key);
  }
  clear(): void { this.values.clear(); this.usedBytes = 0; }
}

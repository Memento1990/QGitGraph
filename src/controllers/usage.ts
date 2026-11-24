export type UsageSource = 'userusage' | 'assistant' | 'automated-test';
export type UsageBoundary = 'pause' | 'resume' | 'stop';
export interface UsageRuntime {
  appVersion: string; sourceBuild: string; sourceBuildReliable: boolean; exeSha256: string;
}
export interface UsageStatus {
  phase: 'idle' | 'recording' | 'paused' | 'stopped' | 'error';
  sessionId: string | null; source: UsageSource | null; build: string; runtime: UsageRuntime;
  eventCount: number; bytes: number; totalBytes: number; sessionCount: number;
  limits: { sessionBytes: number; globalBytes: number; sessionCount: number };
  errorCode: string | null;
}
export interface UsageStart { source: UsageSource; taskIds?: string[] }
export interface UsageEventInput {
  taskIds: string[]; scenarioId: string; actionId: string; resultCode: string;
  /** Static instrumentation uses the controller's call-time timestamp, not delayed persistence time. */
  occurredAt?: string; durationMs?: number; repoId?: string;
  counts?: Partial<Record<'selected' | 'files' | 'staged' | 'unstaged' | 'untracked' | 'commits' | 'conflicts' | 'changed' | 'total', number>>;
  state?: {
    theme?: 'dark' | 'light'; viewport?: 'wide' | 'narrow';
    status?: 'todo' | 'ready' | 'inprogress' | 'readyforusage' | 'done' | 'blocked' | 'archived';
    phase?: 'idle' | 'preview' | 'running' | 'success' | 'failed' | 'cancelled' | 'blocked';
    trusted?: boolean; busy?: boolean; cancelled?: boolean;
  };
  errorCode?: string;
}
/** Optional on Host: browser/demo hosts must not pretend to save native usage. No path or HTTP API. */
export interface UsageHost {
  usageStatus?(): Promise<UsageStatus>;
  usageStart?(input: UsageStart): Promise<UsageStatus>;
  usageBoundary?(boundary: UsageBoundary): Promise<UsageStatus>;
  usageAppend?(event: UsageEventInput): Promise<UsageStatus>;
}
export const USAGE_ERROR_CODES = ['CANCELLED', 'USER_CANCELLED', 'GIT_FAILED', 'IO', 'ACCESS_DENIED', 'NOT_TRUSTED', 'TRUST_REQUIRED', 'TRUST_REVOKED', 'STALE_TARGET', 'INVALID_INPUT', 'NOT_FOUND', 'CONFLICT', 'TIMEOUT', 'UNAVAILABLE', 'DESKTOP_REQUIRED', 'USAGE_FULL', 'USAGE_WRITE_FAILED', 'UNKNOWN_ERROR'] as const;
const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const taskId = /^QG-(?:\d{3}|[A-Z][A-Z0-9-]{0,63})$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value: unknown, allowed: string[]): value is Record<string, unknown> { return object(value) && Object.keys(value).every((key) => allowed.includes(key)); }
function validTasks(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 100 && value.every((id) => typeof id === 'string' && taskId.test(id)) && new Set(value).size === value.length; }
/** Reject unknown fields before IPC; backend repeats validation. Callers supply static action/scenario/result IDs only. */
export function validUsageEvent(value: unknown): value is UsageEventInput {
  if (!keys(value, ['taskIds', 'scenarioId', 'actionId', 'resultCode', 'occurredAt', 'durationMs', 'repoId', 'counts', 'state', 'errorCode']) || !validTasks(value.taskIds)) return false;
  if (!['scenarioId', 'actionId', 'resultCode'].every((key) => typeof value[key] === 'string' && identifier.test(value[key] as string))) return false;
  if (value.occurredAt !== undefined && (typeof value.occurredAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.occurredAt) || !Number.isFinite(Date.parse(value.occurredAt)))) return false;
  if (value.repoId !== undefined && (typeof value.repoId !== 'string' || !/^r-[a-f0-9]{32}$/.test(value.repoId))) return false;
  if (value.errorCode !== undefined && !USAGE_ERROR_CODES.includes(value.errorCode as typeof USAGE_ERROR_CODES[number])) return false;
  if (value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs) || (value.durationMs as number) < 0 || (value.durationMs as number) > 86400000)) return false;
  if (value.counts !== undefined && (!keys(value.counts, ['selected', 'files', 'staged', 'unstaged', 'untracked', 'commits', 'conflicts', 'changed', 'total']) || !Object.values(value.counts).every((count) => Number.isSafeInteger(count) && (count as number) >= 0 && (count as number) <= 1e9))) return false;
  if (value.state !== undefined) {
    if (!keys(value.state, ['theme', 'viewport', 'status', 'phase', 'trusted', 'busy', 'cancelled'])) return false;
    for (const [key, state] of Object.entries(value.state)) {
      if (['trusted', 'busy', 'cancelled'].includes(key)) { if (typeof state !== 'boolean') return false; }
      else if (!({ theme: ['dark', 'light'], viewport: ['wide', 'narrow'], status: ['todo', 'ready', 'inprogress', 'readyforusage', 'done', 'blocked', 'archived'], phase: ['idle', 'preview', 'running', 'success', 'failed', 'cancelled', 'blocked'] } as Record<string, unknown[]>)[key]?.includes(state)) return false;
    }
  }
  return true;
}
export function usageErrorCategory(error: unknown): string {
  const code = object(error) && typeof error.code === 'string' ? error.code : '';
  return USAGE_ERROR_CODES.includes(code as typeof USAGE_ERROR_CODES[number]) ? code : 'UNKNOWN_ERROR';
}
export interface UsageView { status: UsageStatus | null; busy: boolean; errorCode: string | null; supported: boolean }
/** One instance per application Host. No auto-start, background uploads, file readers, retry queue or localStorage. */
export class UsageController {
  private current: UsageStatus | null = null;
  private pending = 0;
  private failure: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<(view: UsageView) => void>();
  private repositories = new Map<string, string>();
  constructor(private host: UsageHost) {}
  get supported(): boolean { return !!(this.host.usageStatus && this.host.usageStart && this.host.usageBoundary && this.host.usageAppend); }
  get view(): UsageView { return { status: this.current ? structuredClone(this.current) : null, busy: this.pending > 0, errorCode: this.failure ?? this.current?.errorCode ?? null, supported: this.supported }; }
  subscribe(listener: (view: UsageView) => void): () => void { this.listeners.add(listener); listener(this.view); return () => this.listeners.delete(listener); }
  private publish(): void { for (const listener of this.listeners) listener(this.view); }
  private accept(status: UsageStatus): void {
    if (status.sessionId !== this.current?.sessionId) this.repositories.clear();
    this.current = structuredClone(status); this.failure = status.errorCode;
  }
  private async queue(operation: () => Promise<UsageStatus | null>): Promise<boolean> {
    if (!this.supported) { this.failure = 'DESKTOP_REQUIRED'; this.publish(); return false; }
    // Bounded in-memory work only; recording never retains business payloads while storage is failing.
    if (this.pending >= 100) { this.failure = 'USAGE_QUEUE_FULL'; this.publish(); return false; }
    this.pending++; this.publish();
    const run = this.tail.then(async () => {
      try { const status = await operation(); if (!status) return false; this.accept(status); return true; }
      catch (error) {
        // Do not display/log arbitrary backend error messages (which may contain private paths/content).
        const category = object(error) && typeof error.code === 'string' && ['USAGE_FULL', 'USAGE_WRITE_FAILED', 'USAGE_EXTERNAL_CHANGE', 'USAGE_STORAGE_INVALID', 'USAGE_SESSION_ACTIVE', 'USAGE_INVALID_TRANSITION', 'INVALID_USAGE_INPUT', 'USAGE_NOT_RECORDING', 'USAGE_CLOCK_INVALID'].includes(error.code) ? error.code : 'USAGE_WRITE_FAILED';
        try { if (this.host.usageStatus) this.accept(await this.host.usageStatus()); }
        catch { if (this.current) this.current = { ...this.current, phase: 'error' }; }
        this.failure = category; return false;
      } finally { this.pending--; this.publish(); }
    });
    this.tail = run; return run;
  }
  refresh(): Promise<boolean> { return this.queue(() => this.host.usageStatus!()); }
  start(source: UsageSource, taskIds: string[] = []): Promise<boolean> {
    if (!['userusage', 'assistant', 'automated-test'].includes(source) || !validTasks(taskIds)) { this.failure = 'INVALID_USAGE_INPUT'; this.publish(); return Promise.resolve(false); }
    const input: UsageStart = { source, taskIds: [...taskIds] };
    return this.queue(() => this.host.usageStart!(input));
  }
  boundary(boundary: UsageBoundary): Promise<boolean> {
    if (!['pause', 'resume', 'stop'].includes(boundary)) return Promise.resolve(false);
    return this.queue(() => this.host.usageBoundary!(boundary));
  }
  record(event: UsageEventInput): Promise<boolean> {
    if (!validUsageEvent(event)) { this.failure = 'INVALID_USAGE_INPUT'; this.publish(); return Promise.resolve(false); }
    if (this.current?.phase !== 'recording' || this.failure) return Promise.resolve(false);
    const payload = { ...structuredClone(event), occurredAt: new Date().toISOString() }, sessionId = this.current.sessionId;
    return this.queue(() => this.current?.phase === 'recording' && this.current.sessionId === sessionId && !this.failure ? this.host.usageAppend!(payload) : Promise.resolve(null));
  }
  /** Input is an opaque in-memory repository ID, never sent/stored; token changes for each session. */
  anonymousRepo(opaqueId: string): string | undefined {
    if (!this.current?.sessionId || this.current.phase !== 'recording') return undefined;
    let token = this.repositories.get(opaqueId);
    if (!token) {
      const bytes = new Uint8Array(16); globalThis.crypto.getRandomValues(bytes);
      token = `r-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
      this.repositories.set(opaqueId, token);
    }
    return token;
  }
}
const controllers = new WeakMap<UsageHost, UsageController>();
export function createUsageController(host: UsageHost): UsageController {
  let controller = controllers.get(host);
  if (!controller) { controller = new UsageController(host); controllers.set(host, controller); }
  return controller;
}

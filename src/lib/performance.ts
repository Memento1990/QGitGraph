import type { NativePerformanceData, NativePerformanceSpan } from '../shared/protocol';

export const PERFORMANCE_CAPACITY = 2000;
export type PerformanceOutcome = 'ok' | 'error' | 'cancelled' | 'stale' | 'reused';
/** Deliberately no free-form metadata, paths, messages, URLs, or argument objects. */
export interface PerformanceFields {
  requestId?: string; oid?: string; cacheHit?: boolean; count?: number; renderedCount?: number;
  outcome?: PerformanceOutcome;
}
export interface PerformanceContext { operationId: string; rootOperationId: string; parentOperationId?: string }
export interface PerformanceSpanData extends PerformanceContext, PerformanceFields {
  id: number; sequence: number; kind: string; phase: string; startedAt: number; durationMs: number;
}
export interface ActivePerformanceSpan extends Omit<PerformanceSpanData, 'sequence' | 'durationMs'> { elapsedMs: number }
export interface PerformanceDump {
  schemaVersion: 1; enabled: boolean; capacity: number; sequence: number; dropped: number;
  spans: PerformanceSpanData[]; active: ActivePerformanceSpan[]; native?: NativePerformanceData;
}
export interface PerformanceSpan { end(fields?: PerformanceFields): void }
export interface PerformanceOperation extends PerformanceSpan {
  readonly context: PerformanceContext | undefined;
  run<T>(callback: () => T): T;
  request(requestId: string): void;
  span(phase: string, fields?: PerformanceFields): PerformanceSpan;
  paint(phase: string, fields?: PerformanceFields): void;
}
interface ActiveEntry { data: Omit<PerformanceSpanData, 'sequence' | 'durationMs'> }
const noopSpan: PerformanceSpan = Object.freeze({ end: () => {} });
const noopOperation: PerformanceOperation = Object.freeze({
  context: undefined, end: () => {}, run: <T>(callback: () => T): T => callback(), request: () => {}, span: () => noopSpan, paint: () => {},
});
const token = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[a-zA-Z0-9_.:-]+$/.test(value);
function fields(value: PerformanceFields = {}): PerformanceFields {
  const result: PerformanceFields = {};
  if (token(value.requestId)) result.requestId = value.requestId;
  if (typeof value.oid === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.oid)) result.oid = value.oid;
  if (typeof value.cacheHit === 'boolean') result.cacheHit = value.cacheHit;
  for (const key of ['count', 'renderedCount'] as const) if (typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key]! >= 0) result[key] = value[key];
  if (['ok', 'error', 'cancelled', 'stale', 'reused'].includes(value.outcome ?? '')) result.outcome = value.outcome;
  return result;
}

/** Pure bounded recorder; the injectable monotonic clock/frame scheduler also make unit tests deterministic. */
export class PerformanceRecorder {
  private enabled = false;
  private nextId = 0;
  private nextOperation = 0;
  private sequence = 0;
  private dropped = 0;
  private ring: (PerformanceSpanData | undefined)[] = new Array(PERFORMANCE_CAPACITY);
  private size = 0;
  private cursor = 0;
  private active = new Map<number, ActiveEntry>();
  private requests = new Map<string, PerformanceContext>();
  private currentContext: PerformanceContext | undefined;
  private native: NativePerformanceData | undefined;
  private nativeFloor = 0;
  constructor(private readonly now: () => number = () => performance.now(), private readonly frame: (callback: () => void) => void = callback => { requestAnimationFrame(callback); }) {}
  get isEnabled(): boolean { return this.enabled; }
  enable(): void { this.enabled = true; }
  context(requestId?: string): PerformanceContext | undefined { return requestId ? this.requests.get(requestId) ?? this.currentContext : this.currentContext; }
  run<T>(context: PerformanceContext | undefined, callback: () => T): T {
    if (!this.enabled || !context) return callback();
    const previous = this.currentContext; this.currentContext = context;
    try { return callback(); } finally { this.currentContext = previous; }
  }
  private begin(kind: string, phase: string, context?: PerformanceContext, value?: PerformanceFields, startedAt?: number): PerformanceSpan {
    if (!this.enabled) return noopSpan;
    if (this.active.size >= PERFORMANCE_CAPACITY || !token(kind) || !token(phase)) { this.dropped++; return noopSpan; }
    const id = ++this.nextId;
    const identity = context ?? { operationId: `span-${id}`, rootOperationId: `span-${id}` };
    const data = { id, ...identity, kind, phase, startedAt: startedAt ?? this.now(), ...fields(value) };
    this.active.set(id, { data });
    return { end: extra => {
      if (!this.active.delete(id)) return;
      const span = { ...data, ...fields(extra), sequence: ++this.sequence, durationMs: Math.max(0, this.now() - data.startedAt) };
      if (this.size === PERFORMANCE_CAPACITY) this.dropped++; else this.size++;
      this.ring[this.cursor] = span; this.cursor = (this.cursor + 1) % PERFORMANCE_CAPACITY;
    } };
  }
  span(kind: string, phase: string, value?: PerformanceFields, context = this.currentContext): PerformanceSpan { return this.begin(kind, phase, context, value); }
  operation(kind: string, value?: PerformanceFields, parent = this.currentContext): PerformanceOperation {
    if (!this.enabled) return noopOperation;
    const operationId = `op-${++this.nextOperation}`;
    const context: PerformanceContext = { operationId, rootOperationId: parent?.rootOperationId ?? operationId, ...(parent ? { parentOperationId: parent.operationId } : {}) };
    const startedAt = this.now(), root = this.begin(kind, 'operation', context, value, startedAt);
    // This span starts at handler origin, not at scheduling time. Double-rAF is a paint opportunity, never physical-paint telemetry.
    const paint = this.begin(kind, 'paint-opportunity', context, value, startedAt);
    const registered: string[] = []; let ended = false;
    const schedulePaint = (span: PerformanceSpan, extra?: PerformanceFields): void => {
      try { this.frame(() => { try { this.frame(() => span.end(extra)); } catch { span.end({ ...extra, outcome: 'error' }); } }); }
      catch { span.end({ ...extra, outcome: 'error' }); }
    };
    return {
      context,
      run: callback => this.run(context, callback),
      request: requestId => { if (token(requestId) && this.requests.size < PERFORMANCE_CAPACITY) { this.requests.set(requestId, context); registered.push(requestId); } },
      span: (phase, extra) => this.begin(kind, phase, context, extra),
      paint: (phase, extra) => schedulePaint(this.begin(kind, phase, context, extra, startedAt), extra),
      end: extra => {
        if (ended) return; ended = true;
        for (const id of registered) if (this.requests.get(id) === context) this.requests.delete(id);
        root.end(extra); schedulePaint(paint, extra);
      },
    };
  }
  setNative(data: NativePerformanceData): void {
    if (!this.enabled || !data.enabled) return;
    // Native data is a fixed typed diagnostic schema, never command results or arbitrary host data.
    this.native = { ...data, spans: data.spans.filter(span => span.sequence > this.nativeFloor).slice(-PERFORMANCE_CAPACITY).map(span => ({ ...span })), active: data.active.slice(-PERFORMANCE_CAPACITY).map(span => ({ ...span })) };
  }
  read(): PerformanceDump {
    const spans: PerformanceSpanData[] = [];
    for (let index = 0; index < this.size; index++) spans.push({ ...this.ring[(this.cursor - this.size + index + PERFORMANCE_CAPACITY) % PERFORMANCE_CAPACITY]! });
    const now = this.enabled ? this.now() : 0;
    return { schemaVersion: 1, enabled: this.enabled, capacity: PERFORMANCE_CAPACITY, sequence: this.sequence, dropped: this.dropped, spans,
      active: [...this.active.values()].map(({ data }) => ({ ...data, elapsedMs: Math.max(0, now - data.startedAt) })),
      ...(this.native ? { native: { ...this.native, spans: this.native.spans.map((span: NativePerformanceSpan) => ({ ...span })), active: this.native.active.map(span => ({ ...span })) } } : {}),
    };
  }
  pending(operationId?: string): number {
    let count = 0;
    for (const { data } of this.active.values()) if (!operationId || data.operationId === operationId || data.rootOperationId === operationId) count++;
    return count;
  }
  /** Reset completed diagnostics only. Active work, IDs and sequence remain intact for race-free sampling. */
  reset(): void {
    this.ring = new Array(PERFORMANCE_CAPACITY); this.cursor = 0; this.size = 0; this.dropped = 0;
    this.nativeFloor = this.native?.sequence ?? this.nativeFloor;
    if (this.native) this.native = { ...this.native, spans: [] };
  }
}

export const performanceDiagnostics = new PerformanceRecorder();
export interface PerformanceWindowDiagnostics {
  readonly read: () => PerformanceDump; readonly reset: () => void; readonly pending: (operationId?: string) => number;
}
declare global { interface Window { readonly __QGITGRAPH_PERFORMANCE__?: PerformanceWindowDiagnostics } }
/** No URL/local-storage switch and no host/invoke function is reachable through this diagnostic object. */
export function configurePerformance(enabled: boolean | undefined): void {
  if (enabled !== true) return;
  performanceDiagnostics.enable();
  if (typeof window !== 'undefined' && !Object.prototype.hasOwnProperty.call(window, '__QGITGRAPH_PERFORMANCE__')) {
    Object.defineProperty(window, '__QGITGRAPH_PERFORMANCE__', { value: Object.freeze({
      read: () => performanceDiagnostics.read(), reset: () => performanceDiagnostics.reset(), pending: (operationId?: string) => performanceDiagnostics.pending(operationId),
    }), writable: false, configurable: false, enumerable: false });
  }
}

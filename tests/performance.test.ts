import { describe, expect, it, vi } from 'vitest';
import { configurePerformance, PERFORMANCE_CAPACITY, PerformanceRecorder } from '../src/lib/performance';

function fixture() {
  let time = 0; const frames: (() => void)[] = [];
  const recorder = new PerformanceRecorder(() => time, callback => { frames.push(callback); });
  return { recorder, advance: (milliseconds: number) => { time += milliseconds; }, frame: () => { const current = frames.splice(0); for (const callback of current) callback(); }, frames };
}
describe('opt-in performance diagnostics', () => {
  it('is off by default without clock, frames or a diagnostic global', () => {
    const now = vi.fn(() => 0), frame = vi.fn(); const recorder = new PerformanceRecorder(now, frame);
    recorder.operation('history').end(); recorder.span('table', 'model').end();
    expect(recorder.read()).toMatchObject({ enabled: false, spans: [], active: [] });
    expect(now).not.toHaveBeenCalled(); expect(frame).not.toHaveBeenCalled();
    vi.stubGlobal('window', {});
    try { configurePerformance(false); expect('__QGITGRAPH_PERFORMANCE__' in window).toBe(false); } finally { vi.unstubAllGlobals(); }
  });
  it('measures handler origin through two animation frames, not driver or physical paint time', () => {
    const { recorder, advance, frame } = fixture(); recorder.enable();
    const operation = recorder.operation('commitSelection'); advance(20);
    const metadata = operation.span('metadata'); advance(30); metadata.end({ count: 12 }); operation.paint('file-list-paint-opportunity', { count: 12 });
    advance(100); operation.end();
    expect(recorder.read().spans.find(span => span.phase === 'operation')?.durationMs).toBe(150);
    expect(recorder.pending(operation.context!.operationId)).toBe(2);
    advance(16); frame(); expect(recorder.pending()).toBe(2);
    advance(16); frame(); expect(recorder.pending()).toBe(0);
    expect(recorder.read().spans.find(span => span.phase === 'paint-opportunity')?.durationMs).toBe(182);
    expect(recorder.read().spans.find(span => span.phase === 'file-list-paint-opportunity')?.count).toBe(12);
  });
  it('bounds the ring, returns detached data and preserves active work plus monotonic IDs across reset', () => {
    const { recorder, frame } = fixture(); recorder.enable(); const operation = recorder.operation('history');
    for (let index = 0; index < PERFORMANCE_CAPACITY + 7; index++) recorder.span('table', 'model', { count: index }).end();
    const snapshot = recorder.read(); expect(snapshot.spans).toHaveLength(PERFORMANCE_CAPACITY); expect(snapshot.dropped).toBe(7);
    snapshot.spans[0].kind = 'modified'; expect(recorder.read().spans[0].kind).toBe('table');
    recorder.reset(); expect(recorder.read().spans).toHaveLength(0); expect(recorder.pending()).toBe(2);
    operation.end(); operation.end(); frame(); frame();
    const final = recorder.read(); expect(final.sequence).toBe(snapshot.sequence + 2); expect(final.active).toHaveLength(0);
    expect(final.spans.every(span => span.id > 0)).toBe(true);
  });
  it('correlates explicit async resumes without leaking current context to concurrent operations', async () => {
    const { recorder } = fixture(); recorder.enable(); const parent = recorder.operation('openRepository');
    const child = recorder.operation('history', undefined, parent.context); child.request('ui-safe-1');
    child.run(() => expect(recorder.context('ui-safe-1')).toEqual(child.context));
    await Promise.resolve(); expect(recorder.context()).toBeUndefined();
    const other = recorder.operation('refresh'); expect(other.context?.rootOperationId).not.toBe(parent.context?.rootOperationId);
    recorder.span('ipc', 'get_history', { requestId: 'ui-safe-1' }, recorder.context('ui-safe-1')).end();
    expect(recorder.read().spans[0].operationId).toBe(child.context?.operationId);
    expect(recorder.pending(parent.context!.operationId)).toBe(4);
    child.end(); expect(recorder.context('ui-safe-1')).toBeUndefined();
  });
  it('allowlists safe fields and never serializes paths, output, subjects, arbitrary args or URLs', () => {
    const { recorder } = fixture(); recorder.enable();
    const unsafe = { requestId: 'C:/private/repo', oid: 'private subject', count: -1, path: 'private/path', args: ['secret'], url: 'https://private', body: 'secret', cacheHit: true };
    recorder.span('ipc', 'get_diff', unsafe).end();
    const data = recorder.read(); expect(data.spans[0]).not.toHaveProperty('requestId'); expect(data.spans[0]).not.toHaveProperty('oid'); expect(data.spans[0]).not.toHaveProperty('count');
    expect(data.spans[0].cacheHit).toBe(true); expect(JSON.stringify(data)).not.toContain('private'); expect(JSON.stringify(data)).not.toContain('secret');
  });
  it('exposes only frozen local read/reset/pending methods when enabled', () => {
    vi.stubGlobal('window', {});
    try {
      configurePerformance(true); const api = window.__QGITGRAPH_PERFORMANCE__!;
      expect(Object.keys(api).sort()).toEqual(['pending', 'read', 'reset']); expect(Object.isFrozen(api)).toBe(true);
      expect(Object.getOwnPropertyDescriptor(window, '__QGITGRAPH_PERFORMANCE__')).toMatchObject({ writable: false, configurable: false });
      expect(api.read().enabled).toBe(true); expect(api.pending()).toBe(0); api.reset();
    } finally { vi.unstubAllGlobals(); }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { defaultState } from '../src/shared/protocol';
import { effectiveSettings, mergeSettings, normalizeState, Requests, StateStore } from '../src/lib/state';

describe('local preferences', () => {
  it('merges default, global, repo and nested settings without losing columns', () => {
    const state = defaultState(); state.settings.theme = 'light';
    state.repoSettings.repo = { diffView: 'split', columnWidths: { graph: 220, date: 100, author: 130, commit: 90 } };
    const settings = effectiveSettings(state, 'repo');
    expect(settings.theme).toBe('light'); expect(settings.diffView).toBe('split'); expect(settings.columnWidths.graph).toBe(220); expect(settings.columns.author).toBe(true);
    expect(effectiveSettings(state, 'another').diffView).toBe('unified');
    const older = mergeSettings(state.settings, { columns: { date: false } } as unknown as Parameters<typeof mergeSettings>[1]);
    expect(older.columns).toEqual({ date: false, author: true, commit: true });
  });
  it('cleans review marks older than 90 days and bounds layout and row settings', () => {
    const state = defaultState(); const now = Date.now();
    state.reviews = [{ key: 'old', repoId: 'repo', paths: ['a.ts'], updatedAt: now - 91 * 86400 * 1000 }, { key: 'new', repoId: 'repo', paths: ['b.ts'], updatedAt: now }];
    state.settings.pageSize = 100_000; state.settings.rowHeight = 2; state.layout.detailSize = 100_000;
    const normalized = normalizeState(state, now);
    expect(normalized.reviews.map(review => review.key)).toEqual(['new']); expect(normalized.settings.pageSize).toBe(1000); expect(normalized.settings.rowHeight).toBe(22); expect(normalized.layout.detailSize).toBe(1200);
  });
  it('adds v2 layout defaults only when absent and keeps 0.3 language, scope and pane choices', () => {
    const fresh = { detailSize: 320, fileSize: 260, localWidth: 390, localListSize: 230, detailRatio: 0.55 };
    expect(defaultState().layout).toEqual(fresh); expect(normalizeState({ version: 2 }).layout).toEqual(fresh);
    const saved = { version: 2, settings: { language: 'zh-CN', startupScope: { kind: 'head' } },
      layout: { detailSize: 360, fileSize: 280 }, directoryScope: { root: 'D:/Projects', depth: 3, width: 180, collapsed: true, collapsedPaths: ['repo'] } };
    const state = normalizeState(saved);
    expect(state.version).toBe(2); expect(state.layout).toEqual({ ...fresh, detailSize: 360, fileSize: 280 });
    expect(state.settings).toMatchObject({ language: 'zh-CN', startupScope: { kind: 'head' }, localChangesPosition: 'middle' });
    expect(state.directoryScope).toEqual(saved.directoryScope); expect(normalizeState(state)).toEqual(state);
  });
  it('retains the existing legacy layout clamp and fractional pixel behavior', () => {
    expect(normalizeState({ layout: { detailSize: 100, fileSize: 100 } }).layout).toMatchObject({ detailSize: 140, fileSize: 150 });
    expect(normalizeState({ layout: { detailSize: 2000, fileSize: 2000 } }).layout).toMatchObject({ detailSize: 1200, fileSize: 700 });
    expect(normalizeState({ layout: { detailSize: 401.25, fileSize: 300.75 } }).layout).toMatchObject({ detailSize: 401.25, fileSize: 300.75 });
  });
  it('normalizes finite layout values and strips unknown layout data', () => {
    const state = normalizeState({ layout: { detailSize: 401.4, fileSize: 300.7, localWidth: 10000, localListSize: -1, detailRatio: 0.625, draft: 'private' } });
    expect(state.layout).toEqual({ detailSize: 401.4, fileSize: 300.7, localWidth: 960, localListSize: 100, detailRatio: 0.625 });
    for (const invalid of [NaN, Infinity, -Infinity, '500', null, {}]) {
      expect(normalizeState({ layout: { localWidth: invalid, localListSize: invalid, detailRatio: invalid } }).layout)
        .toMatchObject({ localWidth: 390, localListSize: 230, detailRatio: 0.55 });
    }
    expect(normalizeState({ layout: { detailRatio: 0.01 } }).layout.detailRatio).toBe(0.2);
    expect(normalizeState({ layout: { detailRatio: 9 } }).layout.detailRatio).toBe(0.8);
  });
  it('keeps review sessions isolated by repo and comparison and saves partial overrides', async () => {
    const save = vi.fn(async () => undefined); const store = new StateStore(save, () => undefined);
    store.review('commit:a', 'one', 'file.ts', true); store.review('commit:a', 'two', 'other.ts', true);
    expect([...store.reviewed('commit:a', 'one')]).toEqual(['file.ts']); expect([...store.reviewed('commit:b', 'one')]).toEqual([]);
    store.review('commit:a', 'one', 'file.ts', false); expect(store.reviewed('commit:a', 'one').size).toBe(0);
    store.updateSettings({ diffView: 'split' }, 'one');
    expect(store.state.repoSettings.one).toEqual({ diffView: 'split' }); expect(store.state.settings.diffView).toBe('unified');
    await store.flush(); expect(save).toHaveBeenCalledOnce();
  });
});

describe('cancellation and late response protection', () => {
  it('invalidates old work only in the same channel and requests backend cancellation', () => {
    const cancel = vi.fn(async () => undefined); const requests = new Requests(cancel);
    const first = requests.begin('history'); const detail = requests.begin('details'); const second = requests.begin('history');
    expect(first.current()).toBe(false); expect(second.current()).toBe(true); expect(detail.current()).toBe(true); expect(cancel).toHaveBeenCalledWith(first.id);
    first.finish(); expect(second.current()).toBe(true);
    requests.cancelAll(['details']); expect(second.current()).toBe(false); expect(detail.current()).toBe(true);
    detail.finish(); expect(detail.current()).toBe(false);
  });
});

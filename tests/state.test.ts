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

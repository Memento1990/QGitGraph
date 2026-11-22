import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, defaultState } from '../src/shared/protocol';
import { effectiveSettings, normalizeState, StateStore } from '../src/lib/state';
import { normalizeSettings, normalizeSettingsPatch, prepareConfigImport, validateIssuePattern, validateSettingsPatch, validateToolArgs } from '../src/lib/settings-schema';

const oid = '1'.repeat(40); const parent = '2'.repeat(40); const other = '3'.repeat(40);
afterEach(() => { vi.useRealTimers(); });

describe('v2 preference migration and schema', () => {
  it('migrates v1 independently of new defaults and preserves old explicit preferences', () => {
    const state = normalizeState({ version: 1, settings: { pageSize: 180, mailmap: true, theme: 'light', detailPosition: 'right', dateFormat: 'iso', showStashes: false, graphStyle: 'angular' }, repoSettings: { repo: { pageSize: 220, initialLoad: 420, columns: { date: false }, gitPath: 'untrusted.exe' } } });
    expect(state.version).toBe(2);
    expect(state.settings).toMatchObject({ pageSize: 180, initialLoad: 180, loadMore: 180, mailmap: true, theme: 'light', detailPosition: 'right', dateFormat: 'iso', showStashes: false, graphStyle: 'angular' });
    expect(state.repoSettings.repo).toMatchObject({ pageSize: 220, initialLoad: 420, loadMore: 220, columns: { date: false } });
    expect(state.repoSettings.repo).not.toHaveProperty('gitPath');
    expect(state.settings.dialogDefaults).toEqual(DEFAULT_SETTINGS.dialogDefaults);
  });
  it('does not turn a v2 legacy pageSize into new initial/load-more values', () => {
    const state = normalizeState({ version: 2, settings: { pageSize: 180, initialLoad: 320, loadMore: 80, detailPosition: 'inline', discoveryDepth: 0 } });
    expect(state.settings).toMatchObject({ pageSize: 180, initialLoad: 320, loadMore: 80, detailPosition: 'inline', discoveryDepth: 0 });
  });
  it('merges repository settings at leaves without capturing unrelated global preferences', async () => {
    const store = new StateStore(async () => undefined, () => undefined);
    store.updateSettings({ dialogDefaults: { tagPush: true }, shortcuts: { head: 'Alt+H' }, columnWidths: { author: 190 } }, 'repo');
    store.updateSettings({ dialogDefaults: { fetchPrune: true }, columns: { date: false } }, 'repo');
    store.updateSettings({ dialogDefaults: { resetMode: 'keep' }, shortcuts: { refresh: 'F5' } });
    const settings = effectiveSettings(store.state, 'repo');
    expect(settings.dialogDefaults).toMatchObject({ tagPush: true, fetchPrune: true, resetMode: 'keep', tagType: 'annotated' });
    expect(settings.shortcuts).toMatchObject({ find: 'Ctrl+F', head: 'Alt+H', refresh: 'F5' });
    expect(settings.columnWidths.author).toBe(190); expect(settings.columnWidths.graph).toBe(DEFAULT_SETTINGS.columnWidths.graph);
    expect(store.state.repoSettings.repo.dialogDefaults).toEqual({ tagPush: true, fetchPrune: true });
    await store.flush();
  });
  it('ignores repository git path overrides even if raw state bypassed migration', async () => {
    const store = new StateStore(async () => undefined, () => undefined); store.state.settings.gitPath = 'C:/Git/bin/git.exe';
    store.state.repoSettings.repo = { gitPath: 'C:/other/git.exe', theme: 'light' };
    expect(effectiveSettings(store.state, 'repo').gitPath).toBe('C:/Git/bin/git.exe');
    store.updateSettings({ gitPath: 'C:/bad/git.exe', columns: { author: false } }, 'another');
    expect(store.state.repoSettings.another).toEqual({ columns: { author: false } }); await store.flush();
  });
  it('keeps valid state when neighbors are malformed and strips unexpected fields', () => {
    const raw = JSON.parse('{"version":1,"settings":{"theme":"light","mailmap":"true","columns":{"date":false,"author":"yes"},"discoveryDepth":0,"__proto__":{"polluted":true}},"repoSettings":{"ok":{"diffView":"split"},"bad":7,"__proto__":{"theme":"light"}},"recent":[{"path":"D:/repo"},null],"trusted":["D:/repo",1],"layout":{"detailSize":999999}}');
    const state = normalizeState(raw);
    expect(state.settings.theme).toBe('light'); expect(state.settings.mailmap).toBe(DEFAULT_SETTINGS.mailmap);
    expect(state.settings.columns).toEqual({ date: false, author: true, commit: true });
    expect(state.repoSettings).toEqual({ ok: { diffView: 'split' } }); expect(state.recent).toEqual([{ path: 'D:/repo', name: 'repo' }]);
    expect(state.layout.detailSize).toBe(1200); expect(Object.prototype).not.toHaveProperty('polluted');
  });
  it('accepts every default and all nested leaf patches without mutation', () => {
    expect(validateSettingsPatch(DEFAULT_SETTINGS)).toEqual([]);
    const input = { dialogDefaults: { resetMode: 'soft' }, graphColors: ['#123', '#abcdef'], startupScope: { kind: 'glob', include: ['release/*'], exclude: [] } };
    const normalized = normalizeSettings(input);
    expect(normalized.dialogDefaults.resetMode).toBe('soft'); expect(normalized.dialogDefaults.tagType).toBe('annotated');
    normalized.graphColors.push('#aaa'); expect(input.graphColors).toEqual(['#123', '#abcdef']);
    expect(normalizeSettingsPatch({ discoveryDepth: 0 })).toEqual({ discoveryDepth: 0 });
  });
  it('validates scalar types, URL schemes, colors, tools and bounded safe issue patterns', () => {
    expect(validateSettingsPatch({ showTags: 'yes', loadMore: NaN, theme: 'sepia', graphColors: ['red'], dialogDefaults: { resetMode: 'force' } }).map(issue => issue.path)).toEqual(expect.arrayContaining(['showTags', 'loadMore', 'theme', 'graphColors', 'dialogDefaults.resetMode']));
    expect(validateSettingsPatch({ issueUrl: 'javascript:alert({id})', pullRequestUrl: 'https://user:password@example.com/{source}', editorPath: 'code --wait', editorArgs: ['{file}', '{shell}'] })).toHaveLength(4);
    expect(validateToolArgs(['--goto', '{file}:{line}:{column}', '--folder-uri={repo}'], 'editor')).toBeNull();
    expect(validateToolArgs(['-d', '{repo}'], 'terminal')).toBeNull(); expect(validateToolArgs(['{file}'], 'terminal')).not.toBeNull();
    for (const pattern of ['#(\\d+)', 'TEAM-([0-9]+)', '\\bBUG-(\\d+)\\b', '^TASK-(\\d+)$']) expect(validateIssuePattern(pattern)).toBeNull();
    for (const pattern of ['(a+)+$', '(.+)', '(\\d+)(\\d+)', '.*#(\\d+)', '(?:a|aa)+(\\d+)', '(\\d+)']) expect(validateIssuePattern(pattern)).not.toBeNull();
  });
  it('previews an import as settings only and reports excluded or unknown fields', () => {
    const preview = prepareConfigImport({ version: 1, trusted: ['D:/bad'], recent: [{ path: 'bad' }], settings: { pageSize: 180, theme: 'light', gitPath: 'bad.exe', editorPath: 'bad.exe', terminalArgs: ['-c', 'bad'], avatars: true, trusted: ['bad'], columns: { date: false } } });
    expect(preview.settings).toEqual({ pageSize: 180, initialLoad: 180, loadMore: 180, theme: 'light', columns: { date: false } });
    expect(preview.warnings.some(warning => warning.includes('gitPath'))).toBe(true); expect(preview.warnings.some(warning => warning.includes('trusted'))).toBe(true);
  });
  it('persists valid view targets and does not retain mutable cached comparisons', () => {
    const state = normalizeState({ version: 2, views: {
      repo: { scope: { kind: 'head' }, search: 'needle', searchMode: 'message', queryMode: 'search', order: 'author-date', scrollTop: 54, selected: oid, detail: { selection: { kind: 'commit', oid, parent }, path: 'src/a.ts', scrollTop: 12 }, filter: { author: 'A' }, collapsed: ['src'] },
      bad: { scope: { kind: 'all' }, detail: { selection: { kind: 'compare', base: 'HEAD~1', target: 'HEAD' } } },
    } });
    expect(state.views.repo.detail?.selection).toEqual({ kind: 'commit', oid, parent }); expect(state.views.repo.search).toBe('needle');
    expect(state.views.bad.detail).toBeUndefined();
  });
});

describe('explicit and resumable immutable review sessions', () => {
  it('does not implicitly activate old manual sessions and resumes without losing paths', async () => {
    const store = new StateStore(async () => undefined, () => undefined); const state = defaultState();
    const key = `commit:${oid}:${parent}`;
    state.version = 1; state.reviews = [{ key, repoId: 'repo', paths: ['a.ts'], updatedAt: Date.now() }]; store.load(state);
    expect(store.isReviewActive(key, 'repo')).toBe(false); expect(store.touchReview(key, 'repo')).toBe(false);
    expect(store.startReview(key, 'repo', { kind: 'commit', oid, parent })).toMatchObject({ active: true, paths: ['a.ts'] });
    store.review(key, 'repo', 'b.ts', true); expect([...store.reviewed(key, 'repo')]).toEqual(['a.ts', 'b.ts']);
    store.endReview(key, 'repo'); expect(store.isReviewActive(key, 'repo')).toBe(false); expect(store.reviewed(key, 'repo').size).toBe(2);
    expect(store.resumeReview(key, 'repo')?.active).toBe(true); await store.flush();
  });
  it('rejects mutable or missing targets and keeps comparison direction, parent and repository isolated', async () => {
    const store = new StateStore(async () => undefined, () => undefined);
    expect(store.startReview('bad', 'repo', { kind: 'commit', oid: 'HEAD' })).toBeNull();
    expect(store.startReview('bad', 'repo', { kind: 'compare', base: oid, target: 'main' })).toBeNull();
    expect(store.startReview('bad', 'repo', { kind: 'commit', oid: '123abc' })).toBeNull();
    const first = store.startReview('one', 'repo', { kind: 'compare', base: parent, target: oid }); expect(first?.active).toBe(true);
    expect(store.startReview('one', 'repo', { kind: 'compare', base: oid, target: parent })).toBeNull();
    store.startReview('two', 'repo', { kind: 'commit', oid, parent: other }); store.startReview('one', 'another', { kind: 'commit', oid });
    store.endAllReviews('repo'); expect(store.isReviewActive('one', 'repo')).toBe(false); expect(store.isReviewActive('two', 'repo')).toBe(false); expect(store.isReviewActive('one', 'another')).toBe(true);
    store.endAllReviews(); expect(store.isReviewActive('one', 'another')).toBe(false); await store.flush();
  });
  it('does not expose a mutable reference to a started session', async () => {
    const store = new StateStore(async () => undefined, () => undefined); const session = store.startReview('key', 'repo', { kind: 'commit', oid })!;
    session.paths.push('not-saved'); session.selection!.oid = 'HEAD';
    expect(store.reviewed('key', 'repo').size).toBe(0); expect(store.isReviewActive('key', 'repo')).toBe(true); await store.flush();
  });
  it('keeps the old manual API without starting automatic reviews', async () => {
    const store = new StateStore(async () => undefined, () => undefined);
    store.review(`commit:${oid}:ROOT`, 'repo', 'manual.ts', true);
    expect(store.isReviewActive(`commit:${oid}:ROOT`, 'repo')).toBe(false); expect(store.reviewed(`commit:${oid}:ROOT`, 'repo').has('manual.ts')).toBe(true); await store.flush();
  });
});

describe('state persistence failures and serialized snapshots', () => {
  it('rejects explicit flush, keeps dirty state, and retries after a failure', async () => {
    const failure = new Error('disk full'); const onError = vi.fn();
    const save = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined); const store = new StateStore(save, onError);
    store.updateSettings({ theme: 'light' }); await expect(store.flush()).rejects.toBe(failure);
    expect(store.dirty).toBe(true); expect(store.state.settings.theme).toBe('light'); expect(onError).not.toHaveBeenCalled();
    await store.flush(); expect(store.dirty).toBe(false); expect(save).toHaveBeenCalledTimes(2);
  });
  it('catches a queued rejection exactly once through onError', async () => {
    vi.useFakeTimers(); const failure = new Error('permission denied'); const onError = vi.fn();
    const store = new StateStore(async () => { throw failure; }, onError); store.updateSettings({ mailmap: true });
    await vi.advanceTimersByTimeAsync(300); expect(onError).toHaveBeenCalledOnce(); expect(onError).toHaveBeenCalledWith(failure); expect(store.dirty).toBe(true);
  });
  it('serializes saves without clearing a later edit while an earlier save is pending', async () => {
    let release: (() => void) | undefined;
    const save = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
    const store = new StateStore(save, () => undefined); store.updateSettings({ theme: 'light' });
    const first = store.flush(); await Promise.resolve(); await Promise.resolve();
    store.updateSettings({ mailmap: true }); const second = store.flush();
    expect(save).toHaveBeenCalledOnce(); release!(); await first; expect(store.dirty).toBe(true); await second; expect(store.dirty).toBe(false);
    expect(save.mock.calls[0][0].settings.mailmap).toBe(false); expect(save.mock.calls[1][0].settings.mailmap).toBe(true);
  });
});

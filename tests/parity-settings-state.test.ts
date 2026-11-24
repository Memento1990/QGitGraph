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
  it('keeps local-changes position shareable and independently overrideable by repository', async () => {
    expect(DEFAULT_SETTINGS.localChangesPosition).toBe('middle');
    for (const localChangesPosition of ['middle', 'inline'] as const) {
      expect(validateSettingsPatch({ localChangesPosition })).toEqual([]);
      expect(validateSettingsPatch({ localChangesPosition }, 'repository')).toEqual([]);
      expect(prepareConfigImport({ version: 2, settings: { localChangesPosition } }).settings).toEqual({ localChangesPosition });
    }
    const store = new StateStore(async () => undefined, () => undefined);
    store.updateSettings({ localChangesPosition: 'inline' }, 'repo');
    expect(store.state.repoSettings.repo).toEqual({ localChangesPosition: 'inline' });
    expect(effectiveSettings(store.state, 'repo').localChangesPosition).toBe('inline');
    expect(effectiveSettings(store.state, 'other').localChangesPosition).toBe('middle');
    for (const invalid of ['bottom', 'right', '', true, null, 1]) {
      expect(validateSettingsPatch({ localChangesPosition: invalid }).map(issue => issue.path)).toEqual(['localChangesPosition']);
      expect(normalizeSettings({ localChangesPosition: invalid }).localChangesPosition).toBe('middle');
    }
    await store.flush();
  });
  it('never imports device-local layout, views or transient commit drafts', () => {
    const preview = prepareConfigImport({ version: 2, layout: { localWidth: 999 }, views: { repo: {} }, draft: 'private',
      settings: { localChangesPosition: 'inline', localWidth: 999, detailRatio: 0.3, fullMessage: true, draft: 'private' } });
    expect(preview.settings).toEqual({ localChangesPosition: 'inline' });
    for (const key of ['layout', 'views', 'draft', 'localWidth', 'detailRatio', 'fullMessage']) expect(preview.warnings.some(warning => warning.includes(key))).toBe(true);
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
  it('roundtrips bounded detail view fields without exporting transient UI objects', () => {
    const view = { scope: { kind: 'head' }, search: 'literal message', searchMode: 'message', queryMode: 'filter', order: 'date', scrollTop: 54.5, scrollLeft: 23.25, selected: oid,
      detail: { selection: { kind: 'commit', oid, parent }, path: 'src/a.ts', scrollTop: 12.5, filesScrollTop: 120.5, filesScrollLeft: 9.5, fullMessage: true, inlineSide: 'above' },
      filter: { fileFilter: 'src' }, collapsed: ['src'] };
    const state = normalizeState({ version: 2, views: { repo: { ...view, draft: 'private', detail: { ...view.detail, draft: 'private', files: [{ path: 'not a cache' }] } } } });
    expect(state.views.repo).toEqual(view); expect(normalizeState(state).views.repo).toEqual(view);
    expect(JSON.stringify(state)).not.toContain('private'); expect(JSON.stringify(state)).not.toContain('not a cache');
  });
  it('cleans malformed detail enums, booleans, scrolls and text with the existing view budgets', () => {
    const state = normalizeState({ views: {
      repo: { scrollTop: NaN, scrollLeft: Infinity, search: 'x'.repeat(40000), detail: { selection: { kind: 'working', draft: 'private' },
        scrollTop: -1, filesScrollTop: 1e15, filesScrollLeft: '40', fullMessage: 'yes', inlineSide: 'left', path: 'x'.repeat(4097) },
        filter: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, 'value'])), collapsed: Array.from({ length: 10001 }, (_, index) => `path${index}`) },
      invalidSelection: { detail: { selection: { kind: 'compare', base: 'HEAD', target: oid }, fullMessage: true, inlineSide: 'below' } },
    } });
    expect(state.views.repo.scrollTop).toBe(0); expect(state.views.repo.scrollLeft).toBe(0); expect(state.views.repo.search).toHaveLength(32768);
    expect(state.views.repo.detail).toEqual({ selection: { kind: 'working' }, scrollTop: 0, filesScrollTop: 1_000_000_000 });
    expect(Object.keys(state.views.repo.filter!)).toHaveLength(64); expect(state.views.repo.collapsed).toHaveLength(10000);
    expect(state.views.invalidSelection.detail).toBeUndefined();
    expect(normalizeState({ views: { repo: { search: '文'.repeat(32768), detail: { selection: { kind: 'working' }, path: '文'.repeat(4096) } } } }).views.repo)
      .toMatchObject({ search: '文'.repeat(32768), detail: { path: '文'.repeat(4096) } });
    expect(normalizeState({ views: { repo: { detail: { selection: { kind: 'working' }, fullMessage: false, inlineSide: 'below' } } } }).views.repo.detail)
      .toEqual({ selection: { kind: 'working' }, fullMessage: false, inlineSide: 'below' });
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
  it('projects save snapshots through the schema and never persists local working drafts', async () => {
    const save = vi.fn(async (_state: unknown) => undefined); const store = new StateStore(save, () => undefined);
    const raw = store.state as unknown as Record<string, unknown>; raw.localDrafts = { repo: 'private message' };
    store.state.views.repo = { scope: { kind: 'all' }, search: '', searchMode: 'all', queryMode: 'filter', order: 'date', scrollTop: 0, selected: null,
      detail: { selection: { kind: 'working' }, fullMessage: true } };
    (store.state.views.repo as unknown as Record<string, unknown>).draft = 'private message';
    (store.state.views.repo.detail as unknown as Record<string, unknown>).draft = 'private message';
    store.queue(); await store.flush();
    expect(JSON.stringify(save.mock.calls[0][0])).not.toContain('private message');
    expect(save.mock.calls[0][0]).toMatchObject({ version: 2, views: { repo: { detail: { selection: { kind: 'working' }, fullMessage: true } } } });
    expect(raw.localDrafts).toEqual({ repo: 'private message' });
  });
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

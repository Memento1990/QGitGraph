import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, defaultState } from '../src/shared/protocol';
import { effectiveSettings, normalizeDirectoryScope, normalizeState } from '../src/lib/state';

const scope = () => ({ root: 'D:\\Projects', depth: 2, width: 240, collapsed: false, collapsedPaths: ['backend', 'folder%3Aname/repo', ''] });

describe('directory navigation preferences', () => {
  it('adds optional scope without changing old repository views, trust, or preferences', () => {
    const old = defaultState(); delete old.directoryScope;
    old.lastRepo = 'D:\\Projects\\repo'; old.trusted = [old.lastRepo]; old.settings.theme = 'light';
    const migrated = normalizeState(old);
    expect(migrated.directoryScope).toBeNull();
    expect(migrated.lastRepo).toBe(old.lastRepo); expect(migrated.trusted).toEqual(old.trusted);
    expect(migrated.settings.theme).toBe('light'); expect(migrated.settings.language).toBe('system');
  });
  it('persists only bounded navigation preferences, never discovered snapshots', () => {
    const normalized = normalizeState({ ...defaultState(), directoryScope: { ...scope(), repositories: [{ trusted: true }] } });
    expect(normalized.directoryScope).toEqual(scope());
    expect(normalized.directoryScope).not.toHaveProperty('repositories');
    expect(normalizeDirectoryScope({ ...scope(), depth: 100, width: 900 })).toMatchObject({ depth: 5, width: 640 });
  });
  it('defaults the wider directory pane without changing existing saved widths', () => {
    const { width: _width, ...legacy } = scope();
    expect(normalizeDirectoryScope(legacy)?.width).toBe(376);
    for (const width of [180, 240, 376, 640]) expect(normalizeDirectoryScope({ ...scope(), width })?.width).toBe(width);
    for (const width of [NaN, Infinity, '640', null]) expect(normalizeDirectoryScope({ ...scope(), width })?.width).toBe(376);
    expect(normalizeDirectoryScope({ ...scope(), width: 311.4 })?.width).toBe(311);
  });
  it('preserves native UNC spelling and encoded filename components', () => {
    const root = '\\\\wsl.localhost\\ExampleDistro\\home\\example\\Projects';
    expect(normalizeDirectoryScope({ ...scope(), root })?.root).toBe(root);
    expect(normalizeDirectoryScope({ ...scope(), collapsedPaths: ['folder%3Aname', 'a%5Cb', '%E4%B8%AD%E6%96%87'] })?.collapsedPaths)
      .toEqual(['folder%3Aname', 'a%5Cb', '%E4%B8%AD%E6%96%87']);
  });
  it('rejects relative or controlled roots and drops malformed disclosure keys', () => {
    for (const root of ['', 'relative/project', '../outside', 'D:\\bad\0path', 'D:\\bad\npath']) expect(normalizeDirectoryScope({ ...scope(), root })).toBeNull();
    const collapsedPaths = ['safe', '..', 'a/../b', 'a//b', 'raw:name', 'raw\\name', '%bad', 'a/%2e%2e', 'a/%e4%b8%ad', 'safe'];
    expect(normalizeDirectoryScope({ ...scope(), collapsedPaths })?.collapsedPaths).toEqual(['safe']);
    expect(normalizeDirectoryScope({ ...scope(), collapsedPaths: Array.from({ length: 400 }, (_, index) => String(index)) })?.collapsedPaths).toHaveLength(256);
  });
  it('keeps language global even when repository overrides or shared input contain it', () => {
    const state = normalizeState({ ...defaultState(), settings: { ...DEFAULT_SETTINGS, language: 'zh-CN' }, repoSettings: { repo: { language: 'en', theme: 'light' } } });
    expect(effectiveSettings(state, 'repo').language).toBe('zh-CN');
    expect(effectiveSettings(state, 'repo').theme).toBe('light');
  });
});

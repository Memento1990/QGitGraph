import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRenderer, defineComponent, h, nextTick, reactive, ssrContextKey, type Component } from 'vue';
import * as Vue from 'vue';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import SettingsSfc from '../src/components/SettingsDialog.vue';
import UpdatesSfc from '../src/components/UpdatesDialog.vue';
import { createPreferencesDraft, importSettingLabel, officialVueReleaseUrl, SETTINGS_SECTIONS, SETTINGS_SPECS, settingsLocale, validateVueRelease, type SettingsDialogProps, type SettingsSave } from '../src/controllers/preferences';
import { DEFAULT_SETTINGS, type GithubUpdateInfo, type Host, type Repository } from '../src/shared/protocol';
import { initI18n, resolveText, setLanguage } from '../src/lib/i18n';
import { prepareConfigImport } from '../src/lib/settings-schema';
import { label } from '../src/i18n/settings';

// Test real SFC rendering and handlers with Vue's custom renderer. Only Reka's browser-only
// portal/focus layer is replaced; these tests do not claim native keyboard/focus coverage.
vi.mock('reka-ui', async () => {
  const { defineComponent, h } = await import('vue');
  const primitive = (tag: string) => defineComponent({ inheritAttrs: false, setup: (_, { attrs, slots }) => () => h(tag, attrs, slots.default?.()) });
  return {
    DialogRoot: defineComponent({ props: { open: Boolean }, setup: (props, { slots }) => () => props.open ? slots.default?.() : null }),
    DialogPortal: defineComponent({ setup: (_, { slots }) => () => slots.default?.() }),
    DialogContent: primitive('section'), DialogOverlay: primitive('aside'), DialogTitle: primitive('h2'), DialogDescription: primitive('p'),
  };
});

// Vitest's node environment compiles Vue SFC templates for SSR. Use the real imported
// script setup with its source compiled for Vue's custom client renderer instead.
function clientComponent(component: Component, file: string): Component {
  const filename = fileURLToPath(new URL(file, import.meta.url));
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const script = compileScript(descriptor, { id: 'settings-test', fs: { fileExists: existsSync, readFile: path => readFileSync(path, 'utf8') } });
  const result = compileTemplate({ source: descriptor.template!.content, filename, id: 'settings-test', compilerOptions: { bindingMetadata: script.bindings, mode: 'function' } });
  if (result.errors.length) throw new Error(String(result.errors[0]));
  const target = component as { render?: unknown; ssrRender?: unknown };
  const javascript = ts.transpileModule(result.code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  target.render = new Function('Vue', javascript)(Vue); delete target.ssrRender;
  return target as Component;
}
const SettingsDialog = clientComponent(SettingsSfc, '../src/components/SettingsDialog.vue');
const UpdatesDialog = clientComponent(UpdatesSfc, '../src/components/UpdatesDialog.vue');

interface TestNode { type: string; text: string; props: Record<string, unknown>; children: TestNode[]; parent: TestNode | null }
function node(type: string, text = ''): TestNode { return { type, text, props: {}, children: [], parent: null }; }
const renderer = createRenderer<TestNode, TestNode>({
  createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
  setText: (target, text) => { target.text = text; },
  setElementText: (target, text) => { target.children = []; target.text = text; },
  patchProp: (target, key, _before, value) => { target.props[key] = value; },
  parentNode: target => target.parent,
  nextSibling: target => target.parent?.children[(target.parent.children.indexOf(target)) + 1] ?? null,
  insert: (target, parent, anchor = null) => {
    if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1);
    target.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    if (index < 0) parent.children.push(target); else parent.children.splice(index, 0, target);
  },
  remove: target => { if (target.parent) target.parent.children.splice(target.parent.children.indexOf(target), 1); target.parent = null; },
});
const mounted: { unmount(): void }[] = [];
function mount(component: Component, props: Record<string, unknown>) {
  const state = reactive(props), root = node('root');
  const app = renderer.createApp(defineComponent({ setup: () => () => h(component, state) })); app.provide(ssrContextKey, {}); app.mount(root); mounted.push(app);
  return { root, props: state, unmount: () => app.unmount() };
}
const all = (root: TestNode): TestNode[] => [root, ...root.children.flatMap(all)];
const content = (root: TestNode): string => root.text + root.children.filter(child => child.type !== '#comment').map(content).join('');
function find(root: TestNode, key: string, value?: unknown): TestNode {
  const target = all(root).find(item => Object.prototype.hasOwnProperty.call(item.props, key) && (value === undefined || item.props[key] === value));
  if (!target) throw new Error(`Missing ${key} ${String(value)}`); return target;
}
const action = (root: TestNode, name: string): TestNode => find(root, 'data-action', name);
const setting = (root: TestNode, name: string): TestNode => find(root, 'data-setting', name);
function event(target: TestNode, name: string, value?: string | boolean): void {
  const event = { target: { value, checked: value }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  const handler = target.props[`on${name}`] as ((event: unknown) => void) | undefined;
  if (!handler) throw new Error(`Missing handler ${name}`); handler(event);
}
async function click(root: TestNode, name: string): Promise<void> { event(action(root, name), 'Click'); await settle(); }
async function edit(root: TestNode, name: string, value: string | boolean): Promise<void> {
  const target = setting(root, name); event(target, target.type === 'select' || target.props.type === 'checkbox' ? 'Change' : 'Input', value); await settle();
}
async function section(root: TestNode, name: string): Promise<void> { event(find(root, 'data-section', name), 'Click'); await settle(); }
async function settle(): Promise<void> { for (let index = 0; index < 8; index++) await nextTick(); }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const repo: Repository = { id: 'fixture-repo', name: 'Literal 保存 / Apply', path: '/fixture', gitDir: '.git', commonDir: '.git', branch: 'main', head: null, bare: false, trusted: true };
const available = (patch: Partial<GithubUpdateInfo> = {}): GithubUpdateInfo => ({ status: 'available', currentVersion: '0.3.0', latestVersion: '0.4.0', releaseTag: 'v0.4.0', releaseUrl: 'https://github.com/Memento1990/QGitGraph/releases/tag/v0.4.0', publishedAt: '2026-11-23T10:00:00Z', releaseNotes: 'Release notes', notesTruncated: false, ...patch });
function host() {
  return {
    saveState: vi.fn(async () => undefined), importConfig: vi.fn(async () => null), exportConfig: vi.fn(async () => true),
    diagnostics: vi.fn(async () => ({ appVersion: '0.3.0', gitVersion: 'git version 2.50', gitPath: '/fixture/git', platform: 'test platform', hostMode: 'desktop' as const, configDirectory: '/fixture/config', warnings: ['Literal 保存 / Apply'], performanceEnabled: true })),
    checkForUpdates: vi.fn(async () => available()), openUrl: vi.fn(async () => undefined), action: vi.fn(async () => undefined),
  };
}
function settings(overrides: Partial<SettingsDialogProps> = {}) {
  const bridge = host(), saves: SettingsSave[] = [], resets: unknown[] = [], scopes: unknown[] = [], opens: unknown[] = [];
  const instance = mount(SettingsDialog, { open: true, settings: structuredClone(DEFAULT_SETTINGS), globalSettings: structuredClone(DEFAULT_SETTINGS), repo, scope: 'global', host: bridge as unknown as Host, ...overrides, onSave: (value: SettingsSave) => saves.push(value), onReset: (value: unknown) => resets.push(value), onScope: (value: unknown) => scopes.push(value), 'onUpdate:open': (value: unknown) => opens.push(value) });
  return { ...instance, bridge, saves, resets, scopes, opens };
}
function updates(overrides: Record<string, unknown> = {}) {
  const bridge = host(), opens: unknown[] = [];
  return { ...mount(UpdatesDialog, { open: true, host: bridge as unknown as Host, language: 'en', currentVersion: '0.3.0', ...overrides, 'onUpdate:open': (value: unknown) => opens.push(value) }), bridge, opens };
}
beforeEach(() => { initI18n('en', []); vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' }); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Dialogs must not call fetch'); })); });
afterEach(() => { for (const app of mounted.splice(0)) app.unmount(); initI18n('en', []); vi.unstubAllGlobals(); });

describe('formal Vue settings schema and drafts', () => {
  it('renders controls for every AppSettings key and every nested fixed schema leaf without prototype-only omissions', () => {
    const keys = [...new Set(SETTINGS_SPECS.map(spec => spec.key.split('.')[0]))].sort();
    expect(keys).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
    for (const group of ['shortcuts', 'columns', 'columnWidths', 'dialogDefaults'] as const) {
      expect(SETTINGS_SPECS.filter(spec => spec.key.startsWith(`${group}.`)).map(spec => spec.key.split('.')[1]).sort()).toEqual(Object.keys(DEFAULT_SETTINGS[group]).sort());
    }
    for (const spec of SETTINGS_SPECS) {
      expect(resolveText(label(spec.key), 'en')).toBeTruthy(); expect(resolveText(label(spec.key), 'zh-CN')).toBeTruthy();
      for (const choice of spec.choices ?? []) { expect(resolveText(choice.text, 'en')).toBeTruthy(); expect(resolveText(choice.text, 'zh-CN')).toBeTruthy(); }
    }
  });

  it('keeps edits detached from parent props and validates JSON, bounds, tools, URLs, shortcuts and enums before normalization', () => {
    const input = structuredClone(DEFAULT_SETTINGS), draft = createPreferencesDraft({ settings: reactive(input) });
    expect(draft.set('theme', 'light')).toBe(true); expect(input.theme).toBe('dark');
    expect(draft.set('language', 'zh-CN')).toBe(true); expect(draft.patch.value).toEqual({ theme: 'light', language: 'zh-CN' });
    for (const [key, value] of [['rowHeight', 500], ['initialLoad', NaN], ['theme', 'unknown'], ['editorPath', 'sh -c bad'], ['editorArgs', ['{unknown}']], ['issueUrl', 'javascript:alert(1)'], ['shortcuts.find', 'Ctrl+Ctrl+K']] as const) expect(draft.set(key, value)).toBe(false);
    expect(draft.effective.value.rowHeight).toBe(DEFAULT_SETTINGS.rowHeight); expect(Object.keys(draft.errors.value)).toHaveLength(7);
    const palette = SETTINGS_SPECS.find(spec => spec.key === 'graphColors')!;
    expect(draft.update(palette, '{broken')).toBe(false); expect(draft.text(palette)).toBe('{broken');
    expect(draft.update(palette, '["#123456"]')).toBe(true); expect(draft.errors.value.graphColors).toBeUndefined();
    expect(draft.patch.value.graphColors).toEqual(['#123456']); expect(input.graphColors).toEqual(DEFAULT_SETTINGS.graphColors);
  });

  it('enforces GLOBAL_ONLY and saves only repository overrides, including nested leaf removal and full JSON map replacement', () => {
    const global = { ...structuredClone(DEFAULT_SETTINGS), rowHeight: 40 }, draft = createPreferencesDraft({ settings: global, globalSettings: global, scope: 'repository', repoPatch: { fontSize: 15, shortcuts: { refresh: 'Alt+R', find: 'Alt+F' }, customEmoji: { previous: 'A' }, language: 'zh-CN', gitPath: '/unsafe' } });
    expect(draft.effective.value.rowHeight).toBe(40); expect(draft.effective.value.gitPath).toBe('');
    expect(draft.set('gitPath', '/new')).toBe(false); expect(draft.set('language', 'zh-CN')).toBe(false);
    expect(draft.set('shortcuts.head', 'Alt+H')).toBe(true); draft.inherit('shortcuts.refresh'); draft.inherit('fontSize');
    expect(draft.effective.value.shortcuts.refresh).toBe(DEFAULT_SETTINGS.shortcuts.refresh);
    draft.set('customEmoji', {});
    expect(draft.patch.value).toEqual({ shortcuts: { find: 'Alt+F', head: 'Alt+H' }, customEmoji: {} });
    draft.inherit('customEmoji'); draft.inherit('shortcuts.head'); draft.inherit('shortcuts.find'); expect(draft.patch.value).toEqual({});
    expect(draft.dirty.value).toBe(true);
  });

  it('revalidates safe import at the final boundary, supports nested patches, preserves unrelated overrides and excludes language/consent/executables', () => {
    const draft = createPreferencesDraft({ settings: DEFAULT_SETTINGS, scope: 'repository', repoPatch: { rowHeight: 30, shortcuts: { refresh: 'Alt+R' } } });
    const preview = prepareConfigImport({ version: 2, settings: { theme: 'light', shortcuts: { find: 'Alt+F' }, dialogDefaults: { tagPush: true }, language: 'zh-CN', gitPath: 'evil', editorArgs: ['evil'], avatars: true }, trusted: ['/fake'] });
    draft.stageImport(preview, Object.keys(preview.settings));
    draft.stageImport({ version: 2, settings: { language: 'zh-CN', gitPath: '/unsafe', avatars: true }, warnings: [] }, ['language', 'gitPath', 'avatars']);
    expect(draft.patch.value).toEqual({ rowHeight: 30, shortcuts: { refresh: 'Alt+R', find: 'Alt+F' }, theme: 'light', dialogDefaults: { tagPush: true } });
    for (const key of Object.keys(preview.settings)) for (const locale of ['en', 'zh-CN'] as const) expect(resolveText(importSettingLabel(key), locale)).toBeTruthy();
    expect(preview.warnings.length).toBeGreaterThan(0);
  });

  it('resolves all three supported language preferences without uncommitted changes affecting shared language', () => {
    expect(settingsLocale('system', ['zh-Hant-TW'])).toBe('zh-CN'); expect(settingsLocale('en', ['zh-CN'])).toBe('en'); expect(settingsLocale('zh-CN', ['en'])).toBe('zh-CN');
    expect(settingsLocale('system', ['fr-FR'])).toBe('en');
  });
});

describe('SettingsDialog real Vue rendering and event contract', () => {
  it('opens without requests or writes and renders every settings control with localized visible and ARIA labels', async () => {
    const { root, bridge, props } = settings();
    expect(bridge.saveState).not.toHaveBeenCalled(); expect(bridge.checkForUpdates).not.toHaveBeenCalled(); expect(bridge.diagnostics).not.toHaveBeenCalled();
    for (const group of SETTINGS_SECTIONS) {
      await section(root, group.id);
      for (const spec of group.specs) expect(setting(root, spec.key).props['aria-label']).toBe(resolveText(label(spec.key), 'en'));
    }
    props.globalSettings = { ...structuredClone(DEFAULT_SETTINGS), language: 'zh-CN' }; await settle();
    expect(content(root)).toContain('保存设置'); expect(action(root, 'close-settings').props['aria-label']).toBe('关闭设置');
    await section(root, 'appearance'); expect(setting(root, 'language').props['aria-label']).toBe('语言（全局）');
    expect(all(setting(root, 'language')).filter(item => item.type === 'option').map(item => item.props.value)).toEqual(['system', 'en', 'zh-CN']);
    expect(content(root)).toContain(repo.name); expect(fetch).not.toHaveBeenCalled();
  });

  it('emits a normalized global patch only on Save and preserves an invalid or failed draft for retry', async () => {
    const { root, bridge, saves, props } = settings();
    await edit(root, 'theme', 'light'); await edit(root, 'language', 'zh-CN');
    expect(saves).toEqual([]); expect(bridge.saveState).not.toHaveBeenCalled();
    await edit(root, 'rowHeight', '99'); expect(setting(root, 'rowHeight').props['aria-invalid']).toBe(true); expect(action(root, 'save-settings').props.disabled).toBe(true);
    await click(root, 'save-settings'); expect(saves).toEqual([]);
    await edit(root, 'rowHeight', '32'); await click(root, 'save-settings');
    expect(saves).toEqual([{ scope: 'global', patch: { theme: 'light', language: 'zh-CN', rowHeight: 32 } }]);
    props.saveError = 'Disk unavailable'; await settle();
    expect(content(root)).toContain('Disk unavailable'); expect(setting(root, 'theme').props.value).toBe('light');
    await click(root, 'save-settings'); expect(saves).toHaveLength(2); expect(bridge.saveState).not.toHaveBeenCalled();
  });

  it('restores a retryable draft when optimistic parent props update before native persistence fails', async () => {
    const { root, saves, props } = settings(); await edit(root, 'theme', 'light'); await click(root, 'save-settings');
    props.settings = { ...structuredClone(DEFAULT_SETTINGS), theme: 'light' }; props.globalSettings = props.settings; await settle();
    expect(action(root, 'save-settings').props.disabled).toBe(true);
    props.saveError = 'Late native flush failure'; await settle();
    expect(setting(root, 'theme').props.value).toBe('light'); expect(action(root, 'save-settings').props.disabled).toBe(false);
    await click(root, 'save-settings'); expect(saves).toEqual([{ scope: 'global', patch: { theme: 'light' } }, { scope: 'global', patch: { theme: 'light' } }]);
  });

  it('keeps Git/language globally constrained and emits complete replacement repo overrides after choosing inheritance', async () => {
    const { root, saves } = settings({ scope: 'repository', repoPatch: { fontSize: 15, shortcuts: { find: 'Alt+F', refresh: 'Alt+R' } } });
    expect(setting(root, 'language').props.disabled).toBe(true);
    event(find(root, 'data-inherit-setting', 'fontSize'), 'Click'); await settle();
    expect(setting(root, 'fontSize').props.value).toBe(String(DEFAULT_SETTINGS.fontSize));
    await section(root, 'shortcuts'); event(find(root, 'data-inherit-setting', 'shortcuts.find'), 'Click'); await settle();
    await edit(root, 'shortcuts.head', 'Alt+H');
    await section(root, 'tools'); expect(setting(root, 'gitPath').props.disabled).toBe(true);
    await click(root, 'save-settings'); expect(saves).toEqual([{ scope: 'repository', patch: { shortcuts: { refresh: 'Alt+R', head: 'Alt+H' } } }]);
  });

  it('requires confirmation to discard drafts on scope change or close, and to reset either scope', async () => {
    const { root, scopes, opens, resets, props } = settings();
    await edit(root, 'theme', 'light'); event(find(root, 'data-setting-scope'), 'Change', 'repository'); await settle();
    expect(scopes).toEqual([]); expect(content(find(root, 'data-settings-confirm'))).toContain('Discard unsaved changes');
    await click(root, 'cancel-settings-confirm'); expect(setting(root, 'theme').props.value).toBe('light');
    await click(root, 'close-settings'); expect(opens).toEqual([]); await click(root, 'confirm-settings'); expect(opens).toEqual([false]);
    await edit(root, 'theme', 'light'); event(find(root, 'data-setting-scope'), 'Change', 'repository'); await settle(); await click(root, 'confirm-settings'); expect(scopes).toEqual(['repository']);
    props.scope = 'repository'; props.repoPatch = { fontSize: 16 }; await settle();
    await click(root, 'reset-settings'); expect(resets).toEqual([]); await click(root, 'cancel-settings-confirm'); expect(resets).toEqual([]);
    await click(root, 'reset-settings'); await click(root, 'confirm-settings'); expect(resets).toEqual([{ scope: 'repository' }]);
    props.scope = 'global'; await settle(); await click(root, 'reset-settings'); await click(root, 'confirm-settings'); expect(resets).toEqual([{ scope: 'repository' }, { scope: 'global' }]);
  });

  it('does not enable external avatars without explicit privacy consent', async () => {
    const { root, saves } = settings(); await section(root, 'files'); await edit(root, 'avatars', true);
    expect(setting(root, 'avatars').props.checked).toBe(false); expect(content(find(root, 'data-settings-confirm'))).toContain('Gravatar');
    await click(root, 'cancel-settings-confirm'); expect(saves).toEqual([]);
    await edit(root, 'avatars', true); await click(root, 'confirm-settings'); await click(root, 'save-settings'); expect(saves).toEqual([{ scope: 'global', patch: { avatars: true } }]);
  });

  it('uses Host export with the correct saved scope and stages only selected safe import settings after a real preview confirmation', async () => {
    const { root, bridge, saves, props } = settings();
    await click(root, 'export-settings'); expect(bridge.exportConfig.mock.calls).toEqual([[null]]);
    bridge.importConfig.mockResolvedValueOnce({ version: 2, settings: { theme: 'light', rowHeight: 36, columns: { author: false }, language: 'zh-CN', editorPath: '/unsafe', avatars: true }, warnings: ['Literal imported warning'] } as never);
    await click(root, 'import-settings'); expect(saves).toEqual([]); expect(content(root)).toContain('Preview configuration import'); expect(content(root)).toContain('Literal imported warning');
    expect(all(root).filter(item => 'data-import-key' in item.props).map(item => item.props['data-import-key'])).toEqual(['theme', 'rowHeight', 'columns']);
    event(find(root, 'data-import-key', 'rowHeight'), 'Change', false); await settle();
    await click(root, 'confirm-settings'); expect(saves).toEqual([]); await click(root, 'save-settings');
    expect(saves).toEqual([{ scope: 'global', patch: { theme: 'light', columns: { author: false } } }]);
    props.open = false; await settle(); props.scope = 'repository'; props.repoPatch = {}; props.open = true; await settle();
    await click(root, 'export-settings'); expect(bridge.exportConfig.mock.calls).toEqual([[null], [repo.id]]); expect(bridge.saveState).not.toHaveBeenCalled();
  });

  it('localizes preview/group labels and validation live while preserving raw JSON input and repository strings', async () => {
    const { root, bridge, props } = settings(); await edit(root, 'graphColors', '{invalid');
    props.globalSettings = { ...structuredClone(DEFAULT_SETTINGS), language: 'zh-CN' }; await settle();
    expect(setting(root, 'graphColors').props.value).toBe('{invalid'); expect(content(root)).toContain('请输入有效的 JSON'); expect(content(root)).toContain(repo.name);
    await edit(root, 'graphColors', '["#123"]');
    bridge.importConfig.mockResolvedValueOnce({ version: 2, settings: { shortcuts: { find: 'Alt+F' }, columnWidths: { date: 160 }, dialogDefaults: { tagPush: true } }, warnings: [] } as never);
    await click(root, 'import-settings'); expect(content(find(root, 'data-settings-confirm'))).toContain('键盘快捷键'); expect(content(root)).toContain('列宽'); expect(content(root)).toContain('对话框默认值');
  });

  it('ignores an import result that resolves after changing scope or closing, and reports import/export failures honestly', async () => {
    const { root, bridge, props, saves } = settings();
    const pending = deferred<never>(); bridge.importConfig.mockImplementationOnce(() => pending.promise); await click(root, 'import-settings');
    props.scope = 'repository'; await settle(); pending.resolve({ version: 2, settings: { theme: 'light' }, warnings: [] } as never); await settle();
    expect(all(root).some(item => 'data-settings-confirm' in item.props)).toBe(false); expect(saves).toEqual([]);
    bridge.importConfig.mockRejectedValueOnce(new Error('Import unavailable')); await click(root, 'import-settings'); expect(content(root)).toContain('Import unavailable');
    bridge.exportConfig.mockRejectedValueOnce(new Error('Export unavailable')); await click(root, 'export-settings'); expect(content(root)).toContain('Export unavailable');
  });

  it('reads genuine local diagnostics on About only, exposes retry, and never checks updates merely by opening either dialog', async () => {
    const { root, bridge } = settings(); bridge.diagnostics.mockRejectedValueOnce(new Error('Local diagnostics unavailable'));
    await section(root, 'about'); expect(content(root)).toContain('Local diagnostics unavailable'); expect(bridge.diagnostics).toHaveBeenCalledTimes(1);
    await click(root, 'refresh-diagnostics'); expect(content(root)).toContain('git version 2.50'); expect(content(root)).toContain('/fixture/config'); expect(content(root)).toContain('Literal 保存 / Apply');
    await click(root, 'show-updates'); expect(all(root).some(item => 'data-updates-dialog' in item.props)).toBe(true);
    expect(bridge.checkForUpdates).not.toHaveBeenCalled(); expect(bridge.saveState).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

describe('UpdatesDialog manual network boundary', () => {
  it('performs no startup/open request, deduplicates explicit clicks, and opens only the returned safe URL after another click', async () => {
    const { root, bridge, props } = updates({ open: false }); expect(bridge.checkForUpdates).not.toHaveBeenCalled(); props.open = true; await settle();
    const pending = deferred<GithubUpdateInfo>(); bridge.checkForUpdates.mockImplementationOnce(() => pending.promise);
    event(action(root, 'check-for-updates'), 'Click'); event(action(root, 'check-for-updates'), 'Click'); await settle();
    expect(bridge.checkForUpdates.mock.calls).toEqual([[]]); expect(action(root, 'check-for-updates').props.disabled).toBe(true);
    pending.resolve(available()); await settle(); expect(find(root, 'data-update-status', 'available').props['aria-live']).toBe('polite'); expect(bridge.openUrl).not.toHaveBeenCalled();
    await click(root, 'open-update-release'); expect(bridge.openUrl).toHaveBeenCalledExactlyOnceWith(available().releaseUrl); expect(fetch).not.toHaveBeenCalled();
  });

  it('renders bounded release notes as text, localizes labels and ARIA, and never writes raw HTML', async () => {
    const { root, bridge, props } = updates(); const payload = '<img src=x onerror=alert(1)>' + '汉'.repeat(9000);
    bridge.checkForUpdates.mockResolvedValueOnce(available({ releaseNotes: payload })); await click(root, 'check-for-updates');
    const notes = content(find(root, 'data-update-notes')); expect(notes.startsWith('<img')).toBe(true); expect(notes).not.toContain('�'); expect(new TextEncoder().encode(notes).length).toBeLessThanOrEqual(16 * 1024);
    expect(all(root).some(item => item.type === 'img' || 'innerHTML' in item.props)).toBe(false);
    props.language = 'zh-CN'; await settle(); expect(content(root)).toContain('检查更新'); expect(content(root)).toContain('发行说明已截断'); expect(action(root, 'close-updates').props['aria-label']).toBe('关闭更新');
    expect(content(find(root, 'data-update-notes'))).toBe(notes);
  });

  it('distinguishes unsupported/current/no-release, rejects malformed results, and allows explicit retry after network errors', async () => {
    const { root, bridge } = updates();
    for (const status of ['unsupported', 'no-release'] as const) {
      bridge.checkForUpdates.mockResolvedValueOnce({ status, currentVersion: '0.3.0', latestVersion: null, releaseTag: null, releaseUrl: null, publishedAt: null, releaseNotes: null, notesTruncated: false });
      await click(root, 'check-for-updates'); expect(find(root, 'data-update-status').props['data-update-status']).toBe(status);
    }
    bridge.checkForUpdates.mockResolvedValueOnce(available({ status: 'current', currentVersion: '0.5.0' })); await click(root, 'check-for-updates'); expect(content(root)).toContain('at least as recent'); expect(all(root).some(item => item.props['data-action'] === 'open-update-release')).toBe(false);
    bridge.checkForUpdates.mockResolvedValueOnce(available({ releaseUrl: 'https://evil.example' })); await click(root, 'check-for-updates'); expect(content(root)).toContain('Invalid release information'); expect(bridge.openUrl).not.toHaveBeenCalled();
    bridge.checkForUpdates.mockRejectedValueOnce(new Error('Offline 429')); await click(root, 'check-for-updates'); expect(content(root)).toContain('Offline 429');
    await click(root, 'check-for-updates'); expect(find(root, 'data-update-status').props['data-update-status']).toBe('available');
  });

  it('rejects generic URLs, semver mismatches, credentials, redirects and non-official owners, including at the final open boundary', () => {
    const base = available();
    for (const releaseUrl of [base.releaseUrl + '?next=evil', base.releaseUrl + '#fragment', base.releaseUrl + '/', base.releaseUrl + '\n', base.releaseUrl!.replace('https:', 'http:'), base.releaseUrl!.replace('github.com', 'github.com.evil.test'), base.releaseUrl!.replace('github.com', 'user:pass@github.com'), base.releaseUrl!.replace('Memento1990', 'Other'), 'javascript:alert(1)', 'https://evil.test/?url=' + base.releaseUrl]) expect(officialVueReleaseUrl({ ...base, releaseUrl })).toBeNull();
    for (const releaseTag of ['v0.4.1', 'V0.4.0', 'v00.4.0', 'v0.4.0-rc.1', '../latest', 'v0.4.0\n']) expect(officialVueReleaseUrl({ ...base, releaseTag })).toBeNull();
    for (const value of [null, {}, { ...base, notesTruncated: 'yes' }, { ...base, publishedAt: 'bad date' }, { ...base, releaseNotes: {} }, { ...base, currentVersion: 'unknown' }]) expect(validateVueRelease(value)).toBeNull();
    expect(officialVueReleaseUrl(base)).toBe(base.releaseUrl);
  });

  it('invalidates delayed check/open results on close, host changes and retry without leaking errors into a new result', async () => {
    const { root, bridge, props, opens } = updates(); const pending = deferred<GithubUpdateInfo>(); bridge.checkForUpdates.mockImplementationOnce(() => pending.promise);
    await click(root, 'check-for-updates'); await click(root, 'close-updates'); expect(opens).toEqual([false]); props.open = false; await settle(); pending.resolve(available()); await settle(); expect(bridge.openUrl).not.toHaveBeenCalled();
    props.open = true; await settle(); expect(find(root, 'data-update-status').props['data-update-status']).toBe('idle'); await click(root, 'check-for-updates');
    const opening = deferred<undefined>(); bridge.openUrl.mockImplementationOnce(() => opening.promise); await click(root, 'open-update-release');
    await click(root, 'check-for-updates'); opening.reject(new Error('Stale open error')); await settle(); expect(content(root)).not.toContain('Stale open error');
    bridge.openUrl.mockRejectedValueOnce(new Error('Browser unavailable')); await click(root, 'open-update-release'); expect(content(root)).toContain('Browser unavailable');
    await click(root, 'open-update-release'); expect(action(root, 'open-update-release').props.disabled).toBe(false);
    const late = deferred<GithubUpdateInfo>(); bridge.checkForUpdates.mockImplementationOnce(() => late.promise); await click(root, 'check-for-updates'); props.host = host(); await settle(); late.reject(new Error('Old host failure')); await settle(); expect(content(root)).not.toContain('Old host failure');
  });

  it('follows shared explicit locale changes when no language prop is supplied', async () => {
    const { root } = updates({ language: undefined }); setLanguage('zh-CN'); await settle(); expect(action(root, 'close-updates').props['aria-label']).toBe('关闭更新'); expect(content(root)).toContain('仅在您选择');
  });
});

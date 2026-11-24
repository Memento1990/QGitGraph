import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/protocol';
import { effectiveSettings, normalizeState, StateStore } from '../src/lib/state';
import { CONFIG_IMPORT_EXCLUDED_SETTINGS, GLOBAL_ONLY_SETTINGS, normalizeSettings, normalizeSettingsPatch, prepareConfigImport, settingsIssuesText, validateSettingsPatch } from '../src/lib/settings-schema';
import { defineMessages, getLanguage, getLocale, initI18n, onLocaleChange, resolveLocale, resolveText, setLanguage } from '../src/lib/i18n';
import { dateText, errorMessage, errorText, formatDate, formatFullDate, formatNumber, fullDateText, numberText, scopeText } from '../src/lib/format';
import { ACTION_GROUPS, ACTION_LABELS, GitActions, actionPreflightText, type ActionContext } from '../src/ui/actions';
import type { Host } from '../src/shared/protocol';

const fixture = defineMessages('test', {
  greeting: 'Hello {name}.', count: '{count} files for {name}.', literal: 'Use {{repo}} and {{file}}.', repeated: '{name}: {name}', nested: 'Result: {message}',
}, {
  greeting: '你好，{name}。', count: '{name} 的 {count} 个文件。', literal: '使用 {{repo}} 和 {{file}}。', repeated: '{name}：{name}', nested: '结果：{message}',
});

// These checks are intentionally compiled by tsc, not executed; runtime checks cover external/untyped catalogues below.
function dictionaryTypeChecks(): void {
  fixture.m('greeting', { name: 'A' }); fixture.m('literal');
  // @ts-expect-error Unknown message keys are not accepted.
  fixture.m('missing');
  // @ts-expect-error Required message parameters cannot be omitted.
  fixture.m('greeting');
  // @ts-expect-error Extra parameters cannot be supplied.
  fixture.m('greeting', { name: 'A', extra: 'B' });
  // @ts-expect-error Messages without parameters cannot receive arguments.
  fixture.m('literal', { repo: 'x' });
  // @ts-expect-error Every locale must supply every key.
  defineMessages('missing', { one: 'One', two: 'Two' }, { one: '一' });
  // @ts-expect-error Extra locale keys are rejected.
  defineMessages('extra', { one: 'One' }, { one: '一', two: '二' });
  // @ts-expect-error Placeholder names must match exactly.
  defineMessages('parameters', { one: '{name}' }, { one: '{other}' });
  // @ts-expect-error Translations may not omit placeholders.
  defineMessages('omitted', { one: '{name}' }, { one: '一' });
}
void dictionaryTypeChecks;
afterEach(() => { initI18n('en', []); });

describe('lightweight locale resolution and typed independent domains', () => {
  it('chooses explicit languages or the first supported system language, with a deterministic English fallback', () => {
    expect(resolveLocale('zh-CN', ['en-US'])).toBe('zh-CN'); expect(resolveLocale('en', ['zh-CN'])).toBe('en');
    for (const tag of ['zh-CN', 'zh', 'zh-Hans-CN', 'zh-TW', 'zh_Hant_HK']) expect(resolveLocale('system', [tag])).toBe('zh-CN');
    expect(resolveLocale('system', ['fr-FR', 'zh-CN', 'en-US'])).toBe('zh-CN');
    expect(resolveLocale('system', ['en-GB', 'zh-CN'])).toBe('en');
    expect(resolveLocale('system', ['de-DE', 'ja-JP'])).toBe('en'); expect(resolveLocale('system')).toBe('en');
  });
  it('has no browser-global import assumptions, tracks preference separately, and emits only resolved-language changes', () => {
    expect(typeof document).toBe('undefined'); let changes = 0; const dispose = onLocaleChange(() => changes++);
    initI18n('system', ['zh-CN']); expect(getLanguage()).toBe('system'); expect(getLocale()).toBe('zh-CN');
    setLanguage('zh-CN'); expect(changes).toBe(1); expect(getLanguage()).toBe('zh-CN');
    setLanguage('en'); expect(changes).toBe(2); dispose(); setLanguage('zh-CN'); expect(changes).toBe(2);
  });
  it('keeps domains independent, interpolates explicitly provided raw values once, and supports nested descriptors/literal braces', () => {
    const other = defineMessages('other', { greeting: 'Other {name}' }, { greeting: '另一位 {name}' });
    initI18n('en'); const raw = '<script>Apply {count} / feature/保存 / HEAD</script>';
    const descriptor = fixture.m('greeting', { name: raw }); expect(resolveText(descriptor)).toBe(`Hello ${raw}.`);
    expect(fixture.t('literal')).toBe('Use {repo} and {file}.'); expect(other.t('greeting', { name: 'A' })).toBe('Other A');
    setLanguage('zh-CN'); expect(resolveText(descriptor)).toBe(`你好，${raw}。`);
    expect(fixture.t('nested', { message: fixture.m('greeting', { name: raw }) })).toBe(`结果：你好，${raw}。`);
    expect(fixture.t('literal')).toBe('使用 {repo} 和 {file}。'); expect(fixture.t('repeated', { name: 'x' })).toBe('x：x');
  });
  it('rejects key/parameter drift at runtime for untyped inputs', () => {
    const untyped = defineMessages as unknown as (domain: string, en: Record<string, string>, zh: Record<string, string>) => unknown;
    expect(() => untyped('missing', { a: 'A' }, {})).toThrow('key mismatch');
    expect(() => untyped('extra', { a: 'A' }, { a: '一', b: '二' })).toThrow('key mismatch');
    expect(() => untyped('wrong', { a: '{name}' }, { a: '{other}' })).toThrow('parameter mismatch');
    expect(() => untyped('repeat', { a: '{name}, {name}' }, { a: '{name}' })).not.toThrow();
  });
});

describe('global-only device-local language persistence restrictions', () => {
  it('defaults legacy/malformed preferences to system while preserving supported explicit choices', () => {
    expect(DEFAULT_SETTINGS.language).toBe('system'); expect(normalizeSettings({}).language).toBe('system');
    for (const language of ['system', 'en', 'zh-CN'] as const) expect(normalizeSettings({ language }).language).toBe(language);
    for (const language of ['zh', 'EN', 'fr', '', null, true, 5]) expect(normalizeSettings({ language }).language).toBe('system');
    expect(normalizeState({ version: 1, settings: { language: 'zh-CN' } }).settings.language).toBe('zh-CN');
    expect(normalizeState({ version: 1, settings: {} }).settings.language).toBe('system');
  });
  it('rejects repository override and import language at every explicit schema boundary', () => {
    expect(GLOBAL_ONLY_SETTINGS).toContain('language'); expect(CONFIG_IMPORT_EXCLUDED_SETTINGS).toContain('language');
    expect(normalizeSettingsPatch({ language: 'zh-CN', theme: 'light' }, { scope: 'repository' })).toEqual({ theme: 'light' });
    expect(validateSettingsPatch({ language: 'en' }, 'repository').map(issue => issue.path)).toEqual(['language']);
    expect(prepareConfigImport({ version: 2, settings: { language: 'zh-CN', theme: 'light' } })).toMatchObject({ settings: { theme: 'light' } });
    expect(normalizeState({ settings: { language: 'en' }, repoSettings: { repo: { language: 'zh-CN', theme: 'light' } } }).repoSettings.repo).toEqual({ theme: 'light' });
  });
  it('persists only global language and ignores raw repository overrides without editing unrelated state', async () => {
    let saved: unknown; const store = new StateStore(async state => { saved = state; }, () => {});
    store.state.repoSettings.repo = { language: 'zh-CN', theme: 'light' };
    store.updateSettings({ language: 'en' }, null); expect(effectiveSettings(store.state, 'repo').language).toBe('en');
    store.updateSettings({ language: 'zh-CN', showTags: false }, 'other');
    expect(store.state.repoSettings.other).toEqual({ showTags: false }); await store.flush();
    expect(saved).toMatchObject({ settings: { language: 'en' } });
  });
  it('retains typed validation descriptors so an existing validation error changes language without guessing English', () => {
    initI18n('en'); const issues = validateSettingsPatch({ rowHeight: NaN, language: 'fr' });
    const text = settingsIssuesText(issues); expect(resolveText(text)).toContain('Expected a finite number.');
    setLanguage('zh-CN'); expect(resolveText(text)).toContain('应为有限数值。'); expect(issues[0].message).toContain('应为有限数值。');
  });
});

describe('locale-sensitive cached formatting and precise error summaries', () => {
  it('switches date/count formatters by locale without altering ISO values or Git search data', () => {
    const value = Date.UTC(2026, 10, 22, 10, 0), now = value + 2 * 86400_000;
    initI18n('en'); const relative = dateText(value, 'relative', now), full = fullDateText(value), count = numberText(12345.6);
    const en = resolveText(relative), enFull = resolveText(full), enCount = resolveText(count);
    expect(formatDate(value, 'iso')).toBe('2026-11-22 10:00:00'); expect(formatDate(value, 'iso-date')).toBe('2026-11-22');
    expect(enCount).toBe(new Intl.NumberFormat('en').format(12345.6));
    setLanguage('zh-CN'); expect(resolveText(relative)).not.toBe(en); expect(resolveText(relative)).toContain('天');
    expect(resolveText(full)).toBe(formatFullDate(value)); expect(resolveText(full)).not.toBe(enFull);
    expect(resolveText(count)).toBe(new Intl.NumberFormat('zh-CN').format(12345.6));
    expect(formatNumber(0.25, { style: 'percent' })).toBe('25%'); expect(formatDate(value, 'iso')).toBe('2026-11-22 10:00:00');
    expect(formatFullDate(NaN)).toBe('—');
  });
  it('translates only exact known codes and preserves every original raw message/detail', () => {
    const raw = { code: 'UNTRUSTED', message: 'raw Git/user path: 保存/Apply', detail: 'fatal: hook rejected {x}\nOID 123' };
    const descriptor = errorText(raw); initI18n('en'); expect(resolveText(descriptor)).toContain('Trust this repository');
    setLanguage('zh-CN'); expect(resolveText(descriptor)).toContain('请先信任此仓库');
    expect(resolveText(descriptor)).toContain(`${raw.message}\n${raw.detail}`);
    for (const code of ['ARGUMENT', 'SETTINGS']) {
      const message = errorMessage({ code, message: 'Do not infer a particular failure', detail: 'arbitrary 原文' });
      expect(message).toContain('请查看下方原始详情'); expect(message).toContain('Do not infer a particular failure\narbitrary 原文');
    }
    expect(errorMessage({ code: 'UNKNOWN', message: 'This is a raw English error', detail: 'unchanged' })).toBe('This is a raw English error\nunchanged');
    expect(errorMessage('Cancel')).toBe('Cancel'); expect(errorMessage(new Error('Use raw details'))).toBe('Use raw details');
  });
  it('uses stable action group/action IDs and preserves scope/reference names across translation', () => {
    const groups = ACTION_GROUPS.map(group => group.id); const ctx = { repo: null, settings: DEFAULT_SETTINGS, refs: [], remotes: [], stashes: [], selected: null, working: null } satisfies ActionContext;
    const actions = new GitActions({} as Host, { context: () => ctx, execute: async () => null, error: () => {}, changed: () => {}, toast: () => {} });
    initI18n('en'); expect(resolveText(ACTION_LABELS['branch-create'])).toBe('Create branch');
    const failure = actionPreflightText('merge', ctx)!; const item = actions.item('branch-create')!;
    setLanguage('zh-CN'); expect(resolveText(ACTION_LABELS['branch-create'])).toBe('创建分支'); expect(ACTION_GROUPS.map(group => group.id)).toEqual(groups);
    expect(item.dataAction).toBe('create-branch'); expect(resolveText(item.label)).toBe('创建分支'); expect(resolveText(failure)).toBe('请先打开仓库，再执行 Git 操作。');
    expect(resolveText(scopeText({ kind: 'refs', refs: ['refs/heads/Apply 保存'] }))).toBe('Apply 保存');
    expect(resolveText(scopeText({ kind: 'glob', include: ['feature/*'], exclude: ['feature/old'] }))).toBe('feature/*，排除 feature/old');
  });
});

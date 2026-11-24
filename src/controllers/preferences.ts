import { computed, shallowRef } from 'vue';
import { DEFAULT_SETTINGS, type AppSettings, type ConfigImport, type GithubUpdateInfo, type Host, type Repository, type SettingsPatch } from '../shared/protocol';
import { type Language, type Localizable, type Locale, resolveLocale } from '../lib/i18n';
import { GLOBAL_ONLY_SETTINGS, SETTINGS_BOUNDS, SETTINGS_ENUMS, isRecord, mergeSettingsPatches, normalizeSettings, normalizeSettingsPatch, prepareConfigImport, validateSettingsPatch, type SettingsIssue } from '../lib/settings-schema';
import { label, m as settingsMessage, type SettingLabelKey } from '../i18n/settings';
import { m } from '../i18n/vue-settings';

export type PreferenceScope = 'global' | 'repository';
export interface SettingsDialogProps {
  open: boolean;
  settings: AppSettings;
  globalSettings?: AppSettings;
  repoPatch?: SettingsPatch;
  scope?: PreferenceScope;
  repo?: Repository | null;
  host: Host;
  saveError?: string;
}
/** Repository patches replace the saved override object, so removed leaves resume inheritance. */
export interface SettingsSave { scope: PreferenceScope; patch: SettingsPatch }
export interface PreferenceInput { settings: AppSettings; globalSettings?: AppSettings; repoPatch?: SettingsPatch; scope?: PreferenceScope }
export interface SettingSpec {
  key: SettingLabelKey;
  kind: 'select' | 'number' | 'text' | 'checkbox' | 'json';
  choices?: readonly { value: string; text: Localizable }[];
  hint?: Localizable;
  min?: number;
  max?: number;
}

const optionText = {
  system: 'system', en: 'english', 'zh-CN': 'chinese', dark: 'dark', light: 'light', inline: 'inline', bottom: 'bottom', right: 'right',
  middle: 'localMiddle', unified: 'unified', split: 'split', curved: 'curved', angular: 'angular', relative: 'relative', iso: 'iso', local: 'local', date: 'date', 'iso-date': 'isoDate',
  author: 'author', committer: 'committer', topo: 'topo', 'author-date': 'authorDate', tree: 'tree', list: 'list', normal: 'normal', branches: 'branches', open: 'open', filled: 'filled',
  git: 'git', sign: 'sign', 'no-sign': 'noSign', recent: 'recent', name: 'name', path: 'path', none: 'none', hyphen: 'hyphen', underscore: 'underscore',
  lightweight: 'lightweight', annotated: 'annotated', 'ff-only': 'ffOnly', merge: 'merge', rebase: 'rebase', default: 'default', summary: 'summary', soft: 'soft', mixed: 'mixed', hard: 'hard', keep: 'keep',
} as const;
const nestedEnums: Record<string, readonly string[]> = {
  'dialogDefaults.tagType': ['lightweight', 'annotated'], 'dialogDefaults.pullMode': ['ff-only', 'merge', 'rebase'], 'dialogDefaults.squashMessage': ['default', 'summary'],
  'dialogDefaults.resetMode': ['soft', 'mixed', 'hard', 'keep'], 'dialogDefaults.worktreeResetMode': ['mixed', 'hard'],
};
const hints: Partial<Record<SettingLabelKey, Localizable>> = {
  fontSize: settingsMessage('fontHint'), graphColors: settingsMessage('paletteHint'), pageSize: settingsMessage('pageHint'), autoLoad: settingsMessage('autoHint'),
  startupScope: settingsMessage('startupHint', { all: '{"kind":"all"}', head: '{"kind":"head"}', refs: '{"kind":"refs","refs":["refs/heads/main"]}', glob: '{"kind":"glob","include":["feature/*"],"exclude":[]}' }),
  branchGroups: settingsMessage('groupsHint', { example: '[{"name":"Features","include":["feature/*"],"exclude":[]}]' }),
  encoding: settingsMessage('encodingHint'), avatars: settingsMessage('avatarsHint'), markdown: settingsMessage('markdownHint'),
  customEmoji: settingsMessage('emojiHint', { example: '{"reviewed":"OK"}' }), issueUrl: settingsMessage('issueHint'),
  issueRules: settingsMessage('rulesHint', { example: '[{"pattern":"TEAM-(\\\\d+)","url":"https://issues.example/TEAM-{id}"}]' }), pullRequestUrl: settingsMessage('prHint'),
  pullRequestProviders: settingsMessage('providerHint', { example: '[{"name":"GitLab","host":"git.example.com","url":"{baseUrl}/-/merge_requests/new?source={source}&target={target}"}]' }),
  defaultRemote: settingsMessage('remoteHint'), confirmCheckout: settingsMessage('checkoutHint'), discoveryDepth: settingsMessage('discoveryHint'), gitPath: settingsMessage('gitHint'),
  editorPath: settingsMessage('editorHint'), editorArgs: settingsMessage('editorArgsHint'), terminalPath: settingsMessage('terminalHint'), terminalArgs: settingsMessage('terminalArgsHint'),
  'dialogDefaults.forceDelete': settingsMessage('forceDeleteHint'), 'dialogDefaults.forceFetch': settingsMessage('forceFetchHint'), 'dialogDefaults.fetchPruneTags': settingsMessage('pruneHint'),
  'shortcuts.find': settingsMessage('shortcutHint'), contextActions: settingsMessage('contextHint', { example: '{"branch":["checkout","branch-rename","branch-delete"]}' }), hiddenActions: m('hiddenHint'),
};
export function settingValue(settings: AppSettings | SettingsPatch, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => isRecord(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined, settings);
}
function spec(key: SettingLabelKey): SettingSpec {
  const base = settingValue(DEFAULT_SETTINGS, key);
  const enums = SETTINGS_ENUMS[key as keyof typeof SETTINGS_ENUMS] ?? nestedEnums[key];
  const bounds = SETTINGS_BOUNDS[key as keyof typeof SETTINGS_BOUNDS] ?? (key.startsWith('columnWidths.') ? [60, key === 'columnWidths.graph' ? 640 : 400] : undefined);
  return {
    key, kind: enums ? 'select' : typeof base === 'boolean' ? 'checkbox' : bounds ? 'number' : typeof base === 'string' ? 'text' : 'json', hint: hints[key],
    ...(enums ? { choices: enums.map(value => ({ value, text: settingsMessage(key === 'localChangesPosition' && value === 'inline' ? 'localInline' : key === 'order' && value === 'date' ? 'commitDate' : key === 'tagSigning' && value === 'sign' ? 'signTags' : optionText[value as keyof typeof optionText]) })) } : {}),
    ...(bounds ? { min: bounds[0], max: bounds[1] } : {}),
  };
}
export const SETTINGS_SECTIONS = [
  { id: 'appearance', keys: ['language', 'theme', 'detailPosition', 'localChangesPosition', 'diffView', 'graphStyle', 'fontSize', 'rowHeight', 'graphColors', 'labelAlignment', 'combineLabels', 'muteMerges', 'muteNonAncestors', 'uncommittedStyle', 'signatureDisplay'] },
  { id: 'history', keys: ['dateSource', 'dateFormat', 'order', 'initialLoad', 'loadMore', 'pageSize', 'autoLoad', 'showRemotes', 'showRemoteHeads', 'showTags', 'includeTagOnly', 'showStashes', 'collapseStashAuxiliary', 'showUncommitted', 'showUntracked', 'firstParent', 'includeReflog', 'scrollToHead', 'autoCenterDetails', 'startupScope', 'branchGroups'] },
  { id: 'files', keys: ['fileView', 'compactFolders', 'mailmap', 'encoding', 'avatars'] },
  { id: 'messages', keys: ['markdown', 'emoji', 'customEmoji', 'issueUrl', 'issueRules', 'pullRequestUrl', 'pullRequestProviders'] },
  { id: 'tools', keys: ['defaultRemote', 'confirmCheckout', 'commitSigning', 'tagSigning', 'referenceSpace', 'repositorySort', 'discoveryDepth', 'gitPath', 'editorPath', 'editorArgs', 'terminalPath', 'terminalArgs'] },
  { id: 'defaults', keys: Object.keys(DEFAULT_SETTINGS.dialogDefaults).map(key => `dialogDefaults.${key}`) },
  { id: 'shortcuts', keys: ['shortcuts.find', 'shortcuts.refresh', 'shortcuts.head', 'shortcuts.stash'] },
  { id: 'columns', keys: ['columns.date', 'columns.author', 'columns.commit', 'columnWidths.graph', 'columnWidths.date', 'columnWidths.author', 'columnWidths.commit', 'hiddenActions', 'contextActions'] },
].map(section => ({ id: section.id, title: settingsMessage(section.id as 'appearance'), specs: (section.keys as SettingLabelKey[]).map(spec) }));
export const SETTINGS_SPECS = SETTINGS_SECTIONS.flatMap(section => section.specs);
export function importSettingLabel(key: string): Localizable {
  if (key === 'columns') return settingsMessage('columns');
  if (key === 'columnWidths') return m('columnWidths');
  if (key === 'dialogDefaults') return settingsMessage('defaults');
  if (key === 'shortcuts') return settingsMessage('shortcuts');
  return label(key as SettingLabelKey);
}

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function pathPatch(path: string, value: unknown): SettingsPatch {
  const [key, child] = path.split('.');
  return { [key]: child ? { [child]: value } : value } as SettingsPatch;
}
function replaceAt(settings: AppSettings | SettingsPatch, path: string, value: unknown): SettingsPatch {
  const next = clone(settings) as unknown as Record<string, unknown>;
  const [key, child] = path.split('.');
  if (child) next[key] = { ...(isRecord(next[key]) ? next[key] as Record<string, unknown> : {}), [child]: clone(value) };
  else next[key] = clone(value);
  return next as SettingsPatch;
}
function without(settings: SettingsPatch, path: string): SettingsPatch {
  const next = clone(settings) as Record<string, unknown>; const [key, child] = path.split('.');
  if (child && isRecord(next[key])) { delete next[key][child]; if (!Object.keys(next[key]).length) delete next[key]; }
  else delete next[key];
  return next as SettingsPatch;
}

/** No Host, DOM, timers or persistence. Drafts are replaced rather than cloned from Vue proxies. */
export function createPreferencesDraft(input: PreferenceInput) {
  const scope = shallowRef<PreferenceScope>('global');
  const global = shallowRef<AppSettings>(normalizeSettings(input.globalSettings ?? input.settings));
  const overrides = shallowRef<SettingsPatch>({});
  const edits = shallowRef<SettingsPatch>({});
  const raw = shallowRef<Record<string, string>>({});
  const errors = shallowRef<Record<string, readonly Localizable[]>>({});
  const baseline = shallowRef('{}');
  const base = computed(() => scope.value === 'global' ? global.value : normalizeSettings(overrides.value, global.value, { scope: 'repository' }));
  // Top-level JSON map editors replace their entire map; nested ordinary fields merge by leaf.
  const effective = computed(() => {
    const merged = normalizeSettings(edits.value, base.value);
    for (const key of ['customEmoji', 'contextActions'] as const) if (edits.value[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = clone(edits.value[key]);
    return merged;
  });
  function reset(next: PreferenceInput): void {
    scope.value = next.scope ?? 'global';
    global.value = normalizeSettings(next.globalSettings ?? next.settings);
    overrides.value = normalizeSettingsPatch(next.repoPatch, { scope: 'repository' });
    edits.value = {}; raw.value = {}; errors.value = {};
    baseline.value = JSON.stringify(scope.value === 'repository' ? overrides.value : {});
  }
  reset(input);
  const patch = computed<SettingsPatch>(() => {
    if (scope.value === 'global') return normalizeSettingsPatch(edits.value, { scope: 'global' });
    const out = mergeSettingsPatches(overrides.value, edits.value);
    for (const key of ['customEmoji', 'contextActions'] as const) if (edits.value[key] !== undefined) (out as Record<string, unknown>)[key] = clone(edits.value[key]);
    return normalizeSettingsPatch(out, { scope: 'repository' });
  });
  const dirty = computed(() => Object.keys(errors.value).length > 0 || JSON.stringify(patch.value) !== baseline.value);
  function isGlobalOnly(path: string): boolean { return GLOBAL_ONLY_SETTINGS.includes(path.split('.')[0] as keyof AppSettings); }
  function overridden(path: string): boolean { return settingValue(patch.value, path) !== undefined; }
  function error(path: string, issues: readonly SettingsIssue[]): void {
    const next = { ...errors.value };
    if (issues.length) next[path] = issues.map(issue => issue.text); else delete next[path];
    errors.value = next;
  }
  function set(path: SettingLabelKey, value: unknown): boolean {
    if (!SETTINGS_SPECS.some(item => item.key === path)) return false;
    if (scope.value === 'repository' && isGlobalOnly(path)) return false;
    const part = pathPatch(path, value); const issues = validateSettingsPatch(part, scope.value); error(path, issues);
    if (issues.length) return false;
    edits.value = replaceAt(edits.value, path, settingValue(normalizeSettingsPatch(part, { scope: scope.value }), path));
    return true;
  }
  function update(spec: SettingSpec, value: string | boolean): boolean {
    if (typeof value === 'string') raw.value = { ...raw.value, [spec.key]: value };
    if (spec.kind === 'json') {
      try { return set(spec.key, JSON.parse(String(value))); }
      catch { errors.value = { ...errors.value, [spec.key]: [settingsMessage('validJson', { label: label(spec.key) })] }; return false; }
    }
    return set(spec.key, spec.kind === 'number' ? String(value).trim() ? Number(value) : NaN : value);
  }
  function inherit(path: SettingLabelKey): void {
    if (scope.value !== 'repository' || isGlobalOnly(path)) return;
    overrides.value = without(overrides.value, path); edits.value = without(edits.value, path);
    const nextRaw = { ...raw.value }; delete nextRaw[path]; raw.value = nextRaw; error(path, []);
  }
  function text(spec: SettingSpec): string {
    if (raw.value[spec.key] !== undefined) return raw.value[spec.key];
    const value = settingValue(effective.value, spec.key);
    return spec.kind === 'json' ? JSON.stringify(value, null, 2) : String(value ?? '');
  }
  function stageImport(preview: ConfigImport, selected: readonly string[]): void {
    for (const key of selected) {
      if (!Object.prototype.hasOwnProperty.call(preview.settings, key)) continue;
      // Do not trust a host's claimed preview, and revalidate at the final staging boundary.
      const safe = prepareConfigImport({ version: 2, settings: { [key]: preview.settings[key as keyof AppSettings] } });
      if (!Object.prototype.hasOwnProperty.call(safe.settings, key)) continue;
      for (const found of SETTINGS_SPECS.filter(spec => spec.key === key || spec.key.startsWith(`${key}.`))) {
        const value = settingValue(safe.settings, found.key);
        if (value !== undefined && set(found.key, value)) {
          const next = { ...raw.value }; delete next[found.key]; raw.value = next;
        }
      }
    }
  }
  function checkpoint() { return { scope: scope.value, global: global.value, overrides: overrides.value, edits: edits.value, raw: raw.value, errors: errors.value, baseline: baseline.value }; }
  function restore(saved: ReturnType<typeof checkpoint>): void {
    scope.value = saved.scope; global.value = saved.global; overrides.value = saved.overrides; edits.value = saved.edits;
    raw.value = saved.raw; errors.value = saved.errors; baseline.value = saved.baseline;
  }
  return { scope, global, effective, patch, raw, errors, dirty, reset, set, update, inherit, overridden, isGlobalOnly, text, stageImport, checkpoint, restore };
}

/** Reactively resolve explicit device language without mutating shared i18n from an uncommitted draft. */
export function settingsLocale(language: Language, systemLanguages?: readonly string[]): Locale {
  return resolveLocale(language, systemLanguages ?? (typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]));
}

const MAX_NOTES_BYTES = 16 * 1024;
function version(value: unknown, stable = false): string | null {
  if (typeof value !== 'string' || value.length > 128) return null;
  const match = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  return !match || match[0] !== value || stable && match[2] || match[2]?.split('.').some(part => /^0\d+$/.test(part)) ? null : value.replace(/^v/, '');
}
/** Updates are narrower than ordinary links: exactly this application's fixed official tag URL. */
export function officialVueReleaseUrl(info: Pick<GithubUpdateInfo, 'status' | 'latestVersion' | 'releaseTag' | 'releaseUrl'>): string | null {
  if (!['available', 'current'].includes(info.status)) return null;
  const tag = version(info.releaseTag, true), latest = version(info.latestVersion, true);
  if (!tag || tag !== latest) return null;
  const expected = `https://github.com/Memento1990/QGitGraph/releases/tag/${info.releaseTag}`;
  return info.releaseUrl === expected ? expected : null;
}
export function validateVueRelease(value: unknown): GithubUpdateInfo | null {
  if (!isRecord(value) || !version(value.currentVersion) || typeof value.notesTruncated !== 'boolean') return null;
  if (value.status === 'unsupported' || value.status === 'no-release') {
    if (['latestVersion', 'releaseTag', 'releaseUrl', 'publishedAt', 'releaseNotes'].some(key => value[key] !== null) || value.notesTruncated) return null;
    return { status: value.status, currentVersion: value.currentVersion as string, latestVersion: null, releaseTag: null, releaseUrl: null, publishedAt: null, releaseNotes: null, notesTruncated: false };
  }
  if (value.status !== 'available' && value.status !== 'current') return null;
  if (value.publishedAt !== null && (typeof value.publishedAt !== 'string' || value.publishedAt.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value.publishedAt) || !Number.isFinite(Date.parse(value.publishedAt)))) return null;
  if (value.releaseNotes !== null && typeof value.releaseNotes !== 'string') return null;
  const info = value as unknown as GithubUpdateInfo;
  if (!officialVueReleaseUrl(info)) return null;
  const bytes = new TextEncoder().encode((info.releaseNotes ?? '').slice(0, MAX_NOTES_BYTES));
  let end = Math.min(bytes.length, MAX_NOTES_BYTES); if (end < bytes.length) while ((bytes[end] & 0xc0) === 0x80) end--;
  const notes = new TextDecoder().decode(bytes.subarray(0, end));
  return { status: info.status, currentVersion: info.currentVersion, latestVersion: info.latestVersion, releaseTag: info.releaseTag, releaseUrl: info.releaseUrl, publishedAt: info.publishedAt, releaseNotes: info.releaseNotes === null ? null : notes, notesTruncated: info.notesTruncated || info.releaseNotes !== null && notes !== info.releaseNotes };
}

import { DEFAULT_SETTINGS, type AppSettings, type ConfigImport, type HistoryScope, type SettingsPatch } from '../shared/protocol';

export type SettingsScope = 'global' | 'repository' | 'import';
export interface SettingsIssue { path: string; message: string }
export interface SettingsNormalizeOptions { scope?: SettingsScope; legacyPageSize?: boolean }

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];
export const GLOBAL_ONLY_SETTINGS: readonly (keyof AppSettings)[] = ['gitPath'];
export const CONFIG_IMPORT_EXCLUDED_SETTINGS: readonly (keyof AppSettings)[] = ['gitPath', 'editorPath', 'terminalPath', 'editorArgs', 'terminalArgs', 'avatars'];
export const SETTINGS_BOUNDS = {
  pageSize: [10, 1000], initialLoad: [10, 1000], loadMore: [10, 1000],
  rowHeight: [22, 60], fontSize: [11, 20], discoveryDepth: [0, 5],
} as const;
export const SETTINGS_ENUMS = {
  theme: ['dark', 'light', 'system'], detailPosition: ['inline', 'bottom', 'right'],
  diffView: ['unified', 'split'], graphStyle: ['curved', 'angular'],
  dateFormat: ['relative', 'iso', 'local', 'date', 'iso-date'], dateSource: ['author', 'committer'],
  order: ['topo', 'date', 'author-date'], fileView: ['tree', 'list'],
  labelAlignment: ['normal', 'branches', 'right'], uncommittedStyle: ['open', 'filled'],
  commitSigning: ['git', 'sign', 'no-sign'], tagSigning: ['git', 'sign', 'no-sign'],
  repositorySort: ['recent', 'name', 'path'], referenceSpace: ['none', 'hyphen', 'underscore'],
} as const;
export const ACTION_KINDS = [
  'branch-create', 'branch-rename', 'branch-delete', 'checkout', 'merge', 'rebase', 'cherry-pick',
  'revert', 'drop', 'reset', 'tag-create', 'tag-delete', 'tag-push', 'stash-save', 'stash-apply',
  'stash-pop', 'stash-drop', 'stash-branch', 'fetch', 'pull', 'push', 'remote-add', 'remote-edit',
  'remote-remove', 'prune', 'set-upstream', 'clean', 'continue', 'abort', 'commit', 'identity',
  'remote-branch-delete', 'fetch-into', 'checkout-remote',
] as const;
export const ISSUE_TEMPLATE_PLACEHOLDERS = ['id', 'commit', 'branch', 'match'] as const;
export const PR_TEMPLATE_PLACEHOLDERS = ['id', 'commit', 'branch', 'source', 'target', 'owner', 'repo', 'host', 'baseUrl', 'remoteWebBase', 'remote'] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const safeKey = (key: string): boolean => key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
const boundedText = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

/** Accept only HTTP(S), with no credentials, control characters, backslashes or variable authority. */
export function safeHttpUrl(value: string): string | null {
  if (!value || value.length > 8192 || /[\s\u0000-\u001f\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && Boolean(url.hostname) ? url.href : null;
  } catch { return null; }
}
export function validateUrlTemplate(value: unknown, placeholders: readonly string[] = ISSUE_TEMPLATE_PLACEHOLDERS, allowEmpty = true): string | null {
  if (!boundedText(value)) return 'Use a URL of at most 4096 characters without control characters.';
  if (!value) return allowEmpty ? null : 'A URL template is required.';
  const names = [...value.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
  if (names.some(name => !placeholders.includes(name)) || /[{}]/.test(value.replace(/\{[^{}]+\}/g, ''))) return `Supported placeholders: ${placeholders.map(name => `{${name}}`).join(', ')}.`;
  const expanded = value.replace(/\{([^{}]+)\}/g, (_match, name: string) => ['baseUrl', 'remoteWebBase', 'remote'].includes(name) ? 'https://example.invalid/owner/repository' : 'example');
  if (!safeHttpUrl(expanded)) return 'Use an HTTP/HTTPS URL without credentials, spaces or backslashes.';
  const withoutBase = value.replace(/^\{(?:baseUrl|remoteWebBase|remote)\}/, 'https://example.invalid/owner/repository');
  const authority = /^https?:\/\/([^/?#]+)/i.exec(withoutBase)?.[1];
  if (!authority || /[{}]/.test(authority)) return 'The URL scheme and host must be fixed; placeholders are allowed only in the path, query or fragment.';
  return null;
}

/** A deliberately small issue-regexp language: literal prefix + ONE decimal capture + literal suffix.
 * Optional \\b boundaries and ^/$ anchors are supported. No user regex is ever executed. */
export interface IssuePattern { prefix: string; suffix: string; boundaryStart: boolean; boundaryEnd: boolean; start: boolean; end: boolean }
export function parseIssuePattern(pattern: string): IssuePattern | null {
  if (!boundedText(pattern, 128)) return null;
  let text = pattern; let start = false; let end = false; let boundaryStart = false; let boundaryEnd = false;
  if (text.startsWith('^')) { start = true; text = text.slice(1); }
  if (text.startsWith('\\b')) { boundaryStart = true; text = text.slice(2); }
  if (text.endsWith('$') && !text.endsWith('\\$')) { end = true; text = text.slice(0, -1); }
  if (text.endsWith('\\b')) { boundaryEnd = true; text = text.slice(0, -2); }
  const captures = ['(\\d+)', '([0-9]+)'];
  const marker = captures.find(capture => text.includes(capture));
  if (!marker) return null;
  const at = text.indexOf(marker);
  function literal(value: string): string | null {
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '\\') {
        const next = value[++i];
        if (!next || !'\\.^$|?*+()[]{}#-'.includes(next)) return null;
        out += next;
      } else { if ('.^$|?*+()[]{}'.includes(char)) return null; out += char; }
    }
    return out;
  }
  const prefix = literal(text.slice(0, at)); const suffix = literal(text.slice(at + marker.length));
  if (prefix === null || suffix === null || (!prefix && !suffix)) return null;
  return { prefix, suffix, boundaryStart, boundaryEnd, start, end };
}
export function validateIssuePattern(value: unknown): string | null {
  return typeof value === 'string' && parseIssuePattern(value) ? null : 'Use a literal prefix and one (\\d+) or ([0-9]+) capture, for example #(\\d+) or TEAM-(\\d+). Optional \\b and ^/$ boundaries are supported; arbitrary regex is not.';
}
export function validateToolExecutable(value: unknown): string | null {
  if (!boundedText(value) || /[|&;<>`"{}]/.test(value)) return 'Use an executable path, not a quoted path, template or shell command.';
  if (value && /\s/.test(value) && !/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(value)) return 'Paths containing spaces must be absolute. Do not add shell arguments to the executable path.';
  return null;
}
export function validateToolArgs(value: unknown, tool: 'editor' | 'terminal'): string | null {
  if (!Array.isArray(value) || value.length > 32) return 'Use a JSON array of at most 32 argument strings; each item is passed as one argument, never through a shell.';
  const allowed = tool === 'editor' ? ['repo', 'file', 'line', 'column'] : ['repo'];
  for (const arg of value) {
    if (!boundedText(arg)) return 'Arguments must be strings of at most 4096 characters without control characters.';
    const names = [...arg.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
    if (names.some(name => !allowed.includes(name)) || /[{}]/.test(arg.replace(/\{[^{}]+\}/g, ''))) return `Supported ${tool} argument placeholders: ${allowed.map(name => `{${name}}`).join(', ')}.`;
  }
  return null;
}
export function validateShortcut(value: unknown): string | null {
  if (!boundedText(value, 64)) return 'Use a short keyboard shortcut, for example Ctrl+F.';
  if (!value) return null;
  const parts = value.split('+').map(part => part.trim()); const key = parts.pop() ?? '';
  const modifiers = ['ctrl', 'control', 'alt', 'option', 'shift', 'meta', 'cmd', 'command', 'mod', 'primary'];
  if (!parts.every(part => modifiers.includes(part.toLowerCase())) || new Set(parts.map(part => part.toLowerCase())).size !== parts.length || !(/^[^\s+]$/.test(key) || /^(?:F(?:[1-9]|1\d|2[0-4])|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Enter|Return|Escape|Esc|Tab|Space|Backspace|Delete|Insert)$/i.test(key))) return 'Use modifiers joined with + and one key, for example Ctrl+Shift+F or F5. Empty disables the shortcut.';
  return null;
}

const DIALOG_ENUMS: Record<string, readonly string[]> = {
  tagType: ['lightweight', 'annotated'], pullMode: ['ff-only', 'merge', 'rebase'],
  squashMessage: ['default', 'summary'], resetMode: ['soft', 'mixed', 'hard', 'keep'], worktreeResetMode: ['mixed', 'hard'],
};
function normalize(input: unknown, options: SettingsNormalizeOptions): { patch: SettingsPatch; issues: SettingsIssue[] } {
  const output: Record<string, unknown> = {}; const issues: SettingsIssue[] = [];
  const issue = (path: string, message: string): void => { issues.push({ path, message }); };
  if (!isRecord(input)) { if (input !== undefined && input !== null) issue('settings', 'Expected a settings object.'); return { patch: {}, issues }; }
  function strings(value: unknown, path: string, maxItems = 64, maxLength = 256): string[] | undefined {
    if (!Array.isArray(value)) { issue(path, 'Expected an array of strings.'); return undefined; }
    if (value.length > maxItems) issue(path, `Use at most ${maxItems} items.`);
    const out: string[] = [];
    for (const [index, item] of value.slice(0, maxItems).entries()) {
      if (boundedText(item, maxLength) && item) out.push(item); else issue(`${path}.${index}`, 'Expected a nonempty string without control characters.');
    }
    return [...new Set(out)];
  }
  function nested(value: unknown, path: string, defaults: Record<string, unknown>): Record<string, unknown> | undefined {
    if (!isRecord(value)) { issue(path, 'Expected an object.'); return undefined; }
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!safeKey(key) || !own(defaults, key)) { issue(`${path}.${key}`, 'Unknown setting.'); continue; }
      const base = defaults[key];
      if (typeof base === 'boolean') { if (typeof item === 'boolean') out[key] = item; else issue(`${path}.${key}`, 'Expected true or false.'); }
      else if (path === 'columnWidths') {
        if (typeof item !== 'number' || !Number.isFinite(item)) { issue(`${path}.${key}`, 'Expected a finite number.'); continue; }
        const max = key === 'graph' ? 640 : 400;
        if (item < 60 || item > max || !Number.isInteger(item)) issue(`${path}.${key}`, `Use a whole number between 60 and ${max}.`);
        out[key] = Math.max(60, Math.min(max, Math.round(item)));
      } else if (path === 'shortcuts') { const error = validateShortcut(item); if (error) issue(`${path}.${key}`, error); else out[key] = item; }
      else { const choices = DIALOG_ENUMS[key]; if (typeof item === 'string' && choices?.includes(item)) out[key] = item; else issue(`${path}.${key}`, `Choose ${choices?.join(', ') ?? 'a valid value'}.`); }
    }
    return out;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!safeKey(key) || !SETTING_KEYS.includes(key as keyof AppSettings)) { issue(key, 'Unknown setting; it is not imported or persisted.'); continue; }
    if (options.scope === 'repository' && GLOBAL_ONLY_SETTINGS.includes(key as keyof AppSettings)) { issue(key, 'This setting is global only.'); continue; }
    if (options.scope === 'import' && CONFIG_IMPORT_EXCLUDED_SETTINGS.includes(key as keyof AppSettings)) { issue(key, 'Executable paths and tool arguments are not imported.'); continue; }
    const enumValues = SETTINGS_ENUMS[key as keyof typeof SETTINGS_ENUMS] as readonly string[] | undefined;
    const bounds = SETTINGS_BOUNDS[key as keyof typeof SETTINGS_BOUNDS];
    if (enumValues) { if (typeof value === 'string' && enumValues.includes(value)) output[key] = value; else issue(key, `Choose ${enumValues.join(', ')}.`); }
    else if (bounds) {
      if (typeof value !== 'number' || !Number.isFinite(value)) { issue(key, 'Expected a finite number.'); continue; }
      if (value < bounds[0] || value > bounds[1] || !Number.isInteger(value)) issue(key, `Use a whole number between ${bounds[0]} and ${bounds[1]}.`);
      output[key] = Math.max(bounds[0], Math.min(bounds[1], Math.round(value)));
    } else if (typeof DEFAULT_SETTINGS[key as keyof AppSettings] === 'boolean') {
      if (typeof value === 'boolean') output[key] = value; else issue(key, 'Expected true or false.');
    } else if (['columns', 'columnWidths', 'shortcuts', 'dialogDefaults'].includes(key)) {
      const result = nested(value, key, DEFAULT_SETTINGS[key as 'columns' | 'columnWidths' | 'shortcuts' | 'dialogDefaults'] as unknown as Record<string, unknown>);
      if (result) output[key] = result;
    } else if (key === 'gitPath' || key === 'editorPath' || key === 'terminalPath') {
      const error = validateToolExecutable(value); if (error) issue(key, error); else output[key] = value;
    } else if (key === 'editorArgs' || key === 'terminalArgs') {
      const error = validateToolArgs(value, key === 'editorArgs' ? 'editor' : 'terminal'); if (error) issue(key, error); else output[key] = [...value as string[]];
    } else if (key === 'issueUrl' || key === 'pullRequestUrl') {
      const error = validateUrlTemplate(value, key === 'issueUrl' ? ISSUE_TEMPLATE_PLACEHOLDERS : PR_TEMPLATE_PLACEHOLDERS); if (error) issue(key, error); else output[key] = value;
    } else if (key === 'graphColors') {
      if (!Array.isArray(value) || !value.length || value.length > 32 || !value.every(color => typeof color === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color))) issue(key, 'Use 1–32 hexadecimal CSS colors, for example ["#80b8e5", "#9bc487"].');
      else output[key] = [...value];
    } else if (key === 'hiddenActions') {
      const result = strings(value, key, 100, 64);
      if (result) output[key] = result.filter(kind => { if ((ACTION_KINDS as readonly string[]).includes(kind)) return true; issue(key, `Unknown action: ${kind}.`); return false; });
    } else if (key === 'customEmoji' || key === 'contextActions') {
      const limit = key === 'customEmoji' ? 1000 : 20;
      if (!isRecord(value) || Object.keys(value).length > limit) { issue(key, `Expected an object with at most ${limit} entries.`); continue; }
      const result: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(value)) {
        if (!safeKey(name) || !(key === 'customEmoji' ? /^[a-z\d_+-]{1,80}$/i : /^(?:branch|remote|remoteBranch|commit|tag|stash|worktree)$/).test(name)) { issue(`${key}.${name}`, 'Invalid shortcode or menu context.'); continue; }
        if (key === 'customEmoji') { if (boundedText(entry, 100) && entry) result[name] = entry; else issue(`${key}.${name}`, 'Use nonempty Unicode text of at most 100 characters, not an image URL.'); }
        else {
          const actions = strings(entry, `${key}.${name}`, 100, 64);
          if (actions) result[name] = actions.filter(action => { if ((ACTION_KINDS as readonly string[]).includes(action)) return true; issue(`${key}.${name}`, `Unknown action: ${action}.`); return false; });
        }
      }
      output[key] = result;
    } else if (key === 'startupScope') {
      const result = normalizeHistoryScope(value);
      if (result) output[key] = result; else issue(key, 'Use {"kind":"all"}, {"kind":"head"}, {"kind":"refs","refs":["refs/heads/main"]} or {"kind":"glob","include":["feature/*"],"exclude":[]}.');
    } else if (key === 'branchGroups') {
      if (!Array.isArray(value) || value.length > 100) { issue(key, 'Use at most 100 branch groups.'); continue; }
      const result: AppSettings['branchGroups'] = []; const names = new Set<string>();
      for (const [index, group] of value.entries()) {
        if (!isRecord(group) || !boundedText(group.name, 120) || !group.name.trim() || names.has(group.name)) { issue(`${key}.${index}`, 'Each branch group needs a nonempty unique name.'); continue; }
        const include = group.include === undefined ? [] : strings(group.include, `${key}.${index}.include`, 100, 1024);
        const exclude = group.exclude === undefined ? [] : strings(group.exclude, `${key}.${index}.exclude`, 100, 1024);
        if (!include || !exclude || [...include, ...exclude].some(pattern => pattern.startsWith('-'))) { issue(`${key}.${index}`, 'Branch patterns cannot start with a dash.'); continue; }
        names.add(group.name); result.push({ name: group.name, include, exclude });
      }
      output[key] = result;
    } else if (key === 'issueRules') {
      if (!Array.isArray(value) || value.length > 30) { issue(key, 'Use at most 30 issue rules.'); continue; }
      const result: AppSettings['issueRules'] = [];
      for (const [index, rule] of value.entries()) {
        if (!isRecord(rule)) { issue(`${key}.${index}`, 'Expected {pattern, url}.'); continue; }
        const error = validateIssuePattern(rule.pattern) ?? validateUrlTemplate(rule.url, ISSUE_TEMPLATE_PLACEHOLDERS, false);
        if (error) issue(`${key}.${index}`, error); else result.push({ pattern: rule.pattern as string, url: rule.url as string });
      }
      output[key] = result;
    } else if (key === 'pullRequestProviders') {
      if (!Array.isArray(value) || value.length > 30) { issue(key, 'Use at most 30 providers.'); continue; }
      const result: AppSettings['pullRequestProviders'] = [];
      for (const [index, provider] of value.entries()) {
        if (!isRecord(provider) || !boundedText(provider.name, 120) || !provider.name || !boundedText(provider.host, 253) || !/^(?:[a-z\d](?:[a-z\d.-]*[a-z\d])?)(?::\d{1,5})?$/i.test(provider.host)) { issue(`${key}.${index}`, 'Expected {name, host, url}; host is a literal hostname, optionally with a port, not a URL or wildcard.'); continue; }
        const error = validateUrlTemplate(provider.url, PR_TEMPLATE_PLACEHOLDERS, false);
        if (error) issue(`${key}.${index}.url`, error); else result.push({ name: provider.name, host: provider.host.toLowerCase(), url: provider.url as string });
      }
      output[key] = result;
    } else {
      if (boundedText(value, key === 'encoding' || key === 'defaultRemote' ? 128 : 4096)) output[key] = value;
      else issue(key, 'Expected a string without control characters.');
    }
  }
  if (options.legacyPageSize && own(output, 'pageSize')) {
    if (!own(input, 'initialLoad')) output.initialLoad = output.pageSize;
    if (!own(input, 'loadMore')) output.loadMore = output.pageSize;
  }
  return { patch: output as SettingsPatch, issues };
}
export function normalizeHistoryScope(value: unknown): HistoryScope | null {
  if (!isRecord(value) || !['all', 'head', 'refs', 'glob'].includes(String(value.kind)) || Object.keys(value).some(key => !['kind', 'refs', 'include', 'exclude'].includes(key))) return null;
  const result: HistoryScope = { kind: value.kind as HistoryScope['kind'] };
  for (const key of ['refs', 'include', 'exclude'] as const) {
    if (value[key] === undefined) continue;
    const items = value[key];
    if (!Array.isArray(items) || items.length > 2048 || !items.every(item => boundedText(item, 1024) && item && !item.startsWith('-'))) return null;
    result[key] = [...new Set(items as string[])];
  }
  return result;
}
export function normalizeSettingsPatch(input: unknown, options: SettingsNormalizeOptions = {}): SettingsPatch { return normalize(input, options).patch; }
export function validateSettingsPatch(input: unknown, scope: SettingsScope = 'global'): SettingsIssue[] { return normalize(input, { scope }).issues; }

/** Objects merge at leaves; arrays replace. Only allowlisted schema keys survive normalization. */
export function mergeSettingsPatches(base: SettingsPatch, patch: SettingsPatch): SettingsPatch {
  const out: Record<string, unknown> = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (!safeKey(key)) continue;
    out[key] = isRecord(value) && isRecord(out[key]) ? { ...out[key] as Record<string, unknown>, ...structuredClone(value) } : structuredClone(value);
  }
  return out as SettingsPatch;
}
export function normalizeSettings(input: unknown, base: AppSettings = DEFAULT_SETTINGS, options: SettingsNormalizeOptions = {}): AppSettings {
  const cleanBase = mergeSettingsPatches(structuredClone(DEFAULT_SETTINGS), normalizeSettingsPatch(base));
  return mergeSettingsPatches(cleanBase, normalizeSettingsPatch(input, options)) as AppSettings;
}

/** Import data cannot change trust, recents, state, executables, or tool launch arguments. */
export function prepareConfigImport(input: unknown): ConfigImport {
  if (!isRecord(input) || !isRecord(input.settings)) return { version: 2, settings: {}, warnings: ['The import contains no settings object.'] };
  const { patch, issues } = normalize(input.settings, { scope: 'import', legacyPageSize: input.version === 1 });
  const warnings = Array.isArray(input.warnings) ? input.warnings.filter((warning): warning is string => boundedText(warning, 4096)).slice(0, 100) : [];
  for (const key of Object.keys(input)) if (!['version', 'settings', 'warnings'].includes(key)) warnings.push(`${key}: device state is not imported.`);
  return { version: 2, settings: patch, warnings: [...warnings, ...issues.map(entry => `${entry.path}: ${entry.message}`)] };
}

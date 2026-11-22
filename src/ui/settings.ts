import type { AppSettings, Diagnostics, Host, Repository, SettingsPatch } from '../shared/protocol';
import { DEFAULT_SETTINGS } from '../shared/protocol';
import { errorMessage } from '../lib/format';
import { effectiveSettings, mergeSettings, type StateStore } from '../lib/state';
import { GLOBAL_ONLY_SETTINGS, SETTINGS_BOUNDS, isRecord, prepareConfigImport, validateSettingsPatch } from '../lib/settings-schema';
import { ACTION_GROUPS, ACTION_LABELS } from './actions';
import { button, checkbox, confirmDialog, el, field, formDialog, input, select } from './dom';
import { UpdateCheck } from './updates';

interface SettingSpec { key: string; label: string; kind: 'select' | 'number' | 'text' | 'checkbox' | 'json'; choices?: readonly string[]; labels?: string[]; hint?: string; min?: number; max?: number }
const check = (key: string, label: string, hint?: string): SettingSpec => ({ key, label, hint, kind: 'checkbox' });
const json = (key: string, label: string, hint: string): SettingSpec => ({ key, label, hint, kind: 'json' });
const choice = (key: string, label: string, choices: string[], labels?: string[], hint?: string): SettingSpec => ({ key, label, choices, labels, hint, kind: 'select' });
const numeric = (key: string, label: string, min: number, max: number, hint?: string): SettingSpec => ({ key, label, min, max, hint, kind: 'number' });
const SECTIONS: { name: string; specs: SettingSpec[] }[] = [
  { name: 'Appearance', specs: [
    choice('theme', 'Theme', ['dark', 'light', 'system'], ['Dark', 'Light', 'Follow system']),
    choice('detailPosition', 'Details position', ['inline', 'bottom', 'right'], ['Inline below selection', 'Bottom', 'Right']),
    choice('diffView', 'Default diff view', ['unified', 'split'], ['Unified', 'Side by side']),
    choice('graphStyle', 'Graph edges', ['curved', 'angular'], ['Curved', 'Angular']),
    numeric('fontSize', 'UI font size', ...SETTINGS_BOUNDS.fontSize, 'Pixels at 100% scale. Windows DPI scaling is respected.'),
    numeric('rowHeight', 'Commit row height', ...SETTINGS_BOUNDS.rowHeight),
    json('graphColors', 'Graph color palette', 'JSON array of 1–32 hex colors, for example ["#80b8e5", "#9bc487"].'),
    choice('labelAlignment', 'Reference label alignment', ['normal', 'branches', 'right']),
    check('combineLabels', 'Combine labels pointing to the same commit'),
    check('muteMerges', 'Mute merge commits'), check('muteNonAncestors', 'Mute commits outside HEAD ancestry'),
    choice('uncommittedStyle', 'Uncommitted graph node', ['open', 'filled']),
    check('signatureDisplay', 'Show commit signature status'),
  ] },
  { name: 'History & branches', specs: [
    choice('dateSource', 'Commit date source', ['author', 'committer']),
    choice('dateFormat', 'Date format', ['relative', 'iso', 'local', 'date', 'iso-date'], ['Relative', 'ISO date and time', 'Local date and time', 'Local date', 'ISO date']),
    choice('order', 'Default history order', ['topo', 'date', 'author-date'], ['Topological', 'Commit date', 'Author date']),
    numeric('initialLoad', 'Initial commits to load', ...SETTINGS_BOUNDS.initialLoad),
    numeric('loadMore', 'Commits per load more', ...SETTINGS_BOUNDS.loadMore),
    numeric('pageSize', 'Legacy page size', ...SETTINGS_BOUNDS.pageSize, 'Retained for compatibility. New history requests use Initial commits and Load more independently.'),
    check('autoLoad', 'Load next page near end of history', 'History is virtualized. A manual Load more control remains available.'),
    check('showRemotes', 'Show remote branches'), check('showRemoteHeads', 'Show remote HEAD references'),
    check('showTags', 'Show tags'), check('includeTagOnly', 'Include commits reachable only from tags'),
    check('showStashes', 'Include stashes'), check('collapseStashAuxiliary', 'Collapse stash index and untracked commits'),
    check('showUncommitted', 'Show uncommitted changes row'), check('showUntracked', 'Include untracked files'),
    check('firstParent', 'Follow first parent only'), check('includeReflog', 'Include reflog commits'),
    check('scrollToHead', 'Scroll to HEAD on opening a repository'), check('autoCenterDetails', 'Center the selected commit when opening details'),
    json('startupScope', 'Startup history scope', 'JSON: {"kind":"all"}, {"kind":"head"}, {"kind":"refs","refs":["refs/heads/main"]} or {"kind":"glob","include":["refs/heads/feature/*"],"exclude":[]}.'),
    json('branchGroups', 'Custom branch groups', 'JSON array: [{"name":"Features","include":["refs/heads/feature/*"],"exclude":["refs/heads/feature/old/*"]}]. Globs are not regular expressions.'),
  ] },
  { name: 'Files & privacy', specs: [
    choice('fileView', 'Changed files', ['tree', 'list'], ['Tree', 'List']),
    check('compactFolders', 'Compact single-child folders'), check('mailmap', 'Apply repository .mailmap'),
    { key: 'encoding', label: 'File encoding', kind: 'text', hint: 'For example utf-8, windows-1252 or gb18030. Decoding is handled by the desktop backend.' },
    check('avatars', 'Load external avatars', 'Off by default. Enabling sends SHA-256 hashes of author emails and your IP address to Gravatar. No image requests occur while disabled.'),
  ] },
  { name: 'Messages & links', specs: [
    check('markdown', 'Render safe inline Markdown', 'Bold, italic, bold italic, code and HTTP/HTTPS links only. Raw HTML is always text; code spans do not expand links or emoji.'),
    check('emoji', 'Expand emoji shortcodes'),
    json('customEmoji', 'Custom Unicode emoji', 'JSON object, for example {"shipit":"🚢", "reviewed":"✓"}. Values are local Unicode text, never fetched images.'),
    { key: 'issueUrl', label: 'Issue URL template', kind: 'text', hint: 'Use {id} for #123; only HTTP/HTTPS URLs without credentials. Links open only on an explicit click.' },
    json('issueRules', 'Custom issue link rules', 'JSON array: [{"pattern":"TEAM-(\\\\d+)","url":"https://issues.example/TEAM-{id}"}]. Only literal prefixes/suffixes and one decimal capture (\\d+) or ([0-9]+) are accepted, optionally bounded by \\b or ^/$. Arbitrary regex is rejected.'),
    { key: 'pullRequestUrl', label: 'Pull request URL template', kind: 'text', hint: 'Manual links support {id}, {commit}, {branch}; create-PR templates also support {source}, {target}, {owner}, {repo}, {host}, {baseUrl} and {remoteWebBase}.' },
    json('pullRequestProviders', 'Custom pull request providers', 'JSON array: [{"name":"Company GitLab","host":"git.example.com","url":"{baseUrl}/-/merge_requests/new?merge_request[source_branch]={source}&merge_request[target_branch]={target}"}]. A literal host match is required. No account API or background requests are used.'),
  ] },
  { name: 'Git & tools', specs: [
    { key: 'defaultRemote', label: 'Default remote', kind: 'text', hint: 'Initial remote in operation dialogs.' },
    check('confirmCheckout', 'Confirm local branch checkout', 'Detached checkouts and destructive operations always require confirmation.'),
    choice('commitSigning', 'Commit signing policy', ['git', 'sign', 'no-sign'], ['Follow Git configuration', 'Sign', 'Do not sign']),
    choice('tagSigning', 'Tag signing policy', ['git', 'sign', 'no-sign'], ['Follow Git configuration', 'Sign annotated tags', 'Do not sign']),
    choice('referenceSpace', 'Replace spaces in reference names', ['none', 'hyphen', 'underscore']),
    choice('repositorySort', 'Repository sort order', ['recent', 'name', 'path']),
    numeric('discoveryDepth', 'Repository discovery depth', ...SETTINGS_BOUNDS.discoveryDepth, '0 searches only the selected directory; higher values also inspect that many levels of child directories.'),
    { key: 'gitPath', label: 'Git executable (global only)', kind: 'text', hint: 'Empty checks trusted standard Git installations, then PATH. Full executable path or command name only, never a shell command. Repository settings cannot override this.' },
    { key: 'editorPath', label: 'External editor executable', kind: 'text', hint: 'Empty uses the desktop default. Use an executable path without surrounding quotes. Editing a working file can modify it.' },
    json('editorArgs', 'Editor arguments', 'JSON string array, each item one literal argument (no shell). Supported placeholders: {repo}, {file}, {line}, {column}; line/column default to 1.'),
    { key: 'terminalPath', label: 'Terminal executable', kind: 'text', hint: 'Empty uses the desktop default terminal. No command is executed automatically.' },
    json('terminalArgs', 'Terminal arguments', 'JSON string array, each item one literal argument (no shell). Supported placeholder: {repo}.'),
  ] },
  { name: 'Dialog defaults', specs: [
    choice('dialogDefaults.tagType', 'New tag type', ['lightweight', 'annotated']),
    check('dialogDefaults.tagPush', 'Push new tags after creation'),
    check('dialogDefaults.reinstateIndex', 'Restore index when applying or popping stashes'),
    check('dialogDefaults.recordOrigin', 'Record origin in cherry-picked commits'),
    check('dialogDefaults.noCommit', 'Cherry-pick / revert without committing'),
    check('dialogDefaults.checkoutAfterCreate', 'Check out newly created branches'),
    check('dialogDefaults.forceDelete', 'Default to force branch deletion', 'Destructive confirmation is still required.'),
    check('dialogDefaults.forceFetch', 'Default to force fetch', 'Non-fast-forward updates still require confirmation.'),
    check('dialogDefaults.fetchPrune', 'Prune stale remote-tracking references on fetch'),
    check('dialogDefaults.fetchPruneTags', 'Prune stale local tags on fetch', 'Pruning tags can delete local tags; an additional confirmation is required.'),
    check('dialogDefaults.mergeNoFastForward', 'Always create a merge commit'),
    check('dialogDefaults.mergeNoCommit', 'Stop merge before committing'),
    check('dialogDefaults.mergeSquash', 'Squash merge changes'),
    choice('dialogDefaults.pullMode', 'Pull integration', ['ff-only', 'merge', 'rebase']),
    check('dialogDefaults.pullNoFastForward', 'Create merge commit when pulling'), check('dialogDefaults.pullSquash', 'Squash pulled changes'),
    choice('dialogDefaults.squashMessage', 'Squash commit message', ['default', 'summary'], ['Git default', 'Summarize commits']),
    check('dialogDefaults.rebaseIgnoreDate', 'Use current time for author date when rebasing'),
    check('dialogDefaults.rebaseInteractive', 'Use external interactive rebase'),
    check('dialogDefaults.rebasePreserveMerges', 'Preserve merge topology when rebasing'),
    choice('dialogDefaults.resetMode', 'Commit reset mode', ['soft', 'mixed', 'hard', 'keep']),
    choice('dialogDefaults.worktreeResetMode', 'Working-tree reset mode', ['mixed', 'hard']),
    check('dialogDefaults.stashIncludeUntracked', 'Include untracked files when saving stashes'),
  ] },
  { name: 'Keyboard shortcuts', specs: [
    { key: 'shortcuts.find', label: 'Find commits', kind: 'text', hint: 'For example Ctrl+F. Empty disables the shortcut.' },
    { key: 'shortcuts.refresh', label: 'Refresh repository', kind: 'text' },
    { key: 'shortcuts.head', label: 'Go to HEAD', kind: 'text' },
    { key: 'shortcuts.stash', label: 'Save stash', kind: 'text' },
  ] },
];
function at(settings: AppSettings, path: string): unknown { return path.split('.').reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, settings); }
function patchFor(path: string, value: unknown): SettingsPatch {
  const [key, child] = path.split('.');
  return { [key]: child ? { [child]: value } : value } as SettingsPatch;
}

export async function showSettings(host: Host, store: StateStore, repo: Repository | null, diagnostics: Diagnostics | null, changed: () => void, onError: (error: unknown) => void): Promise<void> {
  if (document.querySelector('.settings-dialog')) return;
  const previous = document.activeElement as HTMLElement | null;
  const dialog = el('dialog', 'dialog settings-dialog'); dialog.setAttribute('aria-labelledby', 'settings-title');
  const title = el('h2', '', 'Settings'); title.id = 'settings-title';
  let scope = repo ? repo.id : ''; let draft = structuredClone(effectiveSettings(store.state, scope));
  let generation = 0; let saving = 0; let disposed = false; let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Map<string, number>(); const invalid = new Map<string, string>(); const raw = new Map<string, string>(); const awaiting = new Set<string>();
  let active = 0;
  const updates = new UpdateCheck(host, diagnostics?.appVersion);
  const tabs = el('nav', 'settings-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Settings sections'); tabs.setAttribute('aria-orientation', 'vertical');
  const panel = el('div', 'settings-panel'); panel.setAttribute('role', 'tabpanel'); panel.id = 'settings-panel';
  const error = el('div', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert');
  const status = el('small', 'muted', 'Changes apply immediately and are saved locally.'); status.setAttribute('role', 'status'); status.dataset.settingStatus = '';
  const scopeSelect = select([{ value: '', label: 'Global defaults' }, ...(repo ? [{ value: repo.id, label: `This repository · ${repo.name}` }] : [])], scope, 'Settings scope', value => { void switchScope(value); });
  scopeSelect.dataset.settingScope = '';
  const reset = button('Reset scope', () => { void resetScope(); }, 'undo');
  const importButton = button('Import configuration…', () => { void importConfig(); }, 'open');
  const exportButton = button('Export configuration…', () => { void host.exportConfig(scope || null).catch(onError); }, 'export');
  const apply = button('Save now', () => { void save(); }, undefined, 'primary'); apply.dataset.action = 'save-settings';
  const closeButton = button('Close', () => { void close(); });
  const footer = el('footer', 'dialog-footer', reset, importButton, exportButton, el('span', 'spacer'), closeButton, apply);
  dialog.append(el('header', 'dialog-header', title, scopeSelect, button('Close settings', () => { void close(); }, 'close', '', true)), el('div', 'settings-body', tabs, panel), status, error, footer);
  document.body.append(dialog);
  const names = [...SECTIONS.map(section => section.name), 'Columns & actions', 'About & privacy'];
  const tabButtons = names.map((name, index) => {
    const tab = button(name, () => { active = index; render(); }); tab.setAttribute('role', 'tab'); tab.id = `settings-tab-${index}`; tab.setAttribute('aria-controls', panel.id);
    tab.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowDown') next = (index + 1) % names.length;
      else if (event.key === 'ArrowUp') next = (index - 1 + names.length) % names.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = names.length - 1;
      else return;
      event.preventDefault(); active = next; render(); tabButtons[next].focus();
    });
    tabs.append(tab); return tab;
  });
  function feedback(message?: string): void {
    const errors = [...invalid.values()];
    error.textContent = message ?? errors.join('\n'); error.hidden = !error.textContent;
    status.textContent = saving ? 'Saving changes…' : dirty.size ? 'Unsaved changes — retry Save now if saving failed. Valid changes are already active.' : 'All changes saved. New changes apply immediately.';
    apply.disabled = dirty.size === 0 && !store.dirty;
  }
  function schedule(): void { clearTimeout(persistTimer); persistTimer = setTimeout(() => { void save(false); }, 160); }
  async function set(path: string, value: unknown): Promise<void> {
    const sequence = ++generation; dirty.set(path, sequence); invalid.delete(path);
    const key = path.split('.')[0] as keyof AppSettings;
    if (scope && GLOBAL_ONLY_SETTINGS.includes(key)) { invalid.set(path, `${path} is global only.`); feedback(); return; }
    const patch = patchFor(path, value); const issues = validateSettingsPatch(patch, scope ? 'repository' : 'global');
    if (issues.length) { invalid.set(path, issues.map(issue => `${issue.path}: ${issue.message}`).join('\n')); feedback(); return; }
    if (path === 'avatars' && value === true && !effectiveSettings(store.state, scope).avatars) {
      awaiting.add(path);
      const confirmed = await confirmDialog('Allow external avatar requests?', 'Author email addresses are lowercased and hashed with SHA-256 before requesting an image from Gravatar. Gravatar receives those hashes and your IP address; a hash is not anonymous. No image request is made while avatars are disabled.', 'Enable external avatars');
      awaiting.delete(path);
      if (dirty.get(path) !== sequence || disposed) return;
      if (!confirmed) { dirty.delete(path); draft = mergeSettings(draft, { avatars: false }); render(); feedback(); return; }
    }
    draft = mergeSettings(draft, patch);
    // Full-object editors replace their local map; all ordinary nested controls patch one leaf only.
    if (path === 'customEmoji' || path === 'contextActions') {
      if (scope) store.state.repoSettings[scope] = { ...store.state.repoSettings[scope], [path]: structuredClone(value) };
      else (store.state.settings as unknown as Record<string, unknown>)[path] = structuredClone(value);
      draft[path] = structuredClone(value) as AppSettings['customEmoji'] & AppSettings['contextActions']; store.queue();
    } else store.updateSettings(patch, scope || null);
    changed(); feedback(); schedule();
  }
  function control(spec: SettingSpec): HTMLElement {
    const value = at(draft, spec.key); const isGlobal = GLOBAL_ONLY_SETTINGS.includes(spec.key as keyof AppSettings);
    let node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (spec.kind === 'checkbox') {
      const wrapper = checkbox(spec.label, Boolean(value), checked => { void set(spec.key, checked); });
      node = wrapper.querySelector('input')!; node.dataset.setting = spec.key; node.name = spec.key; node.disabled = Boolean(scope && isGlobal);
      return el('div', 'setting-check', wrapper, spec.hint ? el('small', 'muted', spec.hint) : null);
    }
    if (spec.kind === 'select') node = select((spec.choices ?? []).map((value, index) => ({ value, label: spec.labels?.[index] ?? value })), String(value), spec.label, next => { void set(spec.key, next); });
    else if (spec.kind === 'json') {
      node = el('textarea'); node.rows = 5; node.spellcheck = false; node.value = raw.get(spec.key) ?? JSON.stringify(value, null, 2); node.setAttribute('aria-label', spec.label);
      const area = node;
      area.addEventListener('input', () => {
        raw.set(spec.key, area.value);
        try { const parsed: unknown = JSON.parse(area.value); void set(spec.key, parsed); }
        catch { dirty.set(spec.key, ++generation); invalid.set(spec.key, `${spec.label}: enter valid JSON.`); feedback(); }
      });
    } else {
      node = input(spec.label, raw.get(spec.key) ?? String(value), spec.kind === 'number' ? 'number' : 'text');
      const item = node; if (spec.min !== undefined) item.min = String(spec.min); if (spec.max !== undefined) item.max = String(spec.max); if (spec.kind === 'number') item.step = '1';
      item.addEventListener('input', () => { raw.set(spec.key, item.value); void set(spec.key, spec.kind === 'number' ? (item.value.trim() ? Number(item.value) : NaN) : item.value); });
    }
    node.dataset.setting = spec.key; node.name = spec.key; node.disabled = Boolean(scope && isGlobal);
    if (invalid.has(spec.key)) node.setAttribute('aria-invalid', 'true');
    return field(spec.label, node, spec.hint);
  }
  function render(): void {
    tabButtons.forEach((tab, index) => { tab.setAttribute('aria-selected', String(index === active)); tab.tabIndex = index === active ? 0 : -1; });
    panel.setAttribute('aria-labelledby', `settings-tab-${active}`); panel.replaceChildren(el('h3', '', names[active]));
    if (scope) panel.append(el('p', 'muted settings-scope-note', 'Only edited leaves become repository overrides. All other settings continue to inherit global defaults. Git executable is global only. Reset scope removes this repository’s overrides.'));
    const section = SECTIONS[active];
    if (section) for (const spec of section.specs) panel.append(control(spec));
    else if (active === SECTIONS.length) {
      panel.append(el('h4', '', 'Visible commit columns'));
      for (const key of ['date', 'author', 'commit'] as const) panel.append(control(check(`columns.${key}`, key === 'commit' ? 'Commit hash' : key[0].toUpperCase() + key.slice(1))));
      for (const key of ['graph', 'date', 'author', 'commit'] as const) panel.append(control(numeric(`columnWidths.${key}`, `${key[0].toUpperCase() + key.slice(1)} column width`, 60, key === 'graph' ? 640 : 400)));
      panel.append(el('p', 'muted', 'Column boundaries can also be resized with pointer or keyboard. Graph and description stay visible.'), el('h4', '', 'Visible Git actions'), el('p', 'muted', 'Unchecked actions are hidden from toolbars and context menus. This is a display preference, not a security boundary.'));
      for (const group of ACTION_GROUPS) {
        const list = el('fieldset', 'action-settings', el('legend', '', group.label));
        for (const kind of group.kinds) {
          const wrapper = checkbox(ACTION_LABELS[kind], !draft.hiddenActions.includes(kind), checked => { const next = new Set(draft.hiddenActions); if (checked) next.delete(kind); else next.add(kind); void set('hiddenActions', [...next]); });
          wrapper.querySelector('input')!.dataset.setting = `hiddenActions.${kind}`; list.append(wrapper);
        }
        panel.append(list);
      }
      panel.append(control(json('contextActions', 'Context action allowlists', 'JSON object mapping Contexts: commit, branch, remote, remoteBranch, tag, stash, worktree to ordered Git action identifiers. Empty object keeps the default menus. Example: {"branch":["checkout","branch-rename","branch-delete"]}.')));
    } else {
      const details = el('dl', 'about-details');
      for (const [label, value] of [['App version', diagnostics?.appVersion ?? 'Unknown'], ['Git version', diagnostics?.gitVersion ?? 'Not available'], ['Git path', diagnostics?.gitPath ?? 'Not available'], ['Platform', diagnostics?.platform ?? 'Unknown'], ['Configuration directory', diagnostics?.configDirectory ?? 'Host dependent']]) {
        const item = el('dd', 'mono', value); if (label === 'Configuration directory') item.dataset.configDirectory = ''; details.append(el('dt', '', label), item);
      }
      panel.append(details, updates.element);
      for (const warning of diagnostics?.warnings ?? []) panel.append(el('p', 'muted', warning));
      panel.append(el('h4', '', 'Local by default'), el('p', '', 'Repository data is read through the local desktop backend. There is no telemetry, account API or required account. Remote Git operations use your configured transports and credential helpers.'), el('p', '', 'External avatars are opt-in. Issue and pull request links open only when activated. Terminal, editor and external diff tools may run local applications only after repository trust is granted.'), el('p', '', 'Only an explicit Check for updates requests public release metadata from GitHub. GitHub receives your IP address and a User-Agent containing the app version; no repository data is sent. Opening a release page also requires your click. The app never downloads or installs updates automatically.'), el('h4', '', 'Stored on this device'), el('p', '', 'Preferences, trusted paths, recent repositories, views, pane sizes and reviewed file paths are persisted locally. Review marks expire after 90 days; file contents and diffs are not stored. Automatic review marks require an explicitly active immutable review session.'), el('h4', '', 'Configuration sharing'), el('p', '', 'Export uses the desktop host. Imports are previewed before applying an allowlisted settings patch. Imported data cannot grant repository trust, replace recent repositories, set executable paths or arguments, or enable avatars.'));
    }
    feedback();
  }
  async function save(requireValid = true): Promise<boolean> {
    clearTimeout(persistTimer); persistTimer = undefined;
    if (requireValid && invalid.size) { feedback(); return false; }
    const pending = new Map([...dirty].filter(([path]) => !invalid.has(path) && !awaiting.has(path))); const saveScope = scope;
    if (!pending.size && !store.dirty) { feedback(); return !invalid.size; }
    saving++; feedback();
    try {
      await store.flush();
      if (!disposed && saveScope === scope) for (const [path, version] of pending) if (dirty.get(path) === version) dirty.delete(path);
      feedback(); return !invalid.size;
    } catch (failure) {
      feedback(`Could not save settings: ${errorMessage(failure)}\nYour valid changes remain active and unsaved. Retry Save now.`); onError(failure); return false;
    } finally { saving--; if (!disposed) { status.textContent = dirty.size || store.dirty ? 'Unsaved changes — retry Save now. Valid changes remain active.' : 'All changes saved.'; apply.disabled = !dirty.size && !store.dirty; } }
  }
  async function switchScope(value: string): Promise<void> {
    if (invalid.size) {
      if (!await confirmDialog('Discard invalid input?', 'Some inputs cannot be applied. Valid edits are already active and will be saved; invalid input will be discarded when changing scope.', 'Discard invalid input')) { scopeSelect.value = scope; return; }
      for (const path of invalid.keys()) dirty.delete(path); invalid.clear();
    }
    if ((dirty.size || store.dirty) && !await save()) { scopeSelect.value = scope; return; }
    scope = value; draft = structuredClone(effectiveSettings(store.state, scope)); dirty.clear(); raw.clear(); invalid.clear(); error.hidden = true; render();
  }
  async function resetScope(): Promise<void> {
    if (!await confirmDialog('Reset these settings?', scope ? 'Remove this repository’s overrides so it inherits global defaults. Trust and review sessions are not changed.' : 'Restore global defaults. Repository overrides are not removed.', 'Reset settings')) return;
    if (scope) delete store.state.repoSettings[scope]; else store.state.settings = structuredClone(DEFAULT_SETTINGS);
    draft = structuredClone(effectiveSettings(store.state, scope)); raw.clear(); invalid.clear(); dirty.clear(); dirty.set('*', ++generation); store.queue(); changed(); render(); await save();
  }
  async function importConfig(): Promise<void> {
    try {
      const imported = await host.importConfig(); if (!imported) return;
      const preview = prepareConfigImport(imported); const keys = Object.keys(preview.settings) as (keyof AppSettings)[];
      if (!keys.length) { feedback(['No safe settings to import.', ...preview.warnings].join('\n')); return; }
      const body = el('div', '', el('p', '', 'Only selected allowlisted settings are applied to the current scope. Trust, recent repositories, views, tool paths/arguments and avatar consent are never imported.'));
      for (const warning of preview.warnings) body.append(el('p', 'muted', warning));
      body.append(el('pre', 'output-text', JSON.stringify(preview.settings, null, 2)));
      const selected = await formDialog({ title: 'Preview configuration import', description: scope ? `Apply to ${repo?.name ?? 'this repository'}` : 'Apply to global defaults', body, fields: keys.map(key => ({ name: key, label: key, type: 'checkbox', value: true })), confirm: 'Apply selected settings' });
      if (!selected || disposed) return;
      const patch: SettingsPatch = {};
      for (const key of keys) if (selected[key] === true) (patch as Record<string, unknown>)[key] = preview.settings[key];
      const issues = validateSettingsPatch(patch, scope ? 'repository' : 'global');
      if (issues.length) { feedback(issues.map(issue => `${issue.path}: ${issue.message}`).join('\n')); return; }
      for (const key of Object.keys(patch)) { raw.delete(key); invalid.delete(key); dirty.set(key, ++generation); }
      store.updateSettings(patch, scope || null); draft = structuredClone(effectiveSettings(store.state, scope)); changed(); render(); await save();
    } catch (failure) { feedback(`Could not import configuration: ${errorMessage(failure)}`); onError(failure); }
  }
  async function close(): Promise<void> {
    if ((dirty.size || store.dirty) && !await save()) {
      if (!await confirmDialog('Close with unsaved input?', 'Valid changes remain active in memory, but saving has failed or some inputs are invalid. Close now to discard invalid input; reopen settings to retry any unsaved valid changes.', 'Close anyway')) return;
    }
    disposed = true; updates.dispose(); clearTimeout(persistTimer); dialog.close(); dialog.remove(); previous?.focus({ preventScroll: true });
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
  render(); dialog.showModal(); tabButtons[0].focus();
}

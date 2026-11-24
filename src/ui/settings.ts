import type { AppSettings, Diagnostics, Host, Repository, SettingsPatch } from '../shared/protocol';
import { DEFAULT_SETTINGS } from '../shared/protocol';
import { errorText } from '../lib/format';
import { localized, resolveText, setLanguage, type Language, type Localizable } from '../lib/i18n';
import { effectiveSettings, mergeSettings, type StateStore } from '../lib/state';
import { GLOBAL_ONLY_SETTINGS, SETTINGS_BOUNDS, isRecord, prepareConfigImport, settingsIssuesText, validateSettingsPatch } from '../lib/settings-schema';
import { label, labels, m, type SettingLabelKey } from '../i18n/settings';
import { m as common } from '../i18n/common';
import { ACTION_GROUPS, ACTION_LABELS } from './actions';
import { button, checkbox, confirmDialog, disposeBindings, el, field, formDialog, input, select, setAttribute, setText } from './dom';
import { UpdateCheck } from './updates';

interface SettingSpec { key: SettingLabelKey; kind: 'select' | 'number' | 'text' | 'checkbox' | 'json'; choices?: readonly string[]; labels?: Localizable[]; hint?: Localizable; min?: number; max?: number }
const check = (key: SettingLabelKey, hint?: Localizable): SettingSpec => ({ key, hint, kind: 'checkbox' });
const json = (key: SettingLabelKey, hint: Localizable): SettingSpec => ({ key, hint, kind: 'json' });
const choice = (key: SettingLabelKey, choices: string[], names: Localizable[]): SettingSpec => ({ key, choices, labels: names, kind: 'select' });
const numeric = (key: SettingLabelKey, min: number, max: number, hint?: Localizable): SettingSpec => ({ key, min, max, hint, kind: 'number' });
const SECTIONS: { name: Localizable; specs: SettingSpec[] }[] = [
  { name: m('appearance'), specs: [
    choice('theme', ['dark', 'light', 'system'], [m('dark'), m('light'), m('system')]),
    choice('detailPosition', ['inline', 'bottom', 'right'], [m('inline'), m('bottom'), m('right')]),
    choice('localChangesPosition', ['middle', 'inline'], [m('localMiddle'), m('localInline')]),
    choice('diffView', ['unified', 'split'], [m('unified'), m('split')]),
    choice('graphStyle', ['curved', 'angular'], [m('curved'), m('angular')]),
    numeric('fontSize', ...SETTINGS_BOUNDS.fontSize, m('fontHint')), numeric('rowHeight', ...SETTINGS_BOUNDS.rowHeight),
    json('graphColors', m('paletteHint')),
    choice('labelAlignment', ['normal', 'branches', 'right'], [m('normal'), m('branches'), m('right')]),
    check('combineLabels'), check('muteMerges'), check('muteNonAncestors'),
    choice('uncommittedStyle', ['open', 'filled'], [m('open'), m('filled')]), check('signatureDisplay'),
  ] },
  { name: m('history'), specs: [
    choice('dateSource', ['author', 'committer'], [m('author'), m('committer')]),
    choice('dateFormat', ['relative', 'iso', 'local', 'date', 'iso-date'], [m('relative'), m('iso'), m('local'), m('date'), m('isoDate')]),
    choice('order', ['topo', 'date', 'author-date'], [m('topo'), m('commitDate'), m('authorDate')]),
    numeric('initialLoad', ...SETTINGS_BOUNDS.initialLoad), numeric('loadMore', ...SETTINGS_BOUNDS.loadMore), numeric('pageSize', ...SETTINGS_BOUNDS.pageSize, m('pageHint')),
    check('autoLoad', m('autoHint')), check('showRemotes'), check('showRemoteHeads'), check('showTags'), check('includeTagOnly'), check('showStashes'), check('collapseStashAuxiliary'), check('showUncommitted'), check('showUntracked'), check('firstParent'), check('includeReflog'), check('scrollToHead'), check('autoCenterDetails'),
    json('startupScope', m('startupHint', { all: '{"kind":"all"}', head: '{"kind":"head"}', refs: '{"kind":"refs","refs":["refs/heads/main"]}', glob: '{"kind":"glob","include":["refs/heads/feature/*"],"exclude":[]}' })),
    json('branchGroups', m('groupsHint', { example: '[{"name":"Features","include":["refs/heads/feature/*"],"exclude":["refs/heads/feature/old/*"]}]' })),
  ] },
  { name: m('files'), specs: [
    choice('fileView', ['tree', 'list'], [m('tree'), m('list')]), check('compactFolders'), check('mailmap'),
    { key: 'encoding', kind: 'text', hint: m('encodingHint') }, check('avatars', m('avatarsHint')),
  ] },
  { name: m('messages'), specs: [
    check('markdown', m('markdownHint')), check('emoji'), json('customEmoji', m('emojiHint', { example: '{"shipit":"🚢", "reviewed":"✓"}' })),
    { key: 'issueUrl', kind: 'text', hint: m('issueHint') },
    json('issueRules', m('rulesHint', { example: '[{"pattern":"TEAM-(\\\\d+)","url":"https://issues.example/TEAM-{id}"}]' })),
    { key: 'pullRequestUrl', kind: 'text', hint: m('prHint') },
    json('pullRequestProviders', m('providerHint', { example: '[{"name":"Company GitLab","host":"git.example.com","url":"{baseUrl}/-/merge_requests/new?merge_request[source_branch]={source}&merge_request[target_branch]={target}"}]' })),
  ] },
  { name: m('tools'), specs: [
    { key: 'defaultRemote', kind: 'text', hint: m('remoteHint') }, check('confirmCheckout', m('checkoutHint')),
    choice('commitSigning', ['git', 'sign', 'no-sign'], [m('git'), m('sign'), m('noSign')]), choice('tagSigning', ['git', 'sign', 'no-sign'], [m('git'), m('signTags'), m('noSign')]),
    choice('referenceSpace', ['none', 'hyphen', 'underscore'], [m('none'), m('hyphen'), m('underscore')]), choice('repositorySort', ['recent', 'name', 'path'], [m('recent'), m('name'), m('path')]),
    numeric('discoveryDepth', ...SETTINGS_BOUNDS.discoveryDepth, m('discoveryHint')),
    { key: 'gitPath', kind: 'text', hint: m('gitHint') }, { key: 'editorPath', kind: 'text', hint: m('editorHint') }, json('editorArgs', m('editorArgsHint')),
    { key: 'terminalPath', kind: 'text', hint: m('terminalHint') }, json('terminalArgs', m('terminalArgsHint')),
  ] },
  { name: m('defaults'), specs: [
    choice('dialogDefaults.tagType', ['lightweight', 'annotated'], [m('lightweight'), m('annotated')]), check('dialogDefaults.tagPush'), check('dialogDefaults.reinstateIndex'), check('dialogDefaults.recordOrigin'), check('dialogDefaults.noCommit'), check('dialogDefaults.checkoutAfterCreate'), check('dialogDefaults.forceDelete', m('forceDeleteHint')), check('dialogDefaults.forceFetch', m('forceFetchHint')), check('dialogDefaults.fetchPrune'), check('dialogDefaults.fetchPruneTags', m('pruneHint')), check('dialogDefaults.mergeNoFastForward'), check('dialogDefaults.mergeNoCommit'), check('dialogDefaults.mergeSquash'),
    choice('dialogDefaults.pullMode', ['ff-only', 'merge', 'rebase'], [m('ffOnly'), m('merge'), m('rebase')]), check('dialogDefaults.pullNoFastForward'), check('dialogDefaults.pullSquash'),
    choice('dialogDefaults.squashMessage', ['default', 'summary'], [m('default'), m('summary')]), check('dialogDefaults.rebaseIgnoreDate'), check('dialogDefaults.rebaseInteractive'), check('dialogDefaults.rebasePreserveMerges'),
    choice('dialogDefaults.resetMode', ['soft', 'mixed', 'hard', 'keep'], [m('soft'), m('mixed'), m('hard'), m('keep')]), choice('dialogDefaults.worktreeResetMode', ['mixed', 'hard'], [m('mixed'), m('hard')]), check('dialogDefaults.stashIncludeUntracked'),
  ] },
  { name: m('shortcuts'), specs: [
    { key: 'shortcuts.find', kind: 'text', hint: m('shortcutHint') }, { key: 'shortcuts.refresh', kind: 'text' }, { key: 'shortcuts.head', kind: 'text' }, { key: 'shortcuts.stash', kind: 'text' },
  ] },
];
function at(settings: AppSettings, path: string): unknown { return path.split('.').reduce<unknown>((value, key) => isRecord(value) ? value[key] : undefined, settings); }
function patchFor(path: string, value: unknown): SettingsPatch {
  const [key, child] = path.split('.');
  return { [key]: child ? { [child]: value } : value } as SettingsPatch;
}

/** The optional seventh callback is presentation-only. Language changes deliberately never call changed(). */
export async function showSettings(host: Host, store: StateStore, repo: Repository | null, diagnostics: Diagnostics | null, changed: () => void, onError: (error: unknown) => void, languageChanged: () => void = () => {}): Promise<void> {
  if (document.querySelector('.settings-dialog')) return;
  const previous = document.activeElement as HTMLElement | null;
  const dialog = el('dialog', 'dialog settings-dialog'); dialog.setAttribute('aria-labelledby', 'settings-title');
  const title = el('h2', '', m('title')); title.id = 'settings-title';
  let scope = repo ? repo.id : ''; let draft = structuredClone(effectiveSettings(store.state, scope));
  let generation = 0; let saving = 0; let disposed = false; let persistTimer: ReturnType<typeof setTimeout> | undefined;
  const dirty = new Map<string, number>(); const invalid = new Map<string, Localizable>(); const raw = new Map<string, string>(); const awaiting = new Set<string>();
  let active = 0;
  const updates = new UpdateCheck(host, diagnostics?.appVersion);
  const tabs = el('nav', 'settings-tabs'); tabs.setAttribute('role', 'tablist'); setAttribute(tabs, 'aria-label', m('sections')); tabs.setAttribute('aria-orientation', 'vertical');
  const panel = el('div', 'settings-panel'); panel.setAttribute('role', 'tabpanel'); panel.id = 'settings-panel';
  const error = el('div', 'form-error'); error.hidden = true; error.setAttribute('role', 'alert');
  const status = el('small', 'muted', m('immediate')); status.setAttribute('role', 'status'); status.dataset.settingStatus = '';
  const scopeSelect = select([{ value: '', label: m('global') }, ...(repo ? [{ value: repo.id, label: m('repository', { name: repo.name }) }] : [])], scope, m('scope'), value => { void switchScope(value); });
  scopeSelect.dataset.settingScope = '';
  const languageSelect = select([{ value: 'system', label: m('system') }, { value: 'en', label: m('english') }, { value: 'zh-CN', label: m('chinese') }], store.state.settings.language, label('language'), value => {
    if (disposed || !['system', 'en', 'zh-CN'].includes(value)) return;
    const language = value as Language;
    store.updateSettings({ language }, null); draft.language = language; dirty.set('language', ++generation);
    setLanguage(language); languageChanged(); setText(status, m(saving ? 'saving' : 'unsavedRetry')); apply.disabled = false; schedule();
  });
  languageSelect.dataset.setting = 'language'; languageSelect.name = 'language'; languageSelect.dataset.settingLanguage = '';
  const reset = button(m('resetScope'), () => { void resetScope(); }, 'undo');
  const importButton = button(m('import'), () => { void importConfig(); }, 'open');
  const exportButton = button(m('export'), () => { void host.exportConfig(scope || null).catch(onError); }, 'export');
  const apply = button(m('save'), () => { void save(); }, undefined, 'primary'); apply.dataset.action = 'save-settings';
  const closeButton = button(common('close'), () => { void close(); });
  const footer = el('footer', 'dialog-footer', reset, importButton, exportButton, el('span', 'spacer'), closeButton, apply);
  dialog.append(el('header', 'dialog-header', title, scopeSelect, field(label('language'), languageSelect), button(m('closeSettings'), () => { void close(); }, 'close', '', true)), el('div', 'settings-body', tabs, panel), status, error, footer);
  document.body.append(dialog);
  const names = [...SECTIONS.map(section => section.name), m('columns'), m('about')];
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
  function feedback(message?: Localizable): void {
    if (disposed) return;
    const errors = [...invalid.values()];
    const content = message ?? localized(locale => errors.map(value => resolveText(value, locale)).join('\n'));
    setText(error, content); error.hidden = !resolveText(content);
    setText(status, m(saving ? 'saving' : dirty.size ? 'unsavedRetry' : 'savedImmediate'));
    apply.disabled = dirty.size === 0 && !store.dirty;
  }
  function schedule(): void { clearTimeout(persistTimer); persistTimer = setTimeout(() => { void save(false); }, 160); }
  async function set(path: string, value: unknown): Promise<void> {
    if (disposed) return;
    const sequence = ++generation; dirty.set(path, sequence); invalid.delete(path);
    const key = path.split('.')[0] as keyof AppSettings;
    if (scope && GLOBAL_ONLY_SETTINGS.includes(key)) { invalid.set(path, m('globalOnly', { path })); feedback(); return; }
    const patch = patchFor(path, value); const issues = validateSettingsPatch(patch, scope ? 'repository' : 'global');
    if (issues.length) { invalid.set(path, settingsIssuesText(issues)); feedback(); return; }
    if (path === 'avatars' && value === true && !effectiveSettings(store.state, scope).avatars) {
      awaiting.add(path);
      const confirmed = await confirmDialog(m('avatarsTitle'), m('avatarsDescription'), m('enableAvatars'));
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
    const value = at(draft, spec.key); const isGlobal = GLOBAL_ONLY_SETTINGS.includes(spec.key as keyof AppSettings); const name = label(spec.key);
    let node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (spec.kind === 'checkbox') {
      const wrapper = checkbox(name, Boolean(value), checked => { void set(spec.key, checked); });
      node = wrapper.querySelector('input')!; node.dataset.setting = spec.key; node.name = spec.key; node.disabled = Boolean(scope && isGlobal);
      return el('div', 'setting-check', wrapper, spec.hint ? el('small', 'muted', spec.hint) : null);
    }
    if (spec.kind === 'select') node = select((spec.choices ?? []).map((value, index) => ({ value, label: spec.labels?.[index] ?? value })), String(value), name, next => { void set(spec.key, next); });
    else if (spec.kind === 'json') {
      node = el('textarea'); node.rows = 5; node.spellcheck = false; node.value = raw.get(spec.key) ?? JSON.stringify(value, null, 2); setAttribute(node, 'aria-label', name);
      const area = node;
      area.addEventListener('input', () => {
        raw.set(spec.key, area.value);
        try { const parsed: unknown = JSON.parse(area.value); void set(spec.key, parsed); }
        catch { dirty.set(spec.key, ++generation); invalid.set(spec.key, m('validJson', { label: name })); feedback(); }
      });
    } else {
      node = input(name, raw.get(spec.key) ?? String(value), spec.kind === 'number' ? 'number' : 'text');
      const item = node; if (spec.min !== undefined) item.min = String(spec.min); if (spec.max !== undefined) item.max = String(spec.max); if (spec.kind === 'number') item.step = '1';
      item.addEventListener('input', () => { raw.set(spec.key, item.value); void set(spec.key, spec.kind === 'number' ? (item.value.trim() ? Number(item.value) : NaN) : item.value); });
    }
    node.dataset.setting = spec.key; node.name = spec.key; node.disabled = Boolean(scope && isGlobal);
    if (invalid.has(spec.key)) node.setAttribute('aria-invalid', 'true');
    return field(name, node, spec.hint);
  }
  function render(): void {
    tabButtons.forEach((tab, index) => { tab.setAttribute('aria-selected', String(index === active)); tab.tabIndex = index === active ? 0 : -1; });
    panel.setAttribute('aria-labelledby', `settings-tab-${active}`); panel.replaceChildren(el('h3', '', names[active]));
    if (scope) panel.append(el('p', 'muted settings-scope-note', m('scopeNote')));
    const section = SECTIONS[active];
    if (section) for (const spec of section.specs) panel.append(control(spec));
    else if (active === SECTIONS.length) {
      panel.append(el('h4', '', m('visibleColumns')));
      for (const key of ['date', 'author', 'commit'] as const) panel.append(control(check(`columns.${key}`)));
      for (const key of ['graph', 'date', 'author', 'commit'] as const) panel.append(control(numeric(`columnWidths.${key}`, 60, key === 'graph' ? 640 : 400)));
      panel.append(el('p', 'muted', m('widthHint')), el('h4', '', m('visibleActions')), el('p', 'muted', m('actionsHint')));
      for (const group of ACTION_GROUPS) {
        const list = el('fieldset', 'action-settings', el('legend', '', group.label));
        for (const kind of group.kinds) {
          const wrapper = checkbox(ACTION_LABELS[kind], !draft.hiddenActions.includes(kind), checked => { const next = new Set(draft.hiddenActions); if (checked) next.delete(kind); else next.add(kind); void set('hiddenActions', [...next]); });
          wrapper.querySelector('input')!.dataset.setting = `hiddenActions.${kind}`; list.append(wrapper);
        }
        panel.append(list);
      }
      panel.append(control(json('contextActions', m('contextHint', { example: '{"branch":["checkout","branch-rename","branch-delete"]}' }))));
    } else {
      const details = el('dl', 'about-details');
      const entries: [Localizable, Localizable, boolean?][] = [[m('appVersion'), diagnostics?.appVersion ?? common('unknown')], [m('gitVersion'), diagnostics?.gitVersion ?? common('unavailable')], [m('gitPathLabel'), diagnostics?.gitPath ?? common('unavailable')], [m('platform'), diagnostics?.platform ?? common('unknown')], [m('configDirectory'), diagnostics?.configDirectory ?? common('hostDependent'), true]];
      for (const [name, value, configDirectory] of entries) { const item = el('dd', 'mono', value); if (configDirectory) item.dataset.configDirectory = ''; details.append(el('dt', '', name), item); }
      panel.append(details, updates.element);
      for (const warning of diagnostics?.warnings ?? []) panel.append(el('p', 'muted', warning));
      panel.append(el('h4', '', m('localDefault')), el('p', '', m('localDescription')), el('p', '', m('privacyDescription')), el('p', '', m('updatePrivacy')), el('h4', '', m('stored')), el('p', '', m('storedDescription')), el('h4', '', m('sharing')), el('p', '', m('sharingDescription')));
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
      feedback(m('saveError', { detail: errorText(failure) })); onError(failure); return false;
    } finally { saving--; if (!disposed) { setText(status, m(dirty.size || store.dirty ? 'unsaved' : 'saved')); apply.disabled = !dirty.size && !store.dirty; } }
  }
  async function switchScope(value: string): Promise<void> {
    if (invalid.size) {
      if (!await confirmDialog(m('discardTitle'), m('discardDescription'), m('discard'))) { scopeSelect.value = scope; return; }
      for (const path of invalid.keys()) dirty.delete(path); invalid.clear();
    }
    if ((dirty.size || store.dirty) && !await save()) { scopeSelect.value = scope; return; }
    scope = value; draft = structuredClone(effectiveSettings(store.state, scope)); dirty.clear(); raw.clear(); invalid.clear(); error.hidden = true; render();
  }
  async function resetScope(): Promise<void> {
    if (!await confirmDialog(m('resetTitle'), m(scope ? 'resetRepository' : 'resetGlobal'), m('reset'))) return;
    if (scope) delete store.state.repoSettings[scope]; else store.state.settings = structuredClone(DEFAULT_SETTINGS);
    draft = structuredClone(effectiveSettings(store.state, scope)); languageSelect.value = store.state.settings.language;
    raw.clear(); invalid.clear(); dirty.clear(); dirty.set('*', ++generation); store.queue(); changed();
    setLanguage(store.state.settings.language); languageChanged(); render(); await save();
  }
  async function importConfig(): Promise<void> {
    try {
      const imported = await host.importConfig(); if (!imported || disposed) return;
      const preview = prepareConfigImport(imported); const keys = Object.keys(preview.settings) as (keyof AppSettings)[];
      if (!keys.length) { feedback(m('noImport', { warnings: preview.warnings.join('\n') })); return; }
      const body = el('div', '', el('p', '', m('importDescription')));
      for (const warning of preview.warnings) body.append(el('p', 'muted', warning));
      body.append(el('pre', 'output-text', JSON.stringify(preview.settings, null, 2)));
      const selected = await formDialog({ title: m('previewImport'), description: scope ? m('applyRepository', { name: repo?.name ?? m('thisRepository') }) : m('applyGlobal'), body, fields: keys.map(key => ({ name: key, label: key in labels ? label(key as SettingLabelKey) : key, type: 'checkbox', value: true })), confirm: m('applySelected') });
      if (!selected || disposed) return;
      const patch: SettingsPatch = {};
      for (const key of keys) if (selected[key] === true) (patch as Record<string, unknown>)[key] = preview.settings[key];
      const issues = validateSettingsPatch(patch, scope ? 'repository' : 'global');
      if (issues.length) { feedback(settingsIssuesText(issues)); return; }
      for (const key of Object.keys(patch)) { raw.delete(key); invalid.delete(key); dirty.set(key, ++generation); }
      store.updateSettings(patch, scope || null); draft = structuredClone(effectiveSettings(store.state, scope)); changed(); render(); await save();
    } catch (failure) { feedback(m('importError', { detail: errorText(failure) })); onError(failure); }
  }
  async function close(): Promise<void> {
    if ((dirty.size || store.dirty) && !await save()) {
      if (!await confirmDialog(m('closeTitle'), m('closeDescription'), m('closeAnyway'))) return;
    }
    disposed = true; updates.dispose(); disposeBindings(dialog); clearTimeout(persistTimer); dialog.close(); dialog.remove(); previous?.focus({ preventScroll: true });
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close(); });
  render(); dialog.showModal(); tabButtons[0].focus();
}

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { errorText } from '../lib/format';
import { onLocaleChange, resolveText, type Localizable } from '../lib/i18n';
import { prepareConfigImport, normalizeSettings } from '../lib/settings-schema';
import type { ConfigImport, Diagnostics } from '../shared/protocol';
import { label, m as settingMessage } from '../i18n/settings';
import { m } from '../i18n/vue-settings';
import { createPreferencesDraft, importSettingLabel, SETTINGS_SECTIONS, settingValue, settingsLocale, type PreferenceScope, type SettingsDialogProps, type SettingsSave, type SettingSpec } from '../controllers/preferences';
import UpdatesDialog from './UpdatesDialog.vue';

const props = withDefaults(defineProps<SettingsDialogProps>(), { scope: 'global', repo: null, saveError: '' });
const emit = defineEmits<{
  'update:open': [open: boolean];
  save: [value: SettingsSave];
  reset: [value: { scope: PreferenceScope }];
  scope: [scope: PreferenceScope];
}>();
const id = useId();
const draft = createPreferencesDraft(props);
const { effective, dirty, errors, scope: draftScope } = draft;
const section = ref('appearance');
const currentSection = computed(() => SETTINGS_SECTIONS.find(item => item.id === section.value));
const localeRevision = ref(0);
const unsubscribe = onLocaleChange(() => { localeRevision.value++; });
const locale = computed(() => { void localeRevision.value; return settingsLocale(props.globalSettings?.language ?? props.settings.language); });
const text = (value: Localizable): string => resolveText(value, locale.value);
const fieldId = (spec: SettingSpec): string => `${id}-${spec.key.replaceAll('.', '-')}`;
const fieldName = (spec: SettingSpec): string => text(label(spec.key));
const disabled = (spec: SettingSpec): boolean => draftScope.value === 'repository' && (!props.repo || draft.isGlobalOnly(spec.key));
const inherited = (spec: SettingSpec): boolean => draftScope.value === 'repository' && !draft.isGlobalOnly(spec.key) && !draft.overridden(spec.key);
const issues = computed(() => Object.entries(errors.value).map(([key, values]) => ({ key, values })));
const notice = shallowRef<Localizable | null>(null);
const operationError = shallowRef<Localizable | null>(null);
const requested = ref(false);
let retryDraft: ReturnType<typeof draft.checkpoint> | null = null;
const busy = ref(false);
const updatesOpen = ref(false);
const diagnostics = shallowRef<Diagnostics | null>(null);
const diagnosticsBusy = ref(false);
const diagnosticsError = shallowRef<Localizable | null>(null);
let generation = 0;
let diagnosticsGeneration = 0;
let disposed = false;
type Confirmation = 'discard' | 'reset' | 'avatars' | 'import' | null;
const confirmation = ref<Confirmation>(null);
const pendingScope = ref<PreferenceScope | null>(null);
const preview = shallowRef<ConfigImport | null>(null);
const selected = ref<string[]>([]);
const previewKeys = computed(() => Object.keys(preview.value?.settings ?? {}));
const importLabel = (key: string): string => text(importSettingLabel(key));
const status = computed(() => props.saveError ? m('saveFailed') : notice.value ?? (dirty.value ? m('dirty') : m('clean')));

function resetDraft(): void {
  draft.reset(props); notice.value = null; operationError.value = null; requested.value = false;
}
watch(() => [props.open, props.repo?.id, props.scope, props.host] as const, (next, previous) => {
  generation++; diagnosticsGeneration++; busy.value = false; diagnosticsBusy.value = false;
  confirmation.value = null; preview.value = null; selected.value = []; updatesOpen.value = false;
  if (next[0] && (!previous?.[0] || next[1] !== previous[1] || next[2] !== previous[2] || next[3] !== previous[3])) {
    resetDraft(); retryDraft = null; diagnostics.value = null; diagnosticsError.value = null;
    if (section.value === 'about') void readDiagnostics();
  }
});
watch(() => [props.settings, props.globalSettings, props.repoPatch] as const, () => {
  if (!props.open) return;
  if (!dirty.value || requested.value && !props.saveError) resetDraft();
  else draft.global.value = normalizeSettings(props.globalSettings ?? props.settings);
}, { deep: true });
watch(() => props.saveError, value => {
  // Parent state may update before its asynchronous native flush fails. Keep the exact
  // submitted draft available for retry instead of treating an optimistic prop update as success.
  if (value && retryDraft && props.open) { draft.restore(retryDraft); requested.value = false; notice.value = null; }
});
watch(section, value => { if (value === 'about' && props.open && !diagnostics.value) void readDiagnostics(); });
onBeforeUnmount(() => { disposed = true; generation++; diagnosticsGeneration++; unsubscribe(); });
function edited(): void { requested.value = false; retryDraft = null; notice.value = null; operationError.value = null; }
function update(spec: SettingSpec, value: string | boolean): void {
  if (!props.open || disabled(spec)) return;
  if (spec.key === 'avatars' && value === true && !effective.value.avatars) { confirmation.value = 'avatars'; return; }
  edited(); draft.update(spec, value);
}
function override(spec: SettingSpec): void {
  if (disabled(spec)) return;
  if (spec.key === 'avatars' && settingValue(effective.value, spec.key) === true) { confirmation.value = 'avatars'; return; }
  edited(); draft.set(spec.key, settingValue(effective.value, spec.key));
}
function inherit(spec: SettingSpec): void {
  edited(); draft.inherit(spec.key);
  if (spec.key === 'avatars' && effective.value.avatars && !(props.settings.avatars)) confirmation.value = 'avatars';
}
function save(): void {
  if (!props.open || busy.value || !dirty.value || issues.value.length || draftScope.value === 'repository' && !props.repo) return;
  retryDraft = draft.checkpoint();
  emit('save', { scope: draftScope.value, patch: JSON.parse(JSON.stringify(draft.patch.value)) });
  requested.value = true; notice.value = m('requested');
}
function close(): void {
  if (dirty.value) { pendingScope.value = null; confirmation.value = 'discard'; }
  else { generation++; emit('update:open', false); }
}
function requestOpen(open: boolean): void { if (!open) close(); }
function switchScope(value: string): void {
  if (value !== 'global' && value !== 'repository' || value === draftScope.value || value === 'repository' && !props.repo) return;
  if (dirty.value) { pendingScope.value = value; confirmation.value = 'discard'; }
  else emit('scope', value);
}
function resetScope(): void { retryDraft = null; confirmation.value = 'reset'; }
function cancelConfirmation(): void { confirmation.value = null; preview.value = null; selected.value = []; pendingScope.value = null; }
function confirm(): void {
  const kind = confirmation.value;
  if (kind === 'discard') {
    const target = pendingScope.value;
    resetDraft(); retryDraft = null; cancelConfirmation();
    if (target) emit('scope', target); else { generation++; emit('update:open', false); }
  } else if (kind === 'reset') {
    if (draftScope.value === 'repository' && !props.repo) return;
    emit('reset', { scope: draftScope.value }); requested.value = true; notice.value = m('resetRequested'); cancelConfirmation();
  } else if (kind === 'avatars') {
    edited(); draft.set('avatars', true); cancelConfirmation();
  } else if (kind === 'import' && preview.value && selected.value.length) {
    edited(); draft.stageImport(preview.value, selected.value); notice.value = m('importStaged'); cancelConfirmation();
  }
}
function toggleImport(key: string, checked: boolean): void { selected.value = checked ? [...new Set([...selected.value, key])] : selected.value.filter(item => item !== key); }
async function importConfig(): Promise<void> {
  if (!props.open || busy.value || confirmation.value) return;
  const own = ++generation; busy.value = true; operationError.value = null; notice.value = m('importBusy');
  try {
    const imported = await props.host.importConfig();
    if (disposed || !props.open || own !== generation) return;
    if (!imported) { notice.value = m('importCancelled'); return; }
    const safe = prepareConfigImport(imported);
    if (!Object.keys(safe.settings).length) { notice.value = settingMessage('noImport', { warnings: safe.warnings.join('\n') }); return; }
    preview.value = safe; selected.value = Object.keys(safe.settings); confirmation.value = 'import'; notice.value = null;
  } catch (failure) { if (!disposed && own === generation && props.open) operationError.value = settingMessage('importError', { detail: errorText(failure) }); }
  finally { if (!disposed && own === generation) busy.value = false; }
}
async function exportConfig(): Promise<void> {
  if (!props.open || busy.value || dirty.value || draftScope.value === 'repository' && !props.repo) return;
  const own = ++generation; busy.value = true; operationError.value = null;
  try {
    const result = await props.host.exportConfig(draftScope.value === 'repository' ? props.repo!.id : null);
    if (!disposed && own === generation && props.open) notice.value = m(result ? 'exportSuccess' : 'exportCancelled');
  } catch (failure) { if (!disposed && own === generation && props.open) operationError.value = m('exportError', { detail: errorText(failure) }); }
  finally { if (!disposed && own === generation) busy.value = false; }
}
async function readDiagnostics(): Promise<void> {
  if (!props.open || diagnosticsBusy.value) return;
  const own = ++diagnosticsGeneration; diagnosticsBusy.value = true; diagnosticsError.value = null;
  try { const result = await props.host.diagnostics(); if (!disposed && props.open && own === diagnosticsGeneration) diagnostics.value = result; }
  catch (failure) { if (!disposed && props.open && own === diagnosticsGeneration) diagnosticsError.value = m('diagnosticsError', { detail: errorText(failure) }); }
  finally { if (!disposed && own === diagnosticsGeneration) diagnosticsBusy.value = false; }
}
const confirmationTitle = computed(() => confirmation.value === 'discard' ? m('discardTitle') : settingMessage(confirmation.value === 'reset' ? 'resetTitle' : confirmation.value === 'avatars' ? 'avatarsTitle' : 'previewImport'));
const confirmationDescription = computed(() => confirmation.value === 'discard' ? m('discardDescription') : confirmation.value === 'reset' ? settingMessage(draftScope.value === 'repository' ? 'resetRepository' : 'resetGlobal') : settingMessage(confirmation.value === 'avatars' ? 'avatarsDescription' : 'importDescription'));
const confirmationAction = computed(() => confirmation.value === 'discard' ? m('discard') : settingMessage(confirmation.value === 'reset' ? 'reset' : confirmation.value === 'avatars' ? 'enableAvatars' : 'applySelected'));
</script>

<template>
  <DialogRoot :open="open" @update:open="requestOpen">
    <DialogPortal>
      <DialogOverlay class="settings-overlay" />
      <DialogContent class="settings-dialog" :lang="locale" data-settings-dialog @interact-outside.prevent>
        <header class="settings-header">
          <div><DialogTitle class="settings-title">{{ text(settingMessage('title')) }}</DialogTitle><DialogDescription class="settings-description">{{ text(m('draftDescription')) }}</DialogDescription></div>
          <button type="button" class="settings-button" :aria-label="text(settingMessage('closeSettings'))" data-action="close-settings" @click="close">{{ text(m('close')) }}</button>
        </header>
        <div class="settings-scope">
          <label :for="`${id}-scope`">{{ text(settingMessage('scope')) }}</label>
          <select :id="`${id}-scope`" data-setting-scope :aria-label="text(settingMessage('scope'))" :value="draftScope" :disabled="busy" @change="switchScope(($event.target as HTMLSelectElement).value)">
            <option value="global">{{ text(settingMessage('global')) }}</option>
            <option v-if="repo" value="repository">{{ text(settingMessage('repository', { name: repo.name })) }}</option>
          </select>
          <span v-if="draftScope === 'repository'" class="settings-muted">{{ text(m(repo ? 'overrideNote' : 'repoRequired')) }}</span>
        </div>
        <div class="settings-body">
          <nav class="settings-navigation" :aria-label="text(settingMessage('sections'))">
            <button v-for="item in SETTINGS_SECTIONS" :key="item.id" type="button" class="settings-nav-item" :aria-current="section === item.id ? 'page' : undefined" :data-section="item.id" @click="section = item.id">{{ text(item.title) }}</button>
            <button type="button" class="settings-nav-item" :aria-current="section === 'about' ? 'page' : undefined" data-section="about" @click="section = 'about'">{{ text(settingMessage('about')) }}</button>
          </nav>
          <section v-if="currentSection" :aria-labelledby="`${id}-section-title`" class="settings-panel">
            <h3 :id="`${id}-section-title`">{{ text(currentSection.title) }}</h3>
            <p v-if="section === 'columns'" class="settings-muted">{{ text(settingMessage('actionsHint')) }}</p>
            <div v-for="spec in currentSection.specs" :key="spec.key" class="settings-field" :data-inherited="inherited(spec)">
              <div class="settings-field-heading">
                <label :for="fieldId(spec)">{{ fieldName(spec) }}</label>
                <template v-if="draftScope === 'repository'">
                  <span class="settings-badge">{{ text(m(draft.isGlobalOnly(spec.key) ? 'globalOnly' : inherited(spec) ? 'inherited' : 'overridden')) }}</span>
                  <button v-if="!disabled(spec)" type="button" class="settings-link" :aria-label="text(m(inherited(spec) ? 'overrideLabel' : 'inheritLabel', { name: fieldName(spec) }))" :data-inherit-setting="spec.key" @click="inherited(spec) ? override(spec) : inherit(spec)">{{ text(m(inherited(spec) ? 'override' : 'inherit')) }}</button>
                </template>
              </div>
              <input v-if="spec.kind === 'checkbox'" :id="fieldId(spec)" type="checkbox" :name="spec.key" :data-setting="spec.key" :checked="Boolean(settingValue(effective, spec.key))" :disabled="disabled(spec)" :aria-label="fieldName(spec)" :aria-describedby="`${fieldId(spec)}-help ${fieldId(spec)}-error`" @change="update(spec, ($event.target as HTMLInputElement).checked)">
              <select v-else-if="spec.kind === 'select'" :id="fieldId(spec)" :name="spec.key" :data-setting="spec.key" :value="draft.text(spec)" :disabled="disabled(spec)" :aria-label="fieldName(spec)" :aria-invalid="Boolean(errors[spec.key])" :aria-describedby="`${fieldId(spec)}-help ${fieldId(spec)}-error`" @change="update(spec, ($event.target as HTMLSelectElement).value)">
                <option v-for="choice in spec.choices" :key="choice.value" :value="choice.value">{{ text(choice.text) }}</option>
              </select>
              <textarea v-else-if="spec.kind === 'json'" :id="fieldId(spec)" :name="spec.key" :data-setting="spec.key" :value="draft.text(spec)" :disabled="disabled(spec)" rows="4" spellcheck="false" :aria-label="fieldName(spec)" :aria-invalid="Boolean(errors[spec.key])" :aria-describedby="`${fieldId(spec)}-help ${fieldId(spec)}-error`" @input="update(spec, ($event.target as HTMLTextAreaElement).value)" />
              <input v-else :id="fieldId(spec)" :type="spec.kind === 'number' ? 'number' : 'text'" :name="spec.key" :data-setting="spec.key" :value="draft.text(spec)" :disabled="disabled(spec)" :min="spec.min" :max="spec.max" :step="spec.kind === 'number' ? 1 : undefined" :aria-label="fieldName(spec)" :aria-invalid="Boolean(errors[spec.key])" :aria-describedby="`${fieldId(spec)}-help ${fieldId(spec)}-error`" autocomplete="off" spellcheck="false" @input="update(spec, ($event.target as HTMLInputElement).value)">
              <small :id="`${fieldId(spec)}-help`" class="settings-muted">{{ spec.hint ? text(spec.hint) : spec.kind === 'json' ? text(m('jsonHint')) : '' }}</small>
              <small :id="`${fieldId(spec)}-error`" class="settings-error" :role="errors[spec.key] ? 'alert' : undefined">{{ errors[spec.key]?.map(value => text(value)).join('\n') }}</small>
            </div>
          </section>
          <section v-else class="settings-panel settings-about" :aria-labelledby="`${id}-about-title`">
            <h3 :id="`${id}-about-title`">{{ text(settingMessage('about')) }}</h3>
            <p v-if="diagnosticsBusy" role="status">{{ text(m('diagnosticsLoading')) }}</p>
            <p v-if="diagnosticsError" role="alert" class="settings-error">{{ text(diagnosticsError) }}</p>
            <dl v-if="diagnostics" class="settings-diagnostics">
              <dt>{{ text(settingMessage('appVersion')) }}</dt><dd>{{ diagnostics.appVersion }}</dd>
              <dt>{{ text(settingMessage('gitVersion')) }}</dt><dd>{{ diagnostics.gitVersion ?? text(m('unavailable')) }}</dd>
              <dt>{{ text(settingMessage('gitPathLabel')) }}</dt><dd>{{ diagnostics.gitPath ?? text(m('unavailable')) }}</dd>
              <dt>{{ text(settingMessage('platform')) }}</dt><dd>{{ diagnostics.platform }}</dd>
              <dt>{{ text(m('hostMode')) }}</dt><dd>{{ text(m(diagnostics.hostMode ?? 'unknown')) }}</dd>
              <dt>{{ text(settingMessage('configDirectory')) }}</dt><dd data-config-directory>{{ diagnostics.configDirectory ?? text(m('unavailable')) }}</dd>
              <dt>{{ text(m('nativePerformance')) }}</dt><dd>{{ text(m(diagnostics.performanceEnabled ? 'enabled' : 'disabled')) }}</dd>
            </dl>
            <p v-for="(warning, index) in diagnostics?.warnings ?? []" :key="index" class="settings-muted">{{ warning }}</p>
            <div class="settings-inline-actions"><button type="button" class="settings-button" :disabled="diagnosticsBusy" data-action="refresh-diagnostics" @click="readDiagnostics">{{ text(m('diagnosticsRefresh')) }}</button><button type="button" class="settings-button" data-action="show-updates" @click="updatesOpen = true">{{ text(m('openUpdates')) }}</button></div>
            <h4>{{ text(settingMessage('localDefault')) }}</h4><p>{{ text(settingMessage('localDescription')) }}</p><p>{{ text(settingMessage('privacyDescription')) }}</p><p>{{ text(settingMessage('updatePrivacy')) }}</p>
            <h4>{{ text(settingMessage('stored')) }}</h4><p>{{ text(settingMessage('storedDescription')) }}</p>
            <h4>{{ text(settingMessage('sharing')) }}</h4><p>{{ text(settingMessage('sharingDescription')) }}</p>
          </section>
        </div>
        <div class="settings-feedback" aria-live="polite">
          <p role="status">{{ text(status) }}</p>
          <p v-if="saveError" role="alert" class="settings-error" data-save-error>{{ saveError }}</p>
          <p v-if="operationError" role="alert" class="settings-error">{{ text(operationError) }}</p>
          <ul v-if="issues.length" class="settings-error" aria-live="polite"><li v-for="issue in issues" :key="issue.key">{{ text(label(issue.key as Parameters<typeof label>[0])) }}: {{ issue.values.map(value => text(value)).join('; ') }}</li></ul>
        </div>
        <footer class="settings-footer">
          <button type="button" class="settings-button settings-danger" :disabled="busy || draftScope === 'repository' && !repo" data-action="reset-settings" @click="resetScope">{{ text(settingMessage('resetScope')) }}</button>
          <button type="button" class="settings-button" :disabled="busy || draftScope === 'repository' && !repo" data-action="import-settings" @click="importConfig">{{ text(settingMessage('import')) }}</button>
          <button type="button" class="settings-button" :disabled="busy || dirty || draftScope === 'repository' && !repo" data-action="export-settings" :title="text(m('exportSaved'))" @click="exportConfig">{{ text(settingMessage('export')) }}</button>
          <span class="settings-spacer" />
          <button type="button" class="settings-button settings-primary" :disabled="busy || !dirty || issues.length > 0 || draftScope === 'repository' && !repo" data-action="save-settings" @click="save">{{ text(m('save')) }}</button>
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <DialogRoot :open="confirmation !== null && open" @update:open="value => { if (!value) cancelConfirmation(); }">
    <DialogPortal><DialogOverlay class="settings-overlay settings-confirm-overlay" />
      <DialogContent class="settings-confirm" :lang="locale" data-settings-confirm @interact-outside.prevent>
        <DialogTitle class="settings-title">{{ text(confirmationTitle) }}</DialogTitle>
        <DialogDescription class="settings-description">{{ text(confirmationDescription) }}</DialogDescription>
        <p v-if="confirmation === 'reset'" class="settings-muted">{{ text(m('resetDescription')) }}</p>
        <div v-if="confirmation === 'import' && preview" class="settings-import-preview">
          <p>{{ text(m('importScope', { scope: draftScope === 'repository' ? settingMessage('repository', { name: repo?.name ?? '' }) : settingMessage('global') })) }}</p>
          <p v-for="(warning, index) in preview.warnings" :key="index" class="settings-muted">{{ warning }}</p>
          <fieldset><legend>{{ text(m('importSelect')) }}</legend>
            <div v-for="key in previewKeys" :key="key" class="settings-import-field">
              <label><input type="checkbox" :data-import-key="key" :checked="selected.includes(key)" :aria-label="text(m('importField', { name: importLabel(key) }))" @change="toggleImport(key, ($event.target as HTMLInputElement).checked)">{{ importLabel(key) }}</label>
              <pre :aria-label="text(m('importValue', { name: importLabel(key) }))">{{ JSON.stringify(preview.settings[key as keyof typeof preview.settings], null, 2) }}</pre>
            </div>
          </fieldset>
        </div>
        <div class="settings-inline-actions settings-confirm-actions"><button type="button" class="settings-button" data-action="cancel-settings-confirm" @click="cancelConfirmation">{{ text(m('cancel')) }}</button><button type="button" class="settings-button" :class="confirmation === 'reset' ? 'settings-danger' : 'settings-primary'" :disabled="confirmation === 'import' && !selected.length" data-action="confirm-settings" @click="confirm">{{ text(confirmationAction) }}</button></div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
  <UpdatesDialog :open="updatesOpen && open" :host="host" :language="globalSettings?.language ?? settings.language" :current-version="diagnostics?.appVersion" @update:open="updatesOpen = $event" />
</template>

<style scoped>
.settings-overlay { position: fixed; inset: 0; z-index: 70; background: color-mix(in srgb, var(--bg) 78%, transparent); }
.settings-dialog, .settings-confirm { box-sizing: border-box; position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 71; color: var(--text); background: var(--panel); border: 1px solid var(--line); border-radius: 12px; font: inherit; }
.settings-dialog { display: flex; flex-direction: column; width: min(1080px, calc(100vw - 48px)); height: min(820px, calc(100dvh - 48px)); overflow: hidden; }
.settings-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 20px 24px 16px; border-bottom: 1px solid var(--line); }
.settings-title { margin: 0; font-size: 20px; font-weight: 650; line-height: 1.35; }
.settings-description { margin: 6px 0 0; color: var(--muted); line-height: 1.5; font-size: 13px; max-width: 74ch; }
.settings-scope { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 12px 24px; border-bottom: 1px solid var(--line); font-size: 13px; }
.settings-scope > span { flex-basis: 100%; }
.settings-body { display: flex; min-height: 0; flex: 1; }
.settings-navigation { flex: 0 0 190px; padding: 12px; overflow: auto; border-right: 1px solid var(--line); background: var(--panel-muted); }
.settings-nav-item { display: block; width: 100%; text-align: start; padding: 10px 12px; margin-bottom: 4px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--muted); font: inherit; cursor: pointer; }
.settings-nav-item[aria-current] { border-color: var(--line); color: var(--text); background: var(--panel); box-shadow: inset 3px 0 var(--brand); }
.settings-panel { flex: 1; min-width: 0; overflow: auto; padding: 20px 24px; overscroll-behavior: contain; }
.settings-panel h3 { margin: 0 0 18px; font-size: 16px; }
.settings-field { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 14px 0; border-bottom: 1px solid var(--line); }
.settings-field-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.settings-field-heading > label { font-weight: 550; margin-right: auto; }
.settings-field > input:not([type=checkbox]), .settings-field > select { width: min(100%, 440px); }
.settings-field > input[type=checkbox], .settings-import-field input { width: 17px; height: 17px; margin: 2px 0; accent-color: var(--brand); }
.settings-field textarea { resize: vertical; min-height: 88px; width: 100%; font: 12px/1.55 ui-monospace, monospace; tab-size: 2; }
.settings-dialog input:not([type=checkbox]), .settings-dialog select, .settings-dialog textarea { box-sizing: border-box; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; color: var(--text); padding: 8px 10px; font-size: 13px; }
.settings-dialog [aria-invalid=true] { border-color: var(--danger); }
.settings-muted { color: var(--muted); font-size: 12px; line-height: 1.5; }
.settings-error { color: var(--danger); white-space: pre-wrap; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.settings-error:empty, .settings-muted:empty { display: none; }
.settings-badge { color: var(--muted); background: var(--panel-muted); border: 1px solid var(--line); border-radius: 4px; padding: 2px 6px; font-size: 11px; }
.settings-link { border: 0; padding: 4px; color: var(--brand); background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
.settings-feedback { border-top: 1px solid var(--line); padding: 8px 24px; max-height: 100px; overflow: auto; color: var(--muted); font-size: 12px; }
.settings-feedback p { margin: 3px 0; }
.settings-feedback ul { padding-left: 18px; }
.settings-footer, .settings-inline-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.settings-footer { padding: 12px 24px; border-top: 1px solid var(--line); }
.settings-spacer { flex: 1; }
.settings-button { min-height: 34px; border: 1px solid var(--line); border-radius: 5px; padding: 7px 12px; color: var(--text); background: var(--panel-muted); cursor: pointer; font: inherit; font-size: 13px; }
.settings-primary { background: var(--brand); border-color: var(--brand); color: var(--bg); font-weight: 600; }
.settings-danger { color: var(--danger); }
.settings-button:hover:not(:disabled), .settings-nav-item:hover { border-color: var(--brand); }
.settings-button:disabled, .settings-dialog input:disabled, .settings-dialog select:disabled { opacity: .55; cursor: not-allowed; }
.settings-dialog :focus-visible, .settings-confirm :focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.settings-diagnostics { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 20px; margin: 20px 0; font-size: 13px; }
.settings-diagnostics dt { color: var(--muted); }
.settings-diagnostics dd { margin: 0; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
.settings-about p { font-size: 13px; line-height: 1.6; }
.settings-about h4 { margin-bottom: 6px; }
.settings-confirm-overlay { z-index: 80; }
.settings-confirm { z-index: 81; width: min(620px, calc(100vw - 48px)); padding: 24px; max-height: calc(100dvh - 48px); overflow: auto; }
.settings-confirm-actions { justify-content: flex-end; margin-top: 24px; }
.settings-import-preview { max-height: 50dvh; overflow: auto; margin-top: 16px; overscroll-behavior: contain; }
.settings-import-preview fieldset { border: 1px solid var(--line); border-radius: 6px; padding: 12px; }
.settings-import-field { margin: 10px 0 18px; }
.settings-import-field label { display: flex; align-items: center; gap: 8px; }
.settings-import-field pre { padding: 10px; background: var(--bg); border: 1px solid var(--line); color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
@media (max-width: 760px) { .settings-navigation { flex-basis: 150px; } .settings-panel { padding: 16px; } .settings-footer, .settings-header, .settings-scope { padding-left: 16px; padding-right: 16px; } }
</style>

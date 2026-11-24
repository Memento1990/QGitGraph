<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import type { GithubUpdateInfo, Host } from '../shared/protocol';
import { errorText } from '../lib/format';
import { getLanguage, onLocaleChange, resolveText, type Language, type Localizable } from '../lib/i18n';
import { m as updateMessage } from '../i18n/updates';
import { m } from '../i18n/vue-settings';
import { officialVueReleaseUrl, settingsLocale, validateVueRelease } from '../controllers/preferences';

const props = defineProps<{ open: boolean; host: Host; language?: Language; currentVersion?: string }>();
const emit = defineEmits<{ 'update:open': [open: boolean] }>();
const localeRevision = ref(0);
const unsubscribe = onLocaleChange(() => { localeRevision.value++; });
const locale = computed(() => { void localeRevision.value; return settingsLocale(props.language ?? getLanguage()); });
const text = (value: Localizable): string => resolveText(value, locale.value);
const info = shallowRef<GithubUpdateInfo | null>(null);
const checking = ref(false);
const opening = ref(false);
const error = shallowRef<Localizable | null>(null);
const state = ref('idle');
let generation = 0;
let disposed = false;
const installed = computed(() => info.value?.currentVersion ?? props.currentVersion ?? text(m('unknown')));
const published = computed(() => info.value?.publishedAt ? new Date(info.value.publishedAt).toISOString() : text(updateMessage('notProvided')));
const status = computed(() => error.value ?? updateMessage(checking.value ? 'checking' : info.value?.status === 'no-release' ? 'noRelease' : info.value?.status ?? 'idle'));
watch(() => [props.open, props.host] as const, () => {
  generation++; checking.value = false; opening.value = false; error.value = null; info.value = null; state.value = 'idle';
});
onBeforeUnmount(() => { disposed = true; generation++; unsubscribe(); });
function close(): void { generation++; checking.value = false; opening.value = false; emit('update:open', false); }
async function check(): Promise<void> {
  if (!props.open || disposed || checking.value) return;
  const own = ++generation; checking.value = true; opening.value = false; error.value = null; info.value = null; state.value = 'checking';
  try {
    const result = await props.host.checkForUpdates();
    if (!props.open || disposed || own !== generation) return;
    const validated = validateVueRelease(result);
    if (!validated) { error.value = updateMessage('invalidRetry', { detail: updateMessage('invalid') }); state.value = 'error'; return; }
    info.value = validated; state.value = validated.status;
  } catch (failure) {
    if (props.open && !disposed && own === generation) { error.value = updateMessage('checkError', { detail: errorText(failure) }); state.value = 'error'; }
  } finally { if (!disposed && own === generation) checking.value = false; }
}
async function openRelease(): Promise<void> {
  if (!props.open || disposed || checking.value || opening.value || info.value?.status !== 'available') return;
  const url = officialVueReleaseUrl(info.value);
  if (!url) { error.value = updateMessage('invalidRetry', { detail: updateMessage('invalid') }); state.value = 'error'; return; }
  const own = generation; opening.value = true; error.value = null;
  try { await props.host.openUrl(url); }
  catch (failure) { if (props.open && !disposed && own === generation) { error.value = updateMessage('openError', { detail: errorText(failure) }); state.value = 'error'; } }
  finally { if (!disposed && own === generation) opening.value = false; }
}
</script>

<template>
  <DialogRoot :open="open" @update:open="value => { if (!value) close(); }">
    <DialogPortal><DialogOverlay class="updates-overlay" />
      <DialogContent class="updates-dialog" :lang="locale" data-updates-dialog @interact-outside.prevent>
        <header class="updates-header"><div><DialogTitle class="updates-title">{{ text(updateMessage('title')) }}</DialogTitle><DialogDescription class="updates-description">{{ text(m('updateDescription')) }}</DialogDescription></div><button type="button" class="updates-button" :aria-label="text(m('updateClose'))" data-action="close-updates" @click="close">{{ text(m('close')) }}</button></header>
        <p data-update-current-version>{{ text(updateMessage('installed', { version: installed })) }}</p>
        <button type="button" class="updates-button updates-primary" :disabled="checking" data-action="check-for-updates" @click="check">{{ text(updateMessage(checking ? 'checking' : 'check')) }}</button>
        <p :data-update-status="state" role="status" aria-live="polite" aria-atomic="true" :class="{ 'updates-error': error }">{{ text(status) }}</p>
        <div v-if="info && (info.status === 'available' || info.status === 'current')" class="updates-result">
          <dl><dt>{{ text(updateMessage('latest')) }}</dt><dd>{{ info.latestVersion }}</dd><dt>{{ text(updateMessage('published')) }}</dt><dd>{{ published }}</dd></dl>
          <template v-if="info.status === 'available'">
            <h3 v-if="info.releaseNotes">{{ text(updateMessage('notes')) }}</h3>
            <pre v-if="info.releaseNotes" class="updates-notes" data-update-notes>{{ info.releaseNotes }}</pre>
            <p v-if="info.notesTruncated" class="updates-description">{{ text(updateMessage('truncated')) }}</p>
            <button type="button" class="updates-button" :disabled="opening || checking" data-action="open-update-release" @click="openRelease">{{ text(opening ? m('openingRelease') : updateMessage('open')) }}</button>
          </template>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.updates-overlay { position: fixed; inset: 0; z-index: 90; background: color-mix(in srgb, var(--bg) 78%, transparent); }
.updates-dialog { box-sizing: border-box; position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 91; width: min(680px, calc(100vw - 48px)); max-height: calc(100dvh - 48px); overflow: auto; overscroll-behavior: contain; padding: 24px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; color: var(--text); font: inherit; font-size: 13px; line-height: 1.6; }
.updates-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.updates-title { margin: 0; font-size: 20px; line-height: 1.35; font-weight: 650; }
.updates-description { margin-top: 8px; color: var(--muted); font-size: 13px; line-height: 1.5; }
.updates-button { min-height: 34px; flex-shrink: 0; padding: 7px 12px; border: 1px solid var(--line); border-radius: 5px; color: var(--text); background: var(--panel-muted); cursor: pointer; font: inherit; }
.updates-primary { background: var(--brand); border-color: var(--brand); color: var(--bg); font-weight: 600; }
.updates-button:hover:not(:disabled) { border-color: var(--brand); }
.updates-button:disabled { cursor: not-allowed; opacity: .55; }
.updates-dialog :focus-visible { outline: 2px solid var(--brand); outline-offset: 3px; }
.updates-result dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 20px; }
.updates-result dt { color: var(--muted); }
.updates-result dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
.updates-result h3 { font-size: 14px; margin-top: 22px; }
.updates-notes { box-sizing: border-box; max-height: 36dvh; padding: 14px; margin: 12px 0; overflow: auto; border: 1px solid var(--line); border-radius: 6px; color: var(--text); background: var(--bg); white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 ui-monospace, monospace; }
.updates-error { color: var(--danger); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

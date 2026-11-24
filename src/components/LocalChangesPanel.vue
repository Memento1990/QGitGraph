<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AlertTriangle, Check, ChevronDown, FileText, GitCommitHorizontal, LoaderCircle, Minus, Plus, ShieldAlert, Trash2, Undo2 } from 'lucide-vue-next';
import type { LocalChangesController, LocalDiffSelection } from '../controllers/local-changes';
import { localControllerMessages as labels } from '../controllers/local-changes';
import { controllerMessages } from '../controllers/actions';
import { m } from '../i18n/local-changes';
import { LOCAL_DRAFT_LIMIT, localFileStatus, type LocalChangeEntry, type LocalChangeGroup } from '../lib/local-changes';
import { countWorkingFiles } from '../lib/status';
import { resolveText, type Localizable } from '../lib/i18n';
import { useLocale } from '../lib/vue-locale';

const props = defineProps<{ controller: LocalChangesController }>();
const emit = defineEmits<{ openDiff: [selection: LocalDiffSelection]; trust: [] }>();
const { locale } = useLocale();
const id = useId();
const messageInput = ref<HTMLTextAreaElement | null>(null);
let restoringReading = false;
const state = computed(() => props.controller.state);
const repo = computed(() => props.controller.repository);
const counts = computed(() => state.value.snapshot ? countWorkingFiles(state.value.snapshot.working.files) : null);
const staged = computed(() => counts.value?.staged ?? 0);
const count = computed(() => counts.value?.changed ?? 0);
const blocked = computed(() => props.controller.blocked || props.controller.stale);
const text = (value: Localizable): string => resolveText(value, locale.value);
const confirmation = computed(() => state.value.confirmation);
watch([() => props.controller.snapshot, () => props.controller.repository?.id, () => props.controller.repository?.path, () => props.controller.generation], () => props.controller.update(), { immediate: true, flush: 'sync' });
watch([() => state.value.binding?.repoId, () => state.value.binding?.path, () => state.value.binding?.generation], async () => {
  const binding = state.value.binding, reading = { ...state.value.draftReading };
  restoringReading = true;
  try {
    await nextTick();
    if (state.value.binding?.repoId !== binding?.repoId || state.value.binding?.path !== binding?.path || state.value.binding?.generation !== binding?.generation) return;
    const input = messageInput.value;
    if (input) {
      input.setSelectionRange(reading.start, reading.end, reading.direction);
      input.scrollTop = reading.scrollTop; input.scrollLeft = reading.scrollLeft ?? 0;
    }
  } finally { restoringReading = false; }
}, { immediate: true, flush: 'sync' });
function captureDraftReading(): void {
  const input = messageInput.value;
  // Input can still contain the old repository's text between sync activation and Vue's DOM patch.
  if (!input || restoringReading || input.value !== state.value.draft) return;
  props.controller.updateDraftReading({ start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, scrollTop: input.scrollTop, scrollLeft: input.scrollLeft });
}
function changeDraft(event: Event): void {
  props.controller.setDraft((event.target as HTMLTextAreaElement).value); captureDraftReading();
}
function openDiff(entry: LocalChangeEntry): void {
  const selected = props.controller.select(entry.group, entry.file.path);
  if (selected) emit('openDiff', selected);
}
function stageFile(entry: LocalChangeEntry): void {
  if (entry.group === 'staged') void props.controller.unstage(entry.file.path);
  else void props.controller.stage(entry.group, entry.file.path);
}
function danger(entry: LocalChangeEntry): void {
  if (entry.group === 'untracked') void props.controller.deleteUntracked(entry.file.path);
  else if (entry.group === 'unstaged') void props.controller.discard(entry.file.path);
}
function selected(entry: LocalChangeEntry): boolean { return state.value.selected?.group === entry.group && state.value.selected.path === entry.file.path; }
function basename(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }
function directory(path: string): string { return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : text(labels.m('root')); }
function groupAction(group: LocalChangeGroup, count: number): string { return text(m(group === 'staged' ? 'unstageGroup' : 'stageGroup', { count })); }
function commitKey(event: KeyboardEvent): void {
  if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void props.controller.commit(); }
}
function moveFocus(event: KeyboardEvent): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (!target.matches('.ch-file-open')) return;
  const controls = Array.from(event.currentTarget instanceof Element ? event.currentTarget.querySelectorAll<HTMLButtonElement>('.ch-file-open') : []);
  const index = controls.indexOf(target as HTMLButtonElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : Math.max(0, Math.min(controls.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
  event.preventDefault(); controls[next]?.focus();
}
</script>

<template>
  <section class="ch-panel" :aria-labelledby="`${id}-title`" :aria-busy="state.busy" data-testid="local-changes-panel" :data-repo="repo?.id">
    <header class="ch-header"><div class="ch-title-wrap"><h2 :id="`${id}-title`" class="ch-title">{{ text(m('title')) }}</h2><span class="ch-count" :aria-label="text(blocked ? m('unknown') : m('changed', { count }))">{{ blocked ? '—' : count }}</span></div><span class="ch-local-note">{{ text(labels.m('localOnly')) }}</span></header>
    <div v-if="repo && !repo.trusted" class="ch-trust" role="note"><ShieldAlert :size="16" aria-hidden="true" /><div><p>{{ text(labels.m('trust')) }}</p><button class="wb-button" type="button" @click="emit('trust')">{{ text(controllerMessages.m('untrusted')) }}</button></div></div>
    <div v-if="!repo || repo.bare || blocked" class="ch-empty" role="status"><ShieldAlert v-if="blocked" :size="22" aria-hidden="true" /><strong>{{ text(!repo ? m('noRepository') : repo.bare ? m('bare') : labels.m('blocked')) }}</strong><p>{{ text(!repo ? m('chooseRepository') : repo.bare ? m('bareHint') : m('unknownHint')) }}</p></div>
    <template v-if="repo && !repo.bare">
      <form class="ch-composer" :aria-label="text(m('messageFor', { repo: repo.name }))" @submit.prevent="controller.commit()">
        <div class="ch-composer-heading"><label :for="`${id}-message`">{{ text(m('message')) }}</label><span class="ch-draft-note">{{ text(labels.m('draft')) }}</span></div>
        <textarea :id="`${id}-message`" ref="messageInput" class="ch-message" name="commit-message" :value="state.draft" :maxlength="LOCAL_DRAFT_LIMIT" rows="3" spellcheck="false" :aria-describedby="`${id}-hint`" :placeholder="text(m('messagePlaceholder', { repo: repo.name }))" @input="changeDraft" @select="captureDraftReading" @keyup="captureDraftReading" @scroll="captureDraftReading" @blur="captureDraftReading" @keydown="commitKey" />
        <p :id="`${id}-hint`" class="ch-commit-hint" role="status">{{ text(blocked ? labels.m('blocked') : staged ? m('stagedOnly', { count: staged }) : m('stageFirst')) }}</p>
        <button type="submit" class="ch-commit-button" :disabled="!controller.canCommit" :title="text(m('shortcut'))" aria-keyshortcuts="Control+Enter Meta+Enter" data-action="commit-staged"><LoaderCircle v-if="state.pendingKind === 'commit-staged'" :size="15" aria-hidden="true" /><GitCommitHorizontal v-else :size="15" aria-hidden="true" /><span>{{ text(state.pendingKind === 'commit-staged' ? m('committing') : m('commit')) }}</span><span class="ch-commit-count">{{ blocked ? '—' : staged }}</span><span class="ch-shortcut" aria-hidden="true"><kbd>Ctrl</kbd><kbd>↵</kbd></span></button>
        <p class="ch-commit-hint">{{ text(labels.m('stagedOnly')) }}</p>
      </form>
      <div v-if="!blocked" class="ch-files" :aria-label="text(m('fileList'))" @keydown="moveFocus">
        <div v-if="!count" class="ch-empty" role="status"><Check :size="22" aria-hidden="true" /><h3>{{ text(m('clean')) }}</h3><p>{{ text(m('cleanHint')) }}</p></div>
        <template v-else>
          <button type="button" class="ch-stage-all wb-button" :disabled="!controller.canWrite || !state.groups.some(group => group.id !== 'staged' && group.entries.length)" data-action="stage-all-listed" @click="controller.stageAll()"><Plus :size="13" aria-hidden="true" />{{ text(labels.m('stageAll')) }}</button>
          <section v-for="group in state.groups" :key="group.id" class="ch-group" :data-group="group.id" :aria-labelledby="`${id}-${group.id}-heading`">
            <div class="ch-group-header">
              <button :id="`${id}-${group.id}-heading`" class="ch-group-toggle" type="button" :aria-expanded="!state.collapsed.has(group.id)" :aria-controls="`${id}-${group.id}-files`" :aria-label="text(m(state.collapsed.has(group.id) ? 'expandGroup' : 'collapseGroup', { group: m(group.id) }))" @click="controller.toggleGroup(group.id)"><ChevronDown :size="12" class="ch-chevron" :class="{ 'ch-chevron--closed': state.collapsed.has(group.id) }" aria-hidden="true" /><span class="ch-group-dot" :class="`ch-group-dot--${group.id}`" aria-hidden="true" /><span>{{ text(m(group.id)) }}</span><span class="ch-group-count">{{ group.entries.length }}</span></button>
              <button type="button" class="ch-group-action" :disabled="!controller.canWrite || !group.entries.length" :aria-label="groupAction(group.id, group.entries.length)" :data-action="group.id === 'staged' ? 'unstage-listed' : 'stage-listed'" @click="controller.stageAll(group.id)"><Minus v-if="group.id === 'staged'" :size="13" aria-hidden="true" /><Plus v-else :size="13" aria-hidden="true" /><span>{{ groupAction(group.id, group.entries.length) }}</span></button>
            </div>
            <ul v-show="!state.collapsed.has(group.id)" :id="`${id}-${group.id}-files`" class="ch-file-list">
              <li v-for="entry in group.entries" :key="entry.key" class="ch-file-row" :class="{ 'ch-file-row--selected': selected(entry) }" :data-path="entry.file.path" :data-group="entry.group">
                <button type="button" class="ch-file-open" :aria-label="text(controller.ariaLabel('preview', entry.group, entry.file.path))" :aria-pressed="selected(entry)" @click="openDiff(entry)"><FileText :size="13" class="ch-file-icon" aria-hidden="true" /><span class="ch-file-label"><span class="ch-file-name">{{ basename(entry.file.path) }}</span><span class="ch-file-path">{{ directory(entry.file.path) }}</span></span></button>
                <span class="ch-file-status" :data-status="localFileStatus(entry)" :aria-label="text(m('fileStatus', { status: localFileStatus(entry), path: entry.file.path }))">{{ localFileStatus(entry) }}</span>
                <button type="button" class="ch-file-action" :disabled="!controller.canWrite" :aria-label="text(controller.ariaLabel(group.id === 'staged' ? 'unstage' : 'stage', entry.group, entry.file.path))" :title="text(controller.ariaLabel(group.id === 'staged' ? 'unstage' : 'stage', entry.group, entry.file.path))" :data-action="group.id === 'staged' ? 'unstage-file' : 'stage-file'" @click="stageFile(entry)"><Minus v-if="group.id === 'staged'" :size="13" aria-hidden="true" /><Plus v-else :size="13" aria-hidden="true" /></button>
                <button v-if="group.id !== 'staged'" type="button" class="ch-file-action ch-file-danger" :disabled="!controller.canWrite || Boolean(entry.file.submodule)" :aria-label="text(controller.ariaLabel(group.id === 'untracked' ? 'delete-untracked' : 'discard', entry.group, entry.file.path))" :data-action="group.id === 'untracked' ? 'delete-untracked-file' : 'discard-file'" @click="danger(entry)"><Trash2 v-if="group.id === 'untracked'" :size="13" aria-hidden="true" /><Undo2 v-else :size="13" aria-hidden="true" /></button>
              </li>
            </ul>
          </section>
        </template>
      </div>
    </template>
    <p v-if="state.busy" class="ch-notice" role="status" aria-live="polite">{{ text(controllerMessages.m('running')) }}<button type="button" class="wb-button" @click="controller.cancel()">{{ text(controllerMessages.m('cancel')) }}</button></p>
    <p v-if="state.error" class="ch-notice ch-error" role="alert">{{ text(state.error) }}</p>
    <DialogRoot :open="Boolean(confirmation)" @update:open="open => !open && controller.cancelConfirmation()"><DialogPortal><DialogOverlay class="native-dialog-overlay" /><DialogContent v-if="confirmation" class="native-dialog ch-confirm" :aria-busy="state.busy">
      <DialogTitle><AlertTriangle v-if="confirmation.danger" :size="18" aria-hidden="true" />{{ text(confirmation.title) }}</DialogTitle><DialogDescription>{{ text(confirmation.description) }}</DialogDescription>
      <p class="ch-confirm-repo">{{ repo?.name }} · {{ state.binding?.path }}</p><ul class="ch-confirm-paths"><li v-for="file in confirmation.files" :key="file.path"><span v-if="file.oldPath && file.oldPath !== file.path">{{ file.oldPath }} → </span>{{ file.path }}</li></ul>
      <label v-if="confirmation.expected !== null" :for="`${id}-confirmation`">{{ text(m('confirmation')) }}<input :id="`${id}-confirmation`" name="confirmation" :value="confirmation.value" autocomplete="off" spellcheck="false" :aria-describedby="`${id}-confirm-hint`" @input="controller.setConfirmation(($event.target as HTMLInputElement).value)" /><span :id="`${id}-confirm-hint`" class="ch-commit-hint">{{ confirmation.hint ? text(confirmation.hint) : '' }}</span><code>{{ confirmation.expected }}</code></label>
      <p v-if="state.error" class="ch-error" role="alert">{{ text(state.error) }}</p><footer><button type="button" class="wb-button" @click="controller.cancelConfirmation()">{{ text(controllerMessages.m('cancel')) }}</button><button type="button" class="wb-button primary" :class="{ danger: confirmation.danger }" :disabled="confirmation.expected !== null && confirmation.value !== confirmation.expected || controller.stale" :data-action="`confirm-${confirmation.kind}`" @click="controller.confirm()">{{ text(controllerMessages.m('confirm')) }}</button></footer>
    </DialogContent></DialogPortal></DialogRoot>
  </section>
</template>

<style scoped>
.ch-panel{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--panel);color:var(--text);font:13px/1.45 inherit}.ch-header{display:flex;flex-shrink:0;align-items:center;justify-content:space-between;gap:8px;min-height:49px;padding:0 14px;border-bottom:1px solid var(--line)}.ch-title-wrap{display:flex;align-items:center;gap:8px;min-width:0}.ch-title{margin:0;font-size:13px;font-weight:650}.ch-count,.ch-group-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:4px;background:var(--panel-muted);color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.ch-local-note,.ch-draft-note{color:var(--muted);font-size:11px}.ch-local-note{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ch-trust{display:flex;flex-shrink:0;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel-muted);font-size:12px}.ch-trust>svg{flex-shrink:0;margin-top:3px}.ch-trust p{margin:0 0 8px}
.ch-composer{display:flex;flex-shrink:0;flex-direction:column;gap:6px;margin:0;padding:10px 12px;border-bottom:1px solid var(--line)}.ch-composer-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}.ch-composer-heading label{font-size:12px;font-weight:550}.ch-message{width:100%;min-height:58px;max-height:140px;resize:vertical;padding:9px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel-muted);color:var(--text);font:12px/1.6 inherit}.ch-message::placeholder{color:var(--muted)}.ch-commit-hint{margin:0;color:var(--muted);font-size:11px;line-height:1.6}.ch-commit-button{display:flex;align-items:center;justify-content:center;gap:7px;min-height:32px;padding:5px 9px;border:1px solid var(--brand);border-radius:5px;background:var(--brand);color:var(--bg);font-size:12px;font-weight:550}.ch-commit-button:disabled{opacity:.45;cursor:not-allowed}.ch-commit-count{font-size:11px}.ch-shortcut{display:flex;gap:4px;margin-left:auto;font-size:10px;opacity:.8}.ch-shortcut kbd{font:inherit}
.ch-files{flex:1 1 0;min-height:120px;padding:7px 0 14px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.ch-stage-all{margin:3px 12px 8px}.ch-group+.ch-group{margin-top:8px}.ch-group-header{position:sticky;z-index:1;top:-7px;display:flex;align-items:center;gap:4px;min-height:32px;padding:0 10px 0 8px;background:var(--panel)}.ch-group-toggle{display:flex;flex:1;align-items:center;gap:7px;min-width:0;min-height:28px;padding:0 4px;border:0;border-radius:4px;background:transparent;color:var(--text);font-size:12px;font-weight:600;text-align:left}.ch-chevron{color:var(--muted)}.ch-chevron--closed{transform:rotate(-90deg)}.ch-group-dot{width:5px;height:5px;border-radius:50%;background:var(--muted);flex-shrink:0}.ch-group-dot--staged{background:var(--brand)}.ch-group-action{display:flex;align-items:center;gap:3px;min-height:26px;padding:0 5px;border:0;border-radius:4px;background:transparent;color:var(--muted);font-size:11px}.ch-group-action span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:155px}.ch-file-list{margin:0;padding:0;list-style:none}
.ch-file-row{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 18px 26px 26px;align-items:center;column-gap:2px;min-height:34px;padding:0 10px 0 12px}.ch-file-row:hover{background:var(--hover)}.ch-file-row--selected,.ch-file-row--selected:hover{background:var(--active)}.ch-file-row--selected::before{position:absolute;top:5px;bottom:5px;left:0;width:2px;background:var(--brand);content:''}.ch-file-open{display:flex;align-items:center;gap:7px;width:100%;min-width:0;min-height:34px;padding:2px 2px 2px 0;border:0;border-radius:3px;background:transparent;color:var(--text);text-align:left}.ch-file-icon{color:var(--muted);flex-shrink:0}.ch-file-label{display:flex;flex-direction:column;min-width:0}.ch-file-name,.ch-file-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ch-file-name{font-size:12px;line-height:16px}.ch-file-path{font-size:10px;line-height:13px;color:var(--muted)}.ch-file-status{color:var(--muted);font:11px ui-monospace,Consolas,monospace;text-align:center}.ch-file-status[data-status='A'],.ch-file-status[data-status='?']{color:var(--brand)}.ch-file-action{display:flex;align-items:center;justify-content:center;width:26px;height:28px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--muted)}.ch-file-action:not(:disabled):hover,.ch-group-action:not(:disabled):hover{background:var(--hover);color:var(--text)}.ch-file-danger:not(:disabled):hover{color:var(--danger)}.ch-file-action:disabled,.ch-group-action:disabled{opacity:.4;cursor:not-allowed}
.ch-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-height:120px;padding:24px;text-align:center;color:var(--muted)}.ch-empty h3,.ch-empty p{margin:0;font-size:12px}.ch-notice{display:flex;align-items:center;gap:8px;flex-shrink:0;padding:8px 14px;margin:0;border-top:1px solid var(--line);font-size:12px;white-space:pre-wrap}.ch-error{color:var(--danger)}.ch-confirm h2{display:flex;align-items:center;gap:8px}.ch-confirm-paths{max-height:220px;overflow:auto;padding-left:18px;white-space:pre-wrap;font:12px/1.8 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}.ch-confirm-repo{font-size:12px;color:var(--muted);overflow-wrap:anywhere}.ch-confirm label{display:grid;gap:8px}.ch-confirm code{white-space:pre-wrap;overflow-wrap:anywhere}.ch-confirm .danger{background:var(--danger);color:var(--panel)}.ch-panel button:focus-visible,.ch-message:focus-visible{outline:2px solid var(--brand);outline-offset:2px}
</style>

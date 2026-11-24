<script setup lang="ts">
import { computed, useId } from 'vue';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AlertTriangle, Check, GitBranch, LoaderCircle, Terminal, X } from 'lucide-vue-next';
import type { ActionsController, ActionField } from '../controllers/actions';
import { controllerMessages as labels } from '../controllers/actions';
import { m } from '../i18n/actions';
import { resolveText, type Localizable } from '../lib/i18n';
import { useLocale } from '../lib/vue-locale';

const props = defineProps<{ controller: ActionsController }>();
const { locale } = useLocale();
const id = useId();
const state = computed(() => props.controller.state);
const text = (value: Localizable): string => resolveText(value, locale.value);
const fieldId = (field: ActionField): string => `${id}-${field.name}`;
const parameters = computed(() => {
  const action = state.value.confirmation?.action;
  return action ? Object.entries(action).filter(([key]) => !['repoId', 'requestId', 'kind'].includes(key)) : [];
});
const stale = computed(() => props.controller.stale);
function change(field: ActionField, event: Event): void {
  const input = event.target as HTMLInputElement;
  void props.controller.setValue(field.name, field.type === 'checkbox' ? input.checked : input.value);
}
function requestClose(open: boolean): void { if (!open) props.controller.close(); }
function escape(event: Event): void { if (state.value.busy) event.preventDefault(); }
</script>

<template>
  <DialogRoot :open="state.open" @update:open="requestClose">
    <DialogPortal>
      <DialogOverlay class="native-dialog-overlay" />
      <DialogContent
        class="native-dialog workflow-dialog" data-slot="dialog-content" :data-action="state.kind"
        :aria-busy="state.busy" @escape-key-down="escape" @pointer-down-outside="escape"
      >
        <div class="workflow-panel">
          <header class="workflow-header" data-slot="dialog-header">
            <div class="workflow-eyebrow"><GitBranch :size="14" aria-hidden="true" /><span>{{ text(labels.m('repository')) }}</span></div>
            <div class="workflow-title-row">
              <DialogTitle data-slot="dialog-title">{{ text(controller.title) }}</DialogTitle>
              <button type="button" class="wb-icon" :aria-label="text(labels.m('close'))" :disabled="state.busy" @click="controller.close()"><X :size="16" aria-hidden="true" /></button>
            </div>
            <DialogDescription data-slot="dialog-description">{{ text(labels.m('confirmHint')) }}</DialogDescription>
          </header>
          <dl class="workflow-metadata">
            <div><dt>{{ text(labels.m('repository')) }}</dt><dd>{{ controller.repository?.name }}</dd></div>
            <div><dt>{{ text(labels.m('target')) }}</dt><dd>{{ state.confirmation?.action.target ?? state.values.target ?? controller.repository?.branch ?? 'HEAD' }}</dd></div>
            <div><dt>{{ text(labels.m('repository')) }}</dt><dd class="mono">{{ state.binding?.path }}</dd></div>
          </dl>
          <form class="workflow-form" @submit.prevent="state.phase === 'confirm' ? controller.confirm() : controller.submit()">
            <div class="workflow-body">
              <p v-if="stale && state.phase !== 'result'" class="workflow-error" role="alert">{{ text(labels.m('stale')) }}</p>
              <template v-if="state.phase === 'form'">
                <p v-for="(description, index) in state.descriptions" :key="index" class="workflow-hint">{{ text(description) }}</p>
                <div v-for="field in controller.fields" :key="field.name" class="workflow-field" :class="{ 'workflow-check-field': field.type === 'checkbox' }">
                  <input
                    v-if="field.type === 'checkbox'" :id="fieldId(field)" :name="field.name" type="checkbox" data-slot="checkbox"
                    :checked="Boolean(state.values[field.name])" :disabled="state.busy || field.disabled || stale" @change="change(field, $event)"
                  />
                  <label :for="fieldId(field)">{{ text(field.label) }}<span v-if="field.required" class="workflow-required" aria-hidden="true">*</span></label>
                  <div class="workflow-field-control">
                    <textarea
                      v-if="field.type === 'textarea'" :id="fieldId(field)" :name="field.name" data-slot="textarea"
                      :value="String(state.values[field.name] ?? '')" :required="field.required" :disabled="state.busy || field.disabled || stale"
                      :aria-describedby="field.hint ? `${fieldId(field)}-hint` : undefined" rows="4" @input="change(field, $event)"
                    />
                    <select
                      v-else-if="field.type === 'select'" :id="fieldId(field)" :name="field.name" :value="state.values[field.name]"
                      :required="field.required" :disabled="state.busy || field.disabled || stale"
                      :aria-describedby="field.hint ? `${fieldId(field)}-hint` : undefined" @change="change(field, $event)"
                    ><option v-for="option in field.options" :key="option.value" :value="option.value">{{ text(option.label) }}</option></select>
                    <input
                      v-else-if="field.type === 'text'" :id="fieldId(field)" :name="field.name" data-slot="input" type="text"
                      :value="String(state.values[field.name] ?? '')" :required="field.required" :disabled="state.busy || field.disabled || stale"
                      :aria-describedby="field.hint ? `${fieldId(field)}-hint` : undefined" autocomplete="off" spellcheck="false" @input="change(field, $event)"
                    />
                    <p v-if="field.hint" :id="`${fieldId(field)}-hint`" class="workflow-hint">{{ text(field.hint) }}</p>
                  </div>
                </div>
                <section v-if="state.detail" class="workflow-targets" :aria-label="text(labels.m('inspect'))">
                  <strong>{{ text(labels.m('inspect')) }}</strong><p class="mono">{{ state.detail.commit.oid }}</p><p>{{ state.detail.commit.subject }}</p>
                  <ol><li v-for="parent in state.detail.commit.parents" :key="parent" class="mono">{{ parent }}</li></ol>
                </section>
                <p v-if="state.inspecting" class="workflow-note" role="status"><LoaderCircle :size="14" class="workflow-spinner" aria-hidden="true" />{{ text(m('inspecting')) }}</p>
              </template>
              <section v-else-if="state.phase === 'confirm' && state.confirmation" class="workflow-confirmation">
                <div class="workflow-warning"><AlertTriangle :size="18" aria-hidden="true" /><div><h3>{{ text(state.confirmation.title) }}</h3><p v-for="(description, index) in state.confirmation.descriptions" :key="index">{{ text(description) }}</p></div></div>
                <dl class="workflow-confirm-summary"><div v-for="[key, value] in parameters" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></div></dl>
                <section v-if="state.cleanPreview" class="workflow-targets"><strong>{{ text(labels.m('preview')) }}</strong><pre class="workflow-output">{{ state.cleanPreview.output }}</pre></section>
              </section>
              <section v-else-if="state.phase === 'external'" class="workflow-warning">
                <Terminal :size="18" aria-hidden="true" /><div><h3>{{ text(m('externalDropTitle')) }}</h3><p>{{ text(m('externalDropHint')) }}</p><pre v-if="state.externalCommand" class="workflow-output">{{ state.externalCommand }}</pre></div>
              </section>
              <section v-else-if="state.phase === 'result' && state.result" class="workflow-lifecycle" role="status">
                <Check v-if="state.result.status === 'completed'" :size="18" aria-hidden="true" /><Terminal v-else :size="18" aria-hidden="true" />
                <strong>{{ text(state.result.status === 'started' ? m('externalTitle') : state.result.status === 'paused' ? labels.m('paused') : labels.m('completed')) }}</strong>
                <pre v-if="state.result.result.output" class="workflow-output" :aria-label="text(labels.m('output'))">{{ state.result.result.output }}</pre>
              </section>
              <div v-if="state.busy" class="workflow-note" role="status" aria-live="polite"><LoaderCircle :size="15" class="workflow-spinner" aria-hidden="true" />{{ text(labels.m('running')) }}</div>
              <p v-if="state.notice" class="workflow-note" role="status">{{ text(state.notice) }}</p>
              <p v-if="state.error" class="workflow-error" role="alert">{{ text(state.error) }}</p>
            </div>
            <footer class="workflow-footer" data-slot="dialog-footer">
              <button v-if="state.busy" type="button" class="wb-button" @click="controller.cancel()">{{ text(labels.m('cancel')) }}</button>
              <template v-else>
                <button v-if="state.phase === 'confirm'" type="button" class="wb-button" @click="controller.back()">{{ text(labels.m('back')) }}</button>
                <button v-else type="button" class="wb-button" @click="controller.close()">{{ text(labels.m(state.phase === 'result' ? 'close' : 'cancel')) }}</button>
                <button v-if="state.phase === 'external' || state.kind === 'commit' && state.phase === 'form'" type="button" class="wb-button" :disabled="stale" @click="controller.openTerminal()"><Terminal :size="14" aria-hidden="true" />{{ text(state.phase === 'external' ? m('externalDropConfirm') : m('terminal')) }}</button>
                <button v-if="state.phase === 'form' || state.phase === 'confirm'" type="submit" class="wb-button primary" :class="{ danger: state.confirmation?.danger }" :disabled="stale || state.inspecting">
                  {{ text(state.phase === 'confirm' ? labels.m('confirm') : state.kind === 'clean' ? m('previewFiles') : controller.title) }}
                </button>
              </template>
            </footer>
          </form>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.workflow-dialog{width:min(660px,calc(100vw - 32px));padding:0;gap:0;overflow:hidden;color:var(--text)}
.workflow-panel,.workflow-form{display:flex;flex-direction:column;min-height:0;max-height:calc(100dvh - 80px)}
.workflow-header{padding:20px 24px 16px;display:grid;gap:8px}.workflow-eyebrow{display:flex;gap:7px;align-items:center;color:var(--brand);font-size:11px}
.workflow-title-row{display:flex;align-items:center;justify-content:space-between;gap:16px}.workflow-title-row h2{font-size:21px;font-weight:600}
.workflow-metadata{display:grid;grid-template-columns:1fr 1fr 1.4fr;gap:14px;margin:0;padding:12px 24px;border-block:1px solid var(--line);background:var(--panel-muted)}
.workflow-metadata div{min-width:0}.workflow-metadata dt,.workflow-confirm-summary dt{font-size:11px;color:var(--muted)}.workflow-metadata dd{margin:3px 0 0;font-size:12px;overflow-wrap:anywhere}
.workflow-body{padding:12px 24px 18px;overflow:auto;min-height:80px;overscroll-behavior:contain}.workflow-field{display:grid;grid-template-columns:116px minmax(0,1fr);gap:12px;align-items:start;margin:14px 0}.workflow-field>label{padding-top:7px;font-size:12px}.workflow-field-control{min-width:0}.workflow-field input,.workflow-field textarea,.workflow-field select{font-size:12px}.workflow-field textarea{min-height:90px;resize:vertical}.workflow-check-field{grid-template-columns:16px minmax(0,1fr);padding-left:128px;gap:8px}.workflow-check-field>input{width:15px;height:15px;margin-top:3px}.workflow-check-field>label{padding-top:0}.workflow-check-field .workflow-field-control{grid-column:2}.workflow-required{color:var(--danger);margin-left:4px}.workflow-hint{font-size:12px;line-height:1.6;color:var(--muted);margin:5px 0}
.workflow-error,.workflow-warning,.workflow-note{display:flex;gap:8px;padding:10px 12px;margin:14px 0 0;border:1px solid var(--line);border-radius:5px;background:var(--panel-muted);font-size:12px;line-height:1.6;white-space:pre-wrap}.workflow-error,.workflow-warning{border-color:color-mix(in srgb,var(--danger) 40%,var(--line))}.workflow-error{color:var(--danger)}.workflow-warning>svg{color:var(--danger);flex-shrink:0}.workflow-warning h3{margin:0;font-size:13px}.workflow-warning p{margin:5px 0;color:var(--muted)}.workflow-note{color:var(--muted)}
.workflow-confirm-summary{display:grid;gap:8px;margin:16px 0}.workflow-confirm-summary div{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px}.workflow-confirm-summary dd{margin:0;font-size:12px;overflow-wrap:anywhere}.workflow-targets,.workflow-lifecycle{padding:12px;margin-top:14px;border:1px solid var(--line);border-radius:5px;background:var(--panel-muted);font-size:12px}.workflow-targets p{overflow-wrap:anywhere}.workflow-targets ol{padding-left:18px}.workflow-output{font:12px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto}.workflow-lifecycle>svg{margin-right:8px}
.workflow-footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:14px 24px;border-top:1px solid var(--line);flex-shrink:0}.workflow-footer .danger{background:var(--danger);color:var(--panel)}.workflow-spinner{animation:workflow-spin 1s linear infinite;flex-shrink:0}.mono{font-family:ui-monospace,Consolas,monospace}@keyframes workflow-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.workflow-spinner{animation:none}}@media(max-width:650px){.workflow-metadata{grid-template-columns:1fr}.workflow-field{grid-template-columns:1fr;gap:5px}.workflow-check-field{grid-template-columns:16px 1fr;padding-left:0}.workflow-body,.workflow-header,.workflow-footer{padding-inline:16px}}
</style>

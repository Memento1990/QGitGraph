<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { DEFAULT_SETTINGS, type AppSettings, type ChangedFile } from '../shared/protocol';
import type { HistoryController } from '../controllers/history';
import { formatDate, shortOid } from '../lib/format';
import { useLocale } from '../lib/vue-locale';
import FileTree from './FileTree.vue';
import MessageText from './MessageText.vue';

const { text } = useLocale();
const props = withDefaults(defineProps<{ controller: HistoryController; settings?: AppSettings; horizontal?: boolean; ratio?: number }>(), { horizontal: false, ratio: .55 });
const emit = defineEmits<{ close: []; follow: [oid: string]; context: [value: { file: ChangedFile; event: MouseEvent | KeyboardEvent }]; adjacent: [direction: -1 | 1]; ratio: [value: number]; openUrl: [url: string] }>();
const panel = ref<HTMLElement>(), localRatio = ref(.55);
const normalizeRatio = (value: number): number => Math.max(.25, Math.min(.8, Number.isFinite(value) ? value : .55));
watch(() => props.ratio, value => { localRatio.value = normalizeRatio(value); }, { immediate: true });
let dragging: number | null = null;
function resizeStart(event: PointerEvent): void {
  if (event.button !== 0) return;
  dragging = event.pointerId; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); event.preventDefault();
}
function resizeMove(event: PointerEvent): void {
  if (dragging !== event.pointerId || !panel.value) return;
  const bounds = panel.value.getBoundingClientRect();
  if (bounds.width > 0) localRatio.value = normalizeRatio((event.clientX - bounds.left) / bounds.width);
}
function resizeEnd(event: PointerEvent): void {
  if (dragging !== event.pointerId) return;
  dragging = null; const element = event.currentTarget as HTMLElement;
  if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
  emit('ratio', localRatio.value);
}
function resizeKey(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
  const step = event.shiftKey ? .1 : .02;
  if (event.key === 'ArrowLeft') localRatio.value = normalizeRatio(localRatio.value - step);
  else if (event.key === 'ArrowRight') localRatio.value = normalizeRatio(localRatio.value + step);
  else if (event.key === 'Home') localRatio.value = .25;
  else if (event.key === 'End') localRatio.value = .8;
  else return;
  event.preventDefault(); event.stopPropagation(); emit('ratio', localRatio.value);
}
function adjacentKey(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const target = event.target as HTMLElement | null;
  if (target?.isContentEditable || target?.closest('input,textarea,select,button,a,[role="tree"],[role="separator"],[role="textbox"],[contenteditable]:not([contenteditable="false"])')) return;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault(); event.stopPropagation(); emit('adjacent', event.key === 'ArrowUp' ? -1 : 1);
}
const state = computed(() => props.controller.state), detail = computed(() => state.value.detail), metadata = ref<HTMLElement>();
const fileView = ref<'tree' | 'list'>(props.settings?.fileView ?? 'tree');
watch(() => props.settings?.fileView, value => { if (value) fileView.value = value; });
watch(() => state.value.selection, async () => { await nextTick(); if (metadata.value) metadata.value.scrollTop = state.value.metadataScrollTop; });
const title = computed(() => state.value.selection?.kind === 'compare' ? `${shortOid(state.value.selection.base ?? 'ROOT')} → ${shortOid(state.value.selection.target)}` : state.value.selected ? shortOid(state.value.selected) : text('提交详情', 'Commit details'));
function filterInput(event: Event): void { props.controller.updateReading({ fileFilter: (event.target as HTMLInputElement).value }); }
function parentChanged(event: Event): void { void props.controller.selectParent((event.target as HTMLSelectElement).value); }
</script>

<template>
  <section ref="panel" class="ci-panel" :class="{ horizontal }" :style="{ '--inspector-info-ratio': `${localRatio}fr`, '--inspector-files-ratio': `${1 - localRatio}fr` }" :aria-label="text('提交检查器', 'Commit inspector')" :aria-busy="state.status === 'loading'" tabindex="0" @keydown="adjacentKey">
    <header class="ci-header"><h2>{{ title }}</h2><div class="ci-actions"><button v-if="state.review.available" type="button" :aria-pressed="state.review.active" @click="state.review.active ? controller.stopReview() : controller.startReview()">{{ state.review.active ? text('结束审阅', 'End review') : state.review.reviewed.size ? text('继续审阅', 'Resume review') : text('开始审阅', 'Start review') }}</button><button type="button" :aria-label="text('关闭提交检查器', 'Close commit inspector')" :title="text('关闭提交检查器', 'Close commit inspector')" @click="emit('close')"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.4" /></svg></button></div></header>
    <div v-if="state.status === 'idle'" class="ci-state">{{ text('选择一个提交，查看作者、父提交与变更文件。', 'Select a commit to see authors, parents and changed files.') }}</div>
    <div v-else-if="state.status === 'loading'" class="ci-state" role="status">{{ text('正在读取提交详情…', 'Reading commit details…') }}<button type="button" @click="controller.cancel()">{{ text('取消', 'Cancel') }}</button></div>
    <div v-else-if="state.status !== 'ready'" class="ci-state" :role="state.status === 'cancelled' ? 'status' : 'alert'"><strong>{{ state.status === 'cancelled' ? text('读取已取消', 'Read cancelled') : state.status === 'blocked' ? text('当前无法读取提交', 'Commit read unavailable') : text('读取提交失败', 'Commit read failed') }}</strong><pre>{{ state.error?.message }}{{ state.error?.detail ? `\n${state.error.detail}` : '' }}</pre><button type="button" @click="controller.retry()">{{ text('重试', 'Retry') }}</button></div>
    <template v-else>
      <div ref="metadata" class="ci-metadata" @scroll="controller.updateReading({ metadataScrollTop: ($event.target as HTMLElement).scrollTop })">
        <template v-if="detail">
          <h3><MessageText :text="detail.commit.subject" :settings="settings ?? DEFAULT_SETTINGS" inline @open-url="emit('openUrl', $event)" /></h3>
          <dl class="ci-facts"><dt>{{ text('作者', 'Author') }}</dt><dd>{{ detail.commit.author }} <span class="ci-muted">&lt;{{ detail.commit.email }}&gt;</span></dd><dt>{{ text('创作时间', 'Authored') }}</dt><dd>{{ formatDate(detail.commit.authoredAt, 'iso') }}</dd><dt>{{ text('提交者', 'Committer') }}</dt><dd>{{ detail.committer }} <span class="ci-muted">&lt;{{ detail.committerEmail }}&gt;</span></dd><dt>{{ text('提交时间', 'Committed') }}</dt><dd>{{ formatDate(detail.commit.committedAt, 'iso') }}</dd><dt>{{ text('提交 OID', 'Commit OID') }}</dt><dd><code class="ci-oid">{{ detail.commit.oid }}</code></dd><dt>{{ text('父提交', 'Parents') }}</dt><dd v-if="detail.commit.parents.length" class="ci-parents"><button v-for="parent in detail.commit.parents" :key="parent" type="button" :title="parent" @click="emit('follow', parent)">{{ shortOid(parent) }}</button></dd><dd v-else>{{ text('根提交 · 空树比较', 'Root commit · empty-tree comparison') }}</dd><template v-if="settings?.signatureDisplay || detail.signature.status && detail.signature.status !== 'N'"><dt>{{ text('签名', 'Signature') }}</dt><dd>{{ detail.signature.status }} <span v-if="detail.signature.signer">{{ detail.signature.signer }}</span> <code v-if="detail.signature.key">{{ detail.signature.key }}</code></dd></template></dl>
          <div v-if="detail.commit.refs.length" class="ci-refs"><span v-for="refLabel in detail.commit.refs" :key="refLabel.fullName" :title="refLabel.fullName">{{ refLabel.name }}</span></div>
          <div v-if="detail.body" class="ci-message"><MessageText class="ci-message-text" :class="{ collapsed: !state.fullMessage }" :text="detail.body" :settings="settings ?? DEFAULT_SETTINGS" @open-url="emit('openUrl', $event)" /><button v-if="detail.body.length > 220 || detail.body.split('\n').length > 5" type="button" :aria-expanded="state.fullMessage" @click="controller.updateReading({ fullMessage: !state.fullMessage })">{{ state.fullMessage ? text('收起完整说明', 'Collapse full message') : text('展开完整说明', 'Expand full message') }}</button></div>
        </template>
        <template v-else-if="state.selection?.kind === 'compare'"><h3>{{ text('提交比较', 'Commit comparison') }}</h3><dl class="ci-facts"><dt>{{ text('基准', 'Base') }}</dt><dd><code class="ci-oid">{{ state.selection.base ?? text('空树 (ROOT)', 'Empty tree (ROOT)') }}</code></dd><dt>{{ text('目标', 'Target') }}</dt><dd><code class="ci-oid">{{ state.selection.target }}</code></dd></dl></template>
      </div>
      <div v-if="horizontal" class="ci-ratio-handle" role="separator" tabindex="0" aria-orientation="vertical" :aria-label="text('调整提交信息与文件列表比例', 'Resize commit metadata and file list')" :aria-valuenow="Math.round(localRatio * 100)" :aria-valuemin="25" :aria-valuemax="80" @pointerdown="resizeStart" @pointermove="resizeMove" @pointerup="resizeEnd" @pointercancel="resizeEnd" @keydown="resizeKey" />
      <div class="ci-file-heading"><strong>{{ text('变更文件', 'Changed files') }} <span>{{ state.files.length }}</span></strong><label v-if="detail && detail.commit.parents.length > 1" class="ci-parent-select">{{ text('比较父提交', 'Compare parent') }}<select :value="detail.base" @change="parentChanged"><option v-for="(parent, index) in detail.commit.parents" :key="parent" :value="parent">{{ index + 1 }} · {{ shortOid(parent) }}</option></select></label><label class="ci-view"><span class="sr-only">{{ text('文件视图', 'File view') }}</span><select v-model="fileView"><option value="tree">{{ text('目录树', 'Tree') }}</option><option value="list">{{ text('文件列表', 'List') }}</option></select></label></div>
      <div class="ci-filter"><label for="inspector-file-filter" class="sr-only">{{ text('筛选变更文件', 'Filter changed files') }}</label><input id="inspector-file-filter" type="search" :value="state.fileFilter" :placeholder="text('筛选文件路径…', 'Filter file paths…')" @input="filterInput"></div>
      <FileTree :files="state.files" :selected="state.selectedPath" :reviewed="state.review.reviewed" :view="fileView" :compact="settings?.compactFolders ?? true" :filter="state.fileFilter" :scroll-top="state.filesScrollTop" :scroll-left="state.filesScrollLeft" @open="controller.openFile" @scroll="controller.updateReading" @context="emit('context', $event)" />
      <footer class="ci-footer"><span>{{ text('点击文件打开真实差异', 'Open a file to view its diff') }}</span><span v-if="state.review.active">{{ text('审阅中', 'Reviewing') }} · {{ state.review.reviewed.size }} / {{ state.files.length }}</span><span v-else>{{ text('历史只读', 'Read-only history') }}</span></footer>
    </template>
  </section>
</template>

<style scoped>
.ci-panel { display:flex; flex-direction:column; min-width:0; min-height:0; height:100%; overflow:hidden; background:var(--panel,#17191c); color:var(--text,#e6e8eb); font:12px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif; }
.ci-panel:focus-visible { outline:1px solid var(--brand); outline-offset:-1px; }
.ci-header { display:flex; flex-shrink:0; align-items:center; justify-content:space-between; gap:10px; min-height:38px; padding:0 12px 0 16px; border-bottom:1px solid var(--line,#2b2e32); } h2 { font:500 12px Consolas,monospace; margin:0; color:var(--muted,#979da5); }.ci-actions { display:flex; align-items:center; gap:6px; }
button,input,select { min-height:27px; border:1px solid var(--line); border-radius:4px; padding:3px 7px; background:var(--panel-muted,#121416); color:inherit; font:inherit; font-size:12px; } button { cursor:pointer; } button[aria-pressed="true"] { color:var(--brand,#b1d5be); border-color:var(--brand); }.ci-actions>button:last-child { border:0; background:transparent; display:grid; place-items:center; }
:is(button,input,select):focus-visible { outline:2px solid var(--brand); outline-offset:1px; }.ci-metadata { padding:15px 18px 14px; max-height:55%; flex:0 1 auto; min-height:100px; overflow:auto; scrollbar-gutter:stable; }
h3 { margin:0 0 15px; font-size:16px; font-weight:600; overflow-wrap:anywhere; line-height:1.55; }.ci-facts { display:grid; grid-template-columns:64px minmax(0,1fr); column-gap:10px; row-gap:6px; margin:0; } dt { color:var(--muted); } dd { margin:0; min-width:0; overflow-wrap:anywhere; } code { font:11px/1.5 Consolas,"Cascadia Code",monospace; }.ci-oid { user-select:all; overflow-wrap:anywhere; }.ci-muted { color:var(--muted); }
.ci-parents { display:flex; flex-wrap:wrap; gap:5px; }.ci-parents button { color:var(--brand); font-family:Consolas,monospace; font-size:11px; min-height:23px; padding:1px 5px; }.ci-refs { display:flex; flex-wrap:wrap; gap:5px; margin:12px 0 0; }.ci-refs span { border:1px solid var(--line); border-radius:3px; padding:0 5px; font-size:11px; color:var(--brand); }
.ci-message { margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }.ci-message-text { white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; line-height:1.8; margin:0 0 8px; }.ci-message-text.collapsed { max-height:9em; overflow:hidden; }.ci-message button { color:var(--brand); background:transparent; border:0; padding-left:0; }
.ci-file-heading { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-height:38px; padding:4px 12px; border-block:1px solid var(--line); flex-shrink:0; }.ci-file-heading strong { font-weight:500; }.ci-file-heading strong span { margin-left:5px; color:var(--muted); font-weight:400; }.ci-parent-select { margin-left:auto; display:flex; align-items:center; gap:5px; font-size:11px; color:var(--muted); }.ci-parent-select select { max-width:135px; color:var(--text); }.ci-view { margin-left:auto; }.ci-filter { padding:8px 12px; flex-shrink:0; }.ci-filter input { width:100%; box-sizing:border-box; }
.ci-footer { display:flex; justify-content:space-between; gap:8px; border-top:1px solid var(--line); padding:5px 12px; flex-shrink:0; color:var(--muted); font-size:11px; }.ci-footer span:last-child { color:var(--brand); }.ci-state { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; flex:1; padding:24px; color:var(--muted); text-align:center; }.ci-state pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; }.ci-state[role="alert"] strong { color:var(--danger,#e8a09b); }
.ci-panel.horizontal { display:grid; grid-template-columns:minmax(0,var(--inspector-info-ratio)) 5px minmax(0,var(--inspector-files-ratio)); grid-template-rows:39px auto 43px minmax(0,1fr) 28px; }
.ci-panel.horizontal .ci-header { grid-column:1 / -1; grid-row:1; }
.ci-panel.horizontal .ci-metadata { grid-column:1; grid-row:2 / 5; max-height:none; min-height:0; border-right:1px solid var(--line); }
.ci-panel.horizontal .ci-ratio-handle { grid-column:2; grid-row:2 / 5; cursor:col-resize; touch-action:none; background:var(--line); outline-offset:-1px; }
.ci-panel.horizontal .ci-ratio-handle:hover,.ci-panel.horizontal .ci-ratio-handle:focus-visible { background:var(--brand); outline:1px solid var(--brand); }
.ci-panel.horizontal .ci-file-heading { grid-column:3; grid-row:2; border-top:0; }
.ci-panel.horizontal .ci-filter { grid-column:3; grid-row:3; }
.ci-panel.horizontal :deep(.ft-viewport) { grid-column:3; grid-row:4; }
.ci-panel.horizontal .ci-footer { grid-column:1 / -1; grid-row:5; }
.ci-panel.horizontal .ci-state { grid-column:1 / -1; grid-row:2 / 6; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
</style>

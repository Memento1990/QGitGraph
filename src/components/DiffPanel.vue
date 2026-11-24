<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { DiffController, DiffMode } from '../controllers/diff';
import { DiffRowLayout, minimalDiffScrollTop, type DiffViewLine } from '../lib/diff';
import { useLocale } from '../lib/vue-locale';

const { text } = useLocale();
const props = defineProps<{ controller: DiffController }>();
const emit = defineEmits<{ close: [] }>();
const state = computed(() => props.controller.state), viewport = ref<HTMLElement>(), top = ref(0), height = ref(500);
const rows = computed(() => state.value.rows.lines);
const rowLayout = computed(() => new DiffRowLayout(rows.value.map(row => row.kind === 'gap' || row.kind === 'gap-status' ? 29 : 23)));
const range = computed(() => ({ first: Math.max(0, rowLayout.value.indexAt(top.value) - 12), last: Math.min(rows.value.length, rowLayout.value.indexAt(top.value + height.value) + 13) }));
const visible = computed(() => rows.value.slice(range.value.first, range.value.last).map((line, index) => ({ line, index: range.value.first + index, top: rowLayout.value.offsetAt(range.value.first + index), height: rowLayout.value.heightAt(range.value.first + index) })));
const split = computed(() => state.value.mode === 'split');
const minWidth = computed(() => {
  let left = 0, right = 0;
  for (const row of rows.value) { if (row.kind === 'gap' || row.kind === 'gap-status') continue; left = Math.max(left, row.left.length); right = Math.max(right, row.right?.length ?? 0); }
  return Math.min(100000, split.value ? Math.max(700, Math.max(left, right) * 7.3 * 2 + 150) : Math.max(480, left * 7.3 + 130));
});
const activeIndex = computed(() => (state.value.rows.changes ?? []).findIndex(change => change.id === state.value.reading.activeChange));
const activeSide = computed(() => state.value.mode === 'old' || state.value.mode === 'new' ? state.value.sides[state.value.mode] : null);
const sideWarning = computed(() => ['old', 'new'].map(side => ({ side, ...state.value.sides[side as 'old' | 'new'] })).filter(side => ['error', 'binary', 'truncated', 'cancelled', 'blocked'].includes(side.status)));
const canShowRows = computed(() => ['ready', 'truncated'].includes(state.value.status) && (!activeSide.value || activeSide.value.status === 'ready'));
const loadingContent = computed(() => state.value.sides.old.status === 'loading' || state.value.sides.new.status === 'loading');
let observer: ResizeObserver | undefined, restoring = false, restoreVersion = 0;
function lineKey(line: DiffViewLine, index: number): string { return line.id ?? `${line.kind}:${line.old ?? ''}:${line.next ?? ''}:${index}`; }
function onScroll(): void {
  if (!viewport.value || restoring || viewport.value.clientHeight <= 0) return;
  top.value = viewport.value.scrollTop;
  const index = Math.min(rows.value.length - 1, rowLayout.value.indexAt(top.value)), line = rows.value[index];
  props.controller.updateReading({ scrollTop: top.value, scrollLeft: viewport.value.scrollLeft, anchor: line ? { id: line.id, changeId: line.changeId, gapId: line.gapId, old: line.old, next: line.next, offset: top.value - rowLayout.value.offsetAt(index) } : undefined });
}
function anchorIndex(): number {
  const anchor = state.value.reading.anchor; if (!anchor) return -1;
  if (anchor.id) { const index = rows.value.findIndex(line => line.id === anchor.id); if (index >= 0) return index; }
  const index = rows.value.findIndex(line => anchor.old != null && line.old === anchor.old || anchor.next != null && line.next === anchor.next);
  if (index >= 0) return index;
  return rows.value.findIndex(line => anchor.changeId && line.changeId === anchor.changeId || anchor.gapId && line.gapId === anchor.gapId);
}
async function restoreReading(reveal = false): Promise<void> {
  const version = ++restoreVersion; restoring = true; await nextTick();
  const element = viewport.value;
  if (version !== restoreVersion || !element || element.clientHeight <= 0) { if (version === restoreVersion) restoring = false; return; }
  const reading = state.value.reading, index = anchorIndex();
  let value = index < 0 ? reading.scrollTop : rowLayout.value.offsetAt(index) + Math.min(rowLayout.value.heightAt(index) - 1, Math.max(0, reading.anchor?.offset ?? 0));
  const change = reveal && state.value.rows.changes?.find(item => item.id === reading.activeChange);
  if (change) value = minimalDiffScrollTop(value, element.clientHeight, rowLayout.value.offsetAt(change.first), rowLayout.value.offsetAt(change.last), 23);
  element.scrollTop = value; element.scrollLeft = reading.scrollLeft; top.value = element.scrollTop;
  await nextTick(); if (version === restoreVersion) restoring = false;
}
watch(() => [state.value.identity, rows.value], () => { void restoreReading(); }, { flush: 'post' });
watch(() => state.value.readingRevision, () => { void restoreReading(true); }, { flush: 'post' });
function chooseMode(event: Event): void { onScroll(); void props.controller.setMode((event.target as HTMLSelectElement).value as DiffMode); }
function chooseContext(event: Event): void { onScroll(); void props.controller.setContext(Number((event.target as HTMLSelectElement).value)); }
function gapLabel(line: DiffViewLine): string { return `${line.expanded ? text('收起未改上下文', 'Collapse unchanged context') : text('展开未改上下文', 'Expand unchanged context')}${line.gapCount === undefined ? '' : ` · ${line.gapCount} ${text('行', 'lines')}`}`; }
function statusLabel(status: string | undefined): string {
  return status === 'binary' ? text('二进制内容不可作为文本显示', 'Binary content cannot be displayed as text') : status === 'truncated' || status === 'limited' ? text('内容超过限制，未提供完整正文', 'Content exceeds the limit; complete text is unavailable') : status === 'loading' ? text('正在读取真实文件内容…', 'Reading file content…') : status === 'cancelled' ? text('内容读取已取消', 'Content read cancelled') : text('未能取得完整上下文，请重试或查看单侧正文', 'Complete context is unavailable. Retry or view one side.');
}
onMounted(() => {
  if (viewport.value && typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => { height.value = viewport.value?.clientHeight || 500; if (!restoring) void restoreReading(); }); observer.observe(viewport.value); height.value = viewport.value.clientHeight || 500; }
  void restoreReading();
});
onBeforeUnmount(() => { onScroll(); observer?.disconnect(); restoreVersion++; });
</script>

<template>
  <section class="dp-panel" :class="{ 'is-split': split }" :aria-label="text('文件差异', 'File diff')" @keydown="controller.handleKeydown">
    <header class="dp-heading"><div class="dp-identity"><strong>{{ state.selection?.path ?? text('文件差异', 'File diff') }}</strong><span v-if="state.selection?.oldPath && state.selection.oldPath !== state.selection.path" class="dp-rename">{{ text('原路径', 'Previous path') }} {{ state.selection.oldPath }}</span><span v-if="state.selection" class="dp-target"><code>{{ state.selection.base?.slice(0, 8) ?? 'ROOT' }}</code><span>→</span><code>{{ state.selection.target.slice(0, 12) }}</code><span>{{ state.historical ? text('历史快照', 'Historical snapshot') : state.selection.group ?? text('本地变更', 'Local changes') }}</span></span></div><button class="dp-close" type="button" :aria-label="text('关闭文件差异', 'Close file diff')" :title="text('关闭文件差异', 'Close file diff')" @click="emit('close')"><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" stroke-width="1.4" /></svg></button></header>
    <div v-if="state.selection" class="dp-toolbar" role="toolbar" :aria-label="text('差异显示设置', 'Diff display settings')">
      <label>{{ text('视图', 'View') }}<select :value="state.mode" @change="chooseMode"><option value="unified">{{ text('统一差异', 'Unified diff') }}</option><option value="split">{{ text('并排差异', 'Side-by-side diff') }}</option><option value="old">{{ text('旧文件全文', 'Full old file') }}</option><option value="new">{{ text('新文件全文', 'Full new file') }}</option></select></label>
      <label v-if="!activeSide">{{ text('上下文', 'Context') }}<select :value="state.context" @change="chooseContext"><option :value="0">0 {{ text('行', 'lines') }}</option><option :value="3">3 {{ text('行', 'lines') }}</option><option :value="10">10 {{ text('行', 'lines') }}</option><option :value="50">50 {{ text('行', 'lines') }}</option><option v-if="![0, 3, 10, 50].includes(state.context)" :value="state.context">{{ state.context }} {{ text('行', 'lines') }}</option></select></label>
      <button v-if="!activeSide" type="button" :aria-pressed="state.reading.showUnchanged" :disabled="!['ready', 'truncated'].includes(state.status)" @click="controller.setShowUnchanged(!state.reading.showUnchanged)">{{ text('未改上下文', 'Unchanged context') }}</button>
      <div v-if="state.historical" class="dp-navigation"><button type="button" :title="text('上一文件 · Alt+PageUp', 'Previous file · Alt+PageUp')" :disabled="state.fileIndex <= 0" @click="controller.navigateFile(-1)">{{ text('上一文件', 'Previous file') }}</button><span>{{ state.fileCount ? `${state.fileIndex + 1} / ${state.fileCount}` : '—' }}</span><button type="button" :title="text('下一文件 · Alt+PageDown', 'Next file · Alt+PageDown')" :disabled="state.fileIndex < 0 || state.fileIndex >= state.fileCount - 1" @click="controller.navigateFile(1)">{{ text('下一文件', 'Next file') }}</button><span class="dp-divider" /><button type="button" :title="text('上一处改动 · Alt+Shift+F5', 'Previous change · Alt+Shift+F5')" @click="controller.navigateChange(-1)">{{ text('上一处', 'Previous change') }}</button><span>{{ activeIndex + 1 }} / {{ state.rows.document?.changes.length ?? 0 }}</span><button type="button" :title="text('下一处改动 · Alt+F5', 'Next change · Alt+F5')" @click="controller.navigateChange(1)">{{ text('下一处', 'Next change') }}</button></div>
      <button v-if="loadingContent" type="button" @click="controller.cancelContent()">{{ text('取消正文读取', 'Cancel content read') }}</button>
    </div>
    <div v-if="state.status === 'truncated' || state.rows.limited" class="dp-warning" role="status">{{ text('差异超过显示限制。仅显示已实际取得的部分，不代表完整文件或完整比较。', 'This diff exceeds display limits. Only the retrieved portion is shown, not the complete file or comparison.') }}</div>
    <div v-for="warning in sideWarning" :key="warning.side" class="dp-warning" role="status">{{ warning.side === 'old' ? text('旧文件', 'Old file') : text('新文件', 'New file') }} · {{ warning.error?.message ?? statusLabel(warning.status) }} <button v-if="warning.status !== 'binary'" type="button" @click="controller.ensureContent(warning.side as 'old' | 'new')">{{ text('重试正文', 'Retry content') }}</button></div>
    <div v-if="split && canShowRows" class="dp-side-head" aria-hidden="true"><span>{{ text('旧文件', 'Old file') }}</span><span>{{ text('新文件', 'New file') }}</span></div>
    <div ref="viewport" class="dp-viewport" tabindex="0" role="region" :aria-label="text('差异正文', 'Diff content')" :aria-busy="state.status === 'loading' || loadingContent" @scroll="onScroll">
      <div v-if="state.status === 'idle'" class="dp-state">{{ text('从提交详情中打开一个变更文件。', 'Open a changed file from the commit details.') }}</div>
      <div v-else-if="state.status === 'loading'" class="dp-state" role="status">{{ text('正在读取真实差异…', 'Reading diff…') }}<button type="button" @click="controller.cancel()">{{ text('取消', 'Cancel') }}</button></div>
      <div v-else-if="['error', 'cancelled', 'blocked'].includes(state.status)" class="dp-state" :role="state.status === 'cancelled' ? 'status' : 'alert'"><strong>{{ state.status === 'cancelled' ? text('差异读取已取消', 'Diff read cancelled') : state.status === 'blocked' ? text('当前无法读取差异', 'Diff read unavailable') : text('差异读取失败', 'Diff read failed') }}</strong><pre>{{ state.error?.message }}{{ state.error?.detail ? `\n${state.error.detail}` : '' }}</pre><button type="button" @click="controller.retry()">{{ text('重试', 'Retry') }}</button></div>
      <div v-else-if="state.status === 'binary'" class="dp-state" role="status">{{ text('此文件是二进制文件。没有可展示的文本差异。', 'This is a binary file. No text diff is available.') }}</div>
      <div v-else-if="activeSide && activeSide.status !== 'ready'" class="dp-state" role="status"><strong>{{ activeSide.error?.message ?? statusLabel(activeSide.status) }}</strong><button v-if="activeSide.status !== 'loading' && activeSide.status !== 'binary'" type="button" @click="controller.ensureContent(state.mode as 'old' | 'new')">{{ text('读取此侧正文', 'Read this side') }}</button><button v-if="activeSide.status === 'loading'" type="button" @click="controller.cancelContent()">{{ text('取消', 'Cancel') }}</button></div>
      <template v-else-if="canShowRows">
        <div v-if="!rows.length || !activeSide && !state.rows.document?.changes.length" class="dp-empty">{{ activeSide ? text('此侧是空文本文件。', 'This side is an empty text file.') : text('此文件没有文本改动。可能只有文件模式、路径或元数据变化。', 'No text changes. File mode, path or metadata may have changed.') }}</div>
        <div class="dp-canvas" :style="{ height: `${rowLayout.height}px`, minWidth: `${minWidth}px` }">
          <div v-for="row in visible" :key="lineKey(row.line, row.index)" class="dp-line" :class="[row.line.kind, { 'active-change': row.line.changeId && row.line.changeId === state.reading.activeChange }]" :style="{ top: `${row.top}px`, height: `${row.height}px` }">
            <button v-if="row.line.kind === 'gap'" class="dp-gap" type="button" :aria-expanded="row.line.expanded" @click="controller.toggleGap(row.line.gapId!)"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path :d="row.line.expanded ? 'M2 8 6 4 10 8' : 'M2 4 6 8 10 4'" fill="none" stroke="currentColor" stroke-width="1.2" /></svg>{{ gapLabel(row.line) }}</button>
            <span v-else-if="row.line.kind === 'gap-status'" class="dp-gap-status">{{ statusLabel(row.line.gapStatus) }}</span>
            <code v-else-if="row.line.kind === 'change' || row.line.kind === 'hunk'" class="dp-hunk">{{ row.line.left }}</code>
            <template v-else-if="split"><span class="dp-half" :class="{ removed: row.line.sign?.[0] === '-' }"><span class="dp-number" aria-hidden="true">{{ row.line.old ?? '' }}</span><code class="dp-code">{{ row.line.left }}</code></span><span class="dp-half" :class="{ added: row.line.sign?.[1] === '+' }"><span class="dp-number" aria-hidden="true">{{ row.line.next ?? '' }}</span><code class="dp-code">{{ row.line.right ?? '' }}</code></span></template>
            <template v-else><span v-if="!activeSide || state.mode === 'old'" class="dp-number" aria-hidden="true">{{ row.line.old ?? '' }}</span><span v-if="!activeSide || state.mode === 'new'" class="dp-number" aria-hidden="true">{{ row.line.next ?? '' }}</span><span class="dp-sign" aria-hidden="true">{{ row.line.sign ?? '' }}</span><code class="dp-code">{{ row.line.left }}</code></template>
          </div>
        </div>
      </template>
    </div>
    <footer class="dp-footer"><span>{{ state.mode === 'old' ? text('旧文件全文 · 按需读取', 'Full old file · on demand') : state.mode === 'new' ? text('新文件全文 · 按需读取', 'Full new file · on demand') : `${state.rows.document?.changes.length ?? 0} ${text('处文本改动', 'text changes')}` }}</span><span>{{ state.historical ? text('Alt+F5 改动 · Alt+PageUp / PageDown 文件', 'Alt+F5 changes · Alt+PageUp / PageDown files') : text('本地变更 · 不使用历史快捷键', 'Local changes · history shortcuts disabled') }}</span></footer>
  </section>
</template>

<style scoped>
.dp-panel { display:flex; flex-direction:column; min-width:0; min-height:0; height:100%; overflow:hidden; background:var(--panel,#17191c); color:var(--text,#e6e8eb); font:12px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif; }
.dp-heading { display:flex; flex-shrink:0; align-items:center; gap:12px; min-height:55px; padding:8px 14px; border-bottom:1px solid var(--line,#2b2e32); }.dp-identity { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }.dp-identity strong { font:500 13px/1.5 Consolas,"Cascadia Code",monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.dp-target { display:flex; gap:8px; color:var(--muted,#979da5); font-size:11px; }.dp-rename { color:var(--muted); font:11px Consolas,monospace; overflow-wrap:anywhere; }
button,select { min-height:27px; border:1px solid var(--line); border-radius:4px; padding:3px 7px; color:inherit; background:var(--panel-muted,#121416); font:inherit; font-size:12px; } button { cursor:pointer; } button:disabled { cursor:default; opacity:.45; } :is(button,select):focus-visible { outline:2px solid var(--brand,#b1d5be); outline-offset:1px; } .dp-close { border:0; background:transparent; display:grid; place-items:center; }
.dp-toolbar { display:flex; align-items:center; flex-shrink:0; flex-wrap:wrap; gap:8px; min-height:39px; padding:4px 12px; border-bottom:1px solid var(--line); color:var(--muted); }.dp-toolbar label { display:flex; align-items:center; gap:5px; font-size:11px; }.dp-toolbar select { color:var(--text); }.dp-toolbar button[aria-pressed="true"] { color:var(--brand); border-color:var(--brand); }.dp-navigation { display:flex; align-items:center; gap:6px; margin-left:auto; }.dp-navigation span { font-size:11px; font-variant-numeric:tabular-nums; }.dp-divider { width:1px; height:15px; margin:0 3px; background:var(--line); }
.dp-side-head { display:grid; grid-template-columns:1fr 1fr; min-height:25px; flex-shrink:0; border-bottom:1px solid var(--line); background:var(--panel-muted); color:var(--muted); font-size:11px; }.dp-side-head span { padding:3px 14px; }.dp-side-head span+span { border-left:1px solid var(--line); }
.dp-warning { padding:6px 12px; flex-shrink:0; color:var(--danger,#e8a09b); border-bottom:1px solid var(--line); font-size:11px; overflow-wrap:anywhere; }.dp-warning button { min-height:23px; margin-left:5px; font-size:11px; }
.dp-viewport { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; }.dp-viewport:focus-visible { outline:1px solid var(--brand); outline-offset:-1px; }.dp-canvas { position:relative; min-width:100%; }.dp-line { position:absolute; display:flex; align-items:stretch; left:0; right:0; box-sizing:border-box; white-space:pre; font:12px/23px Consolas,"Cascadia Code",monospace; }.dp-line.active-change.change { box-shadow:inset 3px 0 var(--brand); }
.dp-number { display:inline-block; flex:0 0 48px; padding:0 6px; box-sizing:border-box; color:var(--muted); background:var(--panel-muted); text-align:right; user-select:none; font-variant-numeric:tabular-nums; }.dp-sign { width:22px; flex-shrink:0; text-align:center; user-select:none; }.dp-code { display:block; padding:0 12px 0 3px; font:inherit; white-space:pre; tab-size:4; flex:1; min-width:0; }.dp-line.addition,.dp-half.added { background:color-mix(in srgb,var(--brand) 12%,var(--panel)); }.dp-line.deletion,.dp-half.removed { background:color-mix(in srgb,var(--danger) 12%,var(--panel)); }.addition .dp-sign { color:var(--brand); }.deletion .dp-sign { color:var(--danger); }.dp-line.meta { color:var(--muted); }
.dp-half { display:flex; flex:0 0 50%; min-width:0; box-sizing:border-box; }.dp-half+.dp-half { border-left:1px solid var(--line); }.dp-hunk { font:inherit; font-size:11px; width:100%; padding-left:14px; background:color-mix(in srgb,var(--brand) 5%,var(--panel-muted)); color:var(--muted); user-select:none; }
.dp-gap { display:flex; align-items:center; justify-content:center; gap:8px; width:100%; height:29px; border-width:1px 0; border-radius:0; color:var(--muted); font-size:11px; background:var(--panel-muted); }.dp-gap:hover { color:var(--brand); }.dp-gap-status { width:100%; padding-left:16px; background:var(--panel-muted); color:var(--muted); font-size:11px; line-height:29px; }
.dp-state { min-height:220px; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; box-sizing:border-box; gap:12px; padding:24px; color:var(--muted); text-align:center; }.dp-state pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; margin:0; }.dp-state[role="alert"] strong { color:var(--danger); }.dp-empty { padding:25px; color:var(--muted); text-align:center; }.dp-footer { display:flex; justify-content:space-between; gap:12px; flex-shrink:0; padding:5px 12px; border-top:1px solid var(--line); color:var(--muted); font-size:11px; }
.sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; }
</style>

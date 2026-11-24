<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { AppSettings, Commit, GitRef, HistoryQuery } from '../shared/protocol';
import type { GraphEdge, GraphRow } from '../lib/graph';
import { RowLayout } from '../ui/navigation';
import { HistoryLayoutCache } from '../lib/performance-models';
import { commitDate, formatDate, shortOid } from '../lib/format';
import { useLocale } from '../lib/vue-locale';
import MessageText from './MessageText.vue';

const { text } = useLocale();
const props = withDefaults(defineProps<{
  commits: readonly Commit[]; graph?: readonly GraphRow[]; settings: AppSettings;
  selected?: string | null; loading?: boolean; hasMore?: boolean; error?: string | null;
  query?: Partial<HistoryQuery>; comparisonBase?: string | null; generation?: string | number;
  inlineDetails?: boolean; inlineHeight?: number; inlineSide?: 'above' | 'below';
}>(), { selected: null, loading: false, hasMore: false, error: null, comparisonBase: null, generation: 0, inlineDetails: false, inlineHeight: 310, inlineSide: 'below' });
const emit = defineEmits<{
  select: [commit: Commit, ensureOpen?: boolean]; loadMore: []; query: [query: Partial<HistoryQuery>];
  context: [value: { commit: Commit; event: MouseEvent | KeyboardEvent }];
  refContext: [value: { ref: GitRef; commit: Commit; event: MouseEvent | KeyboardEvent }]; openUrl: [url: string];
  compare: [value: { base: string; target: string }]; comparisonBase: [oid: string | null]; retry: [];
}>();
const list = ref<HTMLElement>(), scrollTop = ref(0), scrollLeft = ref(0), height = ref(500), width = ref(0);
const search = ref(props.query?.search ?? ''), composing = ref(false);
const layout = new HistoryLayoutCache();
const graph = computed(() => props.graph ?? layout.prepare({ commits: props.commits, visible: props.commits, topologyRevision: props.generation }));
const graphByOid = computed(() => new Map(graph.value.map(row => [row.oid, row])));
const rowHeight = computed(() => Math.max(22, props.settings.rowHeight));
const geometry = computed(() => new RowLayout(props.commits.length, rowHeight.value, props.inlineDetails ? props.commits.findIndex(commit => commit.oid === props.selected) : -1, props.inlineHeight, props.inlineSide === 'above' ? 'before' : 'after'));
const windowRange = computed(() => geometry.value.visibleRange(scrollTop.value, height.value, 10, 10));
const visible = computed(() => props.commits.slice(windowRange.value.first, windowRange.value.last).map((commit, index) => ({ commit, index: windowRange.value.first + index, graph: graphByOid.value.get(commit.oid) })));
const columns = computed(() => `${props.settings.columnWidths.graph}px minmax(260px,1fr)${props.settings.columns.date ? ` ${props.settings.columnWidths.date}px` : ''}${props.settings.columns.author ? ` ${props.settings.columnWidths.author}px` : ''}${props.settings.columns.commit ? ` ${props.settings.columnWidths.commit}px` : ''}`);
const minWidth = computed(() => props.settings.columnWidths.graph + 260 + (props.settings.columns.date ? props.settings.columnWidths.date : 0) + (props.settings.columns.author ? props.settings.columnWidths.author : 0) + (props.settings.columns.commit ? props.settings.columnWidths.commit : 0));
const activeId = computed(() => {
  const index = props.commits.findIndex(commit => commit.oid === props.selected);
  return index >= windowRange.value.first && index < windowRange.value.last ? `history-row-${props.selected}` : undefined;
});
let observer: ResizeObserver | undefined, queryTimer: ReturnType<typeof setTimeout> | undefined, requested = false;
watch(() => props.query?.search, value => { search.value = value ?? ''; });
watch(() => [props.commits, props.commits.length, props.loading, props.hasMore], () => { requested = false; });
watch(() => props.generation, () => { scrollTop.value = 0; if (list.value) list.value.scrollTop = 0; });
watch(() => props.selected, async oid => { if (oid) { await nextTick(); reveal(oid); } });
function color(index: number): string { return props.settings.graphColors[index % props.settings.graphColors.length] ?? 'var(--brand)'; }
function edgePath(edge: GraphEdge): string {
  const x1 = 16 + edge.from * 14, x2 = 16 + edge.to * 14, y1 = edge.start * rowHeight.value, y2 = edge.end * rowHeight.value;
  return props.settings.graphStyle === 'angular' ? `M${x1},${y1}L${x1},${(y1 + y2) / 2}L${x2},${y2}` : `M${x1},${y1}C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`;
}
function requestMore(): void { if (!props.loading && props.hasMore && !requested) { requested = true; emit('loadMore'); } }
function onScroll(): void {
  if (!list.value) return; scrollTop.value = list.value.scrollTop; scrollLeft.value = list.value.scrollLeft;
  if (props.settings.autoLoad && scrollTop.value + height.value >= geometry.value.totalHeight - rowHeight.value * 5) requestMore();
}
function reveal(oid: string): void {
  const index = props.commits.findIndex(commit => commit.oid === oid), viewport = list.value;
  if (index < 0 || !viewport) return;
  const top = geometry.value.top(index);
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (top + rowHeight.value > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = top + rowHeight.value - viewport.clientHeight;
  scrollTop.value = viewport.scrollTop;
}
function choose(commit: Commit, event?: MouseEvent): void {
  const base = props.comparisonBase ?? props.selected;
  if ((event?.shiftKey || event?.ctrlKey || event?.metaKey) && base && base !== commit.oid) emit('compare', { base, target: commit.oid });
  else emit('select', commit, false);
}
function refContext(ref: GitRef, commit: Commit, event: MouseEvent | KeyboardEvent): void {
  if ('isComposing' in event && (event.isComposing || event.keyCode === 229)) return;
  event.preventDefault(); event.stopPropagation(); emit('refContext', { ref, commit, event });
}
function refKey(ref: GitRef, commit: Commit, event: KeyboardEvent): void {
  if (!event.defaultPrevented && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) refContext(ref, commit, event);
}
function keydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey || target?.isContentEditable || target?.closest('input,textarea,select,button,a,[role="tree"],[role="separator"],[role="textbox"],[contenteditable]:not([contenteditable="false"])')) return;
  const index = props.commits.findIndex(commit => commit.oid === props.selected);
  if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && index >= 0) { event.preventDefault(); emit('context', { commit: props.commits[index], event }); return; }
  let next = index;
  if (event.key === 'ArrowDown') next = Math.min(props.commits.length - 1, index + 1);
  else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = props.commits.length - 1;
  else if (event.key === 'PageDown') next = Math.min(props.commits.length - 1, Math.max(0, index) + Math.max(1, Math.floor(height.value / rowHeight.value)));
  else if (event.key === 'PageUp') next = Math.max(0, index - Math.max(1, Math.floor(height.value / rowHeight.value)));
  else if (event.key === 'Enter' && index >= 0) { event.preventDefault(); emit('select', props.commits[index], true); return; }
  else return;
  if (next < 0 || !props.commits[next]) return;
  event.preventDefault(); emit('select', props.commits[next], true); reveal(props.commits[next].oid);
}
function searchChanged(): void {
  clearTimeout(queryTimer); if (composing.value) return;
  queryTimer = setTimeout(() => emit('query', { search: search.value }), 180);
}
function querySelect(event: Event, field: 'scope' | 'order' | 'searchMode'): void {
  const value = (event.target as HTMLSelectElement).value;
  if (field === 'scope') emit('query', { scope: { kind: value === 'head' ? 'head' : 'all' } });
  else if (field === 'order') emit('query', { order: value as HistoryQuery['order'] });
  else emit('query', { searchMode: value as HistoryQuery['searchMode'] });
}
onMounted(() => {
  if (list.value && typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => { height.value = list.value?.clientHeight || 500; width.value = list.value?.clientWidth ?? 0; }); observer.observe(list.value); height.value = list.value.clientHeight || 500; width.value = list.value.clientWidth; }
});
onBeforeUnmount(() => { observer?.disconnect(); clearTimeout(queryTimer); layout.clear(); });
defineExpose({ reveal, focus: () => list.value?.focus() });
</script>

<template>
  <section class="hp-panel" :aria-label="text('提交历史', 'Commit history')" :style="{ '--history-columns': columns, fontSize: `${settings.fontSize}px` }">
    <header class="hp-toolbar">
      <h2>{{ text('提交历史', 'Commit history') }} <span class="hp-count">{{ commits.length.toLocaleString() }}</span></h2>
      <label><span class="sr-only">{{ text('历史范围', 'History scope') }}</span><select :value="query?.scope?.kind ?? 'all'" @change="querySelect($event, 'scope')"><option value="all">{{ text('所有分支', 'All branches') }}</option><option value="head">{{ text('当前 HEAD', 'Current HEAD') }}</option><option v-if="query?.scope?.kind === 'refs' || query?.scope?.kind === 'glob'" :value="query.scope.kind">{{ text('指定引用', 'Selected refs') }}</option></select></label>
      <label><span class="sr-only">{{ text('历史顺序', 'History order') }}</span><select :value="query?.order ?? settings.order" @change="querySelect($event, 'order')"><option value="date">{{ text('提交时间', 'Commit date') }}</option><option value="topo">{{ text('拓扑顺序', 'Topology') }}</option><option value="author-date">{{ text('作者时间', 'Author date') }}</option></select></label>
      <div class="hp-search"><label for="history-search" class="sr-only">{{ text('搜索历史', 'Search history') }}</label><input id="history-search" v-model="search" type="search" :placeholder="text('搜索历史…', 'Search history…')" @input="searchChanged" @compositionstart="composing = true" @compositionend="composing = false; searchChanged()"></div>
      <label><span class="sr-only">{{ text('搜索字段', 'Search field') }}</span><select :value="query?.searchMode ?? 'all'" @change="querySelect($event, 'searchMode')"><option value="all">{{ text('全部字段', 'All fields') }}</option><option value="message">{{ text('提交说明', 'Message') }}</option><option value="author">{{ text('作者', 'Author') }}</option><option value="hash">OID</option><option value="date">{{ text('日期', 'Date') }}</option><option value="refs">{{ text('引用', 'References') }}</option></select></label>
      <slot name="toolbar" />
    </header>
    <div v-if="comparisonBase" class="hp-base">{{ text('比较基准', 'Comparison base') }} <code>{{ shortOid(comparisonBase) }}</code><button type="button" @click="emit('comparisonBase', null)">{{ text('清除', 'Clear') }}</button><button v-if="selected && selected !== comparisonBase" type="button" @click="emit('compare', { base: comparisonBase, target: selected })">{{ text('与选中提交比较', 'Compare with selection') }}</button></div>
    <div v-if="error" class="hp-error" role="alert">{{ error }} <button type="button" @click="emit('retry')">{{ text('重试', 'Retry') }}</button></div>
    <div class="hp-column-clip" aria-hidden="true"><div class="hp-columns" :style="{ minWidth: `${minWidth}px`, transform: `translateX(${-scrollLeft}px)` }"><span>{{ text('提交图', 'Graph') }}</span><span>{{ text('提交说明', 'Message') }}</span><span v-if="settings.columns.date">{{ text('时间', 'Date') }}</span><span v-if="settings.columns.author">{{ text('作者', 'Author') }}</span><span v-if="settings.columns.commit">{{ text('提交', 'Commit') }}</span></div></div>
    <div ref="list" class="hp-list" role="listbox" :aria-label="text('提交列表', 'Commits')" :aria-busy="loading" :aria-activedescendant="activeId" tabindex="0" @scroll="onScroll" @keydown="keydown">
      <div class="hp-canvas" :style="{ height: `${geometry.totalHeight}px`, minWidth: `${minWidth}px` }">
        <div v-for="row in visible" :id="`history-row-${row.commit.oid}`" :key="row.commit.oid" class="hp-row" :class="{ 'is-selected': row.commit.oid === selected, 'is-muted': settings.muteMerges && row.commit.parents.length > 1 || settings.muteNonAncestors && row.commit.inHead === false }" role="option" :aria-selected="row.commit.oid === selected" :aria-posinset="row.index + 1" :aria-setsize="hasMore ? -1 : commits.length" :style="{ top: `${geometry.top(row.index)}px`, height: `${rowHeight}px` }" @click="choose(row.commit, $event)" @contextmenu.prevent="emit('context', { commit: row.commit, event: $event })">
          <svg v-if="row.graph" class="hp-graph" :width="settings.columnWidths.graph" :height="rowHeight" aria-hidden="true">
            <path v-for="(edge, edgeIndex) in row.graph.edges" :key="edgeIndex" :d="edgePath(edge)" :stroke="color(edge.color)" fill="none" stroke-width="1.5" />
            <circle :cx="16 + row.graph.lane * 14" :cy="rowHeight / 2" :r="row.graph.merge ? 4.5 : 3.5" :fill="row.commit.oid === selected ? color(row.graph.color) : 'var(--panel)'" :stroke="color(row.graph.color)" stroke-width="1.6" />
          </svg><span v-else />
          <div class="hp-message"><button v-for="refLabel in row.commit.refs.filter(item => (settings.showRemotes || item.kind !== 'remote') && (settings.showTags || item.kind !== 'tag') && (settings.showStashes || item.kind !== 'stash'))" :key="refLabel.fullName" type="button" class="hp-ref" :class="{ current: refLabel.current }" :title="refLabel.fullName" :aria-label="`${text('引用菜单', 'Reference menu')}: ${refLabel.fullName}`" aria-haspopup="menu" @click="refContext(refLabel, row.commit, $event)" @contextmenu="refContext(refLabel, row.commit, $event)" @keydown="refKey(refLabel, row.commit, $event)">{{ refLabel.name }}</button><MessageText class="hp-subject" :title="row.commit.subject" :text="row.commit.subject" :settings="settings" inline @open-url="emit('openUrl', $event)" /></div>
          <span v-if="settings.columns.date" class="hp-time" :title="formatDate(commitDate(row.commit, settings.dateSource), 'iso')">{{ formatDate(commitDate(row.commit, settings.dateSource), settings.dateFormat) }}</span>
          <span v-if="settings.columns.author" class="hp-author" :title="`${row.commit.author} <${row.commit.email}>`">{{ row.commit.author }}</span>
          <code v-if="settings.columns.commit" class="hp-hash" :title="row.commit.oid">{{ shortOid(row.commit.oid) }}</code>
        </div>
        <div v-if="geometry.slotIndex >= 0" class="hp-inline-inspector" :style="{ top: `${geometry.slotTop}px`, height: `${geometry.slotHeight}px`, left: `${scrollLeft}px`, width: `${width}px` }" role="region" :aria-label="text('内嵌提交详情', 'Inline commit details')"><slot name="inspector" /></div>
      </div>
      <div v-if="!commits.length && !loading && !error" class="hp-empty">{{ text('没有匹配的提交。请调整范围或搜索条件。', 'No matching commits. Adjust the scope or search.') }}</div>
      <div v-if="loading" class="hp-loading" role="status">{{ text('正在读取历史…', 'Reading history…') }}</div>
      <div v-if="hasMore" class="hp-more"><button type="button" :disabled="loading" @click="requested = false; requestMore()">{{ loading ? text('读取中…', 'Loading…') : text('加载更多历史', 'Load more history') }}</button></div>
    </div>
    <footer class="hp-footer"><span>{{ commits.length.toLocaleString() }} {{ text('个已加载提交', 'loaded commits') }}{{ hasMore ? text(' · 还有更多', ' · More available') : '' }}</span><span>{{ text('Shift / Ctrl / Cmd + 点击比较 · 方向键浏览', 'Shift / Ctrl / Cmd + click to compare · Arrow keys to browse') }}</span></footer>
  </section>
</template>

<style scoped>
.hp-panel { display:flex; flex-direction:column; height:100%; min-height:0; min-width:0; overflow:hidden; background:var(--panel,#17191c); color:var(--text,#e6e8eb); font-family:"Segoe UI","Microsoft YaHei UI",sans-serif; }
.hp-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; flex-shrink:0; min-width:0; max-width:100%; min-height:48px; box-sizing:border-box; padding:8px 12px; border-bottom:1px solid var(--line,#2b2e32); }
.hp-toolbar > label { flex:0 1 auto; min-width:0; max-width:100%; }
.hp-toolbar select { width:100%; min-width:0; max-width:116px; box-sizing:border-box; }
.hp-toolbar :deep(button) { flex-shrink:0; max-width:100%; white-space:nowrap; }
h2 { margin:0; display:flex; flex:0 1 auto; min-width:0; align-items:center; gap:6px; font-size:13px; font-weight:600; white-space:nowrap; }
.hp-count { flex-shrink:0; color:var(--muted,#979da5); border:1px solid var(--line); border-radius:3px; padding:0 5px; font-size:11px; font-variant-numeric:tabular-nums; }
select,input,button { color:inherit; font:inherit; font-size:12px; border:1px solid var(--line); background:var(--panel-muted,#121416); border-radius:4px; min-height:28px; padding:3px 7px; }
select { max-width:130px; } button { cursor:pointer; } button:disabled { opacity:.5; cursor:default; } :is(button,input,select):focus-visible { outline:2px solid var(--brand,#b1d5be); outline-offset:1px; }
.hp-search { margin-left:auto; min-width:min(128px,100%); max-width:240px; flex:1 1 152px; } .hp-search input { width:100%; min-width:0; box-sizing:border-box; }
.hp-column-clip { overflow:hidden; flex-shrink:0; border-bottom:1px solid var(--line); background:var(--panel-muted); } .hp-columns,.hp-row { display:grid; grid-template-columns:var(--history-columns); align-items:center; }
.hp-columns { height:30px; color:var(--muted); font-size:11px; } .hp-columns span { padding-left:10px; }
.hp-list { flex:1; min-height:0; overflow:auto; scrollbar-gutter:stable; } .hp-list:focus-visible { outline:1px solid var(--brand); outline-offset:-1px; }
.hp-canvas { position:relative; } .hp-inline-inspector { position:absolute; box-sizing:border-box; overflow:hidden; border-block:1px solid var(--line); background:var(--panel); z-index:2; } .hp-row { position:absolute; left:0; right:0; box-sizing:border-box; cursor:default; border-left:2px solid transparent; user-select:none; }
.hp-row:hover { background:color-mix(in srgb,var(--brand) 7%,var(--panel)); } .hp-row.is-selected { background:color-mix(in srgb,var(--brand) 11%,var(--panel)); border-left-color:var(--brand); }
.hp-row.is-muted .hp-subject { color:var(--muted); } .hp-graph { display:block; overflow:hidden; }
.hp-message { display:flex; align-items:center; gap:6px; min-width:0; padding-right:12px; } .hp-subject { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hp-ref { flex-shrink:0; min-height:20px; max-width:145px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border:1px solid var(--line); background:var(--panel-muted); border-radius:3px; padding:0 5px; font-size:11px; color:var(--muted); }
.hp-ref:hover { color:var(--brand); border-color:var(--brand); }
.hp-ref.current { color:var(--brand); border-color:color-mix(in srgb,var(--brand) 35%,var(--line)); }
.hp-time,.hp-author,.hp-hash { padding-left:10px; padding-right:8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--muted); font-size:12px; }
.hp-hash { font-family:Consolas,"Cascadia Code",monospace; font-size:11px; }.hp-base { display:flex; align-items:center; gap:8px; padding:5px 14px; color:var(--brand); border-bottom:1px solid var(--line); font-size:12px; }
.hp-error { color:var(--danger,#e8a09b); padding:8px 14px; white-space:pre-wrap; }.hp-empty,.hp-loading,.hp-more { text-align:center; padding:26px 14px; color:var(--muted); font-size:12px; }
.hp-footer { display:flex; justify-content:space-between; gap:12px; padding:5px 14px; border-top:1px solid var(--line); font-size:11px; color:var(--muted); flex-shrink:0; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
</style>

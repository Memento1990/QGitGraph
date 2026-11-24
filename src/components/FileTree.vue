<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ChangedFile } from '../shared/protocol';
import { useLocale } from '../lib/vue-locale';
import { FileTreeCache, fileWindow, type FileNode } from '../lib/diff';

const props = withDefaults(defineProps<{
  files: readonly ChangedFile[]; selected?: string | null; reviewed?: ReadonlySet<string>;
  view?: 'tree' | 'list'; compact?: boolean; filter?: string; scrollTop?: number; scrollLeft?: number;
}>(), { selected: null, view: 'tree', compact: true, filter: '', scrollTop: 0, scrollLeft: 0 });
const emit = defineEmits<{ open: [file: ChangedFile]; context: [value: { file: ChangedFile; event: MouseEvent | KeyboardEvent }]; scroll: [value: { filesScrollTop: number; filesScrollLeft: number }] }>();
interface TreeRow { key: string; name: string; path: string; file?: ChangedFile; level: number; expanded: boolean; parent?: string }
const viewport = ref<HTMLElement>(), top = ref(props.scrollTop), height = ref(300), focused = ref('');
const collapsed = ref<ReadonlySet<string>>(new Set()), cache = new FileTreeCache<ChangedFile>();
const filtered = computed(() => { const text = props.filter.trim().toLocaleLowerCase(); return text ? props.files.filter(file => `${file.path} ${file.oldPath ?? ''}`.toLocaleLowerCase().includes(text)) : props.files; });
const { text } = useLocale();
const rows = computed<TreeRow[]>(() => {
  const result: TreeRow[] = [];
  if (props.view === 'list') return filtered.value.map(file => ({ key: `file:${file.path}`, name: file.path, path: file.path, file, level: 0, expanded: false }));
  function walk(nodes: FileNode<ChangedFile>[], level: number, parent?: string): void {
    for (const node of nodes) {
      const key = `${node.file ? 'file' : 'folder'}:${node.path}`, expanded = !collapsed.value.has(node.path);
      result.push({ key, name: node.name, path: node.path, file: node.file, level, expanded, parent });
      if (!node.file && expanded) walk(node.children, level + 1, key);
    }
  }
  walk(cache.get(filtered.value, props.compact), 0); return result;
});
const range = computed(() => fileWindow(rows.value.length, top.value, height.value, 27, 8));
const visible = computed(() => rows.value.slice(range.value.first, range.value.last));
const active = computed(() => focused.value || (props.selected ? `file:${props.selected}` : rows.value[0]?.key));
const activeId = computed(() => visible.value.some(row => row.key === active.value) ? `file-tree-${encodeURIComponent(active.value ?? '')}` : undefined);
let observer: ResizeObserver | undefined;
function toggle(row: TreeRow): void { const value = new Set(collapsed.value); if (value.has(row.path)) value.delete(row.path); else value.add(row.path); collapsed.value = value; }
function activate(row: TreeRow): void { focused.value = row.key; if (row.file) emit('open', row.file); else toggle(row); }
function onScroll(): void { if (!viewport.value) return; top.value = viewport.value.scrollTop; emit('scroll', { filesScrollTop: viewport.value.scrollTop, filesScrollLeft: viewport.value.scrollLeft }); }
function reveal(index: number): void {
  const element = viewport.value; if (!element) return;
  if (index * 27 < element.scrollTop) element.scrollTop = index * 27;
  else if ((index + 1) * 27 > element.scrollTop + element.clientHeight) element.scrollTop = (index + 1) * 27 - element.clientHeight;
  top.value = element.scrollTop;
}
function keydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) return;
  const index = Math.max(0, rows.value.findIndex(row => row.key === active.value)), row = rows.value[index]; if (!row) return;
  let next = index;
  if (event.key === 'ArrowDown') next = Math.min(rows.value.length - 1, index + 1);
  else if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = rows.value.length - 1;
  else if (event.key === 'ArrowRight') { if (!row.file && !row.expanded) toggle(row); else next = Math.min(rows.value.length - 1, index + 1); }
  else if (event.key === 'ArrowLeft') { if (!row.file && row.expanded) toggle(row); else if (row.parent) next = rows.value.findIndex(item => item.key === row.parent); }
  else if (event.key === 'Enter' || event.key === ' ') { activate(row); }
  else if ((event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) && row.file) emit('context', { file: row.file, event });
  else return;
  event.preventDefault(); focused.value = rows.value[next]?.key ?? row.key; reveal(next);
}
async function restore(): Promise<void> { await nextTick(); if (viewport.value) { viewport.value.scrollTop = props.scrollTop; viewport.value.scrollLeft = props.scrollLeft; top.value = viewport.value.scrollTop; } }
watch(() => props.files, () => { focused.value = ''; collapsed.value = new Set(); void restore(); });
watch(() => [props.scrollTop, props.scrollLeft], () => { if (viewport.value && (Math.abs(viewport.value.scrollTop - props.scrollTop) > 1 || Math.abs(viewport.value.scrollLeft - props.scrollLeft) > 1)) void restore(); });
onMounted(() => { void restore(); if (viewport.value && typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(() => { height.value = viewport.value?.clientHeight || 300; }); observer.observe(viewport.value); } });
onBeforeUnmount(() => { observer?.disconnect(); cache.clear(); });
</script>

<template>
  <div ref="viewport" class="ft-viewport" role="tree" :aria-label="text('变更文件', 'Changed files')" :aria-activedescendant="activeId" tabindex="0" @scroll="onScroll" @keydown="keydown">
    <div class="ft-canvas" :style="{ height: `${rows.length * 27}px` }"><div class="ft-window" :style="{ transform: `translateY(${range.first * 27}px)` }">
      <div v-for="row in visible" :id="`file-tree-${encodeURIComponent(row.key)}`" :key="row.key" class="ft-row" :class="{ selected: row.file?.path === selected, focused: row.key === active }" role="treeitem" :aria-level="row.level + 1" :aria-selected="Boolean(row.file && row.file.path === selected)" :aria-expanded="row.file ? undefined : row.expanded" :style="{ paddingLeft: `${10 + row.level * 15}px` }" :title="row.file?.oldPath ? `${row.file.oldPath} → ${row.path}` : row.path" @click="activate(row)" @contextmenu.prevent="row.file && emit('context', { file: row.file, event: $event })">
        <svg v-if="!row.file" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" :class="{ expanded: row.expanded }"><path d="m4 2 4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
        <span v-else class="ft-status" :class="row.file.status[0]">{{ row.file.status[0] }}</span>
        <span class="ft-name">{{ row.name }}</span>
        <span v-if="row.file && reviewed?.has(row.file.path)" class="ft-reviewed" :aria-label="text('已审阅', 'Reviewed')">{{ text('已阅', 'Read') }}</span>
        <span v-if="row.file?.additions !== null && row.file?.additions !== undefined" class="ft-add">+{{ row.file.additions }}</span><span v-if="row.file?.deletions !== null && row.file?.deletions !== undefined" class="ft-del">−{{ row.file.deletions }}</span>
      </div>
    </div></div>
    <p v-if="!rows.length" class="ft-empty">{{ filter ? text('没有匹配的文件', 'No matching files') : text('此比较没有变更文件', 'No changed files in this comparison') }}</p>
  </div>
</template>

<style scoped>
.ft-viewport { flex:1; min-height:0; overflow:auto; color:var(--text,#e6e8eb); font:12px/1.5 "Segoe UI","Microsoft YaHei UI",sans-serif; scrollbar-gutter:stable; }
.ft-viewport:focus-visible { outline:1px solid var(--brand,#b1d5be); outline-offset:-1px; }
.ft-canvas { position:relative; min-width:100%; width:max-content; } .ft-window { position:absolute; top:0; left:0; min-width:100%; }
.ft-row { display:flex; align-items:center; box-sizing:border-box; gap:7px; height:27px; padding-right:12px; cursor:default; white-space:nowrap; user-select:none; border-left:2px solid transparent; }
.ft-row:hover { background:color-mix(in srgb,var(--brand) 7%,var(--panel)); } .ft-row.selected { border-left-color:var(--brand); background:color-mix(in srgb,var(--brand) 11%,var(--panel)); } .ft-viewport:focus .ft-row.focused { outline:1px solid var(--brand); outline-offset:-1px; }
.ft-name { flex:1; } svg { flex-shrink:0; color:var(--muted); } svg.expanded { transform:rotate(90deg); }
.ft-status { width:14px; flex-shrink:0; color:var(--muted); text-align:center; font:11px Consolas,monospace; } .ft-status.A,.ft-add,.ft-reviewed { color:var(--brand); } .ft-status.D,.ft-del { color:var(--danger,#e8a09b); }
.ft-add,.ft-del,.ft-reviewed { font-size:10px; } .ft-empty { padding:20px 12px; color:var(--muted); text-align:center; }
</style>

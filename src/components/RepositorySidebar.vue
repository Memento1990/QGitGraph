<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, watch } from 'vue';
import { TreeItem, TreeRoot } from 'reka-ui';
import {
  Archive, ArrowDown, ArrowUp, ChevronDown, ChevronRight, CornerUpLeft, Folder, FolderGit2, GitBranch,
  GitCommitHorizontal, GitPullRequestArrow, Package, Plus, RefreshCw, Search, ShieldCheck, Tag,
} from 'lucide-vue-next';
import RepositoryMenu from '@/components/RepositoryMenu.vue';
import type { GitRef, Stash, SubmoduleInfo } from '@/shared/protocol';
import { m as repositoryMessages } from '@/i18n/repository-actions';
import { resolveText } from '@/lib/i18n';
import {
  buildNavigation, createNavigationViewport, navigationBranch, navigationCount, navigationCountLabel, navigationExpanded, navigationScopeName,
  navigationText, navigationTracking, useNavigationLocale,
  type NavigationAction, type NavigationActionKind, type NavigationNode, type NavigationRepository,
} from '@/lib/vue-navigation';

const props = withDefaults(defineProps<{
  repositories: NavigationRepository[];
  scopeRoot: string | null;
  currentPath: string | null;
  refs: GitRef[];
  stashes: Stash[];
  submodules: SubmoduleInfo[];
  generation: number;
  busy: boolean;
  loading: boolean;
  inlineLocal?: boolean;
}>(), { inlineLocal: false });
const emit = defineEmits<{
  select: [path: string];
  action: [action: NavigationAction];
  tag: [ref: GitRef];
  stash: [stash: Stash];
  submodule: [info: SubmoduleInfo];
  open: [];
  trust: [path: string];
  refresh: [path: string];
  visible: [paths: string[]];
}>();
defineSlots<{ local?: (props: { repository: NavigationRepository }) => unknown }>();
const locale = useNavigationLocale();
const text = (key: Parameters<typeof navigationText>[0]) => navigationText(key, locale.value);
const query = ref('');
const navigation = computed(() => buildNavigation(props, query.value));
const expanded = ref<string[]>([...navigation.value.autoExpanded]);
const searchClosed = ref<string[]>([]);
const selectedReference = ref<string>();
const selectedNode = computed(() => navigation.value.byKey.get(selectedReference.value ?? '')
  ?? [...navigation.value.byKey.values()].find(node => node.repo?.path === props.currentPath));
const current = computed(() => props.repositories.find(repo => repo.path === props.currentPath));
const parent = computed(() => props.repositories.find(repo => repo.path === current.value?.parentPath));
const trustPath = computed(() => props.scopeRoot ?? props.currentPath);
const treeExpanded = computed({
  get: () => navigationExpanded(expanded.value, navigation.value.autoExpanded, query.value, searchClosed.value),
  set: (keys: string[]) => {
    if (query.value.trim()) searchClosed.value = [...new Set([...expanded.value, ...navigation.value.autoExpanded])].filter(key => !keys.includes(key));
    else expanded.value = keys;
  },
});
watch(query, () => { searchClosed.value = []; });
watch(() => [props.currentPath, props.generation], () => { selectedReference.value = undefined; });
// Root disclosure keys never contain the current repository. New directory scopes do not overwrite root choices.
watch(() => props.scopeRoot, () => {
  const roots = expanded.value.filter(key => key.endsWith('-root'));
  expanded.value = [...roots, ...navigation.value.autoExpanded.filter(key => !key.endsWith('-root'))];
});
const treeViewport = ref<HTMLElement | null>(null);
const viewport = createNavigationViewport(paths => emit('visible', paths));
function updateVisibleRepositories() {
  const root = treeViewport.value;
  const rows = root ? [...root.querySelectorAll<HTMLElement>('[data-viewport-repository-path]')]
    .map(element => ({ element, path: element.dataset.viewportRepositoryPath! })) : [];
  // Candidate identity changes at the same path also need a fresh event for root-side validation.
  const candidates = props.repositories.map(repo => [repo.path, repo.candidate?.marker, repo.candidate?.components]);
  viewport.update(root, rows, JSON.stringify([props.scopeRoot, props.currentPath, props.generation, candidates]));
}
onMounted(updateVisibleRepositories);
onUpdated(updateVisibleRepositories);
onBeforeUnmount(() => viewport.dispose());
function label(node: NavigationNode): string { return node.message ? text(node.message) : node.label; }
function rowLabel(node: NavigationNode): string {
  if (node.repo) return `${node.label} · ${node.repo.path} · ${navigationBranch(node.repo, locale.value)} · ${text('changes')}: ${navigationCountLabel(node.repo.changes, locale.value)} · ${navigationTracking(node.repo, locale.value)}`;
  if (node.submodule) return `${node.submodule.path} · ${text(node.submodule.initialized ? 'initialized' : 'uninitialized')}`;
  return [label(node), node.contextName, node.count !== undefined ? navigationCountLabel(node.count, locale.value) : ''].filter(Boolean).join(' · ');
}
function toggle(node: NavigationNode, event?: MouseEvent) {
  if (!node.children) return;
  const keys = treeExpanded.value;
  treeExpanded.value = keys.includes(node.key) ? keys.filter(key => key !== node.key) : [...keys, node.key];
  if (event) (event.currentTarget as HTMLElement).closest<HTMLElement>('[role="treeitem"]')?.focus({ preventScroll: true });
}
function activate(node: NavigationNode) {
  // Resolve every activation against current props. Stale references never navigate a new repository.
  const actual = navigation.value.byKey.get(node.key);
  if (!actual) return;
  if (actual.repo) { selectedReference.value = undefined; emit('select', actual.repo.path); return; }
  if (actual.contextPath && actual.contextPath !== props.currentPath && !actual.kind.endsWith('-root')) return;
  if (actual.ref && actual.ref.oid === node.ref?.oid && !props.loading) { selectedReference.value = actual.key; emit('tag', actual.ref); }
  else if (actual.stash && actual.stash.oid === node.stash?.oid && !props.loading) { selectedReference.value = actual.key; emit('stash', actual.stash); }
  else if (actual.submodule && !props.loading && !props.busy) { selectedReference.value = actual.key; emit('submodule', actual.submodule); }
  else if (actual.children) toggle(actual);
}
function onSelect(event: CustomEvent<{ value?: NavigationNode }>) {
  event.preventDefault();
  if (event.detail.value) activate(event.detail.value);
}
function onToggle(event: CustomEvent<{ value?: NavigationNode; originalEvent: PointerEvent | KeyboardEvent }>) {
  // Reka click sends both select and toggle. Preserve arrow-key disclosure without double toggling on clicks.
  event.preventDefault();
  const original = event.detail.originalEvent;
  if (event.detail.value && original.type === 'keydown' && ['ArrowLeft', 'ArrowRight'].includes((original as KeyboardEvent).key)) toggle(event.detail.value);
}
function action(kind: NavigationActionKind, repo: NavigationRepository) {
  if (props.busy || repo.initialized === false || !props.repositories.some(actual => actual.path === repo.path && actual.key === repo.key)) return;
  emit('action', { kind, repoPath: repo.path });
}
function forwardAction(value: NavigationAction) {
  const repo = props.repositories.find(repo => repo.path === value.repoPath);
  if (repo) action(value.kind, repo);
}
function refresh(path: string) { if (!props.busy && path) emit('refresh', path); }
function actionLabel(key: 'branch' | 'sync' | 'commit' | 'refresh' | 'more', repo: NavigationRepository): string {
  return resolveText(repositoryMessages(key, { name: repo.name }), locale.value);
}
function branchTitle(repo: NavigationRepository): string { return `${actionLabel('branch', repo)} · ${navigationBranch(repo, locale.value)}`; }
function syncTitle(repo: NavigationRepository): string { return `${actionLabel('sync', repo)} · ${navigationTracking(repo, locale.value)}`; }
function changeTitle(repo: NavigationRepository): string { return `${repo.name} · ${text('changes')}: ${navigationCountLabel(repo.changes, locale.value)}`; }
</script>

<template>
  <aside class="repository-sidebar" :aria-label="text('navigation')" :aria-busy="loading">
    <header class="workspace-header">
      <FolderGit2 :size="19" aria-hidden="true" class="workspace-icon" />
      <div class="workspace-title"><strong>{{ text('workspace') }}</strong><span v-if="scopeRoot" :title="scopeRoot">{{ navigationScopeName(scopeRoot) }}</span></div>
      <button type="button" class="icon-button" :disabled="busy" :title="text('open')" :aria-label="text('open')" @click="emit('open')"><Plus :size="15" aria-hidden="true" /></button>
    </header>
    <label class="repository-search">
      <Search :size="13" aria-hidden="true" />
      <input v-model="query" type="search" :placeholder="text('search')" :aria-label="text('search')" autocomplete="off" @keydown.stop />
    </label>
    <div ref="treeViewport" class="tree-scroll">
      <TreeRoot
        v-slot="{ flattenItems }" v-model:expanded="treeExpanded" :items="navigation.roots" :model-value="selectedNode"
        :get-key="(node: NavigationNode) => node?.key ?? ''" :get-children="(node: NavigationNode) => node.children"
        selection-behavior="replace" class="repository-tree" :aria-label="text('navigation')"
      >
        <TreeItem
          v-for="item in flattenItems" :key="item._id" v-slot="{ isExpanded }" v-bind="item.bind"
          :data-node-kind="item.value.kind" :data-repository-path="item.value.repo?.path"
          :aria-label="rowLabel(item.value)" :title="rowLabel(item.value)"
          :aria-current="item.value.repo?.path === currentPath ? 'true' : undefined" :disabled="item.value.kind === 'empty'"
          :class="['navigation-item', item.value.repo ? 'repository-row' : item.level === 1 ? 'root-row' : 'reference-row', {
            'current-repository': item.value.repo?.path === currentPath, 'selected-reference': item.value.key === selectedReference,
            'uninitialized-repository': item.value.repo?.initialized === false,
          }]"
          :style="{ '--navigation-indent': `${Math.max(item.level - 2, 0) * 10}px` }"
          @select="onSelect" @toggle="onToggle"
        >
          <template v-if="item.value.repo">
            <div class="repository-row-header" :data-viewport-repository-path="item.value.repo.path">
            <div class="repository-identity">
              <span class="chevron-host" @click.stop @keydown.stop>
                <button v-if="item.value.children" type="button" tabindex="-1" class="icon-button chevron" :aria-expanded="isExpanded" :aria-label="`${text(isExpanded ? 'collapse' : 'expand')} ${item.value.label}`" @click="toggle(item.value, $event)"><ChevronDown v-if="isExpanded" :size="12" aria-hidden="true" /><ChevronRight v-else :size="12" aria-hidden="true" /></button>
              </span>
              <FolderGit2 :size="14" aria-hidden="true" class="repository-icon" />
              <span class="repository-name" :title="item.value.repo.path">{{ item.value.label }}</span>
              <span v-if="!item.value.repo.branch && item.value.repo.head" class="detached-state">HEAD</span>
              <span class="change-count" :title="changeTitle(item.value.repo)" :aria-label="changeTitle(item.value.repo)">{{ navigationCount(item.value.repo.changes) }}</span>
              <span class="menu-host" @click.stop @keydown.stop>
                <RepositoryMenu
                  :repo-path="item.value.repo.path" :repo-name="item.value.repo.name" :generation="generation"
                  :busy="busy || item.value.repo.initialized === false" :staged="null" :unstaged="null"
                  :stash-count="item.value.repo.path === currentPath && !loading ? stashes.length : null"
                  :trusted="item.value.repo.repository?.trusted" @action="forwardAction"
                />
              </span>
            </div>
            <div class="repository-actions" @click.stop @keydown.stop>
              <button type="button" class="branch-button" :disabled="busy || item.value.repo.initialized === false" :title="branchTitle(item.value.repo)" :aria-label="branchTitle(item.value.repo)" @click="action('checkout', item.value.repo)"><GitBranch :size="11" aria-hidden="true" /><span>{{ navigationBranch(item.value.repo, locale) }}</span><ChevronDown :size="10" aria-hidden="true" /></button>
              <div class="fixed-actions">
                <button type="button" class="sync-button" :disabled="busy || item.value.repo.initialized === false" :title="syncTitle(item.value.repo)" :aria-label="syncTitle(item.value.repo)" @click="action('sync', item.value.repo)"><GitPullRequestArrow :size="12" aria-hidden="true" /><span class="sync-count" aria-hidden="true"><ArrowUp :size="10" />{{ navigationCount(item.value.repo.ahead) }}<ArrowDown :size="10" />{{ navigationCount(item.value.repo.behind) }}</span></button>
                <button type="button" class="commit-button" :disabled="busy || item.value.repo.initialized === false" :title="actionLabel('commit', item.value.repo)" :aria-label="actionLabel('commit', item.value.repo)" @click="action('commit', item.value.repo)"><GitCommitHorizontal :size="12" aria-hidden="true" /><span>{{ text('commit') }}</span></button>
                <button type="button" class="icon-button refresh-button" :disabled="busy || item.value.repo.initialized === false" :title="actionLabel('refresh', item.value.repo)" :aria-label="actionLabel('refresh', item.value.repo)" @click="refresh(item.value.repo.path)"><RefreshCw :size="11" aria-hidden="true" /></button>
              </div>
            </div>
            </div>
            <div v-if="item.value.repo.path === currentPath && inlineLocal" class="local-inline" :data-local-path="currentPath" @click.stop @keydown.stop @pointerdown.stop>
              <slot name="local" :repository="item.value.repo" />
            </div>
          </template>
          <template v-else-if="item.level === 1">
            <ChevronDown v-if="isExpanded" :size="12" aria-hidden="true" /><ChevronRight v-else :size="12" aria-hidden="true" />
            <Folder v-if="item.value.kind === 'directory-root'" :size="12" aria-hidden="true" />
            <Package v-else-if="item.value.kind === 'submodules-root'" :size="12" aria-hidden="true" />
            <Tag v-else-if="item.value.kind === 'tags-root'" :size="12" aria-hidden="true" />
            <Archive v-else :size="12" aria-hidden="true" />
            <span class="root-label">{{ label(item.value) }}</span>
            <span v-if="item.value.contextName" class="root-context" :title="item.value.contextPath">{{ item.value.kind === 'directory-root' ? item.value.contextName : `${text('current')}: ${item.value.contextName}` }}</span>
            <span v-if="item.value.kind === 'submodules-root' && parent" class="root-action-host" @click.stop @keydown.stop><button type="button" class="icon-button" :title="`${text('parent')}: ${parent.name}`" :aria-label="`${text('parent')}: ${parent.name}`" @click="emit('select', parent.path)"><CornerUpLeft :size="12" aria-hidden="true" /></button></span>
            <span class="node-count" :title="navigationCountLabel(item.value.count, locale)" :aria-label="navigationCountLabel(item.value.count, locale)">{{ navigationCount(item.value.count) }}</span>
            <span v-if="item.value.kind === 'directory-root' && scopeRoot" class="root-action-host" @click.stop @keydown.stop><button type="button" class="icon-button" :disabled="busy" :title="text('refreshDirectory')" :aria-label="text('refreshDirectory')" @click="refresh(scopeRoot)"><RefreshCw :size="12" aria-hidden="true" /></button></span>
          </template>
          <template v-else>
            <span v-if="item.value.kind === 'directory'" class="directory-chevron" aria-hidden="true"><ChevronDown v-if="isExpanded" :size="11" /><ChevronRight v-else :size="11" /></span>
            <Folder v-if="item.value.kind === 'directory'" :size="12" aria-hidden="true" />
            <Package v-else-if="item.value.kind === 'submodule'" :size="12" aria-hidden="true" />
            <Tag v-else-if="item.value.kind === 'tag'" :size="12" aria-hidden="true" />
            <Archive v-else-if="item.value.kind === 'stash'" :size="12" aria-hidden="true" />
            <span v-else class="empty-marker" aria-hidden="true">—</span>
            <span class="node-label">{{ label(item.value) }}</span>
            <span v-if="item.value.submodule" class="submodule-state">{{ text(item.value.submodule.initialized ? 'initialized' : 'uninitialized') }}</span>
          </template>
        </TreeItem>
      </TreeRoot>
    </div>
    <footer class="sidebar-footer">
      <button type="button" class="trust-button" :disabled="!trustPath || busy" @click="trustPath && emit('trust', trustPath)"><ShieldCheck :size="13" aria-hidden="true" /><span>{{ text('trust') }}</span><ChevronRight :size="12" aria-hidden="true" /></button>
    </footer>
  </aside>
</template>

<style scoped>
.repository-sidebar { display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; color: var(--text); background: var(--panel-muted); font-size: 12px; }
.repository-sidebar button { border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.repository-sidebar button:disabled { opacity: .4; cursor: default; }
.repository-sidebar button:focus-visible, .navigation-item:focus-visible, .repository-search:focus-within { outline: 1px solid var(--brand); outline-offset: -1px; }
.repository-sidebar button:not(:disabled):hover { background: var(--panel); color: var(--text); }
.icon-button { display: inline-flex; flex: 0 0 22px; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border-radius: 3px; }
.workspace-header { display: flex; flex: 0 0 42px; align-items: center; gap: 8px; min-width: 0; padding: 0 12px; }
.workspace-icon { flex-shrink: 0; color: var(--brand); }
.workspace-title { display: flex; flex: 1; align-items: baseline; gap: 8px; min-width: 0; }
.workspace-title strong { flex-shrink: 0; font-size: 12px; font-weight: 600; }
.workspace-title > span { overflow: hidden; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.repository-search { display: flex; flex: 0 0 27px; align-items: center; gap: 6px; min-width: 0; height: 27px; margin: 0 10px 8px; padding: 0 7px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); background: var(--panel); }
.repository-search svg { flex-shrink: 0; }
.repository-search input { width: 100%; min-width: 0; height: 25px; padding: 0; border: 0; background: transparent; color: var(--text); outline: none; font-size: 11px; }
.repository-search input::placeholder { color: var(--muted); }
.tree-scroll { flex: 1 1 0; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-gutter: stable; }
.repository-tree { width: 100%; min-width: 0; margin: 0; padding: 0 5px 10px; list-style: none; }
.navigation-item { width: 100%; min-width: 0; border-radius: 3px; outline-offset: -1px; user-select: none; cursor: default; }
.navigation-item:hover { background: color-mix(in srgb, var(--panel) 75%, transparent); }
.root-row { display: flex; align-items: center; gap: 5px; height: 27px; padding: 0 6px; color: var(--muted); font-size: 10px; }
.root-label { flex: 0 0 auto; font-size: 11px; font-weight: 500; }
.root-context { min-width: 0; margin-left: auto; overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.root-action-host { display: inline-flex; flex: 0 0 22px; }
.node-label { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.node-count { flex: 0 0 auto; min-width: 18px; margin-left: auto; color: var(--muted); text-align: right; font-size: 10px; font-variant-numeric: tabular-nums; }
.navigation-item > svg { flex: 0 0 12px; color: var(--muted); }
.repository-row { min-height: 50px; margin: 0; padding: 0 4px 0 0; }
.repository-row.current-repository { background: color-mix(in srgb, var(--brand) 10%, var(--panel-muted)); box-shadow: inset 2px 0 var(--brand); }
.repository-row-header { height: 50px; min-width: 0; }
.repository-identity { display: flex; align-items: center; gap: 5px; height: 28px; min-width: 0; padding-left: var(--navigation-indent); }
.chevron-host { display: inline-flex; flex: 0 0 18px; width: 18px; height: 22px; }
.chevron { flex-basis: 18px; width: 18px; color: var(--muted); }
.repository-icon { flex: 0 0 14px; color: var(--muted); }
.current-repository .repository-icon { color: var(--brand); }
.repository-name { flex: 1 1 0; min-width: 0; overflow: hidden; font-size: 12px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.detached-state { flex-shrink: 0; color: var(--muted); font: 9px/1 Consolas, monospace; }
.change-count { flex: 0 0 27px; width: 27px; color: var(--brand); text-align: right; font-size: 10px; font-variant-numeric: tabular-nums; }
.menu-host { display: inline-flex; flex: 0 0 22px; width: 22px; }
.repository-actions { display: flex; align-items: center; gap: 3px; width: 100%; height: 22px; padding-left: 22px; }
.repository-sidebar .branch-button { display: inline-flex; flex: 1 1 118px; align-items: center; gap: 4px; min-width: 42px; max-width: 140px; height: 22px; padding: 0 5px; border-radius: 3px; color: var(--muted); font: 10px/1.2 Consolas, monospace; }
.branch-button > svg { flex-shrink: 0; }
.branch-button > span { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.fixed-actions { display: flex; flex: 0 0 auto; align-items: center; justify-content: flex-end; height: 22px; margin-left: auto; gap: 2px; }
.repository-sidebar .sync-button { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; gap: 3px; min-width: 61px; height: 22px; padding: 0 2px; border-radius: 3px; color: var(--muted); }
.sync-count { display: inline-flex; align-items: center; gap: 1px; font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.sync-count svg { flex-shrink: 0; }
.repository-sidebar .commit-button { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; gap: 3px; min-width: 46px; height: 22px; padding: 0 4px; border-radius: 3px; color: var(--muted); font-size: 10px; white-space: nowrap; }
.repository-sidebar .refresh-button { flex-basis: 22px; color: var(--muted); }
.reference-row { display: flex; align-items: center; gap: 6px; height: 26px; padding: 0 7px 0 calc(24px + var(--navigation-indent)); color: var(--text); font-size: 11px; }
.reference-row[data-node-kind='tag'] { font-family: Consolas, monospace; }
.selected-reference { background: color-mix(in srgb, var(--brand) 10%, var(--panel-muted)); color: var(--brand); }
.reference-row[data-node-kind='empty'] { color: var(--muted); font-size: 10px; }
.empty-marker, .directory-chevron { display: inline-flex; flex: 0 0 12px; text-align: center; }
.submodule-state { flex-shrink: 0; color: var(--muted); font-size: 10px; }
.uninitialized-repository .repository-name { color: var(--muted); }
.local-inline { min-width: 0; margin-top: 1px; border-top: 1px solid var(--line); background: var(--panel); user-select: text; }
.sidebar-footer { flex: 0 0 auto; padding: 6px 12px; border-top: 1px solid var(--line); }
.repository-sidebar .trust-button { display: flex; align-items: center; gap: 7px; width: 100%; height: 25px; border-radius: 3px; color: var(--muted); font-size: 11px; }
.trust-button > span { flex: 1; text-align: left; }
</style>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { ChevronRight, MoreHorizontal } from 'lucide-vue-next';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ActionKind } from '@/shared/protocol';
import { actionLabel } from '@/i18n/actions';
import { m as repositoryMessages } from '@/i18n/repository-actions';
import { resolveText } from '@/lib/i18n';
import {
  createNavigationSession, navigationActionDisabled, navigationCount, navigationCountLabel, navigationText,
  REPOSITORY_MENU_GROUPS, useNavigationLocale,
  type NavigationAction, type NavigationActionKind, type NavigationSession,
} from '@/lib/vue-navigation';

const props = defineProps<{
  repoPath: string;
  repoName: string;
  generation: number;
  busy: boolean;
  staged: number | null;
  unstaged?: number | null;
  stashCount?: number | null;
  trusted?: boolean;
}>();
const emit = defineEmits<{ action: [action: NavigationAction] }>();
defineSlots<{ default?: () => unknown }>();
const locale = useNavigationLocale();
const text = (key: Parameters<typeof navigationText>[0]) => navigationText(key, locale.value);
const opened = ref(false);
const sessions = createNavigationSession();
const target = shallowRef<NavigationSession | null>(null);
const moreLabel = computed(() => resolveText(repositoryMessages('more', { name: props.repoName }), locale.value));
const menuGroups = computed(() => target.value ? REPOSITORY_MENU_GROUPS.map(group => ({
  key: group.key,
  items: group.kinds.map(kind => ({ kind, target: target.value! })),
})) : []);
function setOpen(open: boolean) {
  if (open && (props.busy || !props.repoPath)) return;
  opened.value = open;
  if (open) target.value = sessions.open(props.repoPath, props.generation);
  else { sessions.close(); target.value = null; }
}
function close() { setOpen(false); }
watch(() => [props.repoPath, props.generation, props.busy] as const, close, { flush: 'sync' });
onBeforeUnmount(() => sessions.close());
function label(kind: NavigationActionKind): string {
  if (kind === 'sync' || kind === 'terminal' || kind === 'editor' || kind === 'settings') return text(kind);
  return resolveText(actionLabel(kind as ActionKind), locale.value);
}
function choose(item: { kind: NavigationActionKind; target: NavigationSession }) {
  if (!sessions.valid(item.target, props.repoPath, props.generation) || navigationActionDisabled(item.kind, props)) return;
  const action: NavigationAction = { kind: item.kind, repoPath: item.target.repoPath };
  close();
  emit('action', action);
}
const destructive = (kind: NavigationActionKind) => ['branch-delete', 'remote-branch-delete', 'tag-delete', 'stash-drop', 'drop', 'reset', 'clean', 'abort'].includes(kind);
</script>

<template>
  <DropdownMenu :open="opened" @update:open="setOpen">
    <DropdownMenuTrigger as-child :disabled="busy || !repoPath">
      <slot>
        <button type="button" class="repository-menu-trigger" :title="moreLabel" :aria-label="moreLabel" :disabled="busy || !repoPath">
          <MoreHorizontal :size="14" aria-hidden="true" />
        </button>
      </slot>
    </DropdownMenuTrigger>
    <DropdownMenuContent class="repository-menu" align="end" :side-offset="5" :aria-label="moreLabel" :data-repo-path="target?.repoPath">
      <DropdownMenuLabel class="menu-heading">
        <strong :title="repoPath">{{ repoName }}</strong>
        <span class="menu-counts">
          <span :title="`${text('staged')}: ${navigationCountLabel(staged, locale)}`" :aria-label="`${text('staged')}: ${navigationCountLabel(staged, locale)}`">{{ text('staged') }} {{ navigationCount(staged) }}</span>
          <span :title="`${text('unstaged')}: ${navigationCountLabel(unstaged, locale)}`" :aria-label="`${text('unstaged')}: ${navigationCountLabel(unstaged, locale)}`">{{ text('unstaged') }} {{ navigationCount(unstaged) }}</span>
        </span>
        <span v-if="trusted === false" class="menu-trust">{{ text('untrusted') }}</span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator class="menu-separator" />
      <DropdownMenuSub v-for="group in menuGroups" :key="group.key">
        <DropdownMenuSubTrigger class="menu-group">
          {{ text(group.key) }}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent class="repository-menu menu-subcontent" :side-offset="3" :aria-label="text(group.key)">
          <DropdownMenuItem
            v-for="item in group.items" :key="item.kind"
            class="menu-action" :data-action="item.kind" :data-repo-path="item.target.repoPath"
            :disabled="navigationActionDisabled(item.kind, props)" :data-destructive="destructive(item.kind) || undefined"
            @select="choose(item)"
          >
            <span>{{ label(item.kind) }}</span><ChevronRight :size="12" aria-hidden="true" />
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<style scoped>
.repository-menu-trigger { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--muted); cursor: pointer; }
.repository-menu-trigger:hover:not(:disabled) { background: var(--panel); color: var(--text); }
.repository-menu-trigger:disabled { opacity: .4; cursor: default; }
.repository-menu-trigger:focus-visible { outline: 1px solid var(--brand); outline-offset: -1px; }
.repository-menu { z-index: 70; width: 246px; max-height: min(620px, var(--reka-dropdown-menu-content-available-height, 80vh)); overflow: auto; padding: 5px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); color: var(--text); box-shadow: 0 8px 28px color-mix(in srgb, var(--bg) 55%, transparent); font-size: 12px; }
.menu-heading { display: flex; flex-direction: column; gap: 5px; padding: 7px 8px; font-size: 12px; font-weight: 400; }
.menu-heading strong { overflow: hidden; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.menu-counts { display: flex; gap: 14px; color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.menu-trust { color: var(--muted); font-size: 11px; line-height: 1.5; }
.menu-separator { height: 1px; margin: 4px 0; background: var(--line); }
.menu-group, .menu-action { display: flex; align-items: center; justify-content: space-between; min-height: 30px; gap: 10px; padding: 5px 8px; border-radius: 3px; color: var(--text); font-size: 12px; outline: none; cursor: default; }
.menu-group[data-highlighted], .menu-group[data-state='open'], .menu-action[data-highlighted] { background: var(--panel-muted); box-shadow: inset 0 0 0 1px var(--line); }
.menu-action[data-destructive] { color: var(--danger); }
.menu-action[data-disabled] { opacity: .4; pointer-events: none; }
.menu-action > svg { flex-shrink: 0; color: var(--muted); }
.menu-subcontent { width: max-content; min-width: 218px; max-width: 330px; }
</style>

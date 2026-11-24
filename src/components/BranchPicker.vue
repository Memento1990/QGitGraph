<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useId, watch } from 'vue';
import { ArrowLeft, Check, GitBranch, Globe, Search, Tag, X } from 'lucide-vue-next';
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import type { GitRef } from '@/shared/protocol';
import {
  branchPickerGroups, createNavigationSession, localBranchNameProblem, navigationCheckout, navigationText,
  suggestedLocalBranch, useNavigationLocale,
  type NavigationCheckout, type NavigationRepository, type NavigationSession,
} from '@/lib/vue-navigation';

const props = defineProps<{
  open: boolean;
  repo: NavigationRepository | null;
  refs: GitRef[];
  generation: number;
  busy: boolean;
}>();
const emit = defineEmits<{ checkout: [checkout: NavigationCheckout]; 'update:open': [open: boolean] }>();
const locale = useNavigationLocale();
const text = (key: Parameters<typeof navigationText>[0]) => navigationText(key, locale.value);
const query = ref('');
const searchInput = ref<HTMLInputElement>();
const nameInput = ref<HTMLInputElement>();
const remoteRef = shallowRef<GitRef | null>(null);
const localName = ref('');
const submitted = ref(false);
const fieldId = useId();
const sessions = createNavigationSession();
const target = shallowRef<NavigationSession | null>(null);
function close() {
  sessions.close(); target.value = null; remoteRef.value = null; submitted.value = false;
  emit('update:open', false);
}
watch(() => [props.open, props.repo?.path, props.generation, props.busy] as const, (value, previous) => {
  const [open, path, generation, busy] = value;
  if (!open) { sessions.close(); target.value = null; remoteRef.value = null; return; }
  // Changing the target while open invalidates the session, rather than retargeting a live form.
  if (!path || busy || (previous?.[0] && (previous[1] !== path || previous[2] !== generation))) { close(); return; }
  if (!previous?.[0]) {
    target.value = sessions.open(path, generation);
    query.value = ''; remoteRef.value = null; localName.value = ''; submitted.value = false;
  }
}, { immediate: true, flush: 'sync' });
onBeforeUnmount(() => sessions.close());
const visible = computed(() => props.open && target.value !== null);
// Every row captures its opening session, so a late click cannot use the latest target by accident.
const groups = computed(() => branchPickerGroups(props.refs, query.value).map(group => ({
  kind: group.kind, items: group.refs.map(ref => ({ ref: { ...ref }, target: target.value })),
})));
const groupTitle = (kind: 'branch' | 'tag' | 'remote') => text(kind === 'branch' ? 'localBranches' : kind === 'remote' ? 'remoteBranches' : 'tags');
const problem = computed(() => localBranchNameProblem(localName.value, props.refs));
const remoteTarget = shallowRef<NavigationSession | null>(null);
const remoteValid = computed(() => remoteRef.value && props.refs.some(ref =>
  ref.kind === 'remote' && ref.fullName === remoteRef.value!.fullName && ref.oid === remoteRef.value!.oid));
function valid(session: NavigationSession | null): boolean {
  return props.open && !props.busy && sessions.valid(session, props.repo?.path, props.generation);
}
function send(ref: GitRef, session: NavigationSession | null, name?: string) {
  if (!valid(session)) return;
  const checkout = navigationCheckout(ref, props.refs, name);
  if (!checkout) return;
  // No host access, dirty checks, or second local/tag form: the main action controller owns preflight.
  emit('checkout', checkout);
  close();
}
function choose(item: { ref: GitRef; target: NavigationSession | null }) {
  if (!valid(item.target) || item.ref.current) return;
  if (item.ref.kind !== 'remote') { send(item.ref, item.target); return; }
  const actual = props.refs.find(ref => ref.kind === 'remote' && ref.fullName === item.ref.fullName && ref.oid === item.ref.oid);
  if (!actual || /\/HEAD$/.test(actual.fullName)) return;
  remoteRef.value = { ...actual }; remoteTarget.value = item.target;
  localName.value = suggestedLocalBranch(actual); submitted.value = false;
  void nextTick(() => { nameInput.value?.focus(); nameInput.value?.select(); });
}
function submitRemote() {
  submitted.value = true;
  if (!remoteRef.value || problem.value || !remoteValid.value) return;
  send(remoteRef.value, remoteTarget.value, localName.value);
}
function back() { remoteRef.value = null; submitted.value = false; void nextTick(() => searchInput.value?.focus()); }
function focusSearch(event: Event) { event.preventDefault(); void nextTick(() => searchInput.value?.focus()); }
</script>

<template>
  <DialogRoot :open="visible" @update:open="value => { if (!value) close() }">
    <DialogPortal :force-mount="visible">
      <DialogOverlay class="branch-overlay" />
      <DialogContent class="branch-picker" :data-repo-path="target?.repoPath" @open-auto-focus="focusSearch">
        <header class="picker-header">
          <GitBranch :size="17" aria-hidden="true" />
          <div class="picker-heading">
            <DialogTitle class="picker-title">{{ text('branchPicker') }}</DialogTitle>
            <span :title="repo?.path">{{ repo?.name }}</span>
          </div>
          <button type="button" class="icon-button" :title="text('close')" :aria-label="text('close')" @click="close"><X :size="16" aria-hidden="true" /></button>
        </header>
        <DialogDescription class="picker-description">{{ text('branchHint') }}</DialogDescription>
        <template v-if="!remoteRef">
          <label class="picker-search">
            <Search :size="14" aria-hidden="true" />
            <input ref="searchInput" v-model="query" type="search" :aria-label="text('searchRefs')" :placeholder="text('searchRefs')" autocomplete="off" />
          </label>
          <div class="picker-groups">
            <section v-for="group in groups.filter(value => value.items.length)" :key="group.kind" class="picker-group" :aria-label="groupTitle(group.kind)">
              <h3>{{ groupTitle(group.kind) }} <span>{{ group.items.length }}</span></h3>
              <button
                v-for="item in group.items" :key="item.ref.fullName" type="button" class="ref-option"
                :data-ref="item.ref.fullName" :data-ref-kind="item.ref.kind"
                :disabled="busy || item.ref.current" :aria-current="item.ref.current ? 'true' : undefined"
                :title="`${item.ref.fullName}\n${item.ref.oid}${item.ref.current ? `\n${text('currentBranch')}` : item.ref.kind === 'tag' ? `\n${text('detachedTag')}` : ''}`"
                @click="choose(item)"
              >
                <Tag v-if="group.kind === 'tag'" :size="14" aria-hidden="true" />
                <Globe v-else-if="group.kind === 'remote'" :size="14" aria-hidden="true" />
                <GitBranch v-else :size="14" aria-hidden="true" />
                <span class="ref-name">{{ item.ref.name }}</span>
                <span class="ref-meta">{{ item.ref.current ? text('currentBranch') : item.ref.kind === 'tag' ? text('detachedTag') : item.ref.oid.slice(0, 7) }}</span>
                <Check v-if="item.ref.current" :size="13" aria-hidden="true" />
              </button>
            </section>
            <p v-if="groups.every(group => !group.items.length)" class="picker-empty" role="status">{{ text('noRefs') }}</p>
          </div>
        </template>
        <form v-else class="remote-form" novalidate @submit.prevent="submitRemote">
          <button type="button" class="back-button" @click="back"><ArrowLeft :size="13" aria-hidden="true" />{{ text('back') }}</button>
          <p class="remote-target"><Globe :size="14" aria-hidden="true" /><span>{{ remoteRef.fullName }}</span><code>{{ remoteRef.oid.slice(0, 7) }}</code></p>
          <label :for="fieldId">{{ text('remoteName') }}</label>
          <input :id="fieldId" ref="nameInput" v-model="localName" name="localName" autocomplete="off" spellcheck="false" :disabled="busy" :aria-invalid="submitted && problem ? 'true' : undefined" :aria-describedby="`${fieldId}-hint${submitted && problem ? ` ${fieldId}-error` : ''}`" />
          <p :id="`${fieldId}-hint`" class="remote-hint">{{ text('remoteHint') }}</p>
          <p v-if="submitted && problem" :id="`${fieldId}-error`" class="name-error" role="alert">{{ text(problem) }}</p>
          <p v-if="!remoteValid" class="name-error" role="alert">{{ text('noRefs') }}</p>
          <footer><button type="button" class="secondary-button" @click="close">{{ text('close') }}</button><button type="submit" class="primary-button" :disabled="busy || !remoteValid">{{ text('reviewRemote') }}</button></footer>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.branch-overlay { position: fixed; inset: 0; z-index: 80; background: color-mix(in srgb, var(--bg) 66%, transparent); }
.branch-picker { position: fixed; top: 16vh; left: 50%; z-index: 81; display: flex; flex-direction: column; width: min(490px, calc(100vw - 40px)); max-height: 70vh; transform: translateX(-50%); overflow: hidden; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); box-shadow: 0 18px 60px color-mix(in srgb, var(--bg) 70%, transparent); font-size: 12px; }
.picker-header { display: flex; flex-shrink: 0; align-items: center; gap: 10px; padding: 16px 18px 8px; }
.picker-header > svg { flex-shrink: 0; color: var(--brand); }
.picker-heading { flex: 1; min-width: 0; }
.picker-title { margin: 0; font-size: 14px; font-weight: 600; }
.picker-heading > span { display: block; overflow: hidden; margin-top: 3px; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.picker-description { margin: 0; padding: 0 18px 12px; color: var(--muted); font-size: 11px; line-height: 1.5; }
button { cursor: pointer; font: inherit; }
button:disabled { cursor: default; opacity: .5; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--muted); }
.icon-button:hover { background: var(--panel-muted); color: var(--text); }
.picker-search { display: flex; flex-shrink: 0; align-items: center; gap: 8px; height: 32px; margin: 0 18px 10px; padding: 0 8px; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); background: var(--bg); }
.picker-search:focus-within { outline: 1px solid var(--brand); }
.picker-search input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent; color: var(--text); outline: none; font: inherit; }
.picker-search input::placeholder { color: var(--muted); }
.picker-groups { min-height: 70px; overflow: auto; padding: 0 8px 10px; scrollbar-gutter: stable; }
.picker-group h3 { display: flex; justify-content: space-between; margin: 0; padding: 10px; color: var(--muted); font-size: 11px; font-weight: 500; }
.picker-group h3 span { font-variant-numeric: tabular-nums; }
.ref-option { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 6px 10px; border: 0; border-radius: 4px; background: transparent; color: var(--text); text-align: left; }
.ref-option:not(:disabled):hover { background: var(--panel-muted); }
.ref-option[aria-current] { color: var(--brand); opacity: 1; }
.ref-option > svg { flex-shrink: 0; }
.ref-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ref-meta { flex-shrink: 0; color: var(--muted); font-size: 10px; }
.picker-empty { padding: 20px 10px; color: var(--muted); text-align: center; }
.remote-form { display: flex; flex-direction: column; gap: 9px; overflow: auto; padding: 0 18px 16px; }
.back-button { display: inline-flex; align-items: center; align-self: flex-start; gap: 5px; padding: 3px 0; border: 0; background: transparent; color: var(--muted); }
.remote-target { display: flex; align-items: center; gap: 7px; min-width: 0; margin: 0 0 5px; padding: 10px; border-radius: 4px; background: var(--panel-muted); }
.remote-target span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.remote-target code { color: var(--muted); font-size: 11px; }
.remote-form > input { width: 100%; height: 34px; padding: 0 9px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); color: var(--text); font: inherit; }
.remote-hint { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.name-error { margin: 0; color: var(--danger); font-size: 11px; }
.remote-form footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
.primary-button, .secondary-button { min-height: 31px; padding: 0 12px; border: 1px solid var(--line); border-radius: 4px; background: var(--panel-muted); color: var(--text); }
.primary-button { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 15%, var(--panel)); color: var(--brand); }
.primary-button:hover:not(:disabled), .secondary-button:hover { border-color: var(--brand); }
</style>

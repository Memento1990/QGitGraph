<script setup lang="ts">
import { ref, watch } from 'vue';
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui';
import { FolderOpen, X } from 'lucide-vue-next';
import { useLocale } from '../lib/vue-locale';
const props = defineProps<{ open: boolean; depth: number; loading: boolean; error?: string | null; defaultMode?: 'repository' | 'directory' }>();
const emit = defineEmits<{ 'update:open': [value: boolean]; request: [value: {mode:'repository'|'directory';path:string;depth:number}]; pick: [mode:'repository'|'directory']; cancel: [] }>();
const { text } = useLocale();
const mode = ref<'repository'|'directory'>('directory');
const path = ref('');
const depth = ref(0);
watch(() => props.open, value => { if (value) { mode.value = props.defaultMode ?? 'directory'; depth.value = props.depth; } });
function submit() { if (!props.loading && path.value.trim()) emit('request', { mode: mode.value, path: path.value.trim(), depth: depth.value }); }
function close(value: boolean) { if (!value && props.loading) emit('cancel'); emit('update:open', value); }
</script>
<template>
  <DialogRoot :open="open" @update:open="close"><DialogPortal><DialogOverlay class="native-dialog-overlay"/><DialogContent class="native-dialog" @escape-key-down="loading && emit('cancel')">
    <header class="open-header"><DialogTitle>{{ text('打开仓库或目录','Open repository or directory') }}</DialogTitle><DialogClose class="wb-icon" :aria-label="text('关闭','Close')"><X :size="16"/></DialogClose></header>
    <DialogDescription>{{ text('读取本机真实 Git 仓库。打开和扫描不代表信任，不会自动获取或修改远程。','Read local Git repositories. Opening or scanning does not grant trust, fetch, or change remotes.') }}</DialogDescription>
    <form class="open-form" @submit.prevent="submit">
      <label>{{ text('打开方式','Open mode') }}<select v-model="mode" :disabled="loading"><option value="directory">{{ text('父目录中的多个仓库','Repositories in a directory') }}</option><option value="repository">{{ text('单个仓库','Single repository') }}</option></select></label>
      <label>{{ text('本机路径','Local path') }}<div class="path-input"><input v-model="path" :disabled="loading" autocomplete="off" spellcheck="false" :placeholder="text('输入绝对路径，也可使用系统选择器','Enter an absolute path or use the system picker')"/><button type="button" class="wb-button" :disabled="loading" @click="emit('pick',mode)"><FolderOpen :size="14"/>{{ text('浏览…','Browse…') }}</button></div></label>
      <label v-if="mode === 'directory'">{{ text('发现深度（0–5）','Discovery depth (0–5)') }}<input v-model.number="depth" type="number" min="0" max="5" :disabled="loading"/></label>
      <p v-if="loading" role="status">{{ text('正在读取目录，请稍候。取消会停止本次请求。','Reading the directory. Cancel stops this request.') }}</p><p v-if="error" role="alert" class="error">{{ error }}</p>
      <footer><button v-if="loading" type="button" class="wb-button" @click="emit('cancel')">{{ text('取消读取','Cancel read') }}</button><DialogClose v-else class="wb-button">{{ text('取消','Cancel') }}</DialogClose><button type="submit" class="wb-button primary" :disabled="loading || !path.trim()">{{ text('打开','Open') }}</button></footer>
    </form>
  </DialogContent></DialogPortal></DialogRoot>
</template>
<style scoped>.open-header{display:flex;align-items:center;gap:12px;justify-content:space-between}.open-form{display:flex;flex-direction:column;gap:14px}.path-input{display:flex;gap:6px}.path-input input{flex:1;min-width:0}.path-input button{flex:0 0 auto;white-space:nowrap}</style>

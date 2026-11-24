<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui';
import { ShieldCheck, ShieldX, X } from 'lucide-vue-next';
import type { Host, NativeTrustState, Repository } from '../shared/protocol';
import { errorMessage } from '../lib/format';
import { useLocale } from '../lib/vue-locale';
const props = defineProps<{ open: boolean; host: Host; repo: Repository | null; scopeRoot: string | null; generation: number }>();
const emit = defineEmits<{ 'update:open':[value:boolean]; changed:[state:NativeTrustState]; error:[error:unknown] }>();
const { text } = useLocale();
const state = ref<NativeTrustState | null>(null);
const busy = ref(false);
const error = ref('');
const directoryPath = ref('');
const confirmation = ref<null | {kind:'directory'|'repository';path:string;decision:'allow'|'deny'|'inherit';repoId?:string;generation:number}>(null);
let epoch = 0;
const current = computed(() => state.value?.repositories.find(item => item.repoId === props.repo?.id));
async function load() { const token=++epoch; error.value=''; if (!props.host.trustState) { error.value=text('原生宿主不支持信任规则。','The native host does not support trust rules.'); return; } try { const result=await props.host.trustState(props.repo?.id); if (token===epoch && props.open) state.value=result; } catch(e) { if(token===epoch)error.value=errorMessage(e); } }
watch([()=>props.open,()=>props.repo?.id,()=>props.generation],([open])=>{ confirmation.value=null; directoryPath.value=props.scopeRoot ?? ''; if(open)void load(); else epoch++; });
function requestRepository(decision:'allow'|'deny'|'inherit') { const repo=props.repo;if(repo)confirmation.value={kind:'repository',path:repo.path,repoId:repo.id,decision,generation:props.generation}; }
function requestDirectory(path:string,trusted:boolean) { if(path.trim())confirmation.value={kind:'directory',path:path.trim(),decision:trusted?'allow':'deny',generation:props.generation}; }
async function confirm() { const intent=confirmation.value; if(!intent||busy.value||intent.generation!==props.generation||(intent.kind==='repository'&&intent.repoId!==props.repo?.id)) { confirmation.value=null;return; } busy.value=true;error.value='';try { let result:NativeTrustState; if(intent.kind==='directory'){if(!props.host.setDirectoryTrust)throw Error(text('宿主不支持目录授权','Directory trust is unavailable'));result=await props.host.setDirectoryTrust(intent.path,intent.decision==='allow');}else{if(!props.host.setRepositoryTrust||!intent.repoId)throw Error(text('宿主不支持仓库授权','Repository trust is unavailable'));result=await props.host.setRepositoryTrust(intent.repoId,intent.decision);}if(intent.generation!==props.generation)return;state.value=result;confirmation.value=null;emit('changed',result);}catch(e){error.value=errorMessage(e);emit('error',e);}finally{busy.value=false;} }
</script>
<template>
<DialogRoot :open="open" @update:open="value=>emit('update:open',value)"><DialogPortal><DialogOverlay class="native-dialog-overlay"/><DialogContent class="native-dialog">
  <header class="trust-header"><DialogTitle>{{ text('目录与仓库信任','Directory and repository trust') }}</DialogTitle><DialogClose class="wb-icon" :disabled="busy" :aria-label="text('关闭','Close')"><X :size="16"/></DialogClose></header>
  <DialogDescription>{{ text('授权可能允许运行仓库配置的钩子、过滤器、凭据助手与外部工具。打开目录不会自动授信，授权后也不会自动重放先前被阻止的操作。','Trust can allow repository hooks, filters, credential helpers and external tools. Opening does not grant trust, and granting trust does not replay a blocked operation.') }}</DialogDescription>
  <template v-if="confirmation"><h3>{{ confirmation.decision === 'allow' ? text('确认信任范围','Confirm trust scope') : confirmation.decision === 'inherit' ? text('恢复继承','Restore inheritance') : text('撤销或拒绝信任','Revoke or deny trust') }}</h3><pre>{{ confirmation.path }}</pre><p v-if="confirmation.kind==='directory' && confirmation.decision==='allow'">{{ text('此目录规则持续覆盖现有与未来新增的真实子仓库，跨重启保存。单仓拒绝优先；目录外的链接目标不自动继承。','This persistent directory grant covers current and future real descendant repositories. A repository deny overrides it; external link targets do not inherit.') }}</p><p v-else>{{ text('规则变化会使旧授权意图失效；正在进行的写入可能已产生部分结果，取消不是回滚。','A rule change invalidates old authorization intents. Writes may already have partial effects; cancellation is not rollback.') }}</p><footer><button class="wb-button" :disabled="busy" @click="confirmation=null">{{ text('返回','Back') }}</button><button class="wb-button primary" :disabled="busy" @click="confirm">{{ text('确认规则','Confirm rule') }}</button></footer></template>
  <template v-else>
    <section v-if="repo" class="trust-section"><strong>{{ repo.name }}</strong><pre>{{ repo.path }}</pre><p><ShieldCheck v-if="current?.trusted" :size="14"/><ShieldX v-else :size="14"/>{{ current?.trusted ? text('当前可信','Currently trusted') : text('当前不可信／只读','Currently untrusted / read-only') }} · {{ current?.source ?? 'none' }}</p><div class="trust-actions"><button class="wb-button" :disabled="busy" @click="requestRepository('allow')">{{ text('仅信任此仓库','Trust only this repository') }}</button><button class="wb-button" :disabled="busy" @click="requestRepository('deny')">{{ text('明确拒绝此仓库','Deny this repository') }}</button><button class="wb-button" :disabled="busy" @click="requestRepository('inherit')">{{ text('恢复目录继承','Restore directory inheritance') }}</button></div></section>
    <label>{{ text('授信父目录','Grant a parent directory') }}<input v-model="directoryPath" :disabled="busy" autocomplete="off" spellcheck="false"/></label><button class="wb-button" :disabled="busy||!directoryPath.trim()" @click="requestDirectory(directoryPath,true)">{{ text('检查并确认目录范围…','Review directory scope…') }}</button>
    <section class="trust-section"><strong>{{ text('已保存的原生规则','Saved native rules') }}</strong><p v-if="!state?.rules.length">{{ text('尚无规则','No rules saved') }}</p><div v-for="rule in state?.rules" :key="`${rule.kind}:${rule.path}`" class="saved-rule"><span>{{ rule.kind }} · {{ rule.decision }}</span><code>{{ rule.path }}</code><button v-if="rule.kind==='directory'" class="wb-button" :disabled="busy" @click="requestDirectory(rule.path,false)">{{ text('移除目录授权…','Remove directory grant…') }}</button></div></section>
  </template>
  <p v-if="error" role="alert" class="error">{{ error }}</p>
</DialogContent></DialogPortal></DialogRoot>
</template>
<style scoped>.trust-header{display:flex;justify-content:space-between;gap:10px;align-items:center}.trust-section{display:flex;flex-direction:column;gap:7px;border-bottom:1px solid var(--line);padding-bottom:12px}.trust-section p{display:flex;gap:7px;align-items:center}.trust-actions{display:flex;gap:7px;flex-wrap:wrap}.saved-rule{display:flex;flex-wrap:wrap;gap:8px;padding:7px 0;align-items:center}.saved-rule code{font-size:11px;flex:1;min-width:160px;overflow-wrap:anywhere}h3{margin:0;font-size:14px}</style>

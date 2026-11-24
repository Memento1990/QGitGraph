<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose } from 'reka-ui';
import { Activity, ArrowLeft, Check, ChevronRight, CircleHelp, FolderGit2, FolderOpen, GitBranch, GitCommitHorizontal, GitFork, GitPullRequestArrow, Maximize2, Minus, Moon, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, Settings2, ShieldCheck, ShieldX, Sun, X } from 'lucide-vue-next';
import type { ActionKind, ChangedFile, Commit, DiffQuery, GitAction, GitRef, Host, NativeTrustState, ReviewSession, SettingsPatch, Stash, SubmoduleInfo } from './shared/protocol';
import { DEFAULT_SETTINGS } from './shared/protocol';
import { createWorkspaceController } from './controllers/workspace';
import { createHistoryController, type WorkingDiffOpen } from './controllers/history';
import { createActionsController, type ActionBinding, type ControllerResult } from './controllers/actions';
import { createLocalChangesController } from './controllers/local-changes';
import { createUsageController, usageErrorCategory } from './controllers/usage';
import { errorMessage } from './lib/format';
import { configureLocale, resolveText } from './lib/i18n';
import { useLocale } from './lib/vue-locale';
import type { NavigationAction, NavigationRepository } from './lib/vue-navigation';
import { Requests } from './lib/state';
import { RowLayout } from './ui/navigation';
import RepositorySidebar from './components/RepositorySidebar.vue';
import RepositoryMenu from './components/RepositoryMenu.vue';
import BranchPicker from './components/BranchPicker.vue';
import RepositoryOpenDialog from './components/RepositoryOpenDialog.vue';
import HistoryQueryDialog from './components/HistoryQueryDialog.vue';
import HistoryPanel from './components/HistoryPanel.vue';
import CommitInspector from './components/CommitInspector.vue';
import DiffPanel from './components/DiffPanel.vue';
import LocalChangesPanel from './components/LocalChangesPanel.vue';
import ActionDialog from './components/ActionDialog.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import UpdatesDialog from './components/UpdatesDialog.vue';
import TrustDialog from './components/TrustDialog.vue';
import MetadataDialog from './components/MetadataDialog.vue';
import SizeHandle from './components/SizeHandle.vue';
import UsageRecorder from './components/UsageRecorder.vue';

const props=defineProps<{host:Host}>();
const { text }=useLocale();
const workspace=createWorkspaceController(props.host);
const usage=createUsageController(props.host);
const settings=workspace.settings;
const active=computed(()=>workspace.repo.current);
const snapshot=computed(()=>workspace.repo.snapshot);
const counts=workspace.counts;
const history=createHistoryController(props.host,{store:workspace.store,settings:()=>settings.value,onResultError:showError});
const rootError=ref(''),resultText=ref(''),settingsError=ref('');
const requests=new Requests(id=>props.host.cancel(id));
const sidebarOpen=ref(true),localOpen=ref(false),detailOpen=ref(true),mainTab=ref<'history'|'working'|'document'>('history');
const queryOpen=ref(false);
let localActivation:number|null=null;
const openDialog=ref(false),settingsOpen=ref(false),trustOpen=ref(false),updatesOpen=ref(false),commandsOpen=ref(false),branchOpen=ref(false);
const settingsScope=ref<'global'|'repository'>('global');
const branchTarget=shallowRef<NavigationRepository|null>(null),branchRefs=shallowRef<GitRef[]>([]);
const parent=shallowRef<{path:string;name:string}|null>(null);
const localNode=ref<HTMLElement|null>(null),localHost=ref<HTMLElement|null>(null),sidebarLocalHost=ref<HTMLElement|null>(null);
const sidebarWidth=ref(340),localWidth=ref(350),detailWidth=ref(360),detailHeight=ref(320),localListHeight=ref(430);
const localInline=computed(()=>localOpen.value&&sidebarOpen.value&&settings.value.localChangesPosition==='inline');
const writeBusy=computed(()=>actions.state.busy||local.state.busy);
const navigationBusy=computed(()=>writeBusy.value||workspace.repo.loading||workspace.directory.loading);
const metadata=ref<{open:boolean;kind:'tag'|'stash'|'containment'|'remotes'|'archive'|'pull-request'|'reviews'|'diagnostics';target?:string}>({open:false,kind:'remotes'});
const fileMenu=shallowRef<{file:ChangedFile;repoId:string;generation:number;query:DiffQuery}|null>(null);
const refMenu=shallowRef<GitRef|null>(null),refMenuOpen=ref(false),refMenuBinding=shallowRef<{repoId:string;generation:number}|null>(null);
const fileMenuOpen=ref(false);
const contextBinding=shallowRef<{repoId:string;generation:number}|null>(null);
const comparisonBase=ref<string|null>(null),contextCommit=shallowRef<Commit|null>(null),contextOpen=ref(false),inlineSide=ref<'above'|'below'>('below');
const historyPanel=ref<InstanceType<typeof HistoryPanel>|null>(null);
const actionDeps={host:props.host,getRepository:()=>active.value,getGeneration:()=>workspace.repo.generation,getSnapshot:()=>snapshot.value,getSettings:()=>settings.value,getBusy:()=>workspace.repo.loading||workspace.directory.loading,getLoading:()=>workspace.repo.loading||workspace.repo.refreshing,getError:()=>workspace.repo.error,onRefresh:(value:NonNullable<typeof snapshot.value>,binding:ActionBinding)=>{workspace.applySnapshot(value,binding.generation);history.invalidate();},onResult:operationResult,onError:showError};
const actions=createActionsController(actionDeps);
const local=createLocalChangesController(actionDeps);
const commandSearch=ref('');
const commandItems=computed(()=>actions.available.filter(item=>resolveText(item.label).toLocaleLowerCase().includes(commandSearch.value.toLocaleLowerCase())));
const navigation=computed<NavigationRepository[]>(()=>{
  const candidates=workspace.directory.discovery?.repositories??[];
  const sources=candidates.length?candidates:workspace.recent.value.map(item=>({path:item.path,components:[item.name],marker:'git-directory' as const}));
  const paths=new Map(sources.map(item=>[item.path,item]));
  if(active.value&&!paths.has(active.value.path))paths.set(active.value.path,{path:active.value.path,components:[active.value.name],marker:active.value.bare?'bare':'git-directory'});
  return [...paths.values()].map(candidate=>{
    const current=active.value?.path===candidate.path,summary=workspace.summaries.value.get(candidate.path)?.summary;
    return {key:candidate.path,path:candidate.path,name:current?active.value!.name:candidate.components.at(-1)??candidate.path,branch:current?active.value!.branch:summary?.branch??null,head:current?active.value!.head:summary?.head??null,changes:current?counts.value?.changed??null:summary?.changes??null,ahead:current?workspace.status.value.tracking.ahead:summary?.ahead??null,behind:current?workspace.status.value.tracking.behind:summary?.behind??null,repository:current?active.value!:undefined,candidate};
  });
});
const currentNavigation=computed(()=>navigation.value.find(item=>item.path===active.value?.path)??null);
const visibleError=computed(()=>rootError.value||workspace.error.value&&errorMessage(workspace.error.value)||'');
const status=workspace.status;
const taskState=computed(()=>workspace.busy.value||writeBusy.value?'running':'idle');
const taskSequence=ref(0);
watch([taskState,()=>workspace.repo.lastSuccessfulRefresh,()=>workspace.history.commits,()=>workspace.history.ready],()=>{taskSequence.value++;},{flush:'sync'});
const showWorkingDiff=computed(()=>mainTab.value==='working'&&history.diff.state.selection&&!history.diff.state.historical);
const showDocument=computed(()=>mainTab.value==='document'&&history.state.activeDocument!==null);
const showDetails=computed(()=>detailOpen.value&&history.state.selection!==null);
const theme=computed(()=>settings.value.theme==='system'?(systemDark.value?'dark':'light'):settings.value.theme);
const systemDark=ref(typeof matchMedia==='function'?matchMedia('(prefers-color-scheme: dark)').matches:true);
let media:MediaQueryList|undefined;
function observe(taskIds:string[],scenarioId:string,actionId:string,resultCode='STATE_OBSERVED',phase:'success'|'failed'|'blocked'|'cancelled'='success',error?:unknown){
  const repoId=active.value?usage.anonymousRepo(active.value.id):undefined;
  void usage.record({taskIds,scenarioId,actionId,resultCode,...(repoId?{repoId}:{}),state:{theme:theme.value,viewport:'wide',phase,trusted:active.value?.trusted??false,busy:writeBusy.value},...(error?{errorCode:usageErrorCategory(error)}:{})});
}
function showError(error:unknown){rootError.value=errorMessage(error);}
async function operationResult(event:ControllerResult){
  if(event.binding.generation!==workspace.repo.generation)return;
  const working=['stage','unstage','commit-staged'].includes(event.action.kind);
  const scenario=working?'native-stage-commit':event.action.kind==='sync'?'native-sync-success':'native-git-workflows';
  observe(['QG-VUE-ACTIONS'],scenario,`git.${event.action.kind}`,event.status==='completed'?'SUCCESS':'STATE_OBSERVED');
  resultText.value=event.result.output||text(event.status==='completed'?'操作已完成并刷新。':'操作已启动或暂停，尚未完成。',event.status==='completed'?'Operation completed and refreshed.':'Operation started or paused; not completed.');
  pendingActionRefresh=event.binding;
}
let pendingActionRefresh:ActionBinding|null=null;
watch(writeBusy,value=>{
  workspace.setActionBusy(value);
  if(!value&&pendingActionRefresh){const binding=pendingActionRefresh;pendingActionRefresh=null;void workspace.refreshAfterAction(binding.repoId,binding.generation);}
},{flush:'sync'});
watch([()=>snapshot.value,()=>workspace.repo.generation,()=>active.value?.trusted],()=>local.update(),{immediate:true,flush:'sync'});
watch(theme,value=>{document.documentElement.dataset.theme=value;document.documentElement.classList.toggle('dark',value==='dark');observe(['QG-VUE-WORKSPACE'],'native-workspace-theme','workspace.theme');},{immediate:true});
watch(()=>workspace.state.value.settings.language,value=>{configureLocale(value);observe(['QG-VUE-COMPAT'],'native-language','settings.language');},{immediate:true});
watch(()=>[active.value?.id,workspace.repo.generation] as const,()=>{
  history.setRepository(active.value,workspace.repo.generation);
  comparisonBase.value=null;contextOpen.value=false;contextCommit.value=null;branchOpen.value=false;refMenuOpen.value=false;refMenu.value=null;fileMenuOpen.value=false;fileMenu.value=null;metadata.value.open=false;
  localOpen.value=false;localActivation=active.value?workspace.repo.generation:null;mainTab.value='history';
  void nextTick(placeLocal);
});
watch(()=>snapshot.value,value=>{
  if(value&&value.repository.id===active.value?.id&&localActivation===workspace.repo.generation){localOpen.value=Boolean(counts.value?.changed);localActivation=null;}
},{flush:'post'});
watch(()=>active.value,value=>history.setRepository(value,workspace.repo.generation),{flush:'sync'});
watch(()=>history.state.activeDocument,value=>{if(value)mainTab.value='document';});
watch(()=>workspace.reveal.value,value=>{if(value){detailOpen.value=true;mainTab.value='history';void history.select(value.oid);}});
watch(()=>workspace.state.value.layout,value=>{localWidth.value=value.localWidth??350;detailHeight.value=value.detailSize;localListHeight.value=Math.max(400,value.localListSize??430);},{immediate:true});
watch([()=>workspace.directory.scope?.root,()=>workspace.directory.scope?.width],()=>{
  const width=workspace.directory.scope?.width;
  if(width!==undefined)sidebarWidth.value=Math.max(300,Math.min(640,width));
},{flush:'sync'});
watch(()=>workspace.directory.scope?.collapsed,value=>{if(value!==undefined)sidebarOpen.value=!value;},{immediate:true});
watch([localInline,localOpen,localNode,localHost,sidebarLocalHost],()=>void nextTick(placeLocal),{flush:'post'});
watch(()=>history.state.status,value=>{
  if(value==='ready')observe(['QG-VUE-HISTORY'],history.state.selection?.kind==='compare'?'native-history-compare':'native-history-query','history.read','READ_OBSERVED');
});
watch(()=>history.diff.state.status,value=>{
  if(value==='ready')observe(['QG-VUE-HISTORY'],'native-diff-read','diff.read','READ_OBSERVED');
  else if(['binary','truncated','blocked','error','cancelled'].includes(value))observe(['QG-VUE-HISTORY'],'native-diff-negative','diff.read-state','STATE_OBSERVED',value==='error'?'failed':value==='cancelled'?'cancelled':value==='blocked'?'blocked':'success');
});
watch(()=>history.state.review.active,()=>observe(['QG-VUE-HISTORY'],'native-review','review.session'));
function placeLocal(){const node=localNode.value,target=localInline.value?sidebarLocalHost.value:localHost.value;if(node&&target&&node.parentElement!==target)target.appendChild(node);}
function directoryRefresh(path:string){if(workspace.directory.scope?.root===path){void workspace.openDirectory(path,workspace.directory.scope.depth);}else if(active.value?.path===path){void workspace.refresh();}else workspace.refreshSummaries(path);}
function visibleRepositories(paths:string[]){const visible=new Set(paths);workspace.setVisibleCandidates((workspace.directory.discovery?.repositories??[]).filter(item=>visible.has(item.path)));}
async function selectRepository(path:string){
  if(navigationBusy.value)return;
  if(active.value?.path===path){localOpen.value=!localOpen.value;observe(['QG-VUE-WORKSPACE'],'native-workspace-navigation','repository.toggle-local');return;}
  parent.value=null;await openPath(path);
}
async function openPath(path:string){
  const candidate=workspace.directory.discovery?.repositories.find(item=>item.path===path);
  const opened=candidate?await workspace.selectRepository(candidate):await workspace.openRepository(path);
  if(opened&&active.value?.path===path)observe(['QG-VUE-WORKSPACE'],'native-workspace-navigation','repository.open','OPENED');
  return opened;
}
function showOpenDialog(){workspace.repo.error=null;workspace.directory.error=null;openDialog.value=true;}
async function openRequest(value:{mode:'repository'|'directory';path:string;depth:number}){
  rootError.value='';
  const ok=value.mode==='directory'?await workspace.openDirectory(value.path,value.depth):await workspace.openRepository(value.path);
  if(ok){openDialog.value=false;observe(['QG-VUE-WORKSPACE'],'native-directory-open',`repository.open.${value.mode}`,'OPENED');}
}
async function pick(mode:'repository'|'directory'){
  const ok=mode==='directory'?await workspace.pickDirectory():await workspace.pickRepository();
  if(ok){openDialog.value=false;observe(['QG-VUE-WORKSPACE'],'native-directory-open','repository.pick','OPENED');}
}
async function syncRepository(){
  const repo=active.value;if(!repo)return;
  if(!repo.trusted){trustOpen.value=true;return;}
  if(!snapshot.value?.working.upstream){await actions.open('set-upstream');return;}
  await local.sync();
}
async function routeAction(event:NavigationAction){
  if(writeBusy.value)return;
  const generation=workspace.repo.generation;
  if(active.value?.path!==event.repoPath){const ok=await openPath(event.repoPath);if(!ok||active.value?.path!==event.repoPath)return;}
  else if(generation!==workspace.repo.generation)return;
  if(event.kind==='checkout'){await openBranchPicker();return;}
  if(event.kind==='sync'){await syncRepository();return;}
  if(event.kind==='settings'){settingsScope.value='repository';settingsOpen.value=true;return;}
  if(event.kind==='terminal'||event.kind==='editor'){
    const repo=active.value;if(!repo)return;
    if(!repo.trusted){trustOpen.value=true;return;}
    try{if(event.kind==='terminal')await props.host.openTerminal(repo.id);else await props.host.openEditor(repo.id,'');observe(['QG-VUE-COMPAT'],'native-tools-compat',`tools.${event.kind}`);}
    catch(error){showError(error);}
    return;
  }
  if(event.kind==='commit'){localOpen.value=true;mainTab.value='working';return;}
  if(!active.value?.trusted){trustOpen.value=true;return;}
  await actions.open(event.kind);
}
async function openBranchPicker(){const repo=active.value;if(!repo)return;branchTarget.value=currentNavigation.value;branchRefs.value=[...workspace.refs.value];branchOpen.value=true;}
async function checkout(value:{ref:GitRef;localName?:string}){
  const target=branchTarget.value;
  if(!target||target.path!==active.value?.path||!workspace.refs.value.some(item=>item.fullName===value.ref.fullName&&item.oid===value.ref.oid&&item.kind===value.ref.kind))return;
  branchOpen.value=false;
  if(!active.value?.trusted){trustOpen.value=true;return;}
  if(value.ref.kind==='remote'){
    const remote=[...workspace.remotes.value].sort((a,b)=>b.name.length-a.name.length).find(item=>value.ref.name.startsWith(item.name+'/'));
    if(!remote){showError(text('远程引用归属已变化，请刷新。','Remote reference ownership changed. Refresh first.'));return;}
    await actions.open('checkout-remote',{remote:remote.name,target:value.ref.name.slice(remote.name.length+1),name:value.localName??value.ref.name.slice(remote.name.length+1)});
    if(actions.state.phase==='form')await actions.submit();
  }else{
    await actions.open('checkout',{target:value.ref.kind==='branch'?value.ref.name:value.ref.fullName});
    if(!settings.value.confirmCheckout&&actions.state.phase==='form')await actions.submit();
  }
}
function selectCommit(commit:Commit,ensureOpen=false){
  const container=historyPanel.value?.$el as HTMLElement|undefined;
  const list=container?.querySelector<HTMLElement>('.hp-list');
  const row=list?.querySelector<HTMLElement>(`[id="history-row-${commit.oid}"]`);
  if(list&&row){
    const rowIndex=workspace.visibleCommits.value.findIndex(item=>item.oid===commit.oid);
    const oldIndex=workspace.visibleCommits.value.findIndex(item=>item.oid===history.state.selected);
    const rowHeight=settings.value.rowHeight;
    const geometry=new RowLayout(workspace.visibleCommits.value.length,rowHeight,showDetails.value&&settings.value.detailPosition==='inline'?oldIndex:-1,detailHeight.value,inlineSide.value==='above'?'before':'after');
    inlineSide.value=rowIndex*rowHeight-geometry.plainScrollTop(list.scrollTop,list.clientHeight)<list.clientHeight/2?'below':'above';
  }
  workspace.select(commit.oid);
  if(!ensureOpen&&history.state.selected===commit.oid&&detailOpen.value){detailOpen.value=false;return;}
  detailOpen.value=true;mainTab.value='history';void history.select(commit);
  observe(['QG-VUE-HISTORY'],'native-history-query','history.select','SELECTED');
}
function historyQuery(value:Parameters<typeof workspace.setQuery>[0]){void workspace.setQuery(value);}
async function workingDiff(value:WorkingDiffOpen){mainTab.value='working';await history.openWorking(value);}
function closeDiff(){if(history.state.activeDocument)void history.closeDocument(history.state.activeDocument);else{history.diff.clear();mainTab.value='history';}}
function toggleLocal(){localOpen.value=!localOpen.value;if(localOpen.value)mainTab.value='working';}
function toggleSidebar(){sidebarOpen.value=!sidebarOpen.value;workspace.setDirectoryPreferences({collapsed:!sidebarOpen.value});}
async function savePreferences(value:{scope:'global'|'repository';patch:SettingsPatch}){
  settingsError.value='';
  try{
    const saved=value.scope==='repository'&&active.value?await workspace.replaceRepositoryPreferences(value.patch):await workspace.savePreferences(value.patch,'global');
    if(!saved)throw workspace.error.value??Error('SAVE_FAILED');
    observe(['QG-VUE-COMPAT'],'native-settings-compat','settings.save');
  }catch(error){settingsError.value=errorMessage(error);}
}
async function resetPreferences(value:{scope:'global'|'repository'}){
  if(value.scope==='repository'&&active.value){if(!await workspace.replaceRepositoryPreferences({}))settingsError.value=errorMessage(workspace.error.value);}
  else{workspace.store.state.settings=structuredClone(DEFAULT_SETTINGS);workspace.touchState();if(!await workspace.flush())settingsError.value=errorMessage(workspace.error.value);}
}
function resizeSidebar(value:number){sidebarWidth.value=Math.max(300,Math.min(640,Math.round(value)));workspace.setDirectoryPreferences({width:sidebarWidth.value});}
function resizeLocal(value:number){localWidth.value=value;workspace.updateLayout({localWidth:value});}
function resizeDetails(value:number){detailHeight.value=value;workspace.updateLayout({detailSize:value});}
function resizeLocalFiles(value:number){localListHeight.value=Math.max(400,value);workspace.updateLayout({localListSize:localListHeight.value});}
function showMetadata(kind:typeof metadata.value.kind,target?:string){metadata.value={open:true,kind,target};}
async function tagSelected(item:GitRef){if(!active.value)return;detailOpen.value=true;mainTab.value='history';await workspace.revealOid(item.oid,true);await history.select(item.oid);}
async function stashSelected(item:Stash){if(!active.value)return;detailOpen.value=true;mainTab.value='history';await history.select(item.oid);}
async function submoduleSelected(item:SubmoduleInfo){
  const repo=active.value;if(!repo)return;
  if(!item.initialized){showError(text('此子模块尚未初始化；本版不自动执行初始化或更新。请在受信任的终端中显式处理。','This submodule is uninitialized. This version does not automatically initialize or update it. Use a trusted terminal explicitly.'));return;}
  const parentRepo={path:repo.path,name:repo.name};
  if(await workspace.openRepository(`${repo.path.replace(/[\\/]$/,'')}/${item.path}`)){parent.value=parentRepo;observe(['QG-VUE-WORKSPACE'],'native-submodule-navigation','submodule.open','OPENED');}
}
async function trustChanged(value:NativeTrustState){
  await workspace.refresh();workspace.refreshSummaries();
  const trust=value.repositories.find(item=>item.repoId===active.value?.id);
  observe(['QG-NATIVE-TRUST'],trust?.source==='repository-deny'?'native-trust-deny':trust?.source==='directory'?'native-trust-directory':'native-trust-restart','trust.rules.changed');
}
async function windowAction(action:'minimize'|'toggle-maximize'|'close'|'drag'){
  try{if(!props.host.windowAction)throw Error(text('窗口操作仅桌面可用','Window operations require the desktop host'));await props.host.windowAction(action);if(action!=='drag')observe(['QG-NATIVE-WINDOW'],'native-window-controls',`window.${action}`);}
  catch(error){showError(error);}
}
function keydown(event:KeyboardEvent){
  if(event.defaultPrevented||event.isComposing)return;
  const modifier=event.ctrlKey||event.metaKey;
  if(modifier&&event.key.toLowerCase()==='k'){event.preventDefault();commandsOpen.value=true;}
  else if(modifier&&event.key===','){event.preventDefault();settingsScope.value='global';settingsOpen.value=true;}
  else if(modifier&&event.key.toLowerCase()==='r'){event.preventDefault();void workspace.refresh();}
}
function themeToggle(){void workspace.savePreferences({theme:theme.value==='dark'?'light':'dark'},'global');}
async function resumeReview(review:ReviewSession){const selection=review.selection;if(!selection)return;if(selection.kind==='compare'&&selection.target)await history.compare(selection.base??null,selection.target);else if(selection.oid)await history.select({oid:selection.oid,parent:selection.parent});history.startReview();detailOpen.value=true;}
function adjacentCommit(direction:-1|1){const items=workspace.visibleCommits.value,index=items.findIndex(item=>item.oid===history.state.selected),next=items[index+direction];if(next){workspace.select(next.oid);detailOpen.value=true;void history.select(next);}}
function resizeRatio(value:number){workspace.updateLayout({detailRatio:value});}
async function followCommit(oid:string){detailOpen.value=true;mainTab.value='history';await workspace.revealOid(oid,true);await history.select(oid);}
function fileContext(value:{file:ChangedFile;event:MouseEvent|KeyboardEvent}){
  const repo=active.value,selection=history.state.selection;if(!repo||!selection)return;
  fileMenu.value={file:value.file,repoId:repo.id,generation:workspace.repo.generation,query:{repoId:repo.id,requestId:'',base:selection.kind==='commit'?selection.parent??history.state.detail?.base??null:selection.base,target:selection.kind==='commit'?selection.oid:selection.target,path:value.file.path,oldPath:value.file.oldPath??undefined,encoding:settings.value.encoding}};
  fileMenuOpen.value=true;
}
async function fileTool(kind:'copy'|'editor'|'old'|'new'|'external'|'review'){
  const item=fileMenu.value,repo=active.value;fileMenuOpen.value=false;
  if(!item||!repo||item.repoId!==repo.id||item.generation!==workspace.repo.generation)return;
  try{
    if(kind==='copy'){await props.host.copy(item.file.path);return;}
    if(kind==='review'){
      if(history.state.review.reviewed.has(item.file.path))history.markReviewed(item.file.path,false);
      else{await history.openFile(item.file);if(history.diff.state.status==='ready')history.markReviewed(item.file.path,true);}
      return;
    }
    if(!repo.trusted){trustOpen.value=true;return;}
    const request=requests.begin('file-tool'),query={...item.query,requestId:request.id};
    try{if(kind==='editor')await props.host.openEditor(repo.id,item.file.path);else if(kind==='external')await props.host.externalDiff(query);else await props.host.openSnapshot(query,kind);}
    finally{request.finish();}
  }catch(error){showError(error);}
}
async function openUrl(url:string){try{await props.host.openUrl(url);}catch(error){showError(error);}}
function referenceContext(value:{ref:GitRef;commit:Commit;event:MouseEvent|KeyboardEvent}){if(!active.value)return;refMenu.value={...value.ref};refMenuBinding.value={repoId:active.value.id,generation:workspace.repo.generation};refMenuOpen.value=true;}
async function referenceAction(kind:'history'|'metadata'|'copy'|ActionKind){
  const item=refMenu.value,binding=refMenuBinding.value;refMenuOpen.value=false;
  if(!item||!binding||binding.repoId!==active.value?.id||binding.generation!==workspace.repo.generation)return;
  if(kind==='history'){await workspace.setQuery({scope:{kind:'refs',refs:[item.fullName]}});return;}
  if(kind==='metadata'){if(item.kind==='tag')showMetadata('tag',item.fullName);else if(item.kind==='stash')showMetadata('stash',item.name);return;}
  if(kind==='copy'){await props.host.copy(item.fullName);return;}
  let preset:Partial<GitAction>={target:item.kind==='branch'?item.name:item.fullName};
  if(item.kind==='remote'){
    const remote=[...workspace.remotes.value].sort((a,b)=>b.name.length-a.name.length).find(value=>item.name.startsWith(value.name+'/'));
    if(!remote){showError(text('无法确定远程归属，请刷新。','Cannot resolve the remote. Refresh first.'));return;}
    const branch=item.name.slice(remote.name.length+1);preset={remote:remote.name,target:branch,branch,name:branch};
  }else if(kind==='push')preset={branch:item.name};
  await actions.open(kind,preset);
}
function context(value:{commit:Commit;event:MouseEvent|KeyboardEvent}){const repo=active.value;if(!repo)return;contextCommit.value=value.commit;contextBinding.value={repoId:repo.id,generation:workspace.repo.generation};contextOpen.value=true;}
async function contextAction(kind:ActionKind){const commit=contextCommit.value,binding=contextBinding.value;if(!commit||!binding||binding.repoId!==active.value?.id||binding.generation!==workspace.repo.generation)return;contextOpen.value=false;await actions.open(kind,{target:commit.oid});}
function cancelCurrent(){if(local.state.busy)void local.cancel();else if(actions.state.busy)void actions.cancel();else void workspace.cancel(workspace.directory.loading?'directory':workspace.repo.loading?'open':'history');}
onMounted(()=>{
  document.addEventListener('keydown',keydown);media=matchMedia('(prefers-color-scheme: dark)');media.addEventListener('change',mediaChanged);
  void workspace.init().then(()=>{const scope=workspace.directory.scope;sidebarWidth.value=scope?.width??340;sidebarOpen.value=scope?!scope.collapsed:true;void nextTick(placeLocal);});
});
function mediaChanged(event:MediaQueryListEvent){systemDark.value=event.matches;}
onBeforeUnmount(()=>{
  document.removeEventListener('keydown',keydown);media?.removeEventListener('change',mediaChanged);requests.cancelAll();
  if(localNode.value&&localHost.value&&localNode.value.parentElement!==localHost.value)localHost.value.appendChild(localNode.value);
  actions.dispose();local.dispose();history.dispose();void workspace.dispose();
});
</script>

<template>
<div class="workbench app-shell" :data-repo-path="active?.path ?? ''" :data-repo-head="active?.head ?? ''" :data-task-state="taskState" :data-task-sequence="taskSequence" :data-config-directory="workspace.diagnostics.value?.configDirectory ?? ''" :data-repo-id="active?.id ?? ''" :data-open-generation="workspace.repo.generation" :data-host-mode="workspace.diagnostics.value?.hostMode ?? 'desktop'" :data-action-busy="writeBusy" :data-history-sequence="workspace.history.commits.length">
  <header class="native-titlebar" :aria-label="text('应用标题栏','Application title bar')"><button class="wb-icon" :aria-label="sidebarOpen?text('收起仓库导航','Collapse repository navigation'):text('展开仓库导航','Expand repository navigation')" @click="toggleSidebar"><PanelLeftClose v-if="sidebarOpen" :size="15"/><PanelLeftOpen v-else :size="15"/></button><GitFork class="brand" :size="21"/><strong>QGitGraph</strong><span class="muted">/</span><button class="breadcrumb wb-icon" style="width:auto;max-width:35vw" :title="workspace.directory.scope?.root ?? active?.path ?? ''" @click="showOpenDialog"><FolderOpen :size="14"/><span>{{ workspace.directory.scope?.root.split(/[\\/]/).filter(Boolean).at(-1) ?? text('打开工作空间','Open workspace') }}</span><ChevronRight v-if="active" :size="12"/><span v-if="active">{{ active.name }}</span></button><div class="native-drag" @mousedown.left="windowAction('drag')" @dblclick="windowAction('toggle-maximize')"></div><UsageRecorder :host="host"/><button class="wb-icon" :aria-label="text('打开命令面板','Open command palette')" @click="commandsOpen=true"><Search :size="14"/></button><button class="wb-icon" :aria-label="text('切换主题','Toggle theme')" @click="themeToggle"><Sun v-if="theme==='dark'" :size="14"/><Moon v-else :size="14"/></button><button class="wb-icon" :aria-label="text('打开全局设置','Open global settings')" @click="settingsScope='global';settingsOpen=true"><Settings2 :size="15"/></button><div class="native-window-buttons"><button :aria-label="text('最小化窗口','Minimize window')" @click="windowAction('minimize')"><Minus :size="14"/></button><button :aria-label="text('最大化或还原窗口','Maximize or restore window')" @click="windowAction('toggle-maximize')"><Maximize2 :size="13"/></button><button class="close" :aria-label="text('关闭窗口','Close window')" @click="windowAction('close')"><X :size="16"/></button></div></header>
  <div class="shell-split">
    <aside v-if="sidebarOpen" class="sidebar-panel" :style="{width:`${sidebarWidth}px`}">
      <RepositorySidebar :repositories="navigation" :scope-root="workspace.directory.scope?.root ?? null" :current-path="active?.path ?? null" :refs="[...workspace.refs.value]" :stashes="[...workspace.stashes.value]" :submodules="[...workspace.submodules.value]" :generation="workspace.repo.generation" :busy="navigationBusy" :loading="workspace.directory.loading" :inline-local="localInline" @select="selectRepository" @visible="visibleRepositories" @action="routeAction" @tag="tagSelected" @stash="stashSelected" @submodule="submoduleSelected" @open="showOpenDialog" @trust="trustOpen=true" @refresh="directoryRefresh"><template #local><div ref="sidebarLocalHost" class="local-inline"></div></template></RepositorySidebar>
    </aside>
    <SizeHandle v-if="sidebarOpen" class="sidebar-separator" :model-value="sidebarWidth" :min="300" :max="640" :owner="workspace.directory.scope?.root ?? ''" :label="text('调整仓库导航宽度','Resize repository navigation')" @update:model-value="resizeSidebar"/>
    <section class="main-workspace">
      <header v-if="active" class="repository-commandbar"><button v-if="parent" class="wb-icon" :title="text('返回父仓库','Return to parent repository')" @click="openPath(parent.path).then(ok=>{if(ok)parent=null})"><ArrowLeft :size="15"/></button><FolderGit2 :size="19" class="muted"/><h1>{{ active.name }}</h1><button class="wb-button branch" :disabled="navigationBusy" @click="openBranchPicker"><GitBranch :size="13"/>{{ active.branch ?? (active.head ? `HEAD · ${active.head.slice(0,8)}` : text('未创建提交','Unborn HEAD')) }}</button><button :class="['trust-chip',{trusted:active.trusted}]" @click="trustOpen=true"><ShieldCheck v-if="active.trusted" :size="12"/><ShieldX v-else :size="12"/>{{ active.trusted?text('可信','Trusted'):text('只读模式','Read-only') }}</button><div class="grow"></div><button class="wb-icon" :disabled="navigationBusy" :aria-label="text('刷新当前仓库','Refresh current repository')" @click="workspace.refresh"><RefreshCw :size="14"/></button><button class="wb-button" :disabled="navigationBusy" @click="syncRepository"><GitPullRequestArrow :size="14"/>{{ text('同步更改','Sync changes') }} <span class="mono">↑{{ status.tracking.ahead ?? '—' }} ↓{{ status.tracking.behind ?? '—' }}</span></button><button class="wb-button primary" :disabled="!active.trusted||writeBusy" @click="localOpen=true;mainTab='working'"><GitCommitHorizontal :size="14"/>{{ text('提交','Commit') }} {{ counts?.staged ?? '—' }}</button><RepositoryMenu :repo-path="active.path" :repo-name="active.name" :generation="workspace.repo.generation" :busy="navigationBusy" :staged="counts?.staged ?? null" :unstaged="counts?.unstaged ?? null" :stash-count="workspace.stashes.value.length" :trusted="active.trusted" @action="routeAction"/></header>
      <div v-if="visibleError" class="notice-strip error" role="alert"><ShieldX :size="15"/><p>{{ visibleError }}</p><button class="wb-button" @click="trustOpen=true">{{ text('信任与规则','Trust and rules') }}</button><button class="wb-icon" :aria-label="text('关闭错误消息','Dismiss error')" @click="rootError='';workspace.dismissError()"><X :size="13"/></button></div>
      <div v-if="resultText" class="notice-strip" role="status"><Check :size="15"/><p>{{ resultText }}</p><button class="wb-icon" :aria-label="text('关闭结果消息','Dismiss result')" @click="resultText=''"><X :size="13"/></button></div>
      <div v-if="workspace.busy.value||writeBusy" class="notice-strip" role="status"><Activity :size="14"/><p>{{ writeBusy?text('正在执行，请等待真实结果；取消不代表回滚。','Running; waiting for the actual result. Cancellation is not rollback.'):text('正在读取仓库…','Reading repository…') }}</p><button class="wb-button" @click="cancelCurrent">{{ text('取消当前任务','Cancel current task') }}</button></div>
      <template v-if="active"><nav class="workbench-tabs" :aria-label="text('工作区文档','Workspace documents')"><button :class="{active:mainTab==='history'}" @click="mainTab='history';history.activateGraph()"><GitCommitHorizontal :size="14"/>{{ text('提交历史','Commit history') }}</button><button :class="{active:mainTab==='working'}" @click="localOpen=true;mainTab='working'">{{ text('本地修改','Local changes') }} <span>{{ counts?.changed ?? '—' }}</span></button><button v-for="document in history.state.documents" :key="document.id" :class="{active:mainTab==='document'&&history.state.activeDocument===document.id}" @click="history.activateDocument(document.id)" @dblclick="history.pinDocument(document.id,!document.pinned)"><span>{{ document.pinned?'● ':'' }}{{ document.file.path.split('/').at(-1) }} · {{ document.selection.kind==='commit'?document.selection.oid.slice(0,7):text('比较','Compare') }}</span><span role="button" tabindex="0" :aria-label="text('关闭文件标签','Close document tab')" @click.stop="history.closeDocument(document.id)" @keydown.enter.stop="history.closeDocument(document.id)"><X :size="12"/></span></button><div class="grow"></div><button :aria-label="text('显示或隐藏本地修改','Toggle local changes')" @click="toggleLocal">{{ localOpen?'−':'+' }}</button><button :aria-label="text('显示或隐藏提交详情','Toggle commit details')" @click="detailOpen=!detailOpen"><Settings2 :size="13"/></button></nav>
      <main class="workbench-content">
        <div ref="localHost" v-show="localOpen&&!localInline" class="local-column" :style="{width:`${localWidth}px`,flexBasis:`${localWidth}px`}"><div ref="localNode" class="local-files" :style="showWorkingDiff?{flex:`0 0 ${localListHeight}px`}:undefined"><LocalChangesPanel :controller="local" @open-diff="workingDiff" @trust="trustOpen=true"/></div><template v-if="showWorkingDiff&&!localInline"><SizeHandle :model-value="localListHeight" :min="400" :max="580" axis="y" :owner="workspace.repo.generation" :label="text('调整本地文件列表高度','Resize local file list')" @update:model-value="resizeLocalFiles"/><div class="local-preview"><DiffPanel :controller="history.diff" @close="closeDiff"/></div></template></div>
        <SizeHandle v-if="localOpen&&!localInline" :model-value="localWidth" :min="280" :max="640" :owner="workspace.repo.generation" :label="text('调整本地修改宽度','Resize local changes')" @update:model-value="resizeLocal"/>
        <div v-if="showDocument || localInline&&mainTab==='working'" class="diff-workspace"><DiffPanel :controller="history.diff" @close="closeDiff"/></div>
        <div v-show="!(showDocument || localInline&&mainTab==='working')" class="history-workspace"><div :class="['history-split',settings.detailPosition]">
          <div class="history-list-host"><HistoryPanel ref="historyPanel" :inline-details="showDetails&&settings.detailPosition==='inline'" :inline-height="detailHeight" :inline-side="inlineSide" :commits="workspace.visibleCommits.value" :graph="workspace.graphRows.value" :settings="settings" :selected="workspace.history.selected" :loading="workspace.history.loading" :has-more="workspace.history.hasMore" :error="workspace.history.error?errorMessage(workspace.history.error):null" :query="workspace.history.query" :generation="workspace.repo.generation" :comparison-base="comparisonBase" @select="selectCommit" @load-more="workspace.loadMore" @query="historyQuery" @context="context" @ref-context="referenceContext" @open-url="openUrl" @comparison-base="comparisonBase=$event" @compare="value=>{detailOpen=true;history.compare(value.base,value.target)}" @retry="workspace.refresh"><template #toolbar><button class="wb-button" @click="queryOpen=true">{{ text('范围与查询…','Scope and query…') }}</button><button class="wb-icon" title="HEAD" @click="workspace.revealHead">HEAD</button></template><template #inspector><CommitInspector :controller="history" :settings="settings" horizontal @close="detailOpen=false" @follow="followCommit" @adjacent="adjacentCommit" :ratio="workspace.state.value.layout.detailRatio ?? .55" @ratio="resizeRatio" @context="fileContext" @open-url="openUrl"/><SizeHandle :model-value="detailHeight" :min="190" :max="620" axis="y" :owner="workspace.repo.generation" :label="text('调整提交详情高度','Resize commit details height')" @update:model-value="resizeDetails"/></template></HistoryPanel></div>
          <template v-if="showDetails&&settings.detailPosition!=='inline'"><SizeHandle v-if="settings.detailPosition==='right'" :model-value="detailWidth" :min="270" :max="700" reverse :owner="workspace.repo.generation" :label="text('调整提交详情宽度','Resize commit details')" @update:model-value="detailWidth=$event"/><SizeHandle v-else :model-value="detailHeight" :min="190" :max="620" axis="y" reverse :owner="workspace.repo.generation" :label="text('调整提交详情高度','Resize commit details height')" @update:model-value="resizeDetails"/><aside class="detail-host" :style="settings.detailPosition==='right'?{width:`${detailWidth}px`,flex:`0 0 ${detailWidth}px`}:{height:`${detailHeight}px`,flex:`0 0 ${detailHeight}px`}"><CommitInspector :controller="history" :settings="settings" :horizontal="settings.detailPosition!=='right'" @close="detailOpen=false" @follow="followCommit" @adjacent="adjacentCommit" :ratio="workspace.state.value.layout.detailRatio ?? .55" @ratio="resizeRatio" @context="fileContext" @open-url="openUrl"/></aside></template>
        </div></div>
      </main></template>
      <main v-else class="empty-workspace"><FolderGit2 :size="40"/><h1>QGitGraph</h1><p>{{ text('打开单个仓库或包含多个 Git 仓库的目录。所有操作经本机原生宿主执行；未授权时不会执行仓库写入。','Open a repository or a directory containing Git repositories. All operations use the native host. Repository writes require explicit trust.') }}</p><button class="wb-button primary" @click="showOpenDialog"><FolderOpen :size="15"/>{{ text('打开仓库／目录…','Open repository / directory…') }}</button><div v-if="workspace.recent.value.length" class="command-list"><button v-for="item in workspace.recent.value" :key="item.path" @click="openPath(item.path)">{{ item.name }}</button></div></main>
    </section>
  </div>
  <footer class="statusbar"><span>{{ active?active.branch??'HEAD':text('未打开仓库','No repository') }}</span><button v-if="active" @click="toggleLocal">{{ counts?`${counts.changed} ${text('项修改','changes')} · ${counts.staged} ${text('暂存','staged')} · ${counts.unstaged} ${text('未暂存','unstaged')} · ${counts.untracked} ${text('未跟踪','untracked')}`:text('工作区状态未知','Working state unknown') }}</button><span v-if="status.tracking.upstream">{{ status.tracking.upstream }} · ↑{{ status.tracking.ahead??'—' }} ↓{{ status.tracking.behind??'—' }}</span><span>{{ workspace.history.commits.length }} {{ text('条已加载提交','loaded commits') }}</span><span v-if="workspace.repo.stale">{{ text('状态已陈旧','State is stale') }}</span><span class="grow"></span><button v-if="active" @click="trustOpen=true">{{ active.trusted?text('可信','Trusted'):text('只读模式','Read-only') }}</button><button @click="updatesOpen=true"><CircleHelp :size="13"/></button></footer>
  <RepositoryOpenDialog v-model:open="openDialog" :depth="settings.discoveryDepth" :loading="workspace.directory.loading||workspace.repo.loading" :error="workspace.directory.error?errorMessage(workspace.directory.error):workspace.repo.error?errorMessage(workspace.repo.error):null" @request="openRequest" @pick="pick" @cancel="workspace.cancel(workspace.directory.loading?'directory':'open')"/>
  <TrustDialog v-model:open="trustOpen" :host="host" :repo="active" :scope-root="workspace.directory.scope?.root??null" :generation="workspace.repo.generation" @changed="trustChanged" @error="showError"/>
  <SettingsDialog v-model:open="settingsOpen" :settings="settings" :global-settings="workspace.state.value.settings" :repo-patch="active?workspace.state.value.repoSettings[active.id]:undefined" :scope="settingsScope" :repo="active" :host="host" :save-error="settingsError" @save="savePreferences" @reset="resetPreferences" @scope="settingsScope=$event"/>
  <UpdatesDialog v-model:open="updatesOpen" :host="host"/>
  <HistoryQueryDialog v-model:open="queryOpen" :refs="workspace.refs.value" :settings="settings" :query="workspace.history.query" @apply="workspace.setQuery"/>
  <BranchPicker v-model:open="branchOpen" :repo="branchTarget" :refs="branchRefs" :generation="workspace.repo.generation" :busy="navigationBusy" @checkout="checkout"/>
  <ActionDialog :controller="actions"/>
  <MetadataDialog v-model:open="metadata.open" :host="host" :repo="active" :generation="workspace.repo.generation" :kind="metadata.kind" :target="metadata.target" :settings="settings" :remotes="[...workspace.remotes.value]" :reviews="active?workspace.state.value.reviews.filter(review=>review.repoId===active?.id):[]" @action="(kind,initial)=>actions.open(kind,initial)" @select="oid=>{detailOpen=true;history.select(oid)}" @resume-review="resumeReview" @error="showError"/>
  <DialogRoot v-model:open="commandsOpen"><DialogPortal><DialogOverlay class="native-dialog-overlay"/><DialogContent class="native-dialog"><DialogTitle>{{ text('命令与工具','Commands and tools') }}</DialogTitle><DialogDescription>{{ text('所有操作绑定当前仓库，危险操作仍单独确认。','All operations target the current repository. Destructive actions require separate confirmation.') }}</DialogDescription><input v-model="commandSearch" :placeholder="text('查找操作…','Find an operation…')"/><div class="command-list"><button @click="commandsOpen=false;showOpenDialog()">{{ text('打开仓库／目录…','Open repository / directory…') }}</button><button @click="commandsOpen=false;showMetadata('remotes')">{{ text('管理远程…','Manage remotes…') }}</button><button @click="commandsOpen=false;showMetadata('archive')">{{ text('导出归档…','Export archive…') }}</button><button @click="commandsOpen=false;showMetadata('pull-request')">{{ text('创建合并请求链接…','Create pull request link…') }}</button><button @click="commandsOpen=false;showMetadata('reviews')">{{ text('恢复评审会话…','Resume review session…') }}</button><button @click="commandsOpen=false;showMetadata('diagnostics')">{{ text('诊断…','Diagnostics…') }}</button><button @click="commandsOpen=false;workspace.closeRepository()">{{ text('关闭当前仓库','Close current repository') }}</button><button @click="commandsOpen=false;workspace.closeDirectory()">{{ text('关闭目录','Close directory') }}</button><button v-for="item in commandItems" :key="item.kind" :disabled="item.disabled" @click="commandsOpen=false;actions.open(item.kind)">{{ resolveText(item.label) }}</button></div><DialogClose class="wb-button">{{ text('关闭','Close') }}</DialogClose></DialogContent></DialogPortal></DialogRoot>
  <DialogRoot v-model:open="refMenuOpen"><DialogPortal><DialogOverlay class="native-dialog-overlay"/><DialogContent class="native-dialog"><DialogTitle>{{ refMenu?.name }}</DialogTitle><DialogDescription>{{ refMenu?.fullName }} · {{ refMenu?.oid }}</DialogDescription><div class="command-list"><button @click="referenceAction('history')">{{ text('仅显示此引用历史','Show history for this reference') }}</button><button @click="referenceAction('copy')">{{ text('复制完整引用','Copy full reference') }}</button><button v-if="refMenu?.kind==='tag'||refMenu?.kind==='stash'" @click="referenceAction('metadata')">{{ text('元数据与签名…','Metadata and signature…') }}</button><template v-if="refMenu?.kind==='branch'"><button @click="referenceAction('checkout')">Checkout</button><button @click="referenceAction('branch-rename')">{{ text('重命名…','Rename…') }}</button><button @click="referenceAction('branch-delete')">{{ text('删除分支…','Delete branch…') }}</button><button @click="referenceAction('push')">Push</button></template><template v-else-if="refMenu?.kind==='remote'"><button @click="referenceAction('checkout-remote')">{{ text('创建本地跟踪分支…','Create local tracking branch…') }}</button><button @click="referenceAction('remote-branch-delete')">{{ text('删除远程分支…','Delete remote branch…') }}</button><button @click="referenceAction('fetch-into')">{{ text('获取到本地分支…','Fetch into local branch…') }}</button><button @click="referenceAction('set-upstream')">{{ text('设为上游…','Set as upstream…') }}</button></template><template v-else-if="refMenu?.kind==='tag'"><button @click="referenceAction('checkout')">Checkout</button><button @click="referenceAction('tag-push')">{{ text('推送标签…','Push tag…') }}</button><button @click="referenceAction('tag-delete')">{{ text('删除标签…','Delete tag…') }}</button></template><template v-else-if="refMenu?.kind==='stash'"><button @click="referenceAction('stash-apply')">{{ text('应用…','Apply…') }}</button><button @click="referenceAction('stash-pop')">{{ text('弹出…','Pop…') }}</button><button @click="referenceAction('stash-drop')">{{ text('删除…','Drop…') }}</button></template></div><DialogClose class="wb-button">{{ text('关闭','Close') }}</DialogClose></DialogContent></DialogPortal></DialogRoot>
  <DialogRoot v-model:open="fileMenuOpen"><DialogPortal><DialogOverlay class="native-dialog-overlay"/><DialogContent class="native-dialog"><DialogTitle>{{ text('文件操作','File actions') }}</DialogTitle><DialogDescription>{{ fileMenu?.file.path }}</DialogDescription><div class="command-list"><button @click="fileTool('copy')">{{ text('复制文件路径','Copy file path') }}</button><button @click="fileTool('editor')">{{ text('在编辑器中打开工作文件','Open working file in editor') }}</button><button @click="fileTool('old')">{{ text('在外部打开旧快照','Open old snapshot externally') }}</button><button @click="fileTool('new')">{{ text('在外部打开新快照','Open new snapshot externally') }}</button><button @click="fileTool('external')">{{ text('外部差异工具','External diff tool') }}</button><button :disabled="!history.state.review.active" @click="fileTool('review')">{{ text('切换已读状态','Toggle reviewed status') }}</button></div><DialogClose class="wb-button">{{ text('关闭','Close') }}</DialogClose></DialogContent></DialogPortal></DialogRoot>
  <DialogRoot v-model:open="contextOpen"><DialogPortal><DialogOverlay class="native-dialog-overlay"/><DialogContent class="native-dialog"><DialogTitle>{{ text('提交操作','Commit actions') }} · {{ contextCommit?.oid.slice(0,10) }}</DialogTitle><DialogDescription>{{ contextCommit?.subject }}</DialogDescription><div class="command-list"><button @click="comparisonBase=contextCommit?.oid??null;contextOpen=false">{{ text('设为比较基准','Set comparison base') }}</button><button :disabled="!comparisonBase||comparisonBase===contextCommit?.oid" @click="contextOpen=false;contextCommit&&history.compare(comparisonBase,contextCommit.oid)">{{ text('与基准比较','Compare with base') }}</button><button :disabled="!active?.head||active?.head===contextCommit?.oid" @click="contextOpen=false;contextCommit&&history.compare(active?.head??null,contextCommit.oid)">{{ text('与 HEAD 比较','Compare with HEAD') }}</button><button @click="contextOpen=false;showMetadata('containment',contextCommit?.oid)">{{ text('包含关系…','Containment…') }}</button><button @click="contextCommit&&host.copy(contextCommit.oid);contextOpen=false">{{ text('复制完整 OID','Copy full OID') }}</button><button v-for="kind in (['checkout','branch-create','tag-create','merge','rebase','cherry-pick','revert','reset','drop'] as const)" :key="kind" @click="contextAction(kind)">{{ kind }}</button></div><DialogClose class="wb-button">{{ text('关闭','Close') }}</DialogClose></DialogContent></DialogPortal></DialogRoot>
</div>
</template>

const NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  branch: [['circle',{cx:6,cy:5,r:2}],['circle',{cx:6,cy:19,r:2}],['circle',{cx:18,cy:6,r:2}],['path',{d:'M6 7v10M18 8v2a5 5 0 0 1-5 5H6'}]],
  sidebar: [['rect',{x:3,y:4,width:18,height:16,rx:2}],['path',{d:'M9 4v16'}]],
  folder: [['path',{d:'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z'}]],
  board: [['rect',{x:3,y:4,width:18,height:16,rx:2}],['path',{d:'M9 4v16M15 4v16'}]],
  list: [['path',{d:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'}]],
  activity: [['path',{d:'M3 12h4l3-8 4 16 3-8h4'}]],
  search: [['circle',{cx:10.5,cy:10.5,r:6.5}],['path',{d:'m16 16 4.5 4.5'}]],
  plus: [['path',{d:'M12 5v14M5 12h14'}]],
  close: [['path',{d:'m6 6 12 12M6 18 18 6'}]],
  sun: [['circle',{cx:12,cy:12,r:4}],['path',{d:'M12 2v2M12 20v2M2 12h2M20 12h2m-3.1-8.9-1.4 1.4M6.5 17.5l-1.4 1.4M3.1 3.1l1.4 1.4m13 13 1.4 1.4'}]],
  moon: [['path',{d:'M20.6 13.5A9 9 0 0 1 10.5 3.4a9 9 0 1 0 10.1 10.1Z'}]],
  download: [['path',{d:'M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4'}]],
  upload: [['path',{d:'M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4'}]],
  refresh: [['path',{d:'M20 7v5h-5M4 17v-5h5M5.1 7a8 8 0 0 1 13.2-1L20 8M4 16l1.7 2a8 8 0 0 0 13.2-1'}]],
  lock: [['rect',{x:5,y:10,width:14,height:11,rx:2}],['path',{d:'M8 10V7a4 4 0 0 1 8 0v3M12 14v3'}]],
  'arrow-right': [['path',{d:'M4 12h16m-6-6 6 6-6 6'}]],
  info: [['circle',{cx:12,cy:12,r:9}],['path',{d:'M12 11v6M12 7h.01'}]],
  checklist: [['rect',{x:3,y:4,width:18,height:16,rx:2}],['path',{d:'m6 9 1.5 1.5L10 8M13 9h5M6 15h4M13 15h5'}]],
  link: [['path',{d:'m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',transform:'translate(2 1)'}]],
  check: [['path',{d:'m5 12 4 4L19 6'}]],
  copy: [['rect',{x:8,y:8,width:12,height:13,rx:2}],['path',{d:'M16 8V3H3v13h5'}]],
  edit: [['path',{d:'m16 3 5 5-12 12-6 1 1-6Z',transform:'translate(0 -1)'}]],
};
export const STATUSES = Object.freeze({todo:'待办',ready:'可执行',inprogress:'进行中',readyforusage:'待使用验收',done:'已完成',blocked:'已阻塞',archived:'已归档'});
const BOARD_STATUSES = ['todo','ready','inprogress','readyforusage','done'];
const SOURCE_LABELS = {userusage:'用户使用',assistant:'助手回归','automated-test':'自动测试'};
const state = {
  token:null,build:null,board:null,connected:false,loading:true,pending:false,view:'board',selected:null,drawerTab:'details',returnFocus:null,
  filters:{search:'',priority:'all',area:'all',pack:'all',required:'required',blocked:false,archived:false},
  drafts:new Map(),conflict:null,session:null,recording:false,paused:false,usageError:null,usageQueue:Promise.resolve(),usageRetry:[],
  sessions:[],events:[],selectedSession:null,logsLoading:false,logsError:null,
};
let toastTimer = 0;
let searchTimer = 0;
let lastDialogFocus = null;
const $ = id => document.getElementById(id);

function el(tag,attrs={},...children) {
  const element = document.createElement(tag);
  for (const [key,value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === 'class') element.className = value;
    else if (key === 'value') element.value = value;
    else if (key === 'checked') element.checked = Boolean(value);
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(),value);
    else if (['disabled','required','multiple','hidden','readonly'].includes(key)) { if (value) element.setAttribute(key,''); }
    else element.setAttribute(key,String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}
function icon(name) {
  const svg = document.createElementNS(NS,'svg');
  for (const [key,value] of Object.entries({viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':'1.5','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'})) svg.setAttribute(key,value);
  for (const [tag,attrs] of ICONS[name] || ICONS.info) {
    const shape = document.createElementNS(NS,tag);
    for (const [key,value] of Object.entries(attrs)) shape.setAttribute(key,String(value));
    svg.append(shape);
  }
  return svg;
}
function hydrateIcons(root=document) { for (const target of root.querySelectorAll('[data-icon]')) target.replaceChildren(icon(target.dataset.icon)); }
function btn(text,handler,opts={}) {
  const {className='quiet-button',icon:name,mutation=false,...attrs} = opts;
  return el('button',{type:'button',class:className,onclick:handler,...(mutation ? {'data-mutation':'',disabled:state.pending} : {}),...attrs},name && icon(name),text);
}
function field(label,control,opts={}) {
  return el('label',{class:`field${opts.full ? ' full' : ''}`},el('span',{},label),control,opts.hint && el('small',{class:'hint'},opts.hint));
}
function selectOf(items,value,attrs={}) {
  const select = el('select',attrs);
  for (const item of items) {
    const [key,label] = Array.isArray(item) ? item : [item,item];
    select.append(el('option',{value:key},label));
  }
  select.value = String(value ?? '');
  return select;
}
export function revisionOf(board) { return board?.metadata?.revision ?? board?.revision ?? 0; }
function tasks() { return Array.isArray(state.board?.tasks) ? state.board.tasks : []; }
function taskById(id) { return tasks().find(task => task.id === id); }
function taskBlocked(task) { return task.status === 'blocked' || task.blocked === true || task.flags?.blocked === true; }
export function columnFor(task) {
  if (BOARD_STATUSES.includes(task.status)) return task.status;
  if (task.status === 'blocked' && BOARD_STATUSES.includes(task.previousStatus)) return task.previousStatus;
  return 'todo';
}
export function filterTasks(all,filters) {
  const query = String(filters.search || '').trim().toLocaleLowerCase('zh-CN');
  return all.filter(task => {
    if (!filters.archived && (task.status === 'archived' || task.archived === true)) return false;
    if (filters.required === 'required' && !task.required) return false;
    if (filters.required === 'optional' && task.required) return false;
    if (filters.priority !== 'all' && task.priority !== filters.priority) return false;
    if (filters.area !== 'all' && task.area !== filters.area) return false;
    if (filters.pack !== 'all' && task.pack !== filters.pack) return false;
    if (filters.blocked && !taskBlocked(task)) return false;
    if (!query) return true;
    return [task.id,task.title,task.description,task.area,task.pack,...(task.baselineIds || [])].join(' ').toLocaleLowerCase('zh-CN').includes(query);
  });
}
export function safeHref(reference,base='http://localhost:14732/') {
  if (typeof reference !== 'string' || !reference.trim() || /[\u0000-\u001f\u007f]/u.test(reference)) return null;
  const value = reference.trim();
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    }
    if (/^(?:\/(?!\/)|\.\/|\.\.\/|#)/u.test(value) && !value.includes('\\')) {
      const url = new URL(value,base);
      return url.origin === new URL(base).origin && ['http:','https:'].includes(url.protocol) ? url.href : null;
    }
  } catch { return null; }
  return null;
}
export function acceptanceCoverage(task) {
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : [];
  const coverage = Array.isArray(task.verdict?.coverage) ? task.verdict.coverage : [];
  const covered = new Set(coverage.filter(entry => (entry.evidenceIds || []).length && (entry.usageEventIds || []).length).map(entry => entry.acceptanceId));
  return {total:acceptance.length,covered:task.verdict?.decision === 'pass' ? acceptance.filter(item => covered.has(item.id)).length : 0};
}
function dateLabel(value) {
  if (!value) return '时间未提供';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);
}
function sourceLabel(source) { return SOURCE_LABELS[source] || String(source || '来源未提供'); }
function buildLabel() { return String(state.build || state.board?.metadata?.build || ''); }
function errorMessage(error) { return error?.message || '请求失败，请检查本地服务后重试。'; }
class ApiError extends Error { constructor(message,status=0,details=null,code='') { super(message); this.status=status; this.details=details; this.code=code; } }

async function request(path,{method='GET',body,raw=false,signal}={}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),15000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort',abort,{once:true});
  try {
    const response = await fetch(path,{method,cache:'no-store',credentials:'same-origin',headers:{...(state.token ? {'X-Board-Token':state.token} : {}),...(body !== undefined ? {'Content-Type':'application/json'} : {})},...(body !== undefined ? {body:JSON.stringify(body)} : {}),signal:controller.signal});
    let data = null;
    if (!response.ok) {
      try { data = await response.json(); } catch { data = {}; }
      const detail = data?.error;
      throw new ApiError(typeof detail === 'object' ? detail.message : typeof detail === 'string' ? detail : `本地服务请求失败（${response.status}）`,response.status,detail?.details || data,detail?.code || '');
    }
    setConnection(true);
    return raw ? response : response.status === 204 ? {} : await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    setConnection(false);
    throw new ApiError(error?.name === 'AbortError' ? '本地服务响应超时。草稿已保留，请重试。' : '无法连接本地服务 localhost:14732。已保留当前数据和草稿，请启动服务后重试。');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort',abort);
  }
}
function setConnection(connected) {
  state.connected = connected;
  if (typeof document === 'undefined' || !$('connection-status')) return;
  const status = $('connection-status');
  status.className = `connection-status ${connected ? 'online' : 'offline'}`;
  status.replaceChildren(el('span',{class:'status-dot'}),connected ? '本地服务已连接' : '本地服务已断开 · 数据未清空');
  if (!connected && state.board) showNotice('本地服务已断开。当前任务为上次读取的数据；未保存草稿仍在本页。','error',[['重新连接',reloadBoard]]);
}
function showNotice(text,kind='info',actions=[]) {
  $('notice').hidden = false;
  $('notice').className = `notice ${kind}`;
  $('notice-text').textContent = text;
  $('notice-actions').replaceChildren(...actions.map(([label,handler]) => btn(label,handler,{className:'small-button'})));
}
function toast(text,kind='info') {
  clearTimeout(toastTimer);
  $('toast').className = `toast ${kind}`;
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; },6000);
}
function setBusy(busy) {
  state.pending = busy;
  document.querySelectorAll('[data-mutation]').forEach(control => { control.disabled = busy; });
  for (const root of [$('action-dialog'),$('task-drawer')]) root?.querySelectorAll('input,textarea,select').forEach(control => {
    if (busy) { control.dataset.busyDisabled = control.disabled ? 'already' : 'temporary'; control.disabled = true; }
    else if (control.dataset.busyDisabled) { control.disabled = control.dataset.busyDisabled === 'already'; delete control.dataset.busyDisabled; }
  });
  $('save-status').textContent = busy ? '正在保存到本机…' : state.board ? `本地版本 ${revisionOf(state.board)}` : '尚未读取数据';
}
async function command(commandData,{errorTarget,success='已保存到本机',onSuccess}={}) {
  if (state.pending) return null;
  if (!state.board || !state.token) {
    const message = '尚未连接本地看板，无法保存。请先重新连接。';
    if (errorTarget) errorTarget.textContent = message; else showNotice(message,'error',[['重新连接',reloadBoard]]);
    return null;
  }
  if (state.conflict) {
    const message = '存在版本冲突，草稿未覆盖。请先重新读取并对比后再保存。';
    if (errorTarget) errorTarget.textContent = message; else showNotice(message,'warning',[['重新读取并对比',() => reloadBoard({compare:true})]]);
    return null;
  }
  if (errorTarget) errorTarget.textContent = '';
  setBusy(true);
  try {
    const payload = await request('/api/command',{method:'POST',body:{expectedRevision:revisionOf(state.board),command:commandData}});
    const board = payload.board || payload;
    if (!Array.isArray(board.tasks)) throw new ApiError('本地服务未返回完整看板，无法确认保存结果。请重新读取核对。');
    state.board = board;
    for (const [id,draft] of state.drafts) if (!draft.dirty) state.drafts.delete(id);
    onSuccess?.(payload);
    render();
    toast(success);
    emitUsage(commandData.type === 'create' ? 'task.create' : commandData.type === 'update' ? 'task.save' : commandData.type === 'transition' ? 'task.state' : `task.${commandData.type}`,{taskId:commandData.id,status:commandData.status});
    return payload;
  } catch (error) {
    if (error.status === 409) {
      state.conflict = {details:error.details,command:structuredClone(commandData),revision:revisionOf(state.board)};
      showNotice('看板已被其他窗口修改（版本冲突）。当前草稿仍在，不会自动覆盖服务器版本。','warning',[['重新读取并对比',() => reloadBoard({compare:true})]]);
    }
    const message = errorMessage(error);
    if (errorTarget) errorTarget.textContent = message;
    else showNotice(message,error.status === 409 ? 'warning' : 'error',[[error.status === 409 ? '重新读取并对比' : '重试',error.status === 409 ? () => reloadBoard({compare:true}) : () => command(commandData,{success,errorTarget})]]);
    $('save-status').textContent = '保存失败 · 草稿已保留';
    return null;
  } finally { setBusy(false); }
}
async function reloadBoard({compare=false}={}) {
  if (state.loading && state.board) return;
  state.loading = true;
  $('reload-button').disabled = true;
  try {
    const bootstrap = await request('/api/bootstrap');
    if (!bootstrap.token) throw new ApiError('本地服务没有提供写入令牌。');
    state.token = bootstrap.token;
    state.build = bootstrap.build || bootstrap.version;
    const response = await request('/api/board');
    const board = response.board || response;
    if (!Array.isArray(board.tasks)) throw new ApiError('看板数据格式不正确，未将其显示为空看板。');
    const conflict = state.conflict;
    state.board = board;
    for (const [id,draft] of state.drafts) if (!draft.dirty) state.drafts.delete(id);
    state.loading = false;
    $('notice').hidden = true;
    render();
    if (compare && conflict) openConflictDialog(conflict);
    else if (conflict) showNotice('已读取最新版本。草稿保留；请完成冲突对比后再保存。','warning',[['对比草稿',() => openConflictDialog(conflict)]]);
  } catch (error) {
    state.loading = false;
    setConnection(false);
    if (!state.board) renderLoadError(errorMessage(error)); else showNotice(errorMessage(error),'error',[['重试连接',() => reloadBoard({compare})]]);
  } finally { $('view-content').setAttribute('aria-busy','false'); $('reload-button').disabled = false; }
}
function renderLoadError(message) {
  $('view-content').replaceChildren(el('div',{class:'error-state'},icon('info'),el('strong',{},'未能读取本地任务'),el('p',{},message),btn('重新连接',reloadBoard,{icon:'refresh'}),el('span',{class:'subtle'},'没有生成演示任务，也不会显示虚假的完成统计。')));
  $('filter-count').textContent = '服务不可用';
}

function packs() {
  const result = (state.board?.packs || []).map(pack => typeof pack === 'string' ? {id:pack,title:pack} : pack);
  const known = new Set(result.map(pack => pack.id));
  for (const task of tasks()) if (task.pack && !known.has(task.pack)) { result.push({id:task.pack,title:task.pack}); known.add(task.pack); }
  return result.sort((a,b) => (a.order ?? 999) - (b.order ?? 999));
}
function render() {
  if (!state.board) return;
  renderSidebar();
  updateFilterOptions();
  renderWorkspace();
  renderDrawer();
  renderRecording();
  $('revision-label').textContent = `版本 ${revisionOf(state.board)}`;
  $('save-status').textContent = state.pending ? '正在保存到本机…' : `最后更新 ${dateLabel(state.board.metadata?.updatedAt)}`;
  $('view-content').setAttribute('aria-busy','false');
}
function renderSidebar() {
  const required = tasks().filter(task => task.required && task.status !== 'archived');
  const done = required.filter(task => task.status === 'done').length;
  $('total-count').textContent = tasks().length;
  $('required-done').textContent = done;
  $('required-total').textContent = required.length;
  $('required-progress').setAttribute('aria-valuemax',required.length);
  $('required-progress').setAttribute('aria-valuenow',done);
  $('required-progress').firstElementChild.style.width = `${required.length ? done / required.length * 100 : 0}%`;
  $('required-note').textContent = `${required.length - done} 项待完成。只有通过日志验收才计入完成。`;
  const definitions = packs();
  $('pack-count').textContent = definitions.length;
  $('project-all').classList.toggle('active',state.filters.pack === 'all');
  $('pack-list').replaceChildren(...definitions.map(pack => el('button',{type:'button',class:`pack-item${state.filters.pack === pack.id ? ' active' : ''}`,onclick:() => changeFilter('pack',pack.id),'aria-pressed':state.filters.pack === pack.id},el('span',{class:'pack-marker'}),el('span',{class:'pack-name'},pack.title || pack.id),el('span',{class:'count'},tasks().filter(task => task.pack === pack.id && (state.filters.required !== 'required' || task.required)).length))));
}
function updateFilterOptions() {
  const area = $('area-filter');
  area.replaceChildren(el('option',{value:'all'},'全部领域'),...[...new Set(tasks().map(task => task.area).filter(Boolean))].sort().map(value => el('option',{value},value)));
  const pack = $('pack-filter');
  pack.replaceChildren(el('option',{value:'all'},'全部交付包'),...packs().map(pack => el('option',{value:pack.id},pack.title || pack.id)));
  for (const name of ['priority','area','pack','required']) $(`${name}-filter`).value = state.filters[name];
  $('blocked-filter').checked = state.filters.blocked;
  $('archived-filter').checked = state.filters.archived;
  $('search').value = state.filters.search;
}
function changeFilter(name,value) {
  state.filters[name] = value;
  updateFilterOptions();
  renderSidebar();
  renderWorkspace();
  emitUsage('board.filter');
}
function resetFilters() {
  state.filters = {search:'',priority:'all',area:'all',pack:'all',required:'required',blocked:false,archived:false};
  updateFilterOptions(); renderSidebar(); renderWorkspace(); emitUsage('board.filter');
}
function renderWorkspace() {
  document.querySelectorAll('[data-view]').forEach(tab => { const active = tab.dataset.view === state.view; tab.classList.toggle('active',active); tab.setAttribute('aria-pressed',active); });
  $('filter-bar').hidden = state.view === 'logs';
  const visible = filterTasks(tasks(),state.filters);
  $('filter-count').textContent = `${visible.length} / ${tasks().length} 项`;
  if (state.view === 'logs') renderLogs(); else if (state.view === 'list') renderList(visible); else renderBoard(visible);
}
function statusLabel(task) { return el('span',{class:'status-label'},el('span',{class:`status-ring ${columnFor(task)}`}),STATUSES[task.status] || task.status || '未设置'); }
function renderBoard(visible) {
  const columns = el('div',{class:'board-columns','aria-label':'按状态分组的任务看板'});
  for (const status of BOARD_STATUSES) {
    const group = visible.filter(task => columnFor(task) === status);
    const column = el('section',{class:'board-column','data-status':status,'aria-label':`${STATUSES[status]} ${group.length} 项`});
    const header = el('div',{class:'column-header'},el('span',{class:`status-ring ${status}`}),el('h2',{},STATUSES[status]),el('span',{class:'count'},group.length));
    if (status !== 'done') header.append(btn('',() => openCreateDialog(status),{className:'icon-button',icon:'plus','aria-label':`新建${STATUSES[status]}任务`}));
    const cards = el('div',{class:'column-cards'});
    group.forEach(task => cards.append(taskCard(task)));
    if (!group.length) cards.append(el('div',{class:'column-empty'},el('strong',{},status === 'done' ? '尚无已验收任务' : '暂无任务'),status === 'done' ? '完成数来自真实验收' : '调整筛选或将任务移至此列'));
    column.append(header,cards);
    if (status === 'done') column.append(el('div',{class:'column-footnote'},'只接受日志验收，不支持拖入'));
    column.addEventListener('dragover',event => {
      if (!event.dataTransfer.types.includes('application/x-qgitgraph-task')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = status === 'done' ? 'none' : 'move'; column.classList.add(status === 'done' ? 'drop-forbidden' : 'drop-target');
    });
    column.addEventListener('dragleave',event => { if (!column.contains(event.relatedTarget)) column.classList.remove('drop-target','drop-forbidden'); });
    column.addEventListener('drop',event => {
      event.preventDefault(); column.classList.remove('drop-target','drop-forbidden');
      const id = event.dataTransfer.getData('application/x-qgitgraph-task');
      if (status === 'done') { toast('不能拖入「已完成」。请在详情中补充执行日志、证据并提交日志验收。','error'); return; }
      if (id) moveTask(id,status);
    });
    columns.append(column);
  }
  $('view-content').replaceChildren(columns);
}
function taskCard(task) {
  const coverage = acceptanceCoverage(task);
  const dependencies = Array.isArray(task.dependsOn) ? task.dependsOn : [];
  const unresolved = dependencies.filter(id => taskById(id)?.status !== 'done').length;
  const card = el('article',{class:`task-card${state.selected === task.id ? ' selected' : ''}`,tabindex:'0',role:'button','aria-label':`${task.id} ${task.title}，${STATUSES[task.status] || task.status}，按回车查看详情，Alt 加左右方向键移动`,'data-task-id':task.id,draggable:task.status !== 'done' && task.status !== 'archived'},el('div',{class:'task-card-header'},el('span',{class:'task-id'},task.id),el('span',{class:`priority ${task.priority || ''}`},task.priority || '未设')),el('h3',{class:'task-title'},task.title || '未命名任务'),el('div',{class:'task-tags'},task.area && el('span',{class:'area-tag'},task.area),task.required && el('span',{class:'required-tag'},'必做'),taskBlocked(task) && el('span',{class:'pill blocked-tag'},'阻塞'),task.status === 'archived' && el('span',{class:'pill'},'已归档')),el('div',{class:'task-card-footer'},el('span',{title:'已通过验收的条目 / 验收条目总数'},icon('checklist'),`${coverage.covered}/${coverage.total}`),el('span',{class:'dependency',title:dependencies.length ? `${unresolved} 项依赖未完成` : '无依赖'},icon('link'),dependencies.length ? `${dependencies.length}${unresolved ? ' 待解' : ''}` : '无依赖')));
  card.addEventListener('click',() => selectTask(task.id,card));
  card.addEventListener('keydown',event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectTask(task.id,card); }
    if (event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();
      if (task.status === 'done') { toast('已完成任务需先在详情中重新打开。'); return; }
      const index = BOARD_STATUSES.indexOf(columnFor(task)); const target = BOARD_STATUSES[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (target === 'done') toast('「已完成」须通过日志验收，不可直接移动。'); else if (target) moveTask(task.id,target);
    }
  });
  card.addEventListener('dragstart',event => { if (state.pending || task.status === 'done' || task.status === 'archived') { event.preventDefault(); return; } event.dataTransfer.setData('application/x-qgitgraph-task',task.id); event.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
  card.addEventListener('dragend',() => { card.classList.remove('dragging'); document.querySelectorAll('.drop-target,.drop-forbidden').forEach(column => column.classList.remove('drop-target','drop-forbidden')); });
  return card;
}
function renderList(visible) {
  if (!visible.length) { $('view-content').replaceChildren(el('div',{class:'empty-state'},icon('search'),el('strong',{},'没有符合筛选条件的任务'),btn('重置筛选',resetFilters))); return; }
  const headers = [['编号','112px'],['任务',null],['优先级','65px'],['状态','112px'],['领域','105px'],['验收','60px'],['依赖','55px']];
  const table = el('table',{class:'task-table','aria-label':'任务列表'},el('colgroup',{},...headers.map(([,width]) => el('col',width ? {style:`width:${width}`} : {}))),el('thead',{},el('tr',{},...headers.map(([label]) => el('th',{scope:'col'},label)))));
  const body = el('tbody');
  for (const task of visible) {
    const coverage = acceptanceCoverage(task);
    const row = el('tr',{'data-task-id':task.id,tabindex:'0',class:state.selected === task.id ? 'selected' : '',onclick:() => selectTask(task.id,row),onkeydown:event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectTask(task.id,row); } }},el('td',{class:'task-id'},task.id),el('td',{class:'title-cell'},task.title,el('small',{},`${task.required ? '必做' : '选做'} · ${packs().find(pack => pack.id === task.pack)?.title || task.pack || '未分包'}`)),el('td',{},el('span',{class:`priority ${task.priority || ''}`},task.priority || '未设')),el('td',{},statusLabel(task)),el('td',{},task.area || '—'),el('td',{title:'已通过验收 / 验收条目'},`${coverage.covered}/${coverage.total}`),el('td',{},(task.dependsOn || []).length));
    body.append(row);
  }
  table.append(body); $('view-content').replaceChildren(table);
}
async function moveTask(id,status,errorTarget) {
  const task = taskById(id);
  if (!task || task.status === status) return;
  if (status === 'done') { toast('请使用详情中的日志验收。普通移动不能标记完成。','error'); return; }
  if (task.status === 'done') { toast('已完成任务须明确重新打开，不能普通移动。','error'); return; }
  await command({type:'transition',id,status},{errorTarget,success:`已移至「${STATUSES[status]}」`});
}

function selectTask(id,origin) {
  if (!taskById(id)) return;
  state.selected = id; state.drawerTab = 'details'; state.returnFocus = origin || document.activeElement;
  renderWorkspace(); renderDrawer(); $('task-drawer').querySelector('h2')?.focus(); emitUsage('task.select',{taskId:id});
}
function closeDrawer() {
  if (state.pending) { toast('正在保存，请等待请求完成。'); return; }
  const id = state.selected; state.selected = null; $('task-drawer').hidden = true; renderWorkspace();
  if (state.returnFocus?.isConnected) state.returnFocus.focus(); else document.querySelector(`[data-task-id="${CSS.escape(id || '')}"]`)?.focus();
}
function draftFor(task) {
  if (!state.drafts.has(task.id)) state.drafts.set(task.id,{patch:{title:task.title || '',description:task.description || '',priority:task.priority || 'P2',area:task.area || '',pack:task.pack || '',required:Boolean(task.required),owner:task.owner || '',acceptance:structuredClone(task.acceptance || []),dependsOn:[...(task.dependsOn || [])]},dirty:false,baseRevision:revisionOf(state.board)});
  return state.drafts.get(task.id);
}
function markDraft(task,key,value) {
  const draft = draftFor(task); draft.patch[key] = value;
  if (!draft.dirty) emitUsage('task.edit',{taskId:task.id});
  draft.dirty = true;
  const status = $('task-drawer').querySelector('.draft-status'); if (status) { status.textContent = '未保存的草稿'; status.classList.add('dirty'); }
}
function renderDrawer() {
  const drawer = $('task-drawer'); const task = taskById(state.selected);
  if (!task) { drawer.hidden = true; return; }
  drawer.hidden = false;
  const dirty = state.drafts.get(task.id)?.dirty;
  const header = el('div',{class:'drawer-header'},el('div',{class:'drawer-heading-group'},el('h2',{id:'drawer-heading',tabindex:'-1'},task.id),el('small',{},'任务详情 · 更改保存在本机')),dirty && el('span',{class:'dirty-indicator'},'有草稿'),btn('',closeDrawer,{className:'icon-button',icon:'close','aria-label':'关闭任务详情'}));
  const tabs = el('div',{class:'drawer-tabs',role:'group','aria-label':'任务详情分区'});
  for (const [key,label] of [['details','详情'],['activity','执行 / 证据'],['history','历史'],['retro','复盘']]) tabs.append(btn(label,() => { state.drawerTab = key; renderDrawer(); },{className:`drawer-tab${state.drawerTab === key ? ' active' : ''}`,'aria-pressed':state.drawerTab === key}));
  const body = el('div',{class:'drawer-body'});
  if (state.drawerTab === 'details') renderDetails(task,body); else if (state.drawerTab === 'activity') renderActivity(task,body); else if (state.drawerTab === 'history') renderHistory(task,body); else renderRetro(task,body);
  drawer.replaceChildren(header,tabs,body);
  if (state.drawerTab === 'details') {
    const draft = draftFor(task); const error = el('div',{class:'form-error',id:'drawer-save-error',role:'alert'});
    drawer.append(error,el('div',{class:'drawer-footer'},el('span',{class:`draft-status${draft.dirty ? ' dirty' : ''}`},draft.dirty ? '未保存的草稿' : '已与本地数据同步'),btn('放弃草稿',() => discardDraft(task),{className:'small-button',mutation:true}),btn('保存修改',() => saveDraft(task,error),{className:'primary-button',mutation:true})));
    error.style.paddingInline = '18px';
  }
  if (state.pending) drawer.querySelectorAll('input,textarea,select').forEach(control => {
    control.dataset.busyDisabled = control.disabled ? 'already' : 'temporary';
    control.disabled = true;
  });
}
function renderDetails(task,body) {
  const draft = draftFor(task);
  body.append(el('div',{class:'drawer-metadata'},statusLabel(task),el('span',{class:`priority ${task.priority || ''}`},task.priority || '未设'),task.required && el('span',{class:'pill'},'必做任务')));
  if (task.status === 'archived') body.append(el('p',{class:'archived-note'},'已归档任务，仍可查看记录和恢复状态。'));
  const form = el('div',{class:'field-grid',style:'margin-top:16px'});
  const bind = (key,control,transform=control => control.value) => { control.addEventListener('input',() => markDraft(task,key,transform(control))); return control; };
  form.append(field('任务标题',bind('title',el('input',{value:draft.patch.title,required:true,maxlength:300})),{full:true}),field('描述',bind('description',el('textarea',{rows:4,value:draft.patch.description})),{full:true}),field('优先级',bind('priority',selectOf(['P0','P1','P2'],draft.patch.priority,{disabled:Boolean(task.sourceResult),'aria-label':'任务优先级（基线固定）'}))),field('领域',bind('area',el('input',{value:draft.patch.area,maxlength:120}))),field('交付包',bind('pack',selectOf([['','未分包'],...packs().map(pack => [pack.id,pack.title || pack.id])],draft.patch.pack))),field('负责人',bind('owner',el('input',{value:draft.patch.owner,maxlength:120}))));
  form.append(el('label',{class:'checkbox-label'},bind('required',el('input',{type:'checkbox',checked:draft.patch.required,disabled:Boolean(task.required)}),control => control.checked),'必做任务'));
  body.append(form);
  const baseline = Array.isArray(task.baselineIds) ? task.baselineIds.join('、') : '';
  body.append(el('section',{class:'section-note'},el('strong',{},'基线关联'),el('p',{},baseline || '未关联基线。基线只读，避免在任务详情中改写源数据。')));
  for (const id of task.baselineIds || []) {
    const row = state.board?.baseline?.rows?.find(item => item.id === id);
    if (!row) continue;
    const details = el('details',{class:'baseline-comparison'});
    details.append(el('summary',{},`基线 ${String(id).padStart(2,'0')} · ${row.title}`));
    const table = el('dl');
    for (const [label,value] of [['旧 v4 实际',row.old],['当前应用',row.application],['建立看板时的 Vue 状态',row.sourceStatus],['缺口类型',row.gap],['原始优先级',row.sourcePriority],['来源证据',row.sourceEvidence]]) table.append(el('dt',{},label),el('dd',{},value || '—'));
    details.append(table,el('p',{class:'section-note'},'此为来源基线快照；当前执行进度以本任务状态、证据和验收记录为准。'));
    body.append(details);
  }
  const acceptance = el('section');
  acceptance.append(el('div',{class:'drawer-section-heading'},el('h3',{},'验收标准'),btn('新增条目',() => { markDraft(task,'acceptance',[...draft.patch.acceptance,{id:`AC-${draft.patch.acceptance.length + 1}-${Date.now().toString(36)}`,text:'',scenarioIds:['board-use']}]); renderDrawer(); },{className:'text-button',icon:'plus',mutation:true})));
  const list = el('div',{class:'edit-acceptance-list'});
  draft.patch.acceptance.forEach((criterion,index) => {
    const text = el('textarea',{rows:2,value:criterion.text || '', 'aria-label':`验收标准 ${index + 1}`});
    text.addEventListener('input',() => { criterion.text = text.value; markDraft(task,'acceptance',draft.patch.acceptance); });
    const scenarios = el('input',{value:(criterion.scenarioIds || []).join(', '),'aria-label':`标准 ${index + 1} 的场景编号`,placeholder:'场景编号，逗号分隔'});
    scenarios.addEventListener('input',() => { criterion.scenarioIds = splitIds(scenarios.value); markDraft(task,'acceptance',draft.patch.acceptance); });
    list.append(el('div',{class:'edit-acceptance-row'},el('div',{class:'acceptance-fields'},el('label',{},criterion.id || `条目 ${index + 1}`),text,scenarios),btn('',() => { markDraft(task,'acceptance',draft.patch.acceptance.filter((_,i) => i !== index)); renderDrawer(); },{className:'icon-button',icon:'close','aria-label':`删除验收标准 ${index + 1}`,mutation:true})));
  });
  if (!draft.patch.acceptance.length) list.append(el('p',{class:'section-note'},'尚无验收标准。验收前请添加可验证的条目。'));
  acceptance.append(list); body.append(acceptance);
  const deps = el('section',{},el('div',{class:'drawer-section-heading'},el('h3',{},'依赖任务')));
  const depInput = el('input',{value:draft.patch.dependsOn.join(', '),'aria-label':'依赖任务编号',placeholder:'任务编号，逗号分隔'});
  depInput.addEventListener('input',() => markDraft(task,'dependsOn',splitIds(depInput.value)));
  deps.append(field('依赖编号',depInput,{hint:'后端会校验编号、循环依赖；未完成依赖会阻止完成验收。'}));
  const depLinks = el('div',{class:'dependency-list',style:'margin-top:8px'});
  for (const id of task.dependsOn || []) {
    const dependency = taskById(id); const link = btn('',() => selectTask(id),{className:'dependency-link','aria-label':`打开依赖任务 ${id}`});
    link.append(el('span',{},id),el('span',{},dependency?.title || '任务不存在'),dependency && statusLabel(dependency)); depLinks.append(link);
  }
  deps.append(depLinks); body.append(deps);
  const transition = el('section',{},el('div',{class:'drawer-section-heading'},el('h3',{},'状态流转'))); const error = el('p',{class:'form-error',role:'alert'});
  if (task.status === 'done') transition.append(el('p',{class:'callout'},'此任务已完成。若发现问题，可明确重新打开，保留已有验收记录。'),btn('重新打开任务',() => openReopenDialog(task),{className:'quiet-button',mutation:true}));
  else {
    const target = selectOf(Object.entries(STATUSES).filter(([key]) => key !== 'done'),task.status,{'aria-label':'目标任务状态'});
    transition.append(el('div',{class:'move-controls'},target,btn('应用状态',() => moveTask(task.id,target.value,error),{mutation:true})),error,el('p',{class:'section-note'},'完成任务必须提交执行日志、证据和使用事件后验收。'),btn('提交日志验收',() => openAssessDialog(task),{icon:'check',mutation:true}));
  }
  body.append(transition);
}
function splitIds(value) { return [...new Set(String(value || '').split(/[,，\n]/u).map(item => item.trim()).filter(Boolean))]; }
function splitLines(value) { return String(value || '').split(/\n/u).map(item => item.trim()).filter(Boolean); }
function discardDraft(task) {
  if (state.drafts.get(task.id)?.dirty) openConfirmation('放弃未保存修改？','仅清除此任务在当前页面的草稿，不修改已保存的数据。','放弃草稿',() => { state.drafts.delete(task.id); renderDrawer(); });
  else { state.drafts.delete(task.id); renderDrawer(); }
}
async function saveDraft(task,error) {
  const draft = draftFor(task);
  if (!draft.patch.title.trim()) { error.textContent = '请输入任务标题。'; return; }
  if (!draft.patch.area.trim()) { error.textContent = '领域不能为空。'; return; }
  if (!draft.patch.acceptance.length || draft.patch.acceptance.some(criterion => !criterion.text.trim() || !criterion.scenarioIds?.length)) { error.textContent = '请保留至少一条验收标准，且每条标准均填写文本和场景编号。'; return; }
  if (draft.patch.acceptance.some(criterion => criterion.scenarioIds.some(id => !validId(id)))) { error.textContent = '场景编号只能包含字母、数字、点、冒号、短横线和下划线。'; return; }
  if (draft.patch.dependsOn.includes(task.id)) { error.textContent = '任务不能依赖自己。'; return; }
  const result = await command({type:'update',id:task.id,patch:structuredClone(draft.patch)},{errorTarget:error,onSuccess:() => state.drafts.delete(task.id)});
  if (result) state.drafts.delete(task.id);
}

function logsFor(task) { if (Array.isArray(task.executionLogs)) return task.executionLogs; if (Array.isArray(task.logs)) return task.logs; return (task.history || []).filter(item => item.kind === 'log' || item.type === 'log'); }
function evidenceFor(task) { return Array.isArray(task.evidence) ? task.evidence : []; }
function retrospectivesFor(task) { return Array.isArray(task.retrospectives) ? task.retrospectives : []; }
function renderActivity(task,body) {
  const logs = logsFor(task); const evidence = evidenceFor(task); const logSection = el('section');
  logSection.append(el('div',{class:'drawer-section-heading'},el('h3',{},'执行日志'),btn('追加日志',() => openLogDialog(task),{className:'small-button',icon:'plus',mutation:true})));
  if (!logs.length) logSection.append(el('p',{class:'callout warning'},'尚无执行日志。没有日志，任务不能通过已完成验收。'));
  for (const log of logs) logSection.append(el('article',{class:'history-item'},el('div',{class:'history-item-header'},el('strong',{},log.kind === 'log' ? '执行日志' : log.actor || '执行记录'),el('time',{},dateLabel(log.at || log.createdAt || log.timestamp))),el('p',{},log.text || log.summary || '未提供日志文本')));
  body.append(logSection);
  const evidenceSection = el('section'); evidenceSection.append(el('div',{class:'drawer-section-heading'},el('h3',{},'证据'),btn('添加证据',() => openEvidenceDialog(task),{className:'small-button',icon:'plus',mutation:true})));
  if (!evidence.length) evidenceSection.append(el('p',{class:'callout'},'尚无证据。证据路径只作为文本保存和复制，不会由看板读取服务器文件。'));
  for (const item of evidence) {
    const reference = item.reference || item.path || ''; const safe = safeHref(reference);
    const copy = btn('复制',() => navigator.clipboard?.writeText(reference).then(() => toast('证据引用已复制')).catch(() => toast('浏览器不允许复制，请手动选择文本。','error')),{className:'small-button',icon:'copy'});
    evidenceSection.append(el('article',{class:'evidence-item'},el('div',{class:'history-item-header'},el('strong',{},item.type || '证据'),el('span',{class:`pill ${item.result === 'passed' ? 'required-tag' : ''}`},item.result || '未标记'),el('time',{},dateLabel(item.at || item.createdAt))),el('p',{},item.summary || '未提供摘要'),el('span',{class:'reference'},reference || '未提供引用'),safe && btn('打开链接',() => window.open(safe,'_blank','noopener,noreferrer'),{className:'small-button'}),copy,item.build && el('small',{},`构建：${item.build}`),Array.isArray(item.eventIds) && item.eventIds.length && el('small',{},`关联使用事件：${item.eventIds.join('、')}`)));
  }
  body.append(evidenceSection,el('p',{class:'section-note'},'提交验收前，确保每个验收标准均有同一构建的通过证据，以及至少一条已记录的用户使用事件。'),btn('提交日志验收',() => openAssessDialog(task),{className:'primary-button',icon:'check',mutation:true}));
}
function renderHistory(task,body) {
  const history = Array.isArray(task.history) ? task.history : [];
  if (!history.length) { body.append(el('div',{class:'empty-state'},icon('activity'),el('strong',{},'暂无历史记录'),el('p',{},'状态、编辑和验收操作会显示在这里。'))); return; }
  const section = el('section'); section.append(el('div',{class:'drawer-section-heading'},el('h3',{},`历史记录 · ${history.length}`)));
  for (const item of [...history].reverse()) section.append(el('article',{class:'history-item'},el('div',{class:'history-item-header'},el('strong',{},historyKind(item.kind || item.type)),el('time',{},dateLabel(item.at || item.createdAt))),el('p',{},item.text || item.summary || item.rationale || describeHistory(item)),item.actor && el('small',{},`操作者：${item.actor}`),item.revision !== undefined && el('small',{},`版本：${item.revision}`)));
  body.append(section);
}
function historyKind(kind) { return ({create:'创建',update:'编辑',transition:'状态变更',log:'执行日志',evidence:'证据',assess:'验收',retrospective:'复盘',import:'导入'}[kind] || kind || '记录'); }
function describeHistory(item) { return Object.entries(item).filter(([key]) => !['kind','type','at','createdAt','actor','revision'].includes(key)).map(([key,value]) => `${key}：${typeof value === 'object' ? JSON.stringify(value) : value}`).join('\n'); }
function renderRetro(task,body) {
  const retros = retrospectivesFor(task); const section = el('section'); section.append(el('div',{class:'drawer-section-heading'},el('h3',{},'复盘记录'),btn('添加复盘',() => openRetroDialog(task),{className:'small-button',icon:'plus',mutation:true})));
  if (!retros.length) section.append(el('p',{class:'callout'},'完成后可在这里记录做得好、风险和下一步。'));
  for (const item of retros) section.append(el('article',{class:'retro-item'},el('div',{class:'history-item-header'},el('strong',{},item.kind || '复盘'),el('time',{},dateLabel(item.at || item.createdAt))),el('p',{},item.text || item.summary || '未提供复盘内容'),item.actor && el('small',{},`操作者：${item.actor}`)));
  body.append(section);
}

function dialogShell(title,description,content,error,...buttons) {
  const dialog = $('action-dialog');
  dialog.replaceChildren(el('div',{class:'dialog-header'},el('div',{},el('h2',{id:'dialog-title'},title),description && el('p',{},description)),btn('',closeDialog,{className:'icon-button',icon:'close','aria-label':'关闭对话框'})),el('div',{class:'dialog-content'},content,error),el('div',{class:'dialog-footer'},...buttons));
  lastDialogFocus = document.activeElement;
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open','');
  dialog.querySelector('input,textarea,select,button')?.focus();
}
function closeDialog() {
  const dialog = $('action-dialog');
  if (dialog.open && typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
  if (lastDialogFocus?.isConnected) lastDialogFocus.focus(); lastDialogFocus = null;
}
function openConfirmation(title,description,confirmLabel,action) {
  const error = el('p',{class:'form-error',role:'alert'});
  dialogShell(title,description,el('p',{class:'callout'},'此操作不会执行命令或读取证据路径。请确认后继续。'),error,btn('取消',closeDialog,{className:'small-button'}),btn(confirmLabel,async () => { closeDialog(); await action(); },{className:'primary-button',mutation:true}));
}
function openCreateDialog(initialStatus='todo') {
  const generated = `QG-CUSTOM-${Date.now().toString(36).toUpperCase()}`;
  const id = el('input',{value:generated,required:true,maxlength:67,pattern:'QG-(?:[0-9]{3}|[A-Z][A-Z0-9-]{0,63})'});
  const title = el('input',{required:true,maxlength:300,placeholder:'例如：完成本地任务看板验收'});
  const description = el('textarea',{rows:4,placeholder:'任务背景、范围和限制'});
  const priority = selectOf(['P0','P1','P2'],'P2'); const area = el('input',{maxlength:120,placeholder:'例如：桌面端 / 任务板'});
  const pack = selectOf(packs().map(item => [item.id,item.title || item.id]),state.filters.pack !== 'all' ? state.filters.pack : 'W0'); const owner = el('input',{maxlength:120,placeholder:'负责人（可选）'});
  const required = el('input',{type:'checkbox',checked:false}); const acceptance = el('textarea',{rows:3,placeholder:'每行一个可验证的验收标准'}); const dependsOn = el('input',{placeholder:'任务编号，逗号分隔'});
  const form = el('div',{class:'field-grid'},field('任务编号',id,{hint:'以 QG- 开头，后接大写字母、数字和短横线。'}),field('优先级',priority),field('任务标题',title,{full:true}),field('任务描述',description,{full:true}),field('领域',area),field('交付包',pack),field('负责人',owner),el('label',{class:'checkbox-label'},required,'必做任务'),field('验收标准',acceptance,{full:true,hint:'创建后也可在详情抽屉中编辑。'}),field('依赖任务',dependsOn,{full:true}));
  const error = el('p',{class:'form-error',role:'alert'});
  const submit = async () => {
    const idValue = id.value.trim(); const titleValue = title.value.trim();
    if (!/^QG-(?:\d{3}|[A-Z][A-Z0-9-]{0,63})$/u.test(idValue)) { error.textContent = '任务编号格式不正确，请使用 QG- 后接大写字母、数字和短横线。'; id.focus(); return; }
    if (!titleValue) { error.textContent = '请输入任务标题。'; title.focus(); return; }
    if (!acceptance.value.trim()) { error.textContent = '请至少填写一条可验证的验收标准。'; acceptance.focus(); return; }
    const acceptanceItems = acceptance.value.split(/\n/u).map(text => text.trim()).filter(Boolean).map((text,index) => ({id:`AC-${index + 1}`,text,scenarioIds:['board-use']}));
    const patch = {title:titleValue,description:description.value,priority:priority.value,area:area.value.trim() || '自定义',pack:pack.value,required:required.checked,owner:owner.value.trim(),acceptance:acceptanceItems,dependsOn:splitIds(dependsOn.value)};
    const result = await command({type:'create',id:idValue,patch},{errorTarget:error,success:'任务已创建并保存到本机'});
    if (result) { closeDialog(); selectTask(idValue); }
  };
  dialogShell('新建任务','创建只写入本地任务看板，不执行命令。新任务会从待办开始。',form,error,btn('取消',closeDialog,{className:'small-button'}),btn('创建任务',submit,{className:'primary-button',mutation:true}));
}
function openReopenDialog(task) {
  const target = selectOf([['inprogress','进行中'],['ready','可执行']],'inprogress'); const rationale = el('textarea',{rows:3,placeholder:'说明为什么重新打开（可选）'}); const error = el('p',{class:'form-error',role:'alert'});
  const submit = async () => { const result = await command({type:'transition',id:task.id,status:target.value,text:rationale.value.trim() || undefined},{errorTarget:error,success:'任务已重新打开'}); if (result) closeDialog(); };
  dialogShell('重新打开已完成任务','重新打开会保留原有验收、证据和历史。不会伪造新的完成记录。',el('div',{class:'field-grid'},field('目标状态',target),field('说明',rationale,{full:true})),error,btn('取消',closeDialog,{className:'small-button'}),btn('重新打开',submit,{className:'primary-button',mutation:true}));
}
function openLogDialog(task) {
  const text = el('textarea',{rows:7,required:true,placeholder:'记录实际执行、结果、构建编号和剩余限制。不要粘贴密钥或完整代码。'}); const error = el('p',{class:'form-error',role:'alert'});
  const submit = async () => { if (!text.value.trim()) { error.textContent = '执行日志不能为空。'; return; } const result = await command({type:'log',id:task.id,text:text.value.trim()},{errorTarget:error,success:'执行日志已追加'}); if (result) { closeDialog(); state.drawerTab = 'activity'; renderDrawer(); } };
  dialogShell('追加执行日志','日志是验收链路的一部分，只保存你明确提交的文本。',field('日志内容',text,{full:true}),error,btn('取消',closeDialog,{className:'small-button'}),btn('保存日志',submit,{className:'primary-button',mutation:true}));
}
function taskUsageEvents(task) { return state.events.filter(event => Array.isArray(event.taskIds) && event.taskIds.includes(task.id)); }
function openEvidenceDialog(task) {
  const type = selectOf([['test','测试结果'],['browser','浏览器回归'],['usage','使用记录'],['observation','人工观察']],'test'); const result = selectOf([['passed','通过'],['failed','失败']],'passed');
  const build = el('input',{value:buildLabel(),maxlength:128,placeholder:'必须与验收构建一致'}); const summary = el('textarea',{rows:3,required:true,placeholder:'说明证据验证了什么'}); const reference = el('textarea',{rows:2,placeholder:'链接或路径文本；不会被服务器读取'});
  const usage = taskUsageEvents(task);
  const eventIds = el('input',{value:usage.filter(event => event.build === build.value).map(event => event.eventId).join(', '),placeholder:'使用事件 ID，逗号分隔'});
  const error = el('p',{class:'form-error',role:'alert'});
  const submit = async () => {
      if (!build.value.trim() || !reference.value.trim()) { error.textContent = '构建编号和证据引用不能为空。'; return; }
      if (!summary.value.trim()) { error.textContent = '证据摘要不能为空。'; return; }
      const payload = await command({type:'evidence',id:task.id,evidence:{type:type.value,result:result.value,build:build.value.trim(),summary:summary.value.trim(),reference:reference.value.trim(),eventIds:splitIds(eventIds.value)}},{errorTarget:error,success:'证据已保存'});
      if (payload) { closeDialog(); state.drawerTab = 'activity'; renderDrawer(); }
    };
  dialogShell('添加证据','证据引用只作为文本保存和复制，不会读取本地路径。',el('div',{class:'field-grid'},field('证据类型',type),field('结果',result),field('构建编号',build,{full:true}),field('摘要',summary,{full:true}),field('引用（链接或路径文本）',reference,{full:true}),field('关联使用事件',eventIds,{full:true}),el('p',{class:'hint'},usage.length ? `当前任务已有 ${usage.length} 条本页已读取的使用事件。` : '尚未读取到该任务的使用事件；请先开始并使用显式记录会话。')),error,btn('取消',closeDialog,{className:'small-button'}),btn('保存证据',submit,{className:'primary-button',mutation:true}));
}
function openRetroDialog(task) {
  const text = el('textarea',{rows:8,required:true,placeholder:'记录结果、偏差、风险和下一步。'}); const error = el('p',{class:'form-error',role:'alert'});
  const submit = async () => { if (!text.value.trim()) { error.textContent = '复盘内容不能为空。'; return; } const payload = await command({type:'retrospective',id:task.id,text:text.value.trim()},{errorTarget:error,success:'复盘已保存'}); if (payload) { closeDialog(); state.drawerTab = 'retro'; renderDrawer(); } };
  dialogShell('添加复盘','只保存明确提交的文本，不会自动生成结论。',field('内容',text,{full:true}),error,btn('取消',closeDialog,{className:'small-button'}),btn('保存复盘',submit,{className:'primary-button',mutation:true}));
}
function openAssessDialog(task) {
  const acceptance = Array.isArray(task.acceptance) ? task.acceptance : []; const evidence = evidenceFor(task); const usage = taskUsageEvents(task);
  const decision = selectOf([['pass','通过验收并标记完成'],['fail','未通过，保留当前状态'],['insufficient','证据不足，保留当前状态']],'pass'); const build = el('input',{value:buildLabel(),maxlength:128,placeholder:'本次验收构建编号'}); const rationale = el('textarea',{rows:4,required:true,placeholder:'说明验收结论、环境和限制'}); const limitations = el('textarea',{rows:3,placeholder:'限制和后续事项（可选）'}); const rows = [];
  const choices = el('div',{class:'assessment-choices'});
  acceptance.filter(criterion => criterion.applicability !== 'not-applicable').forEach((criterion,index) => {
    const evidenceSelect = el('select',{multiple:true,size:Math.min(3,Math.max(1,evidence.length)),'aria-label':`${criterion.id} 的证据`}); evidence.forEach(item => evidenceSelect.append(el('option',{value:item.id || '',disabled:!item.id},`${item.id || '无 ID 证据'} · ${item.summary || item.type || '未命名'}`)));
    const usageSelect = el('select',{multiple:true,size:Math.min(3,Math.max(1,usage.length)),'aria-label':`${criterion.id} 的使用事件`}); usage.forEach(item => usageSelect.append(el('option',{value:item.eventId},`${item.eventId} · ${item.actionId || '使用事件'}`)));
    rows.push({criterion,evidenceSelect,usageSelect}); choices.append(el('div',{class:'assessment-row'},el('p',{},`${index + 1}. ${criterion.text || '未填写标准'}`),el('small',{},criterion.id || `AC-${index + 1}`),field('同构建通过证据（可多选）',evidenceSelect),field('用户使用事件（可多选）',usageSelect)));
  });
  const note = acceptance.length ? (usage.length ? '通过验收要求：每个标准的全部场景都要覆盖，且有关联的同构建通过证据；后端还会校验时效、来源与依赖。' : '当前没有可关联的使用事件。请先启动并使用显式记录会话，再读取日志。') : '尚未填写验收标准，不能形成有效验收。';
  const error = el('p',{class:'form-error',role:'alert'});
  const criterionScenario = selectOf([...new Set((task.acceptance || []).filter(item => item.applicability !== 'not-applicable').flatMap(item => item.scenarioIds || []))].map(id => [id,id]),task.acceptance?.[0]?.scenarioIds?.[0] || '');
  const recordActualCheck = btn('记录实际使用核验',() => {
    if (!state.recording || state.paused) { toast('请先显式开始并继续一个记录会话。未开始或暂停时不会发送事件。','error'); return; }
    if (!criterionScenario.value) { toast('请先为验收标准填写场景编号。','error'); return; }
    emitUsage('task.acceptance.check',{taskId:task.id,scenarioId:criterionScenario.value,resultCode:'MANUAL_CHECK_DECLARED'});
    toast('已记录人工核验声明；该声明不能替代原型的操作日志或自动成为完成证据。');
  },{className:'small-button'});
  const submit = async () => {
    if (task.status !== 'readyforusage') { error.textContent = '请先应用状态「待使用验收」，再提交日志验收。'; return; }
    if (!build.value.trim()) { error.textContent = '请填写验收构建编号。'; return; }
    if (!acceptance.length) { error.textContent = '请先在详情中添加验收标准。'; return; }
    if (!rationale.value.trim()) { error.textContent = '请填写验收说明。'; return; }
    const coverage = rows.map(({criterion,evidenceSelect,usageSelect}) => ({acceptanceId:criterion.id,evidenceIds:[...evidenceSelect.selectedOptions].map(option => option.value).filter(Boolean),usageEventIds:[...usageSelect.selectedOptions].map(option => option.value)}));
    if (decision.value === 'pass' && coverage.some(item => !item.evidenceIds.length || !item.usageEventIds.length)) { error.textContent = '要通过验收，每个验收标准都必须至少选择一条证据和一条使用事件。'; return; }
    const verdict = {decision:decision.value,rationale:rationale.value.trim(),build:build.value.trim(),coverage,limitations:splitLines(limitations.value)};
    const payload = await command({type:'assess',id:task.id,verdict},{errorTarget:error,success:decision.value === 'pass' ? '已提交验收，等待本地服务确认完成' : '验收结果已保存'});
    if (payload) { closeDialog(); state.drawerTab = 'activity'; renderDrawer(); }
  };
  dialogShell('提交日志验收','完成状态只能由 assess 命令产生。普通拖拽、键盘移动和 transition 都不能标记完成。',el('div',{class:'operation-form'},field('验收决定',decision),field('构建编号',build),field('验收说明',rationale,{full:true}),choices,el('div',{class:'callout'},field('实际核验的场景',criterionScenario),recordActualCheck,el('p',{class:'hint'},'所有场景都需实际事件覆盖；这里仅记录人工声明，不能把一次点击变成使用验证。新事件保存后重新打开对话框查看。')),
    el('p',{class:`callout ${!usage.length && acceptance.length ? 'warning' : ''}`},note),field('限制',limitations,{full:true})),error,btn('取消',closeDialog,{className:'small-button'}),btn('提交验收',submit,{className:'primary-button',mutation:true}));
}

function normalizeSource(source) { return ['userusage','assistant','automated-test'].includes(source) ? source : 'userusage'; }
function validId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }
function usageTaskIds(details={}) { const values = details.taskIds || (details.taskId ? [details.taskId] : []); return [...new Set(values.filter(validId))].slice(0,50); }
function usageState(details={}) { const task = details.taskId ? taskById(details.taskId) : null; return {theme:document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',viewport:'wide',...(task?.status ? {status:task.status} : {}),phase:details.phase || 'success',trusted:false,busy:Boolean(state.pending),cancelled:false}; }
function makeUsageEvent(actionId,details={}) {
  const sequence = (state.session?.sequence || 0) + 1; if (state.session) state.session.sequence = sequence;
  const scenarioId = validId(details.scenarioId) ? details.scenarioId : 'board-use';
  const event = {eventId:`ui-${Date.now().toString(36)}-${sequence}`,sequence,timestamp:new Date().toISOString(),taskIds:usageTaskIds(details),scenarioId,actionId:String(actionId).replace(/[^A-Za-z0-9._:-]/gu,'-').slice(0,128),resultCode:details.resultCode || 'success',state:usageState(details)};
  if (Number.isInteger(details.durationMs) && details.durationMs >= 0) event.durationMs = details.durationMs;
  if (validId(details.errorCode)) event.errorCode = details.errorCode;
  if (details.counts && typeof details.counts === 'object') { const allowed = ['selected','files','staged','unstaged','untracked','commits','conflicts','changed','total']; const counts = {}; for (const key of allowed) if (Number.isInteger(details.counts[key]) && details.counts[key] >= 0) counts[key] = details.counts[key]; if (Object.keys(counts).length) event.counts = counts; }
  return event;
}
async function drainUsage() {
  while (state.recording && !state.paused && state.usageRetry.length && !state.usageError) {
    const item = state.usageRetry[0];
    try {
      const result = await request('/api/usage/events',{method:'POST',body:{sessionId:item.sessionId,sessionToken:item.sessionToken,events:[item.event]}});
      if (result.accepted !== 1) throw new ApiError('服务未确认接收使用事件。');
      state.usageRetry.shift();
      state.events = [...state.events,{...item.event,sessionId:item.sessionId,source:item.source,build:item.build,complete:true}].slice(-2000);
    } catch (error) {
      if (error.code === 'DUPLICATE_EVENT') {
        try {
          const usage = await request(`/api/usage?sessionId=${encodeURIComponent(item.sessionId)}&offset=${item.event.sequence - 1}&limit=1`);
          if (usage.events?.some(event => event.eventId === item.event.eventId)) {
            state.usageRetry.shift();
            state.events = [...state.events,...usage.events].slice(-2000);
            continue;
          }
        } catch { /* 保留待确认事件，不猜测成功。 */ }
      }
      state.usageError = `事件 ${item.event.eventId} 未确认保存：${errorMessage(error)}`;
      showNotice(state.usageError,'error',[['重试使用记录',retryPendingUsage]]);
      break;
    }
  }
  renderRecording();
  if (state.view === 'logs') renderLogs();
}
function retryPendingUsage() {
  if (!state.session || !state.recording) { toast('会话已结束，不能重试已清除的会话令牌。','error'); return; }
  if (state.paused) { toast('记录已暂停。请先继续记录，再重试待发送事件。'); return; }
  state.usageError = null;
  state.usageQueue = state.usageQueue.then(drainUsage);
}
function emitUsage(actionId,details={}) {
  if (!state.session || !state.recording || state.paused || !state.session.sessionId || !state.session.sessionToken) return;
  const {sessionId,sessionToken,source,build} = state.session;
  const event = makeUsageEvent(actionId,details);
  state.usageRetry.push({event,sessionId,sessionToken,source,build});
  state.usageQueue = state.usageQueue.then(drainUsage);
}
function renderRecording() {
  const control = $('record-control'); const pause = $('record-pause'); const label = $('record-label');
  control.classList.toggle('recording',Boolean(state.recording && !state.paused)); control.classList.toggle('paused',Boolean(state.recording && state.paused)); pause.hidden = !state.recording; pause.textContent = state.paused ? '继续' : '暂停';
  label.textContent = !state.recording ? '未开始记录' : state.paused ? '记录已暂停' : state.usageError ? '记录异常 · 可重试' : `记录中 · ${sourceLabel(state.session?.source)}`;
  control.setAttribute('aria-label',state.recording ? '结束当前记录会话' : '开始记录会话');
}
async function beginRecording(source,build,taskIds) {
  const response = await request('/api/usage/session',{method:'POST',body:{source:normalizeSource(source),build:build.trim() || buildLabel() || 'local',...(taskIds.length ? {taskIds} : {})}}); const session = response.session || response;
  if (!session.sessionId || !session.sessionToken) throw new ApiError('本地服务没有返回可用的会话能力。没有开始记录。');
  state.session = {sessionId:session.sessionId,sessionToken:session.sessionToken,source:normalizeSource(session.source || source),build:session.build || build,sequence:0}; state.recording = true; state.paused = false; state.usageError = null; renderRecording(); toast(`已开始记录：${sourceLabel(state.session.source)}。会话令牌仅保存在内存中。`); emitUsage('session.start',{taskIds,phase:'running'});
}
async function stopRecording() {
  if (!state.recording) return;
  if (!state.paused && !state.usageError) { emitUsage('session.stop',{phase:'success'}); await state.usageQueue; }
  if (state.usageRetry.length) {
    toast(`仍有 ${state.usageRetry.length} 个事件未确认保存。请继续记录并重试后再结束。`,'error');
    return;
  }
  state.session = null;
  state.recording = false;
  state.paused = false;
  state.usageError = null;
  renderRecording();
  toast('记录会话已结束。会话令牌已从内存清除。');
}
function togglePauseRecording() { if (!state.recording) return; state.paused = !state.paused; renderRecording(); if (state.paused) toast('记录已暂停；暂停期间不会发送事件。'); else { toast('记录已继续。'); emitUsage('session.resume',{phase:'running'}); retryPendingUsage(); } }
function openSessionDialog() {
  const source = el('div',{class:'session-options'}); [['userusage','用户使用','记录你明确进行的任务看板操作和验收使用。'],['assistant','助手回归','记录助手驱动的回归操作；不记录代码、diff 或自由文本。'],['automated-test','自动测试','记录自动测试使用；事件必须来自白名单字段。']].forEach(([value,label,description]) => source.append(el('label',{class:'session-option'},el('input',{type:'radio',name:'usage-source',value,checked:value === 'userusage'}),el('span',{},el('strong',{},label),el('small',{},description)))));
  const build = el('input',{value:buildLabel(),maxlength:128,placeholder:'构建编号，例如 build-2026.11.24'}); const taskIds = el('input',{value:state.selected || '',maxlength:500,placeholder:'可选：任务编号，逗号分隔'}); const error = el('p',{class:'form-error',role:'alert'});
  const submit = async () => { const selected = source.querySelector('input:checked')?.value || 'userusage'; const ids = splitIds(taskIds.value); if (ids.some(id => !validId(id))) { error.textContent = '任务编号包含不允许的字符。'; return; } try { await beginRecording(selected,build.value,ids); closeDialog(); } catch (e) { error.textContent = errorMessage(e); } };
  dialogShell('开始使用记录','记录是可见、可暂停、可追踪的本地会话，不代表加密身份或密码学证明。',el('div',{class:'operation-form'},source,field('构建编号',build,{hint:'会用于验收证据的同构建校验。'}),field('关联任务',taskIds,{hint:'只填写任务编号；不填写代码、diff 或文本。'}),el('p',{class:'callout'},'开始前必须明确选择来源。未开始或已暂停时，不会向本地 usage API 发送事件。会话令牌只保存在本页内存。')),error,btn('取消',closeDialog,{className:'small-button'}),btn('开始记录',submit,{className:'primary-button',mutation:true}));
}
async function loadUsage(sessionId=state.selectedSession) {
  if (state.logsLoading) return; state.logsLoading = true; state.logsError = null;
  try {
    const sessionsResponse = await request('/api/usage/sessions'); state.sessions = Array.isArray(sessionsResponse.sessions) ? sessionsResponse.sessions : [];
    if (sessionId && !state.sessions.some(item => item.sessionId === sessionId)) sessionId = null; if (!sessionId) sessionId = state.session?.sessionId || state.sessions[0]?.sessionId || null; state.selectedSession = sessionId;
    if (sessionId) { const response = await request(`/api/usage?sessionId=${encodeURIComponent(sessionId)}&limit=200&offset=0`); state.events = Array.isArray(response.events) ? response.events : []; } else state.events = [];
  } catch (error) { state.logsError = errorMessage(error); }
  finally { state.logsLoading = false; if (state.view === 'logs') renderLogs(); }
}
function renderLogs() {
  if (!state.connected && !state.token) { $('view-content').replaceChildren(el('div',{class:'error-state'},icon('activity'),el('strong',{},'日志需要本地服务'),el('p',{},'未读取到 usage 会话，不显示虚假日志。'),btn('重新连接',reloadBoard,{icon:'refresh'}))); return; }
  const sessionsPane = el('section',{class:'sessions-pane'},el('div',{class:'logs-section-header'},el('span',{},'记录会话'),el('span',{class:'count'},state.sessions.length),btn('',() => loadUsage(state.selectedSession),{className:'icon-button',icon:'refresh','aria-label':'刷新记录会话'})),el('div',{class:'sessions-list'}));
  const list = sessionsPane.lastElementChild; if (!state.sessions.length) list.append(el('p',{class:'subtle',style:'padding:10px'},'尚无记录会话。开始后，事件会显示在这里。'));
  for (const session of state.sessions) list.append(el('button',{type:'button',class:`session-row${state.selectedSession === session.sessionId ? ' active' : ''}`,onclick:() => loadUsage(session.sessionId)},el('strong',{},sourceLabel(session.source)),el('small',{},session.sessionId || '未提供会话编号'),el('small',{},`${session.build || '未提供构建'} · ${dateLabel(session.startedAt || session.createdAt)}`)));
  const eventsPane = el('section',{class:'events-pane'},el('div',{class:'logs-section-header'},el('span',{},state.selectedSession ? `事件 · ${state.events.length}` : '事件'),el('span',{class:'toolbar-spacer'}),state.logsError && el('span',{class:'form-error'},state.logsError),btn('刷新',() => loadUsage(state.selectedSession),{className:'small-button'})),el('div',{class:'events-list'})); const eventList = eventsPane.lastElementChild;
  if (!state.selectedSession) eventList.append(el('div',{class:'empty-state'},icon('activity'),el('strong',{},'选择或开始一个记录会话'),el('p',{},'日志 trace 会显示时间、动作、任务编号和状态，不包含代码、diff 或自由文本。')));
  else if (!state.events.length) eventList.append(el('div',{class:'empty-state'},icon('activity'),el('strong',{},'该会话尚无事件'),el('p',{},'如果刚开始记录，请执行一次实际操作。')));
  else state.events.forEach(event => eventList.append(el('article',{class:'event-row'},el('time',{},dateLabel(event.timestamp)),el('div',{},el('div',{class:'event-name'},event.actionId || '未命名动作'),el('div',{class:'event-meta'},`${event.taskIds?.length ? event.taskIds.join('、') : '未关联任务'} · ${event.resultCode || '未提供结果'}`)),el('span',{class:`pill ${event.resultCode === 'success' ? 'required-tag' : ''}`},event.state?.phase || '—'))));
  const payload = el('div',{class:'trace-note'},'透明 trace：仅显示后端白名单字段 eventId / sequence / timestamp / scenarioId / taskIds / actionId / resultCode / durationMs / state / counts / errorCode。代码、diff、任务自由文本和证据路径不会进入 usage 事件。',state.usageError && el('span',{class:'form-error'},` 最近错误：${state.usageError}`),state.usageRetry.length && btn(`重试未发送事件（${state.usageRetry.length}）`,retryPendingUsage,{className:'small-button'}));
  eventsPane.append(payload);
  $('view-content').replaceChildren(el('div',{class:'logs-layout'},sessionsPane,eventsPane));
}

function openConflictDialog(conflict) {
  const details = conflict.details || {}; const serverRevision = details.actualRevision ?? details.revision ?? details.currentRevision ?? revisionOf(state.board); const error = el('p',{class:'form-error',role:'alert'});
  const table = el('table',{class:'conflict-table'},el('thead',{},el('tr',{},el('th',{},'待保存草稿命令'),el('th',{},'服务器提示'))),el('tbody',{},el('tr',{},el('td',{},JSON.stringify(conflict.command,null,2)),el('td',{},typeof details === 'string' ? details : JSON.stringify(details,null,2)))));
  const retry = async () => { closeDialog(); state.conflict = null; const payload = await command(conflict.command,{errorTarget:error,success:'已按新版本重试保存',onSuccess:() => { if (conflict.command.type === 'update') state.drafts.delete(conflict.command.id); }}); if (!payload) showNotice(error.textContent || '按新版本重试失败。草稿仍保留。','error',[['重新对比',() => openConflictDialog(conflict)]]); };
  const discard = () => { closeDialog(); state.conflict = null; if (conflict.command.type === 'update') state.drafts.delete(conflict.command.id); showNotice('已保留服务器版本；本页草稿已放弃。'); render(); };
  dialogShell('版本冲突 · 需要人工确认','另一个窗口已修改看板。不会自动覆盖或伪造成功。',el('div',{class:'operation-form'},el('p',{class:'callout warning'},`服务器当前版本：${serverRevision}\n本页提交基于版本：${conflict.revision}\n草稿没有被覆盖。`),table,el('p',{class:'hint'},'先读取最新版本，再决定按新版本重试或放弃草稿。')),error,btn('保留服务器版本',discard,{className:'small-button'}),btn('按新版本重试草稿',retry,{className:'primary-button',mutation:true}));
}
async function exportBoard() {
  try { const response = await request('/api/export',{raw:true}); const url = URL.createObjectURL(await response.blob()); const anchor = el('a',{href:url,download:`qgitgraph-board-${new Date().toISOString().slice(0,10)}.json`}); document.body.append(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url); toast('看板已导出为本地文件。'); emitUsage('board.export'); }
  catch (error) { showNotice(errorMessage(error),'error',[['重试',exportBoard]]); }
}
async function previewImport(content,name) {
  if (content.length > 20 * 1024 * 1024) { showNotice('导入文件超过 20 MB，已拒绝读取。','error'); return; }
  try { const response = await request('/api/import/preview',{method:'POST',body:{content}}); openImportPreviewDialog(content,name,response.preview || response); }
  catch (error) { showNotice(`导入预览失败：${errorMessage(error)}`,'error',[['重试预览',() => previewImport(content,name)]]); }
}
function openImportPreviewDialog(content,name,preview) {
  const valid = preview.valid === true && !(preview.errors?.length); const errors = Array.isArray(preview.errors) ? preview.errors : preview.error ? [preview.error] : []; const summary = preview.summary || {};
  const summaryNode = el('div',{class:'import-summary'},...Object.entries({任务数:summary.tasks ?? summary.taskCount ?? '—',交付包:summary.packs ?? summary.packCount ?? '—',基线行:summary.baselineRows ?? summary.baseline ?? '—',版本:summary.revision ?? '—'}).flatMap(([label,value]) => [el('span',{class:'muted'},label),el('strong',{},String(value))]));
  const errorNode = errors.length ? el('div',{class:'callout danger'},errors.map(error => typeof error === 'string' ? error : `${error.path || '导入数据'}：${error.message || JSON.stringify(error)}`).join('\n')) : null; const error = el('p',{class:'form-error',role:'alert'});
  const commit = async () => { if (!valid) return; const payload = await command({type:'import',content},{errorTarget:error,success:'导入已提交并保存到本机'}); if (payload) { closeDialog(); emitUsage('board.import'); } };
  dialogShell('导入预览',valid ? '确认预览内容无误后再提交。提交需要再次确认。' : '导入内容没有通过预览校验。',el('div',{class:'operation-form'},el('p',{class:'hint'},`文件：${name || '本地 JSON'} · 只使用文件内容预览，不接受任意服务器路径。`),summaryNode,errorNode,el('p',{class:`callout ${valid ? '' : 'warning'}`},valid ? '预览校验通过。确认后会以当前版本号写入本地看板。' : '预览未通过，不能提交。请修正文件后重新选择。')),error,btn('取消',closeDialog,{className:'small-button'}),btn('确认导入',commit,{className:'primary-button',mutation:true,disabled:!valid}));
}
function setTheme(theme,notify=true) {
  const value = theme === 'light' ? 'light' : 'dark'; document.documentElement.dataset.theme = value; localStorage.setItem('qgitgraph-taskboard-theme',value); $('theme-toggle').replaceChildren(icon(value === 'dark' ? 'sun' : 'moon')); $('theme-toggle').setAttribute('aria-label',value === 'dark' ? '切换到浅色主题' : '切换到深色主题'); if (notify) { toast(value === 'dark' ? '已切换到石墨深色主题' : '已切换到暖灰浅色主题'); emitUsage('board.theme'); }
}
function toggleSidebar() { const collapsed = $('sidebar').classList.toggle('collapsed'); $('sidebar-toggle').setAttribute('aria-expanded',!collapsed); $('sidebar-toggle').setAttribute('aria-label',collapsed ? '展开项目导航' : '收起项目导航'); emitUsage('board.sidebar'); }
function bindEvents() {
  hydrateIcons();
  $('project-all').addEventListener('click',() => changeFilter('pack','all')); $('sidebar-toggle').addEventListener('click',toggleSidebar); $('theme-toggle').addEventListener('click',() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('record-control').addEventListener('click',() => state.recording ? openConfirmation('结束记录会话？','结束后事件不会再发送，会话令牌会从内存清除。','结束记录',stopRecording) : openSessionDialog()); $('record-pause').addEventListener('click',togglePauseRecording);
  $('create-button').addEventListener('click',() => openCreateDialog()); $('export-button').addEventListener('click',exportBoard); $('import-button').addEventListener('click',() => $('import-file').click());
  $('import-file').addEventListener('change',async event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { await previewImport(await file.text(),file.name); } catch (error) { showNotice(`读取导入文件失败：${errorMessage(error)}`,'error'); } }); $('reload-button').addEventListener('click',reloadBoard); $('clear-filters').addEventListener('click',resetFilters);
  $('show-baseline').addEventListener('click',() => { state.filters.required = state.filters.required === 'all' ? 'required' : 'all'; updateFilterOptions(); renderSidebar(); renderWorkspace(); emitUsage('board.baseline'); });
  $('search').addEventListener('input',event => { clearTimeout(searchTimer); searchTimer = setTimeout(() => changeFilter('search',event.target.value),120); }); $('search').addEventListener('keydown',event => { if (event.key === 'Escape') { event.target.value = ''; changeFilter('search',''); event.stopPropagation(); } });
  for (const [id,key] of [['priority-filter','priority'],['area-filter','area'],['pack-filter','pack'],['required-filter','required']]) $(id).addEventListener('change',event => changeFilter(key,event.target.value)); $('blocked-filter').addEventListener('change',event => changeFilter('blocked',event.target.checked)); $('archived-filter').addEventListener('change',event => changeFilter('archived',event.target.checked));
  document.querySelectorAll('[data-view]').forEach(tab => tab.addEventListener('click',() => { state.view = tab.dataset.view; renderWorkspace(); if (state.view === 'logs') loadUsage(); emitUsage(`board.view.${state.view}`); })); $('notice-close').addEventListener('click',() => { $('notice').hidden = true; }); $('action-dialog').addEventListener('cancel',event => { event.preventDefault(); closeDialog(); });
  document.addEventListener('keydown',event => { if (event.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) { event.preventDefault(); $('search').focus(); } if (event.key === 'Escape') { if ($('action-dialog').open || $('action-dialog').hasAttribute('open')) closeDialog(); else if (state.selected) closeDrawer(); } });
}
function initialize() { const theme = localStorage.getItem('qgitgraph-taskboard-theme') === 'light' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; bindEvents(); setTheme(theme,false); reloadBoard(); }
if (typeof window !== 'undefined') initialize();

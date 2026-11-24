import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_PATH = fileURLToPath(new URL('../../designs/repository-interactions-vue/FEATURE-COMPARISON.md', import.meta.url));
export const BOARD_PATH = fileURLToPath(new URL('./data/board.json', import.meta.url));
export const SCHEMA_VERSION = 1;
export const BUILD = 'taskboard-1';
export const P0_IDS = [46, 50, 51, 52, 53, 88, 90];
export const P1_IDS = [1, 3, 7, 11, 13, 14, 15, 16, 19, 21, 23, 26, 27, 29, 39, 42, 45, 48, 49, 54, 56, 57, 58, 61, 62, 63, 64, 66, 70, 71, 72, 74, 75, 76, 77, 78, 83, 84, 85, 86, 89, 91, 100];
const PACK_IDS = [[], [52, 100], [45, 46, 48, 49, 50, 51, 53], [1, 3, 89, 90], [7, 13, 14, 15, 16, 19, 91], [21, 23, 26, 27, 29, 39, 42], [54, 56, 57, 58, 66], [61, 62, 63, 64, 84, 85, 86], [11, 70, 71, 72, 74, 83], [75, 76, 77, 78, 88]];
const PACK_TITLES = ['持久看板与使用日志', '预检与运行真值', '本地修改与父子仓语义', '打开、发现与信任', '布局、阅读状态与偏好', '历史、搜索、比较与 Diff', '分支与 Reset', '历史操作生命周期', 'Stash 与 Clean', '远程与同步'];
export const PACKS = PACK_TITLES.map((title, order) => ({ id: `W${order}`, title, order }));
export const hashText = (text) => createHash('sha256').update(text).digest('hex');

export function parseBaseline(text) {
  let area = '';
  const rows = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (/^## [A-G]\./.test(rawLine)) area = rawLine.replace(/^## /, '');
    if (!/^\| \d{2,3} /.test(rawLine)) continue;
    const cells = rawLine.slice(1, -1).split('|').map((cell) => cell.trim());
    if (cells.length !== 7) throw new Error(`Malformed baseline row at line ${index + 1}`);
    const match = cells[0].match(/^(\d+) (?:N )?(.+)$/);
    if (!match) throw new Error(`Malformed baseline ID at line ${index + 1}`);
    rows.push({ id: Number(match[1]), title: match[2], area, sourceLine: index + 1, rawLine, old: cells[1], application: cells[2], sourceStatus: cells[3], gap: cells[4], sourcePriority: cells[5], sourceEvidence: cells[6] });
  }
  if (rows.length !== 100 || rows.some((row, index) => row.id !== index + 1)) throw new Error('Baseline must contain exactly IDs 1..100');
  return rows;
}

const goals = {
  1: '单仓路径输入、校验、取消和新增 mock 仓库；不读磁盘。',
  3: '深度 0–5、进度、取消、失败与重试 fixture；不执行真实扫描。',
  7: '再次点同仓仅切换本地面板；干净仓不展开提交区。',
  11: '保留按稳定 stash ID 的只读文件与 Diff；写操作关联正确 stash，而非通用说明。',
  13: '宽屏本地修改中栏／仓库行内切换，与同仓历史并存；保留草稿与阅读位置。',
  14: '详情 inline／bottom／right、行内上下展开、尺寸和内部消息／树比例可操作。',
  15: '各分隔条约束、稳定顺序、拖动／键盘和刷新后的尺寸保存。',
  16: '宽屏切仓、返回文档和布局切换恢复选择、查询、滚动、草稿、光标／焦点及每提交树状态。',
  19: '重复选中提交可关闭；历史及详情上下键可切相邻提交，输入框不被劫持。',
  21: 'all／HEAD／多 refs／include-exclude glob／命名组实际过滤 mock 历史。',
  23: '已加载过滤和全历史 mock 搜索分离；字段、日期范围、取消及结果真值可操作。',
  26: '选基准／目标或与 HEAD 比较，得到属于两端的文件列表和 Diff。',
  27: '提交／ref 菜单捕获准确目标、比较和 containment；切仓或变更意图后旧菜单失效。',
  29: '多父 merge fixture 与 parent 选择，文件列表和 Diff 基准同步改变。',
  39: 'Alt 历史导航仅在历史 Diff 有效；working 不装历史导航，保护 editable 和 IME。',
  42: 'binary／truncated／loading／error／retry／cancel fixture 明确展示；失败不是无差异。',
  45: '保留三组、同路径混合状态和唯一路径计数；选择按 group+path 唯一定位。',
  46: 'staged=HEAD→INDEX、unstaged=INDEX→WORKTREE；同路径不同组得到不同基准与内容。',
  48: '组全部／全仓全部范围明确，提交前列出本次目标路径；状态变化后不使用旧范围。',
  49: '仅提交 staged，非空校验、按仓草稿与快捷键；列出路径及说明，保留 unstaged，不隐式 push。',
  50: '危险确认只丢弃 tracked unstaged、保留 staged；执行时重新校验仓库、信任、busy 和快照。',
  51: '单个 untracked 精确路径强确认；执行时再验状态、信任和目标，不混同 tracked discard。',
  52: '所有写意图绑定 repo／generation、HEAD／index 快照；确认时重验授权、互斥与当前目标，失败不假成功。',
  53: '子仓提交与父 gitlink 分离；暂存 v1 后子仓变 v2，父提交仍提交暂存的 v1 指针。',
  54: '新建分支 name／target／checkoutAfter 校验并修改 mock refs。',
  56: '本地分支目标、未合并状态和 force 二次确认；取消不删、不能误删当前分支。',
  57: '明确本地 branch／commit 的 checkout 与 detached 状态、dirty／trust／busy 预检。',
  58: '远程 checkout 创建本地 tracking，可自定义本地名；冲突、取消、信任改变均安全阻止。',
  61: 'Merge target、no-ff／squash／noCommit／签名及消息策略；成功、冲突和 follow-up 状态。',
  62: 'Rebase onto／interactive／日期与 merges 参数、外部会话 mock 生命周期；不假装内置 todo 编辑器。',
  63: 'Cherry-pick commit／parents 检查、merge mainline／noCommit／recordOrigin／签名；改目标重检。',
  64: '独立 Revert 入口、commit／mainline／noCommit／签名与恢复语义，不能由 cherry-pick label 代替。',
  66: 'Reset target 与 soft／mixed／hard／keep 独立语义，hard 强确认且不伪造真实磁盘操作。',
  70: '保存 stash message／includeUntracked／includeIgnored；新增实体并按范围移除本地修改。',
  71: '按 selector apply、reinstateIndex；成功不删 stash，冲突保留且展示 operation。',
  72: '独立 pop 流程：成功删除所选 stash，冲突保留，不由 apply 隐式代替。',
  74: '选择明确 stash 并危险确认，取消不删，成功仅删除捕获的目标。',
  75: 'Fetch 指定／全部远程、force／prune／pruneTags 参数、危险确认与 mock 引用变化，不自动合并。',
  76: 'Pull ff-only／merge／rebase 与适用参数过滤，成功／冲突／失败真实状态。',
  77: 'Push remote／local branch／setUpstream／force-with-lease；强确认及非快进／lease 失败 fixture。',
  78: '独立设置上游表单，本地／远程可不同名；无上游同步可完成配置后再同步。',
  83: 'Clean includeIgnored，先 dry-run 展示捕获的候选范围，再独立确认删除；旧预览失效。',
  84: '按当前 operation 继续；仍有 conflicts 时阻止，解决后推进正确操作。',
  85: '中止当前 operation 的独立危险确认；与取消进程／关闭弹窗区分。',
  86: '独立 no-commit／squash follow-up commit，含签名和再次确认，不借普通 staged commit 冒充。',
  88: '同步干净／上游预检，pull→push；dirty／冲突／失败／取消／切仓／撤信任均停止且不 push。',
  89: 'deny 优先、最具体 root、继承／移除／单仓授权的可操作确认；只为 mock 授权非真实安全身份。',
  90: 'filterConfigured／UNTRUSTED_FILTER fixture 阻断未信任本地列表与 Diff，未知不是空仓；真实路径安全仍不接 host。',
  91: '全局／仓库覆盖、继承、仅全局键限制及偏好保存／刷新恢复／失败重试。',
  100: '分组／唯一计数、未知／陈旧／失败与独立消息详情、retry／取消；成功不清无关错误。',
};

function criterion(id, suffix, text, extra = {}) {
  return { id: `${id}-${suffix}`, text, checked: false, scenarioIds: [`${id}-${suffix}`], ...extra };
}
function baseTask(id, title, description, priority, area, pack, required, baselineIds, acceptance, status = 'ready') {
  return { id, title, description, priority, area, pack, required, status, baselineIds, acceptance, dependsOn: [], owner: '', evidence: [], history: [], retrospectives: [], verdict: null };
}
export function createSeed(sourceText, { now = new Date().toISOString() } = {}) {
  const rows = parseBaseline(sourceText);
  const tasks = rows.map((row) => {
    const id = `QG-${String(row.id).padStart(3, '0')}`;
    const required = P0_IDS.includes(row.id) || P1_IDS.includes(row.id);
    const priority = P0_IDS.includes(row.id) ? 'P0' : P1_IDS.includes(row.id) ? 'P1' : 'P2';
    const assignedPack = PACK_IDS.findIndex((ids) => ids.includes(row.id));
    const fallback = row.id <= 12 ? 3 : row.id <= 17 ? 4 : row.id <= 44 ? 5 : row.id <= 53 ? 2 : row.id <= 69 ? 6 : row.id <= 74 ? 8 : row.id <= 88 ? 9 : 4;
    const acceptance = [criterion(id, 'A1', goals[row.id] ?? `核对并保留已有等价行为，后续按需补齐：${row.gap}。原始状态单独保留，不将已有行为重记成未实现。`), criterion(id, 'A2', '宽屏深色与浅色均可达，保留原始表中已等价的行为；错误、取消和边界结果不伪装成功。')];
    if (row.id === 16) acceptance.push(criterion(id, 'NARROW', '窄屏覆盖／返回与窄屏阅读状态', { applicability: 'not-applicable', reason: '本轮仅 wide dark/light；窄屏子标准不适用，非 done，不作为已完成能力。' }));
    const task = baseTask(id, row.title, `原始对照（不是新任务完成判定）：${row.sourceStatus}\n缺口：${row.gap}\n本轮范围：隔离 mock，宽屏 dark/light；真实 Git／磁盘／网络／外部执行不接 host。`, priority, row.area, `W${assignedPack < 0 ? fallback : assignedPack}`, required, [row.id], acceptance, required ? 'ready' : 'todo');
    task.sourceResult = { status: row.sourceStatus, gap: row.gap, priority: row.sourcePriority, existingEquivalent: /等价|增强|布局变化/.test(row.gap), assessment: 'source-only; not task completion' };
    if (required && row.id !== 52) task.dependsOn = [row.id === 100 ? 'QG-USAGE' : [45, 46, 48, 49, 50, 51, 53, 54, 56, 57, 58, 61, 62, 63, 64, 66, 70, 71, 72, 74, 75, 76, 77, 78, 83, 84, 85, 86, 88, 90].includes(row.id) ? 'QG-052' : 'QG-BOARD'];
    return task;
  });
  tasks.unshift(baseTask('QG-BOARD', '持久 HTML 任务看板与 CLI', '本地 loopback 看板、安全存储、CAS、导入导出与 CLI；源码安全承诺不是身份认证。', 'P0', '基础设施', 'W0', true, [], [criterion('QG-BOARD', 'A1', '102 个稳定任务、100 个原始 baseline 可查；API／CLI 写入持久化且 CAS 冲突明确。'), criterion('QG-BOARD', 'A2', '宽屏深浅色 UI 可使用；锁、备份、坏文件／外部修改和导入不会破坏已有状态。')], 'inprogress'), baseTask('QG-USAGE', '有界结构化使用日志与完成验收', '独立 usage JSONL、内存 session capability、白名单事件；userusage 来源声明并非不可伪造的身份。', 'P0', '基础设施', 'W0', true, [], [criterion('QG-USAGE', 'A1', '真实使用会话事件由使用时记录，隐私字段白名单、序列去重、有界容量、可查询且不修改任务。'), criterion('QG-USAGE', 'A2', '仅 assess 可 done；同 build、逐项证据、真实 userusage、完整日志、失败与依赖检查均强制执行。')], 'inprogress'));
  return { metadata: { revision: 0, schemaVersion: SCHEMA_VERSION, build: BUILD, sourceHash: hashText(sourceText), createdAt: now, updatedAt: now }, baseline: { sourcePath: 'designs/repository-interactions-vue/FEATURE-COMPARISON.md', rows }, packs: structuredClone(PACKS), tasks };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const board = createSeed(await readFile(SOURCE_PATH, 'utf8'));
  if (process.argv.includes('--check')) console.log(JSON.stringify({ tasks: board.tasks.length, required: board.tasks.filter((task) => task.required).length, sourceHash: board.metadata.sourceHash }));
  else process.stdout.write(`${JSON.stringify(board, null, 2)}\n`);
}

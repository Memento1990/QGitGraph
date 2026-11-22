# 0.2.1 性能修订执行记录

日期：2026-11-22。目标：以实际`WSL UNC测试仓库`只读验证打开、历史、详情/Diff、搜索、滚动、切换/取消及刷新体验，减少真实耗时与无关等待；不通过缩减功能或隐藏未完成状态达标。

本文是0.2.1本地验证的历史记录，公开版本已匿名化私有路径与状态指纹。原始测量、失败与覆盖范围不变，不作为0.2.2重新执行或通过的证据。

## 来源与环境

- 已安装：`<用户选择的安装目录>\qgitgraph.exe`，版本0.2.0，8,652,288字节，SHA-256 `7077ed13e9bbbc1eb931d53024d0ef7a0122654e595b721022f1ca7e2e93894a`，与0.2.0已验证交付一致。
- 有用户正在运行该安装实例；性能测试另开独立profile，不能按进程名关闭用户实例，也不能用安装测试清理器卸载它。
- 测试项目：`WSL UNC测试仓库`，路径仅示意为`\\wsl.localhost\<distribution>\home\<user>\<repository>`。Windows Git2.47.0.windows.2经UNC访问WSL文件系统，非本地NTFS，也非Linux Git后端。
- WebView2与已验签driver为157.0.4341.60。
- 用户配置及工作目录不复制到公开交付，诊断不记录源码、提交正文、凭据或完整argv。

## 第一轮只读预检（不是统计基准）

`artifacts/performance-preflight-01/test-report.json`：1,210个可达提交，3,675个跟踪文件，178个引用。`GIT_OPTIONAL_LOCKS=0`、禁止交互，不运行网络/写操作，不改safe.directory或信任。

| Windows Git只读操作 | 单次实测 | 说明 |
|---|---:|---|
| version | 123ms | 包含新进程启动 |
| 合并仓库识别 | 184ms | 单rev-parse返回git/common/bare/root |
| HEAD | 276ms | commit解析 |
| status | 6,477ms | 127字节结果；数据少不等于遍历快 |
| refs | 865ms | 全部178引用 |
| 首300历史 | 2,004ms | 仅OID/parents/时间字段，非完整应用结果 |

这些是一次原始Git预检，不等于应用native延迟、p50或p95。前后index与local config指纹一致。正式性能套件将补完整refs/HEAD/status/选定工作文件前后证据；发现外部并发变化只记录，不恢复或覆盖。

## 优化与验收口径

1. 先构建仅计时、算法不变的0.2.0基线。前端使用单调时钟采集输入、IPC、模型/DOM及双rAF绘制机会；Rust分段记录排队、spawn/job/resume、执行/收集、解析等，两个时钟不相减。
2. 使用相同项目、Git配置、提交/文件样本、driver与计时方法比较优化版，主要操作至少20样本；首次/预热/缓存命中分开。WebDriver往返只列外部驱动开销，不称应用耗时。
3. 优先减少重复Git启动、串行status阻挡历史、详情/Diff先取全文、无差别失效、全图/文件树重建、重复skip搜索和丢失/重复刷新。
4. WORKTREE/INDEX不作不可变缓存；snapshot状态指纹不代表内容指纹。root/rename/binary/encoding/mergeparent、输出限制与Job取消不因性能改动被弱化。
5. 所有写回归只用临时fixture；真实项目不fetch/pull、不改refs/index/config/trust，不执行仓库脚本。无遥测、不更改系统Git/Runtime，不自动切Linux Git。
6. 最终同一release程序hash绑定实际项目、原回归、资源及安装。保留0.2.0回滚产物和原始失败记录；0.2.1本地升级保留用户偏好。

## 已安装版观察基线

`installed-baseline-01`使用独立应用profile但相同Windows用户Git配置，真实输入事件→DOM就绪→双rAF绘制机会，非WebDriver往返：20次warm重开中位数约7,588ms，范围7,219–8,249ms。另完成3次refresh、3次分页。这里“warm”仅表示同次会话重复，不声称控制了操作系统/WSL缓存。

该完整套件最终Failed：首个commit样本点击描述单元格中心命中了ref badge按钮，打开引用菜单而非详情，60秒等待超时。截图与27个已测样本保留，不把未运行Diff计为通过。修正仅涉及验收定位，后续改点击明确的纯文本hash单元格，并核对选中OID/文件列表/Diff真实内容。该run前后仓库摘要一致、owned进程残留0；用户原实例未被清理。

`installed-baseline-02`以3样本先验证已修正工具，测量流程完成，但old/new内容模式的trusted change/DOM条件未获可靠证据，整体Blocked。部分后继可选项因盲目Escape关闭详情形成级联；后续工具仅在真实菜单/对话框存在时Escape，并保存不含内容的失败阶段/观察器状态。仓库摘要一致、清理残留0。可选项Blocked不当作所有测量已通过。

## 原生计时基线

仅增加计时、算法未变的0.2.0程序已单独冻结：`artifacts/performance-0.2.1/instrumented-baseline-product/qgitgraph.exe`，8,678,400字节，SHA-256 `6aaad42cae4aca543f0525688e360431aad800d956b4e0966155be07730c4d23`。对应关键源码和构建日志保留，不覆盖正式0.2.0。

`native-baseline-01`首个冷提交已实际观察到17次Git（详情8次、首个文件Diff9次）：文件列表约5.26秒、Diff绘制机会约9.94秒。每次Git的`resume`阶段约130–175ms（全系统线程快照），明显高于spawn约8–40ms及Job绑定通常数毫秒。这里只是首样本与阶段归因，完整20样本统计完成后再汇总。

原生`git`阶段代表单进程总耗时；其queue/spawn/job/resume/execution/drain为嵌套分段，不能把所有span时长相加当端到端或CPU。Open IPC没有外部requestId，correlated native子进程只覆盖snapshot/history，不把该局部计数当成完整open进程数。

## 已完成实现与局部回归（尚非最终交付验收）

- Git读路径已落地：历史patch首显3次Git（不读两侧blob），单侧内容4次且只读目标侧，兼容完整Diff从9次减为6次；fast详情从8次减为4次，legacy装饰语义保留；snapshot从5次减为4次并在完整request scope内并发独立部分。11项真实read-performance测试、23项legacy integration、5项operations_extra、11项parser测试实际通过，包含missing对侧blob、binary rename、marker文字、ROOT、merge、encoding和限制。
- 手工搜索改500→2000→8000→32000→剩余额度，自适应大输出失败在同一offset回退500；7项history-performance真实测试通过（包括100k cap及输出回退），没有改hash子串/scope语义或缓存可变祖先。
- Runner建立multi-PID观察与共同request scope、可取消CPU检查点、Git版本身份缓存、合并仓库识别、watch错误去重；4项runner-performance真实测试通过，含6个并发槽及排队取消、独立PID退出/清理。
- App/Table已实现历史/元数据并行首屏、先恢复视口后加载详情、无整页空白的刷新、dirty重检与取消意图、图布局复用/可见行节点复用、滚动保存节流。28项对应纯/实际组件fake-DOM回归及tsc通过；还需真实WebView验收。
- Details/DiffView已实现patch优先、old/new懒加载、请求复用/取消/迟到保护、按对象身份有界解析缓存、线性文件树与大列表虚拟化、明确unknown工作区。17项实际Pane事件/状态fake-DOM回归及tsc通过；没有为尚未取得的大文件CPU测量宣称Worker优化已完成。
- Windows documented CreateProcessW原生启动器已集成，保留`PROCESS_INFORMATION.hThread`，从挂起创建、Job绑定后恢复精确线程，不再枚举全系统线程。81项Rust单元、8项host真实进程/签名、11项read、4项runner及3项新原生启动器实际通过；无缓存本地Git启动另行显式执行30个warm样本，p50约103ms/p95约129ms（包含真实Git启动，不是单纯ResumeThread，也非UNC性能）。非Windows保留既有runner，无nightly/未公开API；Win10环境仍未实测。

## 当前状态

`native-baseline-01`128个有效测量样本已完成，但最后all-ref摘要发生无法归因的变化（仅refs digest变），严格A/B基线作废、不恢复项目。已保留诊断数据和错误边界。

`native-baseline-02`完成131个实际样本且前后完整性全部一致，主要场景各20样本可作对照；整套仍Blocked，原因old/new视图观察器未捕获trusted change（实际模式已切换、无loading/错误）、原生取消ack不可得。没有把整套改为Passed。固定commit/parent/file私有计划SHA-256为`<本地私有计划指纹，未公开>`，只存本地，优化版重用，不含项目文件内容。

| 原版native主要场景 | 样本 | p50 | p95 |
|---|---:|---:|---:|
| warm重开到完整绘制机会 | 20 | 12,960ms | 13,294ms |
| 首个冷提交文件列表 | 20 | 4,302ms | 4,947ms |
| 冷提交首个Diff | 20 | 8,284ms | 9,189ms |
| 首次显式切换文件 | 20 | 3,957ms | 4,118ms |
| 缓存提交重访 | 20 | 13.4ms | 17.7ms |

该轮warm打开的工作区遍历比之前已安装版观察基线更慢（约13秒 vs 7.6秒），表明UNC/宿主缓存和系统负载会波动；不挑最快/最慢跨轮拼接成绩。对比优化版时保留相同计时方法与固定样本，旧轮数值不隐藏。缓存重访原来已经快，不宣称它有巨幅提升。

首个完整0.2.1烟测`optimized-smoke-01`已完成52个真实测量（3样本主要场景），项目前后摘要一致、清理残留0，仅原生取消ack另列Blocked。冷提交首Diff约1.995/2.364/2.728秒，Git总调用实测7次（原版17次）；选择反馈约8.5/12.1/31.1ms。首个历史约2.8–3.0秒即可浏览，完整状态仍约7.4秒，其中status单进程约6.5秒为真实UNC成本。原生恢复线程阶段约0.005ms，已不进行全系统线程快照。

修正observer为真实select点击→option点击后，old/new内容均实测成功：首次按需约1.19秒，缓存重复约20–31ms；Diff滚动观察约33–42ms。冷/热内容混合3样本不合并宣称内容p95已达150ms。所有数字为烟测，不作为最终20样本发布对照。

最后针对显式刷新再并行历史与metadata，并补2项deferred回归（当前前端126项）。最终发布程序已构建并冻结，exe SHA-256 `ab146da09b052098a9021d3df0fc946e69b565a5702aa2371757989389b2af67`，安装器`8b470ecfc775053a3fda5bf239643f4c5ded46857b9381d7aa65d7149173a609`，正常bundle禁用二次patch，二者将验证同一原样exe。

## 最终20样本同项目对照

`optimized-final-02`（审阅fast-path修复后的实际交付SHA）完成137个测量，固定计划与`native-baseline-02`一致；两个run的完整性均为`unchanged-within-stated-coverage`，Git配置/HOME身份一致，清理残留0。脚本`compare-performance.mjs`从实际报告计算并拒绝样本/配置/完整性不匹配；输出`performance-comparison-optimized-final-02.json`。性能套件整体仍Blocked（仅剩原生取消ack），与“主要可比较指标有效”分开，不改写Passed。之前`optimized-final-01`与`performance-comparison.json`作为pre-review-fix历史保留，不作为当前程序成绩。

| 场景 | n | 原版p50 | 0.2.1 p50 | 0.2.1 p95 | p50变化 |
|---|---:|---:|---:|---:|---:|
| 提交图可浏览（真实输入→实际行→绘制机会） | 20 | 12,995ms | 2,716ms | 2,866ms | 减少79.1% |
| 全部打开metadata完成（native） | 20 | 12,960ms | 7,094ms | 7,232ms | 减少45.3% |
| 冷提交文件列表 | 20 | 4,302ms | 1,125ms | 1,524ms | 减少73.8% |
| 冷提交首Diff | 20 | 8,284ms | 2,065ms | 2,477ms | 减少75.1% |
| 文件切换Diff | 20 | 3,957ms | 948ms | 1,001ms | 减少76.1% |
| 缓存提交重访 | 20 | 13.4ms | 15.65ms | 35.4ms | 增加2.25ms，未掩饰 |
| 缓存文件重访 | 20 | 12.35ms | 6.35ms | 28.8ms | 减少6ms，本来已快 |
| 完整刷新 | 3 | 10,599ms | 6,148ms | 6,172ms | 减少42.0%，小样本 |
| 历史hash搜索 | 3 | 3,962ms | 2,089ms | 2,134ms | 减少47.3%，小样本 |

选择立即反馈phase的p95约17.1ms，低于100ms响应目标；旧版无相同phase，不能填0算加速。缓存重访p95低于150ms，但旧版也已达标，不能宣称普遍倍速；完整打开、刷新、搜索尚未一律达到50%改善，残余主要是实际UNC工作区遍历，明示未达项目。

顺序单机对照不是随机化或强控制变量实验，不消除OS/WSL缓存/负载差异；首次/预热只按应用会话定义，不称冷磁盘。双rAF只表示绘制机会，Rust各阶段嵌套时间不相加作端到端。具体old/new首次内容与缓存内容、菜单/滚动/resize的最终绝对指标独立保留，不将缺失基线当0，也不把3样本p95称统计稳定尾延迟。

功能parity、资源、实际安装升级及最后ZIP校验继续按最终同一exe独立验收，不以性能结果代替。

## 真实桌面回归发现并修复的边界

初轮`desktop-final`已有12项通过，但review自动已读检查失败：Start review后点击同一个已成功显示的文件，新same-ready快速返回未执行自动已读。截图证实内容正常但review计数未变。这是产品回归，不归咎验收脚本；已在fast path恢复immutability/active-review门禁后的成功显示标记，新增能重现先失败、修复后通过的Pane测试，仍不重发Git或读取全文。前端最终测试数变为127，原断言未放宽。

因此`ab146da0…2af67`已验证的性能程序保留为pre-review-fix记录，但不作为最终交付exe；修复后新程序SHA为`256648cb90341f38fdc58e9915444494b12d1a704bb16dd97f9ab4e5ef58e55b`，安装器为`c212ee3f30cc0f90315b23fe84ac1a7a518ca1c40278fa9dd48b9f7ee1227b6d`。`desktop-final-02`16项真实parity全部通过（包括原失败review），完整仓库不变、清理0。前端127、Rust单元81、Git/host集成85，合计293项实际通过；额外可选启动计时benchmark已显式执行，默认ignored状态不重复算覆盖率。升级脚本第一次InspectOnly因PowerShell5参数默认值中`$PSScriptRoot`尚未初始化而失败，未创建输出或关闭窗口；修复后独立`upgrade-inspect`预检通过，用户窗口仍运行，没有执行安装。

最终交付程序`256648cb…58e55b`已完成`optimized-final-02`137个测量、`desktop-final-02`16项parity及`resources-final`，均绑定同一exe；旧哈希报告保持历史，不与新程序混用。

## 最终资源与轻量回归

`resources-final`以默认关闭性能诊断的最终程序运行固定新fixture，72.099秒空闲、4个系统快照。应用+全部WebView2 Private Bytes p50为254,730,240字节（242.93MiB），Working Set简单求和p50为478,605,312字节（456.43MiB，含共享页重复计数）；输入法/系统broker与driver另列。CPU计数器增量0.171875秒/55.333秒实际观测窗口，即约单核0.311%，非将整个idle时间混作分母。清理残留0，仓库不变。

相对0.2.0同类单机报告（240.57MiB）Private约+1%，exe从8,652,288到8,789,504字节（+1.59%），安装器从2,454,806到2,488,391字节（+1.37%），没有触发20%轻量回归阈值。测量仍仅一台机器/4快照，不包装成实验室内存认证。

资源工具另测固定小fixture完整刷新3次WebDriver墙钟p50约1,021ms，包含自动化往返，不能混入WSL UNC测试仓库 native端到端对照。无Node/Chromium/Git捆绑，无新增npm生产依赖；新增Win32 feature不引入新crate。

## 本地用户安装升级

`upgrade-final`实际完成0.2.0→0.2.1原目录升级：注册表保持原HKCU key与`<用户选择的安装目录>`，839个安装文件、836项notice/source ownership逐文件及5份MPL原档案校验通过，无测试probe。最终安装exe SHA为`256648cb…58e55b`，与parity/性能/资源测量程序一致。

旧窗口PID+精确创建时间+exe路径及唯一Tauri Window匹配后仅发送WM_CLOSE，正常退出，不force/kill。完整旧安装和用户配置字节备份在仅本地`artifacts/performance-0.2.1/upgrade-final/`；从关闭前、关闭后、安装前、安装后到最后，state SHA始终`<本地state指纹，未公开>`，未改trust/偏好/recents，未自动restore或降级。

实际已安装路径另以独立profile只读启动验收：`installed-upgraded-smoke`52个测量完成，前后项目摘要一致、清理0，仅原生取消ack明确Blocked。真实用户state指纹仍与升级前一致，测试没有覆盖它。Installer门禁的证据严格标明**已有用户安装升级**，不冒充全新安装/卸载或干净VM验证；原安装不被测试卸载器删除。启动后的自然视图持久化与安装期间字节保持是不同阶段，各自留证。

ZIP staging仍需最后实际报告，不以升级成功代替。

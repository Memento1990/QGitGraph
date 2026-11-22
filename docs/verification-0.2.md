# 0.2.0 验证记录

日期：2026-11-21。基准与例外见 [parity-spec-0.2.md](parity-spec-0.2.md)。以下将实现、自动化与特定环境验收分开；失败记录不覆盖。

## 自动化基线与新增回归

- 前端最终 Vitest：71通过、0失败，涵盖旧22项及消息/emoji/PR/设置迁移/审阅/菜单表单/导航/Inline几何等新增测试。
- Rust单元：53通过（含新增schema、runner、环境、watcher/path/state持久化回归）；原安全用例保留。
- 旧真实Git集成23项 + operations_extra5项通过。
- 多ref/分页/标签/stash/contains/submodule/裸仓9项通过。
- 操作参数及新动作15项通过：受控prune、pruneTags、fetchinto、tracking checkout、lease远端删除、tagtype/pushpartial、stashindex与失败保留、mainline/rebase recovery/保merge等。
- Host真实测试8项通过，没有SSH缺失跳过：真实ed25519 commit/tag验签、无key/信任/篡改/unsigned；实际Git+helper+两代子进程取消；32MiB边界/超限；stdin/argv/cwd及case-insensitive环境净化。

最终发布只计实际报告与原始日志中的数字，测试helper binary不随产品打包。前端记录位于`artifacts/v0.2/final-tests/`；Rust最终原始日志位于`final-tests-host-tests-02/`，显式启用`host-tests`和`--nocapture`，真实SSH测试缺少`ssh-keygen`时明确失败，不能无声提前return计通过。

## 严格隔离真实桌面

`--profile-dir=ABS`现在同时隔离state和WebView2数据，并通过diagnostics.configDirectory与DOM仓库path/HEAD核对。测试Git使用run内部HOME/config/hooks/template，所有refs全新且实际经过UI创建，不再skip-existing记录假成功。写操作前后核对HEAD、index、porcelain、tracked/untracked内容和refs。

- `desktop-06`：首次严格隔离基线通过（创建/删除branch和附注tag、真实history/Diff/filter/settings/Escape焦点）；完整仓库不变断言通过，退出后受控进程残留0。
- `desktop-parity-01`：基线+新增功能共16个检查通过：真实Inline插槽360px、审阅start/自动已读/end及mutable禁用、实际tagger/完整annotation、glob范围限制/恢复all、设置保存和安全Markdown/emoji/HTTP链接DOM结果。它不是所有原生/provider环境的代替证据。
- Native文件夹选择及取消已实测：Unicode路径打开正确HEAD，取消不改仓库（`native-03/04/05`前两项）；导出控件为现代Save dialog嵌套Edit 1001，区别于Folder dialog 1152，后续完整结果单列。

## 真实外部控制台

- `console-02`：真正运行外部交互式Git console及Git编辑器策略，成功返回completed/exit0；冲突返回paused/operation=rebase/exit1，Git状态保留且可abort。启动不等于完成。
- 同run的 `terminal-result.json`：附加到本次owned console的真实输入句柄，输入PowerShell命令输出正确仓库cwd并exit，进程正常退出0。
- 首轮console测试因隔离HOME屏蔽用户GIT_EDITOR，缺失明确local sequence.editor而进入vi超时；修正测试仓库local配置后复验成功，未更改用户editor。

## 实际修复与失败证据

- 原基线remote URL预检新增临时remote时get-url不识别，改用无网络`ls-remote --get-url`与原始NUL配置/rewrite预检；真实远程基线恢复通过。
- `--refmap=`配合pruneTags没有删掉local-only tag，显式tags refspec修复，真实回归保留严格断言后通过。
- desktop-01 Git -C超MAX_PATH初始化失败：改shortroot+longtracked path独立fixture，后续创建通过，未更改系统LongPathsEnabled。
- desktop-02 driver157输出名称由MSEdgeDriver变Microsoft Edge WebDriver：保持Microsoft有效签名和完整版本校验，兼容官方名称。
- desktop-03 ownership并发写Windows EPERM：文件级串行Promisechain、snapshot/monitor不重入、有界原子rename重试；20项工具纯测试通过。
- desktop-04 `--profile-dir path`经driver转开关格式造成profile不生效：支持等号形式并明确WebView2userDataFolder，严格profile核对保留。
- desktop-05隔离HOME被Rust canonicalize成`\\?\`前缀令Git配置读取失败：A/B实际证实native/forward路径成功、extended失败，验证后仅为外部Git环境去掉前缀。
- 多轮原生导出自动化失败都保留，不能据UI按钮存在称成功；观察实际UIAutomation结构后采用现代SaveDialog Edit控件。

## 平台与外部环境阻塞

本机为Windows11 Pro 10.0.26300、Git2.47、WebView2/driver157。Hyper-V服务可见但Get-VM权限不足；未在真实Win10/干净VM/多屏DPI跑通。无用户生产账号或证书：HTTPS/GCM/SSO、真实SSH agent服务端、GPG/X.509及Authenticode/SmartScreen不以临时SSH测试冒充。

不在宿主卸载或重命名Git/WebView2，不更改全局safe.directory/TLS/host-key/longpath策略，不自动公开发布。

## 轻量与交付

继续只有系统WebView2+Rust+原生TS/CSS，不带Node/Chromium/Git，无大UI/Markdown框架，无CDN/网络字体/默认头像/遥测。新增源码字典和类型设置让前端JS增大，但依然单个小静态客户端；最终包体与全进程内存必须实测，不用宿主小数字替代WebView2开销。

## 最终固定release验收与轻量实测

- 自动化原始报告：前端71、Rust单元53、真实Git集成60，合计184项通过，旧84项的安全意图与原用例保留（合法remote grammar更新不弱化注入保护）。
- `release-final`：Tauri未指定bundle标记的构建真实桌面parity套件16检查通过；`release-payload-final`再次对实际NSIS安装后的原样程序运行16项并通过，包含唯一ref实际创建/删除与全部仓库事实不变、Inline/review/tag/glob/消息；cleanup均无残留。最终交付采用后者的`7077ed13…e93894a`，不混用不同SHA的证据。
- `native-06`三个原生用例通过；历史`release-native-01/02`为选择/取消/export通过、剪贴板失败。修正报告逻辑后`native-payload-final`对最终程序复验：三个原生用例通过、剪贴板因当前host共享OLE访问不可用而明确Blocked，整体退出码2；失败历史保留。未成功保存用户剪贴板前不执行copy、不清空或覆盖其内容。
- `console-02`真实外部Git生命周期与真terminal输入/cwd/退出通过；editor和具体difftool GUI仍需各自工具环境，不用argv构造代替启动。
- 实测安装器2,454,806字节（约2.34MiB），exe8,652,288字节（约8.25MiB）；较0.1.0分别增长约9.68%/10.78%。`install-final-03`真实安装树839文件/12,425,083字节，836项notice清单及5份MPL源码归档逐项校验通过，host-tests探针数量0；卸载后安装目录、注册表与快捷方式均不存在，owned进程残留0。
- 首轮`install-final`卸载器瞬时退出令CIM身份查询竞态，报告保留为失败；`install-process-02`新增立即成功、立即非零、可观测进程3项回归通过。保留进程句柄的精确创建时间/退出码，不按进程名清理。
- Tauri NSIS打包将exe的安装类型标记`__TAURI_BUNDLE_TYPE_VAR_UNK`改为`…NSS`，仅3字节变化，但SHA不同。通过真实安装保留原样payload，桌面/资源/解压运行包统一它；没有放宽同SHA门禁或手工重写标记。
- `large-history-final`补充fixture首次fast-import因附注tag数据后多余空行失败，20k提交已导入但桌面未启动；该run明确Failed、进程清理残留0。修复仅涉及验收脚本协议终止，不以fixture创建失败冒充产品大历史测试通过。
- `large-history-final-02`实际20k仓库已完成首300、追加到400/500及merge/ref断言，但搜索前验收脚本内嵌selector字符串引号无效而失败；搜索未运行不算通过。修复仅将selector作为WebDriver参数传入，不改产品或放松断言；完整run另留新目录。
- 历史`resources-clean`严格隔离固定小仓库，真实DOM刷新3样本p50约3,979ms、p95约4,599ms，包含WebDriver往返，不是纯算法/冷启动延迟；最终payload重新测量的结果另列。
- 历史`resources-clean`65.0秒空闲采样仅3个昂贵CIM快照：应用+全部WebView2 Private Bytes p50约242.53MiB，Working Set简单求和p50约457.35MiB（共享页重复计数）。约0.094秒CPU增量实际只覆盖首末快照间约46.2秒，原报告以65秒作分母偏低，不能引用为完整空闲CPU均值。新版记录明确`cpuWindowSeconds`及不可观测区间；最终以重测报告为准。输入法/系统broker与driver另列，不算应用专有内存也不隐瞒。
- 首轮性能报告把输入法SGTool/conhost也归入后代，导致总Private约312MiB与CPU虚高；修分类后保留旧报告并重新测，未用删进程方式降低结果。

## 最终payload资源测量

`resources-payload-final`对`7077ed13…e93894a`原样exe及`662e2cdc…9678fd`安装器测量通过，仓库不变、退出后owned进程残留0，采样未发现Git常驻。固定全新小fixture，单次warm run：

| 指标 | 实际值 | 口径 |
|---|---|---|
| 空闲 | 75.775秒，5个快照 | 目标≥65秒，昂贵系统快照使总时长略长；不是高频实验室采样 |
| Private Bytes p50 | 252,252,160字节，约240.57MiB | 应用及全部观测到的WebView2子进程；输入法/系统broker/driver分开列出 |
| Working Set p50 | 476,205,056字节，约454.14MiB | 简单求和会重复计算共享页，不等同专有物理占用 |
| CPU | 0.1875CPU秒 / 61.512秒观测窗口，约单核0.305% | 首末快照之间的计数器差；首快照前及离场进程最后快照后的CPU不可见 |
| 刷新p50 / p95 | 3,705.80 / 3,846.93ms | 3个真实DOM/task-sequence样本，包含WebDriver往返，不是纯Git或算法时间 |

exe/安装器相对0.1.0增长10.78%/9.68%，Private约从223MiB到240.57MiB（约+7.9%，单机运行存在波动，不是控制变量严格基准）；小包体不代表总运行内存只有宿主几MiB。没有为了降低数据而卸载Runtime、关闭用户进程或移除共享依赖。

## 两万真实提交的补充验收

`large-history-final-03`通过，绑定同一`7077ed13…e93894a`程序。临时仓库有20,000个真实提交、4个真正分叉的双父merge、8个branch/tag refs，Git数据约6.28MiB；不是庞大文件/超多refs/百万提交综合压测。退出并清理owned进程后，HEAD、index、porcelain、全部tracked/untracked内容、refs和仓库local config均与事前一致，残留0。

- 实际首屏加载300，再显式追加100至400/500；首尾OID、subject、虚拟行位置、真实merge与ref badge核对Git结果。
- 两个已知目标在当前loaded页中均无结果（negative control），切换Search history后准确返回单个message/hash目标；目标真实history index分别17,501/15,000，最后恢复正常300条页面。
- 单次WebDriver+实际task/DOM测时：首300约5,674ms，追加两页约2,804/2,883ms，message搜索约2,335ms，hash搜索约14,890ms。包括driver/轮询/渲染/分页滚动，并非纯Git；尤其hash搜索仍有优化空间，不宣称瞬时或生产规模性能。
- GUI取消只在请求进行中短暂出现，当前UI没有原生取消完成确认；该补充用例明确`optionalblocked`，未注入假延迟或host调用制造成功。真实进程取消/32MiB超限及helper子孙清理仍由host集成测试证明，但不冒充本大历史GUI取消通过。
- 前两轮仅验收工具错误的失败证据保留；成功run不覆盖它们。

最终证据索引选择 `artifacts/v0.2/final-tests/frontend.json`、`final-tests-host-tests-02/`、`release-payload-final/`、`resources-payload-final/`、`install-final-03/`。原生补充结果见`native-payload-final/`，大历史补充结果见`large-history-final-03/`。旧run原始报告保留，不改写成最终程序成绩；最终校验值来自对应manifest。0.1.0交付物保持不变。

# 安全模型：0.3.0 Vue 迁移候选（未发布）

QGitGraph 是本地 Git 客户端，不是恶意仓库沙箱。当前正式前端为 Vue 3 / Reka UI / shadcn-vue，业务通过类型化 Tauri IPC 调用 Rust Host；没有通用 HTTP 或 shell bridge。本文说明当前实现边界，不代表候选已发布或所有安全/环境验收已通过。最新已确认公开稳定版仍为 v0.2.2。

## 原生信任与授权 epoch

- 信任规则由 Rust 保存于当前 profile 的独立 `native-trust.json`，不是 renderer `state.json` 中可任意写回的授权字段。普通保存、共享配置导入与前端伪造的 `trusted` / epoch 不能授予执行权限。
- 支持显式目录授权，以及单仓库允许、拒绝、继承和移除；选择/扫描目录本身不授予信任。规则绑定原生规范路径与文件系统身份，仓库规则另绑定 Git 管理目录身份，不能仅凭相同路径文字继承授权。
- 原生保存成功后才更新规则；规则损坏时要求重新授权，不恢复旧前端授权。兼容旧逐仓信任只在缺少原生文件的本机启动阶段执行一次，且须重新验证身份；普通 state 保存/导入不走迁移。
- 请求绑定原生仓库身份和授权 epoch，执行前复核。信任撤销或身份改变使旧 epoch 请求失效/取消；不能让旧队列在重新授权后继续执行，也不因共享 common Git 目录而取消其他 worktree 的授权请求。
- 写入、网络 Git、外部工具和显式签名验证需要信任。撤销不是 Git 事务回滚，也不会强杀已经交给用户的外部 console；已发生的修改需按真实 Git 状态处理。

## Git 与进程边界

- 只读浏览使用类型化命令和可信绝对 Git 路径，不经 shell 展开参数；外部 Diff、textconv 与 fsmonitor 默认禁用，不自动扩展 `safe.directory`。
- 未信任仓库的 status/工作区 Diff 先检查有效 Git filter 配置（含 include）；可能执行内容转换时返回 `UNTRUSTED_FILTER`，不以禁用转换器的结果冒充准确状态。该预检不是抵御外部并发改配置的原子沙箱；hooks/helpers/filter/verifier 仍是 Git 的执行风险。
- Windows 后台 Git 以受限标准句柄挂起创建，加入 kill-on-close Job 后通过保留的主线程句柄恢复；不重新枚举 PID/线程。取消与输出上限回收所拥有的进程树及有界 pipe workers。异步 Drop 不能同步等待所有 worker；显式等待完成/取消负责回收。
- linked worktree 操作按 common Git 目录排队，等待中的请求也支持取消；提前到达的取消由有界 tombstone 处理。
- 暂存、取消暂存、丢弃和删除使用有界仓库相对路径及 literal pathspec，不开放任意 argv 或递归文件写接口。丢弃限于明确未暂存内容；未跟踪删除要求单文件确认与身份复核。普通提交绑定 HEAD/索引快照，只提交已有索引；同步按明确上游先 pull，失败、冲突或取消后不继续 push。
- Git 写入不是事务，不承诺自动丢弃、删 lock、回滚或冲突恢复。外部交互式 rebase 使用独立认证的 loopback console 会话，区分 started/running/paused/failed/completed；启动不等于成功，主窗口关闭不静默终止用户会话。该专用会话不是 renderer 可用的通用命令桥。

## 前端与本地 Host

- 仅随包主页面获得明确业务权限，不向任意远端 origin 暴露 IPC；没有任意可执行文件、shell 命令或文件读写 API。
- CSP 的 `connect-src` 仅允许 Tauri IPC（`ipc:` / `http://ipc.localhost`），不允许 renderer 发起任意 HTTP 或连接本机看板。`http://ipc.localhost` / `http://asset.localhost` 是 Tauri 内部传输/资源边界，不是通用本机 HTTP 接口；图片另有明确的资源与可选 Gravatar 来源。
- 页面导航和新窗口受限；仓库文字按安全文本渲染，不执行仓库 HTML。受限 inline Markdown 有工作量/深度/token 上限，issue 匹配是有限规则，不是任意用户正则。普通链接仅接受无凭据 HTTP(S)，点击后才打开。
- 外部工具使用校验过的绝对 exe 路径及有限占位符的参数数组，不使用任意 shell 命令字符串。工作文件规范包含检查与历史只读快照导出是不同操作。

## 目录发现、激活与状态

- 目录发现仅做文件系统结构扫描，不启动 Git、不克隆、不授信、不写最近仓库；深度、条目、访问/排队目录、候选、输出和时间预算均有界。可见候选摘要是另一路有界只读 Git 请求，不激活仓库、不安装非活动 watcher、不自动 fetch；未信任候选只读 branch/HEAD，其他计数保持未知。
- 规范包含、链接/reparse 处理及候选重验防止旧节点静默打开其他仓库。合法 `.git` 文件可指向范围外的管理目录，但扫描不递归进入该目标；发现的子节点不跟随链接越出范围。
- UNC 阻塞调用仅能在文件系统调用之间协作取消，不能承诺硬中断；真实 worker 退出前保留 request/singleflight 所有权。
- 原生激活代际与前端请求代际拒绝旧结果；成功验证后才替换 watcher，失败/取消保留原有效 watcher。关闭仓库不删文件、信任或视图，也不终止用户外部会话。
- 状态来自当前快照。未知、加载中、陈旧和 bare 无工作区不显示为新验证的干净状态；ahead/behind 来自本地跟踪引用，不触发 fetch。暂存与未暂存路径可重叠，不能直接相加。

## 环境与凭据

- 大小写不敏感地移除 Git 路由/config/index/object 覆盖变量；可信操作仅保留明确认证/编辑器环境白名单，只读操作不因此获得权限。
- Windows 继承的隐藏环境条目与应用显式 set/remove 分开验证；系统条目不当作应用变量名，不清空整个环境或回退 shell。Unicode、ordinal 覆盖、双 NUL 序列化与句柄边界保持约束。
- GCM、SSH agent、GPG/X.509 由用户管理，不新增密码/私钥库，不关闭 TLS 或 SSH host-key 验证。远端 URL 中的密码/令牌由操作预检拒绝，输出脱敏。
- 签名存在不等于有效；普通浏览不自动执行 verifier，显式可信验签报告真实结果。创建签名默认遵循 Git 配置，不承诺当前候选已完成真实 provider/PKI 认证。

## 状态、分享与可选本地记录

- 偏好包含本机路径、布局、视图和审阅元数据，不保存文件正文或密码；按 schema/大小校验并原子写入，损坏旧 state 保留诊断备份。原生信任文件、profile、备份均属于本机私有数据，不公开分发。
- 全局 Git 路径和语言不受仓库或共享配置静默覆盖；导航只保存有界偏好，不保存发现快照。新 profile 默认右侧详情，已有显式布局偏好不强写。语言在设置中切换，不改写提交/代码/路径或重新发起 Git/更新请求。
- 分享仅允许可预览的显示/工作流设置；不导入可执行路径/参数、头像同意、信任、凭据、最近仓库或审阅。
- 持久审阅针对不可变完整提交 ID；WORKTREE/INDEX 不保存为不可变已读结果。Diff 与侧内容缓存有条目/字节上限，元数据指纹不等于工作文件未变，mutable 内容使用独立 dirty generation。
- **usage 默认关闭，须显式同意并开始**，只写入 Rust 选定 profile 的 `usage/` 有界本机日志；支持暂停/继续/停止，重启不自动恢复。容量满或写入失败明确报告，不偷偷删旧日志、自动补记或声称已保存。
- usage 只接受白名单标识、计数、枚举状态、时长和错误类别，不记录代码、Diff 正文、提交说明、自由输入、凭据或真实私有路径；仓库关联使用匿名 ID。没有任意日志路径参数，不联网、不上传，也不要求运行任务看板。
- usage 关联 `appVersion`、编译期 `sourceBuild` / `sourceBuildReliable` 和运行时计算的 `exeSha256`；程序哈希不是签名或可信来源证明，development/unknown 来源不冒充可靠冻结构建。`userusage`、`assistant`、`automated-test` 保留真实来源，导入本机看板不自动代表验收完成。
- 性能诊断是另一个默认关闭的启动 opt-in（`--performance` 或 `QGITGRAPH_PERF=1`），有界内存记录操作标识、白名单 Git 动词、耗时/计数/结果，不记录参数、输出或路径；诊断接口只能读取/清空指标，不能执行命令。
- 头像默认关闭，启用后向 Gravatar 发送作者邮箱哈希和网络元数据；哈希不等于匿名。

## 手动更新与网络

- 只在设置中的明确点击后检查更新；启动、打开设置与浏览仓库不自动检查，也不授予/需要仓库信任。
- 无参数业务命令只通过系统 WinHTTP 请求固定的 `https://api.github.com/repos/Memento1990/QGitGraph/releases/latest`。不发送仓库内容、路径、Git 身份、账户令牌或 state；GitHub 会收到正常 IP/TLS 元数据及版本 User-Agent。renderer CSP 不因此开放 HTTP。
- 保持 TLS 证书/主机名验证；关闭自动认证、cookie 与重定向，代理失败明确报告而不绕过。句柄 RAII 回收、响应/说明有上限，真实阻塞 worker 保留 singleflight；分阶段超时及总时限检查不等于硬取消已阻塞调用。
- 仅接受同仓库 canonical stable SemVer Release。draft/prerelease、畸形元数据、其他主机/仓库、含凭据/query/fragment 的 URL、限流和超大响应不变成“已是最新”；404 代表没有可访问的 latest，不代表无需更新。
- 发布说明是非可信纯文本，第二次主动点击才打开校验后的官方页；不下载、执行、安装资产，不是签名验证自更新器。

## 验证、安装与公开分发

- native 测试隔离 run-owned profile、WebView2、Git HOME/config、refs 和新建本机 bare remote，不回退用户 APPDATA；只按 PID、创建时间及 run 所有权清理进程，不把系统输入/辅助 broker 当作应用子树。
- Vue 候选真实桌面套件尚未全绿，`git clean` 原生预览与新增专项测试仍在补齐，不能预先标为通过；浏览器/原型与旧版本结果不作当前 native 验收证据。真实 WSL 性能、Win10、干净 VM、DPI/读屏器、provider/PKI 仍需对应授权环境。
- 相同 product identifier 的 currentUser 安装共享注册项与快捷方式。仅更换 `/D` 安装目录或 `--profile-dir` 不能隔离新装/升级/卸载；已有同产品安装会阻断相应测试。静态解包、版本、notice 与哈希检查不证明生命周期通过，本轮尚未完成安装/升级验证。
- 无遥测、账号、默认后台同步或自动发布；测试 probe/临时密钥不随产品分发。候选未配置 Authenticode 签名，不承诺消除 SmartScreen 警告。
- 原始 `artifacts/`、usage/性能日志、截图、真实路径、profile、备份及 `release/` 资产保持本机私有，不入仓库或公开附件；可公开摘要也不得含个人数据。
- 自有代码采用 MIT；第三方原许可证、notices 和适用 MPL 源码义务独立保留，不把所有依赖称为 MIT。最终包及 native runtime/CRT/NSIS 分发仍需按真实资产复核，不以文档或单项自动检查冒充法律/发布认证。

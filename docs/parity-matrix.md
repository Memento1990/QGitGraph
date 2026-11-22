# 功能对齐与验证矩阵（0.2.0 基础 / 0.2.1 性能修订）

0.2.1保留以下功能与安全语义，新增patch优先/全文按需、分阶段首屏、保留视图刷新、有界模型复用和documented Windows启动器。性能方法、真正运行的新增回归及实际项目前后对照见[0.2.1性能记录](performance-0.2.1.md)。本表旧版通过记录不自动变为新版通过；最终0.2.1程序另跑16项桌面parity与既有/新增自动化。

QGitGraph采用独立实现，不包含原插件受限源码/样式/素材/消息协议。对齐基准为2026-11-21查阅的公开功能与设置说明，见 [冻结规格](parity-spec-0.2.md)。本表不承诺受保护外观的像素级复制，也不把未运行环境标通过。

## 已补齐的桌面适用功能

| 领域 | 0.2.0 实现 | 验证证据 |
|---|---|---|
| 分支范围 | all/HEAD、多refs、命名include/exclude glob；129+起点内部OID stdin、零匹配空、稳定分页 | 真实Git9项；真实桌面glob限制/恢复all |
| 搜索 | message正文/author/date/hash/全部refs标签命中，与范围交集 | 真实Git+前端纯函数；不再首匹配ref ancestry |
| 提交图 | stash语义投影、真实parents保留，普通ref/HEAD保护；工作区连真实HEAD；颜色/淡化/标签合并对齐/remoteHEAD和tag-only可控 | graph纯函数+真实Git；桌面Canvas/行对齐与包含关系提示 |
| 元数据 | 权威HEAD/refs/status，detached/bare/unborn、已删除refs清除 | snapshot真实集成；不从当前branch猜HEAD |
| 详情/布局 | Inline插槽、bottom/right；merge父选择、两提交及工作区/index、历史文本 | Inline实际360px插槽、gridcell与虚拟列表包含断言，真Diff+split |
| 消息 | 公开承诺inline Markdown子集、Unicode gitmoji/customemoji、safeHTTP/issue规则 | 安全tokenizer测试，真实DOM bold/emoji/链接，无HTML解释或自动访问 |
| 标签 | 轻量/附注明确类型，tagger/email/date/全文/object/target/signaturepresence；推送可选 | 真实Git与桌面tagmetadata；不伪造轻量tagger |
| 审阅 | start/resume/end/endall，自动已读、未读加粗、跨会话/90天活动；mutable比较禁用 | 状态+immutable测试，真实桌面start/mark/end/mutable无控件 |
| 导航 | Ctrl/Cmd-click与Shift兼容、HEAD居中、stash循环、同分支父子与替代路径、可配置快捷键 | 纯导航/shortcut/Inlinegeometry；桌面Escape/focus。子提交导航限已加载图 |
| 菜单 | 对象上下文ordered allowlists、全局显隐，分支push/归档/PR、远端checkout/delete/fetchinto/pull/merge、stash/工作区reset | 前端契约+真实操作集成；配置不再仅存不生效 |
| 操作参数 | branch checkoutAfter、tag push/type、stash index、cherry -x、实际mainline、rebase日期/保merge、prune/pruneTags、squash summary、签名三态 | 15项真实Git操作+6新增argv，全部通过 |
| 危险改写 | 线性drop成功，dirty/ref/topology预检；复杂root/merge明确转审阅的外部交互，不假成功 | 真rebase/drop/dirty与保merge/recovery断言；自动drop guard仍保留 |
| 外部会话 | 真console+可输入shell，started/running/paused/completed/failed；事务不等Enter持有 | 真console成功及conflictpaused、abort；真控制台输入cwd并exit |
| 验签 | 显式trust后commit/tag验证，有效/缺密钥/不可信/过期/撤销/unsigned/不可用结果；普通浏览不auto verifier | 真实临时SSHed25519 commit/tag及篡改/缺signers/信任拒绝，8host测试的一部分 |
| 远程/认证 | remote完整合法Unicode/dot/slash、安全rewrite/helper/NUL URL预检、lease保护、认证allowlist/case净化、日志脱敏 | 本地bare15新增+23旧集成；真实生产SSO/GCM服务端仍需对应环境 |
| 仓库/子模块 | 最近排序/单项移除、深度0–5发现；linkedworktree/common锁、submodule只读状态与打开 | 真实Gitworktree/submodule/Unicode；longtrackedpathfixture成功但非全路径组合验收 |
| 配置 | 全局/叶级仓库覆盖、v1→v2保偏好、全部桌面设置族/对话框默认、导入预览allowlist、安全分享导出 | schema/migration/save失败测试，真实设置保存与原生导出；Git路径global-only |
| 监听/取消 | 活动仓库recursive变更与新refs/操作目录、anchored noise过滤/错误警告；注册前/排队/运行中取消/超限终止进程树 | 真Git+helper+子孙4PID先存活后清理，32MiB边界及超限，原子配置与watch过滤回归 |
| 可访问性 | native dialogs、gridheader/slot、可见active descendant、ref键盘菜单、文件树可见左右导航、resize范围、最上层Escape | 纯模型+真实键盘Escape；screen reader完整人工测试需单列 |
| PR创建 | branch source/target/remote，GitHub/GitLab/Bitbucket/custom预填安全网页表单 | provider纯构造测试；不调用账户API/不自动外发，实际provider权限/网页变化未冒充通过 |
| 桌面原生 | native folder/取消、保存export、clipboard、editor/terminal/snapshot/externalDiff入口 | 最终程序原生folder/取消/export及真terminal通过；剪贴板回读因host OLE整体Blocked，具体editor/difftool GUI仍待对应环境 |

## 与“无差异”不能混淆的边界

1. **VS Code专属宿主不复制**：editor group/SCM标题栏/状态栏launcher/active text-editor推断，改为独立桌面的相应入口；不变成IDE。
2. **公开范围内安全子集**：Markdown只做inline强调/code/links，不执行HTML/CommonMark网页；issue规则只支持有界numeric capture小语言；emoji本地Unicode常用/gitmoji与custom，不含全部供应商图片。
3. **资源上限明确**：UI最多50k加载提交，过滤/HEADancestry最多100k扫描，20k graphrefs，containment最多256 stash，directsubmodule256，preview100k行；超限要求缩小范围，不假完整。
4. **安全保护继续存在**：复杂自动drop、递归子模块网络、TLS/host-key/global safe.directory不会为了表面无差异取消；用户确认的交互流程和显式参数是桌面等价能力，不声称spawn即完成。
5. **环境仍需真实验收**：Win10、缺Git/Runtime干净VM、DPI/多屏/screenreader、真实SSO/GCM/SSHagent、GPG/X.509与Authenticode/SmartScreen。当前Hyper-V读取权限不足，不在宿主卸载共享依赖模拟。
6. **不是发布授权**：未上传、未push、未公开发布；应用unsigned与依赖原文/source可获取说明如实交付，native CRT/runtime/NSIS条款仍需最终发布复核。

## 验证口径

[0.2.0验证记录](verification-0.2.md)逐项保留实际run、失败修复、原始日志和环境。局部历史测试/纯函数/provider URL不能代替真实桌面、系统或外部账号验证。最终安装、资源占用与hash以版本对应的实际报告为准。0.1.0旧记录见其原始交付目录，不改写成0.2.0成绩。

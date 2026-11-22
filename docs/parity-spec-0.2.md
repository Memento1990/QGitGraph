# 0.2.0 独立功能对齐规格

查阅日期：2026-11-21。来源仅为公开用户文档，不读取或搬运上游实现、样式、资源和协议。

- [Marketplace](https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph)
- [Extension Settings Wiki](https://github.com/mhutchie/vscode-git-graph/wiki/Extension-Settings)
- [Custom PR Provider Wiki](https://github.com/mhutchie/vscode-git-graph/wiki/Configuring-a-custom-Pull-Request-Provider)

Wiki未版本化（页面显示最后编辑2021-04-05），Marketplace所读取内容未提供明确发布版本。因此这是冻结的公开行为规格，不虚称复刻某一“最新版本”。

## 必须真正实现的差异

| ID | 行为 | 验收事实 |
|---|---|---|
| HIST-01 | 多个精确branch/remote/tag范围 | 单查询并集、稳定排序、去重、分页；129+起点不扩大范围 |
| HIST-02 | 命名include/exclude glob | 结构化配置、Unicode、零匹配为空、非法pattern不执行argv |
| HIST-03 | refs搜索 | 当前范围内所有匹配标签对应提交，不只首匹配ancestry |
| HIST-04 | stash语义图 | 真实parents保留；仅stash辅助节点可折叠，普通ref保留对象不误隐藏 |
| HIST-05 | HEAD/工作区 | detached刷新权威head，工作区节点连接真正HEAD |
| GRAPH-01 | 包含关系 | 显示HEAD与branch/tag/stash真实contains，可键盘访问 |
| GRAPH-02 | 显示配置 | graph颜色、merge/nonancestor淡化、remoteHEAD/标签合并对齐、工作区/未跟踪显隐 |
| MSG-01 | Inline Markdown | bold/italic/combined/code；code不再展开issue/emoji；HTML作为文本 |
| MSG-02 | Emoji | 常见/gitmoji shortcodes+自定义Unicode覆盖，未知原样，不加载图片 |
| MSG-03 | 安全链接 | HTTP(S)自动链接、issue规则、禁危险scheme和userinfo，不自动访问 |
| TAG-01 | 附注标签详情 | tagger/email/date/message/tagOID/target/type/签名存在性；轻量标签不伪造tagger |
| REVIEW-01 | 生命周期 | start/resume/end/endall、跨会话恢复、90天活动过期 |
| REVIEW-02 | 自动已读 | 活跃审阅成功看Diff/打开文件才标记，未读加粗；mutable端点禁止 |
| NAV-01 | 对比与父子导航 | Ctrl/Cmd click，Ctrl+Up/Down，Shift替代分岔，stash循环、HEAD居中 |
| NAV-02 | 可配置快捷键 | editable/modal/menu上下文、冲突检测、原生键盘与ARIA |
| LAYOUT-01 | Inline详情 | 可变行高虚拟化、Canvas/点击/滚动准确；保留bottom/right |
| STATE-01 | 视图与失败恢复 | 每仓库范围/选中/scroll/file/面板恢复；迟到响应不改新仓库；保存失败不清dirty |
| SETTINGS-01 | 全设置族 | 日期source/formats、initial/more、排序、mailmap、tag-only、onload、dialogdefaults、context visibility、repo排序与发现 |
| SETTINGS-02 | 迁移 | v1偏好保留，缺失字段取v2默认；global-only executable，不偷偷改用户Git配置 |
| PR-01 | 分支创建PR | GitHub/GitLab/Bitbucket及custom预填source/target，正确解析scp/sshremote |
| SHARE-01 | 分享配置 | allowlist导出、显式预览导入；不导工具路径/args/trust/凭据/recent |
| ACTION-01 | 分支完整操作 | 创建后checkout、remote tracking checkout、remote删除、fetchinto、对象push/pull/merge |
| ACTION-02 | 归档 | branch/tag ZIP/TAR到明确选择位置，不能shell/路径注入 |
| ACTION-03 | 参数默认 | tagtype/pushafter、stashindex、cherry-x、rebase日期/保merge、fetchprune/tagprune、squashmessage |
| ACTION-04 | 签名策略 | Git配置/强制签名/不签名，默认不发送隐式no-gpg-sign |
| ACTION-05 | 危险改写 | preflight/影响说明；复杂root/merge不删guard假对齐，交互流程真实完成才算成功 |
| EXTERNAL-01 | 真实交互 | console有可输入shell、session状态，不把spawn当完成，不等Enter占事务 |
| EXTERNAL-02 | editor/diff | structuredexe/args/有限placeholder，历史快照只读，工具实际wait/错误可见 |
| VERIFY-01 | 显式验签 | trust后commit/tag验证，区分有效/无key/不可信/过期/撤销/无签名/工具不可用 |
| AUTH-01 | 环境策略 | read与trustedbackground/interactive分开，case-insensitive净化路由、认证allowlist、输出脱敏 |
| WATCH-01 | 外部修改 | nestedfiles/newrefs/operation目录、错误诊断、focus快照；无后台网络 |
| PATH-01 | 仓库形态 | worktree/common锁、submodule状态/打开、Unicode config、longpath与UNC局限明示 |
| CANCEL-01 | 真取消 | 注册前/排队/执行中/输出超限/子进程/退出；无回滚假承诺 |
| TEST-01 | 真隔离 | runowned profile+WebView+HOME、唯一refs，禁止APPDATAfallback与按名kill |
| TEST-02 | 证据 | 初始ref不存在、实际执行创建、HEAD/index/status/content断言、失败留证 |
| RELEASE-01 | 轻量交付 | 同源版本+真实测试报告+sha/notices源码校验，旧产物不覆盖 |

## 对齐的公开新配置默认

- details inline；commits order date；作者日期+Date & Time；首次300/后续100。
- mailmap false；merge no-fast-forward true；stash includeUntracked true；tag annotated。
- 较高风险能力保留本产品的额外确认；头像默认关，无遥测/默认外网。
- v1已保存配置不被覆盖成新默认；旧默认与用户自定义无法区分时保留旧值。

## 合理等价与环境门禁

VS Code editor group、SCM按钮、状态栏launcher/active编辑器推断仓库等改为独立桌面等价入口，不引入通用IDE或内嵌完整终端。

真实账号SSO/GCM/SSH、GPG/X.509、Win10、真实DPI多屏、缺Runtime/Git的干净VM与代码签名证书，必须记录具体环境。局部mock/helper和本地bare只证明对应协议/命令，不替代外部provider及系统验证；不可用标Blocked而非通过。

不自动上传或公开发布。不关闭TLS/host-key校验，不全局设置safe.directory，不自动discard、删lock或回滚写操作。

# QGitGraph 0.2.2

以提交图为中心的克制 Windows Git 桌面客户端，独立实现 Git Graph 的公开主要任务流程。不是上游扩展的重新打包，不包含其源码、CSS、素材或协议，也不暗示上游授权或背书。

- [下载最新正式版](https://github.com/Memento1990/QGitGraph/releases/latest)
- [源码仓库](https://github.com/Memento1990/QGitGraph)
- 自有源码采用 [MIT License](LICENSE)，第三方组件保留各自许可。

## 0.2.2 首次公开发行与检查更新

在 **Settings → About & privacy → Check for updates** 手动检查本仓库最新正式Release。启动和打开设置不会自动联网；检查不需要仓库信任，不读取项目数据，不携带GitHub令牌。发现新版后可主动打开官方发布页，**不会自动下载、安装或覆盖应用**。

此版本同时完善公开源码许可、隐私脱敏和完整发布资料；性能与Git功能沿用以下已实现能力。

## 0.2.1 性能修订

- 历史与工作区状态分阶段加载；刷新保留列表、选择与滚动，取消或新的用户意图不再被恢复任务覆盖。
- 普通Diff先显示patch，旧/新全文按需读取；减少重复Git查询，缓存与解析模型保持条数/字节上限。
- Windows后台Git使用创建时保留的初始线程句柄，仍先挂起、绑定Job后恢复，不再枚举全系统线程。
- 图布局、可见行、文件树与Diff模型按真实输入复用；大变更文件列表虚拟化，搜索自适应扫描，watch/focus刷新合并。
- 可选本地性能诊断默认关闭，无遥测；真实WSL UNC测试仓库的只读前后对比与残余UNC延迟见[性能记录](docs/performance-0.2.1.md)。

0.2.0功能清单继续保留如下；基线与本次结果不混用。

## 0.2.0 补齐内容

- 多选 refs、命名 include/exclude glob 分组、范围内 refs 搜索及独立初始/追加加载。
- stash 语义图投影、真实 HEAD、包含关系、自定义图色、标签合并/对齐、作者/提交日期与显示选项。
- **Inline** / Bottom / Right 详情；安全 inline Markdown、本地 Unicode gitmoji、自定义 emoji、issue/普通 HTTP 链接。
- 附注标签完整 metadata、审阅 start/resume/end/end-all、活跃审阅自动已读及90天活动过期。
- Ctrl/Cmd-click 比较、父子/分岔导航、HEAD居中、stash循环、可配置快捷键及键盘/ARIA改进。
- branch 创建后checkout、tracking checkout、远端分支删除、fetch-into、对象push/pull/merge、ZIP/TAR归档。
- tag显式类型/可选推送、stash index、cherry-pick -x/mainline、rebase日期/保merge、prune/pruneTags、squash summary、签名三态。
- 分支创建PR（GitHub/GitLab/Bitbucket/custom）、安全分享配置导出和预览导入。
- v1→v2保留旧偏好，叶级仓库覆盖、视图/布局恢复、显式trust后commit/tag验签与真实外部会话状态。

具体实现、自动测试和实际环境证据见 [功能矩阵](docs/parity-matrix.md)、[0.2.0验证记录](docs/verification-0.2.md)；保留的安全边界和未验证平台不冒充“无差异”。

## 轻量结构

Tauri 2 + Rust + 原生 TypeScript/CSS，无React/组件库/大型Markdown框架，无网络字体、CDN、账号、遥测、托盘常驻、独立Web服务器或自动后台同步。只使用系统WebView2和现有Git，不捆绑Chromium、Node或Git。头像默认关闭，消息中的链接只在用户点击时打开。

系统WebView2本身仍是多进程浏览器运行时；安装包小不等于总内存零开销。最终包体和全进程资源以对应版本真实报告为准。

## 运行要求

- Windows 11 x64；Windows 10 22H2尚需对应真实系统验证。
- Git for Windows 2.38+，优先标准安装路径，再检查绝对PATH目录。设置的 `gitPath` 为全局专属可信绝对 `git.exe`，不接受shell命令。
- Microsoft WebView2 Evergreen Runtime。缺失时安装器联网下载引导；断网且缺Runtime不能自动完成。Edge浏览器不替代Runtime。
- 当前构建未配置Authenticode证书，安装器/应用可能出现SmartScreen提示；不承诺消除Windows信誉警告。

## 开发与构建

需要Node22、Rust MSVC、C++ Build Tools（Desktop development with C++）及Windows SDK。`host-tests`真实验签测试还需要已安装的`ssh-keygen`；缺失会明确失败，不静默计为通过。

```sh
npm ci
npm run desktop
```

```sh
npm run check
npm test
cargo test --locked --features host-tests --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --features host-tests --all-targets -- -D warnings
npm run tauri -- build --bundles nsis --no-binary-patching -- --bin qgitgraph
```

发行构建显式选择 `--bin qgitgraph`，不能将 `qgitgraph-test-probe.exe` 测试helper带入产品。`--no-binary-patching`保持本版本安装/解压程序同一SHA（不使用多bundle updater）；安装器输出 `src-tauri/target/release/bundle/nsis/QGitGraph_0.2.2_x64-setup.exe`。

本地历史产物不进入Git；公开0.2.2交付整理在 `release/QGitGraph-0.2.2/`。stage脚本需真实测试证据索引，自动检查版本、hash、签名状态及notice/source完整性，不硬编码通过数量。GitHub Release附有可直接按资产文件名验证的SHA-256清单。

解压运行包必须保留完整目录与 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`notices/`（含MPL源文件），不能只发exe。它与安装包使用同一SHA-256的原样程序。此处“解压运行”指无需安装即可启动，不承诺默认配置自动保存到exe旁；需要隔离配置时显式指定`--profile-dir=ABS`。

### 真实隔离桌面验收

```sh
node scripts/test-desktop.mjs --binary src-tauri/target/release/qgitgraph.exe --driver <已验签且匹配Runtime的msedgedriver.exe> --output artifacts/new-run --suite parity
```

每run必须新目录；应用state、WebView2数据、Git HOME/config及refs隔离。测试身份核对path/HEAD与profile，失败也留证，finally只清理run拥有的进程，不回退用户APPDATA。

应用支持正常的显式profile选项：

```sh
qgitgraph.exe --profile-dir=D:\QGitGraph-Profiles\personal
```

### 浏览器预览

`npm run dev` 后：
- `http://127.0.0.1:14730` 明确显示需要桌面宿主，不读取文件系统。
- `http://127.0.0.1:14730?demo` 仅开发模式样例，用于视觉预览；不执行Git写入，不算端到端证据，正式包不包含。

## 安全与等价能力

- 初次仓库只读，写操作/外部工具/验证器需trust；Git不是恶意仓库沙箱。
- force-with-lease、危险确认、无自动discard/删lock/全局safe.directory。取消写操作不回滚，查看真实Git恢复状态。
- 内置Diff/历史只读；编辑、暂存和冲突解决通过外部工具。历史snapshot在应用目录受控导出只读文件。
- 外部console报告started/running/paused/failed/completed，启动不等于rebase成功；暂停时可用实际shell继续/abort，Git已退出不因等Enter占锁。外部用户会话不随主窗口静默终止。
- 签名存在不等于验证；普通浏览不自动执行仓库配置的verifier。显式验证支持commit和附注tag，三态sign默认遵循Git配置。
- 密码/私钥不存应用state。用户已有GCM/SSH/GPG配置按可信操作环境策略使用；输出脱敏。
- 默认不自动递归子模块网络或打开任意remote-helper；复杂root/merge自动drop有拓扑保护，转明确审阅的交互流程而非假成功。

公开文档的inline Markdown与有界issue规则不是原始HTML/任意regexp；无法用代码替代的Win10/干净VM/多屏DPI/真实provider认证/签名证书列为环境门禁。手动更新请求会向GitHub发送正常网络元数据（IP、应用User-Agent/版本）；没有遥测、默认自动检查或自动安装。

## 文档与许可

- [0.2.2公开发行、更新与验证说明](docs/release-0.2.2.md)

- [冻结公开规格](docs/parity-spec-0.2.md)
- [逐项矩阵](docs/parity-matrix.md)
- [0.2.1性能记录与前后对照](docs/performance-0.2.1.md)
- [0.2.1交付说明](docs/delivery-0.2.1.md)
- [0.2.1验收与本地升级边界](docs/performance-release-checklist-0.2.1.md)
- [0.2.0历史验证记录](docs/verification-0.2.md)
- [0.2.0历史交付说明](docs/delivery-0.2.md)
- [安全模型](SECURITY.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)

QGitGraph自有源码采用MIT许可，详见 [LICENSE](LICENSE)。第三方组件保留各自原许可证；完整原文、锁定MPL源码与获取说明随交付，应用MIT选择不改变这些权利或替代native runtime/CRT/NSIS最终分发复核。

# QGitGraph

以提交图为中心的 Windows Git 桌面客户端，独立实现 Git Graph 的公开主要任务流程。不是上游扩展的重新打包，不包含其源码、CSS、素材或协议，也不暗示上游授权或背书。

- [下载最新公开稳定版](https://github.com/Memento1990/QGitGraph/releases/latest)（本次说明中最新已确认版本为 **v0.2.2**）
- [源码仓库](https://github.com/Memento1990/QGitGraph)
- 自有源码采用 [MIT License](LICENSE)，第三方组件保留各自许可，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 当前开发状态：0.3.0 Vue 迁移候选，未发布

当前正式应用入口已迁移到 **Vue 3 + Reka UI + 本地可编辑的 shadcn-vue 组件 + Tauri 2 / Rust Host**，不是浏览器原型，也不再以旧原生 DOM 控制器作为正式界面。源码版本号为 0.3.0，**尚未发布 GitHub v0.3.0 tag / Release**；本地候选构建不等于已发布、可升级或验收完成。

- **四组同级导航**：目录、子模块、标签、储藏；后三组跟随当前仓库。仓库行保留分支切换入口和同行快捷操作，不添加分支侧树。
- **历史与 Diff**：提交图、提交详情、父提交选择、文件列表、统一/双栏 Diff 与审阅迁移到 Vue。新 profile 默认右侧详情，已有显式布局偏好保留，不强写为新默认值。
- **本地修改与同步**：区分已暂存、未暂存和未跟踪；暂存/取消暂存针对明确路径，提交仅使用确认的索引内容，不自动 add。同步按明确上游先 pull，失败、冲突或取消后不继续 push。
- **设置与状态**：在设置中选择语言、主题及全局/仓库选项；未知、加载中和陈旧状态不冒充刚验证的干净状态。本轮界面验收范围是宽屏深色与浅色。
- **原生授权与本地记录**：目录/仓库信任由 Rust 独立保存并绑定真实身份与授权 epoch；可选 usage 默认关闭，显式开始后只记录本机白名单事件，并关联运行程序及构建来源。不依赖任务看板，不开放 HTTP 或 shell bridge。

原生 `git clean` 的预览与确认执行已完整实现，Rust **186 unit + 141 integration（12 targets）通过**。RC10 已生产构建冻结，根布局采用受控像素侧栏、主区域 flex 与独立根分隔条，不再使用根布局 Reka Splitter；菜单、Tree、Dialog 仍使用 Reka UI。前端 **747/747**、最终脚本/许可检查 **206/206**、看板 **46/46** 及 notices **945 文件**一致性检查通过。这些是实现与自动检查事实，不代表完整使用验收。

**同一 RC10 候选的真实 Windows 自动桌面 `full` 已通过 26/26，并经发行验证器复核**；这是 `automated-test`，不是 `userusage`、安装验收或完整平台认证。首轮 full01 的 driver EOF 失败记录保留；同一 RC10 exe 的本机 fixture 资源实测已通过，并经发行验证器复核，仅代表本机测量。断网 Sandbox guest 的候选新装→卸载、0.2.2→RC10 升级→卸载两例已通过，宿主注册未变。发行门禁仍未齐备：沙盒中实装应用的界面启动验收未完成，驱动创建会话超时，installed-startup 仍为 blocked，未确定产品缺陷；真实 `userusage` 证据不足，真实 WSL 性能未测。旧版通过结果、浏览器样例和单元测试均不能替代当前候选验收。

当前状态与旧记录的区别见 [0.3.0 候选说明](docs/release-0.3.0.md)；旧计数、哈希、安装与性能结论仅保留在其中的[迁移前历史区](docs/release-0.3.0.md#pre-vue-history)。原始日志、截图、profile、真实路径及候选资产留在本机私有目录，不加入源码或公开证据。

## 运行要求

- Windows 11 x64；Windows 10 22H2 仍需真实环境验证。
- Git for Windows 2.38+；使用可信绝对 `git.exe` 路径，不接受 shell 命令作为 `gitPath`。
- Microsoft WebView2 Evergreen Runtime；Edge 浏览器不替代 Runtime。缺少 Runtime 时安装器可能需要联网获取，不能承诺离线完成。
- 当前候选未配置 Authenticode 签名，可能出现 SmartScreen 提示；不承诺 Windows 信誉认证。

使用系统 WebView2 和现有 Git，不捆绑 Chromium、Node 或 Git。无账号、遥测、默认后台同步、产品内独立 Web 服务器或自动安装更新。WebView2 仍有多进程资源开销，包体小不代表总内存为零。

## 手动检查更新

在 **设置 → 关于与隐私 → 检查更新** 中主动查询本仓库最新公开稳定 Release。启动、打开设置与浏览仓库不会自动发起检查；检查不需要仓库信任，不读取仓库数据，不携带 GitHub 令牌。GitHub 会收到正常网络元数据及应用版本 User-Agent。

发现新版后，仅在再次点击时打开官方发布页；**不会自动下载、安装或覆盖应用**，也不是签名验证的自更新器。公开最新版本与本地 0.3.0 候选须分开判断。

## 开发与构建

需要 Node 22、Rust MSVC、C++ Build Tools（Desktop development with C++）及 Windows SDK。`host-tests` 的真实验签测试还需要 `ssh-keygen`；缺失不能算通过。

```sh
npm ci
npm run desktop
```

```sh
npm run check
npm test
npm run build
cargo test --locked --features host-tests --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --features host-tests --all-targets -- -D warnings
npm run tauri -- build --bundles nsis --no-binary-patching -- --bin qgitgraph
```

以上是可执行的开发/检查命令，不是本次全部通过的声明。发行构建显式选择 `--bin qgitgraph`，不分发测试 probe。使用 `QG_SOURCE_BUILD` 提供可追溯构建来源；usage 中的 `sourceBuild` 和运行时实测 `exeSha256` 是不同身份，缺失可靠来源不能冒充已冻结候选。最终资产仍需绑定实际源码、测试证据、哈希及第三方 notices，不凭版本号或旧哈希认证。

### 隔离的真实 Vue 桌面验收

在项目根目录执行，下列占位符需替换为实际已验证的程序/驱动路径；每次使用全新的本机忽略目录。

```sh
node scripts/test-vue-desktop.mjs --binary <候选exe绝对路径> --driver <已验证驱动绝对路径> --output artifacts/new-vue-full --suite full
node scripts/measure-resources.mjs --binary <同一候选exe绝对路径> --driver <已验证驱动绝对路径> --output artifacts/new-vue-resources --frontend vue
```

桌面脚本只接受新建夹具，隔离应用 profile、WebView2 与 Git 环境；真实操作通过 native UI 发起，日志来源为 `automated-test`，不是 `userusage`。资源脚本须显式选择 `--frontend vue`，其本机夹具采样不证明真实 WSL 性能。失败、Blocked 与未覆盖项保留，不能写成完整通过。

安装验收另有边界：同 identifier 的安装器共享 currentUser 注册项与快捷方式；更换安装目录或 `--profile-dir` **不能隔离安装生命周期**。本轮两例安装生命周期在独立断网 Sandbox guest 中完成，不覆盖宿主现用安装；实装应用启动仍缺 session/DOM 证据。旧静态 StartMenu.dll 元数据/解包尺寸差异失败保留为工具差异历史，不以实装通过改写或豁免。

应用可通过 `--profile-dir=ABS` 指定独立配置目录；这不是安装注册隔离。浏览器 `npm run dev` 只用于开发预览，`?demo` 为样例数据，不算 native 证据，正式包不包含 demo。

## 安全与分发

- 仓库默认只读；写入、网络 Git、外部工具和显式验签需要原生信任。选择目录不等于信任全部候选；目录授权必须单独确认。Git 不是恶意仓库沙箱。
- 类型化 Host 命令不开放任意 shell、argv 或文件读写。目录发现是有界纯文件系统扫描；候选摘要是独立只读 Git 请求，不自动 fetch。
- 取消写操作不回滚；没有自动 discard、删除 lock、全局扩展 `safe.directory` 或假成功。编辑与冲突解决仍有外部工具边界。
- 密码、私钥不写入应用 state 或 usage；usage 不记录代码、Diff 正文、提交说明、自由输入或真实私有路径。可选头像会向第三方发送哈希邮箱及网络元数据，默认关闭。
- 本地 `artifacts/`、日志、备份和 `release/` 资产不进入仓库；私有验收证据不作为公开发布附件。
- 分发包必须保留 `LICENSE`、`THIRD_PARTY_NOTICES.md` 和完整 `notices/`（含适用的 MPL 源码），不能只分发 exe。自有代码 MIT 不改变第三方许可，也不等于所有依赖均为 MIT 或已完成法律/签名认证。

## 文档

- [0.3.0 Vue 候选状态与迁移前历史](docs/release-0.3.0.md)
- [安全模型](SECURITY.md)
- [第三方许可与分发边界](THIRD_PARTY_NOTICES.md)
- [0.2.2 公开发行与手动更新说明](docs/release-0.2.2.md)
- [0.2.1 历史性能记录](docs/performance-0.2.1.md)
- [0.2.0 历史功能矩阵](docs/parity-matrix.md)与[验证记录](docs/verification-0.2.md)（不作为当前 Vue 候选覆盖声明）

# 0.2.2 首次公开发行与手动更新检查

0.2.2用于QGitGraph首次公开源码和GitHub Release，沿用0.2.1性能修订及独立实现路线。历史0.2.0/0.2.1验证文档只证明对应本地版本，不自动变为0.2.2验收结果。

## 手动检查更新

入口：**Settings → About & privacy → Check for updates**。不要求打开或信任任何Git仓库。

- 只有主动点击才查询固定的 `https://api.github.com/repos/Memento1990/QGitGraph/releases/latest`；启动、打开设置、切换仓库均不自动检查。
- Windows使用系统WinHTTP与正常TLS校验，renderer仍为IPC-only CSP；不调用shell下载工具、不捆绑TLS库或updater插件。
- 不发送仓库内容/路径、作者、诊断、配置或GitHub token；GitHub接收普通网络元数据（IP、TLS及版本化应用User-Agent）。Cookie、自动认证和重定向禁用，代理/证书失败不绕过。
- 有且只有一个实际在途检查，后台工作线程结束才释放singleflight；关闭界面只忽略迟到结果，不声称强制取消原生调用。每阶段有限超时、30秒elapsed检查，不是严格30秒硬取消。
- 512KiB响应上限、16KiB UTF-8安全plain-text说明；只认当前仓库规范稳定SemVer标签和精确HTTPS发布页。
- 区分发现新版、已安装版本不低于最新正式版、没有公开latest Release、平台不支持和网络/限流/数据错误。失败不假装“已是最新”。
- 发现新版后主动点击可打开官方发布页。没有自动下载、执行安装器或覆盖应用；unsigned发行仍可能出现SmartScreen提示。

## 公开源码与许可边界

自有源码采用根目录[MIT License](../LICENSE)，Copyright (c) 2026 QGitGraph contributors。第三方组件保留原许可、版权和覆盖源码；完整notice和5份锁定MPL源码随安装/解压/源码包保留。应用MIT不表示把依赖或上游Git Graph受限实现改成MIT，也不代表上游授权/背书或法律合规认证。

性能文档中的私有项目、用户名、用户state指纹与本机安装路径已匿名化。真实性能方法/数字、失败记录、环境Blocked和产品二进制校验值保留。历史本地交付产物不覆盖，也不会作为公开Release资产上传。

提交与归档只包含审核后的源码、测试、脚本、文档、资源、锁文件、LICENSE及notice。`.zcode`、Git凭据/密钥、环境文件、依赖目录、构建缓存、生成schema、历史release、私有性能计划/截图/状态、升级备份和原始本机诊断都不公开。团队共享配置不能修改更新来源或授予信任。

## 交付与验证口径

版本号在package/Tauri/Cargo及锁文件一致为0.2.2。Windows安装器和完整解压包使用同一原样exe，源码包经过白名单与敏感信息检查；发布资产有独立按文件名直接核对的SHA-256清单。

自动化、真实桌面parity、原生手动检查入口、资源与实际本地升级分别留存新报告。源码冻结后的`stage-result.json`、`manifest.json`和`SHA256SUMS.txt`是本地归档成功的权威记录；本文件不提前宣称尚未执行的步骤已通过。GitHub Release先draft上传并核对资产，再publish，最后验证官方latest API及桌面检查结果。

## 0.2.2 本次实际验证

- 前端142项、Rust单元115项、真实Git/host集成85项，合计342项实际通过。新增更新相关测试包括前端15项和Rust34项，已包含在上述总数，不重复相加；Clippy全目标warnings denied通过。
- 最终程序真实桌面parity16项通过，临时仓库HEAD/index/status/内容/refs不变，owned进程清理残留0。
- 首次发布前，真实桌面在未打开任何仓库时点击检查，系统WinHTTP成功返回并准确显示`no-release`；关闭重开About回到idle。验证只证明该实际UI流程和源代码/离线测试覆盖，不包装成完整OS网络审计。
- 实际原目录0.2.1→0.2.2升级通过：完整旧安装及偏好仅本地备份，state在安装前后逐字节一致，原注册key/路径保持，840个安装文件、完整MIT LICENSE/notice/MPL原档案核对通过，无测试probe及安装器owned进程残留。该证据是已有用户安装升级，不冒充fresh-install/uninstall/干净VM。
- 新版主程序8,858,112字节、安装器2,506,296字节，分别比0.2.1约+0.78%/+0.72%，不捆绑新HTTP/TLS运行时或Git。
- 单机固定小fixture全应用+WebView2 Private Bytes p50约275.4MiB，75.2秒空闲，约单核0.84%观测CPU。该单轮比0.2.1约242.9MiB高13.4%，仍低于20%回归阈值；如实保留系统运行波动，不能仅报宿主或把它宣称零开销。原始报告在本机排除目录，公开资料不含个人路径。

发布后官方latest/current联调在Release正式公开后执行。若该外部步骤失败，须单独报告，不能用发布前no-release成功代替。

Windows10、干净VM缺Runtime/Git、离线安装、多屏DPI/屏幕阅读器、生产认证、GPG/X.509、provider网页权限及Authenticode仍需对应真实环境；本次普通更新检测不替代签名自动更新或完整平台认证。

GitHub仓库：<https://github.com/Memento1990/QGitGraph>。Release入口：<https://github.com/Memento1990/QGitGraph/releases/latest>。

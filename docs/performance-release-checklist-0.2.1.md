# 0.2.1 性能修订验收清单

本清单保留0.2.1历史验证与未覆盖边界，公开版本已匿名化私有仓库名称。已有勾选不表示0.2.2已执行或通过；新版本须使用自己的实际报告。

## 已完成实现

- [x] 默认关闭、仅本地有界native计时；前端与Rust单调时钟分别统计，不相减。
- [x] 基线程序仅加计时且算法不变，已独立冻结，正式0.2.0保持原样。
- [x] 合并仓库识别、Git版本身份缓存、multi-PID/request scope、可取消CPU检查点。
- [x] Patch优先/单侧按需、批量对象读取、fast detail、snapshot去重及有界并发。
- [x] 自适应手工搜索、同offset输出限制回退，保留scope/子串/排序/分页/完整性语义。
- [x] 分阶段首屏、非空白刷新、用户意图/取消/dirty重检、图/可见行/文件树/解析模型复用及持久化节流。
- [x] 不读取全文即可查看普通patch，nullable side明确完成，旧/新内容按需并支持取消/重试。

## 最终程序验收（以实际报告为准）

已留存：127项前端 +81项Rust单元 +85项Git/host集成（合计293）、16项实际桌面parity、`optimized-final-02`137个真实项目交互测量（整体仅原生取消ack另列Blocked）、`resources-final`72.1秒全进程资源及`upgrade-final`既有用户安装升级。原失败run未覆盖，新程序各证据SHA一致。

以下是验收口径，不将真实环境Blocked或未覆盖的fresh-install/uninstall重新勾选：

- 原有安全/功能回归与新增loader/cache/取消/字段解析回归必须跑实际发布源码，不能复用改动前通过数。
- Windows精确初始线程句柄启动器必须通过真实argv/Unicode/环境/8MiB/stdout-stderr限额、子孙取消、排队无spawn及退出回收验证，不以mock或代码存在替代。
- 真实WebView/parity、native原生流程及资源测量绑定最终exe SHA；包含系统WebView2全部子进程，不只报Rust宿主。
- 真实`WSL UNC测试仓库`只读对照的主要场景各20样本，固定commit/parent/file计划；first-use与warm、缓存命中与冷路径分开，公开p50/p95与未达目标项。
- All-ref/HEAD/index/status/config及样本文件前后不一致时严格对照失效，保留证据，不擅自恢复或关闭用户工作。
- 真实输入、可见结果身份、双rAF绘制机会与native阶段必须分开，driver墙钟不冒充应用延迟，缺失指标不填0。
- Win10/干净VM/DPI/屏幕阅读器/provider/PKI/Authenticode环境缺失继续明确Blocked，局部fixture不代替。

## 本地交付

- 0.2.1版本package/Tauri/Cargo/锁文件一致；新安装包、解压运行、源码、性能记录及SHA256校验完整。
- 默认无诊断记录/遥测/网络预加载/大依赖。测试probe、用户项目数据、样本私有计划与截图不进产品/公开源码包。
- 所有notice原文与锁定MPL源码档案校验，Windows本机新feature不表示依赖条款自动通过。
- 本地升级前备份用户偏好和既有安装回滚程序，仅正常关闭已确认的QGitGraph窗口；不按进程名批量kill，不通过测试卸载器删除用户安装。
- 无上传、Git提交、push或公开发布。

源码归档发生在最终验证之后。新版本根目录的`stage-result.json`、`manifest.json`及`SHA256SUMS.txt`是归档已完成与校验结果的权威记录，本清单不提前自证尚未生成的ZIP。

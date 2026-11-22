# 0.2.0 差异关闭进度

这是实施进度表，不替代最终验收。失败、blocked和未运行都保留，不能仅因代码存在就写通过。公开基准见 [parity-spec-0.2.md](parity-spec-0.2.md)。

## 当前已实现并有局部自动化证据

- 多精确refs、include/exclude glob、零匹配、129起点与稳定分页：真实Git测试。
- 所有matching ref label搜索、标签显隐与加载范围分离：真实Git测试。
- stash展示投影保留真实parents、保护普通ref/显式祖先：真实Git测试。
- 权威HEAD/snapshot、tagger/完整附注、stash语义、包含关系、bare/unborn/detached、Unicode config/submodule：9项历史测试通过。
- 新分支/远端分支动作、fetch into、prune/pruneTags、tag类型/后推送、stash index、cherry -x/mainline、rebase日期/保merge、squash summary、签名三态：15项新真实Git测试通过。
- 完整旧Git基线23+5通过；Rust单元53通过，旧安全用例仍保留。显式启用`host-tests`后重新留存原始日志，测试探针不得随产品分发。
- inline Markdown、gitmoji/customunicode、safeHTTP/issue、PRprovider、配置迁移/叶级覆盖、保存失败、审阅生命周期、inline几何/快捷键/byteLRU：前端71测试通过。
- Inline表格详情、上下文菜单配置、日期/排序/加载、视图恢复、review/标签/PR等UI已构建；`release-final`真实桌面16项通过。最终交付改用实际NSIS安装后的原样exe，SHA绑定复验单独记录，不能混用Tauri打包前的不同标记文件。

## 真实桌面执行中发现的验收工具问题

| run | 事实 | 处理 |
|---|---|---|
| desktop-01 | Git -C 超MAX_PATH目录在fixture初始化失败，app未启动 | 长路径改独立case，shortrepo+long tracked path，host不支持则blocked，不能冒充桌面通过 |
| desktop-02 | 微软157 driver输出新名称而校验只认旧MSEdgeDriver，app未启动 | 仍要求Microsoft有效签名，兼容两个官方名称和完整版本 |
| desktop-03 | 并发process-ownership原子rename在Windows EPERM，app未启动 | 按文件串行证据写入、进程snapshot去重/不重入，bounded retry，不吞错误 |
| desktop-04 | driver参数形式令显式profile未生效 | 支持等号开关、明确WebView2目录，保留严格profile/仓库identity门禁 |
| desktop-05 | canonical HOME的Windows extended前缀令Git配置读取失败 | canonical安全检查后转Git可接受显示路径，真实A/B与回归测试 |
| native-03/04/05 | 导出Save dialog与Folder dialog控件不同 | 观察原生结构后分别定位，native-06真实选择/取消/导出通过 |
| release-native-01/02 | 剪贴板OLE在保存用户内容前失败 | 保留失败；新版脚本只在可安全保存时copy，否则整体Blocked，不清空用户内容 |
| install-final | 安装与全部许可校验通过，卸载器瞬时退出导致CIM身份记录竞态 | 保留原失败，改保留进程句柄和精确创建时间，3项进程回归及install-final-02/03安装卸载通过 |
| bundle identity | Tauri打包将`UNK`标记改为`NSS`，exe仅3字节不同 | 不降低SHA门禁；实际安装后保留原样exe，桌面/性能/解压运行包统一此文件 |

这些不是UI通过；失败证据保存在独立run，不被下一轮成功覆盖。

最终程序`7077ed13…e93894a`的`release-payload-final`16项真实桌面检查、`install-final-03`完整安装/notice/source/无探针/卸载、`resources-payload-final`75.775秒空闲与真实刷新测量均通过。`native-payload-final`的选择/取消/导出通过，剪贴板OLE环境明确Blocked。基础自动化71+53+60=184项，发布工具26项和进程竞态3项另计；最终六类证据索引不覆盖历史run。详细数值与边界见[验证记录](verification-0.2.md)。

## 保留的安全语义

- 签名存在不等于有效；只有显式、信任后验签才执行外部验证器。
- mutable WORKTREE/INDEX比较不审阅、不作不可变缓存。
- 复杂root/merge自动drop不去掉guard；转明确用户确认的交互保merge流程，不说“打开终端=删除成功”。
- 默认不自动递归子模块网络、不关闭TLS/SSH host-key、不全局safe.directory、不自动删锁/discard。
- 安全消息是公开承诺的inline子集，不是原始HTML或完整CommonMark浏览器。
- 图/读取/输出/缓存有明确预算，超限报错，不返回伪完整结果。

## 环境验收仍需真实条件

本机已确认Windows11 Pro 10.0.26300。Hyper-V服务存在但Get-VM权限不足，Win10/干净VM不可由宿主模拟替代。真实多屏DPI、SSO/GCM/SSH、GPG/X.509、代码签名证书仍各自需要授权测试环境；临时SSH key/受控helper仅证明对应协议与runner行为。

不把无法运行项改成已对齐。最终deliverable记录各子项actualpass/blocked及版本hash，旧0.1.0产物保留。

# QGitGraph 0.1.0 — 验证记录

日期：2026-11-21。本文件区分实现、自动化通过、人工待测；不能把演示数据或按钮存在当成桌面验收。

## 环境

- 当前 Windows x64 主机，系统报告版本 10.0.26300；未另测 Windows 10 22H2。
- Git for Windows 2.47.0.windows.2。
- WebView2 Runtime 157.0.4341.60；Edge WebDriver 同版本，tauri-driver 2.1.0。
- Node 22.11.0、Rust/Cargo 1.94.0 MSVC、Tauri 2.12.7。
- 所有仓库写操作使用独立临时仓库；远程操作只使用本地 bare remote，没有真实外网 push 或全局身份变更。

## 自动化结果

| 检查 | 结果 |
|---|---|
| `npm run check` / `npm run build` | 通过；纯TypeScript/CSS静态产物，生产不包含DemoHost |
| `npm test` | 22/22 通过，4组：图/差分/格式/状态 |
| Rust单测 | 34/34 通过：参数校验、NUL协议、编码、签名存在性、操作状态 |
| Git集成 | 23/23 通过：查询/merge/比较/工作区/stash/tag/remote/lease/mailmap/worktree |
| 历史改写与修复回归 | 5/5通过：rebase/drop/dirty保护、externalDiff根与双端、排队取消 |
| Clippy `--all-targets -- -D warnings` | 通过；最终完整回归34单测+28集成通过 |
| Notice generator `--check` | 837文件字节一致；0缺失全文项，保留6条分发复核事项 |

### 实际修复过的问题

- Git runner 全局 literal-path 环境会让 stash 保存untracked后没有清理原文件。隔离A/B确认后改成**只读查询**使用该环境，写操作与外部工具显式适配，原完整stash断言重跑通过。
- 根提交的外部difftool必须传空树与提交两端；不再退化成提交与当前工作区比较。未跟踪文件明确引导内置预览，不静默假成功。
- 等待仓库事务锁也响应取消；不需要等外部交互控制台退出。
- open/save末端以同锁区内的权威信任状态为准，避免迟到结果恢复已撤销信任。
- 工作区不持久化“已审阅”；Diff换文件清除旧复制选择；大文件截断不误报没有差异。

## 真实桌面验证

使用实际编译的Tauri `.exe` + 系统WebView2，非浏览器mock：

- 中文/空格路径仓库打开、实际分支/tag/stash/工作区/merge图。
- 提交详情、真实patch、unified/split、左右/底部布局。
- 筛选及清空、设置对话框、Git动作菜单。
- 真实UI创建分支、创建附注tag、确认删除tag和分支；随后直接Git断言ref变化，HEAD与工作区不被误改。
- 最近一次读写回归均无应用错误；具体结果：`artifacts/desktop-smoke-results.json` 和 `artifacts/desktop-actions-results.json`。
- 深色和浅色预览检查通过；浏览器默认无Host时显示Desktop required，只有开发显式`?demo`使用样例，不能执行Git写入。

## 安装验证

NSIS当前用户安装和卸载已在本机运行成功：

- 安装后含exe、完整第三方notice树；安装与卸载退出0。
- 卸载后应用exe与安装目录移除；不卸载用户Git或系统WebView2。
- 最初测试脚本用正斜杠`/D=`路径被忽略，改成Windows完整反斜杠后指定目录测试通过。这是测试调用修正，保留最初失败记录，不伪报首轮通过。
- 产物未签名（Authenticode `NotSigned`）。没有证书，不声明解决SmartScreen。

最终尺寸/哈希和安装文件数在 `artifacts/release-summary.json` 汇总。

## 资源实测与口径

第一轮优化版（空仓库窗口）单次暖启动窗口句柄约 **469 ms**，**不是可交互时间或p95**。

前台空闲采样：宿主约33 MiB Working Set / 8.4 MiB Private Bytes；**加上全部WebView2子进程**约418–426 MiB Working Set之和 / 224–225 MiB Private Bytes之和。Working Set简单求和会重复计算共享页，不能当成独占物理内存。记录于 `artifacts/resources-release-first.json`。

这说明“安装包小”不等于“浏览器运行时零开销”。不以仅宿主内存宣传总占用。最小化Low memory target的试验版本出现退出后宿主未结束的问题，因此该额外优化已从交付版本移除，优先保证生命周期正确；没有禁用硬件加速或安全功能。这个试验失败单独保留，不声称交付版本有已验证的低内存模式。

第一轮采样后段聚合CPU仅增加约0.03s/5s；空闲无Git子进程，退出后受控应用/WebView2子进程无残留。测量本身有CIM开销，不是严格实验室基准。

最终稳定版复测：窗口句柄出现约 **592 ms**；14s采样末全部进程约 **411.85 MiB Working Set之和 / 223.08 MiB Private Bytes之和**，7个应用/WebView2进程，无Git；正常关闭后残留为0。数据文件 `artifacts/resources-release-stable.json`。此版本不包含失败的Low memory试验。

最终安装器 **2,238,227字节（2.1345 MiB）**，exe **7,810,560字节（7.449 MiB）**；安装后含notice与卸载器共 **11,583,355字节（11.047 MiB）**，839个文件（绝大部分是许可及第三方源码资料）。资源范围不含系统WebView2/Git。

## 尚未验证 / 发行前检查

- Windows 10、不同DPI/多屏、screen reader、企业代理、UNC/超长路径组合。
- WebView2/Git缺失、离线安装与干净VM；已提供诊断/引导，不冒称实测。
- 原生文件夹/导出对话框、剪贴板和外部编辑器的完整自动化。
- 真实HTTPS/GCM、SSH key/agent、GPG/X.509签名和交互式rebase编辑器人工流程。
- 真正执行中的Git进程取消压力、复杂submodule、10万+历史规模的性能与极端merge图。
- 还不是原插件逐项像素/全部参数默认值完全一致；明确差异见 `docs/parity-matrix.md`。
- 依赖原文与MPL源文件已保留，仍须针对最终实际发布产物核对Microsoft runtime、CRT、NSIS条款；没有自动上传或公开发行。

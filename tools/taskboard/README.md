# QGitGraph 项目任务看板

## 面向 coding agent 的协作分工

看板主要由当前 coding agent 通过 CLI／API 驱动；HTML 是用户按需查看和干预的窗口，不是要求用户手工维护的项目管理工具。

- **Agent 负责**：将需求入板、拆任务、选下一项、在授权范围内连续实施、维护状态、运行检查并登记真实证据、分析使用日志、记录验收结论、重开回归和复盘。服务启动与常规维护也优先由 agent 处理。
- **用户负责**：表达目标、作必要决策与授权、实际使用并反馈。无需逐项建卡、拖动状态、填测试结果、关联日志事件或点击完成。
- **使用验收不等于人工维护**：用户显式开启本地日志后正常使用，由 agent 整理同构建覆盖、测试和反馈；不足时保持待使用验收。助手回归不能冒充用户使用，也不能因为部分任务待验收而停止其他已授权且可执行的任务。
- **运行边界**：看板提供持久状态与 CLI／API，不会自行唤起或持续运行 agent。当前仅在 agent 会话执行时推进，不是后台无人值守调度器；也不会自行执行 shell／Git 或绕过权限。

## 日常使用（查看与可选手动操作）

以下步骤用于说明入口和手动备用方式，不要求用户每次亲自执行或维护任务。

1. 在仓库根运行 `node tools/taskboard/server.mjs`，或双击本目录的 `启动任务看板.cmd`。
2. 打开 **http://127.0.0.1:14732/**。必须使用这个回环地址；`localhost` 不在 Host 白名单。
3. 看板／列表切换，按编号、优先级、领域或交付包筛选。任务详情可改验收标准、依赖，追加执行记录、证据和复盘；原始对照基线可展开查看。
4. 普通状态流转不能直接进入“已完成”。实现和检查结束进入“待使用验收”，之后由助手核对同构建实际使用日志、全部场景、测试与反馈，通过专用 `assess` 记录结论。
5. 在原型顶栏“使用日志”显式选择来源并开始；用户使用、助手回归、自动测试不能混用。可暂停、继续、结束，失败时明确显示未保存。看板日志页可查会话。
6. 日志中的 `OBSERVED` 是操作后观察，不是自动证明。点击“记录人工核验”只产声明，不能替代实际原型日志。任务的所有必测 `scenarioIds` 都要覆盖，不是任选一项。
7. 修改验收标准会要求新证据和修改后新收到的日志；重开依赖会连同相关已完成下游一起失效，旧记录保留。
8. 任务数据保存到 `data/board.json`，原始使用日志与备份在 `.local/`（Git 忽略）；界面没有 shell／Git 执行接口，不会读取证据路径或联网抓取证据。

后续项目工作以本看板为唯一任务状态源。原始 100 项 Markdown 是来源快照，不再作为另一份进度表。2026-11-24 已获准以最新 Vue 原型正式落地，并在本轮验收通过后完成官方发行；正式任务使用 `QG-NATIVE-*`、`QG-VUE-*`、`QG-RELEASE-*` 记录，原型历史与构建证据保留且不冒充正式应用验收。用户现用安装与 profile 不覆盖，真实私人仓库只读，Git 写入回归限临时 fixture。此次发行授权不延伸为后续版本的自动发布。

## 开发与 API 参考


Node 22 built-ins only. From the repository root:

```sh
node tools/taskboard/server.mjs
# Open http://127.0.0.1:14732/
node tools/taskboard/cli.mjs list --required --pack W2 --json
node tools/taskboard/cli.mjs show QG-046
node tools/taskboard/cli.mjs validate
node --test tools/taskboard/tests/*.test.mjs
```

The server binds **only** `127.0.0.1:14732`; `localhost` and alternate Host values are rejected. A second writer is refused by `.local/exclusive.lock`. Stop with SIGINT/SIGTERM so the lock is released. After a forced termination, first verify that its recorded PID is no longer running before manually removing a stale lock. Never delete a live lock.

`data/board.json` is the persistent state, including task history. An existing board is never reseeded on startup. Do not redirect `seed.mjs` output over a live board. The seed retains the original 100 comparison rows and source result separately from task delivery status, creates stable `QG-001`–`QG-100`, `QG-BOARD`, `QG-USAGE`, and follows W0–W9. P0/P1 are required; others are backlog. Scope is wide dark/light. The narrow-only criterion is explicitly N/A with a reason, not checked/done.

## CLI writes

Writes always go through the running server; no alternate state path or server URL is accepted. The CLI silently obtains the token from bootstrap, or uses `TASKBOARD_TOKEN` if set. It sends the exact board Origin. Read-only list/show/validate work offline.

```sh
node tools/taskboard/cli.mjs update QG-046 --json '{"owner":"assistant"}'
node tools/taskboard/cli.mjs transition QG-046 inprogress --text 'Implementation started'
node tools/taskboard/cli.mjs log QG-046 'Implemented group-specific selection; awaiting tests'
node tools/taskboard/cli.mjs retrospective QG-046 'Root cause and follow-up'
node tools/taskboard/cli.mjs command --json '{"type":"update","id":"QG-046","patch":{"owner":"assistant"}}' --expect 12
node tools/taskboard/cli.mjs evidence QG-046 --json '{"type":"test","result":"passed","build":"build-id","summary":"Actual test command and result","reference":"test-run-reference"}'
node tools/taskboard/cli.mjs assess QG-046 --json '{"decision":"insufficient","rationale":"No user usage yet","build":"build-id","coverage":[],"limitations":["Needs user usage"]}'
node tools/taskboard/cli.mjs import-preview exported-board.json
node tools/taskboard/cli.mjs import exported-board.json --expect 12
```

Without `--expect`, a write first reads the current revision and uses it for CAS. HTTP 409 is reported without automatic retry (CLI exit 3); reload/review before explicitly retrying. Other CLI errors exit 2. `command --json` accepts create/update/transition/log/evidence/retrospective/assess/import. Create uses `{type:'create',id:'QG-CUSTOM',patch:{title,description,priority,area,pack,required,acceptance,dependsOn,owner}}`, with at least one criterion `{id,text,scenarioIds:[...]}`. Unknown patch fields are rejected. Import cannot change task status, protected baseline/source data, existing evidence or audit records, or introduce completion; use commands instead.

## HTTP contract

JSON errors are `{error:{code,message,details?}}`; revision conflicts have status 409 and `details:{expectedRevision,actualRevision}`. API read routes require `X-Board-Token`, except bootstrap. Non-board Origins are rejected (Origin may be absent for non-browser board clients). No CORS headers are emitted. JSON POSTs require `Content-Type: application/json`, max 6 MiB, and bounded request time.

| Route | Input / output |
| --- | --- |
| `GET /api/bootstrap` | `{token,version,build}`; keep token in memory; build is the current service/UI source fingerprint |
| `GET /api/board` | board directly: `{metadata,baseline,packs,tasks}` |
| `POST /api/command` | `{expectedRevision,command}` → `{board,result}` |
| `GET /api/export` | board JSON attachment; token header required |
| `POST /api/import/preview` | `{content:<board or JSON string>}` → `{valid,errors,summary}`; no mutation |
| `GET /api/baseline-source` | plaintext from the one fixed comparison document |
| `GET /api/usage/sessions?offset=0&limit=200` | `{sessions,total,offset,limit,bytes,limits,warning?}` |
| `GET /api/usage?sessionId=...&offset=0&limit=200` | `{sessions,events,total,offset,limit,warning?}`; without ID returns session metadata |

`command` forms: update `{type,id,patch}`; transition `{type,id,status,text?}`; log/retrospective `{type,id,text}`; evidence `{type,id,evidence}`; assess `{type,id,verdict}`; import `{type,content}`. Evidence is `{type:'test'|'browser'|'usage'|'observation',result:'passed'|'failed',build,summary,reference,eventIds?}`; the server adds `id,at`, returned as `result.evidenceId`. History/retrospectives have `id,kind,text,at,actor:'assistant-decision',revision` and operation-specific fields. This actor is a decision declaration, not authenticated identity.

Only the public index/styles/app/protocol whitelist is served; no arbitrary file paths. Evidence references are text and are never fetched, executed, or read from disk by the server. UI content must be rendered as text.

## Usage recording

Only these two POST routes accept the exact Origins `http://127.0.0.1:14731` and `http://127.0.0.1:14732`. Missing Origin, trailing slash, `localhost`, foreign ports, and other Origins are rejected. They never mutate tasks.

- `POST /api/usage/session` body `{source:'userusage'|'assistant'|'automated-test',build,taskIds?:[]}` → `{sessionId,sessionToken,source,build}`.
- `POST /api/usage/events` body `{sessionId,sessionToken,events:[...]}` → `{accepted,eventIds,lastSequence}`. Max 100 events/batch; sequences start at 1 and must be contiguous. An exact full-batch replay from the same capability is acknowledged without appending again (lost-response recovery); changed payloads, mixed replays and cross-session duplicate IDs are rejected. Session capability tokens are memory-only, excluded from disk and read APIs, and expire at server restart.
- Required event fields: `eventId,sequence,timestamp,taskIds,scenarioId,actionId,resultCode`. Optional: `durationMs,repoId,counts,state,errorCode`. No other fields, free input, paths, code, diffs, messages, event-level source/build, or arbitrary nested values.
- IDs/result/error codes match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; repoId must be an anonymous identifier, never a filesystem path. Timestamp is ISO UTC. Duration is 0–86400000 ms.
- `counts` keys only `selected,files,staged,unstaged,untracked,commits,conflicts,changed,total`; values are integers 0–1e9.
- `state` keys only `theme:'dark'|'light'`, `viewport:'wide'|'narrow'`, `status:<task-status>`, `phase:'idle'|'preview'|'running'|'success'|'failed'|'cancelled'|'blocked'`, `trusted/busy/cancelled:boolean`.
- The server adds `sessionId,source,build,receivedAt,version`; source/build come from the stored session. `source` is a declared provenance category, **not an unforgeable human identity**; DOM `isTrusted` is not used to identify a person.

JSONL files are independent in ignored `.local/usage`, max 10 MiB/session and 50 MiB globally, max 1000 sessions. Full logs pause/reject collection without silently deleting data. Incomplete final JSONL lines are excluded from complete evidence and make that session read-only; complete earlier records remain readable. Complete malformed records pause collection and evidence resolution pending offline review. Usage reads are paginated, max 1000 results/request.

## 正式应用本机日志导入（与原型日志隔离）

正式 native recorder **默认关闭**，每次显式选择 `userusage` / `assistant` / `automated-test` 并同意后开始，支持暂停、继续、结束。重启不自动续录。日志固定写入后端选择的当前 profile 下 `usage/`，IPC 不接受文件/目录参数，没有看板 HTTP 依赖，不放宽正式应用 CSP。每会话 10 MiB、profile 总计 50 MiB、最多 1000 会话；满额或写入失败会明确显示未确认保存，不删除旧日志、不自动补记。

- 会话 header 为 `kind:'native-session',schemaVersion:1,sessionId,source,build,runtime,taskIds,createdAt`。`runtime` 仅含 `appVersion,sourceBuild,sourceBuildReliable,exeSha256`；`build` 必须是 `native-<实际运行 exe 的 SHA-256>`。运行时测量 exe hash，源码构建使用编译期独立 `QG_SOURCE_BUILD`，**不把 exe 自身 hash 嵌回 exe**。`development/unknown/unavailable` 标为不可靠源码关联，不冒充发行源码指纹。
- 随后的 `kind:'boundary'`（`start/pause/resume/stop`）和 `kind:'event'` 使用单调连续 `sequence`、原始 `eventId,sessionId,source,build,occurredAt,collectedAt` 及上述事件白名单。来源与 build 整会话固定。边界本身是 `OBSERVED` 观察，不能自动证明产品正确。只在开始 / 继续后的 recording 阶段接受业务事件。
- native `repoId` 严格为会话内随机 `r-<32 lowercase hex>`；不是路径或仓库名，也不使用路径的可逆/可枚举 hash。`errorCode` 仅接受 `CANCELLED,USER_CANCELLED,GIT_FAILED,IO,ACCESS_DENIED,NOT_TRUSTED,TRUST_REQUIRED,TRUST_REVOKED,STALE_TARGET,INVALID_INPUT,NOT_FOUND,CONFLICT,TIMEOUT,UNAVAILABLE,DESKTOP_REQUIRED,USAGE_FULL,USAGE_WRITE_FAILED,UNKNOWN_ERROR`。counts/state 与原型同一有限白名单；不收业务正文、自由输入或任意嵌套对象。操作/场景/结果编号必须来自静态仪表化，不把实际输入拼入编号。

先**结束会话**，再选择本机完整 UTF-8 JSONL 文件。

```sh
node scripts/import-native-usage.mjs "<profile>/usage/s-<id>.jsonl" --preview
node scripts/import-native-usage.mjs "<profile>/usage/s-<id>.jsonl" --expect 12
# 等价 CLI（不允许 --source / --build / ID 重写）
node tools/taskboard/cli.mjs usage-import-preview "<local-file>.jsonl"
node tools/taskboard/cli.mjs usage-import "<local-file>.jsonl" --expect 12
```

文件只由 CLI 本机读取（regular file，最多 10 MiB，严格 UTF-8，有界读取）；服务器**仅接收内容**，不接本机路径、不读取任意文件，也不执行 shell/Git。两个新接口均要求原有看板 Host/Origin 白名单与 `X-Board-Token`，不会向原型 Origin 开放。

| Route | Input / output |
| --- | --- |
| `POST /api/usage/import/preview` | `{content:<JSONL string>}` → `{valid,errors,revision,contentHash?,summary}`；无写入 |
| `POST /api/usage/import/commit` | `{content,contentHash,expectedRevision}` → `{revision,sessionId,source,build,runtime,records,replayed,importedAt?}` |

`contentHash` 是 preview 规范化完整会话的 SHA-256，不是身份签名；commit 重验同一内容、来源、build 和 ID。会话/事件 ID 冲突拒绝，完全相同语义的重放幂等、不重复计数或改写首次 `importedAt`。并行 commit 与其他看板事务共享串行队列及 revision CAS；409 不自动重试。新导入只递增审计 revision，不改任务状态/验收结果。容量预检包含导入元数据开销；没有默默清理旧数据。写入先持久化忽略目录中的日志，再更新 board revision；中途崩溃可重启核对并完全重放，不能宣称未确认事务成功。

只导入**明确 stop、完整且全部有效**的 native 会话。无换行的坏尾、完整坏记录、未知隐私字段、来源/build 不一致、乱序/重复 ID、暂停期事件或未结束会话均整份拒绝；不把前半段“救回”作为完成证据。拒绝内容不落盘，错误响应不回显被拒内容。已存 native 文件出现坏尾会阻止证据解析，需离线复核。旧原型 JSONL 保持兼容，不转换/重标来源。

导入保留 `occurredAt`、`collectedAt`、`source`、`build`、ID；兼容读取字段 `timestamp=occurredAt,receivedAt=collectedAt`，**另外记录**首次 `importedAt`。native 验收同时要求原始发生和采集时间严格晚于最近实质验收标准变化（及新任务创建），不能用今天的 `importedAt/receivedAt` 给旧记录“洗新鲜度”；未来日期也不接受。原型旧日志继续以其服务器原始 `receivedAt` 为采集边界，不把旧客户端 timestamp 误当可信收集时钟。`source` 仍是类别声明而非真实人身份认证；助手/自动测试导入仍不能替代实际用户使用。导入成功不代表任务完成，只有 `assess` 全覆盖同构建测试和实际使用才能完成。

正式 controller 在 `record()` 调用当下固定 `occurredAt`（UTC 毫秒），Rust 写入时生成 `collectedAt`，避免 IPC 排队延迟把旧操作改成新操作。后端校验发生时间属于当前会话、不在未来且不倒退；未提供发生时间的后端内部调用以采集当时为发生时间。两类原始时间各自按序保存，导入不会用晚到的采集/导入时间覆盖它们。

## Completion gate

Only `assess` can enter `done`, and only from `readyforusage`. Ready/inprogress do not require dependencies done; readyforusage requires dependencies readyforusage/done; pass requires all dependencies done.

Verdict: `{decision:'pass'|'fail'|'insufficient',rationale,build,coverage:[{acceptanceId,evidenceIds,usageEventIds}],limitations:[]}`. Pass requires every applicable criterion and **all** of its scenario IDs to have registered passed same-build evidence and complete same-build task/scenario-matched usage coverage received after the latest substantive criterion change, at least one actual `userusage` session event, at least one selected passed test/browser record, and no registered failed evidence for that build. References/test claims remain declarations requiring truthful registration; the backend does not execute them. Do not record synthetic fixtures as production evidence.

Successful usage result codes are `success/passed/verified` (or uppercase). Verified negative scenarios are supported explicitly with `EXPECTED_FAILURE_OBSERVED`, `EXPECTED_FAILURE_VERIFIED`, `EXPECTED_ERROR_VERIFIED`, `EXPECTED_CANCEL_VERIFIED`, `EXPECTED_BLOCK_VERIFIED`, `EXPECTED_REJECTION_VERIFIED`, `CONFLICT_STOP_VERIFIED`, `CANCEL_STOP_VERIFIED`, `TRUST_REVOKE_STOP_VERIFIED`, `STALE_TARGET_REJECTED_VERIFIED`. These mean the intended negative behavior itself was verified and must be explained in the assessment rationale; arbitrary errors/failures do not count. Criterion scenario IDs must correspond to the actual recorded scenario, not just a task label. Change criteria through update before assessment when needed.

Reopen with transition to inprogress/ready: prior evidence and history remain, verdict/checkmarks reset. A failed or insufficient assessment stays readyforusage, not done.

## Persistence / recovery

Transactions serialize the complete read-check/CAS/command/backup/write operation. The board is written to an exclusive temporary file, fsynced, then renamed over the original without deleting the old file first. `.local/backups` retains at most 20 snapshots / 20 MiB. Corrupt JSON/schema, missing files or an external byte/hash modification cause refusal, never silent reseed/overwrite. Stop the server and review a backup offline to recover. `.local` is ignored by git. Never edit a live board by hand.

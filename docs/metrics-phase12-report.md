# Harness Supervisor 任务度量阶段一/二交付报告

- 日期：2026-10-27
- 版本：0.5.0
- 分支：`feat-261025-task-metrics`
- 范围：只完成 SPEC 的阶段一（现状审计与最小数据模型）和阶段二（基础统计与任务报告）
- 明确不实现：费用采集（当前多为积分制，无法直接核对）、首次验收、返工、人工干预、HS/非 HS 对照分析（阶段三/四）

## 1. 现状审计结论

实现前检查了当前 `main`（`e8ce68e`）、Worker 状态机、事件日志、Store、Supervisor、IPC、CLI、MCP、通知与测试。

关键事实：

1. `WorkerRecord` 已有 `createdAt`、`startedAt`、`endedAt`、`status`、`stats`，但没有任务 ID 或用量字段。
2. Qoder 适配器已经把 `result.usage` 写入一条 `run.progress`（`kind=usage`）的 `detail` JSON；该字段仅作展示，不是稳定结构化数据，也不是任务级权威记录。
3. Pi 适配器忽略了 assistant message 中原生的 `usage`；真实 Pi 是否提供该字段取决于 provider/message，不能假定。
4. MiniMax Code 的 ACP 适配器没有消费任何用量事件。最新 0.6.13 真实单轮捕获：`session/prompt` 响应只有 `stopReason`，没有 usage；`usage_update` 只有上下文 `used=20269`/`size=1000000` 和 `cost.amount=0 USD`，不是输入/输出 Token 消耗。其 headless `exec --output-format json` 有结构化 usage，但 HS 的 mcode 适配器走 ACP，且不读取 mcode 私有会话库。因此当前不生成 mcode Token 记录，Token 用量保持未知；费用也不采集。
5. HS 无法从 Codex/GPT 宿主会话可靠读取主 Agent 的完整 token；只能显式补录。
6. 现有通知、ACK、幂等、保留策略、取消/恢复语义均与度量无关，应保持不动。

因此采用独立度量存储和事件旁路，不修改 Worker 状态机。

## 2. 数据模型与持久化

代码：`src/metrics.ts`。

### 2.1 TaskRecord

- `id`：稳定的 `t-...` 任务 ID；也允许调用方提供固定 ID。
- `title`、`category`、`executionMode`（当前只允许 `delegated`）、`createdAt`、`updatedAt`。
- `workerIds`：默认单 Worker，可显式关联多个 Worker。
- `parentSessionRef`：可选的不透明主 Agent 会话引用；不从环境推断。
- `acceptanceStatus`：默认 `pending`；阶段一/二不写入验收结果。
- `createdBy`：`spawn` / `mcp` / `cli` / `manual` / `import`。

任务状态不写入 TaskRecord，而是在读取时由现有 Worker 记录派生，避免出现第二套 Worker 状态机：

- 无 Worker → `pending`
- 有活动 Worker → `running`
- 有 failed/crashed → `failed`
- 有 interrupted/orphaned → `interrupted`
- 全部 completed → `completed`
- 全部 cancelled → `cancelled`
- 缺失 Worker 或混合终态无法唯一判断 → `unknown`

### 2.2 UsageRecord

- `id`、`taskId`、`workerId`、`role`（`parent_agent` / `worker`）。
- `provider`、`modelId`、`harness`。
- `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reportedTotalTokens`；未知一律 `null`。
- `usageSource`：`runtime_reported` / `host_reported` / `manual` / `imported` / `estimated`。
- `attribution`：`exact` / `incremental` / `session_level` / `estimated`。
- `confidence`：`verified` / `partial` / `unverified` / `unknown`。
- `recordedAt`、可选短备注。

规则：

- 不把 input/output/cache 相加，也不把 `reportedTotalTokens` 加到分项。
- 运行时全零报告转为 `null` + `unverified`，不当作真实零消耗。
- `session_level` 主 Agent 用量只进入 `sessionLevelParentUsage`，不进入任务总量。
- `usageId` 提供幂等：相同 ID + 相同内容返回原记录；不同内容报 `CONFLICT`。
- 运行时记录 ID 为 `runtime:<workerId>:<eventSeq>`，同一事件不会重复计入。

### 2.3 存储

- 文件：`<stateDir>/metrics/metrics.jsonl`，目录/文件权限 `0700/0600`。
- 每行 `{schemaVersion, kind:"task"|"usage", task|usage}`。
- 追加写入；读取时 last-wins，损坏行、截断尾行和不支持 schema 被忽略并产生警告。
- `init` 只读一次；运行中更新任务 `workerIds` 通过追加新版本实现。
- 当前没有自动清理策略；`prune` 不删除度量日志，长期保留列入后续工作。
- 度量写入失败只记录警告，不阻断 Worker 生命周期；无法初始化时 `metricsReady=false`，度量接口返回 `UNSUPPORTED`。

## 3. Worker 关联与用量采集

### 3.1 关联

- `WorkerRecord` 增加可选 `taskId`，旧记录保持未知，不猜测历史归属。
- `spawn` 未提供 `taskId` 时自动创建一个 `delegated` 任务（标题来自 `name`，否则为 `delegated <runtime> task`），并把新 Worker 写入 `workerIds`。
- 需要多个 Worker 同一任务时，先 `metrics create` / `metrics_task_create`，再在 `spawn` 传 `--task` / `taskId`。
- 显式 `taskId` 不存在时返回 `NOT_FOUND`；度量存储不可用时不会为了统计阻断 Worker，只会跳过关联并记录告警。
- `resume` 保留原 `taskId`；旧 Worker 没有 `taskId` 时不自动补建，避免把历史运行错归到新任务。

### 3.2 运行时事件

- `HarnessEvent` 新增 `{type:"usage", usage}`；`WorkerEventType` 新增 `run.usage`。
- Supervisor 将数值字段截断为非负整数后写入事件，不写结果文本；订阅 Store 事件流写入 MetricsStore。
- Daemon 重启后扫描已持久化的 `run.usage` 事件，按 `runtime:<workerId>:<seq>` 去重补账。

### 3.3 各 Harness 实际来源

| Runtime | 来源 | 处理 |
| --- | --- | --- |
| Pi | assistant message 的 `usage`（input/output/cacheRead/cacheWrite/totalTokens） | 每次 `message_end` 累加，`agent_settled` 时发一条 `run.usage`；字段缺失保持未知 |
| Qoder | `result.usage` | 同一 settle 窗口只取最后一个 result 的 usage，避免近似重复 result 重复计数 |
| MiniMax Code | 最新 0.6.13 实测：ACP `usage_update` 只有上下文 used/size 与 cost=0 USD；prompt result 只有 stopReason；headless `exec --output-format json` 有 usage，但 HS 走 ACP | 当前未消费，不生成 UsageRecord；报告显示 Token 用量未知；不读私有会话库，不用上下文量代替 Token |
| 主 Agent | 无宿主读取 | 只能通过 `metrics_record_usage` / `metrics_record-usage` 显式补录 |

## 4. 报告

代码：`MetricsStore.taskMetrics()` / `MetricsStore.report()`。

单任务报告包含：

- 存储的 TaskRecord、派生状态、时间线（createdAt/startedAt/finishedAt/endToEndMs/waitingMs）。
- 关联 Worker 的运行时、状态、startedAt/endedAt、单 Worker 运行时长；缺失 Worker 标记 `missing`。
- 原始 usage 记录。
- Worker、可归属主 Agent、session-level 主 Agent、unverified 的用量汇总。
- 警告与 `unknownFields`。

汇总报告包含：

- 任务状态计数、Worker 数。
- 覆盖率：有 Worker、有 Worker 用量、有可归属主 Agent 用量、session-level、verified、unverified、缺失 Worker。
- 每类用量的记录数/可用数/verified/partial/unverified/unknown，以及每个 token 字段的值、已知记录数、缺失记录数。
- 端到端耗时、Worker 运行时长、单 Worker 等待时间的已知数、缺失数、总和、平均、中位数、最小/最大。
- `notTracked`：费用、首次验收、返工、干预、对照基线。
- `unknownFields`、`dataQualityWarnings`。
- 可选任务详情（`includeTasks`，`limit` 只截断详情，聚合计数仍覆盖全部选中任务）。

耗时只使用可解析的时间戳；负数或缺失时间保持未知。`workerRun` 是各 Worker 运行时间之和，不是墙钟；`waiting` 只在单 Worker 任务上派生，并包含进程启动与 supervisor 开销。

## 5. 接口

### IPC

`metrics_task_create`、`metrics_task_show`、`metrics_report`、`metrics_usage_record`；`spawn` 增加可选 `taskId`。所有参数使用 zod strict schema。

### CLI

```text
metrics create --title <title> [--category <c>] [--task-id <id>] [--parent-session <ref>]
metrics show <taskId>
metrics report [--since <iso>] [--until <iso>] [--include-tasks] [--limit 500]
metrics export [--since <iso>] [--until <iso>] [--limit 500]
metrics record-usage <taskId> --role parent_agent|worker [--worker <id>] ...
```

`metrics export` 总是输出 JSON；`metrics report --json` 也是机器可读结构。`spawn --task <taskId>` 用于多 Worker 关联。

### MCP

`metrics_task_create`、`metrics_task_show`、`metrics_report`、`metrics_record_usage`。旧 daemon 未提供 0.5.0 metrics IPC 时，工具返回明确 `UNSUPPORTED` 升级提示，不伪造数据。

## 6. 修改文件

新增：

- `src/metrics.ts`
- `test/unit/metrics.test.ts`
- `test/integration/metrics.test.ts`
- `test/integration/metrics-cli.test.ts`
- `test/integration/metrics-mcp.test.ts`
- `docs/metrics-phase12-report.md`
- `evidence/metrics-phase12-261025/`

修改：

- `src/types.ts`：`taskId`、`run.usage`、`usage` HarnessEvent
- `src/adapters/pi/session.ts`：usage 累加与 `run.usage`
- `src/adapters/qoder/session.ts` / `adapter.ts`：结构化 usage，settle 窗口去重，模型标识
- `src/supervisor.ts`：MetricsStore 生命周期、任务关联、usage 事件、度量 API、重启补账
- `src/store.ts`：无改动（通过现有事件流订阅）
- `src/ipc/protocol.ts` / `server.ts`：metrics IPC
- `src/cli.ts` / `src/mcp.ts` / `src/mcp-presentation.ts`：CLI/MCP 接口、taskId 呈现
- `package.json`、`package-lock.json`、`src/version.ts`：0.5.0
- `README.md`：使用说明与边界
- `test/integration/mcp-modes.test.ts`：production worker 字段新增 `taskId`；中断测试改为等待 Worker 记录落盘后再杀 daemon
- `test/unit/notify.test.ts`：投递突发窗口断言改为检查首次尝试已开始，不依赖本机进程启动耗时
- `test/integration/helpers.ts` / `test/integration/idempotency.test.ts`：新增 `waitForWorkerRecord`，修正 admission 标记到 Worker 记录之间的中断窗口

## 7. 测试与证据

详细结果与复现命令见 [`evidence/metrics-phase12-261025/README.md`](../evidence/metrics-phase12-261025/README.md)。

- 单元 `metrics`：12 项通过
- 集成 `metrics`：5 项通过（假 Pi、假 Qoder、重启、统计故障隔离）
- CLI `metrics`：1 项通过
- MCP `metrics`：1 项通过
- 真实 Qoder 单轮：`qodercli 1.1.78` + `DeepSeek-Flash`，结果 `METRICS_REAL_OK`；Qoder 只报告全零 usage，系统记录为 `unverified`/`null`，未伪造零消耗
- 真实 MiniMax Code 最新 0.6.13 ACP 单轮：prompt result 只有 `stopReason`，`usage_update` 只有 `used=20269`/`size=1000000` 与 `cost=0 USD`，无 Token 分项；证据见 [`evidence/mcode-usage-probe-261027/`](../evidence/mcode-usage-probe-261027/README.md)
- 完整回归：253 项，251 通过，0 失败，2 跳过（真实 Pi E2E 默认门控），409.9s；命令 `node test/run.mjs`

回归过程中发现并修正了两个与本机进程启动耗时相关的测试竞态，生产语义未改变：

1. 通知突发测试原先要求 480ms 突发窗口内完成一次真实投递；本机 Node 进程启动约 300–540ms 时必然失败。现改为断言首次投递尝试已开始（`lastAttemptStartedAt`），仍验证“后续事件不会重置首个窗口”。
2. 中断/重启测试原先只等待幂等 admission 标记就杀 daemon。度量自动建任务使“admission 已写、Worker 记录未建”的合法窗口变宽；现改为等待 `worker.json` 落盘后再中断，仍验证重试返回 `UNCERTAIN` 且不生成第二个 Worker。

**证据分级：**

- 真实：Qoder 单轮 worker、任务自动关联、`run.usage` 写入、全零→未知处理、任务完成与耗时；MiniMax Code 0.6.13 ACP 单轮确认无 Token 分项。
- 模拟：Pi/Qoder 的 token 数值、多 Worker、幂等、重启、CLI/MCP 全链路。
- 未验证：真实 Pi token 数值、Qoder 非零 token 数值、真实主 Agent 用量补录；MiniMax Code 最新 0.6.13 的 ACP Token 分项已实测未提供，headless exec 的 usage 未验证。

## 8. 已知限制

1. 不采集费用（当前多为积分制，无法直接核对）；Qoder 的 `total_cost_usd`/`total_credits` 只留在 progress detail，不进入度量。
2. 没有验收、返工、干预统计；Worker `completed` 不等于验收通过。
3. 没有自动读取主 Agent 用量；`session_level` 数据不会进入任务总量。
4. 没有与 provider 账单核对；`verified` 目前没有自动来源。
5. `direct` 任务未实现；当前只支持委托任务。
6. 度量日志没有自动清理；`prune` 不处理度量记录。
7. 任务与 Worker 的关联在 spawn 前创建；极端写入失败可能留下没有 Worker 的任务记录或没有任务的 Worker，报告会给出警告。
8. 真实 Qoder 1.1.78 本次只返回零 token；不能据此推断 Qoder 的 token 统计能力。
9. 统计模块的读写失败不会阻断 Worker，但可能造成该 Worker 没有任务/用量记录。
10. MiniMax Code 最新 0.6.13 的真实 ACP 单轮未提供 Token 分项：prompt result 只有 stopReason，usage_update 只有上下文 used/size 与 cost=0。其 headless `exec --output-format json` 的 usage 未被 HS 使用；不读取私有会话库，因此 mcode Token 用量保持未知。

## 9. 后续工作

- 阶段三：AcceptanceRecord、Rework、Intervention，明确人工与 Agent 操作来源，不自动推断。
- 阶段四：与非 HS 任务的可比对照与导出；费用明确不采集（积分制无法核对），不引入 CostRecord。
- MiniMax Code：最新 0.6.13 的 ACP 实测未提供 Token 分项；若上游在 prompt result 填充 usage 可直接接入。不得用上下文 `used`/`size` 代替 Token 消耗，也不自动读取 mcode 私有会话库；headless `exec --output-format json` 的 usage 只在非交互 worker 场景评估。
- 度量日志保留与清理策略，确保不破坏活跃任务和未确认通知。
- 真实 Pi / 其他 provider 的 usage 字段核对，以及真实主 Agent 增量补录流程。
- 需要时支持 direct 任务和对照分析；不得为了证明 HS 价值强行委派。

## 10. Git

- 分支：`feat-261025-task-metrics`
- 基线：`main` = `e8ce68e`（0.4.4）
- 提交：见 `git log --oneline main..HEAD`
- 未提交的旧 Qoder 证据目录（`evidence/qoder-*-1.1.78/`）与本任务无关，未纳入度量提交。

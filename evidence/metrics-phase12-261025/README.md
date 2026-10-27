# 任务度量阶段一/二证据（0.5.0）

- 日期：2026-10-27
- 分支：`feat-261025-task-metrics`
- 范围：TaskRun / UsageRecord 数据模型、独立追加日志、Worker 自动关联、运行时用量采集、单任务与汇总报告、CLI/MCP/IPC
- 不包含：费用采集（积分制无法直接核对）、首次验收、返工、人工干预、对照基线（阶段三/四）

## 真实 Qoder 单轮烟测

环境：Windows，`qodercli 1.1.78`，模型 `DeepSeek-Flash`，仅一次文本任务（无工具）。隔离状态目录与临时 daemon，未触碰生产 daemon。

- Worker：`w-mvqa1ni2-6f884c43`（`runtime=qoder`，`completed`）
- Task：`t-mvqa1ni2-7327a31e`（自动创建，`createdBy=spawn`）
- 最终文本：`METRICS_REAL_OK`
- 事件：`run.usage` 被写入，字段为 Qoder 报告的 input/output/cache=0
- 度量结果：五个 token 字段全部保存为 `null`，`confidence=unverified`，注释明确“全零不等于已核实的零消耗”
- 报告：`knownWorkerUsage.usableRecords=0`，`unverifiedUsage.records=1`，警告包含“worker cost is unknown”
- 时间：`endToEndMs=19227`，`workerRun=6298`，`waiting=12929`（单 Worker，含启动开销）

原始脱敏结果：[qoder-real-task.json](qoder-real-task.json)、[qoder-real-report.json](qoder-real-report.json)。

**结论：真实 Qoder 路径能进入同一任务记录；本次 Qoder 没有报告非零 token，因此没有把零值当作真实消耗。没有验证 Qoder token 数值的准确性。**

## 假 Pi 受控烟测

使用脚本化 Pi fixture（`usage: input=10, output=5, totalTokens=15`）：

- 每个 `spawn` 自动创建任务并关联 `taskId`
- `run.usage` 进入独立度量日志
- 单任务报告显示 `inputTokens=10`、`outputTokens=5`、`reportedTotalTokens=15`，`confidence=partial`
- 未补录主 Agent 用量时，报告明确警告 `main-agent cost is unknown`
- 不把 cache token 加到 input/output，也不把 `reportedTotalTokens` 与分项相加

## 自动化测试

| 套件 | 结果 | 覆盖 |
| --- | --- | --- |
| `test/unit/metrics.test.ts` | 12 passed | 持久化、损坏行、幂等补录、冲突、未知值、全零、终态分类、覆盖率、耗时、范围与截断 |
| `test/integration/metrics.test.ts` | 5 passed | 自动/显式任务、多 Worker、Pi/Qoder usage、重启去重、统计故障隔离 |
| `test/integration/metrics-cli.test.ts` | 1 passed | CLI create/show/report/export/record-usage |
| `test/integration/metrics-mcp.test.ts` | 1 passed | MCP 四个 metrics 工具 |
| 完整回归 | 253 tests / 251 pass / 0 fail / 2 skipped（409.9s） | 现有生命周期、通知、ACK、事件历史、Qoder 回归；2 项真实 Pi E2E 默认跳过 |

回归中修正了两个与本机进程启动耗时相关的测试竞态（不改变生产语义）：通知突发测试改为断言首次投递尝试已开始；中断/重启测试改为等待 `worker.json` 落盘后再杀 daemon，因为度量自动建任务使 admission 到 Worker 记录之间的合法窗口变宽。

## 边界

- 真实 Qoder 的 token 字段在本次运行中全为零，只能证明“未知处理正确”，不能证明 token 数值可信。- 未做真实 Pi 的 token 采集验证；Pi 路径只经过脚本化 fixture。
- MiniMax Code 最新 0.6.13 已做一次真实 ACP 单轮探测：`session/prompt` 响应只有 `stopReason`，`usage_update` 只有上下文 `used=20269`/`size=1000000` 与 `cost=0 USD`，没有 input/output Token 分项。因此 mcode Token 用量保持未知；详见 [../mcode-usage-probe-261027/README.md](../mcode-usage-probe-261027/README.md)。
- 主 Agent 用量不会从 Codex/GPT 会话自动读取；本次未做真实主 Agent 补录，只做受控 CLI/IPC 测试。
- 度量日志当前不自动清理，`prune` 不会删除它。
- 费用不采集（当前多为积分制，无法直接核对），`total_cost_usd` 等报文不入度量。

## 复现

```bash
npm run build
node --test --test-concurrency=1 \
  dist/test/unit/metrics.test.js \
  dist/test/integration/metrics.test.js \
  dist/test/integration/metrics-cli.test.js \
  dist/test/integration/metrics-mcp.test.js
```

真实 Qoder 烟测使用的是隔离状态目录与临时 daemon，运行后已 `down`；原始 Qoder session 内容未复制到仓库。

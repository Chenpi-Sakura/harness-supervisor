# MCP production/development 输出模式验证（2026-10-23）

工作树：`feat-261023-mcp-output-modes`（隔离开发工作树，未合并 main，未 push）。

## 验证范围

- 修复前全量：`npm run test:unit`（79 通过）、`npm run test:integration`（74 通过）。
- 交付前修复后按用户要求只跑针对性回归：`dist/test/unit/mcp-presentation.test.js` 5 通过；`dist/test/integration/mcp-modes.test.js` + `mcp.test.js` 10 通过；`npm run build`、`npm run typecheck` 通过。未重复运行 4 分钟全集。
- 新增/更新测试：
  - `test/unit/mcp-presentation.test.ts`：模式解析、CONFLICT/UNCERTAIN 错误标识、事件管理字段与用户内容分离、仅当前轮去重、无 result 保留、20KB 当前轮报告、无额外报告长度限制、`pendingInput` 全字段。
  - `test/integration/mcp-modes.test.ts`：真实 MCP stdio 握手、CLI/env 优先级、非法值拒绝、production/development 字段差异、长报告、跨 resume 历史报告、原生 `needs_input` -> `answer`、失败原因、幂等重放/CONFLICT、MCP 层的 UNCERTAIN、事件分页、显式 progress、未确认通知不被旧已确认记录遮挡、路由持久化、旧 daemon fixture 兼容处理。
- 上述自动化使用 fake harness + TestDaemon；另由主 Agent 独立执行下文的真实 Pi 验收。未执行真实 Qoder 或本轮 Codex 桌面主动唤醒 E2E。

## 固定输入的字节对比

同一已完成 Worker，同一 `worker_wait` 请求（until=terminal）通过真实 MCP stdio 返回：

| 模式 | 返回字节数 |
| --- | --- |
| production | 20,593 |
| development | 32,350 |

说明：

- 这是同一固定测试输入的**返回字节数**（UTF-8），不是精确 Token 数，也不代表账单节省；其中包含 development 的缩进/完整诊断字段差异。
- 长报告测试使用 20,000 字符报告，production 的 `worker.result` 完整包含首尾标记，最终报告只在返回中出现一次；`run.completed.data.text` 不再重复。

## 关键证据

- 两种模式均通过 MCP stdio 初始化和工具调用；`--mode` 覆盖 `HARNESS_SUPERVISOR_MCP_MODE`，默认 production；非法 CLI/env 值在启动时退出码 1，并在 stderr 指明具体配置项。
- production 的 `worker_spawn` 仅含 `id/runtime/status/lastSeq/notifyTarget`；`worker_status` 默认不含 `recentEvents`/`stderrTail`/PID/session 诊断字段。
- development 保留旧结构（`recentEvents` 默认 20、`stderrTail`、PID/sessionFile/supervisorId/config/stats 等）。
- production 通知默认先过滤已确认记录再应用 `limit`：预置 80 条已确认旧记录且 `limit=5` 时，新未确认通知仍被返回。
- MCP 层 UNCERTAIN：daemon 在 spawn 准入后被 kill，重启后同 requestId 经 production MCP 返回 `UNCERTAIN`（含 requestId），Worker 列表只有 1 条，未重复执行。
- `worker_wait` 去重修复：只有 `run.completed` 属于当前轮（事件时间不早于当前轮 `startedAt`）且事件文本确实是 `worker.result.text` 的前缀时才删除事件文本；跨 resume 的旧报告保留，当前轮 20KB 报告仍只出现一次，无 result 时一律保留。事件 `nextSeq` 语义未改变。
- 旧 daemon 独立 fixture：production 启动检测到 daemon 0.2.0 后以退出码 1 报错，明确要求备份、确认无活动 Worker、人工升级并重启 daemon，未自动重启/替换；development 可连接，`wake_target` 使用旧 `notifications.target` 读取默认目标且不返回收件箱记录，未发送 `unacknowledgedOnly`，未调用旧服务不存在的 `notification_target_get`。
- production 呈现层未新增报告长度限制；`pendingInput` 的 requestId/method/title/message/options/placeholder/prefill/createdAt/expiresAt 均保留。
- 显式 `state` 过滤仍保留原语义；development 通知记录仍包含 target/delivery/createdAt。
- 路由绑定在 production/development 间一致，持久化 Worker 记录和通知记录未被模式改变。

## 主 Agent 独立复核与真实 Pi 验收

主 Agent 复跑 `mcp-presentation.test.js`、`mcp-modes.test.js` 和原有 `mcp.test.js`，共 **15/15 通过**；`npm run typecheck` 和 `git diff --check` 通过。最初独立复现的两种历史报告丢失情况（恢复后 running 且无当前结果、恢复后已有新结果但读取旧完成事件）在修复后均保留旧报告及原游标。

使用候选构建启动独立 0.3.0 测试 Daemon，两个真实 MCP stdio 客户端分别采用 production / development，共同观察同一个原生 Pi Worker `w-mvkr6j9z-b4256a84`：

1. Pi 原生扩展调用 `ctx.ui.input`，production `worker_wait` 返回完整 `pendingInput` 与 `awaiting_input`。
2. production `worker_answer` 提交 `HS_INPUT_OK` 后，Pi 继续实际执行。
3. 主 Agent 读回真实文件内容 `HS_MODE_NATIVE_OK`；任务为 completed，最终报告的首尾标记完整，等待返回中没有重复报告。
4. 同一 Worker 在两模式下的最终报告完全相同；production 不含 sessionFile / PID / stderrTail / 默认过程事件，development 保留诊断。
5. 两条重要通知（输入请求、完成）均由 production 收件箱读到并确认；随后关闭独立测试 Daemon。未改生产 Daemon、用户配置或主目录构建。

同一真实 Worker 的 `worker_status` 返回量为 production **509 bytes**、development **7,441 bytes**，本样本减少约 **93.2%**。两模式原始工具 schema 分别为 **14,008 / 15,967 bytes**。上述均为 UTF-8 字节数，不是 Token 或账单节省比例，且会随报告和实际任务变化。精简记录见 [real-pi.json](real-pi.json)，独立回归输出见 [review-tests.txt](review-tests.txt)。

本次原生 Pi 验收通过 IPC 创建带原生输入扩展的 Worker，通过生产 MCP 等待、回答、读结果和确认通知；MCP `worker_spawn` 的模式契约由上文自动化覆盖。它不等于重新验收 Codex 桌面主动唤醒。

# Codex 主动唤醒端到端实验（阶段 1）

- 时间：2026-10-22（UTC 07:24–07:27）
- 环境：Windows、`codex-cli 0.161.0`（真实 Codex agent，`codex app-server` 会话）、HS 本仓库代码、模拟 Worker（fake harness，计划允许）
- 隔离：独立临时 HS 状态目录与独立临时工作目录；未触碰用户正在使用的 Codex 桌面会话，也未修改 `~/.codex` 配置

## 实验流程（与计划中的验收步骤一一对应）

1. 启动独立 HS daemon（`notification_target = codex-queue`，thread 在下一步拿到后再登记）。
2. 用真实 `codex app-server` 建立 Codex 会话（thread），并通过 `thread/start.config` 挂载真实 `dist/src/mcp.js`（harness_supervisor MCP server），审批策略 `approvalPolicy: never` + 该 MCP server `default_tools_approval_mode: approve`。
3. 通过 IPC 把该 thread 登记为通知投递目标。
4. **Codex 创建 Worker**：第一轮 prompt 要求 Codex 只调用一次 `worker_spawn`（模拟慢 Worker），然后立即结束回合、不要等待。
5. **Codex 当前回合结束**：第一轮 `turn/completed`。
6. **Worker 在回合结束后才完成**：模拟 Worker 耗时 45s，而 Codex 回合约 19s 结束。
7. HS 在 Worker 完成时生成通知并通过官方 `codex queue --thread … --message …` 投递。
8. **外部事件触发 Codex 自动继续**：Codex 宿主自行开始第二轮 turn（无任何外部 `turn/start` 调用）。
9. 第二轮中 Codex 读取 Worker 结果并作答。

## 结果（`result-late-worker.json`）

| 观测点 | 时间 |
| --- | --- |
| Codex 第一轮 turn 开始 | 07:25:36.456 |
| Codex 第一轮 turn 完成（回合结束） | 07:25:55.343 |
| Worker 完成 → 通知投递成功（`codex queue`，attempts=1） | 07:26:35.755 |
| Codex **自动开始第二轮 turn** | 07:26:43.830 |
| 第二轮 turn 完成 | 07:27:00.371 |

- 第一轮回复：`w-mvj7vkgn-70fba0e8`（只有 Worker ID，说明 Codex 按指令结束了回合，没有等待结果）。
- 第二轮回复：`Worker w-mvj7vkgn-70fba0e8 completed successfully. Result: FAKE_PI_OK.`
- 通知收件箱：`delivered=1, pending=0, failed=0, unacked=1`；Worker 终态 `completed`。
- `turnsStarted=2`，其中第二个 turn 由宿主自己的队列 drain 触发。

另一份 `result.json` 是同一脚本的首次运行（Worker 恰好与回合结束同时完成），结论相同。

## 结论与分级

- **A 级唤醒的机制已真实打通**：Codex 回合结束后，Worker 完成 → HS 用官方 CLI 投递到 thread 队列 → Codex 宿主自动开始新 turn 并读到 Worker 结果。全程使用官方支持的 `codex app-server` 协议与 `codex queue` CLI，没有进程注入、没有修改会话数据库、没有模拟 UI 输入。
- **仍需用户侧最后一步确认**：本实验的 Codex 会话是由探针建立的 app-server 会话（与桌面端使用同一套协议），不是用户当前正在看的桌面窗口，因此“桌面端在回合结束后是否仍保持该 thread 加载并自动 drain 队列”需要在用户自己的桌面会话里做一次确认。若桌面端卸载了 thread（例如窗口关闭或切换会话），消息会留在队列中直到该 thread 再次被加载——这正是 E1 观测到的行为。
- **B 级（独立受控会话）**：本实验本身就是 B 级形态（HS 之外的探针管理 Codex 会话），但它同时证明了 A 级所需的宿主行为。
- **C 级（本地收件箱）**：始终可用，作为桌面端未加载 thread 时的兜底；默认通道即为此。

## 限制

- 模拟 Worker 而非真实模型 Worker（计划第 3 步允许模拟）；Worker 生命周期与真实 Pi 一致（同一 adapter）。
- Codex 会话使用探针管理，认证沿用当前 ChatGPT 登录；两轮对话的额度消耗未单独计量。
- 未验证窗口关闭、应用退到后台、多窗口等桌面端状态；这些属于宿主行为，不在 HS 控制范围内。
- 投递为 at-least-once；本实验 `attempts=1` 且收件箱记录 `delivered`，未观察到重复消息。
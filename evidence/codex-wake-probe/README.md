# Codex 主动唤醒可行性探测（阶段 1）

- 时间：2026-10-22（UTC 06:07–06:14）
- 环境：Windows、`codex-cli 0.161.0`（桌面端安装的 Codex 同时运行着 `codex app-server`）、模型 `gpt-6-luna`（低推理强度，仅用于最小实验）
- 目的：判断 Pi/Qoder Worker 完成后，外部事件能否自动让**已经结束推理回合的 Codex 会话**继续处理（A 级目标）。

## 结论摘要

| 能力 | 结果 |
| --- | --- |
| 用 `codex queue --thread <id> --message <text>` 向任意已持久化 thread 追加一条消息 | 支持，写入共享队列 `~/.codex/queue_1.sqlite` |
| 当有 app-server 客户端**加载**该 thread 且其处于 idle | 队列在约 2.5 秒内被自动排空，**自动开始一个新的 turn**（无需再调用 `turn/start`） |
| 当**没有任何客户端加载**该 thread（例如 `codex exec` 跑完后退出） | 消息只留在队列中，15 秒以上没有 turn 被启动，rollout 文件不增长 |
| app-server 对外公开的会话控制接口 | `thread/resume`、`turn/start`、`thread/queue/add`、`thread/queue/start`、`thread/queue/list` 等（`codex app-server generate-json-schema --experimental`） |

因此：**A 级唤醒在本机存在受支持的实现路径**，其机制是“外部写入 thread 队列 + 宿主自带的 queue drain”。是否真的能唤醒“Codex 桌面端当前这条对话”，取决于桌面端是否已加载该 thread（窗口打开、会话处于 idle），这一条必须在桌面端做真实验收（见下文“待验收”）。

## 实验 E1：thread 无客户端加载时不排空

1. `codex exec --json --skip-git-repo-check "Reply with exactly: SEED-OK"` 创建 thread `01a16239-2158-7242-a064-e979ff702903`，turn 正常完成，进程退出（`evidence/codex-wake-probe/e1-exec-thread.jsonl.txt`）。
2. 运行 `codex queue --thread 01a16239-… --message "Reply with exactly: WAKE-OK"`。
   - 输出：`Queued message 01a16239-9202-… for thread 01a16239-…`，退出码 0。
3. 之后持续观察 15 秒以上：
   - rollout `rollout-2026-10-22T14-07-55-01a16239-….jsonl` 大小始终为 87616 字节，最后一条仍是原 turn 的 `task_complete`；
   - 没有新的 `turn/started`。

结论：队列写入是持久的，但**没有加载该 thread 的客户端时不会执行**。这也说明“单纯写队列”不等于唤醒。

## 实验 E2：thread 被加载时队列自动执行

用一个自建的 app-server 探针（JSONL stdio，`initialize` → `thread/start` → `turn/start`）加载新 thread `01a1623d-d0a4-7493-b44d-5d1143efb6fe`，seed turn 完成并等待 idle 后，**从另一个进程**执行 `codex queue --thread 01a1623d-… --message "Reply with exactly: PROBE-WAKE"`：

```
06:13:07.632  turn/completed  PROBE-SEED
06:13:08.204  QUEUE_EXIT 0    Queued message … for thread 01a1623d-…
06:13:10.752  thread/status/changed {"status":{"type":"active"}}
06:13:10.753  turn/started    {"turn":{"id":"01a1623d-f7a3-…","status":"inProgress"}}
06:13:10.806  item/started    userMessage "Reply with exactly: PROBE-WAKE"
```

- 从写入队列到自动开新 turn：约 2.5 秒。
- 队列项在排空后被删除：事后查询 `queued_items` 只剩 E1 写入的那条（已在实验后手工删除，避免遗留消息在用户以后再打开该 thread 时被执行）。
- 完整日志见 `e2-auto-drain.txt`（截取关键行）。

结论：**只要 thread 处于“已加载 + idle”，外部 `codex queue` 就能让该会话自动继续**，且过程完全走 Codex 官方 CLI / app-server 队列，不需要注入桌面进程、修改会话数据库或模拟 UI 输入。

## 与 A / B / C 分级的对应

- **A 级（唤醒原桌面会话）**：机制已具备（E2）。待验收的关键在于“Codex 桌面端在回合结束后是否仍然加载该 thread 并自动排空队列”。需要一次真实桌面端实验：
  1. 桌面端开始一条对话，Codex 创建 HS Worker 后结束当前回合（idle，窗口保持打开）；
  2. Worker 稍后完成，HS 用 `codex queue --thread <该 thread> --message "<完成通知>"` 投递；
  3. 观察桌面端是否自动开始新 turn，并读取 Worker 结果（rollout 文件出现新的 `userMessage(clientId=…)` + assistant 回复）。
- **B 级（独立受控会话）**：已具备（探针即是）。可用 `codex app-server` + `thread/resume`/`turn/start` 或 `codex exec resume` 驱动自管会话；与桌面会话的差别是“不作用于用户正在看的对话”，且会独立消耗额度。
- **C 级（本地收件箱）**：作为兜底能力实现（阶段 2），不依赖桌面端加载状态。

## 未验证 / 限制

- 未在本轮对用户的真实桌面会话注入消息（需要用户同意，属于操作 GUI / 影响正在使用的会话）。
- 桌面端加载哪条 thread、窗口最小化或应用退到后台时是否仍然排空队列，未验证。
- `codex queue` 对 thread 名称（`--thread <name>`）的支持仅从 `--help` 得知，未实测。
- 队列排空是“消息已被 Harness 接受并开始 turn”，不等于“主 Agent 已经读到 Worker 结果”；后者仍需桌面端真实观察到助手回合内容。
- 事件投递到队列是 at-least-once 语义：`codex queue` 每次都生成新的 `queuedSubmissionId`，重试可能产生重复消息，因此投递层必须记录“已成功入队”并停止重试，无法承诺 exactly-once。
- Codex 的 CLI / app-server 属于实验性接口（`app-server` 标注 experimental），版本升级可能改变行为。
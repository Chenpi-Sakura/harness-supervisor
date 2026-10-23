# 通知投递降噪：失效过滤 + 短窗口（2026-10-23）

分支 `fix-261023-notify-result-noise`。本次只处理“投递前的失效判断与短延迟”，不改权限策略、不新增服务、不引入轮询、不改变收件箱/结果的既有大小策略。

## 1. 解决的问题

主 Agent 被唤醒后看到的常常是**已经失效**的提醒：

1. `needs_input` 通知在“请求已被回答 / 已随 cancel 撤销 / 已被 resume 换成新请求”之后仍然投递。
2. 跨 resume 时 harness 可能**复用同一个 requestId**，只比较 id 无法区分“这就是当前请求”还是“旧回合的同名请求”。
3. 维护性 `cancel` 后立刻 `resume`，中间的 `run.cancelled` 变成噪声。
4. 唤醒消息里塞入摘要/命令，等于把收件箱内容再注入一次上下文；且消息里的旧 requestId 会诱导主 Agent 直接作答。

## 2. 实现

### 2.1 唯一投递闸门（`src/notify.ts`）

- 新增纯函数 `staleNotificationReason(subject, record)`，`Notifier.deliver()` 在调用宿主**之前**求值；判定为过期时把记录标为 `delivery.state = "superseded"` 并写入 `supersededReason`/`supersededAt`，**不调用宿主**。
- `needs_input` 与**当前真实 pendingInput** 对比，而不看通知自己的字段：
  - 无 pendingInput（已答/已撤销/超时/run 结束）→ stale；
  - worker 已终态 → stale；
  - `requestId` 不一致 → stale（被新请求取代）；
  - `pendingInput.seq !== record.seq` → stale（**同 id 跨 resume 复用**，靠事件序号而非 id 识别）；
  - `expiresAt` 已过 → stale；
  - 旧记录无 `seq`（兼容 v0.4.2 前的 `PendingInput`）→ 退化为 `requestId` + 创建时间容差 2s，超差视为不同请求。
- `cancelRequested`（取自 `runtimes.get(id).cancelRequested`）为真时，`needs_input` 直接 stale：`cancel()` 先置运行时标志、后改写记录，这段时间 `answer` 已拒绝，但记录仍是 `awaiting_input`。**不通过 statusReason 字符串猜测**。
- 只有 `cancelled` 做“后续运行”抑制，且**依据证据而非当前状态**：`worker.starting`/`worker.resumed`/`run.accepted` 的 seq 大于该取消事件 seq，或 `startedAt` 晚于该事件时间。resume 很快又完成/失败时旧取消同样被抑制；**新回合自己的取消不会被抑制**（它的 seq 晚于 run-start）。`completed`/`failed`/`crashed`/`detached` 不因此被压掉。

### 2.2 短窗口与批量（`src/notify.ts`）

- 新增 `deliveryDelayMs`：默认 1000ms，环境变量 `HARNESS_SUPERVISOR_NOTIFY_DELAY_MS`（0–60000，0 = 立即）。`retryPending` 修复路径不受延迟影响。
- 定时器**按 worker** 一个：首个待投递事件开启窗口，窗口内后续事件并入同一批；`ingest` **不重置**已有定时器，连续事件不会把首事件饿死；不同 worker 各有定时器，互不阻塞。
- 这是“同 worker 短窗口 + 失效过滤”，**不是把所有提醒合并成一条**；不同 worker、真正待输入、失败、完成始终各自投递。
- 已 `delivered` 的记录永不重标：`deliver()` 在宿主调用前判定，调用返回后即便状态又变也不回溯（宿主无法撤回已接受的消息）；`InFlight`（宿主调用进行中）的记录在读取收件箱时也跳过，避免“先被读成 superseded、随后又 delivered”。
- 投递不依赖 ack：**不**用“已投递未 ack”压制后续提醒（有回归覆盖）。`superseded` 不计入 `pending`/`unacked`，也不保护 worker 免于 retention，但记录与事件都保留。

### 2.3 收件箱读取也核对（`src/notify.ts`）

`channel: "none"`（仅收件箱）的 worker 永远不经过 `deliver()`，失效请求会一直留在默认 actionable 视图。因此 `list()` 在 **actionable 视图**（`state=pending`、`unacknowledgedOnly`）上重新核对一次：

- 未投递（`pending`/`failed`）且已失效 → 标为 `superseded`（`failed` 记录保留 `attempts`/`lastError`，原因里注明“投递失败且已失效”）；
- 宿主调用进行中的记录跳过；`delivered` 历史不动；
- `state=all` 不做任何改动，保留完整证据；**不伪造 `ackAt`**。

### 2.4 唤醒消息只发指针（`src/notify.ts`）

```
[harness-supervisor] <workerId> <kind> seq=<n> | read worker_status for result
[harness-supervisor] <workerId> needs_input seq=<n> | read worker_status; answer current pendingInput
```

不带 `runtime`、`eventType`、摘要正文，也不带旧 `requestId`。`summary` 仍是结构化收件箱字段（`MAX_SUMMARY_CHARS` 未变），worker 结果仍受既有 `maxResultBytes` 约束：本次**没有改变收件箱/结果的大小策略**，只是把唤醒消息收敛成指针，并要求先读当前 `pendingInput` 再作答。

### 2.5 撤回（`src/supervisor.ts`）

- mcode 的 `permission_withdrawn`（`detail` = 被撤回的 requestId）以前只记一条 progress，`pendingInput` 一直存在，闸门会认为请求仍然有效。现在在 progress 分支按 `kind + detail` 严格匹配当前 `pendingInput.requestId`：清空 `pendingInput`、清 `pendingUiTimer`、恢复 `running` 并保存；事件里记录 `pendingInputCleared: true`。
- 判定抽成导出纯函数 `shouldClearPendingInput()`：`answeringRequestId` 非空（应答在途）、`cancelRequested`/`finalizing`/终态、detail 缺失或与当前 id 不符，一律不清。不做“最近一次请求/最近 session”的猜测。

## 3. 真实验证与限制

- 进程/IPC 集成（模拟 Harness）：`test/fixtures/fake-harness` 经真实 Daemon + IPC + Pi Adapter，覆盖“答后再投递”“维护 cancel→resume”“codex-queue 单次投递”“重启/ack/重试”“离线重连”“崩溃遗留”。这不是实际 Pi 模型运行或桌面宿主唤醒验证。
- 模拟验证：`codex-queue` 宿主用 `test/fixtures/fake-codex-queue.mjs` 模拟（记录 argv、可失败、可慢速）；父 Agent 的 `test/integration/mcode.test.ts` 同样使用 fake-mcode，覆盖完整 ACP 撤回链路，不冒充真实 MiniMax 撤回 E2E。真实 MiniMax 最终结果验证单独见 `result-noise-261023.md`。
- 无法撤回：Codex queue 一旦接受了消息就无法收回。本分支只保证“投递前”不再发失效提醒；`deliver()` 判定与 CLI 接受之间存在极小窗口，因此唤醒文案要求先读当前 `pendingInput`，而不是照着消息里的旧 requestId 作答。
- 未做：不合并不同 worker 的提醒；不引入 Exactly-Once；不改权限策略；不改生产 Daemon/config；未运行全量回归（父 Agent 统一验收）。`mcp-modes` 中 `productionInfo.version` 断言 0.4.0 与本工作树 0.4.3 的差异属版本号校准，非本分支修改范围。

## 4. 回归清单

`test/unit/notify.test.ts`（27 项）、`test/unit/supervisor-withdrawal.test.ts`（3 项）、`test/integration/notify.test.ts`（12 项），共 42 项通过。覆盖：

- 答后/撤销后投递被抑制、记录仍以 `superseded` 可查、`ackAt` 为空、事件仍在事件日志；
- 同 requestId 跨 resume（`pendingInput.seq`）与旧记录无 seq 的兼容路径；
- `cancel` 进行中（`cancelRequested`）即 stale；
- 维护 cancel→resume 的中间 `cancelled` 不投递、新 `needs_input` 与最终 `completed` 仍投递；
- 不同 worker 互不影响；已投递未 ack 不压制下一条 `needs_input`；
- 宿主调用进行中读取收件箱不改状态；
- 失效的 `failed` 记录退出 actionable 视图但保留失败历史；
- 崩溃/重启后 `superseded` 稳定、不被 `retryPending` 重试；旧记录（无 target/无 seq/无新字段）可加载。

证据文件：`evidence/notify-delivery-noise-261023/`。

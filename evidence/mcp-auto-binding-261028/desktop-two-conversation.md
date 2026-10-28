# Codex Desktop 双对话验收结果（2026-10-28）

## 环境

- Codex Desktop 真实 UI，两个并行对话 A / B；主 Agent 未手填 `notifyTarget`。
- HS 0.6.1 隔离 daemon：PID 27964，stateDir `%TEMP%\hs-061-desktop`。
- Worker runtime：Pi；两个任务的 prompt 均为 “Wait 60 seconds, then create done.txt...”。

## 用户侧观察

A 先收到完成通知，B 后收到；两个对话各自显示自己的 Worker 完成，没有交叉。

A 返回：

```json
{"target":{"channel":"codex-queue","codexThreadId":"01a164b6-bb26-74a3-bb57-bc6a2c48a8ac"},"source":"caller","wake":"bound","observation":"wake","warnings":[]}
```

B 返回：

```json
{"target":{"channel":"codex-queue","codexThreadId":"01a164b6-e971-74c2-9e18-b0b298d2bf85"},"source":"caller","wake":"bound","observation":"wake","warnings":[]}
```

## 本地核对

Worker 记录：

| 对话 | Worker | 目标 Thread | 状态 | 事件数 |
|---|---|---|---|---|
| A | `w-mvs0epcb-0e8a6d9b` | `01a164b6-bb26-74a3-bb57-bc6a2c48a8ac` | completed | 15 |
| B | `w-mvs0ey86-c5fae774` | `01a164b6-e971-74c2-9e18-b0b298d2bf85` | completed | 15 |

两个 Worker 的 `notifyTarget` 与各自对话的 binding 完全一致，目标不同。

隔离 daemon 日志中的实际投递：

```text
2026-10-28T11:08:21.153Z Worker w-mvs0epcb-0e8a6d9b finished {"status":"completed"}
2026-10-28T11:08:23.753Z Notification accepted by Codex queue
  {"notificationId":"w-mvs0epcb-0e8a6d9b#14","seq":14,
   "threadId":"01a164b6-bb26-74a3-bb57-bc6a2c48a8ac",
   "attempts":1,"messageId":"01a18232-669a-7af2-8164-360053624324"}
2026-10-28T11:08:26.675Z Worker w-mvs0ey86-c5fae774 finished {"status":"completed"}
2026-10-28T11:08:28.877Z Notification accepted by Codex queue
  {"notificationId":"w-mvs0ey86-c5fae774#14","seq":14,
   "threadId":"01a164b6-e971-74c2-9e18-b0b298d2bf85",
   "attempts":1,"messageId":"01a18232-7abd-78b2-8072-dae3f124ff4f"}
```

A 的通知先入队，B 后入队；`notifications.jsonl` 中两条最终状态均为 `delivered`，`attempts=1`，无投递错误。

文件结果：

```text
C:\Users\Lenovo\AppData\Local\Temp\hs-061-A\done.txt  -> HS_A_DONE (9 bytes)
C:\Users\Lenovo\AppData\Local\Temp\hs-061-B\done.txt  -> HS_B_DONE (9 bytes)
```

## 结论

本次真实 Codex Desktop 双对话验收通过：

- `worker_spawn` 未传 `notifyTarget`，两个对话均得到 `source=caller`；
- A/B 绑定到各自不同的 Thread，未串线；
- 完成通知分别投递到正确对话，且两个对话都被实际唤醒并处理；
- 用户观察到 A 先、B 后，与 daemon 入队顺序一致；
- 两个 Worker 都完成，`done.txt` 内容正确；
- 没有看到 Spawn 后、通知前的重复 `worker_wait` / `worker_status` / `worker_events` 轮询。

## 边界

- 这是单次 Desktop 实测，不能替代所有 Codex Desktop 版本/网络/休眠场景的验证。
- 投递仍是 at-least-once；本次 `attempts=1` 不代表任何情况下不会重复。
- 绑定成功本身仍不等于必然唤醒；本结论只覆盖本次真实 Desktop 运行。
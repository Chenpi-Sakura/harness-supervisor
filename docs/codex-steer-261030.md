# Codex `turn/steer` 真实实验与 Desktop 阻塞分析（2026-10-30）

- 环境：Windows，Codex CLI / app-server `0.161.0`，Codex Desktop 正在运行
- 目标：判断 HS 能否把高优先级通知直接送入 Codex Desktop 的**当前活动回合**，而不是只写入 `codex queue`
- 结论：`turn/steer` 协议和模型行为均已真实验证；**HS 无法可靠接入 Codex Desktop 的活动回合**，因此 0.6.5 不实现宿主 steer，也不把 queue 冒充为 steer

## 1. 协议事实

`codex app-server generate-json-schema` 生成的 `TurnSteerParams`：

```json
{
  "threadId": "...",
  "expectedTurnId": "...",
  "input": [{ "type": "text", "text": "..." }]
}
```

- `expectedTurnId` 是**必需**的活动回合前置条件，不匹配时请求失败。
- 成功响应只返回 `{ "turnId": "..." }`，表示请求被接受，不表示模型已应用。
- 官方 schema 还说明：`turn/start` 和 `turn/steer` 在当前活动回合不能接受同回合引导时（例如 `/review`、手动 `/compact`）会返回明确错误。

## 2. 实验 A：同一 app-server 的活动回合

使用真实 app-server（`--listen ws://127.0.0.1`），创建一个真实模型回合，提示词要求运行一个 15 秒的 shell 命令，并在收到 steer 时把 token 写入最终答复。

结果：

| 检查 | 结果 |
| --- | --- |
| 错误 `expectedTurnId` | 拒绝：`expected active turn id ... but found ...` |
| 正确 `expectedTurnId` | 接受：`{"turnId":"01a18b07-4d9e-7831-a098-dcef63cde5bc"}` |
| 模型是否收到 | 是。最终文本：`BASE_DONE HS_STEER_TOKEN_065` |
| 回合结束后再 steer | 拒绝：`no active turn to steer` |

这说明：**RPC 成功、宿主接受、模型实际应用**三个层次在可控 app-server 中都能成立，且错误回合和已结束回合会被安全拒绝。

## 3. 实验 B：第二个 app-server 接管同一活动线程

在 A 的回合仍在运行时，启动独立的 app-server B：

| 操作 | 结果 |
| --- | --- |
| `thread/read` | 能从磁盘读到该线程和活动回合（B 自己报告 `notLoaded`） |
| `thread/resume` | 失败：`thread ... already has an active writer` |
| `turn/steer` | 失败：`thread not found`（未加载到 B） |

写者锁（`~/.codex/thread-writer-locks/`）阻止了跨进程接管。即使 B 知道正确的 `threadId` 和 `turnId`，也无法取得该线程的控制权。

## 4. Codex Desktop 的实际拓扑

运行中的进程：

```text
Codex Desktop (140264)
  └─ codex.exe ... app-server --analytics-default-enabled ...   (28384)
        # 没有 --listen；使用 Desktop 的私有 stdio 管道
  共享 managed daemon (47640)
      app-server --listen unix:// --managed-daemon
```

- Desktop 的 app-server 是 Desktop 自己启动的 stdio 子进程，**没有外部可连接的 socket**。
- 共享 managed daemon 的 `thread/loaded/list` 为空；`thread/list` 只能从磁盘列出 Desktop 线程，状态为 `notLoaded`。
- 因此 HS 既拿不到 Desktop 活动回合的**连接**，也无法通过 `thread/resume` 取得写者锁。

补充：`codex app-server proxy` 的 control socket 是 WebSocket 升级后的连接（直接用 JSONL 写入没有响应）；即使通过它连接 managed daemon，也仍然看不到 Desktop 的活动 `loaded` 线程。

## 5. 为什么不能用 `codex queue` 代替

- `codex queue` 写入 `~/.codex/queue_1.sqlite` 的 `queued_items`，目标 app-server 消费后作为**后续消息**处理；它没有 `expectedTurnId` 前置条件，也没有“当前回合已接受 steer”的语义。
- queue 的投递是 at-least-once；它可能在下一次回合执行，也可能在宿主未加载线程时滞留在队列中。
- 把 queue 描述成实时 steer 会让主 Agent 误以为当前执行已经改变。

## 6. 0.6.5 的处理

- 不新增 steer 传输通道，不写 `queue_1.sqlite`，不读取 Desktop 私有文件来猜测活动回合。
- `supervisor_info.codexSteer` 明确返回：

```json
{
  "status": "unavailable",
  "verified": { "appServerRpc": true, "modelApplied": true, "desktopActiveTurn": false },
  "reason": "Codex Desktop owns its thread in a private stdio app-server; the shared app-server refuses an active writer. codex-queue remains the supported delivery path."
}
```

- `codex-queue` 继续作为唯一受支持的宿主投递路径；通知仍标记为 at-least-once，不宣称唤醒。

## 7. 未来可以重新评估的条件

只有满足以下任一条件，才值得实现宿主 steer：

1. Codex Desktop 提供受支持的本地控制端点，并允许外部客户端按 `threadId`/`turnId` 发送 steer；
2. Codex 提供宿主级 API，明确把“当前活动回合”暴露给本地 MCP/守护进程；
3. 共享 app-server 能安全接管带有活动写者的线程，并提供活动回合查询。

在此之前，HS 不应依赖私有端点、会话文件或写者锁猜测来实现 steer。
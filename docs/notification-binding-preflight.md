# Worker 通知绑定预检与等待策略（下一版本必做）

> 状态：已实施（2026-10-28）。实现见 `src/supervisor.ts` 的 `attachNotificationBinding()`、`src/mcp-presentation.ts` 的 `presentAcceptedWorker()`；测试见 `test/integration/notification-binding.test.ts` 与 `test/unit/mcp-presentation.test.ts`。与 [notification-context-budget.md](./notification-context-budget.md) 阶段 1 并行，互不依赖。

## 1. 背景

一次真实使用中，Codex 调用 HS 派发 Worker 时没有检查当前对话已有的通知能力：全局默认通道是 `none`，于是 Worker 被绑定到“不唤醒”，主 Agent 只能反复轮询。通知机制本身没有失效，问题在于**框架没有让正确的做法成为默认路径**。

结论：不能把正确性寄托在主 Agent 每次记得检查。HS 应当在派发点暴露足够的预检信息，并用返回值和警告把“降级”说清楚。

## 2. 需求

### 2.1 派发前自动检查

`worker_spawn` / `worker_resume` 之前，调用方应确认：当前对话 Thread ID 是否已核实、目标通道是否有效、以及全局默认目标是什么。**不能因为全局默认是 `none`，就忽略当前对话已有的有效 Thread ID。**

### 2.2 每个 Worker 独立绑定

当前对话的目标应显式绑定到本次 Worker，而不是为了省事修改全局默认。多个 Codex 对话并行派发时，各自接收自己的通知。

### 2.3 按情况选择等待方式

- 已成功绑定当前对话、且任务允许异步：结束当前回合，等待 HS 在任务完成时唤醒，不反复调用 `worker_status` / `worker_events`。
- 用户要求立即拿到结果，或通知不可用：使用 `worker_wait` 等待。

### 2.4 降级必须明确

找不到可靠的 Thread ID 时，才降级到收件箱或阻塞等待，并明确说明“本 Worker 不保证自动唤醒”。**不得一边绑定 `none`，一边告诉用户它会自动通知。**

### 2.5 运行中的任务不做破坏性补救

绑定确定后，不得为了更换目标而擅自取消或重启 Worker。应保留原任务，通过已有的等待、状态查询或收件箱接回结果。

## 3. 能力落点（HS 可实施 vs 只能靠调用约定）

HS **不通过进程环境、“最近会话”或全局 Thread ID 推断调用者**。0.6.1 起，MCP 只使用 Codex 每次工具调用自带的 `_meta.threadId` 自动绑定；没有该元数据时退回显式目标或 daemon 默认。

| 要求 | HS 侧可实施 | 只能靠调用约定 |
|---|---|---|
| 2.1 预检 | `worker_spawn` / `worker_resume` 返回生效的 `notifyTarget` 及其来源（显式传入 / 当前 MCP 调用者 / daemon 默认 / 未绑定） | CLI 调用仍需显式传 Thread ID；MCP 由宿主提供 `_meta` |
| 2.1 忽略默认 `none` | 未绑定而 daemon 默认是 `none` 时返回明确的 `warnings`（本次 Worker 不会唤醒本对话） | — |
| 2.2 独立绑定 | 按 Worker 持久化；`worker_resume` 省略时保留原绑定 | 多个 MCP 调用各自带自己的 `_meta.threadId` |
| 2.3 等待方式 | 返回 `observation: "wake" \| "wait"` 建议值；仅在宿主确实支持唤醒该 Thread 时采用 wake | 是否允许异步由调用方与用户决定 |
| 2.4 明确降级 | `warnings` 与 `wake: "bound" \| "unbound"` 字段，不声称唤醒保证；无效/冲突 `_meta` 即使 fallback 可唤醒也警告 | 向用户如实转述 |
| 2.5 不破坏性补救 | 不自动取消/重启；`worker_send` 不因绑定变化而失败 | — |

**用词约束**：`codex-queue` 投递是 at-least-once，且“入队成功”不等于“主 Agent 被唤醒”。对外只能表达“已绑定目标”，不能表达“必定唤醒”。

## 4. 实施范围

先检查现有能力是否足够，只补缺失部分，**不重写通知系统**：

1. `worker_spawn` / `worker_resume` 响应增加生效目标、来源、`wake` 状态与 `warnings`；
2. `supervisor_info` / `supervisor_wake_target` 明确“这是新 Worker 的默认值，不是当前对话的绑定”；
3. 工具描述与项目文档写清 2.1–2.5 的调用约定；
4. 自动化测试覆盖第 5 节全部场景；
5. 不改通知投递、ACK、幂等与重试语义。

## 5. 验收标准

| 场景 | 必须达到的结果 |
|---|---|
| 当前 Thread ID 有效，全局默认是 `none` | 自动绑定当前对话，`source=caller`；MCP 调用无需手填 Thread ID |
| 当前对话与全局默认目标不同 | 本次 Worker 绑定正确，全局默认不覆盖已识别的调用者 |
| 多个 Codex 对话并行派发 | 通知分别回到各自的对话 |
| Thread ID 无法核实 | 明确降级：`wake: "unbound"` 或 fallback 警告，不虚报自动通知 |
| Worker 已运行，才发现绑定错误 | 不取消、不重启，保留任务并接回结果 |
| 已绑定通知目标的异步任务 | 在宿主确实支持唤醒时返回 `observation: "wake"`；不进行无意义的重复轮询 |
| 用户明确要求立即等待结果 | 正常使用 `worker_wait`，不盲目结束回合 |

## 6. 与路线的关系

- 与阶段 1（读取分层）**并行**，不依赖 V1–V3；
- 属于阶段 2（N1/N3 写入约束与归因）的前置体验改进，但不改变其安全结论；
- 不引入新的投递通道，不改动 `turn/steer` 相关实验。

## 7. 实施记录（2026-10-28）

`worker_spawn` / `worker_resume` 的响应新增 `notificationBinding`：

```json
{
  "target": { "channel": "codex-queue", "codexThreadId": "..." },
  "source": "explicit | caller | daemon-default | preserved",
  "wake": "bound | unbound",
  "observation": "wake | wait",
  "warnings": ["..."]
}
```

- `source=explicit`：调用方显式传入 `notifyTarget`（包括显式 `channel=none`）。
- `source=caller`：0.6.1 起，MCP `worker_spawn` 省略目标时，从本次工具调用的 `_meta.threadId` 自动绑定当前 Codex 对话；只接受规范 UUID，且与 `_meta["x-codex-turn-metadata"].thread_id` 冲突时拒绝猜测。
- `source=daemon-default`：没有可用调用者身份且 spawn 省略目标，使用 daemon 默认值。
- `source=preserved`：resume 省略目标，保留原绑定。
- 优先级：显式 `notifyTarget` > `caller` > `daemon-default`；已识别的当前对话不会被全局默认覆盖。resume 不自动绑定新对话。
- `wake=unbound` 时 `warnings` 必非空，说明本次 Worker 不会唤醒本对话，并建议 `worker_wait` 或收件箱；`observation` 同时为 `wait`。
- `wake=bound` 只表示目标已绑定，不表示主 Agent 一定被唤醒；投递仍是 at-least-once。
- CLI 非 JSON 输出会打印绑定与警告；`--json` 原样包含该字段。
- 不通过 daemon 环境变量、`CODEX_THREAD_ID` 或“最近 Session”推断调用者；自动绑定只使用宿主逐次工具调用提供的 `_meta`。它是路由提示，不是认证边界。
- 不改通知投递、ACK、幂等与重试；resume 的显式目标仍是“未来事件接管”，不取消或重启正在运行的任务。
- 自动化覆盖：A/B 对话独立绑定、同对话多 Worker、显式目标优先、无/非法身份降级、resume 保留与显式接管、客户端重连与 Daemon 重启后的持久化。
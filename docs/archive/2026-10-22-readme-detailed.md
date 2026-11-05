> **归档快照**：这是 2026-10-22 的详细版 README，保留当时的实现说明与验证数据，**不再更新**。
> 文中的相对链接以仓库根目录为基准；当前功能说明以仓库根目录的 `README.md` 为准。

# Harness Supervisor v0.2

一个轻量的本地生命周期与通信层，让主 Agent 通过 **CLI** 或 **MCP** 启动、观察、指导、取消和恢复其他厂商的原生 AI Harness。完整支持 **Pi Agent**（Pi v1.3+ 原生 RPC）；实验性 **Qoder CLI** 适配（stream-json/stdio 控制协议，真实交互证据见 [§9](#9-测试与真实证据)）。

v0.2 在 v0.1 的基础上增加了三件“长期异步”必需的事（不改变原有接口语义）：

- **持久化通知收件箱**：完成/失败/取消/需要输入/崩溃/失联等重要事件各生成一条稳定 ID 的通知，可查询、可确认、跨重启不重复、不丢失；普通进度不产生通知。
- **可选 Codex 队列投递**：登记 Codex thread 后，通过官方 `codex queue --thread <id> --message <text>` 投递简短摘要；只在宿主确实加载该 thread 时才会自动开始新 turn，语义为 at-least-once，且不宣称“已唤醒”。
- **可选请求幂等**：`spawn`/`resume`/`send` 支持 `requestId`，相同参数重试返回已有结果、不同参数报冲突、daemon 中途崩溃报 `UNCERTAIN` 而非自动重跑。

此外提供 `prune` 维护命令（只清理终态且无未确认通知的 Worker），以及 Qoder CLI 真实交互验收证据。

它管理的是 **进程、会话和事件**，不是新的多智能体框架：

- 不做 Planner / Reviewer / Implement 角色拆分
- 不做任务 DAG、讨论投票、智能模型路由
- 不引入额外的 LLM 做调度或生命周期管理
- 不重复实现 Pi 的 Agent 循环，只控制它

> 一句话：主 Agent 只负责决策；Pi/Qoder 仍然是原来的 Harness；Supervisor 负责让“另一个 Harness”变得可启动、可观测、可插话、可取消、可恢复。

---

## 1. 架构

```
Main Agent (Codex / Pi / any MCP client)
   │  CLI                    │  MCP (stdio)
   ▼                         ▼
SupervisorClient ────── 本地 IPC（Windows named pipe / Unix socket，token 认证）
                                │
                                ▼
                    Supervisor daemon（单用户本地进程）
                    ├─ Worker 状态机与独立生命周期
                    ├─ 追加式事件日志 + seq 游标
                    ├─ 会话元数据与重启对账
                    └─ 有界 wait / 输入请求 / 取消
                    ┌───────────┴────────────┐
                    │ Pi 原生 RPC            │ Qoder stream-json/stdio
                    ▼                        ▼
            Pi worker 子进程          Qoder CLI worker 子进程
            ├─ 自己的 cwd             ├─ 自己的 cwd
            ├─ 自己的 session 文件     ├─ Qoder 持久化 session
            └─ 自己的进程树            └─ 自己的进程树
```

关键设计：**Worker 属于 daemon，而不是 CLI/MCP 连接**。

- 主客户端断开，Worker 继续运行，之后可重新查询。
- MCP 工具是 request/response 拉取模型。Supervisor **不声称**能后台唤醒主 Agent。
- daemon 被强制杀死后，不能重新接上原来的 stdin/stdout 管道；重启后会把未完成 Worker 明确标记为 `orphaned` 或 `interrupted`，绝不自动重跑。

---

## 2. 环境要求

- Node.js **>= 22.19**（开发与验证使用 Node v24.21.0）
- Pi Agent **>= 1.3**，并已配置好 provider / model / 凭据
- （可选，Qoder runtime）Qoder CLI `qodercli` 1.1.75/1.1.76（均在 Windows 实测），并已执行一次 `qodercli login`，或在 daemon 环境中设置 `QODER_PERSONAL_ACCESS_TOKEN`
- **Windows 原生环境已实测**；WSL 需要在 WSL 内单独安装 Node 与 Pi，本项目未在本机 WSL 中实测
  - Windows 下 Supervisor 会自动定位 `~/.pi/agent/bin/pi-launcher.js`
  - 也可通过 `HARNESS_SUPERVISOR_PI_ENTRY=<pi-launcher.js 或 Pi CLI JS 入口>` 指定
  - `HARNESS_SUPERVISOR_PI_BIN` 可指定真实可执行文件，但不接受 `.cmd/.bat` shim（避免 shell 注入）
  - Qoder 默认从 PATH 查找 `qodercli`；也可用 `HARNESS_SUPERVISOR_QODER_BIN` 或 `HARNESS_SUPERVISOR_QODER_ENTRY` 指定

```bash
npm install
npm run build
node dist/src/cli.js --help
```

可选：`npm link` 后可以直接使用 `harness-supervisor` 或 `harness-sup` 命令。

默认状态目录：`~/.harness-supervisor`。可用 `--state-dir <dir>` 或 `HARNESS_SUPERVISOR_HOME` 隔离多个实例。

### WSL 方案

如果 Pi 只安装在 WSL 中，请在 WSL 内安装 Node.js（>=22.19）与 Pi，然后在 WSL 内执行同样的 `npm install && npm run build`。将状态目录和 Worker cwd 放在 Linux 路径下（例如 `~/work`）；如需访问 Windows 盘符，可使用 `/mnt/d/...`。本项目在 Windows 原生环境实测，WSL 需自行验证 Pi 工具链（Git Bash/PowerShell 与 Linux shell 的工具集不同）。

---

## 3. CLI 快速开始

以下命令以 `node dist/src/cli.js` 为例；`npm link` 后可替换为 `harness-supervisor`。

```bash
# 启动本地 daemon（若已启动则直接返回）
node dist/src/cli.js up

# 启动 Worker。返回时只代表 prompt 已被接受，不代表任务完成。
node dist/src/cli.js spawn \
  --cwd D:/work/demo \
  --prompt "Create hello.txt containing hello. Then reply exactly DONE." \
  --name demo-worker \
  --model deepseek-v4.1-flash-1017 \
  --provider new-api \
  --thinking off \
  --json

# Qoder Worker（需先 qodercli login；模型名用 qodercli --list-models 选择）
node dist/src/cli.js spawn \
  --runtime qoder \
  --cwd D:/work/demo \
  --model <cheap-qoder-model> \
  --prompt "用 Write 工具创建 hello.txt，然后回复 DONE。"

# 查询状态 + 最近事件
node dist/src/cli.js status <workerId>

# Worker 运行期间追加指令（Pi native steer；Qoder 走 stream-json priority=next）
node dist/src/cli.js send <workerId> --message "Also add a timestamp to the file." --mode steer

# 增量读取事件（sinceSeq 游标）
node dist/src/cli.js events <workerId> --since 0 --limit 100

# 有超时边界的等待：直到终态
node dist/src/cli.js wait <workerId> --since 0 --timeout-ms 60000

# 取消受控 Worker（Pi: 先清队列再 abort；Qoder: cancel_async_message + interrupt；必要时终止进程树）
node dist/src/cli.js cancel <workerId>

# 在持久化 session 存在且旧进程已退出时，继续该会话
node dist/src/cli.js resume <workerId> --prompt "Continue and summarize what changed."

# 优雅关闭 daemon（会取消所有活动 Worker）
node dist/src/cli.js down
```

### 重要语义

| 行为 | 含义 |
| --- | --- |
| `spawn` 返回 `running` | Harness 已接受 prompt，**任务尚未完成** |
| `wait` 返回 `terminal: true` | Worker 已进入终态，`completed / failed / cancelled / crashed / orphaned / interrupted` 之一 |
| `run.completed` + `result.text` | Pi: 原生 `agent_settled`；Qoder: `result` 非错误且已静默 |
| `run.failed` | Harness 报告了 provider/run 错误，或启动失败；Qoder 未登录也会走这里 |
| `run.cancelled` | 主动取消、超时或 Supervisor 关闭 |
| `crashed` | Harness 进程在 settle 前异常退出 |

Qoder 的 `steer` 使用 `priority="next"`（在安全边界注入或开始下一轮），`follow-up` 使用 `priority="later"`（空闲后执行）。它与 Pi 的 steer 不是逐字节相同的语义；Qoder 的多轮 `result` 通过短暂静默窗口合并为一次终态，详见 [§7.2](#72-qoder-cli-adapter实验性)。

CLI 的 `wait` 退出码：`0` completed，`3` failed，`4` cancelled，`5` crashed/orphaned/interrupted，`2` 调用错误。`spawn --wait` 也会在 Worker 需要输入时提前返回，避免阻塞到超时。

完整示例见 [`examples/cli-walkthrough.sh`](examples/cli-walkthrough.sh)。

---

## 4. MCP 接入

### Codex（Windows，实测 `codex-cli 0.161.0`）

已实测：Codex 通过 MCP 调用 `worker_spawn` / `worker_wait` / `worker_send`，在 Pi 运行中发送 steer，收回完成结果；外部预启动的 daemon 在 Codex 退出后仍可连接。证据见 [`evidence/codex-real-pi/`](evidence/codex-real-pi/)。

#### 1. 构建并预先启动 daemon

`codex exec` 退出时会终止 MCP server 的整个进程树。若让 MCP server 自动拉起 daemon，daemon 也会被强杀且没有 graceful shutdown 记录（见 [`evidence/codex-auto-start/`](evidence/codex-auto-start/)）。需要 Worker 在 Codex 退出后继续运行，请在 **Codex 之外**先启动并保持 daemon：

```powershell
npm install
npm run build
node D:/Projects/Harness-Supervisor/dist/src/cli.js up
```

默认状态目录是 `~/.harness-supervisor`。如果 daemon 使用 `--state-dir`，Codex MCP 的 args 必须指向同一个目录，否则 MCP server 会在 Codex 的进程树里另起一个 daemon。

#### 2. 配置 `~/.codex/config.toml`

```toml
[mcp_servers.harness_supervisor]
command = "node"
args = ["D:/Projects/Harness-Supervisor/dist/src/mcp.js"]
startup_timeout_sec = 30
tool_timeout_sec = 150

# codex exec 默认 approval_policy=never，未放行时 MCP 调用会被取消并报：
# "MCP tool call requires approval, but approval policy is never"
# 自动化场景需要放行该服务器的工具；只在可信工作区使用。
default_tools_approval_mode = "approve"
```

`codex exec` 还需要加 `-c approval_policy="on-request"`（或写进 profile / 顶层配置）。交互式 Codex 可把 `approve` 改为 `prompt` 或 `writes`，保留逐次审批。

Windows 路径建议使用 `D:/...` 正斜杠，避免 TOML 反斜杠转义；`tool_timeout_sec` 必须大于你使用的 `worker_wait` 超时（工具上限 120s）。

#### 3. 注册并检查

```powershell
codex mcp add harness_supervisor -- node D:/Projects/Harness-Supervisor/dist/src/mcp.js
codex mcp list
```

`codex mcp add` 适合快速注册；超时和审批字段需再手工补进 `config.toml`。修改配置后重启 Codex 会话。启动后可以用 `/mcp`（交互式）或直接要求 Codex 调用 `worker_spawn` 来确认工具可见。

#### 4. 其他 MCP 客户端

可使用 [`examples/mcp.json`](examples/mcp.json)。MCP server 在 daemon 未运行时可以自动启动它；但如上面的 Codex 限制，若宿主会清理子进程树，请改为外部预启动 daemon。

### 工具清单

| 工具 | 用途 |
| --- | --- |
| `worker_spawn` | 启动 Worker；**prompt 被接受即返回**，不等待完成；返回 `id`、`lastSeq` |
| `worker_status` | 状态、`lastSeq`、最近事件、pending input、结果/错误、stderr 尾部 |
| `worker_list` | 列出 Worker（持久化，跨 daemon 重启） |
| `worker_events` | 按 `sinceSeq` 增量读取事件；`sinceSeq=0` 读完整历史 |
| `worker_wait` | 有界长轮询；默认 20s，最大 120s；不带 `sinceSeq` 时先检查当前状态/最近 20 条事件，再等待；带 `sinceSeq` 时严格按游标增量；默认省略普通 `run.progress`（保留 `queue_cleared` 和工具错误），`includeProgress=true`（或 `types:["run.progress"]`）返回全部，完整历史用 `worker_events` |
| `worker_send` | 运行中追加 `steer` / `follow-up`（Pi 队列 / Qoder priority 消息）；不用于回答输入请求 |
| `worker_answer` | 回答 `run.needs_input`（Pi extension select/confirm/input/editor；Qoder canUseTool 审批或 AskUserQuestion） |
| `worker_cancel` | 取消 + 终止进程树 + 确认终态；不影响其他 Worker（Pi 先清队列，Qoder 先 cancel_async_message + interrupt） |
| `worker_resume` | 用新指令显式恢复已有 session；校验 session ID，拒绝伪造成功 |
| `supervisor_info` | 版本、限制、runtime capability、通知通道与唤醒边界 |
| `supervisor_notifications` | 读取持久化通知收件箱（默认只看 pending），轻量、无需轮询 Worker |
| `supervisor_notifications_ack` | 确认已处理的通知（幂等） |
| `supervisor_wake_target` | 可选：登记 Codex thread，启用 `codex queue` 投递通道 |

推荐主 Agent 循环：

1. `worker_spawn`
2. `worker_wait`（传入上次的 `nextSeq` 作为 `sinceSeq`），或 `worker_status`
3. 运行中需要补充方向：`worker_send`
4. 出现 `run.needs_input`：`worker_answer`
5. 必要时 `worker_cancel` 或 `worker_resume`
6. 终态后读取 `result.text` / `error`

### 等待语义（MCP 层）

- **不带 `sinceSeq`**：先查当前状态和最近 20 条事件。如果 Worker 已经终态、`awaiting_input`，或指定的 `types` 事件已经出现，立即返回；否则从当前末尾开始等待新事件。这避免“刚 spawn 完调用 wait 等 `run.started`，但事件已经发生”时白等到超时。
- **带 `sinceSeq`**：严格游标语义，只返回 `seq > sinceSeq` 的事件；适合无损增量消费。用上一次结果的 `nextSeq` 或 Worker 的 `lastSeq`。
- 不带游标返回的是最近窗口，不是完整历史；需要完整历史用 `worker_events(sinceSeq=0)`。
- 默认省略普通 `run.progress`（工具开始/结束、turn、assistant 预览），只返回状态变化、输入请求、消息和终态等重要事件；`queue_cleared` 和工具错误仍会保留。`eventsOmitted` 表示本次省略了多少条。需要完整进度时传 `includeProgress=true`，或把 `run.progress` 放进 `types`；需要完整事件流时用 `worker_events`。
- 终态后重复调用不带游标的 `worker_wait` 会立即返回，不应用于轮询循环；读状态或结果后应停止。

### 关于“主动唤醒”

v0.2 结论（证据：`evidence/codex-wake-probe/`）：

- **A 级（唤醒原 Codex 会话）的机制已端到端跑通**：官方 `codex queue --thread <id> --message <text>` 会写入共享队列；当某个 app-server 客户端加载了该 thread 且处于 idle 时，队列会被自动排空并开始新的 turn。真实端到端实验（`evidence/codex-wake-e2e/`）：Codex 回合于 07:25:55 结束 → Worker 之后完成 → HS 在 07:26:35 投递成功 → Codex 在 07:26:43 **自行**开始第二轮并回答 `Worker … completed successfully. Result: FAKE_PI_OK.`。没有任何客户端加载该 thread 时（例如 `codex exec` 已退出），消息只留在队列中，不会被执行（`evidence/codex-wake-probe/` E1）。
- 因此 HS 提供 `channel=codex-queue` + `supervisor_wake_target`：重要事件会以单行摘要写入指定 thread。**是否真的唤醒桌面会话取决于 Codex 桌面端是否加载了该 thread**。2026-10-22 已在用户真实桌面会话完成一次验收：回合结束后 Worker 完成 → `codex queue` 投递成功 → 同一 thread 自动开始新回合并读取结果（[`evidence/desktop-wake-1022/`](evidence/desktop-wake-1022/README.md)）。
- **默认通道仍是收件箱（C 级）**：通知持久化、可查询、可确认，不依赖宿主加载状态，也不含任何隐藏轮询。
- **B 级（独立受控会话）** 也可用：`codex app-server` 的 `thread/start`、`turn/start`、`thread/queue/*` 已在探测中实际调用；它与桌面会话的差别是不作用于用户正在看的对话，并独立消耗额度。
- 投递是 **at-least-once**：`codex queue` 每次生成新的 `queuedSubmissionId`，重试可能产生重复消息，因此投递成功即停止重试；投递成功也不等于主 Agent 已读到内容。
- 宿主的 MCP tool timeout 必须大于你设置的 `worker_wait` 时间。

### Codex 宿主限制（实测）

- **进程树清理**：`codex exec 0.161.0` 退出时会终止 MCP server 的整个进程树。自动拉起的 daemon 也会被杀，且没有 shutdown 记录；因此长任务应使用外部预启动 daemon。`evidence/codex-auto-start/daemon.log` 与残留 `daemon.lock` 是实测证据。
- **无后台唤醒（v0.1 结论）**：在 `codex exec` 流程中，所有观察都发生在同步 MCP 工具调用内；`codex exec` 退出后没有客户端加载该 thread，因此排队消息也不会执行。
- **v0.2 补充**：官方 `codex queue` + 已加载的 thread 可以实现“事件驱动的下一个 turn”（见上方“关于主动唤醒”与 `evidence/codex-wake-probe/`）。桌面端已在 2026-10-22 的单次真实验收中保持 thread 加载并自动开始新回合（[`evidence/desktop-wake-1022/`](evidence/desktop-wake-1022/README.md)）；该行为依赖宿主，尚未做重复稳定性验证。
- **沙箱范围**：Codex 的 `-s read-only` 等 sandbox 约束不阻止 MCP server / Worker 启动本地进程和写入 Supervisor 状态目录。MCP server 是宿主进程，工具审批和 OS 权限才是实际边界。
- **审批**：`codex exec` 默认的审批策略会取消未放行的 MCP 调用；本项目的实测组合是 `default_tools_approval_mode = "approve"` + `approval_policy = "on-request"`。`approve` 会自动放行启动/取消 Worker 这类有副作用的工具，只应在可信工作区使用。
- **环境继承**：外部预启动的 daemon 使用它自己的环境启动 Pi；Codex MCP 配置里的 `env` 只在 MCP server 自动启动新 daemon 时生效。不要把 Pi 凭据只放在 Codex MCP 的环境表里而期待已运行的 daemon 使用它。
- **版本**：以上仅在 `codex-cli 0.161.0`、Windows 上实测；Codex 的配置字段和审批行为可能随版本变化。

---

## 5. 生命周期与事件

### 状态

| 状态 | 终态 | 说明 |
| --- | --- | --- |
| `starting` | 否 | 正在拉起 Harness / 加载 session |
| `running` | 否 | 已接受 prompt，任务运行中 |
| `awaiting_input` | 否 | Pi extension 弹出了对话框，等待 `worker_answer` |
| `completed` | 是 | 原生 run 正常 settle，`result.text` 可用 |
| `failed` | 是 | provider/run 错误或启动失败；`error` 可用 |
| `cancelled` | 是 | abort / maxDuration / Supervisor shutdown |
| `crashed` | 是 | 进程在 settle 前异常退出；`exit` 记录 code/signal |
| `orphaned` | 是 | daemon 重启后丢失控制通道，记录中的 PID 仍存活 |
| `interrupted` | 是 | daemon 重启后进程已不在，任务结果未知 |

状态之外，Worker 记录还包含：独立 ID、cwd、PID、Harness session ID/文件、退出码、token/turn/tool 统计、pending input、最近事件、resume 信息。

### 事件

- `worker.starting` / `worker.started` / `worker.session`
- `run.accepted` / `run.started`
- `run.progress`（tool start/end、turn complete、assistant message、retry、compaction、notification、usage、`queue_cleared`、`permission_timeout`）
- `run.needs_input` / `run.input_answered`
- `run.message_sent`
- `run.error`
- `run.completed` / `run.failed` / `run.cancelled`
- `worker.cancel_requested` / `worker.exited` / `worker.crashed`
- `worker.orphaned` / `worker.interrupted` / `worker.resumed` / `worker.resume_failed`

每个 Worker 的事件序列 `seq` 从 1 单调递增。`nextSeq` 可直接作为下一次增量读取的游标。原始 token 级 text delta 不落盘；只保存规范化进度，避免事件日志无限膨胀。

### 通知收件箱（v0.2）

重要事件（`run.completed`、`run.failed`、`run.cancelled`、`run.needs_input`、`worker.crashed`、`worker.orphaned`/`worker.interrupted`）在写入事件日志的同时，会生成一条**通知**：

| 字段 | 说明 |
| --- | --- |
| `id` | `<workerId>#<seq>`，同一事件永远不会产生两条记录（重启对账也按此去重） |
| `kind` / `eventType` / `workerId` / `runtime` / `seq` | 事件身份 |
| `summary` | 精简摘要：终态文本 / 错误 / `run.needs_input` 的 requestId、问题、选项；不含完整对话 |
| `delivery.state` | `pending` / `delivered` / `failed`（可选通道的投递状态） |
| `ackAt` / `ackBy` | 消费者确认时间；已确认记录不再出现在默认收件箱，也不会被重新投递；未确认的通知不会被 `prune` 清理 |

访问方式：MCP `supervisor_notifications` / `supervisor_notifications_ack` / `supervisor_wake_target`；CLI `inbox` / `ack` / `notify-target` / `retry-notifications`；IPC `notifications` / `notification_ack` / `notification_target` / `notification_retry`。

**确认语义**：`notifications` 默认只返回“未确认且待投递”的记录；`counts.pending` 也只统计这类记录。已确认记录可用 `state="all"`（或 `delivered`/`failed`）查询作诊断，但永远不会被自动重发——包括切换投递通道、daemon 重启、重新连接时。

**失败重试**：自动重试只针对 `pending`（有尝试次数上限）；`failed` 记录必须显式重试（`retry-notifications --states failed` 或 IPC `notification_retry {states:["failed"]}`），它会获得新的尝试预算而不是永久卡住。重试可能重复投递（at-least-once），已确认记录一律跳过。

普通 `run.progress` **不会**产生通知。重要事件不受“消费者离线”影响：记录先落盘，重连后可继续读取；daemon 重启后会用已持久化事件补齐丢失的通知，且不会重复。

### 等待

- `worker_wait({ sinceSeq, timeoutMs, until: "terminal"|"event", types })`
- 默认 `sinceSeq` 是当前末尾，只等新事件；传 `0` 可拿到全部历史。
- 返回 `timedOut`、`terminal`、`events`、`nextSeq`、`hasMore`。
- 若 Worker 进入 `awaiting_input`，即使 `until: "terminal"` 也会立即返回（`terminal: false`），让授权请求不会被 wait 超时掩盖。
- 不重复读取全部历史；客户端自己维护游标。

### 需要进一步指令

Pi 的 `extension_ui_request`（select / confirm / input / editor）和 Qoder 的 `can_use_tool` 会映射为 `run.needs_input`，Worker 状态变为 `awaiting_input`。`worker_answer` 分别发送 `extension_ui_response` 或 `control_response`，恢复为 `running`。

限制：如果 Worker 只是在普通回复里写“请确认是否继续”，Harness 没有原生暂停原语时，Supervisor 不会假装检测到问题或自动暂停。只有 Harness 自己发出扩展对话框/控制请求时，才有 `awaiting_input`。Qoder 的审批请求在 5 分钟未回答时会 deny，避免永久卡住。

---

## 6. 恢复、关闭与重启边界

### Resume（恢复已有会话）

支持条件（全部满足才会执行）：

1. Worker 已处于终态，且当前没有活动 runtime；
2. 对应 adapter 支持 resume；
3. Worker 记录了持久化 session 文件，且文件仍存在；
4. 旧 PID 不在运行；
5. Supervisor 启动新的 Harness 进程并**校验 session ID 与 session 文件路径**；
6. 调用方提供新的 prompt。

任何一步不满足都会返回 `UNSUPPORTED` / `INVALID_STATE`，不会静默创建新 session 并声称恢复成功。

`resume` 的语义是：**启动一个新的 Harness 进程，加载指定 session，然后提交一个新的 prompt**。它不会续接原进程内存中的运行，不会补跑中断的 assistant turn，也不会重放旧工具调用或自动重试可能产生副作用的工作。`resumeCount` 和新 prompt 被接受后的 `worker.resumed` 事件都只在 session 校验通过、run 真正开始后记录；若加载失败，会恢复之前的终态并写 `worker.resume_failed`。

Pi 通过 `--session <file>` 加载并校验 session ID/路径。Qoder 通过 `--resume <session-id>` 加载，启动后校验 init 返回的 `session_id` 与记录一致，并要求原 session 文件仍存在；Qoder session 文件位于用户 Qoder 配置目录的 `projects/` 下，Supervisor 只记录路径与存在性，不复制其内容。

### 并发与控制语义

- **并发上限是原子占位**：`maxWorkers` 同时计入活动 Worker 和正在启动的请求，检查与创建之间的 await 窗口不能突破上限。
- **同一 Worker 的 resume 串行化**：第一次 resume 进行中时，第二次返回 `INVALID_STATE`，不会出现两个进程加载同一 session。
- **取消开始后拒绝新控制指令**：`send` / `answer` 会返回 `INVALID_STATE`；同一输入请求的第二个 answer 也会被拒绝。已经发出但仍在 Pi 队列中的 steer/follow-up 会在 abort 前通过 `clear_queue` 清除；Qoder 则发 `cancel_async_message`，只统计 CLI 确认取消的消息。
- **取消顺序**：Pi 是 `clear_queue` → `abort` → 有界等待 `agent_settled` → 必要时强制终止进程树。Pi 文档说明 abort 会继续队列中的消息，所以必须先清队列；非空队列清空会记录 `run.progress`（`kind: "queue_cleared"`，只记录数量，不保存消息正文）。Qoder 是 `cancel_async_message` → `interrupt {cancel_queued:true}` → 有界等待 result → 必要时终止进程树。
- **关停屏障**：`shutdown` 先拒绝新的 spawn/resume/send/answer，等待进行中的准入最多 5 秒，再取消/强杀所有活动 runtime；不会出现关停快照漏掉刚启动 Worker 的情况。
- **线性化**：完成与取消同时发生时，以先完成的一方为准，可能返回 `completed`。终态只有在 Harness 进程停止后才可见。
- **默认不是事务型 API，但可选幂等**：未携带 `requestId` 时，spawn/resume 与旧版一样不具备幂等性；携带后按下节语义处理。已完成的操作重复提交应优先查 `status` / `list`。

### 请求幂等（v0.2，可选）

`spawn` / `resume` / `send` 接受可选的 `requestId`（IPC 字段；MCP/CLI 同名参数）。supverisor 在执行**之前**先写入一条记录（`<stateDir>/idempotency.jsonl`），因此崩溃只能留下“未完成”状态，而不会产生“看起来成功但实际未记录”的结果。

| 重复请求 | 行为 |
| --- | --- |
| 相同 key + 相同参数 + 已完成 | 返回记录的 Worker 当前状态 / 首轮结果，**不再执行** |
| 相同 key + 相同参数 + 原请求抛错 | 重放同一个错误（消息前缀 `Replayed result`），不再执行 |
| 相同 key + 相同参数 + 仍在执行 | `INVALID_STATE`，不会重复启动 |
| 相同 key + 不同参数 | `CONFLICT`（带 `firstSeenAt`） |
| 相同 key + daemon 中途崩溃 | `UNCERTAIN`，提示先查 `status`/`list`，**不自动重跑** |
| 无 requestId | 保持 v0.1 行为 |

- **可重试的错误会释放 key**：`BAD_REQUEST`、`UNSUPPORTED`、`INVALID_STATE`、`LIMIT_EXCEEDED` 且未创建 Worker 时，该 key 会被释放，调用方可用同一个 requestId 重试。
- **spawn 的幂等保证到“被接受”为止**：请求成功意味着只创建了一个 Worker；任务本身后续失败也仍会被记录为同一个 Worker，重试不会产生第二个。
- **send 无法保证不重复送达**：如果 daemon 在消息写入后崩溃、但 harness 已收到，重试只能报 `UNCERTAIN`；不能谎称成功。
- 记录可用 `prune` 压实（保留最新记录与所有未完成记录）。

### Supervisor 重启

- **优雅关闭**（`down` / SIGINT / SIGTERM）：先进入关停屏障，取消所有活动 Worker，状态记录为 `cancelled` + reason `supervisor_shutdown`，然后退出。
- **强制杀死 / 崩溃**：未完成 Worker 在下次启动时被对账为：
  - `orphaned`：记录中的 PID 仍存活，但 daemon 已失去 stdin/stdout 控制通道；
  - `interrupted`：PID 已不存在，结果未知。
- **重启后没有任何 Worker 保留实时控制通道**。`status` / `events` / `wait` 仍可只读使用；不能对旧运行继续 steer 或 answer。若 daemon 在终态落盘前被杀，即使任务实际已完成，也会保守地报 `interrupted`（结果未知），不会自动改判为 `completed`；需要时只能显式 resume 读取 session。
- **客户端断开不是 Supervisor 重启**：daemon 仍在时，任何客户端重连后都可以继续 status/send/cancel；只有 daemon 进程本身退出/被杀，才进入上述对账路径。
- **`orphaned` 进程不能通过 Supervisor 取消**。Supervisor 会明确返回 `UNSUPPORTED`，而不是假装取消成功；需要在确认 PID 身份后由人工/平台工具终止。拒绝按记录 PID 自动 kill 是因为 PID 复用可能误杀无关进程。待旧进程真正退出后，才可以显式 resume。
- **`resumeAvailable` 只是前置条件**：它表示 session 文件存在、旧 PID 不在运行、adapter 支持 resume，并不保证一定能加载该文件；真正的加载会校验 session ID/路径，失败则恢复原终态并报错，不伪造成功。
- 需要显式 `resume`，且只接受已持久化 session；旧 PID 仍存活时一律拒绝。`resume` 加载的是持久化会话，不会续接原运行。
- 平台差异：Windows 上非 detached 的 Pi 子进程在 daemon 被强杀后通常随之退出，记录会变为 `interrupted`；POSIX 或子进程自行存活时可能出现 `orphaned`。两种状态都不代表任务成功。

### 保留与清理（v0.2）

`prune` 是**显式维护操作**，自动清理只能通过它触发：

```bash
harness-sup prune --older-than-days 7 --keep 20 --dry-run   # 只看将会删什么
harness-sup prune --older-than-days 7 --keep 20            # 真正删除
```

- 只处理**终态** Worker；活跃 Worker 永不删除。
- 有**未确认通知**的 Worker 即使很旧也不会被删除（不会丢弃尚未交付的重要事件）。
- `keep N` 保护最新的 N 个终态 Worker；`--dry-run` 不产生任何副作用。
- 同时压实元数据：通知日志只丢弃 30 天前已确认的记录；幂等日志保留最新记录与所有未完成记录。
- **不删除** harness 原生 session 文件（默认），需要时显式加 `--include-sessions`；删除 Worker 目录后该 Worker 不能再 resume。

### PID 复用与进程身份校验

monitor 重启后不再持有子进程句柄，因此对账不能只看 PID 是否存活。现在会在发现 `pid` 仍存活时读取它的命令行（Linux：`/proc/<pid>/cmdline`；Windows：`Get-CimInstance Win32_Process`；其他 POSIX：`ps`），并与该 Worker 的唯一 token（worker id、session id、session file）比对：

| 结果 | 状态 | 含义 |
| --- | --- | --- |
| 命令行包含 token（`pidVerified=true`） | `orphaned` | 大概率是原进程，仍然不自动接管 |
| 命令行不包含 token（`pidVerified=false`） | `interrupted` | PID 已被别的进程复用，原进程已不存在 |
| 无法读命令行（`pidVerified=null`） | `orphaned` | 保守处理，不杀进程 |

- 身份不匹配时对 `orphaned` 的 `cancel` 会明确返回“没有属于本 Worker 的活进程，未终止任何进程”。
- `resume` 只在“PID 存活且身份匹配”时拒绝；PID 被复用时不再阻止 resume。
- 对账事件记录 `pidAlive` 与 `pidVerified`，便于复核。
- 残留风险：命令行读取失败（权限/平台限制）时仍回退为保守的 `orphaned` 语义；命令行 token 存在极小概率的偶然匹配。

### Pause

Pi 没有可用的 pause 原语，Supervisor 不实现假暂停；Qoder 的 `interrupt` 是终止当前 turn，不是可继续的 pause。capability 中明确 `pause: false`。`resume` 是“基于持久化 session 启动新进程并继续”，不是恢复同一个内存中的运行。

---

## 7. Adapter 实现方式

### 7.1 Pi Adapter（完整支持）

使用 Pi v1.3+ 官方文档化的 **RPC mode**（`pi --mode rpc`）：

- 严格 JSONL framing：只按 LF 分帧、剥离可选 CR、支持跨 chunk UTF-8；不使用 `readline`（它会错误拆开 U+2028/U+2029）。
- 命令：`prompt`、`steer`、`follow_up`、`clear_queue`、`abort`、`get_state`、`get_last_assistant_text`、`extension_ui_response`。
- 事件：`agent_start/end/settled`、`tool_execution_*`、`message_*`、`auto_retry_*`、`compaction_*`、`extension_ui_request`、`extension_error`。
- **完成判定使用 `agent_settled`，不是 prompt response。** Prompt response 只代表 accepted/queued/handled。
- 每个 Worker 使用独立 `--session-dir`，捕获 `sessionId/sessionFile`；resume 通过 `--session <file>` 并校验 ID。
- `abort` 后等待 settle；关闭时先关 stdin 请求有序退出，超时后 Windows 用 `taskkill /PID <pid> /T /F`，POSIX 用进程组 SIGKILL，按 PID 精确限定范围。
- Extension UI 对话框会暴露给主 Agent；fire-and-forget（notify/setWidget 等）不会阻塞。

为什么没有直接引入 Pi 的完整 TypeScript client 包？

- Pi 的 RPC 协议本身就是成熟、文档化的复用点；
- 官方 `RpcClient` 绑定 `node + dist/cli.js` 的启动方式，并把 stderr 直接写到宿主 stderr，不适合 daemon 统一管理；
- Supervisor 只需要很小、可测试、跨 Harness 可替换的传输层，避免把整个 Pi 包作为运行时依赖。

这不是自研 ACP 客户端。v0.1 直接使用厂商原生 RPC；未来接入支持 ACP 的 Harness 时，可以在 adapter 层复用成熟 ACP SDK，而不是扩展本项目的协议。

### 7.2 Qoder CLI Adapter（实验性）

Qoder 使用 **CLI 原生 stream-json + stdio 控制协议**，而不是另装 SDK 依赖：

```text
qodercli --print
  --output-format stream-json
  --input-format stream-json
  --permission-prompt-tool stdio
  --permission-mode <default|accept_edits|auto|dont_ask|plan>
  --session-id <uuid>      # spawn
  --resume <session-id>    # resume
```

- **启动握手**：发送 `control_request {type:"initialize"}`，等待 `system/init`；从 init 读取真实的 `session_id`、model 和 permissionMode。
- **事件映射**：`assistant` 的 text/tool_use → `assistant_message` / `tool_start`；`user` 的 tool_result → `tool_end`；`result` → `turn_complete`、`usage`（input/output tokens、cost/credits）和最终 `settled`；`result.is_error=true` → `run.failed`。Qoder 未登录时返回的是 `subtype:"success"` + `is_error:true` 且错误文本在助手消息里，adapter 会把这种情况报为 failed，而不是 completed。
- **预提示错误**：真实 qodercli 可能在收到 prompt 前就因认证检查发出错误 result；adapter 会缓存该错误，在 prompt 阶段抛出并走统一的启动失败清理，避免在 `worker.started`/`worker.session` 之前直接 settle。
- **追加指令**：`steer` 发送 `priority:"next"` 的 user 消息，`follow-up` 发送 `priority:"later"`；每条消息有独立 uuid。Qoder 的多轮 result 通过 `350ms`（无待处理消息）或 `1.5s`（有待处理消息）静默窗口合并为一次终态，避免把中间 turn 误判为完成。
- **取消**：先对已发送的 steer/follow-up 发 `cancel_async_message`，只把 CLI 明确返回 `cancelled:true` 的消息计入 `queue_cleared`；再发 `interrupt {cancel_queued:true}`；若进程不退出，Supervisor 仍会终止进程树。
- **权限**：CLI 的 `can_use_tool` 控制请求映射为 `run.needs_input`（审批为 `select: allow/deny`，AskUserQuestion 为 `select`/`input`）；`worker_answer` 通过 `control_response` 返回 allow/deny 或 answers。5 分钟未回答会 deny，避免 Harness 永久卡住。
- **认证与配置隔离**：桌面端注入的 `QODER_AGENT_SDK_ENTRYPOINT`、`QODER_AGENT_SDK_VERSION`、临时 auth payload、`QODER_WORKER_*` 会在子进程环境中移除，避免把 CLI 误当成 SDK 子进程；保留 `QODER_CONFIG_DIR`、`QODERCN_CONFIG_DIR`、`QODER_PERSONAL_ACCESS_TOKEN` 等正常凭据/配置来源。
- **安全默认**：`HARNESS_SUPERVISOR_QODER_PERMISSION_MODE` 默认 `auto`；只允许 `default / accept_edits / auto / dont_ask / plan`，明确拒绝 `bypass_permissions`、`yolo`、`--dangerously-skip-permissions`。`extraArgs` 不能覆盖 session、permission、cwd、settings、MCP/远程控制等由 Supervisor 管理的参数。
- **会话文件**：优先按 Qoder 的 `projects/<encoded-cwd>/<session-id>.jsonl` 定位，找不到时只在候选配置根目录的 `projects/*/` 下按文件名查找；不读取 session 内容。Qoder 可能首轮结束后才落盘，或落在另一个配置根；Supervisor 在 settle 时重新查询并更新记录（`worker.session` 带 `refreshed:true`），若仍不存在则 resume 诚实拒绝。

**当前验证状态（必须明确）**：真实 `qodercli 1.1.76` + `DeepSeek-Flash` 的纯文本 worker 与 native resume 已在 Windows 实测通过（同一 session ID/文件、`resumeCount=1`、两次结果分别为 `QODER_E2E_OK` / `QODER_RESUME_OK`，无旧结果重放）；真实 `steer`、`cancel` 和工具权限审批仍未在真实模型上验证。协议本身还由 `qodercli 1.1.75` 的初始化/未登录路径探测与 `test/fixtures/fake-qoder.ts` 覆盖。README 仍把它标为实验性，不把协议测试等同于全部真实宿主能力。真实 E2E 命令：`npm run e2e:qoder`。

测试使用 `test/fixtures/fake-harness.ts` 与 `test/fixtures/fake-qoder.ts`：它们分别实现 Pi RPC 和 Qoder stream-json 的脚本化子集，由**真实生产 adapter、daemon 和状态机**驱动，不绕过实现。

---

## 8. 安全与资源边界

**v0.1 不是沙箱，也不提供文件系统隔离。**

- **cwd 只是默认工作目录**：Supervisor 只校验它存在且是目录，并把它作为 Pi/Qoder 进程的初始 cwd。它不限制 Harness 的 bash/read/write/edit 等工具访问该目录之外的路径；不要把 cwd 当作文件隔离机制。
- **同一 OS 用户 = 同一个信任域**：Worker 继承 daemon 的环境变量，拥有与 daemon 相同的文件、网络和进程权限。它可以读取其他 Worker 的 session/事件、Supervisor 状态目录以及 `ipc.token`。因此不要在同一用户下运行不可信 Worker 与 Supervisor。
- **本地 IPC 认证**：daemon 在状态目录生成随机 token（`ipc.token`；POSIX 创建时 0600，Windows 继承目录 ACL），客户端必须通过 timing-safe hello 握手。token 不写日志、不回显；但同用户进程仍可读取该文件，所以 token 不能防御同用户恶意 Worker。
- **凭据**：Supervisor 自身的日志、事件、stderr、结果和错误会做静态模式与敏感环境变量值脱敏，但这是**捕获后的尽力而为**，不是访问控制。Worker 仍能读取继承的环境变量，也可能把凭据写入自己的输出或被 Harness 记录。`--api-key` / `--no-session` 被禁止放进 Pi 的 `extraArgs`；Qoder 的 `--settings`、`--permission-mode`、`--dangerously-skip-permissions`、`--remote*`、`--cwd` 等也被禁止覆盖。但这些只约束显式参数，不改变环境继承。
- **工具 allowlist 不是沙箱**：`tools` 只限制传给 Harness 的工具集合；Pi 扩展 / Qoder plugins、shell 和网络能力仍可能扩大边界。
- **Qoder 认证**：`qodercli login` 的登录态保存在用户 Qoder 配置目录中；Supervisor 不读取、不复制、不记录其 token。Qoder CLI 进程仍以当前 OS 用户身份运行，能访问该用户可访问的 Qoder 配置与 session 数据。桌面端注入的 SDK 入口/临时 auth payload 会被剥离，避免意外复用桌面端宿主凭据。
- **Qoder 权限模式**：默认 `auto` 是 Qoder 自己的无人值守策略（安全读取/工作区编辑可自动批准，风险动作由其分类器或规则处理）；它不是 Supervisor 的沙箱，也不代表所有动作都已批准。需要更严格时设置 `HARNESS_SUPERVISOR_QODER_PERMISSION_MODE=accept_edits` 或 `default`，把 `ask` 请求转成 `awaiting_input` 交给主 Agent。`bypass_permissions` / `yolo` 被明确拒绝，不会为了方便测试自动跳过审批。
- **Qoder session 内容**：Qoder 的 session 文件可能包含完整对话与工具结果，位于用户 Qoder 配置目录；Supervisor 只在 `resume` 前后检查路径/ID，不把内容复制进自己的状态目录或证据目录。需要保留证据时应先脱敏。
- **Codex 的 sandbox 不等于 MCP 沙箱**：`codex exec -s read-only` 只约束 Codex 的 shell 工具；MCP server 及其启动的 Worker 仍是宿主进程，可写 Supervisor 状态目录和运行本地命令。Codex 侧的 `default_tools_approval_mode` 是工具调用边界，不是文件系统隔离。
- **生命周期控制 ≠ 资源配额**：`maxDurationMs`、取消和 `maxWorkers` 只控制进程生命周期，不限制 CPU、内存、磁盘、网络或子进程产生的资源消耗。
- **取消范围**：只针对该 Worker 的 PID / 进程组，不用命令字符串过滤作为安全边界。daemon 重启后的 `orphaned` 进程不再受控，Supervisor 不会假装取消。
- **Supervisor 不自动重试**：进程断开、daemon 重启、任务失败都不会由 Supervisor 自动重跑可能产生副作用的任务。Pi 自身的 provider 级 auto-retry 仍由其配置控制，Supervisor 只透传 `auto_retry_*` 事件；需要严格禁止时应在 Pi 侧关闭。
- **限制**：默认最多 8 个并发 Worker；wait 最大 120s；prompt 最大 256K 字符；保存结果最大 64K；stderr 环形截断；IPC 请求行有大小上限。
- **不删除用户数据**：Supervisor 只管理自己的状态目录与 Worker 进程；没有删除 Worker/会话的命令。
- **建议**：不可信任务使用容器 / VM / 独立低权限用户运行；限制其对 Supervisor 状态目录和其他 Worker 数据的访问；使用专用只读或临时工作目录；限制网络与工具；把 Pi/Qoder 凭据放在隔离配置中。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `HARNESS_SUPERVISOR_HOME` | 状态目录 |
| `HARNESS_SUPERVISOR_PI_ENTRY` | Pi launcher / CLI JS 入口（Windows 推荐） |
| `HARNESS_SUPERVISOR_PI_BIN` | Pi 可执行文件 |
| `HARNESS_SUPERVISOR_PI_ARGS` | 追加给 Pi 的 JSON 字符串数组 |
| `HARNESS_SUPERVISOR_QODER_BIN` | qodercli 可执行文件（不接受 `.cmd/.bat` shim） |
| `HARNESS_SUPERVISOR_QODER_ENTRY` | qodercli 的 JS 入口（测试/替代启动） |
| `HARNESS_SUPERVISOR_QODER_ARGS` | 追加给 qodercli 的 JSON 字符串数组（受保留参数限制） |
| `HARNESS_SUPERVISOR_QODER_PERMISSION_MODE` | Qoder 权限模式，默认 `auto`；拒绝 bypass/yolo |
| `HARNESS_SUPERVISOR_MAX_WORKERS` | 并发 Worker 上限 |
| `HARNESS_SUPERVISOR_MAX_WAIT_MS` | wait 上限 |
| `HARNESS_SUPERVISOR_ABORT_TIMEOUT_MS` | abort 等待上限 |
| `HARNESS_SUPERVISOR_CLOSE_GRACE_MS` | 关闭 Harness 的宽限时间 |
| `HARNESS_SUPERVISOR_DAEMON_ENTRY` | 覆盖 daemon 入口（开发/测试） |

---

## 9. 测试与真实证据

### 自动化测试（模拟 Harness）

```bash
npm test
```

结果（最终运行）：

- 45 个单元测试：JSONL framing、脱敏、持久化/游标、IPC 协议校验、Pi 启动参数、Qoder 启动/环境隔离/权限参数/配置根优先级，以及通知收件箱、幂等记录、PID 身份判定
- 59 个集成测试：CLI、daemon、并发取消隔离、增量事件、steer、extension 授权、失败/崩溃/取消区分、max duration、强制终止、daemon 崩溃/重启对账/resume、优雅关闭、MCP 全流程与客户端断连、MCP 条件等待与紧凑事件、Qoder stream-json 全流程（含 late session 与跨配置根刷新）、通知/幂等/prune/PID 复用、性能探针，以及并发/竞态回归
- 2 个依赖真实 Pi 的测试默认跳过（`RUN_REAL_PI=1`）；其中 native session resume 测试不调用模型，real worker 测试会调用一次低成本模型

最终运行：106 tests，104 pass，0 fail，2 skipped。完整输出见 [`evidence/test-suite-v02.txt`](evidence/test-suite-v02.txt)。

覆盖的关键断言包括：

- spawn 在任务完成前返回；
- 主客户端断开后 Worker 继续并最终完成；
- 事件 seq 严格递增、游标不重复；
- 有界 wait 在超时后返回 `timedOut`；
- steer 内容出现在 Worker 最终结果；
- 取消一个 Worker 时另一个正常完成；
- completed / failed / cancelled / crashed 是不同终态；
- daemon 被 SIGKILL 后不会自动重跑，重启后标记为 interrupted/orphaned；
- resume 在 session 文件缺失时明确拒绝，不伪造成功；resumeCount 只在加载和新 prompt 都成功后增加；
- 不响应 abort 的 Harness 会被强制终止并确认进程死亡；
- MCP 客户端断开后 daemon 和 Worker 继续，重连可读到完成结果；
- MCP `worker_wait` 不带游标时能看到已经发生的 `run.started`，带游标时不重放；
- MCP `worker_wait` 默认省略 `run.progress` 并报告 `eventsOmitted`，`includeProgress=true` 或 `types=["run.progress"]` 时返回进度；
- MCP 服务器 instructions 和只读工具的 annotation 可见；
- 并发 spawn 不能突破 `maxWorkers`；
- 取消开始后 send/answer 被拒绝，重复 answer 只有一个成功；
- 取消会先清空 Pi 队列，非空清空记录 `queue_cleared`；
- 启动过程中取消会在 prompt 被接受前生效；
- 并发重复 cancel 幂等，且只记录一次 `run.cancelled`；
- shutdown 会等待 in-flight spawn 结束，不遗留活动 Worker；
- 并发 resume 只产生一个 runtime；
- 对仍存活的 `orphaned` PID，cancel 明确返回 `UNSUPPORTED`，不伪造成功。
- Qoder：`system/init` 记录 session、工具调用产生 `tool_start/tool_end`、`result` 产生 `usage/turn_complete`；
- Qoder：steer 不产生第二个 Worker，最终结果包含 steer 内容，只记录一次 `run.completed`；
- Qoder：取消只统计 CLI 确认 `cancelled:true` 的队列消息，进程 PID 被确认终止，重复 cancel 只有一条 `run.cancelled`；
- Qoder：resume 使用同一 session ID/文件，新 prompt 生效，`resumeCount=1`，不重放第一次结果；
- Qoder：`can_use_tool` 审批可 allow/deny，分别得到 completed 与 failed；
- Qoder：未登录的 in-band 错误必须报 `failed`，不能因为 `subtype:"success"` 误报 `completed`；
- Qoder：prompt 之前的预提示 auth 错误也必须失败并保留登录提示，不能卡在 starting 或被忽略；
- Qoder：首轮结束后才出现的 session 文件、以及实际位于另一个配置根目录的 session，会在 settle 时刷新并记录，保证 resume 可用。

Qoder 测试使用 `test/fixtures/fake-qoder.ts`。它的消息形状来自 Qoder Agent SDK 1.0.55 的协议类型和真实 `qodercli 1.1.75` 的探测，但它仍是模拟进程；**自动化通过不等于真实模型已经跑通**。

### 真实 Qoder CLI 协议探测（不调用模型）

2026-10-22 在 Windows 上用真实 `qodercli 1.1.75` 做了一次无会话持久化探测：发送 `initialize` 控制请求和一条 user 消息，工具集为空，未登录。真实 CLI 返回：

1. `system/init` —— 说明真实 CLI 接受 Supervisor 使用的 initialize 握手；
2. `assistant` —— 文本 `Not logged in · Please run /login`；
3. `result` —— `subtype:"success"`、`is_error:true`、`terminal_reason:"completed"`，没有 `errors` 数组。

这验证了协议握手，也暴露了真实错误形态：未登录错误不是进程退出码 42，而是 in-band 的错误 result。适配器已把这种结果映射为 `failed` 并附带登录提示；回归测试见 `Qoder in-band auth failures`。证据见 [`evidence/qoder-protocol-probe/probe.txt`](evidence/qoder-protocol-probe/probe.txt)。该探测没有调用模型，也没有生成持久化 Qoder session；它**不代表**真实 worker/steer/cancel/resume 已验证。

随后又用真实 `qodercli` 通过完整 daemon/adapter 链路跑了一次**未登录、无模型调用**的 spawn（`QODER_CONFIG_DIR`/`QODERCN_CONFIG_DIR` 指向临时目录，未触碰用户 Qoder 配置）：spawn 以 `INVALID_STATE` 退出，Worker 记录为 `failed`，错误包含 `Not logged in` 和 `qodercli login` 提示；daemon 停止后 PID 已确认死亡。这验证了真实二进制的定位、initialize/system-init 握手、in-band 错误映射和清理，但仍不是一次完成的真实模型运行。证据见 [`evidence/qoder-real-adapter-probe/probe.txt`](evidence/qoder-real-adapter-probe/probe.txt)。

### 真实 Qoder Worker + Resume（已执行）

2026-10-22 使用用户本人的 `qodercli login`（登录态位于 `~/.qoder`）和低成本 `DeepSeek-Flash` 运行：

```bash
env -u QODERCN_CONFIG_DIR -u QODER_CONFIG_DIR \
QODER_REAL=1 QODER_REAL_MODEL="DeepSeek-Flash" node scripts/e2e-qoder.mjs
```

实际结果：`qodercli 1.1.76`，worker `w-mvj3cs8c-bac88ff1`，spawn 约 9.7s 返回；首轮 10.0s 完成并返回 `QODER_E2E_OK`；随后 `resume` 返回 `QODER_RESUME_OK`，session ID `cd9efaad-750d-4783-b305-b3ad44e0933a` 与 session 文件均保持不变，`resumeCount=1`，第二个结果没有重放第一个答案；外部 daemon 在运行期间保持存活。任务为纯文本，不调用工具，因此没有自动批准任何权限。

注意事项：Qoder 的 result 中 `usage` / `total_credits` 全为 0，这表示 CLI 没有上报 token/费用，不代表真实零成本；本项目不据此推断节省额度。首轮结束后 session 文件才出现，且实际位于登录配置根 `~/.qoder`；adapter 在 settle 时会刷新并记录真实路径（见下文 late-session 回归测试）。证据见 [`evidence/qoder-real/result.json`](evidence/qoder-real/result.json)、[`events.jsonl`](evidence/qoder-real/events.jsonl) 与 [`test-run.txt`](evidence/qoder-real/test-run.txt)。

仍未验证：真实 `steer`、真实 `cancel`、工具调用与 `can_use_tool` 审批。这些需要额外真实模型调用和人工审批策略，不应由本次纯文本 E2E 冒充。

### 真实 Pi Worker

```bash
RUN_REAL_PI=1 \
REAL_PI_MODEL=deepseek-v4.1-flash-1017 \
REAL_PI_PROVIDER=new-api \
node test/run.mjs e2e
```

实际结果：worker `w-mvi7k7co-1cee0dd5` 在独立 cwd 创建 `worker-output.txt`（内容 `SUPERVISOR_E2E_OK`），最终回复 `WORKER_DONE`，状态 `completed`，退出码 0，用时约 11.8s。证据见 [`evidence/real-pi-worker/result.json`](evidence/real-pi-worker/result.json)。

原生 Pi session 加载（不调用模型）：`RUN_REAL_PI=1 node test/run.mjs e2e --test-name-pattern "loads a persisted session"` 通过，验证了 `--session <file>` 后 session ID 与 session 文件路径保持不变。见 [`evidence/real-pi-resume.txt`](evidence/real-pi-resume.txt)。

### 真实 Pi → Pi（父 Agent 通过 Supervisor 控制子 Agent）

```bash
npm run e2e:parent
```

实际结果：父 Pi（真实模型）通过 bash 工具调用 Supervisor CLI；Supervisor 启动真实子 Pi Worker；子 Worker 写文件并返回 `WORKER_DONE`；父 Agent 读取文件后回复 `PARENT_E2E_OK`。所有断言通过，父进程 exit 0。证据见 [`evidence/parent-pi/result.json`](evidence/parent-pi/result.json) 与 [`evidence/parent-pi/run-child-worker.sh`](evidence/parent-pi/run-child-worker.sh)。

### 真实 Codex 宿主（`codex-cli 0.161.0`，Windows）

```powershell
# 先在 Codex 之外启动 daemon，再运行一次真实 Codex + 真实 Pi
node dist/src/cli.js up
$env:CODEX_WORKER_MODE="real"; $env:RUN_CODEX="1"; node scripts/e2e-codex.mjs
```

实际结果（正式运行）：Codex 完成 4 个 MCP 调用（`worker_spawn` / `worker_wait` / `worker_send` / `worker_wait`），只创建 1 个 Worker；Worker 在运行中收到 `CODEX_STEER` 并完成，结果为 `REAL_CODEX_OK`；外部预启动的 daemon 在 Codex 退出后仍可连接。Codex 用量：79,662 input / 301 output tokens。证据见 [`evidence/codex-real-pi/test-run.txt`](evidence/codex-real-pi/test-run.txt) 与同目录的 `codex.jsonl`、`worker.json`、`events.jsonl`。

自动拉起 daemon 的实验见 [`evidence/codex-auto-start/`](evidence/codex-auto-start/)：Codex 退出时杀掉了整个 MCP 进程树，daemon 无 shutdown 记录、`daemon.lock` 残留。这就是必须以外部 daemon 运行的原因。`scripts/e2e-codex.mjs` 默认 fake Pi 模式，适合重复验证宿主传输；real 模式会额外产生真实 Pi 调用。该脚本和 Codex 的审批/进程树行为都只在上述版本与平台实测。

### 真实 Codex 桌面端交互（GPT-6 Luna）

使用真实 Codex 桌面端、外部预启动 daemon 和真实 Pi，已验证：

- 运行中 steer：`worker_send` 在 `sleep 20` 期间发送，`run.message_sent`（seq 7）早于完成（seq 15），文件包含 `FIRST` 与 `STEERED_BY_CODEX`；
- cancel：排队 steer 被清除（`queue_cleared steering=1`），受测 PID 真实退出，只记录一次 `run.cancelled`，重复取消幂等，对照 Worker 不受影响；
- resume：同一 session ID/文件、`resumeCount=1`、新 PID，验证码只从会话上下文恢复，seed 文件未被重放；
- 客户端断连/重连：外部 daemon PID 和启动时间不变，Worker PID 连续，重连后读取到完成结果。

证据索引见 [`evidence/README.md`](evidence/README.md) 第 6 节。桌面端测试仍受 pull-only 限制；所有结果都是通过 `worker_wait` 拉取，不宣称后台唤醒。

### 真实编码委派（Codex → Pi）

在独立仓库 `D:\tmp\hs-coding-task` 中，Codex（GPT-6 Luna）先读取测试并委派，真实 Pi（DeepSeek `deepseek-v4.1-flash-1017`）自主修改 `src/duration.js`、运行测试并完成。基线 11 tests（8 pass / 3 fail），最终 11/11 pass；测试未修改，Worker 用时 38.0s、7 turns、8 tool calls，无中途人工干预。Codex 实际 6 次工具调用（2 次 MCP、2 次 shell、2 次宿主调用），累计 239,581 input（199,552 cached）/ 891 output tokens；Pi 用量 45,896 tokens。此结果没有原生 Codex 基线，不能据此推断节省额度。证据见 [`evidence/coding-delegation/`](evidence/coding-delegation/test-run.txt)。

该委派还暴露了等待结果的上下文开销：旧版 `worker_wait` 返回 26 条进度事件（约 10 KB / 3,433 tokens）并被 Codex 截断。现已默认省略普通 `run.progress`，只保留状态变化、输入、消息、终态、队列清空和工具错误；需要完整进度时显式传 `includeProgress=true`。在同一份真实事件日志上，默认等待从 10,936 字符/27 个事件降到 4,047 字符/2 个事件（省略 25 条进度）。

### 成本控制

真实测试只使用 `deepseek-v4.1-flash-1017` 或当前配置的 Pi 模型；正式 Codex 验证只运行 1 个 Worker、1 次 Codex turn，不存在循环调用。日常测试全部使用本地模拟 Harness；`RUN_CODEX=1` 必须显式设置，否则脚本跳过。

---

## 10. 已知限制

1. **Pi 完整支持，Qoder 实验性**：Qoder CLI 已有协议 adapter、模拟协议测试与部分真实交互证据（工具调用、取消、AskUserQuestion 已真实验证；steer/follow-up 被接受但未生效；权限 allow/deny 未能触发）。不要把协议测试等同于真实宿主能力。
2. **Pull-only 事件 + 可选队列投递**：MCP 工具本身仍是拉取式；重要事件可用 `supervisor_notifications` 读取，或通过 `codex-queue` 通道投递给已加载的 Codex thread（at-least-once，不保证唤醒）。
3. **无 pause**：Pi/Qoder 都没有可继续的 pause 原语；resume 是新进程 + 持久化 session。
4. **自然语言“提问”不自动变成交互**：只有原生 extension dialog（Pi）或 `can_use_tool`（Qoder）会进入 `awaiting_input`。
5. **daemon 崩溃后无法接管原管道**：只做状态对账，不假装重连；仍存活的 `orphaned` 进程不能通过 Supervisor 取消，需人工确认 PID 后终止。
6. **PID 复用风险已缓解但未消除**：对账会比对命令行 token（见“PID 复用与进程身份校验”），能区分“PID 被复用”和“原进程仍存活”；命令行不可读时仍回退为保守的 `orphaned`，不会自动重跑或杀进程。
7. **非沙箱，cwd 不是隔离**：Worker 与 daemon 同用户、继承环境变量，并可按该用户的权限访问文件系统和网络，包括 Supervisor 状态目录与 `ipc.token`；不可信任务必须容器化/独立用户运行。
8. **事件日志默认无自动保留策略**：事件 JSONL 仍按 Worker 增长（文本 delta 不入库）；可用 `prune` 显式清理终态 Worker 并压实通知/幂等元数据，但不会自动删除活跃 Worker 或未确认通知。
9. **单用户本地 daemon**：没有用户/团队/权限后台，也没有远程 MCP 认证。
10. **Windows 原生**已验证；非 detached 的 Pi 子进程通常在 daemon 被强杀后随之退出（对账为 `interrupted`），POSIX 或自行存活的进程才可能成为 `orphaned`。WSL 需要自行在 WSL 内安装 Node + Pi，本项目未在该环境实测。不要用 `.cmd` shim 作为 `HARNESS_SUPERVISOR_PI_BIN`。
11. **结果文本可能很大**：存储与事件展示有上限；完整 Pi session 文件保留原始记录。
12. **MCP 工具超时**：宿主必须把 tool timeout 配到比 wait 更长。
13. **极端强杀下的持久化窗口**：daemon 被强制杀死时，事件/状态快照的最后一个异步写可能尚未落盘；重启会按已有记录保守对账，不猜测成功。
14. **示例中的 model/provider 仅是验证环境配置**：请替换为你自己的 Pi provider/model。
15. **幂等是可选的，且不是 exactly-once**：`requestId` 只覆盖 `spawn`/`resume`/`send` 的“不重复执行”意图；未带 `requestId` 的老客户端行为不变。daemon 在执行中崩溃时返回 `UNCERTAIN`，调用方必须自行查 `status`/`list`；Qoder 的 `send` 无法保证不重复送达 harness。
16. **关停有等待上限**：shutdown 最多等待 in-flight 准入 5 秒，之后进入取消/强杀；若 Harness 连强杀都不响应，或 daemon 本身被更底层机制杀死，仍可能需要人工清理残留进程。
17. **工具子进程的清理上限**：取消/强杀覆盖 Harness 的进程树/进程组；若 Harness 先退出，且它启动的工具子进程被 OS 重新挂接，Supervisor 无法再追踪这些孙进程。需要更强保证时应结合 OS 级 Job Object / cgroup 管理。
18. **Codex 宿主进程树**：实测 `codex exec 0.161.0` 退出会杀掉 MCP server 的整个进程树；必须先在 Codex 之外启动 daemon，才能让 Worker 跨越 Codex 退出继续运行。交互式 Codex 的生命周期未单独实测。
19. **Qoder 多轮终态是协议启发式**：Qoder 的 stream-json 可能为 steer/follow-up 产生中间 `result`；adapter 用 350ms/1.5s 静默窗口合并为一次终态。已增加确定性协议测试：两个 `result` 间隔 200ms（窗口内）会合并为一次终态并采用最后一个结果；间隔 2000ms（窗口外）会先以第一个结果结束、迟到结果被忽略。真实 E2E 中 follow-up 没有产生第二个 turn（`extraTurns=1`），steer 被 CLI 接受但未影响当前 turn，所以“多轮”能力在 1.1.76 上仍未得到真实验证；窗口外迟到 result 的语义限制依然存在（已由测试固定，不伪装为支持）。
20. **Qoder 权限交互仅部分真实验证**：AskUserQuestion 已真实走通 `can_use_tool → awaiting_input → worker_answer`；但 `permission mode=default` 下 Bash 调用未产生审批请求，因此 allow/deny 两条路径仍只有模拟测试覆盖。`auto` 模式仍可能按 Qoder 自己的策略自动处理动作，不等同于人工审批。
21. **Qoder session 布局已真实 resume 验证，但仍依赖版本**：真实 E2E 已验证同一 session ID/文件的 `--resume`；session 文件按 `projects/<encoded-cwd>/<session-id>.jsonl` 定位，首轮后才出现，且可能位于另一个配置根（本机为 `~/.qoder`）。adapter 在 settle 时刷新真实路径，但这依赖当前布局；Qoder 版本变化可能改变。
22. **Qoder 版本范围**：协议形状在 `qodercli 1.1.75`（无登录探测）和 `1.1.76`（真实 worker/resume/工具调用/取消/AskUserQuestion）上验证，参考 Qoder Agent SDK 1.0.55；其他版本的字段、权限模式、session 布局或 stream-json 行为可能不同。升级后应重新运行 Qoder 测试与真实 E2E。
23. **SSH 科研场景未验证（P2）**：本轮没有可用的、经用户授权的远程主机与凭据，因此没有执行 SSH + 长作业的真实场景。已明确的能力边界：Worker 进程、SSH 连接、远程作业三个生命周期互相独立，HS 只能管理第一个；远程作业是否存活必须由 Worker 通过原生 SSH/Slurm 工具自行确认，HS 不会代为判断。

---

## 11. 下一步值得扩展（不急）

- Codex 桌面端 A 级唤醒的重复稳定性复验（单次已通过：`evidence/desktop-wake-1022/`；建议覆盖多通知并发、桌面忙碌/离线、长摘要等场景）
- 定位 Qoder 官方的异步消息入口，使 steer/follow-up 真实生效（当前 `priority` user 消息被接受但未生效）
- 用写文件类工具或不同 Qoder 版本触发真实 allow/deny 审批
- 事件日志的按 Worker 自动归档（当前仅提供 `prune` 显式维护）
- Windows 本地通知（toast）作为 C 级可选提醒通道
- 更严格的沙箱与 per-worker 环境变量 allowlist
- 可选的 artifact/manifest 输出，而不是只依赖最终文本
- Resume 时附带“上次运行摘要”，减少主 Agent 重新读取全部事件的成本
- OS 级进程指纹（启动时间）与 PID 复用防护
- JSON Schema 版本的公开 API 契约与向后兼容策略

---

## 12. 项目结构

```
src/
  adapters/pi/        Pi 原生 RPC 适配器、启动解析、JSONL session
  adapters/qoder/     Qoder CLI stream-json/stdio 适配器（实验性）
  ipc/                named pipe / Unix socket、token、server/client
  util/               JSONL、脱敏、日志、文件
  types.ts            公开类型与 Worker/Event schema
  store.ts            持久化 + 追加式事件日志 + 游标
  supervisor.ts       生命周期状态机、wait、cancel、resume、重启对账
  daemon.ts           daemon 入口逻辑
  daemon-entry.ts     detached daemon 进程入口
  cli.ts              CLI
  mcp.ts              MCP server
  index.ts            库导出
test/
  fixtures/           脚本化 Pi RPC / Qoder stream-json Harness（仅测试）
  unit/ integration/ e2e/
scripts/
  e2e-parent-pi.mjs   真实父 Pi -> 子 Pi 证据脚本
  e2e-qoder.mjs       真实 Qoder worker + resume 脚本（需登录）
evidence/             实际运行产物与断言（qoder-protocol-probe 为真实 CLI 无模型探测）
examples/             Codex / 通用 MCP / CLI 示例
```

---

## 13. License

MIT

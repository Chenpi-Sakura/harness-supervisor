# Harness Supervisor v0.1

一个轻量的本地生命周期与通信层，让主 Agent 通过 **CLI** 或 **MCP** 启动、观察、指导、取消和恢复其他厂商的原生 AI Harness。首版完整支持 **Pi Agent**（Pi v1.3+ 原生 RPC）。

它管理的是 **进程、会话和事件**，不是新的多智能体框架：

- 不做 Planner / Reviewer / Implement 角色拆分
- 不做任务 DAG、讨论投票、智能模型路由
- 不引入额外的 LLM 做调度或生命周期管理
- 不重复实现 Pi 的 Agent 循环，只控制它

> 一句话：主 Agent 只负责决策；Pi 仍然是 Pi；Supervisor 负责让“另一个 Pi”变得可启动、可观测、可插话、可取消、可恢复。

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
                                │  Pi 原生 RPC（严格 JSONL）
                                ▼
                    Pi worker 子进程
                    ├─ 自己的 cwd
                    ├─ 自己的 session 文件
                    └─ 自己的进程树（可精确终止）
```

关键设计：**Worker 属于 daemon，而不是 CLI/MCP 连接**。

- 主客户端断开，Worker 继续运行，之后可重新查询。
- MCP 工具是 request/response 拉取模型。Supervisor **不声称**能后台唤醒主 Agent。
- daemon 被强制杀死后，不能重新接上原来的 stdin/stdout 管道；重启后会把未完成 Worker 明确标记为 `orphaned` 或 `interrupted`，绝不自动重跑。

---

## 2. 环境要求

- Node.js **>= 22.19**（开发与验证使用 Node v24.21.0）
- Pi Agent **>= 1.3**，并已配置好 provider / model / 凭据
- **Windows 原生环境已实测**；WSL 需要在 WSL 内单独安装 Node 与 Pi，本项目未在本机 WSL 中实测
  - Windows 下 Supervisor 会自动定位 `~/.pi/agent/bin/pi-launcher.js`
  - 也可通过 `HARNESS_SUPERVISOR_PI_ENTRY=<pi-launcher.js 或 Pi CLI JS 入口>` 指定
  - `HARNESS_SUPERVISOR_PI_BIN` 可指定真实可执行文件，但不接受 `.cmd/.bat` shim（避免 shell 注入）

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

# 查询状态 + 最近事件
node dist/src/cli.js status <workerId>

# Worker 运行期间追加指令（Pi native steer）
node dist/src/cli.js send <workerId> --message "Also add a timestamp to the file." --mode steer

# 增量读取事件（sinceSeq 游标）
node dist/src/cli.js events <workerId> --since 0 --limit 100

# 有超时边界的等待：直到终态
node dist/src/cli.js wait <workerId> --since 0 --timeout-ms 60000

# 取消受控 Worker（先清空 Pi 队列，再 abort；必要时终止进程树）
node dist/src/cli.js cancel <workerId>

# 在 Pi 持久化 session 存在且旧进程已退出时，继续该会话
node dist/src/cli.js resume <workerId> --prompt "Continue and summarize what changed."

# 优雅关闭 daemon（会取消所有活动 Worker）
node dist/src/cli.js down
```

### 重要语义

| 行为 | 含义 |
| --- | --- |
| `spawn` 返回 `running` | Pi 已接受 prompt，**任务尚未完成** |
| `wait` 返回 `terminal: true` | Worker 已进入终态，`completed / failed / cancelled / crashed / orphaned / interrupted` 之一 |
| `run.completed` + `result.text` | Pi 原生 `agent_settled` 且没有 abort/error |
| `run.failed` | Pi 报告了 provider/run 错误，或启动失败 |
| `run.cancelled` | 主动取消、超时或 Supervisor 关闭 |
| `crashed` | Harness 进程在 settle 前异常退出 |

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

### 工具清单

| 工具 | 用途 |
| --- | --- |
| `worker_spawn` | 启动 Worker；**prompt 被接受即返回**，不等待完成；返回 `id`、`lastSeq` |
| `worker_status` | 状态、`lastSeq`、最近事件、pending input、结果/错误、stderr 尾部 |
| `worker_list` | 列出 Worker（持久化，跨 daemon 重启） |
| `worker_events` | 按 `sinceSeq` 增量读取事件；`sinceSeq=0` 读完整历史 |
| `worker_wait` | 有界长轮询；默认 20s，最大 120s；不带 `sinceSeq` 时先检查当前状态/最近 20 条事件，再等待；带 `sinceSeq` 时严格按游标增量 |
| `worker_send` | 运行中追加 `steer` / `follow-up`；不用于回答扩展对话框 |
| `worker_answer` | 回答 `run.needs_input`（Pi extension select/confirm/input/editor） |
| `worker_cancel` | abort + 终止进程树 + 确认终态；不影响其他 Worker |
| `worker_resume` | 用新指令显式恢复已有 Pi session；校验 session ID，拒绝伪造成功 |
| `supervisor_info` | 版本、限制、runtime capability、pull-only 唤醒边界 |

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
- 终态后重复调用不带游标的 `worker_wait` 会立即返回，不应用于轮询循环；读状态或结果后应停止。

### 关于“主动唤醒”

- `run.needs_input`、进度、完成事件都会写入 daemon 的事件日志。
- MCP 工具调用是拉取式的：宿主必须调用 `worker_wait` / `worker_events` 才能看到事件。
- 本项目不伪造“后台无限唤醒主 Agent”的能力。若宿主未来支持 notification/channel，可在其上增加推送层；v0.1 没有。
- 宿主的 MCP tool timeout 必须大于你设置的 `worker_wait` 时间。

### Codex 宿主限制（实测）

- **进程树清理**：`codex exec 0.161.0` 退出时会终止 MCP server 的整个进程树。自动拉起的 daemon 也会被杀，且没有 shutdown 记录；因此长任务应使用外部预启动 daemon。`evidence/codex-auto-start/daemon.log` 与残留 `daemon.lock` 是实测证据。
- **无后台唤醒**：在本次 `codex exec` 流程中，所有观察都发生在同步 MCP 工具调用内；没有可用的“daemon 主动把新 turn 推给 Codex”的机制。主 Agent 必须在当前 turn 调用 `worker_wait`。
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

状态之外，Worker 记录还包含：独立 ID、cwd、PID、Pi session ID/文件、退出码、token/turn/tool 统计、pending input、最近事件、resume 信息。

### 事件

- `worker.starting` / `worker.started` / `worker.session`
- `run.accepted` / `run.started`
- `run.progress`（tool start/end、turn complete、assistant message、retry、compaction、notification、`queue_cleared`）
- `run.needs_input` / `run.input_answered`
- `run.message_sent`
- `run.error`
- `run.completed` / `run.failed` / `run.cancelled`
- `worker.cancel_requested` / `worker.exited` / `worker.crashed`
- `worker.orphaned` / `worker.interrupted` / `worker.resumed` / `worker.resume_failed`

每个 Worker 的事件序列 `seq` 从 1 单调递增。`nextSeq` 可直接作为下一次增量读取的游标。原始 token 级 text delta 不落盘；只保存规范化进度，避免事件日志无限膨胀。

### 等待

- `worker_wait({ sinceSeq, timeoutMs, until: "terminal"|"event", types })`
- 默认 `sinceSeq` 是当前末尾，只等新事件；传 `0` 可拿到全部历史。
- 返回 `timedOut`、`terminal`、`events`、`nextSeq`、`hasMore`。
- 若 Worker 进入 `awaiting_input`，即使 `until: "terminal"` 也会立即返回（`terminal: false`），让授权请求不会被 wait 超时掩盖。
- 不重复读取全部历史；客户端自己维护游标。

### 需要进一步指令

Pi 的 `extension_ui_request`（select / confirm / input / editor）会映射为 `run.needs_input`，Worker 状态变为 `awaiting_input`。`worker_answer` 会发送 `extension_ui_response`，恢复为 `running`。

限制：如果 Worker 只是在普通回复里写“请确认是否继续”，Pi 没有任何原生暂停机制，Supervisor 不会假装检测到问题或自动暂停。只有 Harness 自己发出扩展对话框时，才有 `awaiting_input`。

---

## 6. 恢复、关闭与重启边界

### Resume（恢复已有会话）

支持条件（全部满足才会执行）：

1. Worker 已处于终态，且当前没有活动 runtime；
2. Pi adapter 支持 resume；
3. Worker 记录了持久化 session 文件，且文件仍存在；
4. 旧 PID 不在运行；
5. Supervisor 启动新的 Pi 进程并**校验 session ID 与 session 文件路径**；
6. 调用方提供新的 prompt。

任何一步不满足都会返回 `UNSUPPORTED` / `INVALID_STATE`，不会静默创建新 session 并声称恢复成功。

`resume` 的语义是：**启动一个新的 Pi 进程，加载指定 session 文件，然后提交一个新的 prompt**。它不会续接原进程内存中的运行，不会补跑中断的 assistant turn，也不会重放旧工具调用或自动重试可能产生副作用的工作。`resumeCount` 和新 prompt 被接受后的 `worker.resumed` 事件都只在 session 校验通过、run 真正开始后记录；若加载失败，会恢复之前的终态并写 `worker.resume_failed`。

### 并发与控制语义

- **并发上限是原子占位**：`maxWorkers` 同时计入活动 Worker 和正在启动的请求，检查与创建之间的 await 窗口不能突破上限。
- **同一 Worker 的 resume 串行化**：第一次 resume 进行中时，第二次返回 `INVALID_STATE`，不会出现两个进程加载同一 session。
- **取消开始后拒绝新控制指令**：`send` / `answer` 会返回 `INVALID_STATE`；同一对话框的第二个 answer 也会被拒绝。已经发出但仍在 Pi 队列中的 steer/follow-up 会在 abort 前通过 `clear_queue` 清除。
- **取消顺序**：`clear_queue` → `abort` → 有界等待 `agent_settled` → 必要时强制终止进程树。Pi 文档说明 abort 会继续队列中的消息，所以必须先清队列；非空队列清空会记录 `run.progress`（`kind: "queue_cleared"`，只记录数量，不保存消息正文）。
- **关停屏障**：`shutdown` 先拒绝新的 spawn/resume/send/answer，等待进行中的准入最多 5 秒，再取消/强杀所有活动 runtime；不会出现关停快照漏掉刚启动 Worker 的情况。
- **线性化**：完成与取消同时发生时，以先完成的一方为准，可能返回 `completed`。终态只有在 Harness 进程停止后才可见。
- **不是事务型 API**：spawn/resume 没有幂等键。客户端超时后不要盲目重试，应先查 `status` / `list`；in-flight 的重复 resume 会被拒绝，但已完成的 resume 再调用是一次新的显式运行。

### Supervisor 重启

- **优雅关闭**（`down` / SIGINT / SIGTERM）：先进入关停屏障，取消所有活动 Worker，状态记录为 `cancelled` + reason `supervisor_shutdown`，然后退出。
- **强制杀死 / 崩溃**：未完成 Worker 在下次启动时被对账为：
  - `orphaned`：记录中的 PID 仍存活，但 daemon 已失去 stdin/stdout 控制通道；
  - `interrupted`：PID 已不存在，结果未知。
- **重启后没有任何 Worker 保留实时控制通道**。`status` / `events` / `wait` 仍可只读使用；不能对旧运行继续 steer 或 answer。若 daemon 在终态落盘前被杀，即使任务实际已完成，也会保守地报 `interrupted`（结果未知），不会自动改判为 `completed`；需要时只能显式 resume 读取 session。
- **客户端断开不是 Supervisor 重启**：daemon 仍在时，任何客户端重连后都可以继续 status/send/cancel；只有 daemon 进程本身退出/被杀，才进入上述对账路径。
- **`orphaned` 进程不能通过 Supervisor 取消**。Supervisor 会明确返回 `UNSUPPORTED`，而不是假装取消成功；需要在确认 PID 身份后由人工/平台工具终止。拒绝按记录 PID 自动 kill 是因为 PID 复用可能误杀无关进程。待旧进程真正退出后，才可以显式 resume。
- **`resumeAvailable` 只是前置条件**：它表示 session 文件存在、旧 PID 不在运行、adapter 支持 resume，并不保证 Pi 一定能加载该文件；真正的加载会校验 session ID/路径，失败则恢复原终态并报错，不伪造成功。
- 需要显式 `resume`，且只接受已持久化 session；旧 PID 仍存活时一律拒绝。`resume` 加载的是持久化会话，不会续接原运行。
- 平台差异：Windows 上非 detached 的 Pi 子进程在 daemon 被强杀后通常随之退出，记录会变为 `interrupted`；POSIX 或子进程自行存活时可能出现 `orphaned`。两种状态都不代表任务成功。

### 已知的 PID 复用注意事项

对账使用 `pid + 存活检查`，没有跨平台的进程启动时间指纹。极端情况下 PID 复用可能把新进程误判为旧 Worker；后果是更保守的 `orphaned`（拒绝自动处理、拒绝 resume），不会导致自动重跑。生产环境可在平台层增加进程启动时间校验。

### Pause

Pi 没有可用的 pause/resume 原语，Supervisor 不实现假暂停。capability 中明确 `pause: false`。`resume` 是“基于 Pi session 文件启动新进程并继续”，不是恢复同一个内存中的运行。

---

## 7. Pi Adapter 实现方式

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

测试使用 `test/fixtures/fake-harness.ts`：它实现 Pi RPC 的脚本化子集，由**真实生产 adapter、daemon 和状态机**驱动，不绕过实现。

---

## 8. 安全与资源边界

**v0.1 不是沙箱，也不提供文件系统隔离。**

- **cwd 只是默认工作目录**：Supervisor 只校验它存在且是目录，并把它作为 Pi 进程的初始 cwd。它不限制 Pi 的 bash/read/write/edit 等工具访问该目录之外的路径；不要把 cwd 当作文件隔离机制。
- **同一 OS 用户 = 同一个信任域**：Worker 继承 daemon 的环境变量，拥有与 daemon 相同的文件、网络和进程权限。它可以读取其他 Worker 的 session/事件、Supervisor 状态目录以及 `ipc.token`。因此不要在同一用户下运行不可信 Worker 与 Supervisor。
- **本地 IPC 认证**：daemon 在状态目录生成随机 token（`ipc.token`；POSIX 创建时 0600，Windows 继承目录 ACL），客户端必须通过 timing-safe hello 握手。token 不写日志、不回显；但同用户进程仍可读取该文件，所以 token 不能防御同用户恶意 Worker。
- **凭据**：Supervisor 自身的日志、事件、stderr、结果和错误会做静态模式与敏感环境变量值脱敏，但这是**捕获后的尽力而为**，不是访问控制。Worker 仍能读取继承的环境变量，也可能把凭据写入自己的输出或被 Pi 记录。`--api-key` / `--no-session` 被禁止放进 `extraArgs`，但这只约束显式参数，不改变环境继承。
- **工具 allowlist 不是沙箱**：`tools` 只限制传给 Pi 的工具集合；Pi 扩展、shell 和网络能力仍可能扩大边界。
- **Codex 的 sandbox 不等于 MCP 沙箱**：`codex exec -s read-only` 只约束 Codex 的 shell 工具；MCP server 及其启动的 Worker 仍是宿主进程，可写 Supervisor 状态目录和运行本地命令。Codex 侧的 `default_tools_approval_mode` 是工具调用边界，不是文件系统隔离。
- **生命周期控制 ≠ 资源配额**：`maxDurationMs`、取消和 `maxWorkers` 只控制进程生命周期，不限制 CPU、内存、磁盘、网络或子进程产生的资源消耗。
- **取消范围**：只针对该 Worker 的 PID / 进程组，不用命令字符串过滤作为安全边界。daemon 重启后的 `orphaned` 进程不再受控，Supervisor 不会假装取消。
- **Supervisor 不自动重试**：进程断开、daemon 重启、任务失败都不会由 Supervisor 自动重跑可能产生副作用的任务。Pi 自身的 provider 级 auto-retry 仍由其配置控制，Supervisor 只透传 `auto_retry_*` 事件；需要严格禁止时应在 Pi 侧关闭。
- **限制**：默认最多 8 个并发 Worker；wait 最大 120s；prompt 最大 256K 字符；保存结果最大 64K；stderr 环形截断；IPC 请求行有大小上限。
- **不删除用户数据**：Supervisor 只管理自己的状态目录与 Worker 进程；没有删除 Worker/会话的命令。
- **建议**：不可信任务使用容器 / VM / 独立低权限用户运行；限制其对 Supervisor 状态目录和其他 Worker 数据的访问；使用专用只读或临时工作目录；限制网络与工具；把 Pi 凭据放在隔离配置中。

环境变量：

| 变量 | 作用 |
| --- | --- |
| `HARNESS_SUPERVISOR_HOME` | 状态目录 |
| `HARNESS_SUPERVISOR_PI_ENTRY` | Pi launcher / CLI JS 入口（Windows 推荐） |
| `HARNESS_SUPERVISOR_PI_BIN` | Pi 可执行文件 |
| `HARNESS_SUPERVISOR_PI_ARGS` | 追加给 Pi 的 JSON 字符串数组 |
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

- 22 个单元测试：JSONL framing、脱敏、持久化/游标、IPC 协议校验、Pi 启动参数
- 24 个集成测试：CLI、daemon、并发取消隔离、增量事件、steer、extension 授权、失败/崩溃/取消区分、max duration、强制终止、daemon 崩溃/重启对账/resume、优雅关闭、MCP 全流程与客户端断连、MCP 条件等待，以及并发/竞态回归
- 2 个依赖真实 Pi 的测试默认跳过（`RUN_REAL_PI=1`）；其中 native session resume 测试不调用模型，real worker 测试会调用一次低成本模型

最终运行：48 tests，46 pass，0 fail，2 skipped。完整输出见 [`evidence/test-suite-races.txt`](evidence/test-suite-races.txt)。

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
- MCP 服务器 instructions 和只读工具的 annotation 可见；
- 并发 spawn 不能突破 `maxWorkers`；
- 取消开始后 send/answer 被拒绝，重复 answer 只有一个成功；
- 取消会先清空 Pi 队列，非空清空记录 `queue_cleared`；
- 启动过程中取消会在 prompt 被接受前生效；
- 并发重复 cancel 幂等，且只记录一次 `run.cancelled`；
- shutdown 会等待 in-flight spawn 结束，不遗留活动 Worker；
- 并发 resume 只产生一个 runtime；
- 对仍存活的 `orphaned` PID，cancel 明确返回 `UNSUPPORTED`，不伪造成功。

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

### 成本控制

真实测试只使用 `deepseek-v4.1-flash-1017` 或当前配置的 Pi 模型；正式 Codex 验证只运行 1 个 Worker、1 次 Codex turn，不存在循环调用。日常测试全部使用本地模拟 Harness；`RUN_CODEX=1` 必须显式设置，否则脚本跳过。

---

## 10. 已知限制

1. **仅完整支持 Pi**：其他 Harness 需要实现 `HarnessAdapter`；未预先编写大量无用兼容层。
2. **Pull-only 事件**：MCP 没有后台唤醒主 Agent；需要宿主侧 notification 支持时再扩展。
3. **无 pause**：Pi 无原语；resume 是新进程 + 持久化 session。
4. **自然语言“提问”不自动变成交互**：只有原生 extension dialog 会进入 `awaiting_input`。
5. **daemon 崩溃后无法接管原管道**：只做状态对账，不假装重连；仍存活的 `orphaned` 进程不能通过 Supervisor 取消，需人工确认 PID 后终止。
6. **PID 复用风险**：对账只做 PID 存活检查；后果是更保守的拒绝，不会自动重跑。
7. **非沙箱，cwd 不是隔离**：Worker 与 daemon 同用户、继承环境变量，并可按该用户的权限访问文件系统和网络，包括 Supervisor 状态目录与 `ipc.token`；不可信任务必须容器化/独立用户运行。
8. **事件日志无自动保留策略**：v0.1 按 Worker 无限增长（文本 delta 不入库），后续需要 retention/compaction。
9. **单用户本地 daemon**：没有用户/团队/权限后台，也没有远程 MCP 认证。
10. **Windows 原生**已验证；非 detached 的 Pi 子进程通常在 daemon 被强杀后随之退出（对账为 `interrupted`），POSIX 或自行存活的进程才可能成为 `orphaned`。WSL 需要自行在 WSL 内安装 Node + Pi，本项目未在该环境实测。不要用 `.cmd` shim 作为 `HARNESS_SUPERVISOR_PI_BIN`。
11. **结果文本可能很大**：存储与事件展示有上限；完整 Pi session 文件保留原始记录。
12. **MCP 工具超时**：宿主必须把 tool timeout 配到比 wait 更长。
13. **极端强杀下的持久化窗口**：daemon 被强制杀死时，事件/状态快照的最后一个异步写可能尚未落盘；重启会按已有记录保守对账，不猜测成功。
14. **示例中的 model/provider 仅是验证环境配置**：请替换为你自己的 Pi provider/model。
15. **没有幂等键**：spawn、resume、send 都不是事务型操作。客户端/宿主超时后不要盲目重试，先通过 `status`/`list` 确认是否已生效；否则可能启动第二个 Worker 或追加一次新运行。
16. **关停有等待上限**：shutdown 最多等待 in-flight 准入 5 秒，之后进入取消/强杀；若 Harness 连强杀都不响应，或 daemon 本身被更底层机制杀死，仍可能需要人工清理残留进程。
17. **工具子进程的清理上限**：取消/强杀覆盖 Harness 的进程树/进程组；若 Harness 先退出，且它启动的工具子进程被 OS 重新挂接，Supervisor 无法再追踪这些孙进程。需要更强保证时应结合 OS 级 Job Object / cgroup 管理。
18. **Codex 宿主进程树**：实测 `codex exec 0.161.0` 退出会杀掉 MCP server 的整个进程树；必须先在 Codex 之外启动 daemon，才能让 Worker 跨越 Codex 退出继续运行。交互式 Codex 的生命周期未单独实测。

---

## 11. 下一步值得扩展（不急）

- 第二个 runtime adapter（优先选支持 ACP 的原生 Harness，并复用成熟 ACP SDK）
- 事件日志 retention / 归档 / 结构化磁盘配额
- 宿主推送适配层（hooks/webhook/IDE channel），在真实有唤醒能力时明确标注
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
  fixtures/           脚本化 Pi RPC Harness（仅测试）
  unit/ integration/ e2e/
scripts/
  e2e-parent-pi.mjs   真实父 Pi -> 子 Pi 证据脚本
evidence/             实际运行产物与断言
examples/             Codex / 通用 MCP / CLI 示例
```

---

## 13. License

MIT

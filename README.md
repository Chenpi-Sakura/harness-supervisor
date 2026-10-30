# Harness Supervisor

Harness Supervisor（HS）是一个本地、轻量、运行时无关的 **Agent Worker 生命周期与通信层**。它不实现 Agent 循环，而是让主 Agent 通过 **CLI** 或 **MCP** 启动、观察、指导、取消和恢复其他厂商的原生 Harness。

当前接入：

- **Pi Agent**（Pi v1.3+ 原生 RPC）：完整支持。
- **MiniMax Code**（ACP / ndJSON stdio）：实验性，spawn / 完成 / 取消 / resume 已真实验证。
- **Qoder CLI**（stream-json / stdio 控制协议）：实验性。

HS 管理的是 **进程、会话、事件**，不是新的多智能体框架：

- 不做 Planner / Reviewer 等角色拆分，不做任务 DAG、投票或模型路由；
- 不重复实现 Harness 内部的规划、工具调用与上下文管理；
- 不引入额外的 LLM 做调度或生命周期管理；
- 只在 Harness 原生能力之上提供统一的生命周期与通信。

## 功能

- **独立 Worker**：每个 Worker 是一个原生 Harness 子进程，有自己的 cwd、session 与进程树。Worker 属于 daemon，客户端断开后继续运行。
- **完整生命周期**：spawn / status / events / wait / send / answer / cancel / resume，含并发准入、取消与关停屏障、重启对账。
- **增量事件**：每 Worker 一条追加式事件流，`seq` 单调递增，支持 `sinceSeq` 游标；状态变化与普通进度分开返回。
- **持久化通知收件箱**：完成 / 失败 / 取消 / 需要输入 / 崩溃 / 失联等事件生成稳定 ID 的通知，可查询、可确认、跨重启不重复；默认不产生任何外部调用。
- **可选队列投递**：登记 Codex thread 后，可用官方 `codex queue` 把简短通知写入该 thread；是否真正唤醒主 Agent 取决于宿主是否加载该 thread。
- **可选请求幂等**：`spawn` / `resume` / `send` 支持 `requestId`；重复请求不会重复执行，结果不确定时报 `UNCERTAIN`。
- **任务度量（阶段一/二）**：每次 `spawn` 自动创建或关联一个委托任务；记录 Worker 终态、耗时、可得的运行时 Token 用量，并生成带覆盖率、来源和未知字段的单任务/汇总报告。主 Agent 用量只能显式补录；费用不采集（积分制无法直接核对），验收、返工与干预尚未采集。
- **统一入口**：CLI、MCP、IPC 共享同一个 daemon 与同一份状态。

## 构成

```text
主 Agent / 外部客户端
   │ CLI                     │ MCP (stdio)
   ▼                         ▼
SupervisorClient ─── 本地 IPC（named pipe / Unix socket + token）
                                │
                                ▼
                    Supervisor daemon
                    ├─ Worker 状态机与并发准入
                    ├─ 追加式事件日志 + seq 游标
                    ├─ 持久化通知收件箱
                    ├─ 任务度量与用量记录（独立的追加日志）
                    └─ wait / 输入请求 / 取消 / 恢复
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        Pi 原生 RPC           Qoder stream-json
        Pi 子进程              qodercli 子进程

        MiniMax Code ACP（ndJSON）
        mcode acp 子进程
```

| 模块 | 职责 |
| --- | --- |
| `src/adapters/pi/` | Pi 原生 RPC、启动参数、session 定位 |
| `src/adapters/qoder/` | Qoder stream-json、权限/提问、session 定位 |
| `src/adapters/mcode/` | MiniMax Code ACP（ndJSON）、权限请求、session 句柄 |
| `src/supervisor.ts` | 状态机、wait、send/answer、cancel、resume、重启对账 |
| `src/store.ts` | Worker 记录、追加式事件日志、游标、持久化 |
| `src/metrics.ts` | 任务/用量记录、独立追加日志、覆盖率与报告计算 |
| `src/notify.ts` | 通知收件箱、确认、可选投递与重试 |
| `src/ipc/` | 本地 IPC、token 认证、server/client |
| `src/cli.ts` / `src/mcp.ts` | 两个入口，共用同一套核心行为 |
| `src/types.ts` | 公开类型、状态与事件 schema |

## 工作原理

1. **进程归属**：daemon 启动 Harness 子进程并持有其 stdio；CLI/MCP 只是客户端，断开不影响 Worker。
2. **Adapter 只做翻译**：把 Harness 原生事件映射为统一事件，把统一指令映射为原生命令，保留运行时自己的语义。
3. **状态来自证据**：`spawn` 返回只代表 prompt 被接受；`completed` 只在 Harness 报告 settle、或进程退出被确认后出现。
4. **恢复是显式且受限的**：daemon 重启不会接管原进程；`resume` 是“新进程 + 加载持久化 session + 新 prompt”，并校验 session，不重放旧操作。
5. **先落盘再交付**：重要事件与通知写入本地追加日志；消费者离线不丢，投递语义是 at-least-once。

## 快速开始

要求：Node.js >= 22.19；Pi >= 1.3 并已配置 provider/凭据。

```bash
npm install
npm run build
node dist/src/cli.js up          # 启动本地 daemon（已在运行则直接返回）

# 启动 Worker：只代表 prompt 被接受，不代表任务完成
node dist/src/cli.js spawn \
  --cwd D:/work/demo \
  --prompt "Create hello.txt containing hello. Then reply exactly DONE." \
  --name demo-worker --json

node dist/src/cli.js status <workerId>       # 状态 + 最近事件 + 结果
node dist/src/cli.js wait <workerId> --timeout-ms 60000
node dist/src/cli.js send <workerId> --message "也写一个时间戳" --mode steer
node dist/src/cli.js cancel <workerId>
node dist/src/cli.js resume <workerId> --prompt "继续并总结改动"
node dist/src/cli.js metrics show <taskId>          # 任务状态、Worker 耗时与用量
node dist/src/cli.js metrics report                 # 汇总、覆盖率与未知字段
node dist/src/cli.js down                    # 优雅关闭（会取消活动 Worker）
```

默认状态目录为 `~/.harness-supervisor`，可用 `--state-dir <dir>` 或 `HARNESS_SUPERVISOR_HOME` 隔离实例。
完整命令见 `node dist/src/cli.js help`，示例见 [`examples/cli-walkthrough.sh`](examples/cli-walkthrough.sh)。

### 全新 clone / 另一台机器接入

仓库只包含源码、测试与文档；`dist/` 被 `.gitignore` 忽略，**必须在本机构建**。可复现流程：

```bash
git clone --branch main https://gitcode.com/chenpi_1/harness-supervisor.git Harness-Supervisor
cd Harness-Supervisor
npm ci                 # 按 package-lock.json 安装，可复现
npm run build          # 生成 dist/（tsc）
npm run typecheck      # 可选：类型检查
node dist/src/cli.js up          # 在本机启动 daemon
node dist/src/cli.js info        # 核对 version=0.6.5 与 stateDir
```

依赖：Node.js >= 22.19（`node -v` 核对）；Pi >= 1.3。若 `npm ci` 因网络镜像失败，改用 `npm install` 后以 `git status` 确认 `package-lock.json` 未被意外改写。

**不会随 Git 迁移的本机状态**（每台机器各自建立，不假定能从其他机器继承）：

- **状态目录**（默认 `~/.harness-supervisor`）：Worker 记录、事件日志、session 文件、通知收件箱、幂等日志。复制源码不等于复制运行状态；其他机器上的 Worker 不能在本机 `resume`，也不应把旧状态目录硬搬到新版本上继续使用。
- **daemon 进程与 IPC 端点**：由本机 `up` 启动。其他机器不会共享本机 daemon；同一机器上的不同工作树若使用相同状态目录，则连接的是同一个 daemon，开发测试须显式指定独立状态目录。
- **宿主配置**：Codex 的 `~/.codex/config.toml`（MCP 注册）、其他 MCP 客户端的配置，都在本机手写，且**必须指向本机 clone 的绝对路径**。
- **原生 Harness 凭据**：Pi 的 provider/model/凭据配置、Qoder 的 `qodercli login` 登录态、MiniMax Code 自身的安装与登录（`npm install -g @minimax-ai/code`）均由本机原生工具管理，HS 不保存也不迁移它们。缺少凭据时 `spawn` 会失败，不属于 HS 的缺陷。

因此“另一台机器可用”指的是：clone → `npm ci` → `npm run build` 后即可运行同一份代码；运行状态与凭据需要各机自行配置。

历史证据与交付报告里可能提到开发工作树路径（如 `.smoke-routing-dev`），那只是当时的运行记录。正式配置、`scripts/` 与 `examples/` 不依赖任何开发工作树，全新 clone 不需要它，可以忽略或删除。

### MCP 接入（Codex 为例）

先在 **Codex 之外**启动并保持 daemon（`codex exec` 退出会清理 MCP server 的进程树，自动拉起的 daemon 会被一起杀掉）。下面的绝对路径要换成**本机 clone 的主目录**：

```powershell
# 示例：本机主目录为 D:/Projects/Harness-Supervisor（换成你自己的 clone 路径）
node D:/Projects/Harness-Supervisor/dist/src/cli.js up
```

```toml
# ~/.codex/config.toml
[mcp_servers.harness_supervisor]
command = "node"
args = ["D:/Projects/Harness-Supervisor/dist/src/mcp.js"]
startup_timeout_sec = 30
tool_timeout_sec = 150            # 必须大于 worker_wait 的超时
default_tools_approval_mode = "approve"   # 只在可信工作区使用
```

若 daemon 使用 `--state-dir`，MCP 的 args 也要用 `--state-dir` 指向同一目录。其他客户端可使用 [`examples/mcp.json`](examples/mcp.json)。

### MCP 输出模式（0.3.0 起）

MCP server 有两种**呈现模式**，只影响当前 MCP 进程如何返回结果，不改变 daemon、Worker 状态、持久化事件、通知路由或权限边界：

- `production`（默认）：只返回主 Agent 执行任务所需字段；`spawn`/`resume` 返回接受状态，`status` 显式请求才带最近事件，`wait` 不重复完整报告。适合日常使用，占用上下文更少。
- `development`：保留 0.3.0 之前的完整 JSON 结构（例如 `recentEvents` 默认 20、`stderrTail`、PID/session 诊断字段、通知默认 `pending`），用于兼容现有脚本和排查问题。

配置优先级：命令行 `--mode` > 环境变量 `HARNESS_SUPERVISOR_MCP_MODE` > 默认 `production`。非法值会在 MCP 启动时明确报错退出，不会静默降级，也不使用 `NODE_ENV`。

`production` 还要求共享 daemon 为 **0.4.0 或更高**；新 MCP 连接后会检查 daemon 版本，旧 daemon 必须先备份状态、确认无活动 Worker，再由人工升级并重启，不能只改 MCP 配置。

```toml
# ~/.codex/config.toml（示例：本机 clone 主目录为 D:/Projects/Harness-Supervisor）
[mcp_servers.harness_supervisor]
command = "node"
args = ["D:/Projects/Harness-Supervisor/dist/src/mcp.js"]

# 需要旧版完整返回时才显式切换；默认无需写 --mode
# args = ["D:/Projects/Harness-Supervisor/dist/src/mcp.js", "--mode", "development"]
```

所有 MCP 客户端也可以统一用环境变量切换：

```powershell
$env:HARNESS_SUPERVISOR_MCP_MODE = 'development'   # 或 production
node D:/Projects/Harness-Supervisor/dist/src/mcp.js
```

模式不改变真实能力或限制。`production` 的字段精简不是安全沙箱，也不是权限隔离；完整诊断仍可在 `development` 或 CLI/IPC 中获取。

#### production 返回样例

`worker_spawn`（接受任务，不代表完成；`notifyTarget` 是实际持久化目标）：

```json
{"id":"w-xxx","runtime":"pi","status":"running","lastSeq":5,"notifyTarget":{"channel":"none"}}
```

`worker_wait`（完整结果只出现在 `worker.result`；`run.completed.data.text` 不再重复；游标语义保持）：

```json
{"worker":{"id":"w-xxx","runtime":"pi","cwd":"D:/work/demo","status":"completed","lastSeq":11,"result":{"text":"最终报告全文","truncated":false},"resumeAvailable":true},"events":[{"seq":10,"ts":"2026-10-23T08:37:41.210Z","type":"run.completed","data":{"aborted":false,"stopReason":"stop","forcedCleanup":false}}],"eventsOmitted":3,"nextSeq":11,"hasMore":false,"timedOut":false,"terminal":true}
```

`worker_status`（未显式传 `recentEvents` 时不带事件和 `stderrTail`；`pendingInput` 保留回答所需全部字段）：

```json
{"worker":{"id":"w-xxx","runtime":"pi","cwd":"D:/work/demo","status":"awaiting_input","lastSeq":8,"pendingInput":{"requestId":"ui-123","method":"confirm","title":"Approve?","message":"Continue?","createdAt":"2026-10-23T08:37:41.210Z"},"resumeAvailable":false}}
```

0.6.5 起同一响应还会带 `lastProgress`、`timeline`、`inputState`（见后文“终态进展、输入有效期与运行段”）。

`supervisor_notifications`（默认返回所有未确认记录，先过滤未确认再应用 `limit`，不会被旧已确认记录遮挡）：

```json
{"notifications":[{"id":"w-xxx#10","workerId":"w-xxx","kind":"completed","summary":{"status":"completed","text":"FAKE_PI_OK"},"acked":false}],"counts":{"pending":1,"delivered":0,"failed":0,"unacked":1},"filteredCounts":{"pending":1,"delivered":0,"failed":0,"unacked":1},"globalCounts":{"pending":2,"delivered":3,"failed":0,"unacked":2},"scope":{"state":"pending","workerId":"w-xxx","unacknowledgedOnly":true,"limit":50,"returned":1}}
```

`supervisor_info` 在 production 下包含 `version`、`mcpMode`、必要限制、`runtimes`（各 runtime 的精简能力说明：Qoder 未经真实验证的 steer/follow-up 限制、MiniMax Code 的 steer 边界）和通知投递边界；不包含 daemon PID/stateDir 等诊断字段。


## 接口

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `worker_spawn` | 启动 Worker；prompt 被接受即返回，不等待完成 |
| `worker_status` | 状态、pending input、结果/错误；production 默认不带最近事件/诊断 |
| `worker_list` | 列出 Worker（持久化，跨重启） |
| `worker_events` | 按 `sinceSeq` 增量读取事件 |
| `worker_wait` | 有界等待（默认 30s，最大 120s）；默认省略普通进度 |
| `worker_send` | 运行中追加 steer / follow-up |
| `worker_answer` | 回答输入请求或权限询问 |
| `worker_cancel` | 取消并确认终态；不影响其他 Worker |
| `worker_resume` | 用新指令恢复已有 session |
| `supervisor_info` | 版本、限制、runtime 能力、通知通道 |
| `supervisor_notifications` | 读取通知收件箱（production 默认全部未确认；development 默认 pending） |
| `supervisor_notifications_ack` | 确认通知（幂等） |
| `supervisor_wake_target` | 可选：登记 Codex thread 以启用队列投递 |
| `metrics_task_create` | 创建一个可关联多个 Worker 的委托任务 |
| `metrics_task_show` | 单任务状态、耗时、用量记录、覆盖率与警告 |
| `metrics_report` | 区间汇总（按任务创建时间）、覆盖率、未知字段；可带任务详情 |
| `metrics_record_usage` | 人工补录主 Agent 或 Worker 用量；支持 `usageId` 幂等 |

### CLI 命令

`up` `down` `daemon` `info` · `spawn` `list` `status` `events` `wait` `send` `answer` `cancel` `resume` · `inbox` `ack` `notify-target` `retry-notifications` · `metrics create|show|report|export|record-usage` · `prune`

### Worker 通知绑定（多 Codex 对话）

`spawn.notifyTarget` 显式指定发起会话；CLI 使用 `--notify-thread` 或 `--notify-none`，MCP 使用下面的对象：

```json
{"notifyTarget":{"channel":"codex-queue","codexThreadId":"<verified-origin-thread-id>"}}
```

0.6.1 起，MCP 的 `worker_spawn` 在省略 `notifyTarget` 时会读取 Codex 每次工具调用的 `_meta.threadId`，自动绑定到**发起本次调用**的 Codex 对话。优先级：显式 `notifyTarget` > 自动识别到的当前对话 > daemon 全局默认值。多个 Codex 对话并行派发时，每个工具调用带自己的 Thread ID，Worker 各自保存独立快照，不会串线。自动绑定只接受规范 UUID；缺失、格式错误或与同一 `_meta` 中的 `x-codex-turn-metadata.thread_id` 冲突时，不猜测，退回 daemon 默认并给出 `warnings`。

自动绑定需要 **daemon 0.6.1 或更高**。旧 daemon 仍可正常 `worker_spawn`，但 MCP 不会发送新字段，并在 `notificationBinding.warnings` 中说明“未自动绑定”；升级 daemon 后需重启 MCP/Codex 会话，版本判断才会刷新。

每个 Worker 在创建时持久化绑定，每条重要事件和通知保存各自的目标快照。全局 `notify-target` / `supervisor_wake_target` 只作为**新 Worker 的默认值**。已有 Worker、已排队或失败待重试的通知都不会随默认值迁移。未配置目标时只写收件箱；旧版本无绑定的 Worker 和无目标的通知同样保留在收件箱，不推测原始会话。

```powershell
# 必须在发起 Worker 的那个 Codex 对话内执行；先检查变量确实存在
if (-not $env:CODEX_THREAD_ID) { throw '请显式提供已核实的 Thread ID' }
node dist/src/cli.js spawn --cwd D:/work/demo --prompt '执行任务' --notify-thread $env:CODEX_THREAD_ID --json

# 默认保留原绑定；明确授权接管时才指定新目标（仅影响后续事件）
node dist/src/cli.js resume <workerId> --prompt '继续任务'
node dist/src/cli.js resume <workerId> --prompt '接管后继续' --notify-thread <new-thread-id>
```

CLI 不经过 Codex 的 MCP 调用，因此在 shell 中仍需显式传 `--notify-thread`（或使用 `--notify-none`）。HS 不会读取 MCP 进程环境、`CODEX_THREAD_ID`、最近 Session 或全局 Thread ID 来猜测调用者；MCP 的自动绑定只使用该次工具调用自带的 `_meta.threadId`。`worker_resume` 不自动绑定新对话：省略目标时保留原绑定，显式目标只影响后续事件。已有 Worker、已排队或失败待重试的通知不会随默认值迁移。

旧客户端省略 `notifyTarget` 仍可调用；这是向后兼容的默认值快照，不保证它能识别发起会话。恢复历史通知时只信事件中的历史目标；无历史目标的旧事件不会投递给新接管者。通知 `delivered` 仅表示队列接受；`ack` 表示消费者已处理。崩溃窗口可能重复投递，消费者应按稳定通知 ID 去重。

`spawn` / `resume` 的响应现在带 `notificationBinding`，把生效目标、来源和降级说清楚：

```json
{
  "target": { "channel": "none" },
  "source": "daemon-default",
  "wake": "unbound",
  "observation": "wait",
  "warnings": ["No notifyTarget was passed and the daemon default is channel 'none'; this worker will not wake this conversation. ..."]
}
```

- `source` 为 `explicit`（显式传入）、`caller`（从当前 MCP 调用的 `_meta.threadId` 自动绑定）、`daemon-default`（无调用者身份时取全局默认）或 `preserved`（resume 省略、保留原绑定）。
- `wake=unbound` 时 `warnings` 必非空，`observation=wait`：应使用 `worker_wait` 或收件箱，不能对用户声称会自动通知。
- `wake=bound` 只表示目标已绑定；投递仍是 at-least-once，不保证主 Agent 一定被唤醒。
- 自动绑定的 Thread ID 来自宿主注入的 `_meta`，是路由提示而非认证凭据；HS 校验格式和重复字段一致性，但不把它当作安全边界。

对于可独立推进的长程任务：派发一次、检查 `notificationBinding.wake`；只有在宿主确实支持唤醒该 Thread 时才结束当前回合，等待完成/失败/需要输入的通知，不再周期性调用 `worker_wait` / `worker_status` / `worker_events`。宿主唤醒行为不确定、未绑定或投递失败时，明确降级并用 `worker_wait` 或收件箱接回结果。2026-10-28 已在 Codex Desktop 的双对话实测中验证自动绑定、互不串线和完成通知唤醒（见 `evidence/mcp-auto-binding-261028/desktop-two-conversation.md`）；这仍只是单次实测，不把“已绑定”推广为“任何宿主、任何情况下都必定唤醒”。这是默认协作规范，不是对所有宿主行为的强制保证。

### Worker 报告协议与命令守卫

HS 是唯一受支持的 Worker 通知生产路径。`spawn` / `resume` 发送的任务提示会前置固定协议块：Worker 以最终答复结束本次运行，不得调用 `codex queue` 或其他宿主接口向父会话注入报告，也不得为此另起 Codex 会话；需要决策时使用自带 harness 的 permission/input。

运行时再加一层最小护栏：Daemon 启动时若在 PATH 中找到 Codex CLI，就在 `<stateDir>/worker-guard/bin` 生成 `codex` shim，并只把该目录前置到 **Worker 进程**的 PATH。`codex queue` 返回退出码 2、向工具 stderr 写一行说明，并在 `<stateDir>/worker-guard/worker-guard.jsonl` 追加 `{ts, workerId, argv, cwd}`；其他子命令转发给真实 CLI。Daemon 自身的 PATH 与通知投递不受影响。若 Codex 是后来才安装的，重启 Daemon 后护栏才会生成。

```powershell
# 暂时关闭护栏（仅诊断/兼容）
$env:HARNESS_SUPERVISOR_WORKER_GUARD = '0'
# 关闭任务提示中的协议块（仅诊断/兼容）
$env:HARNESS_SUPERVISOR_WORKER_PROTOCOL = '0'
```

**边界**：这是护栏与审计，不是安全边界。Worker 使用绝对路径、其他宿主接口、修改 PATH 或覆盖 shim 都能绕过；同一 OS 用户下 HS 无法仅凭 PATH 阻止。Pi 已用真实进程和 shell 验证拦截与放行；Qoder 与 MiniMax Code 复用同一环境注入，但其工具 shell 的 PATH 解析未单独验证。护栏失败（找不到 Codex、目录不可写）只记 `daemon.log`，不阻断 Worker 启动。

### 通知降噪与结果读取（0.4.3）

唤醒消息只携带 Worker、事件类型、序号和读取提示，不重复发送命令参数或完整报告。收到提醒后先用 `worker_status` 取得**当前** `pendingInput` 或最终 `result`，处理后确认收件箱通知；不要根据晚到的消息直接回答旧 requestId。

Daemon 默认给新通知留出 1000ms 短窗口，同一 Worker 共用一个定时器；`HARNESS_SUPERVISOR_NOTIFY_DELAY_MS=0` 可关闭延迟，允许范围 0—60000ms。投递前再次核对请求是否仍有效，已回答、撤回、过期或被新回合替换的待输入请求不再投递，标为 `superseded`，保留事件与诊断记录。窗口内取消后立即 resume 的旧取消提醒也会被抑制；真正完成、失败和仍需输入的提醒继续发送。此机制不将所有历史事件强行合并为一条，也不能撤回已被 Codex queue 接受的消息。

`superseded` 不表示 delivered 或消费者 ack；默认待办视图排除这类记录，显式 `state='all'` 可核对历史。该配置只控制 Daemon 投递，独立于 MCP production/development 呈现模式。

MiniMax Code 在原生 ACP 提供 messageId 时按最后一条 assistant 消息构建结果，同一消息的分块完整重组，较早过程播报留在进度事件中。不对最终报告增加固定字数上限。缺少 messageId 的旧协议仅能依据工具调用边界分开前后文本，不能可靠分开同一连续流中的多条匿名发言。

### 终态进展、输入有效期与运行段（0.6.5）

`worker_status` 的同一响应现在包含三个由持久化事件派生的字段，默认仍受 2 KiB 预算约束：

- `lastProgress`：最近一条可用的进展文本及其来源事件 `seq`、时间和 `evidence`。`evidence=partial_progress` 只表示 Worker 曾产出这段文本，**不是验收或完成证据**；取消/失败时优先使用终态事件保存的 `partialText`，没有有效文本时返回 `state="none"` 并说明原因。完成状态下最终文本已在 `worker.result` 中，`lastProgress` 只保留事件引用（`textInResult=true`），避免重复占用上下文。
- `timeline`：`firstStartedAt`、`currentRunStartedAt`、`endedAt`、`resumeCount` 和运行段。`startedAt` 仍表示最近一次运行段的开始；恢复后的 Worker 用 `firstStartedAt` 取最初开始时间。旧的 `startedAt` 含义没有被改写。
- `inputState`：`pending` / `answered` / `expired` / `withdrawn` / `closed`，并给出 `expiresAt`、`expiresInMs`、`nextActions`。请求过期后 `worker_answer` 返回 `INVALID_STATE` 且 `details.reason=input_expired`；已回答的重复请求返回 `already_answered`；Worker 已结束时提示使用 `worker_resume`，不再让调用方逐个工具试错。

Qoder 的原生控制请求会一直等待回答；此前 HS 适配器自己的 5 分钟计时器会提前拒绝请求。0.6.5 将 Qoder 默认窗口改为 **30 分钟**，可用 `HARNESS_SUPERVISOR_INPUT_TIMEOUT_MS`（60000—86400000）覆盖。2026-10-30 真实 Qoder 1.1.79 验证：请求在 04:14:40 创建，04:20:38（5 分 58 秒）回答后仍被接受，Worker 以 `QODER_INPUT_OK` 完成。MiniMax Code 默认同为 30 分钟，可用 `HARNESS_SUPERVISOR_MCODE_INPUT_TIMEOUT_MS` 单独覆盖；其宿主自身的等待上限仍未验证（真实 0.7.0 Ask 模式没有触发审批请求），因此只声明 HS 侧计时器可配置。Pi 仍使用扩展本身提供的 `timeout`。

事件截断边界：`run.progress` 的 `preview` 入库上限 4 KiB、`detail` 8 KiB，取消/失败的 `partialText` 4 KiB；完成文本仍受 `maxEventStringBytes` 限制。超限时事件数据带 `*Truncated`/`*Chars`（旧记录只有可见的 `...[truncated N chars]` 后缀）。单条事件读取只能返回 **HS 已存**的内容；更长的原始输出在 Runtime 自己的 session 文件中，MCP 响应会明确标注 `storedTruncated`。

通知统计现在区分范围：`supervisor_notifications` 返回 `filteredCounts`（与本次 `workerId`/`state`/未确认筛选一致，`limit` 之前）、`globalCounts`（整个收件箱）和 `scope`。旧的 `counts` 字段保持“整个收件箱”语义，不会被未加说明地改成筛选值。

Codex 宿主实时 steer：`turn/steer` 本身已在真实 app-server 活跃回合中验证（错误 `expectedTurnId` 被拒绝，模型最终文本包含 steer token，回合结束后返回 `no active turn to steer`）。但 HS **没有**实现 Desktop 实时 steer：Codex Desktop 使用自己的私有 stdio app-server，共享 app-server 无法接管已有活动 writer 的线程（`already has an active writer`）。因此 `supervisor_info.codexSteer` 明确为 `unavailable`，`codex-queue` 仍是唯一受支持的宿主投递路径。详见 [`docs/codex-steer-261030.md`](docs/codex-steer-261030.md)。

### 任务度量（0.5.0，阶段一/二）

本节只实现“可信的任务记录与报告”，不是完整的成本分析平台。费用不采集（当前多为积分制，无法直接核对）；首次验收、返工与人工干预尚未采集，报告会以 `notTracked`、`unknownFields` 和警告显式说明，而不是填零。

**存储与关联**

- 每个 `spawn` 若无 `taskId`，自动创建一个 `delegated` 任务并关联该 Worker；需要多个 Worker 属于同一验收单元时，先用 `metrics create` / `metrics_task_create` 创建任务，再在 `spawn` 传 `--task` / `taskId`。
- 任务记录与用量记录位于独立追加日志 `stateDir/metrics/metrics.jsonl`（权限 0600），采用 last-wins 读取；损坏行和截断尾行被忽略并产生警告，不阻塞 Worker。
- 旧 Worker 没有 `taskId` 时不会被猜测归入历史任务，也不会为了统计重跑或虚构用量。`prune` 删除 Worker 目录后，任务记录仍保留；报告会把缺失 Worker 标为 `missing` 并降低状态确定性。
- 任务状态由现有 Worker 状态机派生，不另建状态机：有活动 Worker → `running`；有失败/崩溃 → `failed`；有中断/失联 → `interrupted`；全部完成 → `completed`；仅有取消 → `cancelled`；没有 Worker → `pending`；缺失 Worker 或混合终态无法唯一判断 → `unknown`。

**用量来源与可信度**

| 来源 | 实现 | `usageSource` / `confidence` | 说明 |
| --- | --- | --- | --- |
| Pi | assistant message 的 `usage`（input/output/cacheRead/cacheWrite/totalTokens）按回合累加后写 `run.usage` | `runtime_reported` / `partial` | 字段缺失保持未知；不把 cache 加到 input/output |
| Qoder CLI | `result.usage` 的 token 字段；同一 settle 窗口只取最后一个 result | `runtime_reported` / `partial` | 全零报告转为 `null` + `unverified`，不当作真实零消耗 |
| MiniMax Code | 最新 0.6.13 实测：ACP `usage_update` 只有上下文 `used`/`size` 与 `cost=0 USD`（不是 Token 消耗）；prompt result 只有 `stopReason` | 无 UsageRecord / `unknown` | 不读取 mcode 私有会话库；headless `exec --output-format json` 虽有 usage，但 HS 走 ACP |
| 主 Agent | 只能通过 `metrics_record_usage` 显式补录 | `manual` / `partial`（可标 `verified`） | HS 不读取 Codex/GPT 会话总量，也不从 MCP 进程环境推断 |

`attribution=session_level` 的主 Agent 用量只在 `sessionLevelParentUsage` 中展示，不计入任务级总量；只有调用方明确提供可核验的任务级增量时才使用 `incremental`/`exact`。`confidence` 的 `verified` 目前没有来源会自动产生，运行时报告最多是 `partial`。

**报告与导出**

```bash
node dist/src/cli.js metrics create --title "实现某项功能" --category coding --json
# 返回 taskId 后，可把多个 Worker 关联到同一任务：
node dist/src/cli.js spawn --cwd ./repo --prompt "..." --task <taskId> --json

node dist/src/cli.js metrics show <taskId> --json
node dist/src/cli.js metrics report --since 2026-10-01 --until 2026-10-31 --json
node dist/src/cli.js metrics export --since 2026-10-01 --json

# 主 Agent 用量必须显式补录；session_level 不会进入任务总量
node dist/src/cli.js metrics record-usage <taskId> --role parent_agent \
  --input-tokens 12000 --output-tokens 800 --attribution incremental --confidence partial \
  --usage-id parent-task-1 --json
```

MCP 对应 `metrics_task_create`、`metrics_task_show`、`metrics_report`、`metrics_record_usage`。`metrics_report` 的 `includeTasks` 可带任务详情（`limit` 只截断详情，聚合计数仍覆盖全部选中任务）。

报告包含：任务状态计数、Worker 数、每类用量的记录数/可用数/verified/partial/unverified、各 Token 字段的值与已知/缺失记录数、端到端耗时、Worker 运行时长、单 Worker 等待时间（含启动开销）、覆盖率、`notTracked` 与数据质量警告。Token 分类从不相加；`reportedTotalTokens` 只在运行时明确报告时汇总。未知值保持 `null`，不会用零或估算填充。

**兼容与隔离**

- 统计初始化或写入失败只记日志并使度量接口报 `UNSUPPORTED`，不阻断 Worker 的 spawn / 取消 / 恢复 / 通知；任务关联失败时 Worker 仍会运行，只是没有统计。
- 度量日志没有自动清理策略，当前不会随 `prune` 删除；长期保留策略列入后续工作。
- 度量为 0.5.0 新增 IPC；旧 MCP 连接旧 daemon 时不会伪造统计，工具会明确要求升级/重启 daemon。旧 Worker、旧事件日志和现有通知/ACK 语义不受影响。
- 度量只保存任务元数据、Worker ID、时间戳、用量数字、来源与短备注；不复制完整 prompt、模型输出、思考过程、环境变量或凭据。

### 关键语义

0.4.4 的可选 Codex 消费前 ACK hook 已在 0.5.x 移除：不再发布 `harness-supervisor-codex-hook` 与安装器，也不再产生 `notification-gate.jsonl`。收件箱、ACK、重试与投递前失效检查保留，`supervisor_notifications(includeDelivery=true)` 仍可查看投递时序。

如果机器上安装过旧 hook，HS **不会自动修改** `~/.codex/hooks.json`。请在重新构建/升级该机器的 `dist` 之前，用 Codex `/hooks` 禁用或手动删除对应的 `UserPromptSubmit` 组（命令形如 `node '<repo>/dist/src/codex-notification-hook.js' --state-dir '<stateDir>'`）。`tsc` 不会删除已移除源文件对应的旧产物；需要先停止并保护 Daemon，再执行 `npm run clean` 后重新 `npm run build`，否则旧构建里的 hook 文件会继续存在。清理后该入口消失，未清理的 hooks.json 会指向不存在的文件。迁移只动用户自己的配置，HS 不代删。

- `spawn` 返回时任务尚未完成；终态以 `wait` / `status` 为准。
- `worker_wait` 是有界等待，超时不代表失败；不带游标时先检查当前状态，避免白等。
- `run.message_sent` 只代表消息被 Harness 接受，不代表模型已看到或采纳。
- `resume` 不会续接原进程内存中的运行，也不会自动重跑中断任务。
- `prune` 是显式维护操作：只清理终态且没有未确认通知的 Worker。
- 未携带 `requestId` 时不具备幂等性；带 `requestId` 时也不会获得跨组件的 exactly-once。

### 长期事件与请求持久化

每个 Worker 的事件缓存最多保存最近 500 条，完整历史仍在追加日志中。启动流式扫描日志，历史查询按需异步分页，稀疏字节索引支持深页读取；通知重建使用单次流式扫描。已知的事件缺口或追加失败会明确报错，不将残缺历史伪装为完整结果；单个损坏日志不会阻止其他 Worker 继续受管。

直接使用 TypeScript/JavaScript 库的调用方需注意：`Supervisor.events()` 现在返回 Promise，应使用 `await`；`Store.getEvents()` 只访问缓存，`truncated:true` 表示需调用 `await Store.readEvents()` 获取完整历史，`Store.scanEvents()` 用于全历史流式处理。CLI、IPC、MCP 的字段和调用方式保持兼容；MCP 的 production 呈现是 0.3.0 新增的默认行为，旧完整结构可通过 `--mode development` 继续使用。

带 `requestId` 的副作用操作会先等待准入记录写入，再启动进程或发送消息；持久化失败明确返回错误。通知也在收件箱记录写入确认后才调用宿主。上述承诺针对进程崩溃和写入失败，不提供断电 fsync、磁盘损坏或跨组件 exactly-once 保证。

### 状态与事件

- 非终态：`starting` / `running` / `awaiting_input`
- 终态：`completed` / `failed` / `cancelled` / `crashed` / `orphaned` / `interrupted`
- 事件：`worker.starting|started|session`、`run.accepted|started|progress|usage|needs_input|input_answered|message_sent|error|completed|failed|cancelled`、`worker.cancel_requested|exited|crashed|orphaned|interrupted|resumed|resume_failed`

`run.usage` 是结构化、低频的运行时用量报告；`run.progress` 中旧的 `kind=usage` 仍保留以兼容既有事件消费者，但任务度量只消费 `run.usage`。`run.usage` 只描述 Token，不代表费用；本系统不采集费用。

`orphaned` 表示 daemon 重启后进程可能仍存活但已失去控制；`interrupted` 表示进程已不在或 PID 已被复用。两者都不代表任务成功，也不会被自动重跑。

## 运行时支持

| Runtime | 状态 | 说明 |
| --- | --- | --- |
| Pi | 完整 | 原生 RPC；steer / follow-up / cancel / resume / 扩展对话框均可映射 |
| MiniMax Code | 实验性 | ACP over ndJSON（`mcode acp`）。spawn / 完成 / 取消 / resume 已在真实 0.6.12 上验证（历史证据；最新 0.6.13 本轮只做了单轮 ACP 与 Token 探测，未重跑全部交互）；权限问答在 Ask 模式下对真实进程验证过（是否触发询问由运行时风险分类决定，并非每次都出现）。steer 与 follow-up 依赖 `mcode/session/steer`、`mcode/session/queue/enqueue` 扩展，未声明该扩展的构建会明确报 `UNSUPPORTED`；真实进程上 `queue/enqueue` 可用，steer 在**活跃 turn 内**已验证有效（agent 照做，事件记为 `mode=steered`），turn 结束后再发会被拒，因此 steer 的送达依赖 turn 是否还活着。ACP 的 `session/prompt` 会阻塞到 turn 结束且拒绝并发第二个 prompt |
| Qoder CLI | 实验性 | 单轮、取消、AskUserQuestion、resume 已真实验证；默认 `bypass_permissions`（1.1.79 实测：真实 Worker 完成文件写入/读取且无审批），可用显式配置覆盖。输入请求默认等待 30 分钟（1.1.79 真实 5 分 58 秒回答后仍完成），可用 `HARNESS_SUPERVISOR_INPUT_TIMEOUT_MS` 调整。steer / follow-up 在当前版本被接受但未生效，权限 allow/deny 仅部分验证。任务度量可读取 `result.usage`，但全零报告按未知处理 |

用量采集边界：Pi 只在 assistant message 原生提供 `usage` 时记录；Qoder 只在 `result.usage` 存在时记录；MiniMax Code 最新 0.6.13 实测 ACP 只提供上下文 `used`/`size` 与 `cost=0 USD`，prompt result 不含 usage，其 headless `exec --output-format json` 虽有结构化 usage，但 HS 走 ACP 且不读取私有会话库，因此报告中保持未知。主 Agent 用量不会从宿主会话自动读取，必须显式补录。

## 边界

- **不是沙箱**：`cwd` 只是默认工作目录；Worker 与 daemon 同用户、继承环境变量，可访问该用户可访问的文件与网络。
- **单用户本地**：没有多用户、远程 MCP 认证或配额管理；生命周期控制不等于资源限制。
- **投递不是 exactly-once**：通知与队列投递均为 at-least-once；`delivered` 不等于主 Agent 已读到。
- **唤醒受宿主约束**：只有宿主加载了目标 thread，队列消息才会触发新回合。
- **度量不是账单**：Token 为运行时或人工报告值，未与 provider 账单核对；本系统不采集费用（积分制无法直接核对），验收、返工、干预和对照基线在阶段一/二均未采集。主 Agent 用量不会自动读取，缺失就是未知，不是零。
- **统计故障不阻断执行**：度量存储不可用时 Worker 仍可运行，但该 Worker 可能没有任务关联或用量记录，报告会明确说明。
- **崩溃后不接管**：daemon 重启只做状态对账，不会重新接上原管道，也不会自动重跑。
- **平台**：Windows 原生已验证；WSL / 其他 POSIX 需自行验证。

## 后续工作

当前以原型实际使用为主，扩展验收及已知问题跟踪见 [`docs/backlog.md`](docs/backlog.md)。其中暂缓事项不作为本阶段交付的前置条件。

## 文档与证据

以下内容按时间归档，**不随代码更新**；实现以 `src/` 为准。

| 位置 | 内容 |
| --- | --- |
| [`docs/v0.2-report.md`](docs/v0.2-report.md) | v0.2 交付报告：通知、幂等、保留策略、Qoder 验证 |
| [`docs/iteration-261023-report.md`](docs/iteration-261023-report.md) | 2026-10-23 迭代：Worker 通知路由、原生输入闭环、事件历史与幂等可靠性 |
| [`docs/v0.6.5-report.md`](docs/v0.6.5-report.md) | 0.6.5 交付报告：终态进展、输入有效期、通知统计与 Codex steer 边界 |
| [`docs/codex-steer-261030.md`](docs/codex-steer-261030.md) | 2026-10-30 Codex app-server `turn/steer` 实验与 Desktop 阻塞分析 |
| [`evidence/v0.6.5-261030/`](evidence/v0.6.5-261030/) | 0.6.5 真实 Qoder 等待、app-server steer 与回归证据 |
| [`evidence/metrics-phase12-261025/README.md`](evidence/metrics-phase12-261025/README.md) | 0.5.0 任务度量阶段一/二的测试与烟雾证据 |
| [`evidence/release-v0.2.0-261023/README.md`](evidence/release-v0.2.0-261023/README.md) | 主目录发布验收、Windows 原子替换修复及部署限制 |
| [`docs/archive/project-status-2026-10-22.md`](docs/archive/project-status-2026-10-22.md) | 2026-10-22 项目现状审计 |
| [`docs/archive/readme-detailed-2026-10-22.md`](docs/archive/readme-detailed-2026-10-22.md) | 旧版详细 README 快照（含实现细节与历史数据） |
| [`evidence/`](evidence/) | 真实运行证据：Pi / Qoder / Codex / 唤醒实验，每个目录含 README |

## 项目结构

```text
src/            daemon、supervisor、store、metrics、notify、IPC、CLI、MCP、adapters
test/           unit / integration / e2e 与脚本化 Harness fixtures
scripts/        真实 E2E 脚本（Pi / Qoder / MiniMax Code / Codex）
examples/       MCP 配置与 CLI 示例
evidence/       实际运行产物与断言（归档）
docs/           交付报告、审计与归档快照
```

## License

MIT

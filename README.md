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
node dist/src/cli.js info        # 核对 version=0.4.0 与 stateDir
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

`production` 还要求共享 daemon 为 **0.4.0 或更高**；新 MCP 连接后会检查 daemon 版本，旧 daemon 必须先备份状态、确认无活动 Worker，再由人工升级并重启（见“从 0.3.x 升级”），不能只改 MCP 配置。

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

`supervisor_notifications`（默认返回所有未确认记录，先过滤未确认再应用 `limit`，不会被旧已确认记录遮挡）：

```json
{"notifications":[{"id":"w-xxx#10","workerId":"w-xxx","kind":"completed","summary":{"status":"completed","text":"FAKE_PI_OK"},"acked":false}],"counts":{"pending":1,"delivered":0,"failed":0,"unacked":1}}
```

`supervisor_info` 在 production 下包含 `version`、`mcpMode`、必要限制、`runtimes`（各 runtime 的精简能力说明：Qoder 未经真实验证的 steer/follow-up 限制、MiniMax Code 的 steer 边界）和通知投递边界；不包含 daemon PID/stateDir 等诊断字段。

#### 从 0.3.x 升级

- 0.4.0 新增 **MiniMax Code** runtime（ACP over ndJSON，`mcode acp`），并把 MCP 的 daemon 版本闸门提到 **0.4.0**。新 MCP 连上 0.3.x 的旧 daemon 时，production 会在启动时明确报错并退出（旧 daemon 里没有 mcode 这个 runtime）。处理顺序同样是：备份状态目录、确认没有活动 Worker、升级代码，然后由人工停止并重新启动 daemon。
- 不需要迁移状态目录、Worker 记录、通知或 session 文件；新增 runtime 只是多一个可选的 `spawn --runtime mcode`，不改变其他 runtime 的行为。

#### 从 0.2.x 升级

- 升级到 0.3.0 后 MCP 默认变为 `production`。依赖旧完整字段的客户端请加 `--mode development` 或设置 `HARNESS_SUPERVISOR_MCP_MODE=development`。
- **必须同时升级 Daemon，不能只改 MCP 配置。** 0.3.0 的 production 需要新的 IPC 能力（`unacknowledgedOnly` 与只读 `notification_target_get`）。新 MCP 在连接后检查 daemon 版本；若 daemon 低于 0.4.0，production 会在启动时明确报错并退出，不会自动重启或替换 daemon。正确处理顺序是：备份状态目录（默认 `~/.harness-supervisor`）、确认没有活动 Worker、升级代码，然后由人工停止并重新启动 daemon。
- **旧 daemon 的 development 兼容入口仍然可以连接，但只有旧语义。** 旧 daemon 不支持跨状态“未确认”收件箱过滤，development 默认仍是 `pending`；`supervisor_wake_target` 无参读取会改用旧 `notifications` 返回的 `target`，只返回默认目标，不外露收件箱记录。此时不能获得 production 的新过滤与诊断边界保证，应尽快安排升级 daemon。
- 不需要迁移状态目录、Worker 记录、通知或 session 文件；模式只改变本进程的返回，不改变已持久化的路由和事件。这里的“无状态迁移”不等于“无需升级 daemon”。
- `supervisor_wake_target` 无参调用现在只返回实际默认目标，不再附带收件箱内容（两种模式一致）。
- 两模式共用同一套 daemon 与 IPC 行为；切换模式不会改变 `accepted != completed`、原生输入回答、`requestId` 重试语义或通知投递限制。


## 接口

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `worker_spawn` | 启动 Worker；prompt 被接受即返回，不等待完成 |
| `worker_status` | 状态、pending input、结果/错误；production 默认不带最近事件/诊断 |
| `worker_list` | 列出 Worker（持久化，跨重启） |
| `worker_events` | 按 `sinceSeq` 增量读取事件 |
| `worker_wait` | 有界等待（默认 20s，最大 120s）；默认省略普通进度 |
| `worker_send` | 运行中追加 steer / follow-up |
| `worker_answer` | 回答输入请求或权限询问 |
| `worker_cancel` | 取消并确认终态；不影响其他 Worker |
| `worker_resume` | 用新指令恢复已有 session |
| `supervisor_info` | 版本、限制、runtime 能力、通知通道 |
| `supervisor_notifications` | 读取通知收件箱（production 默认全部未确认；development 默认 pending） |
| `supervisor_notifications_ack` | 确认通知（幂等） |
| `supervisor_wake_target` | 可选：登记 Codex thread 以启用队列投递 |

### CLI 命令

`up` `down` `daemon` `info` · `spawn` `list` `status` `events` `wait` `send` `answer` `cancel` `resume` · `inbox` `ack` `notify-target` `retry-notifications` · `prune`

### Worker 通知绑定（多 Codex 对话）

`spawn.notifyTarget` 显式指定发起会话；CLI 使用 `--notify-thread` 或 `--notify-none`，MCP 使用下面的对象：

```json
{"notifyTarget":{"channel":"codex-queue","codexThreadId":"<verified-origin-thread-id>"}}
```

每个 Worker 在创建时持久化绑定，每条重要事件和通知保存各自的目标快照。全局 `notify-target` / `supervisor_wake_target` 只作为**新 Worker 的默认值**。已有 Worker、已排队或失败待重试的通知都不会随默认值迁移。未配置目标时只写收件箱；旧版本无绑定的 Worker 和无目标的通知同样保留在收件箱，不推测原始会话。

```powershell
# 必须在发起 Worker 的那个 Codex 对话内执行；先检查变量确实存在
if (-not $env:CODEX_THREAD_ID) { throw '请显式提供已核实的 Thread ID' }
node dist/src/cli.js spawn --cwd D:/work/demo --prompt '执行任务' --notify-thread $env:CODEX_THREAD_ID --json

# 默认保留原绑定；明确授权接管时才指定新目标（仅影响后续事件）
node dist/src/cli.js resume <workerId> --prompt '继续任务'
node dist/src/cli.js resume <workerId> --prompt '接管后继续' --notify-thread <new-thread-id>
```

本机 shell 的 `CODEX_THREAD_ID` 已实测存在，但共享 MCP server 的进程环境不等于逐请求身份。本实现不自动读取 MCP 进程环境来替调用方绑定，不扫描“最近 Session”。调用方须传入已核实的 Thread ID；若宿主不提供，则明确使用收件箱降级。不要在并行会话中先改全局默认值再 spawn 来模拟绑定。

旧客户端省略 `notifyTarget` 仍可调用；这是向后兼容的默认值快照，不保证它能识别发起会话。恢复历史通知时只信事件中的历史目标；无历史目标的旧事件不会投递给新接管者。通知 `delivered` 仅表示队列接受；`ack` 表示消费者已处理。崩溃窗口可能重复投递，消费者应按稳定通知 ID 去重。

### 通知降噪与结果读取（0.4.3）

唤醒消息只携带 Worker、事件类型、序号和读取提示，不重复发送命令参数或完整报告。收到提醒后先用 `worker_status` 取得**当前** `pendingInput` 或最终 `result`，处理后确认收件箱通知；不要根据晚到的消息直接回答旧 requestId。

Daemon 默认给新通知留出 1000ms 短窗口，同一 Worker 共用一个定时器；`HARNESS_SUPERVISOR_NOTIFY_DELAY_MS=0` 可关闭延迟，允许范围 0—60000ms。投递前再次核对请求是否仍有效，已回答、撤回、过期或被新回合替换的待输入请求不再投递，标为 `superseded`，保留事件与诊断记录。窗口内取消后立即 resume 的旧取消提醒也会被抑制；真正完成、失败和仍需输入的提醒继续发送。此机制不将所有历史事件强行合并为一条，也不能撤回已被 Codex queue 接受的消息。

`superseded` 不表示 delivered 或消费者 ack；默认待办视图排除这类记录，显式 `state='all'` 可核对历史。该配置只控制 Daemon 投递，独立于 MCP production/development 呈现模式。

MiniMax Code 在原生 ACP 提供 messageId 时按最后一条 assistant 消息构建结果，同一消息的分块完整重组，较早过程播报留在进度事件中。不对最终报告增加固定字数上限。缺少 messageId 的旧协议仅能依据工具调用边界分开前后文本，不能可靠分开同一连续流中的多条匿名发言。

### 关键语义

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
- 事件：`worker.starting|started|session`、`run.accepted|started|progress|needs_input|input_answered|message_sent|error|completed|failed|cancelled`、`worker.cancel_requested|exited|crashed|orphaned|interrupted|resumed|resume_failed`

`orphaned` 表示 daemon 重启后进程可能仍存活但已失去控制；`interrupted` 表示进程已不在或 PID 已被复用。两者都不代表任务成功，也不会被自动重跑。

## 运行时支持

| Runtime | 状态 | 说明 |
| --- | --- | --- |
| Pi | 完整 | 原生 RPC；steer / follow-up / cancel / resume / 扩展对话框均可映射 |
| MiniMax Code | 实验性 | ACP over ndJSON（`mcode acp`）。spawn / 完成 / 取消 / resume 已对真实 0.6.12 进程验证；权限问答在 Ask 模式下对真实进程验证过（是否触发询问由运行时风险分类决定，并非每次都出现）。steer 与 follow-up 依赖 `mcode/session/steer`、`mcode/session/queue/enqueue` 扩展，未声明该扩展的构建会明确报 `UNSUPPORTED`；真实进程上 `queue/enqueue` 可用，steer 在**活跃 turn 内**已验证有效（agent 照做，事件记为 `mode=steered`），turn 结束后再发会被拒，因此 steer 的送达依赖 turn 是否还活着。ACP 的 `session/prompt` 会阻塞到 turn 结束且拒绝并发第二个 prompt |
| Qoder CLI | 实验性 | 单轮、取消、AskUserQuestion、resume 已真实验证；steer / follow-up 在当前版本被接受但未生效，权限 allow/deny 仅部分验证 |

### MiniMax Code 接入

MiniMax Code 的 CLI 以 **Agent Client Protocol（ACP）** 暴露原生会话能力，HS 通过 `mcode acp` 子进程接入：

```bash
npm install -g @minimax-ai/code   # 提供 mcode CLI
# 若 mcode 不在 PATH，可显式指定包入口
export HARNESS_SUPERVISOR_MCODE_ENTRY="C:/Users/<you>/AppData/Roaming/npm/node_modules/@minimax-ai/code/cli.js"

node dist/src/cli.js spawn --runtime mcode --cwd ./repo --prompt "..."
```

几个与实现相关的事实：

- **传输是 ndJSON，不是 LSP 帧**：每行一个 JSON-RPC 2.0 消息；`session/cancel` 是 notification，`session/prompt` 是 request 并阻塞到 turn 结束。
- **Windows 上不能用 npm 的 `.cmd` shim**：Node 拒绝直接 spawn `.cmd`/`.bat`，HS 因此一律以 `node <cli.js> acp` 启动。
- **会话句柄**：MiniMax Code 把对话存在自己的 SQLite 里，没有逐会话文件；HS 在 worker 的 session 目录写一份 `mcode-session.json` 句柄（首行含 `{type:"session",id}`），用于满足 resume 契约并校验会话身份。
- **权限模式**：MiniMax Code 默认 `bypassPermissions`，工具调用不会询问。HS 默认把会话切到 Ask（`default`），让权限请求表现为 `awaiting_input` 并可通过 `worker_answer` 回答；可用 `HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE=auto|bypassPermissions|default` 覆盖。注意该设置在 MiniMax Code 侧是**进程级**的。
- **能力声明是真实的**：`initialize` 返回的 `_meta["minimax-code/extensions"].methods` 决定 steer / follow-up 是否可用，缺失时报 `UNSUPPORTED` 而不是假装成功。
- **id 空间是分离的**：MiniMax Code 的反向请求（权限确认）从 0 开始编号，HS 自己的请求用 `hs-<n>` 字符串 id，因此双方 id 不会互相撞号 —— 否则一次权限请求可能被误当成对 HS 请求的回答，让 turn 被静默判定为已结束。
- **哪些命令会被拦不是读写之分**：Ask 模式下实测 `ls` 与 `echo x > f.txt` 都没有触发许可，而后续的 `Get-Content` 验证命令才触发。真实规则由 MiniMax Code 运行时的风险分类决定，HS 侧无法预先断言某个动作会被拦。

详细的能力差异与验证记录见归档文档与 `evidence/`。

## 边界

- **不是沙箱**：`cwd` 只是默认工作目录；Worker 与 daemon 同用户、继承环境变量，可访问该用户可访问的文件与网络。
- **单用户本地**：没有多用户、远程 MCP 认证或配额管理；生命周期控制不等于资源限制。
- **投递不是 exactly-once**：通知与队列投递均为 at-least-once；`delivered` 不等于主 Agent 已读到。
- **唤醒受宿主约束**：只有宿主加载了目标 thread，队列消息才会触发新回合。
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
| [`evidence/release-v0.2.0-261023/README.md`](evidence/release-v0.2.0-261023/README.md) | 主目录发布验收、Windows 原子替换修复及部署限制 |
| [`docs/archive/project-status-2026-10-22.md`](docs/archive/project-status-2026-10-22.md) | 2026-10-22 项目现状审计 |
| [`docs/archive/readme-detailed-2026-10-22.md`](docs/archive/readme-detailed-2026-10-22.md) | 旧版详细 README 快照（含实现细节与历史数据） |
| [`evidence/`](evidence/) | 真实运行证据：Pi / Qoder / Codex / 唤醒实验，每个目录含 README |

## 项目结构

```text
src/            daemon、supervisor、store、notify、IPC、CLI、MCP、adapters
test/           unit / integration / e2e 与脚本化 Harness fixtures
scripts/        真实 E2E 脚本（Pi / Qoder / MiniMax Code / Codex）
examples/       MCP 配置与 CLI 示例
evidence/       实际运行产物与断言（归档）
docs/           交付报告、审计与归档快照
```

## License

MIT

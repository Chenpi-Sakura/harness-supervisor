# Harness Supervisor

Harness Supervisor（HS）是一个本地、轻量、运行时无关的 **Agent Worker 生命周期与通信层**。它不实现 Agent 循环，而是让主 Agent 通过 **CLI** 或 **MCP** 启动、观察、指导、取消和恢复其他厂商的原生 Harness。

当前接入：

- **Pi Agent**（Pi v1.3+ 原生 RPC）：完整支持。
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
```

| 模块 | 职责 |
| --- | --- |
| `src/adapters/pi/` | Pi 原生 RPC、启动参数、session 定位 |
| `src/adapters/qoder/` | Qoder stream-json、权限/提问、session 定位 |
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

要求：Node.js >= 22.19；Pi >= 1.3 并已配置 provider/凭据；Qoder 可选（需 `qodercli login`）。

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
node dist/src/cli.js info        # 核对 version=0.2.0 与 stateDir
```

依赖：Node.js >= 22.19（`node -v` 核对）；Pi >= 1.3；Qoder 可选。若 `npm ci` 因网络镜像失败，改用 `npm install` 后以 `git status` 确认 `package-lock.json` 未被意外改写。

**不会随 Git 迁移的本机状态**（每台机器各自建立，不假定能从其他机器继承）：

- **状态目录**（默认 `~/.harness-supervisor`）：Worker 记录、事件日志、session 文件、通知收件箱、幂等日志。复制源码不等于复制运行状态；其他机器上的 Worker 不能在本机 `resume`，也不应把旧状态目录硬搬到新版本上继续使用。
- **daemon 进程与 IPC 端点**：由本机 `up` 启动。其他机器不会共享本机 daemon；同一机器上的不同工作树若使用相同状态目录，则连接的是同一个 daemon，开发测试须显式指定独立状态目录。
- **宿主配置**：Codex 的 `~/.codex/config.toml`（MCP 注册）、其他 MCP 客户端的配置，都在本机手写，且**必须指向本机 clone 的绝对路径**。
- **原生 Harness 凭据**：Pi 的 provider/model/凭据配置、Qoder 的 `qodercli login` 登录态均由本机原生工具管理，HS 不保存也不迁移它们。缺少凭据时 `spawn` 会失败，不属于 HS 的缺陷。

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

## 接口

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `worker_spawn` | 启动 Worker；prompt 被接受即返回，不等待完成 |
| `worker_status` | 状态、最近事件、pending input、结果/错误 |
| `worker_list` | 列出 Worker（持久化，跨重启） |
| `worker_events` | 按 `sinceSeq` 增量读取事件 |
| `worker_wait` | 有界等待（默认 20s，最大 120s）；默认省略普通进度 |
| `worker_send` | 运行中追加 steer / follow-up |
| `worker_answer` | 回答输入请求或权限询问 |
| `worker_cancel` | 取消并确认终态；不影响其他 Worker |
| `worker_resume` | 用新指令恢复已有 session |
| `supervisor_info` | 版本、限制、runtime 能力、通知通道 |
| `supervisor_notifications` | 读取通知收件箱（默认只看待处理） |
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

### 关键语义

- `spawn` 返回时任务尚未完成；终态以 `wait` / `status` 为准。
- `worker_wait` 是有界等待，超时不代表失败；不带游标时先检查当前状态，避免白等。
- `run.message_sent` 只代表消息被 Harness 接受，不代表模型已看到或采纳。
- `resume` 不会续接原进程内存中的运行，也不会自动重跑中断任务。
- `prune` 是显式维护操作：只清理终态且没有未确认通知的 Worker。
- 未携带 `requestId` 时不具备幂等性；带 `requestId` 时也不会获得跨组件的 exactly-once。

### 长期事件与请求持久化

每个 Worker 的事件缓存最多保存最近 500 条，完整历史仍在追加日志中。启动流式扫描日志，历史查询按需异步分页，稀疏字节索引支持深页读取；通知重建使用单次流式扫描。已知的事件缺口或追加失败会明确报错，不将残缺历史伪装为完整结果；单个损坏日志不会阻止其他 Worker 继续受管。

直接使用 TypeScript/JavaScript 库的调用方需注意：`Supervisor.events()` 现在返回 Promise，应使用 `await`；`Store.getEvents()` 只访问缓存，`truncated:true` 表示需调用 `await Store.readEvents()` 获取完整历史，`Store.scanEvents()` 用于全历史流式处理。CLI、IPC、MCP 的字段和调用方式保持兼容。

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
| Qoder CLI | 实验性 | 单轮、取消、AskUserQuestion、resume 已真实验证；steer / follow-up 在当前版本被接受但未生效，权限 allow/deny 仅部分验证 |

详细的能力差异与验证记录见归档文档与 `evidence/`。

## 边界

- **不是沙箱**：`cwd` 只是默认工作目录；Worker 与 daemon 同用户、继承环境变量，可访问该用户可访问的文件与网络。
- **单用户本地**：没有多用户、远程 MCP 认证或配额管理；生命周期控制不等于资源限制。
- **投递不是 exactly-once**：通知与队列投递均为 at-least-once；`delivered` 不等于主 Agent 已读到。
- **唤醒受宿主约束**：只有宿主加载了目标 thread，队列消息才会触发新回合。
- **崩溃后不接管**：daemon 重启只做状态对账，不会重新接上原管道，也不会自动重跑。
- **平台**：Windows 原生已验证；WSL / 其他 POSIX 需自行验证。

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
scripts/        真实 E2E 脚本（Pi / Qoder / Codex）
examples/       MCP 配置与 CLI 示例
evidence/       实际运行产物与断言（归档）
docs/           交付报告、审计与归档快照
```

## License

MIT

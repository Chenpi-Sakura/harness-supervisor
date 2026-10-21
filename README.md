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

# 取消（会终止该 Worker 的进程树，不影响其他 Worker）
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

### Codex 配置（`~/.codex/config.toml`）

```toml
[mcp_servers.harness_supervisor]
command = "node"
args = ["D:/Projects/Harness-Supervisor/dist/src/mcp.js"]
startup_timeout_sec = 30
tool_timeout_sec = 150
```

其他 MCP 客户端可使用 [`examples/mcp.json`](examples/mcp.json)。

MCP server 会自动启动本地 daemon；主客户端退出后 daemon 和 Worker 继续存在。

### 工具清单

| 工具 | 用途 |
| --- | --- |
| `worker_spawn` | 启动 Worker；**prompt 被接受即返回**，不等待完成 |
| `worker_status` | 状态、最近事件、pending input、结果/错误、stderr 尾部 |
| `worker_list` | 列出 Worker（持久化，跨 daemon 重启） |
| `worker_events` | 按 `sinceSeq` 增量读取事件 |
| `worker_wait` | 有界长轮询；默认 20s，最大 120s；等待终态或首个匹配事件 |
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

### 关于“主动唤醒”

- `run.needs_input`、进度、完成事件都会写入 daemon 的事件日志。
- MCP 工具调用是拉取式的：宿主必须调用 `worker_wait` / `worker_events` 才能看到事件。
- 本项目不伪造“后台无限唤醒主 Agent”的能力。若宿主未来支持 notification/channel，可在其上增加推送层；v0.1 没有。
- 宿主的 MCP tool timeout 必须大于你设置的 `worker_wait` 时间。

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
- `run.progress`（tool start/end、turn complete、assistant message、retry、compaction、notification）
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

任何一步不满足都会返回 `UNSUPPORTED` / `INVALID_STATE`，不会静默创建新 session 并声称恢复成功。`resume` 不会自动重放旧任务，也不会自动重试可能有副作用的工作。

### Supervisor 重启

- **优雅关闭**（`down` / SIGINT / SIGTERM）：取消所有活动 Worker，状态记录为 `cancelled` + reason `supervisor_shutdown`，然后退出。
- **强制杀死 / 崩溃**：未完成 Worker 在下次启动时被对账为：
  - `orphaned`：记录中的 PID 仍存活，但 daemon 已失去 stdin/stdout 控制通道；
  - `interrupted`：PID 已不存在，结果未知。
- 不会自动恢复、自动重跑或猜测成功。
- 需要显式 `resume`，且只接受已持久化 session；旧进程仍存活时拒绝并发 resume。

### 已知的 PID 复用注意事项

对账使用 `pid + 存活检查`，没有跨平台的进程启动时间指纹。极端情况下 PID 复用可能把新进程误判为旧 Worker；这只会导致更保守的 `orphaned`（拒绝自动处理），不会导致自动重跑。生产环境可在平台层增加进程启动时间校验。

### Pause

Pi 没有可用的 pause/resume 原语，Supervisor 不实现假暂停。capability 中明确 `pause: false`。`resume` 是“基于 Pi session 文件启动新进程并继续”，不是恢复同一个内存中的运行。

---

## 7. Pi Adapter 实现方式

使用 Pi v1.3+ 官方文档化的 **RPC mode**（`pi --mode rpc`）：

- 严格 JSONL framing：只按 LF 分帧、剥离可选 CR、支持跨 chunk UTF-8；不使用 `readline`（它会错误拆开 U+2028/U+2029）。
- 命令：`prompt`、`steer`、`follow_up`、`abort`、`get_state`、`get_last_assistant_text`、`extension_ui_response`。
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

- **本地 IPC 认证**：daemon 在状态目录生成随机 token（`ipc.token`），客户端必须通过 timing-safe 比较的 hello 握手。token 不写日志、不回显。
- **凭据**：不记录 API Key / token。日志、事件、stderr、结果、错误均做静态模式与敏感环境变量值脱敏；Pi 凭据仍由 Pi 自己的配置管理。`--api-key` 和 `--no-session` 被禁止放在 `extraArgs` 中。
- **工作目录与工具**：每个 Worker 有独立 cwd；可选 `tools` allowlist 传给 Pi；`maxDurationMs` 可强制取消。
- **取消范围**：只针对该 Worker 的 PID / 进程组，不用命令字符串过滤作为安全边界。
- **不是沙箱**：Worker 继承 daemon 的环境变量，Pi 工具可以访问文件系统和网络。对不可信任务，应在容器 / 虚拟机 / 受限用户中运行，并收紧 Pi 工具 allowlist。
- **无自动重试**：进程断开、daemon 重启、任务失败都不会自动重跑可能产生副作用的任务。
- **限制**：默认最多 8 个并发 Worker；wait 最大 120s；prompt 最大 256K 字符；保存结果最大 64K；stderr 环形截断；IPC 请求行有大小上限。
- **不删除用户数据**：Supervisor 只管理自己的状态目录与 Worker 进程；没有删除 Worker/会话的命令。

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
- 14 个集成测试：CLI、daemon、并发取消隔离、增量事件、steer、extension 授权、失败/崩溃/取消区分、max duration、强制终止、daemon 崩溃/重启对账/resume、优雅关闭、MCP 全流程与客户端断连
- 2 个依赖真实 Pi 的测试默认跳过（`RUN_REAL_PI=1`）；其中 native session resume 测试不调用模型，real worker 测试会调用一次低成本模型

最终运行：38 tests，36 pass，0 fail，2 skipped。完整输出见 [`evidence/test-suite.txt`](evidence/test-suite.txt)。

覆盖的关键断言包括：

- spawn 在任务完成前返回；
- 主客户端断开后 Worker 继续并最终完成；
- 事件 seq 严格递增、游标不重复；
- 有界 wait 在超时后返回 `timedOut`；
- steer 内容出现在 Worker 最终结果；
- 取消一个 Worker 时另一个正常完成；
- completed / failed / cancelled / crashed 是不同终态；
- daemon 被 SIGKILL 后不会自动重跑，重启后标记为 interrupted/orphaned；
- resume 在 session 文件缺失时明确拒绝，不伪造成功；
- 不响应 abort 的 Harness 会被强制终止并确认进程死亡；
- MCP 客户端断开后 daemon 和 Worker 继续，重连可读到完成结果。

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

完整证据索引：[`evidence/README.md`](evidence/README.md)。

### 成本控制

真实测试只使用 `deepseek-v4.1-flash-1017`，每次只运行一个 Worker，父/子各一次；不存在循环调用。日常测试全部使用本地模拟 Harness。

---

## 10. 已知限制

1. **仅完整支持 Pi**：其他 Harness 需要实现 `HarnessAdapter`；未预先编写大量无用兼容层。
2. **Pull-only 事件**：MCP 没有后台唤醒主 Agent；需要宿主侧 notification 支持时再扩展。
3. **无 pause**：Pi 无原语；resume 是新进程 + 持久化 session。
4. **自然语言“提问”不自动变成交互**：只有原生 extension dialog 会进入 `awaiting_input`。
5. **daemon 崩溃后无法接管原管道**：只做状态对账，不假装重连；旧进程需人工处理/等待退出。
6. **PID 复用风险**：对账只做 PID 存活检查；后果是更保守的拒绝，不会自动重跑。
7. **非沙箱**：继承环境变量与文件系统权限；不可信任务需容器化。
8. **事件日志无自动保留策略**：v0.1 按 Worker 无限增长（文本 delta 不入库），后续需要 retention/compaction。
9. **单用户本地 daemon**：没有用户/团队/权限后台，也没有远程 MCP 认证。
10. **Windows 原生**已验证；WSL 需要自行在 WSL 内安装 Node + Pi，本项目未在该环境实测。不要用 `.cmd` shim 作为 `HARNESS_SUPERVISOR_PI_BIN`。
11. **结果文本可能很大**：存储与事件展示有上限；完整 Pi session 文件保留原始记录。
12. **MCP 工具超时**：宿主必须把 tool timeout 配到比 wait 更长。
13. **极端强杀下的持久化窗口**：daemon 被强制杀死时，事件/状态快照的最后一个异步写可能尚未落盘；重启会按已有记录保守对账，不猜测成功。
14. **示例中的 model/provider 仅是验证环境配置**：请替换为你自己的 Pi provider/model。

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

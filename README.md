<div align="center">

# Harness Supervisor

![version](https://img.shields.io/badge/version-0.12.2-blue) ![node](https://img.shields.io/badge/node-%3E%3D22.19.0-339933) ![runtime](https://img.shields.io/badge/runtime-Pi%20%7C%20Qoder%20%7C%20mcode%20%7C%20DSH%20%7C%20Codex%20%7C%20Claude%20Code-6f42c1) ![protocol](https://img.shields.io/badge/protocol-RPC%20%7C%20ACP-orange) ![platform](https://img.shields.io/badge/platform-Windows%20verified-green) ![license](https://img.shields.io/badge/license-MIT-green)

<hr />

**本地、轻量、运行时无关的 Agent Worker 生命周期与通信层**

主 Agent（下称 **Master**）通过 **CLI** 或 **MCP** 启动、观察、指导、取消和恢复其他厂商的原生 Harness；每个被启动的 Harness 进程称为 **Worker**。HS 只管理进程、会话与事件；规划、工具调用和上下文管理由各 Harness 自己完成。

</div>

## 安装

普通使用直接安装 npm 包，无需 Clone 仓库或本地构建。Worker 对应的原生 Harness CLI 或 ACP 适配器仍需自行安装，并完成原生账号配置。

### 独立 CLI / MCP

需要 Node.js `>=22.19.0`：

```powershell
npm install -g harness-supervisor@latest
harness-sup --help
```

安装后可使用 `harness-sup` 管理 Worker，使用 `harness-sup-mcp` 接入支持 stdio MCP 的 Master。全局 npm 可执行目录需要在终端与宿主应用的 `PATH` 中。

### DSH 插件

在 DSH 自带的「插件 → 添加插件」中输入 `dsh-harness-supervisor@latest`，安装并启用。也可通过 DSH CLI 安装到 Desktop profile：

```powershell
dsh plugin --profile desktop add dsh-harness-supervisor@latest
```

这是社区维护的插件，安装入口使用 DSH 自带的插件管理器。插件包含固定配套的 HS 核心、生产依赖与 WebUI，无需额外全局安装 HS；DSH 会自动配置会话 MCP 连接。

[插件使用与配置](https://github.com/Chenpi-Sakura/harness-supervisor/tree/main/packages/dsh-plugin#readme) · [核心 npm 包](https://www.npmjs.com/package/harness-supervisor) · [插件 npm 包](https://www.npmjs.com/package/dsh-harness-supervisor)

## 快速开始

### 独立 CLI

以下示例使用已安装并配置好的 Pi。将 `D:/work/demo` 替换为现有工作目录：

```powershell
harness-sup up
harness-sup spawn --runtime pi --cwd D:/work/demo --prompt "Create hello.txt containing hello. Then reply exactly DONE." --name demo-worker --json
```

`spawn` 返回任务已接受的状态。复制返回的 Worker ID，再读取状态或等待结果：

```powershell
harness-sup list
harness-sup status <workerId>
harness-sup wait <workerId> --timeout-ms 60000
```

需要与 Worker 通信、取消、恢复或续接时，查看 `harness-sup help` 和下方接口说明。`down` 会关闭 daemon 并取消活动 Worker，结束查看时不必执行它。

独立 CLI/MCP 默认状态目录为 `~/.harness-supervisor`，可用 `--state-dir <dir>` 或 `HARNESS_SUPERVISOR_HOME` 选择实例。DSH 插件使用其数据目录下的 `harness-supervisor` 专属实例，由插件携带的核心启动。另一台机器同样从 npm 安装，并配置本机 Harness；账号登录态、运行进程与任务记录不会随安装包迁移。

### 在 DSH 中使用

插件启用后，可直接让 DSH 委派原生 Worker。右侧栏入口和对话顶部标签可以打开共用 WebUI；`/hs` 可在右侧浏览器中打开。**设置 → Harness Supervisor** 只提供 HS 核心来源选择、保存、刷新状态与诊断详情；选择自定义来源时填写安装目录，设置页不嵌入 WebUI。

人工界面可查看本机当前 HS 实例的全部 Worker，默认展开当前对话；模型的查询、操作和通知 ACK 仍受会话归属约束。

## Codex 与 Claude Code Worker

两者通过外部 ACP 适配器接入，HS 不锁定适配器版本，也不会在每次启动任务时下载。按需安装或更新最新稳定版：

```powershell
npm install -g @agentclientprotocol/codex-acp@latest
npm install -g @agentclientprotocol/claude-agent-acp@latest
harness-sup spawn --runtime codex --model gpt-6-luna --thinking low --cwd D:/work/demo --prompt "完成任务并总结" --persistence persistent
harness-sup spawn --runtime claude --cwd D:/work/demo --prompt "完成任务并总结" --persistence persistent
```

复用原生 Harness 的认证和设置。支持持续会话、审批、取消；重启恢复要求适配器声明 `session/load`。模型与推理等级必须由适配器提供并确认；暂不接入执行中 steering、问题表单或适配器专用终端扩展。缺少安装、认证或能力时会明确报错，不自动换模型或重新创建会话。

可用 `HARNESS_SUPERVISOR_CODEX_ACP_ENTRY` / `HARNESS_SUPERVISOR_CLAUDE_ACP_ENTRY` 指定适配器的绝对 JS 入口或原生可执行文件；Windows 不接受 `.cmd`/`.ps1` 启动脚本。适配器官方的 `CODEX_PATH` / `CLAUDE_CODE_EXECUTABLE` 可选择现有原生 CLI。更新适配器与 HS 发版独立，已有 Worker 不会被热替换，升级后应验证所需能力。

## MCP 接入

MCP server 是 daemon 的客户端。建议先在普通终端启动 daemon，尤其是宿主会在退出时清理 MCP 子进程树的场景：

```powershell
harness-sup up
```

然后在 Master 的 stdio MCP 配置中注册已安装的入口：

```json
{
  "mcpServers": {
    "harness-supervisor": {
      "command": "harness-sup-mcp",
      "args": ["--mode", "production"]
    }
  }
}
```

`mcpServers` 是常见宿主配置格式，并非 MCP 协议规定的字段。工具超时和审批参数请以宿主文档为准；超时应大于 `worker_wait` 的等待时间。它们控制宿主对 HS 工具的调用，不改变 Worker 内部权限。使用自定义状态目录时，同时在 MCP 的 `args` 中加入 `"--state-dir", "<同一目录的绝对路径>"`。

多个 Master 需要分开管理会话时，为各 MCP 进程固定不同的会话标识：

```powershell
harness-sup-mcp --mode production --owner-ref <stable-session-reference> --notify-none
```

该连接只能操作所属会话的 Worker 与通知 ACK，不继承共享 daemon 的 Codex 通知目标。旧 Worker 不自动归入新会话，仍可通过全局 CLI 查询。DSH 插件会自动设置归属。归属检查是路由护栏，不是操作系统沙箱。

## 可选 WebUI

daemon 启动时默认开启 WebUI：独立 HS 监听 `127.0.0.1:61114`，DSH 插件实例监听 `127.0.0.1:61115`，不会自动打开浏览器。浏览器仍需通过可信入口取得访问凭证，独立 HS 用户可运行：

```powershell
harness-sup ui          # 在系统浏览器中打开
harness-sup ui --stop   # 关闭 WebUI，Worker 继续运行
```

独立 HS 与 DSH 插件使用各自的实例和默认端口，可以同时开启 WebUI。端口被其他程序占用时会记录启动失败，Worker 与 IPC 仍可使用；释放端口后可通过对应入口重试开启。

可在启动 daemon 前设置 `HARNESS_SUPERVISOR_UI=0`，关闭默认监听；之后仍可用 `harness-sup ui` 手动开启。`ui --stop` 会关闭当前监听，直到再次手动开启或 daemon 重启。

浏览器和 DSH 使用同一套界面，可按“工作目录 → 会话 → Worker”查看状态、结果、轨迹和用量，回答输入或取消任务；任务创建与续接由 Master 完成。界面仅监听 `127.0.0.1`，一次性入口兑换独立浏览器凭证，不向网页暴露 IPC Token。刷新不会唤醒模型或自动 ACK；daemon 或 WebUI 重启后需从可信入口重新打开。

Codex、Claude Code 与其他 Harness 共用侧栏、关系图和详情，显示各自的本地图标与品牌色。运行信息优先显示原生会话初始化时上报的模型配置；仅有请求配置时标注“请求”，未上报时保留未知。这些身份信息不是逐轮计费用量。新增运行时的完整检查项见 [Harness 接入指南](https://github.com/Chenpi-Sakura/harness-supervisor/blob/main/docs/harness-integration.md)。

## 更新 HS

### DSH 用户

按 DSH 插件管理器更新 `dsh-harness-supervisor@latest`。使用“插件内置 HS”时，新插件会为支持托管更新的旧核心自动登记受控升级：停止接收新任务，等待已有任务结束，备份并验证后切换。外部 npm／自定义核心不自动替换；不会降级或自动重试已取消、失败的同一候选。可在设置中刷新状态、查看诊断，切换完成后重新打开 Worker 面板。

### 独立 CLI / MCP 用户

先更新 npm 客户端，再从已安装包准备候选核心：

```powershell
npm install -g harness-supervisor@latest
$hsPackageRoot = Join-Path (npm root -g) 'harness-supervisor'
harness-sup runtime prepare --source $hsPackageRoot
harness-sup runtime apply --runtime-id <返回的id> --intent-id <本次更新的唯一标识>
harness-sup runtime status
```

安装新版 npm 包不等于切换正在运行的核心。上述命令需要指向现有实例的同一 `--state-dir`；HS 会暂停接收新任务，等待已有任务和队列结束，再切换并验证新核心。等待期间仍可回答输入、取消 Worker，也可用 `harness-sup runtime cancel --intent-id <同一标识>` 取消更新。切换完成后，使用该状态目录的受支持客户端共用新核心，WebUI 需重新打开。

从旧 `0.9.2` 等缺少受控更新能力的实例首次迁入时，须先安排维护窗口、处理活动 Worker 并停止旧 daemon。无法确认进程退出时自动切换会停止；不要删除锁或并行拉起旧核心。状态目录中的 `runtime-update.json`、`runtime-update.log` 与 `runtime-backups/` 保留恢复线索。

<details>
<summary>离线安装备用方式</summary>

下载预构建 `.tgz` 后，可以用 `npm install -g <核心包.tgz>` 安装独立 HS，或在 DSH 自带的插件管理器中添加插件 `.tgz` 的完整路径。安装包已包含构建产物与生产依赖，不需要源码编译；运行核心的切换仍按上面的更新流程执行。

</details>

## 核心理念

HS 的目标：以尽可能低的开销，让独立的原生 Harness Worker 被可靠地调用、观察、控制和协作。

**不做**

- 新的 Agent 框架或 Agent Loop；
- Planner / Reviewer / Challenger 等角色拆分；
- 任务 DAG、投票、模型路由或固定工作流；
- Harness 内部的规划、工具调用与上下文管理；
- 额外 LLM 做调度或生命周期管理；
- 多用户、远程调度、配额管理或安全沙箱。

**设计原则**

- **原生优先**：优先使用运行时原生协议、Session 与控制能力；不为统一接口伪造底层不支持的行为。
- **提供能力，不规定工作流**：任务如何拆分、是否多轮协作，由 Master 自行决定。
- **状态来自证据**：`completed` 只在 Harness 报告 settle、或进程退出被确认后出现。
- **先落盘再交付**：重要事件与通知先写入本地追加日志，消费者离线不丢。

## 当前接入

| Runtime | 传输 | 状态 |
| --- | --- | --- |
| Pi Agent | Pi 原生 RPC（Pi v1.3+） | 完整支持 |
| Qoder CLI | 官方 ACP 默认，stream-json 可回退 | 实验性 |
| MiniMax Code | ACP over ndJSON | 实验性 |
| DeepSeek Harness / DSH | 官方 ACP（`dsh --profile acp`） | PoC |
| Codex | 外部 `@agentclientprotocol/codex-acp` | 实验性，已通过真实任务与持续会话验收 |
| Claude Code | 外部 `@agentclientprotocol/claude-agent-acp` | 实验性，已通过真实任务与持续会话验收 |

## 功能

- **独立 Worker**：每个 Worker 是一个原生 Harness 子进程，有自己的 cwd、session 与进程树。Worker 属于 daemon，客户端断开后继续运行。
- **完整生命周期**：spawn / status / events / wait / send / answer / cancel / resume，含并发准入、取消与关停屏障、重启对账。
- **增量事件**：每 Worker 一条追加式事件流，`seq` 单调递增，支持 `sinceSeq` 游标；状态变化与普通进度分开返回。
- **持久化通知收件箱**：完成 / 失败 / 取消 / 需要输入 / 崩溃 / 失联等事件生成稳定 ID 的通知，可查询、可确认、跨重启保留；默认不产生任何外部调用。
- **可选队列投递**：登记 Codex thread 后，可用官方 `codex queue` 把简短通知写入该 thread；是否真正唤醒 Master 取决于宿主是否加载该 thread。
- **可选请求幂等**：`spawn` / `resume` / `send` 支持 `requestId`；重复请求不会重复执行，结果不确定时报 `UNCERTAIN`。
- **任务度量**：每次 `spawn` 自动创建或关联一个委托任务；记录 Worker 终态、耗时、可得的运行时 Token 用量，并生成带覆盖率、来源和未知字段的单任务/汇总报告。费用不采集，验收、返工与干预尚未采集。
- **Qoder 双传输**：默认使用官方 ACP，可回退 stream-json；两种传输的会话句柄不互换，能力差异如实报告。
- **DSH ACP 接入**：支持 spawn / 事件 / 取消 / `session/resume` / 模型与推理强度配置 / 权限提权应答；桌面端安装可自动发现，也可用 `HARNESS_SUPERVISOR_DSH_ENTRY` 指定入口。
- **Codex / Claude Code ACP 接入**：复用原生认证与设置，支持持续会话、权限审批、取消和能力协商后的恢复。适配器独立安装、独立更新，不绑定 HS 发布版本。
- **统一入口**：CLI、MCP、IPC 共享同一个 daemon 与同一份状态。

## 架构

```mermaid
flowchart TB
    Client["Master / 外部客户端"]

    subgraph interfaces["接口"]
        CLI["CLI"]
        MCP["MCP (stdio)"]
    end

    IPC["SupervisorClient<br/>本地 IPC（named pipe / Unix socket + token）"]

    subgraph daemon["Supervisor daemon"]
        direction TB
        Lifecycle["生命周期<br/>状态机 / 并发准入 / wait / 输入 / 取消 / 恢复"]
        Events["事件<br/>追加式日志 + seq 游标"]
        Inbox["通知<br/>持久化收件箱"]
        Metrics["度量<br/>任务 / 用量追加日志"]
    end

    subgraph adapters["Runtime Adapters"]
        Pi["Pi 原生 RPC<br/>Pi 子进程"]
        Qoder["Qoder ACP 默认 / stream-json 回退<br/>qodercli 子进程"]
        Mcode["MiniMax Code ACP（ndJSON）<br/>mcode acp 子进程"]
        Dsh["DeepSeek Harness ACP（ndJSON）<br/>dsh --profile acp 子进程"]
        Codex["Codex ACP 适配器<br/>Codex App Server"]
        Claude["Claude ACP 适配器<br/>Claude Agent SDK"]
    end

    Client --> CLI
    Client --> MCP
    CLI --> IPC
    MCP --> IPC
    IPC --> Lifecycle
    Lifecycle --> Events
    Lifecycle --> Inbox
    Lifecycle --> Metrics
    Lifecycle --> Pi
    Lifecycle --> Qoder
    Lifecycle --> Mcode
    Lifecycle --> Dsh
    Lifecycle --> Codex
    Lifecycle --> Claude
```

| 模块 | 职责 |
| --- | --- |
| `src/adapters/` | Pi / Qoder / MiniMax Code / DSH / Codex / Claude Code 的运行时适配，以及通用 ACP ndJSON 传输 |
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
3. **状态来自证据**：`spawn` 返回只表示任务已接受；`completed` 只在 Harness 报告 settle、或进程退出被确认后出现。
4. **恢复显式且受限**：daemon 重启不会接管原进程；`resume` 使用“新进程 + 加载持久化 session + 新 prompt”，并校验 session，不重放旧操作。
5. **先落盘再交付**：重要事件与通知写入本地追加日志；投递语义为 at-least-once。

## 权限与 MCP 返回契约

### 推荐权限

HS 的推荐默认是让原生 Harness 直接执行完整任务，不为普通文件/命令操作增加人工审批：

| 运行时 | 推荐设置 | 说明 |
| --- | --- | --- |
| Qoder CLI | `HARNESS_SUPERVISOR_QODER_PERMISSION_MODE=bypass_permissions` | ACP 下映射为 `yolo`（Auto-approves all tools）；不设置时也是该默认 |
| MiniMax Code | `HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE=bypassPermissions` | 宿主原生默认；不设置时也是该默认 |
| DSH | `HARNESS_SUPERVISOR_DSH_PERMISSION_MODE=danger-full-access` | 原生默认 `workspace-write` + 审批 `ask`：工作区内写入免审批，工作区外写入会被拒绝并可触发一次性提权。设为 `danger-full-access` 才移除文件沙箱且不再询问；`read-only` 只读。桌面端 UI 的三种模式属于 desktop profile，不会自动传给 ACP |
| Pi | 由 Pi 自身配置决定 | HS 不管理 Pi 的权限模式 |

建议在**启动 daemon 的环境**中显式写出上述值，修改后重启 daemon。只有确实需要逐工具人工审批时，才改为 `default`（Qoder 在 ACP 下会通过 `session/request_permission` 暴露原生选项）。桌面端权限选择器只影响桌面会话。

**边界**：这些模式只表示跳过审批，不提供沙箱隔离。Worker 与 daemon 使用同一 OS 用户，仍可访问该用户可访问的文件、进程和网络；高风险任务应使用真正的隔离环境。

### MCP 输出模式

MCP server 有两种呈现模式，只影响当前 MCP 进程如何返回结果，不改变 daemon、Worker 状态、持久化事件、通知路由或权限边界：

- `production`（默认）：只返回 Master 执行任务所需字段。`status` 是有界状态快照，不返回事件、时间线或完整结果；`wait` 在完成时返回完整最终结果，需要输入时返回 `pendingInput`，超时只返回状态与游标；`until=event` 未指定 `types` 时只等待 lifecycle 事件，progress 不会结束等待；`events` 只返回 lifecycle 摘要，`run.progress` 不会进入 Production；`list` 使用 Keyset 分页。适合日常使用。
- `development`：扩展诊断字段白名单（完整 result/pendingInput、`recentEvents`、`lastProgress`、`timeline`、`stderrTail`、PID/session 引用等），但不是原始内部记录直出。用于排查问题，不进入 Master 的默认调用链。

配置优先级：命令行 `--mode` > 环境变量 `HARNESS_SUPERVISOR_MCP_MODE` > 默认 `production`。非法值会在 MCP 启动时明确报错退出，不会静默降级，也不使用 `NODE_ENV`。

开发模式命令与隔离实例配置见[源码开发与验证](#源码开发与验证)。

`production` 的字段精简只服务于上下文预算，不提供安全隔离；完整诊断可在 `development` 或 CLI/IPC 中获取。完整最终结果不会被展示层截断；`result.truncated` 只表示 Supervisor 存储层已按 `maxResultBytes` 截断。

`worker_spawn` 返回样例（接受任务，任务可能仍在运行；`notifyTarget` 是实际持久化目标）：

```json
{"id":"w-xxx","accepted":true,"runtime":"pi","status":"running","lastSeq":5,"notifyTarget":{"channel":"none"}}
```

`worker_wait` 完成时返回样例（完整结果只出现一次；默认不带事件）：

```json
{"worker":{"id":"w-xxx","runtime":"pi","status":"completed","lastSeq":11,"result":{"text":"最终报告全文","truncated":false},"resumeAvailable":true,"session":{"available":true,"restorable":true}},"terminal":true,"timedOut":false,"nextSeq":11,"hasMore":false}
```

`worker_status` 默认是有界快照：只带 `resultPreview`/`errorPreview` 和必要的 `pendingInput`，不带 `recentEvents`、`lastProgress`、`timeline` 或 `inputState`。需要完整待处理输入时显式传 `includeInput=true`；需要完整结果时用 `worker_wait`。完整结果可从 `worker_wait` 获取，事件历史从 `worker_events` 获取。

`worker_list` 返回 `{workers,nextCursor,hasMore}`；把 `nextCursor` 原样传回并保持相同的 `statuses`/`includeArchived` 过滤条件即可遍历完整历史。旧于 0.9.1 的 Daemon 仍可返回第一页；cursor 页会返回带升级指引的 `UNSUPPORTED`，不会把旧严格 Schema 错误直接暴露。

## 接口

### MCP 工具

| 工具 | 用途 |
| --- | --- |
| `worker_spawn` | 启动 Worker；prompt 被接受即返回，不等待完成 |
| `worker_status` | 有界状态快照、pending input 预览、结果/错误预览；完整结果用 `worker_wait` |
| `worker_list` | 列出 Worker（持久化、跨重启）；`{workers,nextCursor,hasMore}` Keyset 分页 |
| `worker_events` | 增量读取 lifecycle 事件；Production 不返回 `run.progress` 或原始 `data` |
| `worker_wait` | 有界等待（默认 30s，最大 120s）；完成时返回完整结果，超时只返回状态与游标 |
| `worker_send` | 运行中追加 steer / follow-up |
| `worker_answer` | 回答输入请求或权限询问 |
| `worker_cancel` | 取消并确认终态；不影响其他 Worker |
| `worker_resume` | 用新指令恢复已有 session |
| `worker_continue` | 在 idle 的 persistent Worker 上提交下一轮；沿用同一 native session |
| `worker_admin` | pin / unpin、archive / unarchive、retire / unretire |
| `worker_forget` | 删除终态 Worker 的 HS 记录与事件；保留 native session 文件 |
| `supervisor_info` | Production 为版本、模式、runtime 与 Worker 计数快照；完整诊断在 Development |
| `supervisor_notifications` | 读取通知收件箱（production 默认全部未确认；development 默认 pending） |
| `supervisor_notifications_ack` | 确认通知（幂等） |
| `supervisor_wake_target` | 可选：登记 Codex thread 以启用队列投递 |
| `metrics_task_create` | 创建一个可关联多个 Worker 的委托任务 |
| `metrics_task_show` | 单任务状态、耗时、用量摘要、覆盖率与警告；原始 usage 记录仅在 Development 返回 |
| `metrics_report` | 区间汇总（按任务创建时间）、覆盖率、未知字段；`includeTasks` 在 Production 返回任务摘要，Development 返回完整详情 |
| `metrics_record_usage` | 人工补录 Master 或 Worker 用量；支持 `usageId` 幂等 |

### CLI 命令

| 分类 | 命令 | 用途 |
| --- | --- | --- |
| 守护进程 | `up` `down` `daemon` `info` | 启动、关闭、前台运行 daemon，查看版本与状态目录 |
| Worker 管理 | `spawn` `list` `status` `events` | 创建 Worker，列出、查询状态，增量读取事件 |
| Worker 通信 | `wait` `send` `answer` `cancel` `resume` `continue` | 有界等待、追加指令、回答输入、取消、恢复、继续同一 Worker 的下一轮 |
| Worker 管理 | `admin` `forget` | 固定、归档、退役、取消退役；删除 HS 记录但保留 native session |
| 通知 | `inbox` `ack` `notify-target` `retry-notifications` | 读取与确认收件箱，登记投递目标，重试投递 |
| 度量 | `metrics create\|show\|report\|export\|record-usage` | 创建任务，查看单任务/汇总报告，导出，补录用量 |
| 维护 | `prune` `compact` | 清理终态且没有未确认通知的 Worker；压缩终态 Worker 的旧进度事件 |

### 状态与事件

| 类别 | 值 |
| --- | --- |
| 非终态 | `starting` `running` `awaiting_input` |
| 终态 | `completed` `failed` `cancelled` `crashed` `orphaned` `interrupted` |
| Worker 事件 | `worker.starting` `worker.started` `worker.session` |
| 运行事件 | `run.accepted` `run.started` `run.progress` `run.usage` `run.needs_input` `run.input_answered` `run.message_sent` `run.error` `run.completed` `run.failed` `run.cancelled` |
| 生命周期事件 | `worker.cancel_requested` `worker.exited` `worker.crashed` `worker.orphaned` `worker.interrupted` `worker.resumed` `worker.continued` `worker.resume_failed` |

`run.usage` 是结构化、低频的运行时用量报告；`run.progress` 中旧的 `kind=usage` 仍保留以兼容既有事件消费者，但任务度量只消费 `run.usage`。`run.usage` 只描述 Token，不包含费用。

`orphaned` 表示 daemon 重启后进程可能仍存活但已失去控制；`interrupted` 表示进程已不在或 PID 已被复用。两者都不代表任务成功，也不会被自动重跑。

### 关键语义

| 主题 | 语义 |
| --- | --- |
| `spawn` | 返回时任务尚未完成；终态以 `wait` / `status` 为准 |
| `worker_wait` | 有界等待；超时只表示等待窗口结束，不带游标时应先检查当前状态 |
| `run.message_sent` | 只表示消息被 Harness 接受；模型是否看到或采纳需以事件与结果为准 |
| `resume` | 使用新进程加载持久化 session；不会续接原进程内存，也不会自动重跑中断任务 |
| `continue` | 仅用于 `persistent` Worker；要求同一 session 仍可恢复，拒绝时不会创建替代 Worker |
| `pin` | 保护 Worker 不被 `prune` 或 `forget` 删除 |
| `archive` | 仅从默认 `list` 隐藏；记录、事件与 session 引用保留 |
| `retire` | 停止接受新的 `continue` / `resume`；`unretire` 可恢复 |
| `forget` | 显式删除 HS 记录与事件；native session 文件保留，需无未确认通知 |
| `prune` | 显式维护操作；只清理终态、未 pin 且没有未确认通知的 Worker |
| `compact` | 只处理终态、未 pin、无运行中进程且非 orphaned 的 Worker；保留全部生命周期事件与最新进度，seq 游标不变 |
| `requestId` | 不带 `requestId` 时不具备幂等性；带 `requestId` 时也不提供跨组件的 exactly-once |

### Persistent Worker

接口演进与兼容变化见 [CHANGELOG](CHANGELOG.md)。

`worker_spawn` 传入 `persistence="persistent"`（CLI 为 `spawn --persistence persistent`）后，Worker 的身份和 native session 会跨 Turn 保留。每轮结束后 Activation 进程退出，`status` 仍记录本轮终态（通常为 `completed`），派生字段 `lifecycle` 变为 `idle`；下一轮通过 `worker_continue` 在同一个 `workerId` 和同一个 session 上启动新的 Activation。

| 字段 | 含义 |
| --- | --- |
| `persistence` | `oneshot`（默认，兼容旧行为）或 `persistent` |
| `lifecycle` | `active` `awaiting_input` `activating` `idle` `orphaned` `unavailable` `unknown`；由状态、进程与 session 可用性派生，不额外持久化 |
| `session.available` | 记录的 session locator 存在 |
| `session.restorable` | 当前可以安全启动新的 Activation；进程可能仍在运行、Worker orphaned 或文件缺失时为 `false` |
| `session.reason` | `restorable=false` 的原因，例如 `session_file_missing`、`process_may_be_running` |

`continue` 与 `resume` 分工：`continue` 用于正常交付下一轮工作；`resume` 保留原有恢复语义。Worker 为 `persistent` 但 session 不可恢复时，`continue` 返回真实错误，不会静默新建 Worker 或伪造上下文连续性。旧记录没有该字段时按 `oneshot` 读取。

进程退出只释放运行资源；HS 不会因 Turn 结束删除 native session，也不会自动把 Worker 标记为退役。`pin` 保护记录，`archive` 只影响默认列表，`retire` 阻止新的 Turn，`forget` 删除 HS 记录与事件但保留 native session 文件，`compact` 只裁剪旧进度事件、不改动 session。原生 Session 删除尚未提供。

### 存储诊断

`supervisor_info`（CLI 为 `info`）的 `storage` 字段提供状态目录的事件字节总量、最大事件文件、active / idle / other Worker 数量以及上次启动各阶段耗时。数值来自已加载的事件文件长度，不做额外全盘扫描；`startup.store.eventBytes` 是启动时快照，不是当前值。

`compact [workerId] [--keep-progress 200] [--dry-run] [--json]` 用于压缩终态 Worker 的事件日志：保留全部非 `run.progress` 事件、最新 N 条进度以及最后一条事件，原子重写 `events.jsonl` 并在记录中写入 `compacted` 标记。序列号保持不变，因此已有游标仍可继续读取；`worker.compacted.retainedFromSeq` 标明仍保留的最小序号，失去的中间序号属于显式压缩，重启时不会被误报为历史损坏。压缩后的记录仍可 `continue`（persistent Worker），`forget` 与原生 session 行为不变。`--dry-run` 只报告可回收的事件与字节数；活跃、orphaned、pinned 或仍有运行中进程的 Worker 会被拒绝或跳过。

### 持久化与幂等

每个 Worker 的事件缓存最多保存最近 500 条，完整历史仍在追加日志中。启动流式扫描日志，历史查询按需异步分页，稀疏字节索引支持深页读取；通知重建使用单次流式扫描。已知的事件缺口或追加失败会明确报错，不将残缺历史伪装为完整结果；单个损坏日志不会阻止其他 Worker 继续受管。

直接使用 TypeScript/JavaScript 库的调用方需注意：`Supervisor.events()` 返回 Promise，应使用 `await`；`Store.getEvents()` 只访问缓存，`truncated:true` 表示需调用 `await Store.readEvents()` 获取完整历史，`Store.scanEvents()` 用于全历史流式处理。

带 `requestId` 的副作用操作会先等待准入记录写入，再启动进程或发送消息；持久化失败会明确返回错误。通知也在收件箱记录写入确认后才调用宿主。上述承诺针对进程崩溃和写入失败，不提供断电 fsync、磁盘损坏或跨组件 exactly-once 保证。

### Worker 报告协议与命令守卫

HS 是唯一受支持的 Worker 通知生产路径。`spawn` / `resume` 发送的任务提示会前置固定协议块：Worker 以最终答复结束本次运行，不得调用 `codex queue` 或其他宿主接口向 Master 会话注入报告，也不得为此另起 Codex 会话；需要决策时使用自带 harness 的 permission/input。

运行时再加一层最小护栏：Daemon 启动时若在 PATH 中找到 Codex CLI，就在 `<stateDir>/worker-guard/bin` 生成 `codex` shim，并只把该目录前置到 **Worker 进程**的 PATH。`codex queue` 返回退出码 2、向工具 stderr 写一行说明，并在 `<stateDir>/worker-guard/worker-guard.jsonl` 追加 `{ts, workerId, argv, cwd}`；其他子命令转发给真实 CLI。Daemon 自身的 PATH 与通知投递不受影响。若 Codex 是后来才安装的，重启 Daemon 后护栏才会生成。

```powershell
# 暂时关闭护栏（仅诊断/兼容）
$env:HARNESS_SUPERVISOR_WORKER_GUARD = '0'
# 关闭任务提示中的协议块（仅诊断/兼容）
$env:HARNESS_SUPERVISOR_WORKER_PROTOCOL = '0'
```

**边界**：这是一层护栏与审计，不构成安全边界。Worker 使用绝对路径、其他宿主接口、修改 PATH 或覆盖 shim 都能绕过；同一 OS 用户下 HS 无法仅凭 PATH 阻止。Pi 已用真实进程和 shell 验证拦截与放行；Qoder、MiniMax Code 与 DSH 复用同一环境注入，但其工具 shell 的 PATH 解析未单独验证。护栏失败（找不到 Codex、目录不可写）只记 `daemon.log`，不阻断 Worker 启动。

## 运行时支持

| Runtime | 状态 | 已验证范围 |
| --- | --- | --- |
| Pi | 完整 | 原生 RPC；spawn / steer / follow-up / cancel / resume；Persistent 3 轮连续协作（同 Worker / 同 Session）；dialog 尚未单独真实覆盖 |
| Qoder CLI | 实验性 | ACP 默认：spawn / resume / 审批 / 提问 / 取消 / Persistent 3 轮连续协作。stream-json 回退：spawn / cancel / resume；steer、follow-up 被接受但未生效 |
| MiniMax Code | 实验性 | ACP：spawn / 完成 / 取消 / resume / Persistent 3 轮连续协作；活跃回合内 steer；queue 入队；Ask 模式尚未触发 |
| DSH | PoC | ACP v1：spawn / resume / 模型与推理配置 / 工作区写入 / 工作区外提权 / 完全权限 / 取消 / Persistent 3 轮连续协作 |
| Codex | 实验性 | Codex ACP 2.6.0 + Codex CLI 0.169.0：`gpt-6-luna` / `low`；真实三轮、进程重启后恢复及文件内容核对；HS daemon/IPC 真实文件任务。审批和取消另有协议与集成测试 |
| Claude Code | 实验性 | Claude ACP 0.107.0 + Claude Code 2.1.325：原生 MiniMax-M3.1-Flash 配置；真实三轮、进程重启后恢复及文件内容核对；HS daemon/IPC 真实文件任务。审批和取消另有协议与集成测试 |

### 操作能力对比

`是` 表示适配器实现了该能力；`有条件` 表示依赖特定传输、扩展或版本，或只有协议/单元测试；`否` 表示明确不支持。真实运行覆盖范围见上表。

| 操作 | Pi | Qoder ACP（默认） | Qoder stream-json 回退 | MiniMax Code | DSH | Codex / Claude ACP |
| --- | --- | --- | --- | --- | --- | --- |
| 协议 | Pi RPC | ACP v1 | stream-json | ACP | ACP v1 | ACP v1 |
| spawn / 单轮 prompt | 是 | 是 | 是 | 是 | 是 | 是 |
| 流式文本 / 思考 / 工具事件 | 是 | 是 | 是 | 是 | 是（无 plan） | 是 |
| 取消 | 是 | 是 | 是 | 是 | 是 | 是 |
| resume | 是（Pi session 文件） | 是（`session/load`） | 是（`--resume`，校验 session id） | 是（`session/load`） | 是（`session/resume`，要求相同绝对 cwd） | 有条件（适配器声明 session/load） |
| Idle continue（同一 Worker / Session 下一轮） | L3（真实 3 轮） | L3（真实 3 轮） | L2（未跑 3 轮；resume 已真实验证） | L3（真实 3 轮） | L3（真实 3 轮） | L3（真实 3 轮，含重启恢复） |
| 运行中 steer | 是 | 否 | 有条件（被接受，未验证生效） | 有条件（需 steer 扩展；活跃回合内已验证） | 否 | 否 |
| follow-up 队列 | 是 | 否 | 有条件（被接受，未验证生效） | 有条件（需 queue 扩展；已验证入队） | 否 | 否 |
| 交互输入（审批 / 提问 / 对话框） | 是（extension dialog） | 是（permission + elicitation） | 1.1.79 及以前支持；1.1.82 不支持提问/审批 | 是（Ask 模式触发时） | 仅审批；请求不含工具名/输入，无 elicitation | 仅权限审批；未接入提问扩展 |
| 权限模式控制 | 由 Pi 自身配置，HS 不管理 | 5 种 ACP 模式映射（plan 无对应） | 支持（默认 `bypass_permissions`） | `bypassPermissions` 默认 / `default` 为 Ask | 3 种（默认 `workspace-write` + `ask`） | 沿用原生设置，不自动提权 |
| 模型 / 思考配置 | 是 | 是 | 是 | 否（忽略，走运行时配置） | 是（model 对 + `reasoning_effort`） | 是（需目录提供并确认） |
| provider 参数 | 是 | 否（写进 model 名） | 否（写进 model 名） | 否（写进 model 名） | 是（model 重名时必须） | 否（沿用原生配置） |
| 工具白名单 | 是 | 否 | 是 | 否（忽略） | 否 | 否（明确拒绝） |
| extraArgs | 是（禁改保留参数） | 是（禁改保留参数） | 是（禁改保留参数） | 仅校验，不转发 | 否（明确 `UNSUPPORTED`） | 否（明确拒绝） |
| Token 用量 | 是（原生 usage） | 未知（1.1.82 计数全零） | 有条件（`result.usage` 存在时） | 否（仅上下文占用） | 否（仅上下文占用） | 未知（未采集） |
| pause | 否 | 否 | 否 | 否 | 否 | 否 |

说明：

- MiniMax Code 的 `model`、`thinking` 和 `tools` 不会传给其 ACP 会话；`extraArgs` 只做保留参数校验，不会转发。需要这些设置时应在 MiniMax Code 自身配置中完成。
- Qoder ACP 的 `tools` 会被明确拒绝，需要工具白名单时请使用 stream-json 回退；Qoder 的 `provider` 需要写进 model 名。
- DSH 的 `tools` 与 `extraArgs` 会被明确拒绝；其 `usage_update` 只表示上下文占用。DSH Worker 的 ACP 接入仍标记为 PoC；DSH 作为 Master 的插件使用方式见前文。

用量采集边界：Pi 只在 assistant message 原生提供 `usage` 时记录；Qoder 只在 `result.usage` 存在时记录；MiniMax Code 0.6.13 的 ACP 只提供上下文 `used`/`size` 与 `cost=0 USD`，prompt result 不含 usage；DSH 的 `usage_update` 同样只表示上下文占用，不写 `run.usage`。Master 用量不会从宿主会话自动读取，必须显式补录。

## 边界

- **无沙箱**：`cwd` 只表示默认工作目录；Worker 与 daemon 同用户、继承环境变量，可访问该用户可访问的文件与网络。
- **单用户本地**：没有多用户、远程 MCP 认证或配额管理；生命周期控制不提供资源限制。
- **投递语义为 at-least-once**：通知与队列投递可能重复；`delivered` 只表示已写入目标，Master 是否读到取决于宿主。
- **唤醒受宿主约束**：只有宿主加载了目标 thread，队列消息才会触发新回合。
- **度量为参考值**：Token 来自运行时事件或人工补录，未与 provider 账单核对；本系统不采集费用，验收、返工、干预和对照基线也未采集。Master 用量缺失即未知，不会按零计算。
- **统计故障不阻断执行**：度量存储不可用时 Worker 仍可运行，但该 Worker 可能没有任务关联或用量记录，报告会明确说明。
- **崩溃后不接管**：daemon 重启只做状态对账，不会重新接上原管道，也不会自动重跑。
- **平台**：Windows 原生已验证；WSL / 其他 POSIX 需自行验证。

## 源码开发与验证

仅修改源码、开发插件或运行项目测试时需要 Clone。以下以 PowerShell 为例：

```powershell
git clone https://github.com/Chenpi-Sakura/harness-supervisor.git
cd harness-supervisor
npm ci
npm run build
npm run typecheck
```

开发联调必须使用独立状态目录。下列 CLI 和 MCP 连接到同一个开发实例：

```powershell
$hsDevState = Join-Path $PWD '.artifacts/hs-dev-state'
node dist/src/cli.js up --state-dir $hsDevState
node dist/src/cli.js info --state-dir $hsDevState
node dist/src/mcp.js --mode development --state-dir $hsDevState
```

`development` 是 MCP 诊断输出模式，不是 daemon 开关；CLI 的 `--mode` 用于 `send` 的消息类型，没有 `--develop` 参数。若在 Master 中注册开发 MCP，使用源码入口和状态目录的绝对路径，保留 `--mode development --state-dir <开发目录>`。开发进程不要复用在用实例的默认状态目录。

按改动范围执行现有脚本：

```powershell
npm run test:web
npm run test:plugin
npm test
```

`npm test` 包含构建与核心套件；真实 Harness 验收另需相应运行时、账号及测试开关。开发结束后，可用 `node dist/src/cli.js down --state-dir $hsDevState` 关闭自己的开发实例；该命令会取消其中的活动 Worker。

发布包由 `npm run pack:core` 生成固定生产依赖的核心 `.tgz`，DSH 插件打包见[插件开发说明](https://github.com/Chenpi-Sakura/harness-supervisor/tree/main/packages/dsh-plugin#开发与打包)。

## License

MIT

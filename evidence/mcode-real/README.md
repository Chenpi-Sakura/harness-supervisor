# MiniMax Code ACP 适配真实运行证据（2026-10-23）

本目录记录 HS 新增 **MiniMax Code** runtime adapter 后的真实运行证据。Adapter 通过 MiniMax Code 的 **Agent Client Protocol（ACP）** 接入，即 `mcode acp` 子进程。

## 协议事实（对真实进程核对，非文档推断）

上游 `MiniMax-AI/minimax-code`（MIT 开源）的 ACP 实现在 `packages/tui/src/acp/`，传输层为 `acp.ndJsonStream`。对本机安装的 `@minimax-ai/code@0.6.12` 实测：

| 事实 | 核对方式 |
| --- | --- |
| 传输是 **ndJSON**（每行一个 JSON-RPC 2.0 消息），不是 LSP `Content-Length` 帧 | 上游 `packages/tui/src/acp/stdio.ts` + 真实握手 |
| `initialize` → `protocolVersion: 1`，`agentInfo.name = minimax-code` | 真实握手响应 |
| `session/new {cwd, mcpServers}` → `{sessionId, modes, configOptions}` | 真实响应 |
| `session/prompt` 是 **request 且阻塞到 turn 结束**，返回 `{stopReason}`；过程中通过 `session/update` 推 `agent_message_chunk` | 真实 turn，`stopReason: "end_turn"` |
| `session/cancel` 是 **notification**（无 id），不是 request | 上游 `agent.ts` `app.onNotification(acp.methods.agent.session.cancel, …)` |
| `session/load {sessionId, cwd, mcpServers}` 用于恢复已有会话 | 真实 `session/load` 调用（缺 `cwd`/`mcpServers` 会被参数校验拒绝） |
| 权限请求是 **agent → client 的反向 request** `session/request_permission`，回复需**原样回传 id** | 上游 `interactions.ts` + 真实交互 |
| 真实权限选项为 `allow-once` / `allow-always` / `deny`（显示名 `Allow once` / `Always allow` / `Deny`） | 真实权限往返 |
| **MiniMax Code 默认 `bypassPermissions`**，因此工具调用默认不询问；要触发询问必须先用 `session/set_config_option`（注意是 snake_case）把会话切到 `default`（Ask） | 真实 `session/new` 响应 + 真实切换 |
| 哪些命令会被拦由 MiniMax Code 运行时的风险分类决定，**不是简单的读写之分**：Ask 模式下实测 `ls` 与 `echo x > f.txt` 都未触发许可，而后续的 `Get-Content` / `Get-Item` 验证命令触发了许可 | 手工对比实验（**该实验的产物未归档**，见下方「已知限制」） |
| steer / follow-up 走 mcode 私有扩展 `mcode/session/steer`、`mcode/session/queue/enqueue`，且仅在 `initialize` 的 `_meta["minimax-code/extensions"].methods` 声明时可用 | 真实 `initialize` 响应 |
| Windows 不能直接 spawn npm 的 `.cmd` shim（Node 报 `spawn EINVAL`），必须 `node <cli.js> acp` | 真实 spawn 失败与修正 |

## 真实 E2E 结果

`npm run e2e:mcode`（`scripts/e2e-mcode.mjs`）使用**真实 MiniMax Code CLI**、独立 daemon 与独立状态目录：

- 第一次运行：worker `completed`，返回 `MCODE_E2E_OK`，记录到 ACP `sessionId` 与会话句柄文件。
- 同一 worker `resume`：再次 `completed`，返回 `MCODE_E2E_RESUMED`。
- **权限往返**：第三个 worker 真实触发 `session/request_permission`，选项 `Allow once` / `Always allow` / `Deny`；回答 `Allow once` 后该 run 正常 `completed`。请求标题是模型生成的自由文本，**逐次不同**（归档里那次是 `Allow Verify file exists and print its contents?`），所以它只能当作示意，不能当固定断言。
- **取消**：第四个 worker 跑一条约 29 秒的命令，在 turn 存活时被取消，run 以 `cancelled` 收尾，事件序列为 `worker.starting` → `worker.started` → `worker.session` → `run.started` → `run.accepted` → `worker.cancel_requested` → `run.cancelled` → `worker.exited`。
- 事件序列包含 `worker.starting` → `worker.started` → `worker.session` → `run.started` → `run.accepted` → `run.progress` → `run.completed`。

> **权限往返不是每次都会出现**：是否弹许可由 MiniMax Code 运行时的风险分类决定，取决于 agent 实际执行了哪条命令。E2E 的提示词现在让 agent 在写文件后再用 `Get-Content` 验证文件存在（这条命令在实测中会触发许可）；即便如此，某次运行仍可能不触发，脚本会把这种情况记成 `outcome: "not_requested"` 并打印提示，而不是假装通过。

原始产物见 [mcode-e2e.json](mcode-e2e.json)。

> 两个 E2E 脚本默认把产物写到**系统临时目录**（`%TEMP%\hs-mcode-evidence`），不会静默覆盖本目录里已归档的证据。要刷新归档时显式指定输出目录：
>
> ```powershell
> $env:MCODE_EVIDENCE_DIR = "D:\Projects\harness-supervisor\evidence\mcode-real"
> npm run e2e:mcode
> ```

## 真实 steer / follow-up 验收

`npm run e2e:mcode:steer`（`scripts/e2e-mcode-steer.mjs`）同样使用**真实 MiniMax Code CLI**、独立 daemon 与独立状态目录：

- 启动一个跑 `ping -n 12 127.0.0.1`（约 11 秒）的 turn，**等到 agent 真的开始了一次工具调用**才发 steer —— 因为上游要求 turn 已被准入（`activePromptTurnId`），提前发会被拒。
- steer 的回执由 agent 自己给出：`mode = "steered"`，并带上它加入的那个 turn 的 `turnId`。
- agent **确实照做了**：最终结果文本包含 `MCODE_STEER_OK`（它放弃跑完 ping，直接按 steer 指令回复），run 正常 `completed`。
- follow-up 的回执同样来自 agent：`status = "queued"`、`position = 1`，并返回队列条目 `itemId`。
- 本脚本把权限模式设为 `bypassPermissions`：它测的是转向，权限往返由 `scripts/e2e-mcode.mjs` 负责。

原始产物见 [mcode-steer-e2e.json](mcode-steer-e2e.json)。

## 自动化测试覆盖

- `test/unit/mcode-launch.test.ts`：启动入口解析（必须是 Node 入口而非 `.cmd` shim）、缺失入口报错、`extraArgs` 不得覆盖 supervisor 管理的参数、权限模式解析（默认 Ask）、会话句柄的读写与拒绝。
- `test/unit/mcode-acp-session.test.ts`：直接驱动真实 adapter 对上 `test/fixtures/stub-mcode-acp.ts`（**故意用数字反向 id**，与真实 agent 一致）。覆盖：supervisor 的请求 id 必须是 `hs-<n>` 字符串、agent 的反向请求不会被误当成答复、权限可按显示名或 optionId 回答、agent 撤回权限请求按 progress 报而不按错误报、steer 与 follow-up 的 agent 回执（`mode` / `turnId` / `status` / `itemId`）被如实记录、未建模的扩展请求也要回 `-32601`、权限模式被 agent 拒绝时报 `UNSUPPORTED`、同一 session 的第二个 turn 仍能结算。
- `test/integration/mcode.test.ts`：基于 `test/fixtures/fake-mcode.ts`（严格复刻真实线格式，含 id 回用要求与 `session/set_config_option`）覆盖：正常完成、会话句柄、resume、tool 事件、权限请求 → `awaiting_input` → 回答（允许与拒绝）、Ask 模式切换、取消、失败、steer、无扩展时报 `UNSUPPORTED`、runtime 列表、progress 事件。其中「id 不碰撞」用例是**真回归**：fake agent 在客户端用数字 id 时会故意复用那个数字发自己的权限请求，把实现退回数字 id 就会变红。

## 已知限制

- **steer / follow-up 依赖构建版本**：未声明 `mcode/session/steer` / `mcode/session/queue/enqueue` 扩展的 MiniMax Code 构建会明确返回 `UNSUPPORTED`，不会伪装成功。真实进程上两者都已单独验收：`queue/enqueue` 返回了排队回执（`status=queued`、`position=1`），steer 在**活跃 turn 内**被接受（`mode=steered`）且 agent 确实照做；turn 已结束时同样的 steer 会被拒（`Steering requires an admitted, active ACP prompt Turn`），因此 steer 的送达以 turn 是否仍然活着为前提。
- **权限模式是进程级的**：`session/set_config_option` 的 `permissionMode` 带 `_meta["minimax-code/scope"] = "process"`，即它作用于整个 MiniMax Code 进程，而不是单个会话；同一进程内的多个 worker 会共享该设置。
- **哪些命令会被拦不是读写之分**：即使在 Ask 模式下，`ls` 与 `echo x > f.txt` 都没有请求许可，而本轮末尾的 `Get-Content` / `Get-Item` 验证命令才触发许可。真实规则由 MiniMax Code 运行时的风险分类决定，HS 侧无法预先断言某个动作会被拦。**这一条的证据等级低于其他条目**：结论来自一次手工对比实验，那次实验的命令清单没有归档进本目录，归档的 E2E 只记录了触发许可的那一次。因此它是「已观察到的真实行为」，但目前**不是可从仓库复现的断言**。
- **会话不在逐会话文件里**：MiniMax Code 把对话存进自己的 SQLite，HS 因此在 worker 的 session 目录写一份 `mcode-session.json` 句柄（首行 `{type:"session",id}`）以满足 resume 契约并校验会话身份；句柄本身不含对话内容。
- **不是沙箱**：`cwd` 只是默认工作目录，mcode 子进程与 daemon 同用户、继承环境变量。

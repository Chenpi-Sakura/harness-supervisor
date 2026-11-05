# DSH ACP 真实验收（2026-11-05）

## 1. 环境

- Windows x64，Node 24.21.0。
- DeepSeek Harness 桌面端 `0.2.1-rc.5`，自带 CLI 路由到
  `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`。
- 通过 `dsh --profile acp` 启动；`initialize` 返回 ACP protocolVersion 1、
  `sessionCapabilities={close,list,resume}`、无 `session/load`。
- 模型：`deepseek-official/deepseek-v4-flash`，`thinking=low`。
- 使用桌面端正常 `~/.dsh` 登录态；HS 不读取、不记录凭据。

本目录只保存投影后的断言与截断预览，不包含完整原始对话、会话文件或凭据。

## 2. 运行方式

```bash
DSH_REAL=1 node scripts/e2e-dsh-acp.mjs
```

未设置 `HARNESS_SUPERVISOR_DSH_ENTRY` 时，适配器按 PATH → Windows 卸载注册表
→ 常见安装目录的顺序发现桌面端。本次验收记录到的入口：

```text
D:\Program Next\dsh\DeepSeek Harness.exe
  --expose-internals <app.asar>/.../dsh-desktop-host/lib/cli.js --profile acp
```

## 3. 结果

全部通过：

| 场景 | 结果 |
| --- | --- |
| spawn + prompt | `completed`，结果 `DSH_HS_E2E_OK` |
| 模型/推理配置 | `set_config_option` 应用 model 对与 `reasoning_effort=low`，无错误 |
| resume / `session/resume` | `completed`，能回忆上一轮 token `DSH_HS_E2E_OK`，session id 与句柄不变，`resumeCount=1` |
| 工作区内写入 | 创建 `dsh-acp-write-ok.txt`，内容 `DSH_WRITE_OK`；0 次 `run.needs_input` |
| 工作区外写入（原生默认 `workspace-write`） | 首次写入被沙箱拒绝并触发 1 次 `session/request_permission`（`allow-once` / `reject-once`）；经 `worker_answer` 允许后写入 `DSH_ESCALATION_OK` 成功 |
| 工作区外写入（`danger-full-access`） | 独立 daemon 以 `HARNESS_SUPERVISOR_DSH_PERMISSION_MODE=danger-full-access` 启动；同一场景无审批、0 次 `needs_input`，写入 `DSH_FULL_ACCESS_OK` 成功 |
| 取消 | `cancelled`，进程退出（`pidAlive=false`） |
| 非致命错误 | 各场景 `runErrors=0`、`fatalErrors=0` |

附带观察：

- `usage_update` 到达（上下文占用），HS 记录为 `context_usage` 进度；
  `run.usage=0`，不把上下文占用当作 Token 消耗。
- 桌面端 UI 的“仅可查看 / 工作区内修改 / 完全权限”是 desktop profile 的
  权限预设，不会自动传给 ACP。`acp` profile 在启动时读取
  `DSH_PERMISSION_MODE`，默认 `workspace-write` + approval `ask`；HS 的
  `HARNESS_SUPERVISOR_DSH_PERMISSION_MODE` 优先于继承值，并按 daemon 生效。
- `read-only` 目前只有映射与单元测试，没有在真实桌面端跑拒绝场景。

## 4. 已知限制

- 没有活动回合 `steer`；`session/prompt` 活动期间拒绝第二个 prompt，
  `steer` / `followUp` 为 `UNSUPPORTED`。
- 没有 `session/load`、fork、delete、transcript 回放；`session/resume` 要求
  相同的绝对 cwd。
- 权限请求只带 `toolCallId` 与 `allow-once` / `reject-once`，不含工具名或输入；
  HS 无法在审批时展示具体命令内容。
- 没有 plan、命令、终端、客户端文件系统、elicitation、图片或 MCP stdio。
- `tools` 白名单与 `extraArgs` 在 HS 侧明确拒绝，避免破坏纯 JSON-RPC stdout。
- DSH 的 ACP codec 将原生 `aborted` / `blocked` / `error` 回合映射为
  `end_turn`，HS 不能总是把这些情况与正常完成区分开；本证据只覆盖正常完成与
  取消，没有覆盖 aborted/blocked/error 的区分。
- `cwd` 不是文件系统沙箱。

## 5. 文件

- `result.json`：场景断言、入口、模型与限制。
- `permission-config.txt`：`--dump-config` 中与权限相关的配置节选，说明原生默认值。
- `events.jsonl`：投影后的 HS 事件（seq/type/kind/tool 等），不含完整对话。

# 0.6.1 Codex Desktop 双对话验收清单（由用户执行）

目标：验证两个独立 Codex Desktop 对话在**不手填 Thread ID** 时，各自 `worker_spawn` 自动绑定到自己的对话，通知不串线；并观察 Agent 是否在绑定成功后结束回合、不反复轮询。

本清单使用隔离的 0.6.1 MCP/daemon，不改生产 Daemon。请在 Windows PowerShell 中执行。

## 1. 构建并启动隔离 daemon

```powershell
cd D:\Projects\Harness-Supervisor
npx tsc -p tsconfig.json --outDir .smoke-061/dist

$env:HARNESS_SUPERVISOR_HOME = "$env:TEMP\hs-061-desktop"
node .smoke-061\dist\src\cli.js up
node .smoke-061\dist\src\cli.js info --json
```

`info` 应为 `version=0.6.1`，`stateDir` 指向 `%TEMP%\hs-061-desktop`。

## 2. 在 Codex 配置中增加隔离 MCP server

编辑 `C:\Users\Lenovo\.codex\config.toml`，追加：

```toml
[mcp_servers.harness_supervisor_061]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\Projects\Harness-Supervisor\.smoke-061\dist\src\mcp.js', '--mode', 'production']
cwd = 'D:\Projects\Harness-Supervisor'
env = { HARNESS_SUPERVISOR_HOME = 'C:\Users\Lenovo\AppData\Local\Temp\hs-061-desktop' }
startup_timeout_sec = 30
tool_timeout_sec = 150
default_tools_approval_mode = "approve"
```

重启 Codex Desktop（或重新加载 MCP），确保新 server 被加载。

## 3. 对话 A

新建/打开对话 A，发送：

```text
请调用 harness_supervisor_061 的 worker_spawn，不要传 notifyTarget。
cwd = C:\Users\Lenovo\AppData\Local\Temp\hs-061-A
prompt = "Wait 60 seconds, then create done.txt containing exactly HS_A_DONE. Modify nothing else."
调用后只把返回的 notificationBinding JSON 原样贴给我，然后结束本回合；
不要调用 worker_wait、worker_status 或 worker_events。
```

## 4. 对话 B

另开对话 B（与 A 并行），发送同样内容，但目录改为 `hs-061-B`，内容改为 `HS_B_DONE`。

## 5. 必须记录的检查项

在 A、B 各自对话中：

1. `notificationBinding.source` 必须是 `caller`，`wake` 必须是 `bound`，`warnings` 应为空。
2. A、B 的 `notificationBinding.target.codexThreadId` **必须不同**。
3. 在各自对话的 shell 工具里执行 `echo $env:CODEX_THREAD_ID`，其值应与该对话的 binding target 一致。
4. Spawn 后到通知到达前，不应出现反复的 `worker_wait` / `worker_status` / `worker_events`；只应有 `worker_spawn`。
5. 等 Worker 完成：A 对话应收到 A 的通知，B 对话收到 B 的；不得交叉。
6. 检查两个临时目录下的 `done.txt` 内容分别为 `HS_A_DONE` / `HS_B_DONE`。

## 6. 如果未自动绑定

如果 `source` 是 `daemon-default` 或出现 “predates caller auto-binding”：

- 记录该对话的 `notificationBinding` 与 `CODEX_THREAD_ID`；
- 不要反复 spawn 或轮询；把原始 JSON 和 Codex 版本反馈给我；
- 这说明当前 Desktop 没有传 `_meta.threadId` 或 MCP 进程未加载 0.6.1，需要先排查，不能宣称自动绑定通过。

## 7. 清理

```powershell
# 移除 config.toml 中的 harness_supervisor_061 块并重启 Codex
$env:HARNESS_SUPERVISOR_HOME = "$env:TEMP\hs-061-desktop"
node .smoke-061\dist\src\cli.js down
```

## 判据

- 通过：A/B 均 `source=caller`、target 各自正确且不同、通知不串线、Spawn 后无轮询。
- 未通过：任一 binding 缺失/错误、目标相同、需要手填 Thread ID、或通知串线。
- CLI 的 `codex exec` 证据只证明 MCP 协议与绑定逻辑；Desktop UI 结果以本清单为准。

## 8. 实际结果（2026-10-28）

**通过。**

- A：`source=caller`、`wake=bound`、target `01a164b6-bb26-74a3-bb57-bc6a2c48a8ac`，Worker `w-mvs0epcb-0e8a6d9b`。
- B：`source=caller`、`wake=bound`、target `01a164b6-e971-74c2-9e18-b0b298d2bf85`，Worker `w-mvs0ey86-c5fae774`。
- 两个 target 不同；A 先收到通知，B 后收到，未串线。
- 两条通知均被 Codex queue 接受且最终 `delivered`（`attempts=1`）。
- 两个 Worker 均 completed，`done.txt` 分别为 `HS_A_DONE` / `HS_B_DONE`。
- Spawn 后到通知前未观察到重复轮询；通知到达后各读取一次状态取结果。

完整记录：`desktop-two-conversation.md`。
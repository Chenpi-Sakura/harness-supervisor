# Codex Desktop 多线程 Persistent Worker 人工验收步骤

> 日期：2026-11-09（2026-11-10 更新执行状态）
>
> 状态：**Stage 1 与 Stage 2 已执行并通过（2026-11-10）；Stage 3 本轮未复验。** 验收使用真实 Codex Desktop Thread，未用 app-server / `codex exec` 冒充；结果见 [2026-11-09-hs-0.9-release-candidate.md](2026-11-09-hs-0.9-release-candidate.md) 第 6、16 节。
>
> 目标：验证 Codex Desktop 的 Master 回合结束之后，Worker 完成事件能通过 `codex queue` 自动唤醒原 Thread；并在唤醒后验证 Persistent Worker 的隔离、连续 Turn 与输入请求。

## 0. 分阶段执行，先完成最小验收

| 阶段 | 内容 | 是否必做 | 预计 |
| --- | --- | --- | --- |
| Stage 1 | 两个 Thread 各 spawn 一名 persistent Pi Worker；初始回合立即结束；验证两个 Thread 自动唤醒、通知隔离，再用 `worker_continue` 验证同一 Worker / Session | 必做 | 约 10 分钟 |
| Stage 2 | DSH persistent Worker 的 `needs_input` 主动唤醒 → `worker_answer` → 完成唤醒 → `worker_continue` | 必做 | 约 5 分钟 |
| Stage 3 | Thread 切换 / 卸载 / 完整退出 | 选做，Stage 1-2 通过后另约 | 约 10 分钟 |

Stage 1 未通过时停止，不执行 Stage 2/3。一次只做一个阶段，避免把多种宿主行为混在同一次观察里。

## 1. 安全隔离（全程有效）

- 不升级、不停止、不修改生产 Daemon（`C:\Users\Lenovo\.harness-supervisor`）。
- 不使用生产状态目录；验收只使用 `D:/tmp/hs-09-rc-state`。
- 不删除任何 Native Session；不自动清理用户数据。
- 临时修改的 Codex MCP 配置在验收结束后恢复。
- `D:/tmp/hs-09-rc-state` 保留到维护者审计完成，删除需用户明确同意。

## 2. 准备

### 2.1 启动独立 RC Daemon

终端 1 保持打开：

```powershell
$env:HARNESS_SUPERVISOR_HOME = 'D:/tmp/hs-09-rc-state'
node D:/Projects/Harness-Supervisor/dist/src/daemon-entry.js --state-dir D:/tmp/hs-09-rc-state
```

准备目录：

```powershell
mkdir D:/tmp/hs-09-rc-work-a
mkdir D:/tmp/hs-09-rc-work-b
mkdir D:/tmp/hs-09-rc-work-c
mkdir D:/tmp/hs-09-rc-audit
```

在终端 1 确认 Codex CLI 可用（通知投递通过 `codex queue`）：

```powershell
codex --version
```

若命令不存在，Daemon 的通知会停在 `failed`，本次验收无法判断唤醒；先修正 PATH 再开始。

### 2.2 临时指向 RC Daemon

编辑 `C:\Users\Lenovo\.codex\config.toml`，只在 `[mcp_servers.harness_supervisor].env` 中增加 `HARNESS_SUPERVISOR_HOME`：

```toml
env = { HARNESS_SUPERVISOR_HOME = 'D:/tmp/hs-09-rc-state', HARNESS_SUPERVISOR_MCODE_ENTRY = 'C:/Users/Lenovo/.minimax-code/releases/0.6.12/node_modules/@minimax-ai/code/cli.js', HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE = 'bypassPermissions' }
```

**完全退出 Codex Desktop 并重新启动**（关闭窗口不算退出）。在一个新 Thread 中只做预检查：

> 调用 supervisor_info，只报告 stateDir、version 和 codexSteer.status。不要启动 Worker。

期望 `stateDir` 为 `D:\tmp\hs-09-rc-state`，`version` 为 `0.9.0`（本文档最初验收使用 `0.8.0` 构建；发布版本仅版本号变更）。若 stateDir 仍是生产目录，停止测试。

### 2.3 独立 PowerShell 监控窗口

新开终端 2，粘贴以下脚本并保持运行：

```powershell
$env:HARNESS_SUPERVISOR_HOME = 'D:/tmp/hs-09-rc-state'
$cli = 'D:/Projects/Harness-Supervisor/dist/src/cli.js'
Write-Host "monitor state=$env:HARNESS_SUPERVISOR_HOME  (Ctrl+C to stop)"
while ($true) {
  $ts = Get-Date -Format 'HH:mm:ss'
  $workers = @(node $cli list --json 2>$null | ConvertFrom-Json)
  $inbox = node $cli inbox --state all --json 2>$null | ConvertFrom-Json
  $w = if ($workers.Count -gt 0) {
    ($workers | ForEach-Object { "$($_.id)=$($_.status)/$($_.lifecycle)" }) -join '  '
  } else { '(none)' }
  $n = if ($inbox.notifications.Count -gt 0) {
    ($inbox.notifications | ForEach-Object {
      "$($_.id) state=$($_.delivery.state) created=$($_.createdAt) queued=$($_.delivery.enqueuedAt) thread=$($_.target.codexThreadId)"
    }) -join '  '
  } else { '(none)' }
  Write-Host "[$ts] workers: $w"
  Write-Host "[$ts] inbox:   $n"
  Start-Sleep -Seconds 3
}
```

监控窗口只读调用 CLI，不占用 Master 回合。不要用 Codex Thread 里的 `worker_wait` 代替它。

## 3. 主动唤醒的四阶段判定

| 阶段 | 名称 | 证据 | 能证明什么 |
| --- | --- | --- | --- |
| S1 | queue accepted | `daemon.log` 的 `Notification accepted by Codex queue`；`messageId`、`enqueuedAt` | `codex queue` CLI 接受了消息 |
| S2 | delivered | inbox `delivery.state="delivered"`、`delivery.enqueuedAt` 非空 | HS 已把投递记录写为 delivered；仍只表示队列接受 |
| S3 | Thread 被唤醒 | Codex Desktop 中该 Thread **在用户没有输入的情况下自动出现新回合** | 宿主消费了队列并启动回合 |
| S4 | 模型实际消费 | 新回合调用 `worker_status` / `worker_events`，说出正确的 Worker 结果，并在处理后 ACK（inbox 出现 `ackAt`） | 模型真正读到了通知并处理了对应 Worker |

关键约束：

- HS 的 `delivery.state="delivered"` 是 S2，不是 S3。不得用 delivered 声称 Thread 已唤醒。
- `ackAt` 是 S4 的辅助证据；ACK 不代表唤醒本身，但能证明 Master 处理了这条通知。
- 新回合自动出现之前，用户不得在 Thread 中输入任何内容。若用户输入后才出现回合，只能记为“人工触发”，不能算 S3 通过。
- 记录每次 S2 的 `enqueuedAt` 和 S3 的本地时间；两者无法比较到毫秒时，至少记录到秒。
- S1 的原始记录在终端 1 的 Daemon 输出和 `D:/tmp/hs-09-rc-state/daemon.log`；搜索 `Notification accepted by Codex queue`。

## 4. Stage 1：双 Thread 主动唤醒 + 连续协作

### 4.1 Thread 1：只 spawn，立即结束回合

在 Thread 1 粘贴：

> 只调用一次 `worker_spawn`。调用后立即结束本回合，不要调用 `worker_wait`、`worker_status`、`worker_events`，不要 sleep，不要轮询。参数：persistence="persistent"，cwd="D:\\tmp\\hs-09-rc-work-a"，prompt="请使用 shell 执行 sleep 30，然后只回复 RC_A_TURN1_OK。不要读取或修改其他目录。"。只报告：workerId、lastSeq、notificationBinding.source、notificationBinding.target.codexThreadId、notificationBinding.wake。

检查回复：

- 必须包含 `workerId`、`lastSeq`、`target.codexThreadId`。
- `notificationBinding.source` 必须是 `caller`，`wake` 必须是 `bound`。若为 `daemon-default` / `unbound`，本 Thread 没有自动绑定，停止测试并记录失败。
- 回复后 Turn 必须结束。若 Master 仍在运行、调用了 wait/status/events、或主动 sleep，本次时序无效，重新开始。

说明：prompt 里的 `sleep 30` 是 Worker 的任务内容，用于把完成时间推到 Master 回合结束之后；Master 自身不得 sleep。

### 4.2 Thread 2：同样只 spawn

在 Thread 2 粘贴：

> 只调用一次 `worker_spawn`。调用后立即结束本回合，不要调用 `worker_wait`、`worker_status`、`worker_events`，不要 sleep，不要轮询。参数：persistence="persistent"，cwd="D:\\tmp\\hs-09-rc-work-b"，prompt="请使用 shell 执行 sleep 30，然后只回复 RC_B_TURN1_OK。不要读取或修改其他目录。"。只报告：workerId、lastSeq、notificationBinding.source、notificationBinding.target.codexThreadId、notificationBinding.wake。

两个 Thread 的 spawn 尽量在相近时间发出。两个初始回合都必须结束；不要在 Thread 1/2 中继续发消息。

### 4.3 等待自动唤醒（不轮询 Master）

观察终端 2：

- 两名 Worker 从 `starting/running` 变为 `completed/idle`。
- inbox 出现两条通知，`target.codexThreadId` 分别等于两个 Thread 的绑定 ID。
- 每条通知的 `delivery.state` 变为 `delivered`，并记录 `enqueuedAt`。
- **记录两个初始回合结束的本地时间 `T_spawn_end`**。只有当 `enqueuedAt > T_spawn_end` 时，S3 才能证明“回合结束后唤醒”；若通知早于回合结束，本次时序无效，把 Worker 的 `sleep 30` 改为 `sleep 60` 后重试。
- 每个 Thread 在用户没有输入的情况下自动出现新回合（S3）。

若 60 秒内某个 Thread 没有自动新回合：

- 记录“未自动唤醒”，不要用输入消息制造新回合。
- 检查该 Thread 是否仍加载、Desktop 是否在后台睡眠、queue 是否被宿主消费。
- Stage 1 判定为未通过，停止后续步骤。

### 4.4 在自动新回合中读取结果并 ACK

Thread 自动新回合出现后，先不要输入，观察它是否自行调用 `worker_status`。若它已经自行读取结果并 ACK，直接记录 S4 通过；若它没有读取结果就结束了，再发送下面的补问，并记录为“S3 自动唤醒，S4 人工补问”：

> 这个回合由通知自动启动。请调用 `worker_status`（workerId 用通知里的 id），报告 status、lifecycle、result.text、session.sessionId、resumeCount；然后调用 `supervisor_notifications` 找到这条通知并调用 `supervisor_notifications_ack` 确认。不要启动新的 Worker。

期望：

- Thread 1 的结果是 `RC_A_TURN1_OK`，Thread 2 的结果是 `RC_B_TURN1_OK`。
- 每个 Thread 只处理自己的 workerId 和通知 ID；不出现对方 Worker 的结果。
- 两条通知都出现 `ackAt`。

### 4.5 用 `worker_continue` 验证同一 Worker / Session

在 Thread 1 粘贴：

> 只调用一次 `worker_continue`，workerId 用刚才的 id，prompt="只回复 RC_A_TURN2_OK，并说出你上一轮回复的原文。不要读取或修改其他目录。"。调用后立即结束本回合，不要调用 worker_wait/status/events，不要 sleep。只报告 lastSeq 和 notificationBinding.wake。

再次等待该 Thread 自动新回合（S3），然后在该回合中读取：

> 调用 `worker_status` 和 `worker_events`，报告 status、lifecycle、result.text、session.sessionId、resumeCount、lastSeq；ACK 本 Worker 的通知。

同样记录 continue 回合结束时间 `T_continue_end`；新的 completion 通知 `enqueuedAt` 必须晚于它，才能证明第二轮也是回合结束后唤醒。

期望：

- 结果包含 `RC_A_TURN2_OK` 与 `RC_A_TURN1_OK`。
- `workerId` 与 `session.sessionId` 与第一轮一致，`resumeCount` 增加。
- `notificationBinding.source` 为 `preserved`，`target.codexThreadId` 不变，`wake=bound`。
- 新通知只到 Thread 1，Thread 2 没有收到。

最小验收只要求 Thread 1 做这一轮 continue。若需要验证两个 Thread 的每轮唤醒，可让 Thread 2 用同样的方式再执行一次 `worker_continue`，但不要在同一时刻并行执行两个额外 Turn，以免混淆通知时间。

可选的三轮上下文扩展：在 Thread 1 再执行两轮 `worker_continue`，分别引入口令 `UI-NONCE-A-7F3K` 与 `UI-NONCE-B-9Q2M`，最后要求不重发口令并回忆两者。该扩展用于 Desktop 场景的上下文连续性，不纳入最小验收；四 Runtime 的真实 3 轮上下文验证已由 `evidence/persistent-worker-261109/` 覆盖。

### 4.6 Stage 1 通过条件

| 检查 | 通过条件 |
| --- | --- |
| spawn 回合 | 两个 Thread 都只调用一次 `worker_spawn`，随后回合结束；没有 wait/status/events/sleep |
| 绑定 | 两个绑定均为 `source=caller`、`wake=bound`，thread ID 不同 |
| 自动唤醒 | 两个 Thread 都在无用户输入的情况下自动出现新回合；两轮通知的 `enqueuedAt` 都晚于对应回合的结束时间 |
| 隔离 | 每条通知只到自己的 Thread；每个 Thread 的结果只含自己的 token |
| 重复启动 | 只有两个 persistent Worker，没有重复 spawn |
| 连续协作 | Thread 1 的 `worker_continue` 使用同一 workerId 与 sessionId，且再次自动唤醒 |
| ACK | 每条已处理通知有 `ackAt`，同一 `workerId#seq` 只有一条记录 |

## 5. Stage 2：needs_input 主动唤醒

Pi 的真实输入请求需要扩展触发；本阶段使用 DSH 的 ACP 权限询问（默认 `workspace-write` + `ask`）。重点是 needs_input 在 Master 回合结束之后到达并自动唤醒；初始回合内不得用 `worker_wait` 等待它。

### 5.1 建立 DSH persistent Worker（只 spawn）

在 Thread 1（或一个新 Thread）粘贴：

> 只调用一次 `worker_spawn`。调用后立即结束本回合，不要调用 worker_wait/status/events，不要 sleep 或轮询。参数：runtime="dsh"，persistence="persistent"，cwd="D:\\tmp\\hs-09-rc-work-c"，prompt="请在工作区内创建 rc-dsh-seed.txt，内容为 RC_DSH_SEED，然后只回复 RC_DSH_SEED_OK。不要读写工作区之外的路径。"。只报告 workerId、lastSeq、notificationBinding.source、target.codexThreadId、wake。

记录绑定；等待自动新回合：结果应为 `RC_DSH_SEED_OK`，在同一回合读取 `worker_status` 并 ACK。

若 DSH 启动时报找不到 CLI，在终端 1 重启 RC Daemon 前设置 `HARNESS_SUPERVISOR_DSH_ENTRY` 指向桌面端的 `resources/runtime/cli/bin/dsh.cmd`。

### 5.2 发出会触发权限询问的 `worker_continue`（只 continue）

在同一 Thread 粘贴：

> 只调用一次 `worker_continue`，workerId 用刚才的 id，prompt="先读取工作区内的 rc-dsh-seed.txt，把内容作为中间结果保留；然后尝试创建 C:\\Users\\Lenovo\\hs-09-rc-outside.txt，内容为 RC_DSH_OK。该路径在工作区之外，如果出现权限请求，请保持等待，不要绕过；写入成功后只回复 RC_DSH_OK。"。调用后立即结束本回合，不要调用 worker_wait/status/events，不要 sleep。只报告 lastSeq 和 notificationBinding.wake。

这里先让 Worker 做一次工作区内的允许操作，再触发工作区外写入，目的是把 `needs_input` 推到 Master 回合结束之后。

### 5.3 判断 needs_input 是否发生在回合结束后

从终端 2 记录：

- continue 回合结束的本地时间 `T_end`。
- needs_input 通知的 `createdAt`、`delivery.enqueuedAt`（`T_queue`）。
- 该 Thread 自动出现新回合的时间（`T_wake`）。

判定：

| 情况 | 处理 |
| --- | --- |
| `T_queue > T_end` 且 Thread 自动出现新回合 | 有效：needs_input 在回合结束后唤醒 |
| `T_queue <= T_end` | 回合内到达：本次不证明 needs_input 的主动唤醒；记录实际行为，可重试一次 |
| 没有自动新回合 | 记为宿主未唤醒或 Thread 未加载；不得用输入消息制造回合后声称通过 |

重试时在 continue prompt 中增加一个允许的工作区步骤（例如先创建并读回 `rc-dsh-marker.txt`），把权限询问进一步推后。重试仍无法区分时，如实记录“needs_input 主动唤醒未验证”；Stage 1 的 completed 唤醒仍然独立有效。

### 5.4 在自动新回合中回答，并由 completed 通知再次唤醒

自动新回合出现后，在该回合粘贴：

> 这个回合由 needs_input 通知自动启动。请调用 `worker_status`，读取 pendingInput.requestId、method、title 和可选选项；然后调用 `worker_answer`（workerId 用同一个 id，requestId 用该值，confirmed=true），报告回答是否被接受。不要启动新的 Worker。

期望：

- `worker_answer` 被同一 Worker 接受。
- Worker 继续执行并完成，产生一条 `completed` 通知。
- 该 Thread 再次自动出现新回合；在新回合中读取结果、session 和通知并 ACK。
- 结果包含 `RC_DSH_OK` 或明确显示外部文件写入成功。

### 5.5 再次 `worker_continue` 验证连续协作

在完成后的 Thread 中粘贴：

> 只调用一次 `worker_continue`，workerId 用同一个 id，prompt="读取 C:\\Users\\Lenovo\\hs-09-rc-outside.txt 并只回复文件内容。"。调用后立即结束本回合，不要调用 wait/status/events，不要 sleep。

等待自动新回合；读取 `worker_status`，确认结果、同一 `session.sessionId`、`resumeCount`，并 ACK。测试结束后可删除 `C:\Users\Lenovo\hs-09-rc-outside.txt`（这是本轮验收创建的文件）。

### 5.6 Stage 2 通过条件

| 检查 | 通过条件 |
| --- | --- |
| needs_input 时序 | `T_queue > T_end`，并在无用户输入时自动出现新回合 |
| 回答 | `worker_answer` 使用通知中的 requestId，同一 Worker 接受并继续 |
| 完成唤醒 | answer 之后产生 completed 通知，Thread 再次自动唤醒 |
| 连续协作 | 后续 `worker_continue` 使用同一 workerId/sessionId |
| 通知隔离 | needs_input 与 completed 通知只到该 Thread，ACK 后不再重复投递 |

## 6. Stage 3（选做）：Thread 切换、卸载与完整退出

仅在 Stage 1-2 通过后另约时间执行。每一步都遵循“只 continue、立即结束回合、独立监控”，不要在 Thread 里 wait。

### D1：Thread 切换

> 只调用一次 `worker_continue`，prompt="先执行 sleep 20，然后只回复 D1_SWITCH_OK。"，调用后立即结束本回合，不要 wait。

启动后切换到 Thread 2，等待约 10 秒再切回 Thread 1。记录：完成通知是否在 Thread 1 自动出现并开启新回合；Thread 2 是否收到无关通知。

### D2：Thread 卸载

在一个新 Thread 中只 spawn 一名 persistent Worker（prompt 要求 `sleep 20` 后回复 `D2_UNLOAD_OK`），立即结束回合。按宿主实际能力卸载该 Thread（关闭标签或归档），等待约 30 秒后重新打开。记录：通知是否滞留、重新打开后是否自动出现新回合或只补一条消息、Worker 状态是否仍正确。

### D3：完整退出 Codex Desktop

在 Thread 1 中只 `worker_continue` 一个约 30 秒的 Turn（回复 `D3_EXIT_OK`），立即结束回合，然后**完全退出 Codex Desktop**。等待 40 秒后重新启动 Desktop 并打开 Thread 1。记录：Worker 是否在应用退出期间完成；重新打开后通知行为。终端 2 可用于确认 Worker 状态。

## 7. 维护者审计

用户告知某一阶段完成后，维护者只读检查 RC 状态目录：

```powershell
$env:HARNESS_SUPERVISOR_HOME = 'D:/tmp/hs-09-rc-state'
$cli = 'D:/Projects/Harness-Supervisor/dist/src/cli.js'
node $cli info --json
node $cli list --json
node $cli inbox --state all --json
node $cli status <workerId> --json
node $cli events <workerId> --full --json
```

阶段判定：

| 检查 | 通过条件 |
| --- | --- |
| Worker 数量 | Stage 1 只有 2 个 persistent Pi Worker；Stage 2 增加 1 个 DSH Worker；无重复 spawn |
| 绑定 | 每个 Worker 的 `notificationBinding.source=caller`、`wake=bound`；thread ID 与所属 Thread 一致 |
| 通知 | 每个终态/输入事件恰好一条 `workerId#seq`；`target.codexThreadId` 正确；无跨 Thread 记录 |
| 阶段时间 | S2 `enqueuedAt` 早于 S3 自动新回合；`ackAt` 晚于 S4 处理 |
| 连续协作 | 同一 Worker 的 `session.sessionId` 不变，`resumeCount` 递增 |
| 未唤醒 | 未加载的 Thread 允许滞留；记录实际行为，不声称已唤醒 |

## 8. 收尾

1. 从 `C:\Users\Lenovo\.codex\config.toml` 移除 `HARNESS_SUPERVISOR_HOME = 'D:/tmp/hs-09-rc-state'`，恢复原 env。
2. 完全退出并重启 Codex Desktop。
3. 停止 RC Daemon（`node D:/Projects/Harness-Supervisor/dist/src/cli.js --state-dir D:/tmp/hs-09-rc-state down`）。
4. 保留 `D:/tmp/hs-09-rc-state` 供维护者审计；删除 `D:/tmp/hs-09-rc-outside.txt` 与临时工作目录需用户明确同意。
5. 生产 Daemon 与生产状态目录全程未改动；未删除任何 Native Session。

## 9. 本次修订说明

| 原步骤 | 新步骤 | 修改原因 |
| --- | --- | --- |
| Test A 在 `worker_spawn` 后调用 `worker_wait` | 只调用 `worker_spawn`，拿到 workerId 后立即结束回合 | `worker_wait` 会让 Master 回合一直运行，Worker 完成时无法验证“回合结束后自动唤醒” |
| Test A 第二轮 `worker_continue` 后等待完成 | `worker_continue` 后立即结束回合，等待自动新回合 | 每一轮都验证主动唤醒，同时验证同一 Worker / Session |
| 仅在 Thread 内观察 | 新增独立 PowerShell 监控 `list` / `inbox` / delivery 时间 | 监控不占用 Master 回合，可记录 S1/S2 的准确时间 |
| 把通知 delivered 当作唤醒 | 拆成 S1 queue accepted、S2 delivered、S3 Thread 唤醒、S4 模型消费 | `delivery.state=delivered` 只表示 `codex queue` 接受，不证明宿主已唤醒或模型已读取 |
| Test C 用 `worker_wait` 等 `needs_input` | spawn/continue 后结束回合，用时间戳区分回合内/回合后 | 避免用持续 wait 冒充主动唤醒；回合内到达的 needs_input 单独标记 |
| 唤醒后直接继续 | 在自动新回合中 `worker_status` / `worker_events` / ACK | 证明模型实际消费了通知并读取了正确 Worker 的结果 |
| 一次性执行 A-D | 拆成 Stage 1 / Stage 2 / Stage 3 | 优先完成双 Thread 主动唤醒与连续协作，避免一次执行过多测试 |
| 只写“安全隔离” | 明确不删 Native Session、不自动清理、验收后保留状态目录供审计 | 保持原有安全边界，并避免验收数据被误删 |

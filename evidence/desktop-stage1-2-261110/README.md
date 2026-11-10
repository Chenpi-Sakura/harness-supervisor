# Codex Desktop Stage 1/2 验收证据（2026-11-10）

- 环境：Windows 10.0.26300 x64，Node v24.22.1，真实 Codex Desktop Thread
- RC 状态目录：`D:/tmp/hs-09-rc-state`，验收时 Daemon 版本 `0.8.0`（发布版本 `0.9.0`，仅版本号变更）
- 生产 Daemon：`C:\Users\Lenovo\.harness-supervisor`（PID 55532），未升级、未停止、未修改
- 方法：真实 Codex Desktop Thread；未使用 app-server / `codex exec` 冒充桌面端
- 范围：Stage 1 / Stage 2 通过；Stage 3（Thread 切换、卸载、完整退出）本轮未复验

## 1. Worker / Session / Thread

| Worker | Runtime | Session | Thread | 结果 | resumeCount |
| --- | --- | --- | --- | --- | --- |
| `w-mwa3rjdb-f41352ff` | Pi | `01a1c366-67c4-7534-ab53-ceccb5be800a` | `01a164b6-bb26-74a3-bb57-bc6a2c48a8ac` | `RC_A_TURN1_OK` → `RC_A_TURN2_OK` + 上一轮原文 | 1 |
| `w-mwa3rhn7-0df92d2b` | Pi | `01a1c366-5f98-7096-9331-6cda720590a1` | `01a164b6-e971-74c2-9e18-b0b298d2bf85` | `RC_B_TURN1_OK` | 0 |
| `w-mwa471ig-726771ea` | DSH | `e18bbf4d-71e1-4944-b5a9-9f85e8ff2f2e` | `01a1c371-2117-7e81-912c-0b62f7addcf5` | `RC_DSH_SEED_OK` → Reject 路径 → `RC_DSH_TURN3_OK` + `RC_DSH_MARKER` | 2 |

DSH 的 `dsh-session.json` 在最终 Turn 后仍指向同一 session；外部文件 `C:\Users\Lenovo\hs-09-rc-outside.txt` 实际存在且内容为 `RC_DSH_OK`（验证后已按用户要求删除）。

## 2. 通知记录

| 通知 | 类型 | created | enqueued | acked | target thread |
| --- | --- | --- | --- | --- | --- |
| `w-mwa3rhn7-0df92d2b#12` | completed | 03:01:12.507Z | 03:01:14.818Z | 03:06:03.762Z | `01a164b6-e971-74c2-9e18-b0b298d2bf85` |
| `w-mwa3rjdb-f41352ff#12` | completed | 03:01:15.419Z | 03:01:17.823Z | 03:06:08.713Z | `01a164b6-bb26-74a3-bb57-bc6a2c48a8ac` |
| `w-mwa3rjdb-f41352ff#24` | completed | 03:08:59.675Z | 03:09:01.950Z | 03:11:51.566Z | `01a164b6-bb26-74a3-bb57-bc6a2c48a8ac` |
| `w-mwa471ig-726771ea#12` | completed | 03:12:40.178Z | 03:12:42.588Z | 03:13:54.037Z | `01a1c371-2117-7e81-912c-0b62f7addcf5` |
| `w-mwa471ig-726771ea#31` | needs_input | 03:14:28.730Z | 03:14:31.046Z | 03:18:14.079Z | `01a1c371-2117-7e81-912c-0b62f7addcf5` |
| `w-mwa471ig-726771ea#37` | completed | 03:14:47.331Z | 03:14:49.376Z | 03:18:14.079Z | `01a1c371-2117-7e81-912c-0b62f7addcf5` |
| `w-mwa471ig-726771ea#56` | needs_input | 03:18:51.299Z | 03:18:53.674Z | 03:25:46.152Z | `01a1c371-2117-7e81-912c-0b62f7addcf5` |
| `w-mwa471ig-726771ea#62` | completed | 03:23:49.400Z | 03:23:52.094Z | 03:25:46.152Z | `01a1c371-2117-7e81-912c-0b62f7addcf5` |

8 条通知均为 `attempts=1`、`delivery.state=delivered`，`workerId#seq` 唯一；`daemon.log` 中有对应的 `Notification accepted by Codex queue` 与 `messageId`。

## 3. 四阶段判定

| 阶段 | 证据 |
| --- | --- |
| S1 queue accepted | `daemon.log` 的 8 条 `Notification accepted by Codex queue`，含 `messageId`、`enqueuedAt` |
| S2 delivered | `inbox` 8 条全部 `delivered`；这只表示队列接受，不表示宿主已唤醒 |
| S3 Thread 被唤醒 | Stage 1 两个 Thread、Stage 1 continue 的 `#24`、Stage 2 的 `#31/#56/#62` 均在无用户输入时自动出现新回合 |
| S4 模型实际消费 | 自动回合调用 `worker_status` / `worker_events`，报告正确结果，并在 ACK 后出现 `ackAt` |

关键时间线：

| 事件 | 时间（UTC） | 说明 |
| --- | --- | --- |
| Stage 2 continue 回合结束 | 约 03:14:14 | Master 回合结束 |
| `needs_input` `#31` | 03:14:28.730 / enqueued 03:14:31.046 | 回合后到达，自动唤醒 |
| Reject 回答 | 03:14:43.708 | 首次路径选择 Reject |
| completed `#37` | 03:14:47.331 / enqueued 03:14:49.376 | 再次自动唤醒 |
| Allow 重试 continue 开始 | 03:18:40.161 | 回合开始后立即结束 |
| `needs_input` `#56` | 03:18:51.299 / enqueued 03:18:53.674 | 回合后到达，自动唤醒 |
| 成功回答 Allow once | 03:23:47.337 | `run.input_answered` outcome=`value` |
| 外部写入成功 | 03:23:47.360 | `tool_end` `isError=false` |
| completed `#62` | 03:23:49.400 / enqueued 03:23:52.094 | 结果 `RC_DSH_TURN3_OK` + `RC_DSH_MARKER` |
| `#56/#62` ACK | 03:25:46.152 | 全部通知已确认 |

## 4. 说明与边界

- 初始回合与 continue 回合都只调用一次 `worker_spawn` / `worker_continue` 后立即结束，没有 `worker_wait`、`worker_status`、`worker_events`、sleep 或轮询。
- Stage 2 第一次 needs_input 由 Master 选择 Reject，验证了 answer → 同一 Worker 继续 → completed → 再次唤醒，但没有验证允许写入；随后显式使用 `value="Allow once"` 重试，外部文件真实创建并写入 `RC_DSH_OK`。
- 第一次 Allow 重试时，Master 同时传了 `value` 和 `confirmed`，`worker_answer` 按 Schema 返回 `Provide exactly one of value, confirmed, or cancelled=true`；这是预期的参数校验，不是 HS 状态错误。改为只传 `value="Allow once"` 后成功。
- Stage 3 的 Thread 切换 / 卸载 / 完整退出本轮没有新增证据；按既往验证结论不阻塞，但不把本轮 Stage 1/2 的结果扩展为 Stage 3 已通过。

## 5. 证据来源与收尾

本次验收的原始状态保存在 `D:/tmp/hs-09-rc-state`，可用只读 CLI 复核：

```bash
HARNESS_SUPERVISOR_HOME=D:/tmp/hs-09-rc-state node dist/src/cli.js list --json
HARNESS_SUPERVISOR_HOME=D:/tmp/hs-09-rc-state node dist/src/cli.js inbox --state all --json
HARNESS_SUPERVISOR_HOME=D:/tmp/hs-09-rc-state node dist/src/cli.js status w-mwa471ig-726771ea --json
HARNESS_SUPERVISOR_HOME=D:/tmp/hs-09-rc-state node dist/src/cli.js events w-mwa471ig-726771ea --full --json
```

- Codex 配置已恢复，`harness_supervisor.env` 中不再包含 `HARNESS_SUPERVISOR_HOME`。
- RC Daemon 已停止：首次 `down` 后曾被独立监控窗口拉起（PID 8616），再次 `down` 后确认其退出、`daemon.lock` 移除，等待 6 秒未再拉起。
- 生产 Daemon PID 55532 仍运行；生产状态目录未修改；未删除任何 Native Session。
- 外部测试文件 `C:\Users\Lenovo\hs-09-rc-outside.txt` 已按用户要求删除（2026-11-10），并确认文件不存在。
- 本证据不包含原始 Native Session 内容、凭据或生产数据。

# Codex 桌面端 A 级唤醒验收（一次真实 GUI 测试）

- 时间：2026-10-22 19:47–19:55（UTC+8；UTC 11:47–11:55）
- 环境：Windows 11、`codex-cli 0.161.0`、Codex 桌面（会话内模型显示 GPT-6 Luna）、HS `feat-261022-async-notify` @ `3d28ce7`
- 隔离：独立临时状态目录（`%TEMP%\hs-e2e-wake-1022`）与独立工作目录（`%TEMP%\hs-e2e-work`）；daemon 在 Codex 之外预启动；临时的 MCP 入口命名为 `hs_e2e`，不影响原有 `harness_supervisor` 配置
- 性质：**用户真实桌面会话** + 真实 Pi Worker。这是对 `evidence/codex-wake-e2e/`（B 级、app-server 会话）缺失环节的补充

## 要验证的问题

`codex queue` 的机制已知依赖"thread 被某个 app-server 客户端加载"。本实验要回答：**用户桌面上的 Codex 会话，在回合结束之后是否仍保持该 thread 加载，从而在队列被写入时自动开始新回合？**

## 流程

1. 构建并外部预启动 HS daemon（`--state-dir` 指向临时目录），确认 `info` 正常。
2. 在 `~/.codex/config.toml` 临时新增 `[mcp_servers.hs_e2e]`（`node dist/src/mcp.js --state-dir <临时目录>`），新开桌面会话，`/mcp` 确认工具可见。
3. 从 `~/.codex/sessions/.../rollout-*.jsonl` 的 `session_meta.payload.id` 取得当前会话 thread id（`01a16370-4dd1-7200-8e00-0219a0d15735`）。
4. `notify-target --channel codex-queue --thread <id>`，确认 target 已持久化。
5. 在桌面会话中要求 agent：调用 `worker_spawn` 启动一个"sleep 120s 后写 `wake-proof.txt`"的 Pi Worker，**启动后立即结束回合，不调用任何轮询工具**。
6. 回合结束后不触碰窗口，观察通知投递与桌面行为。

## 观测结果

| 观测点 | 时间（UTC） |
| --- | --- |
| daemon 启动（pid 44056） | 11:42:56.412 |
| 桌面会话创建（thread `01a16370…`） | 11:47:49 |
| 注册唤醒目标（`codex-queue`） | 11:49:13.475 |
| 第一回合结束（界面显示用时 20 秒，未等待 Worker） | 约 11:49:5x |
| Worker 完成：`run.completed`（seq 17） | 11:52:09.971 |
| `codex queue` 投递成功（attempts=1） | 11:52:10.951 |
| **桌面自动开始新回合**并读取 Worker 结果 | 投递后数秒内（见截图） |

- 通知：`w-mvjhawr9-686b5f0f#17`，`delivery.state=delivered`，`messageId=01a16374-554f-7aa1-81e1-4e4870668685`；收件箱计数 `pending=0 / delivered=1 / failed=0 / unacked=1`。
- 桌面行为：同一 thread 中出现 `[harness-supervisor] … completed at 2026-10-22T11:52:09.971Z (seq 17) …` 的输入，随后**助手自行作答**并调用工具读取结果，用户没有发送任何新消息。
- Ground truth：`wake-proof.txt` 内容为 `PI_WAKE_OK`（11 字节），与 Worker 自述一致（文件在删除前用 `Get-Content` 核对）。

## 结论

- **A 级：成立（单次）**。桌面 Codex 在回合结束后保持 thread 加载；HS 通过官方 `codex queue` 投递后，宿主自行 drain 队列并开始新回合，无需用户输入，也无需 HS 注入 UI 或修改会话数据库。
- **仍受宿主条件约束**：若 thread 未被加载（窗口关闭、切换会话、app-server 退出），消息只留在队列中（见 `evidence/codex-wake-probe/` E1）。因此这是"条件满足时可靠"，不是无条件推送。
- **`delivered` 不等于唤醒**：本实验用"同一 thread 出现新回合"而非 `delivery.state` 作为判定依据。

## 局限

- 只成功验收一次，没有重复运行；未测并发通知、桌面忙碌/离线、超长摘要。
- 未精确测量"投递 → 新回合开始"的延迟（截图仅能确定秒级先后顺序）。
- 桌面端版本、会话加载策略、审批策略变化都可能改变行为；复验时以本目录步骤为准。
- 本目录中的 `inbox.json` 与 `daemon-log-excerpt.txt` 是终端输出的转录（原始状态目录已按用户要求删除）；`desktop-wake.png` 是未修改的原始截图。

## 文件

| 文件 | 内容 |
| --- | --- |
| `desktop-wake.png` | 原始桌面截图：同一 thread 收到通知并自动开新回合 |
| `summary.json` | 时间线、环境、通知记录、Ground truth、局限（机器可读） |
| `inbox.json` | `inbox --state all --limit 20 --json` 输出转录 |
| `daemon-log-excerpt.txt` | daemon 启动/Worker 完成日志转录 |
| `sha256sums.txt` | 文件校验和 |

## 清理

测试后已停止测试 daemon、删除两个临时目录、移除 `[mcp_servers.hs_e2e]`、终止残留 MCP 进程，并确认 `~/.codex/queue_1.sqlite` 的 `queued_items = 0`。生产状态目录 `~/.harness-supervisor` 未被本次测试写入。
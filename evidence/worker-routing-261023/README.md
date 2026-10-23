# Worker 路由与异步交互验收证据

日期：2026-10-23（Asia/Shanghai）。实现代码：`2b0c2dc`。所有运行使用独立状态目录，未更新生产实例。

## 真实宿主结果

两个测试会话由 Codex 桌面原生 `create_thread` 创建，后续通知通过 HS 自己的官方 `codex queue` 路径触发新回合。没有使用另起的 app-server 模拟桌面。`desktop-turns.json` 来自原生 `read_thread`，只保留测试相关消息与时间线；没有原始 Session 或工具完整日志。

| 用例 | Worker | 接收 Thread | 文件验证 |
| --- | --- | --- | --- |
| 最终 A | `w-mvjuijvg-a55dd906` | `01a164b6-bb26-74a3-bb57-bc6a2c48a8ac` | `A_FINAL_OK` / `A_FINAL_WAKE_OK` |
| 最终 B | `w-mvjuimrr-4d620982` | `01a164b6-e971-74c2-9e18-b0b298d2bf85` | `B_FINAL_OK` / `B_FINAL_WAKE_OK` |
| 原生输入 + MCP answer | `w-mvju83tx-ad08307c` | 同 A | `HS_INPUT_CONTINUED_OK` / `HS_INPUT_WAKE_OK` |

最终 A/B 的执行区间确实重叠，通知各自 `delivered` 且已 ack；发起回合结束时间早于通知触发的新回合。具体 UTC 时间和原样文件内容见 `e2e-summary.json`。P1 的 `needs_input` 和 `completed` 分别出现在不同的新回合，回答通过真实 MCP `worker_answer` 执行。

前一组 A/B 和一轮 CLI answer 对照也保留在摘要中。最早两个测试创建时未指定模型；用户提出模型偏好后，后续续测使用 `gpt-6-luna`、`low`。Pi 沿用用户已有 provider/model 配置。

## 文件与复核

- `e2e-summary.json`：独立读取状态、通知、目标、ack 与实际文件后产生；断言最终 A/B 目标不同、时间重叠、内容匹配、通知确认，以及真实 MCP 交互闭环。
- `desktop-turns.json`：两个真实本地会话的发起/通知回合时间线，不以 Worker 自述代替结果。
- `automated-tests.txt`：最终全套 142 项，140 通过、2 项真实测试默认跳过。
- `real-pi-tests.txt`：显式启用后真实 Pi 两项全部通过。
- `windows-checks.txt`：Windows 进程身份、强制取消和生命周期竞态 12/12 通过。
- `reliability-tests.txt`：本轮阶段性可靠性回归；最终数目以全套输出为准。
- `cleanup.json`：本轮测试通知确认、两个测试 Daemon 关闭，以及原实例只读检查结果。
- `teardown.json`：进程复核与本轮状态/临时目录清理范围；保留开发工作树及脱敏证据。
- `sha256sums.txt`：本目录证据校验和。

复跑时先构建，外部启动隔离 Daemon，在两个真实桌面会话内分别运行 `scripts/e2e-route-spawn.mjs` 并显式传入各自 Thread ID；启动后结束回合，不 wait。通知新回合核对目标/文件并 ack。交互用 `scripts/e2e-pi-input-spawn.mjs`，回答用 `scripts/e2e-pi-input-answer.mjs`；扩展通过真实 Pi `ctx.ui.input` 请求普通技术输入。

未测试窗口关闭、Thread 真正卸载后的即时唤醒，也没有额外 GUI 双窗截图。仅凭 `delivered` 无法确认唤醒，本证据使用宿主记录的新回合和实际文件作为判据。

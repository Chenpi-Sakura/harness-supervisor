# 0.6.5 证据（2026-10-30）

范围：终态进展、输入有效期、通知统计范围、Resume 时间线、Codex 自动绑定复核与 `turn/steer` 边界。

## 真实 Qoder 输入等待

环境：Windows，Qoder CLI 1.1.79，隔离 daemon（`%TEMP%` 状态目录），使用已登录的 `~/.qoder` 配置；未触碰生产 daemon。

- 请求创建：2026-10-30T04:14:40.287Z
- 回答时间：2026-10-30T04:20:38.773Z（5 分 58 秒后）
- 结果：`QODER_INPUT_OK`，Worker `completed`
- 默认窗口：30 分钟；旧版 5 分钟计时器是 HS 适配器自己的限制

原始字段见 [qoder-input-wait.json](qoder-input-wait.json)。

## Codex `turn/steer` 真实协议与模型行为

受控 app-server（Codex 0.161.0，WebSocket）创建真实活动回合：

- 错误 `expectedTurnId` 被拒绝；
- 正确 steer 被接受，最终模型文本包含 `HS_STEER_TOKEN_065`；
- 回合结束后 steer 返回 `no active turn to steer`。

见 [codex-steer-rpc.json](codex-steer-rpc.json)。

## Codex Desktop 跨进程阻塞

第二个 app-server 能读到线程，但：

- `thread/resume` 失败：`already has an active writer`；
- `turn/steer` 失败：线程未加载（`thread not found`）；
- Desktop 的 app-server 是私有 stdio 进程，没有外部 `--listen`；
- 共享 managed daemon 的 `thread/loaded/list` 为空。

见 [codex-steer-cross-process.json](codex-steer-cross-process.json) 与
[`docs/codex-steer-261030.md`](../../docs/codex-steer-261030.md)。

## 自动化

定向套件（含新增 `status-evidence`、`progress-evidence`、`input-state`、`input-timeout`）：

- 单元：context-budget、mcp-presentation、notify、metrics、progress-evidence、input-state、input-timeout 全部通过
- 集成：status-evidence（7）、mcp（2）、qoder、mcp-auto-binding、mcp-modes、lifecycle、event-history、notification-binding、notify-routing 全部通过
- 完整回归：322 tests / 320 pass / 0 fail / 2 skipped（真实 Pi E2E 默认跳过），642.1s，见 [full-regression.txt](full-regression.txt)

## 边界

- 真实 Qoder 等待只覆盖一次单轮 AskUserQuestion；不证明所有 Qoder 工具审批都可等待 30 分钟。
- MiniMax Code 的 HS 侧输入窗口已可配置（默认 30 分钟，`HARNESS_SUPERVISOR_MCODE_INPUT_TIMEOUT_MS`）；真实 0.7.0 Ask 模式没有触发审批请求，因此宿主自身的等待上限仍未验证。
- Codex steer 只在受控 app-server 中验证；Desktop 实时 steer 未实现。
- 自动绑定沿用 2026-10-28 的真实 Desktop 双对话证据，并在本轮重新运行自动化回归；没有新增第二次 Desktop 实测。
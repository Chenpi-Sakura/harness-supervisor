# Qoder CLI 真实交互验收（阶段 4）

- 时间：2026-10-22（UTC 06:59–07:12）
- 环境：Windows，`qodercli 1.1.76`，模型 `DeepSeek-Flash`（低成本）
- 脚本：`scripts/e2e-qoder-interactions.mjs`（`npm run e2e:qoder:interactions`）
- 隔离：每个场景使用独立临时状态目录与独立 daemon，未触碰用户已运行的 HS daemon 与 Qoder 会话
- 需要 `QODER_REAL=1` 与 `QODER_REAL_MODEL=<低成本模型>` 才会真正调用模型

## 结果总览

| 场景 | 结果 | 说明 |
| --- | --- | --- |
| 真实工具调用（permission mode=auto） | **通过（真实）** | `Bash` 工具被真实调用一次，最终回复 `HS_QODER_TOOL_OK` |
| 运行中 steer | **协议层接受，未生效** | `run.message_sent` 记录成功；立即发送（spawn 后立刻）与延迟 1.5s 发送两种方式下，最终答案都未包含指定 token |
| follow-up | **协议层接受，未产生第二个 turn** | `run.message_sent` 记录成功，`extraTurns=1`，最终文本仍是第一轮内容 |
| 取消 + 队列清理 | **通过（真实）** | 运行中排队 follow-up 后 `cancel`，状态 `cancelled`，进程不存活，排队文本从未执行 |
| 权限审批 allow/deny | **未验证** | `permission mode=default` 下 Bash 调用**没有**触发 `can_use_tool` 请求，因此无法走到 allow/deny；需要更具体的工具（写文件类）或不同 CLI 版本 |
| AskUserQuestion | **通过（真实）** | 触发 `run.needs_input`（options: Red/Blue），回答 Blue 后最终回复 `Blue.` |

原始数据：`summary.json`（脱敏后的结构化结果）、`run.log`（含 daemon 日志，已脱敏）、`steer-immediate.txt`（补充的立即 steer 探测）。

## 关键结论与语义修正

1. **`run.message_sent` 不等于“模型已看到”**。Qoder 1.1.76 接受 stream-json 的 `priority:"next"/"later"` user 消息（CLI 二进制内同样存在这两个优先级值），但实测未影响当前 turn；原始内容见 `steer-immediate.txt`。
   - 因此本仓库在 Qoder adapter 的 capabilities 说明与 MCP `worker_send` 描述中都明确写出这一限制，不把“已接受”当作“已生效”。
2. **follow-up 在 Qoder 上不能按 Pi 的语义使用**：当前实现写的是 `priority:"later"`，实测没有产生后续 turn。adapter 仍保留 `followUp` 能力，但文档标明为未验证/可能无效。
3. **取消路径真实可用**：`cancel_async_message` → `interrupt{cancel_queued}` → 有界等待 → 必要时终止进程树的组合，在真实 Qoder 上得到 `cancelled` + 进程退出 + 排队消息未执行。
4. **input 通道可用**：AskUserQuestion 通过 `can_use_tool` 控制请求映射为 `run.needs_input`，`worker_answer` 的回答真实进入了模型上下文。
5. **权限提示未被触发**：在 `default` 模式下执行 `echo` 没有产生审批请求。该行为属于 Qoder CLI 自身策略，仓库不伪造审批测试；allow/deny 仍只有协议层单元/集成测试覆盖（`test/integration/qoder.test.ts` 使用模拟 CLI）。

## 未验证 / 限制

- Qoder 真实权限审批（allow 与 deny 各一次）在本机无法触发，列为未验证。
- steer/follow-up 的真实生效路径未知；若后续要支持，需要先定位 Qoder 官方的异步消息入口（可能的候选：`send_async_message` 类控制请求），而不是继续用 `priority` user 消息猜测。
- 真实 Qoder 输出速度很快（10–12 条要点约 20 秒），部分“运行中交互”场景天然存在竞态；本报告中的结论已用两种时机（立即 / 1.5s）验证 steer 仍未生效，排除了单纯“发得太晚”的解释。
- 本目录不保存原始 Qoder session 文件与完整对话，只保留脱敏摘要。
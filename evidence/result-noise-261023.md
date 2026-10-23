# MiniMax 最终结果降噪（2026-10-23）

## 根因与实现

原适配器把一个 `session/prompt` 内的所有 `agent_message_chunk` 追加到同一个字符串。因此“开始检查”“正在运行测试”和最终报告会一起进入 `worker.result.text`，还会再被完成通知带回主 Agent。

本机 MiniMax Code 0.6.12 的原生 ACP projector 将流式 delta 的 `messageId` 与完整 assistant message 的 `id` 投影为 `session/update.update.messageId`。修复依赖这个原生边界，不分析中文/英文措辞，也不要求 Worker 遵守报告模板：

- 同一 messageId 的分块完整拼接；后续新 messageId 替换先前消息，最终结果只保留最后一条。
- 较早 messageId 的迟到块仍记录进度，不覆盖当前结果；完整消息快照替换而非重复追加。
- 原生工具调用开始时，清除先前播报作为最终结果的候选；无最终答复则返回空结果，不拿“正在执行”冒充报告。
- 每次 prompt 清空消息边界状态，支持同一会话继续运行。
- 不对最终报告增加字数限制；既有 Supervisor 的可配置结果大小限制保持有效。

旧 ACP 若没有 messageId，仅能依据原生工具调用边界分开前后文本；同一连续流内多条匿名消息仍无法可靠区分，保留拼接，不伪造识别能力。过程仍通过既有进度摘要和原生 session 查询；本次没有把既有受限摘要升级为完整逐字对话存储。

## 回归与真实验证

消息边界六组测试各运行两轮，覆盖同 ID 分块、新 ID、旧消息迟到、整条快照、20KB 最终报告、无 ID 的工具边界与没有最终答复。与既有 ACP 测试合计 20 项通过；随后加入 MCP 呈现、mcode 集成回归，共 44 项通过。

真实命令：`node scripts/e2e-mcode-final-message.mjs`，设置实际 CLI 入口、用户已授权的 `bypassPermissions` 和独立证据目录。脚本启动独立 Daemon / 状态 / cwd，要求原生 Worker 先播报 `NOISE_PROGRESS_ONLY`，执行工具向 `proof.txt` 写入 `FINAL_TOOL_OK`，再答复 `FINAL_REPORT_OK`。

实测 2026-10-23 20:24:49—20:25:06（北京时间）：Worker completed，文件内容核对通过，过程事件仍包含播报标记，最终结果严格为 `FINAL_REPORT_OK`。这是输出语义验证，不宣称已经量化任务总 Token 节省。

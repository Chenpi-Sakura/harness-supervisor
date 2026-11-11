# Changelog

本项目从 0.9.1 起维护变更记录。历史版本摘要来自仓库 tag 与 `docs/` 交付报告。

## [0.9.2] - 2026-11-11

### 修复

- 每个输入或审批请求由 HS 分配不透明、唯一的 `requestId`，仅在内部映射回原生 ID，避免原生 ID 复用时迟到答案误批新请求。客户端继续原样回传当前 `pendingInput.requestId`；无需修改 CLI/MCP/IPC 参数。
- Production 增量事件按最早未交付的位置装包，预算未容纳的生命周期事件留给后续页；游标不再跳过这些事件，尾部快照行为不变。
- `worker_wait` 的类型过滤跨历史分页扫描，不再因目标事件位于前 500 条之后而误超时；交付游标仍保持原有分页语义。
- 完成通知指向 `worker_wait` 全文读取，输入通知明确使用 `includeInput=true`；已投递但失效的请求动态显示 `actionable=false` 和失效原因，保留真实投递与 ACK 历史。
- 默认 `worker_status` 的预算覆盖长标题和选项；无法容纳的选项整项省略并标明完整读取方式，不改写原生答案值。显式 `includeInput=true` 保留全文。
- 锁定 `body-parser` 至 2.4.0，修复 GHSA-27r3-jxmh-p828。

### 升级说明

- 修复生效需要升级并重启 daemon 和 MCP server；状态目录和 Worker 记录无需迁移。重启前应处理活动 Worker，HS 不接管旧进程。
- `requestId` 必须视为不透明值，不得使用旧请求 ID 或自行构造原生 ID。当前请求的 ID 可从 `worker_wait` 或 `worker_status(includeInput=true)` 获取。

## [0.9.1] - 2026-11-10

MCP 返回契约版本：Production 只返回决策与操作所需字段，Development 返回扩展诊断白名单。Worker 生命周期、事件落盘格式、CLI 与 IPC 状态语义不变。

### 输出变更（可能影响已有 MCP 客户端）

- `worker_list` 顶层从 Worker 数组改为 `{workers,nextCursor,hasMore}`。Production 条目只保留身份、状态、生命周期、`needsInput` 与 `lastSeq`；分页使用不透明 Keyset cursor，排序为 `(createdAt DESC, id ASC)`，默认 50、最大 200。依赖数组格式的客户端需要适配。
- `worker_status` 收敛为有界状态快照（默认 ≤2 KiB）：不再返回完整结果、`recentEvents`、`lastProgress`、`timeline`、`inputState` 或 `cwd`；结果/错误只返回 `resultPreview`/`errorPreview`。完整结果改用 `worker_wait`，完整待处理输入用 `includeInput=true`。
- Production `worker_status.includeResult=true` 与 `worker_status.recentEvents` 现在返回 `UNSUPPORTED`。
- `worker_wait` 在完成时返回完整最终结果（不在 MCP 层截断），需要输入时返回完整 `pendingInput`，超时只返回状态与游标；默认不返回事件。`until=event` 未指定 `types` 时只等待 lifecycle 事件，`run.progress` 不会结束等待；返回的事件批次最多 10 条、4 KiB，超出用 `eventsOmitted` 标注。
- `worker_events` Production 只返回 lifecycle 摘要，不返回 `run.progress` 或原始 `data`；`includeProgress=true` 与 progress 类型的 `seq` 返回 `UNSUPPORTED`；严格增量每页最大 200 条。
- `supervisor_info` Production 收敛为版本、模式、runtime 可用性与 Worker 计数；limits、wake、storage、PID、stateDir 等诊断只在 Development 返回。
- `supervisor_notifications` Production 默认返回全部未确认通知，不返回投递历史、routing target 或 ACK 诊断；`includeDelivery=true` 返回 `UNSUPPORTED`。
- metrics 工具：Production 返回任务摘要、覆盖率和用量汇总，不返回原始 usage 记录或 token 明细；`metrics_report.includeTasks` 在 Production 返回任务摘要，Development 返回完整任务详情。
- `worker_spawn` / `worker_resume` / `worker_continue` / `worker_send` / `worker_answer` / `worker_cancel` 明确返回 `accepted`，不会把接受写成完成；`worker_cancel` 增加 `cancellationState`；`worker_resume` 增加 `sessionRestored`。

### 新增与修复

- `worker_list` 真正的 Keyset 分页：cursor 指向最后一条已返回记录，并发新增、归档、删除或遗忘不会造成后续页重复或遗漏；1,200 个 Worker 全量翻页回归。
- Production 2 KiB 状态预算在完整投影后再次测量并收缩；响应体积有自动化实测。
- Development 在旧 Daemon 缺少 `session` 投影时不再崩溃；`worker_resume.sessionRestored` 仅在明确 `session.available=true` 时为 true。
- 旧 Daemon 兼容：第一页 `worker_list` 仍可用；带 cursor 的后续页返回带升级指引的 `UNSUPPORTED`，不会发送旧 Schema 不认识的 `after` 参数。cursor 中的时间戳必须是规范 ISO，否则返回 `BAD_REQUEST`。
- `worker_resume.sessionRestored` 在旧 Daemon 未返回 session 投影时省略，不再写成 `false`。
- Development `worker_events` 始终返回存储事件流；`includeProgress` 仅保留为跨模式兼容参数。移除了不可达的 Production 原始事件分支，事件只能经白名单摘要返回。
- 新增真实 Harness MCP 验收脚本 `scripts/e2e-mcp-runtimes.mjs` 与证据 `evidence/mcp-runtime-acceptance-261110/`。

### 验收

- 真实 Qoder CLI 1.1.82 与 MiniMax Code 0.7.0 通过 `worker_spawn -> worker_wait -> worker_status -> worker_events` 验收；Production 过滤了 Qoder 的 59 条 `run.progress`（含 thinking），最终结果完整返回一次。
- 单元与集成测试覆盖双模式投影、参数绕过、游标语义、10 万条 progress、旧 Daemon 兼容和响应预算。
- 未在本版本验证：Codex Desktop 模型回合、Persistent 多轮真实 MCP 调用、Pi/DSH 的真实 MCP 验收、权限审批交互。

### 升级说明

- 升级后重启 daemon，并重启 MCP server（或宿主会话），使版本检查与新的返回契约生效。
- 状态目录、事件文件与 Worker 记录无需迁移；旧记录继续可读。
- Production 需要 daemon ≥0.4.0；`worker_list` cursor 需要 daemon ≥0.9.1；metrics 需要 daemon ≥0.5.0。
- 字段精简只影响 MCP 返回，不提供安全隔离，也不会截断 `worker_wait` 的最终结果；`result.truncated` 仅表示 Supervisor 存储层按 `maxResultBytes` 截断。

## 历史版本

| 版本 | 日期 | 摘要 |
| --- | --- | --- |
| 0.9.0 | 2026-11-10 | Persistent Worker、`worker_continue`、pin/archive/retire/forget、存储诊断 |
| 0.8.0 | 2026-11-05 | 通过 ACP 接入 DeepSeek Harness（DSH） |
| 0.7.0 | 2026-11-04 | Qoder ACP 可选传输 |
| 0.6.6 | 2026-11-04 | 兼容 Qoder CLI 1.1.82 启动参数与懒初始化 |
| 0.6.5 | 2026-10-30 | 终态诊断、输入恢复与通知可读性 |
| 0.6.1 | 2026-10-28 | MCP 自动绑定 Codex 当前对话 |
| 0.6.0 | 2026-10-28 | 通知绑定与投递边界整理 |
| 0.5.0 | 2026-10-27 | 任务度量（metrics）第一阶段与第二阶段 |
| 0.2.0 | 2026-10-23 | 异步投递、幂等、保留策略与 PID 校验 |

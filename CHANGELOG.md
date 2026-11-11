# Changelog

本项目从 0.9.1 起维护变更记录。历史版本摘要来自仓库 tag 与 `docs/` 交付报告。

## [0.10.2] - 2026-11-11

- 配套插件 `0.1.2` 携带 HS `0.10.2`；添加 GitHub Actions 的正式版本标签发布流程，使用 npm OIDC 信任及 provenance，不保存长期 npm Token。手动运行仅构建验收，不发布。
- 发布前校验核心、插件、标签、仓库来源与固定依赖，校验构建产物完整性；已有 npm 版本内容不同则拒绝重发。锁文件下载地址统一到官方 registry，依赖版本及完整性值不变。

## [0.10.1] - 2026-11-11

- DSH 增加对话标签页、左侧主面板和设置页的共用 WebUI 入口。人工界面可管理本机全部 Worker，默认展开当前对话；模型的 MCP 查询、操作和通知 ACK 继续受会话归属约束。
- Worker 导航改为“工作目录 → 会话 → Worker”，支持折叠、平铺、稳定会话色块及 Harness 图标；完整目录通过悬浮提示显示。
- 事件改为可搜索、按需展开详情的紧凑轨迹；调整信息布局、字重、侧栏底部信息、滚动条及展开动画，修复结果与轨迹切换时的宽度抖动。未上报用量在界面暂显示 0，底层未知值语义不变。
- 浏览器授权按宿主面板替换并校验请求代际，防止重复挂载耗尽凭据及迟到请求撤销当前页面授权；全局分页独立补充当前会话 Worker，避免旧会话任务被首屏分页遗漏。
- 配套插件升级为 `0.1.1`，固定携带 HS `0.10.1`；不会因发布或插件安装自动替换正在运行的核心。

## [0.10.0] - 2026-11-11

### 新增

- 通用 Master 会话归属 `ownerRef`，scoped MCP 固定进程身份与 inbox-only 通知策略；列表、结果、生命周期操作和整批 ACK 在服务端校验范围。无归属旧记录不自动认领，原有全局 CLI/MCP 保持兼容。
- 可选本机 WebUI：共用 React/Vite 前端、一次性入口、独立浏览器凭证和服务端作用域；支持观察、用量、完整审批和取消。仅按需监听 loopback，不新增常驻服务。
- 同仓库 `packages/dsh-plugin` 安装包装，按真实 DSH Agent 管理原生 MCP 生命周期，提供 `/hs`、设置页与官方 Browser 页签入口；固定核心与生产依赖随安装包发布。
- 托管核心缓存、排空、原子指针与一次性交接 helper。新任务准入与既有任务完成分开，幂等请求落盘前也计入排空屏障；仅在目标尚未接收新工作且确认退出时恢复上一已验证核心。

### 升级边界

- 旧 `0.9.2` daemon 不支持本次 scoped/UI/drain 能力，首次升级须处理活动 Worker 后手动迁入；客户端不会替换运行中的旧实例。
- 首版为本机单用户、兼容状态格式；DSH 主动唤醒后置。会话归属与 IPC Token 不构成同用户安全隔离。
- 核心更新前后的通知仍是 at-least-once，可能重复投递；交接后需重新打开 WebUI。插件安装回滚与运行核心回滚分别报告。

### 验证

- Windows 系统浏览器、DSH Web iframe 和真实 DSH Desktop Browser 载体均已验收；Desktop 的 `dsh-app://app` 入口单独处理，不放宽 Web iframe 来源或 CSP。
- MiniMax-M3.1-Flash 作为真实 Desktop Master，完成 Qoder / MiniMax Code 的委派、读取与同 Worker / 原生 Session 二次续接；独立核对实际文件字节和进程退出。另覆盖真实 Pi 的输入、过期请求拒绝和跨会话操作拒绝。
- Desktop 普通文本输入和取消已验证；权限确认审批未在该桌面路径中单独验证，不能将普通输入视为权限审批。
- 核心全量 434 项通过、3 项真实 Harness 开关测试跳过；最终修复的 27 项定向回归及插件 10 项测试通过，构建和类型检查通过。

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

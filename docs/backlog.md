# 后续事项 Backlog

更新日期：2026-11-10。
最近补充：2026-11-10，0.9.1 Phase 1–7 完成：Production 硬过滤 `worker_wait` / `worker_events` 的 progress 旁路；`worker_status` 收敛为纯状态快照；20 个实际注册工具全部使用显式双模式投影；`worker_list` 改为 Keyset 真分页并通过 1,200 Worker 与并发变更测试；真实 Qoder 1.1.82 与 MiniMax Code 0.7.0 的 Production MCP 最小任务验收通过，真实 thinking/progress 全部未泄漏；独立审查无阻断项。版本已提升到 0.9.1，尚未推送、打 tag 或部署。见 `docs/2026-11-10-hs-0.9.1-report.md`、`docs/2026-11-10-hs-0.9.1-mcp-response-plan.md` 与 `evidence/mcp-runtime-acceptance-261110/`。
最近补充：2026-11-10，0.9.0 已发布（`cd8d5b4` / `v0.9.0`）并在目标生产环境部署：82 Worker、331 MB 状态冷启动 27s → 16.7s（首次）→ 0.48s（检查点），备份 37.6 MB 保留；本开发机默认状态为独立 15 Worker 实例。Codex Desktop Stage 1/2 已通过，Stage 3 未复验。完整测试 386/384/0/2。331 MB 数据来源见 `docs/2026-11-10-0.9.0-production-deployment.md`。
最近补充：2026-11-05，0.8.0 完成 DSH（DeepSeek Harness）桌面端 ACP PoC：新增通用 ACP 传输层与 `dsh` runtime，真实 0.2.1-rc.5 的 spawn/模型与推理配置/`session/resume`/工作区写入/工作区外提权审批/`danger-full-access` 无审批写入/取消通过；`steer`/`followUp`/`tools`/`extraArgs` 明确不支持，`usage_update` 只作上下文占用。权限模式由 `HARNESS_SUPERVISOR_DSH_PERMISSION_MODE` 控制，原生默认是 `workspace-write` + `ask`。代码位于独立分支，暂不合并进生产默认。证据见 `evidence/dsh-acp-real/`。
最近补充：2026-11-04，0.7.0 实现 Qoder ACP 并在真实 1.1.82 验收后**设为默认传输**（`HARNESS_SUPERVISOR_QODER_PROTOCOL=stream-json` 可回退），spawn/resume/Write 审批/AskUserQuestion/取消全部通过；版本号保持 0.7.0。ACP steer/follow-up、Token 用量与默认传输的长期稳定性仍待后续验证。
最近补充：2026-11-04，完成 Pi / Qoder / mcode 的 ACP 改造可行性评估（`docs/2026-11-04-acp-feasibility.md`）：Qoder ACP 已真实验证工具审批和 elicitation 提问，建议作为可选传输层；mcode 已是 ACP，只考虑共享内核；Pi 官方无 ACP，第三方适配器缺少权限映射，建议保留原生 RPC。
最近补充：2026-11-04，0.6.6 修复 Qoder CLI 1.1.82 的启动参数冲突与懒初始化（`system init` 需首条 user 消息触发），真实 1.1.82 spawn/resume 通过；1.1.82 的 stream-json 不再暴露 AskUserQuestion 权限请求，ACP 已做官方握手与 Write 审批探测，列为下一阶段可选传输层。
最近补充：2026-10-30，0.6.5 完成终态 `lastProgress`、输入请求有效期/结构化恢复提示、通知统计范围拆分、Resume 时间线与事件读取边界；Qoder 输入窗口改为 30 分钟并经真实 1.1.79 验证。Codex app-server `turn/steer` 协议与模型应用已真实验证，但 Desktop 私有 stdio app-server 与活动 writer 锁使 HS 无法接入，0.6.5 不实现宿主 steer，边界见 `docs/2026-10-30-codex-steer.md`。
最近补充：2026-10-28，0.5.x 已移除 0.4.4 的 Codex 消费前 ACK hook（源码、安装器、测试、文档与 bin 入口）；收件箱/ACK/重试/投递前失效检查保留。已安装旧 hook 的机器需手动在 `/hooks` 禁用或删除对应 `UserPromptSubmit`，HS 不修改用户配置。
最近补充：2026-10-27，0.5.0 完成任务度量阶段一/二（任务关联、运行时可用 Token、覆盖率报告）；费用不采集（积分制无法直接核对），验收/返工/干预/对照分析仍在阶段三/四，见 `docs/v0.5.0-metrics-phase12-report.md`。

当前阶段以原型实际使用为主。用户通常保持宿主 7×24 小时运行；以下事项全部暂缓，不作为当前原型交付的前置条件，也不安排主动轮询或自动测试任务。只有实际使用遇到问题或用户重新安排时再启动。

当前可用基线：以 Pi 为主要 Runtime，支持多 Codex 对话并行创建 Worker、持久化通知路由、重要事件唤醒已加载的目标 Thread、原生输入回答闭环及后续结果确认。机器常开不等于所有 Thread 始终加载；未加载场景保留既有能力边界。Qoder 继续保持实验性说明；0.7.0 起 ACP 是默认传输，stream-json 可通过环境变量显式回退。

| 事项 | 类型 | 后续验收重点 | 状态 |
| --- | --- | --- | --- |
| 0.9.1 MCP 返回契约 | 接口优化 | 20 个实际注册工具的 Production/Development 双白名单；Production 硬过滤 progress/thinking；`worker_status` 纯状态查询、`worker_wait` 完成时返回完整结果；`worker_list` Keyset 分页；参数绕过、10 万 progress、游标与响应体积测试 | Phase 1–7 已完成（2026-11-10）；真实 Qoder/MiniMax Code 验收通过；独立审查无阻断；待用户确认发布 |
| Persistent Worker 桌面多 Thread 验收 | 宿主验收 | Stage 1/2 已验证：两个 Codex Thread 各一名 persistent Worker、通知只到正确 Thread、两个 Thread 均自动唤醒、同一 Worker continue、DSH `needs_input → Allow once → completed` 再次唤醒。Stage 3 的 Thread 切换 / 卸载 / 完整退出本轮未复验。按 `docs/2026-11-09-desktop-e2e-runbook.md` 执行，不用 app-server 冒充 | Stage 1/2 已通过（2026-11-10）；Stage 3 未复验 |
| 331 MB 生产状态验收 | 规模验收 | 目标生产环境已验证（2026-11-10）：82 Worker，0 活动；0.8.0 27s → 0.9.0 首次 16.7s → 再次 0.48s；备份 37.6 MB 保留。本开发机默认 15 Worker 实例不用于该结论 | 已验证（目标环境，维护者报告） |
| 生产状态压缩与备份保留 | 维护决策 | `compact --dry-run` 可回收 2,123,215 events / 321,291,500 bytes；备份 `state-20261110-123310.zip` 37.6 MB 保留。压缩不可逆，等待用户决定；如压缩，先压三大 Worker | 待决策 |
| Persistent Worker P2 收敛 | 代码质量 | 终态 `pidAlive` 对 PID 复用的投影、finalizer try/finally、events 响应暴露压缩游标缺口、永久损坏尾行的启动回退、CLI/MCP inbox 默认差异、生产绑定可见性 | 后续 |
| 双对话真实工作负载 | 扩展验收 | 在已有双会话 E2E 通过基础上，用真实开发任务验证完成、失败、输入通知的正确路由及 ack，避免跨对话处理 | 暂缓 |
| 离线与重启恢复 | 宿主边界验证 | Thread 卸载、桌面退出、Daemon 重启后的保存、补投、重复处理与实际唤醒分别核对 | 暂缓 |
| 旧 Worker 升级兼容 | 扩展验收 | 真实旧状态下的查询、未绑定收件箱降级、Resume 保留绑定、显式接管仅改变未来事件 | 暂缓 |
| `worker_wait` 历史分页 | 已知 P2 正确性问题 | `until:event` 配合类型过滤时只检查游标后前 500 条，目标在后页且任务仍运行时可能误超时；补复现并修复。当前可用 `worker_events` 推进游标查询 | 暂缓，保留限制说明 |
| 长期资源与清理 | 规模验收 | 模拟规模数据和少量真实长任务，检查内存、磁盘、通知积压与 prune，保护活跃 Worker 和未确认通知 | 暂缓 |
| 任务度量阶段三 | 指标扩展 | 首次验收、返工、人工干预的记录与去重；明确操作来源，不自动把 steer/消息事件当人工干预；固定数据集复算 | 后续 |
| 任务度量阶段四 | 对照与导出 | 不做费用采集（积分制无法核对）；只有存在同验收标准的非 HS 基线时才做 Token/耗时对照；不接受用会话总 Token 摊派到单任务 | 后续 |
| MiniMax Code Token 用量 | 运行时用量 | 最新 0.6.13 实测：ACP prompt result 只有 stopReason，usage_update 只有上下文 used/size 与 cost=0；headless `exec --output-format json` 有结构化 usage。需上游在 ACP 补 usage，或评估非交互 worker；不读私有会话库，不用上下文量代替 Token | 待上游/待验证 |
| Codex Desktop 实时 steer | 宿主能力 | app-server `turn/steer` 已在真实活动回合验证（含错误 turn 拒绝与模型应用）；但 Desktop 的 app-server 是私有 stdio，共享 daemon 无法取得活动 writer 锁。只有出现受支持的 Desktop 控制端点或宿主级 API 时再实现；不写 queue SQLite、不猜活动回合 | 阻塞 |
| DSH ACP 默认稳定性（PoC） | 运行时验证 | 桌面端 0.2.1-rc.5 已真实验证 spawn / 模型与推理配置 / `session/resume` / 工作区写入 / 工作区外提权 / `danger-full-access` 写入 / 取消；仍需多轮并发、长上下文、错误路径与桌面端升级兼容验证。当前 `steer`/`followUp`/`tools`/`extraArgs` 明确不支持；合并进生产前先评审 PoC 分支与证据 | PoC/待验证 |
| DSH ACP 权限路径 | 运行时能力 | 已真实验证：原生默认 `workspace-write` + `ask`，工作区外写入被拒绝后触发一次 `session/request_permission`，经 `worker_answer` 允许后写入成功；`HARNESS_SUPERVISOR_DSH_PERMISSION_MODE=danger-full-access` 下同一路径写入无审批。`read-only` 仅做映射与单元测试，未跑真实拒绝场景；超时/拒绝路径仍只有协议测试 | 已验证（PoC）；read-only 与超时待补 |
| Qoder ACP 默认稳定性 | 运行时验证 | 0.7.0 已将 ACP 设为默认（默认值切换不升级版本号），真实 1.1.82 的 spawn/resume/Write 审批/AskUserQuestion/取消通过且无 `run.error`。仍需补测多轮并发、长上下文、错误路径与桌面环境；发现问题时可用 `HARNESS_SUPERVISOR_QODER_PROTOCOL=stream-json` 回退。见 `docs/v0.7.0-report.md` | 待验证 |
| Qoder ACP steer/follow-up | 运行时能力 | `initialize._meta.qoder.promptQueueing=true` 已观察到，但尚未验证 queued prompt 对 run 边界的影响；当前 ACP capabilities 明确 `steer=false`、`followUp=false`，不伪造支持 | 待验证 |
| Qoder ACP Token 用量 | 运行时用量 | 真实 1.1.82 ACP prompt result usage 全零；HS 不写 `run.usage`。需上游在 ACP 补 token 计数，或改用有结构化 usage 的非 ACP 路径；不读私有会话库 | 待上游 |
| MiniMax Code 输入等待 | 运行时边界 | 0.6.5 后 HS 侧默认 30 分钟，可用 `HARNESS_SUPERVISOR_MCODE_INPUT_TIMEOUT_MS` 覆盖；真实 0.7.0 Ask 模式没有触发审批请求，宿主自身的等待上限仍未验证。需真实 Ask 场景确认宿主是否允许超过 5 分钟，再决定是否把默认值视为宿主保证 | 待验证 |
| Pi 输入上限 | 运行时边界 | Pi 原生 `timeout` 仍由扩展提供；默认统一 30 分钟上限，`HARNESS_SUPERVISOR_PI_INPUT_TIMEOUT_MS=0` 可关闭，到期由 Supervisor 发送取消。仅经过脚本化 Harness 与单元测试，未验证真实扩展在 HS 取消后的行为 | 待验证 |
| 度量日志保留 | 规模与清理 | `metrics.jsonl` 的保留/清理策略；不得删除活跃任务、任务关联或未确认通知所需信息；需与 `prune` 语义分开 | 后续 |

Qoder stream-json steer/follow-up 继续按现有真实证据标为未验证生效；ACP 下二者明确不支持。只有获得明确原生协议依据或实际需求后再投入，不为统一接口伪造支持。

## 实际使用反馈：降低通知与审批的总 Token 开销

2026-10-23，MiniMax Code 自验中普通只读工具反复请求权限，Master 逐次回答后，已排入 Codex 队列的通知仍可能晚到；切换权限模式的取消事件也会唤醒。用户明确要求改善此体验。此项属于已发生的成本问题，优先于上述暂缓的扩展验收。

当前措施：按用户明确授权将本机 HS 的 MiniMax 原生权限配置由 Ask、Auto 切为 Full access，并恢复同一 Worker。此配置影响该 Daemon 后续启动、恢复的 MiniMax Worker；不把全权限设为项目通用默认。自验已完成，记录见 `evidence/mcode-selftest-261023.md`。

2026-10-28 追加：只改本机配置并不够——HS 每次新建/恢复会话都会通过 `session/set_config_option` 写入 `permissionMode`，旧的代码默认 `default` 会把 Full access 再次覆盖。现已把代码默认改为 `bypassPermissions`；需要 Ask 时显式设置 `HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE=default`。设置失败会显式报 `UNSUPPORTED`，不静默降级。

0.4.3 迭代落实投递前失效检查、每 Worker 短窗口、精简唤醒指针和 MiniMax 原生消息边界分离。已被宿主接受的旧提醒无法撤回；真正不同的待办仍分别投递，未实现“所有通知只唤醒一次”的保证。

优化方向与剩余边界：

- 投递前检查请求是否仍有效；已回答、已撤销、旧回合的请求保留事件证据，不再新发唤醒。不能宣称能撤回已被 Codex queue 接受的消息。
- 将同一 Worker 的待处理提醒合并为收件箱唤醒信号；Master 一次取得当前待办并批量确认，保留真正需要及时回答的问题。
- 通知仅携带 Worker、事件/游标和必要行动提示；实际命令参数由当前 pendingInput 获取，完成报告按需完整读取，不设固定报告字数上限。
- 区分调用方已知的维护取消与异常停止，避免切换配置的中间状态无谓唤醒；保持终态和持久化证据真实。
- 权限策略应明确可配置，优先减少源头的普通工具审批，不建立另一个模型审批代理，也不按标题自动放行任意操作。
- MiniMax 自验的 `worker.result.text` 实际混入多段过程播报。后续核对 ACP 的消息/回合边界，尽可能单独提供最终答复；不能仅靠任意截字或丢弃不可区分的片段。完整过程保留在事件查询中，最终报告不设固定字数上限。

验收按完整任务统计唤醒回合数、重复/失效提醒数、工具返回大小及可取得的实际 Token 用量；不能只用通知字符数声称节省 Token。覆盖事件先被读取/回答再投递、resume 后请求编号重用、并发 Worker 正确路由和必要阻塞不漏报；协议回归与真实桌面验收分别记录。

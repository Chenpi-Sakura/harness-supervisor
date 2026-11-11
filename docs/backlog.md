# 后续事项 Backlog

更新日期：2026-11-11。只保留未实现、待验证、待决策或阻塞事项；已实现与已验收内容（含原更新记录、基线描述与已完成表格行）逐字归档至 `docs/archive/2026-11-11-backlog-snapshot.md`。

当前阶段以原型实际使用为主。用户通常保持宿主 7×24 小时运行；以下事项全部暂缓，不作为当前原型交付的前置条件，也不安排主动轮询或自动测试任务。只有实际使用遇到问题或用户重新安排时再启动。

| 事项 | 类型 | 后续验收重点 | 状态 |
| --- | --- | --- | --- |
| Persistent Worker 桌面多 Thread 验收 Stage 3 | 宿主验收 | Thread 切换 / 卸载 / 完整退出后的保存、补投、重复处理与实际唤醒；按 `docs/2026-11-09-desktop-e2e-runbook.md` 执行，不用 app-server 冒充 | Stage 1/2 已通过；Stage 3 未复验 |
| 生产状态压缩与备份保留 | 维护决策 | `compact --dry-run` 可回收 2,123,215 events / 321,291,500 bytes；备份 `state-20261110-123310.zip` 37.6 MB 保留。压缩不可逆，等待用户决定；如压缩，先压三大 Worker | 待决策 |
| Persistent Worker P2 收敛 | 代码质量 | 终态 `pidAlive` 对 PID 复用的投影、finalizer try/finally、events 响应暴露压缩游标缺口、永久损坏尾行的启动回退、CLI/MCP inbox 默认差异、生产绑定可见性 | 后续 |
| 双对话真实工作负载 | 扩展验收 | 在已有双会话 E2E 通过基础上，用真实开发任务验证完成、失败、输入通知的正确路由及 ack，避免跨对话处理 | 暂缓 |
| 通知与审批开销真实任务验收 | 成本验收 | 按完整任务统计唤醒回合数、重复/失效提醒数、工具返回大小及可取得的实际 Token 用量；不能只用通知字符数声称节省 Token。覆盖事件先被读取/回答再投递、resume 后请求编号重用、并发 Worker 正确路由和必要阻塞不漏报；协议回归与真实桌面验收分别记录 | 暂缓 |
| 离线与重启恢复 | 宿主边界验证 | Thread 卸载、桌面退出、Daemon 重启后的保存、补投、重复处理与实际唤醒分别核对 | 暂缓 |
| 旧 Worker 升级兼容 | 扩展验收 | 真实旧状态下的查询、未绑定收件箱降级、Resume 保留绑定、显式接管仅改变未来事件 | 暂缓 |
| 长期资源与清理 | 规模验收 | 模拟规模数据和少量真实长任务，检查内存、磁盘、通知积压与 prune，保护活跃 Worker 和未确认通知 | 暂缓 |
| 任务度量阶段三 | 指标扩展 | 首次验收、返工、人工干预的记录与去重；明确操作来源，不自动把 steer/消息事件当人工干预；固定数据集复算 | 后续 |
| 任务度量阶段四 | 对照与导出 | 不做费用采集（积分制无法核对）；只有存在同验收标准的非 HS 基线时才做 Token/耗时对照；不接受用会话总 Token 摊派到单任务 | 后续 |
| MiniMax Code Token 用量 | 运行时用量 | 最新 0.6.13 实测：ACP prompt result 只有 stopReason，usage_update 只有上下文 used/size 与 cost=0；headless `exec --output-format json` 有结构化 usage。需上游在 ACP 补 usage，或评估非交互 worker；不读私有会话库，不用上下文量代替 Token | 待上游/待验证 |
| Codex Desktop 实时 steer | 宿主能力 | app-server `turn/steer` 已在真实活动回合验证（含错误 turn 拒绝与模型应用）；但 Desktop 的 app-server 是私有 stdio，共享 daemon 无法取得活动 writer 锁。只有出现受支持的 Desktop 控制端点或宿主级 API 时再实现；不写 queue SQLite、不猜活动回合 | 阻塞 |
| DSH ACP 默认稳定性 | 运行时验证 | 0.10.0 已合并进生产默认；仍需多轮并发、长上下文、错误路径与桌面端升级兼容验证。当前 `steer`/`followUp`/`tools`/`extraArgs` 明确不支持，不伪造支持 | 待验证 |
| DSH ACP 权限路径补测 | 运行时能力 | `read-only` 仅做映射与单元测试，未跑真实拒绝场景；超时/拒绝路径仍只有协议测试 | 待补真实验证 |
| Qoder ACP 默认稳定性 | 运行时验证 | 0.7.0 已将 ACP 设为默认（默认值切换不升级版本号），真实 1.1.82 的 spawn/resume/Write 审批/AskUserQuestion/取消通过且无 `run.error`。仍需补测多轮并发、长上下文、错误路径与桌面环境；发现问题时可用 `HARNESS_SUPERVISOR_QODER_PROTOCOL=stream-json` 回退。见 `docs/v0.7.0-report.md` | 待验证 |
| Qoder ACP steer/follow-up | 运行时能力 | `initialize._meta.qoder.promptQueueing=true` 已观察到，但尚未验证 queued prompt 对 run 边界的影响；当前 ACP capabilities 明确 `steer=false`、`followUp=false`，不伪造支持 | 待验证 |
| Qoder ACP Token 用量 | 运行时用量 | 真实 1.1.82 ACP prompt result usage 全零；HS 不写 `run.usage`。需上游在 ACP 补 token 计数，或改用有结构化 usage 的非 ACP 路径；不读私有会话库 | 待上游 |
| MiniMax Code 输入等待 | 运行时边界 | 0.6.5 后 HS 侧默认 30 分钟，可用 `HARNESS_SUPERVISOR_MCODE_INPUT_TIMEOUT_MS` 覆盖；真实 0.7.0 Ask 模式没有触发审批请求，宿主自身的等待上限仍未验证。需真实 Ask 场景确认宿主是否允许超过 5 分钟，再决定是否把默认值视为宿主保证 | 待验证 |
| Pi 输入上限 | 运行时边界 | Pi 原生 `timeout` 仍由扩展提供；默认统一 30 分钟上限，`HARNESS_SUPERVISOR_PI_INPUT_TIMEOUT_MS=0` 可关闭，到期由 Supervisor 发送取消。仅经过脚本化 Harness 与单元测试，未验证真实扩展在 HS 取消后的行为 | 待验证 |
| 度量日志保留 | 规模与清理 | `metrics.jsonl` 的保留/清理策略；不得删除活跃任务、任务关联或未确认通知所需信息；需与 `prune` 语义分开 | 后续 |

Qoder stream-json steer/follow-up 继续按现有真实证据标为未验证生效；ACP 下二者明确不支持。只有获得明确原生协议依据或实际需求后再投入，不为统一接口伪造支持。

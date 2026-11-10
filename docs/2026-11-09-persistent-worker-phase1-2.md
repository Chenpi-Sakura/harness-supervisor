# Persistent Worker Phase 1-2 交付记录

> 日期：2026-11-09
>
> 分支：`feat-261109-hs-09`
>
> 版本：0.8.0（按要求未升级）
>
> 机器：Windows 10.0.26300 / Node v24.22.1（本机开发环境，非 331 MB 生产实例）
>
> 依据：`HS-0.9-Persistent-Worker-Architecture-Proposal.md`

## 1. 范围与结论

本阶段完成提案的 Phase 1（Persistent Worker 最小语义）与 Phase 2（Adapter 真实能力矩阵的持续协作部分）。

| 结论 | 证据 |
| --- | --- |
| 同一 Worker 连续 3 轮，Worker ID 与 Native Session 不变 | Pi / Qoder ACP / MiniMax Code / DSH 四条真实 Harness E2E |
| 后两轮实际使用前序上下文 | 第 3 轮未重发两个随机口令，四家 Harness 均正确回传 |
| 每轮结束后 Activation 进程退出，可再次激活 | `pidAlive=false`，下一轮冷恢复成功 |
| 旧 oneshot 行为保持 | 未传 `persistence` 的 Worker 默认 `oneshot`；`worker_resume` 语义未改 |
| Session 不可恢复时返回真实错误 | oneshot / session 文件缺失 / orphaned / active / 并发 continue 自动化测试 |

## 2. Phase 1 实现差异

| 设计与实现 | 源码入口 |
| --- | --- |
| `persistence`、`lifecycle`、`NativeSessionRef`、`session` 投影 | `src/types.ts` |
| spawn 记录持久化模式；session 建立/刷新时写入 `sessionRef` | `src/supervisor.ts` `spawnInternal` / `initializeSession` / `refreshSessionState` |
| 读取时派生 `lifecycle` 与 `session.restorable`，不持久化第二份状态 | `src/supervisor.ts` `summary` / `sessionProjection` / `lifecycleFor` |
| `Supervisor.continue()` 复用冷恢复路径，不创建替代 Worker | `src/supervisor.ts` `continue` / `continueOnce` |
| 新事件 `worker.continued`；`run.accepted` 带 `continued=true` | `src/supervisor.ts` `resumeInternal` |
| IPC `continue` 方法、`spawn.persistence` | `src/ipc/protocol.ts` / `src/ipc/server.ts` |
| CLI `continue`、`spawn --persistence`、状态展示 | `src/cli.ts` |
| MCP `worker_continue`、生产响应字段 | `src/mcp.ts` / `src/mcp-presentation.ts` / `src/context-budget.ts` |

兼容边界：

- `WorkerSummary` 新增字段为派生值；旧记录按 `oneshot` 读取。
- `worker_resume` 仍用于恢复语义；`worker_continue` 只接受 `persistent` Worker。
- 事件 seq、通知 `workerId#seq`、Usage `runtime:<workerId>:<seq>` 未改动。
- MCP 与旧 Daemon 的字段差异由可选字段输出兼容。

## 3. Phase 2 真实能力矩阵

运行命令：

```bash
node scripts/e2e-persistent-pi.mjs --runtime pi
node scripts/e2e-persistent-pi.mjs --runtime qoder
node scripts/e2e-persistent-pi.mjs --runtime mcode
node scripts/e2e-persistent-pi.mjs --runtime dsh
```

| Runtime | 真实版本 | Idle continue 级别 | 3 轮结果 | 备注 |
| --- | --- | --- | --- | --- |
| Pi | 1.4.0 | L3 | 通过 | 原生 Pi RPC + Pi session 文件 |
| Qoder CLI | 1.1.82 | L3（ACP 传输） | 通过 | stream-json 保留 L2；ACP 使用 `session/load` |
| MiniMax Code | 0.7.0 | L3 | 通过 | ACP `session/load` |
| DSH | 桌面捆绑 CLI | L3 | 通过 | `session/resume`，要求相同绝对 cwd |

L3 表示真实 Harness 调用与效果验证通过；四条路径均未经过真实 Codex/Master 回合闭环，因此不声明 L4。`session/list/delete/fork/close` 仍为声明级，未开放。

Qoder 真实运行的配置注意：Qoder Desktop 会注入 `QODER_CONFIG_DIR` / `QODERCN_CONFIG_DIR` 指向未登录的配置根；E2E 脚本会移除这两个变量，使用 `~/.qoder` 的登录状态。该行为只影响测试脚本，不改变 Daemon 配置读取规则。

真实运行的证据文件位于 `.evidence/persistent-pi/`（gitignored），包含每次 Turn 的状态、session id、`pidAlive` 和最终文本。四个运行时均满足：

- `turn1Completed` / `turn2Completed` / `turn3Idle`
- `sameWorker` / `sameSessionAfterTurn2` / `sameSessionAfterTurn3`
- `contextHadNonceA` / `contextHadNonceB`
- `allProcessesExited` / `resumeCount`

## 4. 自动化回归

| 测试 | 覆盖 |
| --- | --- |
| `test/integration/persistent.test.ts` | 3 轮同 session；oneshot 拒绝；session 缺失；active 与并发拒绝；Daemon 重启后续接；每轮独立通知与双线程路由；`needs_input → answer → continue` |
| `test/integration/cli.test.ts` | `spawn --persistence persistent` + `continue` |
| `test/integration/mcp.test.ts` | `worker_continue` 工具与生产响应字段 |
| `test/integration/mcp-modes.test.ts` | production 响应键集合与既有语义 |
| `test/unit/daemon-lock.test.ts` | 死 PID 回收、PID 复用识别、真实存活锁拒绝回收、损坏锁保守拒绝 |
| `test/fixtures/fake-harness.ts` | `[scenario:recall]` 模拟跨 Turn 上下文回读 |

最终全量结果：**386 tests，384 pass，0 fail，2 skipped**（0.9 RC 收尾轮，2026-11-09，含审计修复与新增回归；约 10 分 59 秒）。2 项 skipped 是需 `RUN_REAL_PI=1` 才执行的真实付费 Pi 测试；其余覆盖 Phase 1-4、admin、compaction、MCP/CLI 与存储回归。修复完成后的四条真实 Harness 3 轮复跑全部通过，证据见 `evidence/persistent-worker-261109/`；审计与发布判断见 `docs/2026-11-09-hs-0.9-release-candidate.md`。

## 5. Phase 0 安全项

`daemon.lock` 已改为保守身份校验：

- PID 已退出：视为陈旧锁，正常回收。
- PID 存活但命令行不含该 `stateDir` / `daemon-entry` / `harness-supervisor` 特征：判定为 PID 复用，回收。
- PID 存活且身份匹配，或命令行无法读取、无法核实：拒绝回收并返回 `INVALID_STATE`。
- 锁文件损坏或不可解析：拒绝回收，要求人工确认后再删除；避免在另一个 Daemon 写入锁的瞬间误删。

331 MB 生产实例验证仍受本机环境限制，未执行。

## 6. Phase 3-4 增量

| 能力 | 实现 |
| --- | --- |
| 每轮独立通知 | 已有 `workerId#seq` 机制；新增双 Worker 双线程多轮测试，验证每轮一条通知、目标不串线 |
| `needs_input → answer → continue` | 自动化闭环：持久化 Worker 提问、回答、完成后继续同一 session |
| Pin | `pinned` 字段；`prune` 跳过；`forget` 拒绝 |
| Archive | `archived` 字段；默认 `list` 隐藏，`includeArchived` 可见；身份与 session 保留 |
| Retire | `retiredAt` 字段；`lifecycle=retired`；阻止 continue/resume，可 `unretire` |
| Forget | 删除 HS 记录与事件；拒绝 active、orphaned、pinned、未确认通知；native session 文件保留 |
| 存储诊断 | `info.storage`：eventBytes、最大事件文件、active/idle/other 数量、启动阶段耗时 |
| 取消/失败后继续 | 自动化：取消或失败的 persistent Turn 后可继续同一 session；真实 Harness 的三轮连续性证据见 Phase 2 |
| 事件压缩 | `compact [workerId] [--keep-progress N] [--dry-run]`：保留全部非进度事件、最新 N 条进度和最后一条事件；原子重写，seq 不变，`compacted` 标记区分有意缺口 |
| Daemon lock | 存活 PID 命令行指纹校验；PID 复用可回收；无法核实或损坏的锁拒绝回收 |

事件压缩只处理终态、未 pin、非 orphaned 且没有运行中进程的 Worker。压缩后的文件启动时仍可走 checkpoint 快路径；`readEvents`/`scanEvents` 读取剩余事件，`worker.compacted.retainedFromSeq` 标明保留范围，通知重建与状态查询不受影响。测试覆盖 dry-run 不写盘、旧进度被裁剪、生命周期事件与最终结果保留、restart 不误报历史损坏、persistent Worker 压缩后继续同一 session。

未做：ResultRef 单份权威存储、显式 `storage check` 命令、原生 Session 删除。`forget`、`prune` 与 `compact` 都不触碰 native session。

## 7. 未完成与风险

- Phase 0：本机无 331 MB 生产状态目录，未做生产冷启动实测；两个既有存储提交与本次改动均未合并、未推送。
- Phase 3：多 Codex Thread 各一名 Persistent Worker 的桌面唤醒闭环未验证（自动化已覆盖通知生成、线程目标隔离与 `needs_input → answer → continue`）。
- Phase 4：事件压缩、存储诊断与安全清理已实现；ResultRef 单份权威存储与显式 `storage check` 尚未实现。
- Phase 5：原生 Session list/fork/delete、跨 Worker attach/Lease 未实现。
- Task 机制按用户要求暂缓；未引入 SQLite。
- 回滚：全部改动集中在工作树，未触碰生产 Daemon；回滚本次改动即可恢复 0.8.0 行为。

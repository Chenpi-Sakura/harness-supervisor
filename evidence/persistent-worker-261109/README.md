# Persistent Worker 与旧状态兼容证据（2026-11-09）

- 机器：Windows 10.0.26300 x64，Node v24.22.1
- 代码：`feat-261109-hs-09`，验收时版本 0.8.0（发布版本 0.9.0，仅版本号变更）
- 范围：真实 Harness 3 轮连续协作；真实 0.8.0 Daemon 状态由 0.9 RC Daemon 打开
- 未包含：Codex Desktop Stage 1/2（另行记录于 `evidence/desktop-stage1-2-261110/`）、331 MB 生产状态目录（本证据未访问；后续 2026-11-10 已在目标生产环境补验，见 `docs/2026-11-10-0.9.0-production-deployment.md`）

## 1. 四个 Runtime 的真实 3 轮协作

命令：

```bash
node scripts/e2e-persistent-pi.mjs --runtime pi
node scripts/e2e-persistent-pi.mjs --runtime qoder
node scripts/e2e-persistent-pi.mjs --runtime mcode
node scripts/e2e-persistent-pi.mjs --runtime dsh
```

每个脚本使用独立临时状态目录和工作目录。Turn 1 / Turn 2 分别引入随机口令，Turn 3 要求在不重发口令的情况下回忆两者；口令只存在于 native session 中。

| Runtime | 真实版本 | Worker | Session | 关键结果 | 证据 |
| --- | --- | --- | --- | --- | --- |
| Pi | 1.4.0 | `w-mw996096-57b21ada` | `01a1c056-360f-730d-9d2b-632142cb0e13` | 3 轮 completed/idle；同 Worker 同 Session；两个口令均回忆；每轮 `pidAlive=false`；`resumeCount=2` | [run-pi.json](run-pi.json) |
| Qoder CLI（ACP） | 1.1.82 | `w-mw99699n-93f73f35` | `43255c59-774c-4fd9-a33c-97a43f24d739` | 同上 | [run-qoder.json](run-qoder.json) |
| MiniMax Code | 0.7.0 | `w-mw9974la-a819cf5c` | `mvs_61e09fd258e54f1288b062fc35d66153` | 同上 | [run-mcode.json](run-mcode.json) |
| DSH | 桌面捆绑 0.2.1-rc.5 | `w-mw997q5i-26bce24a` | `fe4130ed-5c4a-437c-b3e4-6f9cabab3bcc` | 同上 | [run-dsh.json](run-dsh.json) |

四个证据文件的 `assertions` 全部为 `true`：`turn1Completed`、`turn1Idle`、`turn1Session`、`sameWorker`、`sameSessionAfterTurn2`、`turn2Completed`、`sameSessionAfterTurn3`、`contextHadNonceA`、`contextHadNonceB`、`turn3Idle`、`allProcessesExited`、`resumeCount`。

这些运行验证了 Adapter + Supervisor 的连续会话能力，没有经过 Codex Desktop Master 回合，因此级别为 L3。

## 2. 真实 0.8.0 状态兼容

步骤：

1. 从 `main@7649b34` 创建 detached worktree，构建 0.8.0 Daemon。
2. 在临时状态目录启动旧 Daemon，用旧 CLI spawn 一个 Workers（假 Pi Harness），得到 `w-mw98z9yv-6408f3dc`，session `d362da62-dfd4-47d9-9b81-97bfe571b74a`，收件箱 ID `w-mw98z9yv-6408f3dc#11`。
3. 停止旧 Daemon，用 0.9 RC Daemon 打开同一状态目录。

结果：

| 检查 | 结果 |
| --- | --- |
| 启动 | 1 个 Worker，0 warnings，首次全量扫描后写入检查点（28 ms） |
| 读取 | `persistence=oneshot`、`lifecycle=idle`、session 可恢复、结果 `FAKE_PI_OK` 可读 |
| `continue` | `UNSUPPORTED`，说明按照 oneshot 处理，没有创建替代 Worker |
| `resume` | 同一 session 恢复并完成 `RESUMED FAKE_PI_OK`；`resumeCount=1`，`turns=2` |
| 通知 | 收件箱保留 `#11`，resume 后新增 `#24`；重启后 ID 稳定、无重复 |
| 第二次启动 | `checkpointed=1, scanned=0`（23 ms），走检查点快路径 |

完整数值见 [legacy-state-probe.json](legacy-state-probe.json)。旧 worktree 与临时状态目录在采集后已删除，生产状态目录未被读取或修改。

## 3. 未覆盖

- Codex Desktop Stage 3 的 Thread 卸载/退出行为（Stage 1/2 已另行验证：`evidence/desktop-stage1-2-261110/`）。
- 331 MB 生产状态目录的启动与分页性能（后续 2026-11-10 已在目标生产环境补验，见 `docs/2026-11-10-0.9.0-production-deployment.md`）。
- 新状态回滚到旧 Daemon（降级）未测试；使用过 `compact` 的状态在旧 Daemon 下可能被报告为历史断档。

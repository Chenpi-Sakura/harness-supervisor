# Worker 写入约束与命令护栏（2026-10-28）

对应实现：`src/worker-protocol.ts`、`src/worker-guard.ts`、`src/codex-guard.ts`。
对应规范：`AGENTS.md` §3「Worker 报告协议」；使用说明见 `README.md`「Worker 报告协议与命令守卫」。

## 验证了什么

| 项 | 方式 | 结果 |
|---|---|---|
| 任务提示前置协议块 | Pi 夹具把实际收到的 prompt 写入 session 文件；测试读取首条 user 消息 | ✅ 以 `[harness-supervisor:worker-protocol]` 开头，原始任务完整保留 |
| `codex queue` 被拒绝 | Worker 进程执行 `codex queue ...`（真实 cmd/sh，经 Worker PATH 解析） | ✅ 退出码 2，工具 stderr 含拒绝说明，结果不含真实 CLI 输出 |
| 拒绝可归因 | 读取 `<stateDir>/worker-guard/worker-guard.jsonl` | ✅ 记录 `codex_queue_denied`、workerId、argv、cwd |
| 其他子命令转发 | Worker 执行 `codex --version` | ✅ 真实（夹具）CLI 返回 `FAKE_CODEX_OK`，参数到达 |
| Daemon 自身不受影响 | 护栏只注入 Worker 的 `HarnessSpawnSpec.env`；Daemon 的 `process.env` 未修改 | ✅ 代码路径 + 既有通知测试全部通过 |
| 绝对路径可绕过 | Worker 用真实 CLI 的绝对路径执行 `queue` | ✅ 成功执行；不产生 denial 记录（证明不是安全边界） |
| 未找到 Codex 时不阻断 Worker | 空 PATH 下 `prepareWorkerGuard` 返回 null | ✅ 单元测试 |
| 缺少真实路径时不递归 | 清空 `HARNESS_SUPERVISOR_REAL_CODEX` 后调用 shim | ✅ 退出码 127 + `misconfigured` |

原始输出：

- `worker-write-guard-unit-261028.txt`（4 个单元测试）
- `worker-write-guard-integration-261028.txt`（1 个集成测试，含拒绝、转发、绕过与协议前缀）

## 复现

```powershell
# 隔离构建，不重建生产 dist
npx tsc -p tsconfig.json --outDir .smoke-phase2/dist
Copy-Item test/run.mjs .smoke-phase2/test/run.mjs -Force
Copy-Item test/fixtures/*.mjs .smoke-phase2/test/fixtures/ -Force
node .smoke-phase2/test/run.mjs unit --test-name-pattern "worker protocol|prepareWorkerGuard|codex shim|shim refuses"
node .smoke-phase2/test/run.mjs integration --test-name-pattern "worker command guard"
```

## 边界与未验证

- **不是安全边界**：同一 OS 用户下，绝对路径、其他宿主写入接口、修改 `PATH`/覆盖 shim 均可绕过；上面的绕过用例就是证据。
- **不是模型行为验证**：使用脚本化 Pi 夹具执行真实 shell 命令，验证的是环境注入、PATH 解析与拒绝逻辑；没有让真实模型自主决定是否调用 `codex queue`。
- **Pi 已验证；Qoder 与 MiniMax Code 未单独验证**：两者复用同一 `HarnessSpawnSpec.env` 注入路径，但其内部工具 shell 是否按 PATH 解析 `codex` 尚未实测。若其工具使用绝对路径或自有执行器，护栏可能不生效，协议块仍然生效。
- 协议块是提示词约束，不是强制；Worker 可以不遵守，护栏只能覆盖 `codex queue` 这一条路径。
- 护栏只在 Daemon 启动时解析一次真实 Codex 路径；Codex 之后安装或移动，需要重启 Daemon 才会更新。
- 拒绝日志是独立 JSONL，不是 HS 事件；它不参与通知、ACK、重试或 `prune`。
# v0.2.0 主目录发布验收（2026-10-23）

交付目标为 GitCode `main` 中的源码，其他电脑从 README 中的地址 clone 后执行 `npm ci`、`npm run build`，再将 MCP 配置指向本机 clone 的绝对路径。运行时不依赖 `.smoke-routing-dev`，构建产物、本机状态和原生 Harness 凭据不提交。

## 实际执行与验证

- HS Pi 开发 Worker `w-mvkel4ks-fb141e1c` 完成主目录 squash 合并、版本同步及文档，随后在重复回归中触及 30 分钟上限，状态为 cancelled；负责人接手剩余验收，没有将其取消状态当成功。
- `7161077`：Worker 通知路由、事件历史和幂等可靠性以单个功能提交进入 `main`；`package.json`、锁文件根包和 `src/version.ts` 均为 `0.2.0`。
- 发布复跑暴露 Windows `worker.json` 原子 rename 的间歇性 `EPERM`。补充修复 `b033c4b` 只对 Windows 的 `EPERM` / `EACCES` / `EBUSY` 最多重试 8 次，总退避约 1.1 秒；不删除旧记录，持续失败仍传播错误。失败遗留的唯一临时文件沿用既有行为，可供诊断。
- 真实 Windows 文件锁测试 3/3 通过：完整替换、短暂占用后恢复、持续占用时失败且旧记录完整。独立审计另行复跑 3/3，通过且无阻塞问题。
- 修复后完整 `npm test`：146 项，144 通过，2 项真实 Pi 测试按默认环境开关跳过，0 失败。原始输出见 [automated-tests.txt](automated-tests.txt)。`npm run typecheck` 与 `git diff --check` 通过。
- 本机独立干净克隆执行 `npm ci --no-audit --no-fund`、build、typecheck 成功，CLI 为 `v0.2.0`；独立状态目录中的 MCP 握手确认服务版本 `0.2.0`、13 个工具、`worker_spawn.notifyTarget` 和 `workerRouting=true`。这是同一 Windows 宿主的干净目录验证，不冒充另一台物理电脑的实测。
- 确认生产状态目录无活动 Worker 后，备份配置与完整状态，再停止开发路径 Daemon，从主目录启动 `v0.2.0`。状态目录保持不变，未重跑旧任务，回退备份保留在本机 `~/.codex/hs-upgrade-backups/`。
- 从主目录真实 MCP 启动 Pi Worker `w-mvkg25pg-9e08b6c6`，完成实际文件写入，负责人读回 `HS_V020_MAIN_OK`，并确认其完成通知；详情见 [runtime-proof.json](runtime-proof.json)。

## 宿主限制与边界

本机 Codex 配置已指向主目录 `dist/src/mcp.js`。尝试使用公开 `config/mcpServer/reload` 时，`codex app-server proxy` 连接宿主控制套接字失败（Windows `10050`），所以不能宣称已刷新所有加载的 MCP 进程。已加载的旧客户端需在设置中的 MCP servers 对 HS 执行 Restart；主目录新 MCP 与新 Daemon 已通过实际握手和执行验证。没有修改宿主私有数据库，也没有强行终止其他会话的客户端。

双 Codex 会话主动唤醒及原生输入闭环的真实证据继续见 [Worker 路由验收](../worker-routing-261023/README.md)。本次主目录切换没有重跑双会话测试；只覆盖宿主保持 Thread 加载的结论仍然适用。Qoder 的既有真实交互限制、`wait` 类型过滤只扫描首 500 条的 P2、at-least-once 通知边界均未变化。

## 远程与跨机器核对

主仓库为 `https://gitcode.com/chenpi_1/harness-supervisor.git`，发布分支为 `main`。可用 `git ls-remote origin refs/heads/main` 与本地 `git rev-parse main` 比对；全新 clone 按 README 的命令构建。开发分支保留供追溯，不需要复制开发工作树、私有状态或用户凭据。

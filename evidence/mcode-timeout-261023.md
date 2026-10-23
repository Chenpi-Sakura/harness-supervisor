# MiniMax Code 长回合超时修复（0.4.1）

## 真实问题

2026-10-23，MiniMax Code 0.6.12 经生产 HS 0.4.0 启动自验 Worker `w-mvkwgs9e-4f3929b5`。原生权限请求成功传回并回答，但任务于 seq 674–676 失败：`MiniMax Code request timed out after 120000ms: session/prompt`。失败前仍有原生工具与权限事件，不能视为正常完成。

ACP 的 `session/prompt` 覆盖整个原生回合，包括权限等待；适配器错误地复用了普通控制 RPC 的 120 秒超时。

## 修复

- 仅对 `session/prompt` 取消短 RPC 超时。初始化、steer 等控制请求仍有超时；进程退出、主动取消和 Supervisor `maxDurationMs` 继续约束任务。
- 权限请求向 Master 保留经过脱敏的实际 `rawInput`，避免仅凭代理生成的标题判断；不改变原生 Allow once / Always allow / Deny 选项。
- package、lockfile 和运行版本统一为 0.4.1。

## 自动化验证

在隔离工作树运行 `npm run build`、`npm run typecheck`，均通过。执行 `node --test dist/test/unit/mcode-acp-session.test.js dist/test/integration/mcode.test.js`：30 项通过，0 失败。

新增回归覆盖：超过控制 RPC 时限的待审批回合仍可继续；无响应的 steer 仍会超时且不结束主任务；完整实际权限参数保留；无短 RPC 超时的任务仍由 Supervisor maxDuration 取消。已有取消、恢复、反向请求编号隔离等测试继续通过。

上述回归使用协议桩，不等同于真实 MiniMax 长任务完成。真实自验必须在升级后恢复原 Worker 继续验收，本记录不宣称其已通过。

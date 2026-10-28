# Codex 消费前 ACK Hook 移除记录（2026-10-28）

## 移除范围

- 源码：`src/codex-notification-gate.ts`、`src/codex-notification-hook.ts`、`src/install-codex-notification-hook.ts`
- 测试：`test/unit/codex-notification-gate.test.ts`、`test/unit/codex-hook-install.test.ts`
- 脚本：`scripts/e2e-codex-ack-gate.mjs`
- 文档：`docs/codex-ack-gate.md`
- `package.json` / `package-lock.json` 的 `harness-supervisor-codex-hook`、`harness-supervisor-install-codex-hook` bin 入口

保留：收件箱、通知 ID、ACK、重试、投递前失效检查、`supervisor_notifications(includeDelivery=true)`。未新增服务、消息总线或第二套状态机。

## 验证

- 全新输出目录构建（避免旧 `dist` 残留）：`npx tsc -p tsconfig.json --outDir .smoke-phase4/dist`，退出码 0。
- 该目录 `dist/src` 中已没有 `codex-notification-*` 文件（只有 `codex-guard.*`）。
- 单元测试：161/161 通过（Hook 测试已随源码删除）。
- 通知集成：`notify.test.js` + `notification-binding.test.js`，17/17 通过。
- `package.json` 有效，`bin` 只剩 `harness-supervisor` / `harness-sup`。

## 生产配置（未修改）

本机 `C:\Users\Lenovo\.codex\hooks.json` 仍包含：

```json
{
  "type": "command",
  "command": "node 'D:\\Projects\\Harness-Supervisor\\dist\\src\\codex-notification-hook.js' --state-dir 'C:\\Users\\Lenovo\\.harness-supervisor'"
}
```

按任务要求**没有修改**该文件。当前生产 `dist` 也未被重建，因此旧文件仍存在，hook 暂时仍可运行；下一次干净构建后该入口会消失。迁移步骤已写入 README：停止并保护 Daemon → 在 `/hooks` 禁用或手动删除该 `UserPromptSubmit` 组 → `npm run clean` → `npm run build`。

## 限制

- `tsc` 不会删除已移除源文件对应的旧产物；必须 `npm run clean` 才是真正的干净构建。清理会删除整个 `dist`，不能在运行中的生产 Daemon 上直接执行。
- 已入队/已接受的 Codex 消息仍不能由 HS 撤回；移除 Hook 只去掉了“消费前拦截”能力，收件箱与 ACK 语义不变。
- 本次未做真实 Codex 桌面端回归；Hook 能力已移除，不再宣称消费前拦截有效。
# Codex 当前对话自动绑定：协议调查与真实运行证据（2026-10-28）

## 结论

Codex 0.161.0 会在每次 `tools/call` 的 `params._meta` 中提供：

```json
{
  "threadId": "01a181d6-...",
  "sessionId": "01a181d6-...",
  "windowId": "01a181d6-...:0",
  "x-codex-turn-metadata": {
    "thread_id": "01a181d6-...",
    "turn_id": "01a181d6-...",
    "model": "gpt-6-luna",
    "turn_trigger": "exec"
  }
}
```

`initialize` 只有 `clientInfo = {name:"codex-mcp-client", title:"Codex", version:"0.161.0"}`，不含 Thread ID；MCP server 进程环境也没有 Thread ID。因此自动绑定只能使用**逐次工具调用**的 `_meta.threadId`，不能使用进程环境、最近会话或全局默认值。

`codex-meta-probe.jsonl` 是用一个最小 MCP probe server 通过真实 `codex exec` 抓到的原始记录；`thread.started` 的 thread_id 与 `_meta.threadId` 完全一致。

## 真实运行（单对话）

- Codex：`codex exec`，thread `01a181d9-43d6-7512-af49-4b5512f9fb3f`。
- HS：隔离 state 目录，0.6.1，MCP production，Pi 夹具 Worker。
- 工具调用只有 `worker_spawn` 一次；未调用 `worker_wait` / `worker_status` / `worker_events`。
- 返回：

```json
{
  "notifyTarget": {
    "channel": "codex-queue",
    "codexThreadId": "01a181d9-43d6-7512-af49-4b5512f9fb3f"
  },
  "notificationBinding": {
    "source": "caller",
    "wake": "bound",
    "observation": "wake",
    "warnings": []
  }
}
```

- Worker `w-mvrx0ccw-4856efeb` 完成，结果 `FAKE_PI_OK`；持久化绑定仍指向该 thread。
- 原始输出：`codex-e2e.jsonl`、`worker-list.json`、`worker-status.json`。

## 自动化覆盖

`test/integration/mcp-auto-binding.test.ts`：

- A/B 两个 Thread ID **并发** Spawn，各自绑定，不串线；
- 同一对话多个 Worker 各自保存目标；
- 显式 `notifyTarget` 覆盖自动绑定；
- 已识别的 caller 优先于 daemon 全局默认；
- 无 `_meta` / 非法 UUID → `daemon-default` + warning；
- resume 省略目标保留原绑定，显式目标才接管；
- 同一 `requestId` 的 spawn 重放返回**首次接受时**的绑定快照，不返回之后被 resume 改写的目标；
- 无 `_meta` / 非法 UUID → `daemon-default` + warning；非法或冲突的 `_meta` 即使 fallback 可唤醒也会警告；
- MCP 客户端断开重连、Daemon 重启后绑定仍正确；
- `_meta.threadId` 与 `x-codex-turn-metadata.thread_id` 冲突时拒绝猜测。

### 旧 Daemon 兼容

`callerThreadId` 是 0.6.1 新增 IPC 字段。MCP 在启动时缓存 daemon 版本，只有 >= 0.6.1 才发送该字段；0.6.0 及更老的 daemon 仍可 `worker_spawn`，不会因严格 schema 拒绝而失败，返回的 `notificationBinding` 会附带 “predates caller auto-binding” 警告。`mcp-modes` 中用 0.6.0 fixture 固定了“不发送新字段且 spawn 仍成功”的行为。

### 审查修正

独立审查发现 1 个阻断问题和若干非阻断问题，均已在提交前修复并复测：

- **阻断**：0.6.1 MCP 向 0.6.0 daemon 发送 `callerThreadId` 会触发严格 schema 拒绝。改为按 daemon 版本门控，旧 daemon 只收到原有字段，并返回升级提示。
- 重放 `requestId` 时恢复首次接受快照，避免把 resume 后的新目标误报给原始调用；
- 非法/冲突 `_meta` 即使 fallback 可唤醒也追加警告；
- 文档中的 `source`、优先级和长任务建议同步到实现；
- 撤销与自动绑定无关的 `worker_cancel` 默认超时改动（保持 20s）。

### 最终回归

2026-10-28 在最终工作树运行完整 `npm test`：

```text
tests 291
pass 289
fail 0
skipped 2
duration_ms 663301
```

原始输出：`full-regression.txt`（2 个 skip 是需要显式 `RUN_REAL_PI=1` 的真实 Pi 付费测试）。

## 剩余验证（需两个真实 Codex Desktop 对话）

本证据使用 `codex exec`（真实 Codex MCP client），不是 Desktop UI。Desktop 两对话的最终验收步骤见交付报告；必须由用户在真实 Desktop 会话中执行，不能用 CLI 结果冒充 Desktop UI 验收。

## 边界

- `_meta` 是宿主提供的路由提示，不是加密认证；HS 只校验 UUID 格式和重复字段一致性。
- Codex 版本/客户端若不发送 `_meta.threadId`，HS 退回 daemon 默认并明确警告，不猜测。
- 自动绑定只影响 `worker_spawn`；`worker_resume` 不自动改绑。
- 绑定成功不等于一定唤醒；`codex-queue` 投递仍是 at-least-once，且要求宿主加载目标 thread。
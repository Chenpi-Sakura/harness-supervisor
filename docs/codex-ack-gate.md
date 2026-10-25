# Codex 已 ACK 通知的消费前过滤（0.4.4）

## 解决什么

`codex queue` 接受消息后，HS 的业务 ACK 不能撤回它。0.4.3 的投递前失效过滤不覆盖“先入队、后 ACK、再消费”。本功能提供可选的原生 `UserPromptSubmit` hook：在提示进入模型前读取持久化 ACK，拦截已处理的通知，避免额外模型查询和回复。

它不删除聊天记录、不伪造 delivered/ACK，也不承诺不创建空回合或不显示界面条目。Codex 可能显示 `Blocked by hook`；当前公开 hooks 文档说明 `suppressOutput` 尚未实现。

## 在发生问题的电脑启用

先按 README 的生产升级流程拉取和构建，保护活动 Worker，不在运行中的生产 dist 上直接构建。随后在**固定生产仓库目录**运行：

```powershell
# 默认只打印拟安装定义，可先核对
node dist/src/install-codex-notification-hook.js

# 合并到当前 CODEX_HOME/hooks.json；已有文件先备份，不替换其他 hooks
node dist/src/install-codex-notification-hook.js --install
```

自定义目录使用 `--codex-home <Codex配置目录>`、`--state-dir <HS实际状态目录>`。HS 状态必须指向这台电脑的实际通知收件箱，不能指向开发测试目录。安装器保留其他 hooks，重复运行相同定义不会重复添加；无效配置直接报错，不覆盖。

如果已安装 HS hook 的入口或状态目录改变，安装器拒绝再追加一个不同副本；请先在 `/hooks` 核对旧定义，再决定替换。不能把两个指向不同状态目录的定义悄悄叠加。

在该电脑的 Codex CLI 使用 `/hooks` 检查并信任新增的 HS `UserPromptSubmit` 定义。必要时重新加载桌面会话，使它读取已审查的定义。Codex 对非托管 hook 要求精确定义的信任确认；安装器不授予信任，也不更改沙箱或关闭权限保护。**不要把测试脚本的 `--dangerously-bypass-hook-trust` 放进生产启动参数。**

过滤器兼容 0.4.3 的通知状态文件，保留原有 ACK 工具；不需要搬迁状态目录。它是可选的宿主接入能力，未启用时 HS 的既有推送行为不变。只升级 Daemon、未安装并信任 hook，不能解决已入队消息的消费问题。

停用时在 `/hooks` 禁用该定义，或从 hooks.json 删除安装器添加的单组 `UserPromptSubmit`，保留其他定义；必要时可核对安装器输出的备份文件。不要为回退覆盖其他人之后新增的 hooks。

## 判定与边界

- 只识别 HS 自身的完整短指针格式，按 `workerId#seq` 查找；同 Worker 的其他 seq 不受影响。
- 要求通知类型和目标 `codexThreadId` 与 hook 的原生 `session_id` 一致；不猜最近会话。
- 通知目标应绑定已核实的会话 UUID；会话名称不会由过滤器自动反查为 UUID。Codex 启动环境中须能运行 Node（安装器生成的命令使用 `node`）。
- 只有持久化 ACK 确认时才返回原生 `decision: block`。未 ACK 的重试仍允许，避免把一次未完成处理永久吞掉；不宣称 Exactly Once。
- 非 HS 输入、引用后的问题、未知记录、目录不匹配、无法读取状态等均放行；普通提示不查询 HS、不添加模型上下文。
- hook 只读取通知，不启动 Daemon、不读取 IPC token、不重新执行 Worker、不改写 ACK。检查日志写入状态目录下 `notification-gate.jsonl`，记录完整通知 ID、目标会话、turn、`checkedAt`、ACK 时间和判定。
- `checkedAt` 表示这次消费前检查，不冒充 UI 的 `consumedAt`；检查后其他 hook 仍可能拦截，因此 allow 也不证明模型已经执行。
- 当前只处理单条完整指针。若宿主把多条新旧消息合成一个提示，选择放行整批，不为丢弃旧事件而误吞新任务。选择性删除界面消息需要宿主另行支持。
- 手工需要重新讨论一条已 ACK 通知时，请附加问题或引用消息，不要只提交一条完全相同的 HS 短指针。

## 投递时序诊断

production MCP 默认仍精简；需要排查时显式调用：

```json
{"workerId":"<workerId>","state":"all","includeDelivery":true}
```

工具是 `supervisor_notifications`。返回 createdAt、ackAt、完整 delivery、目标快照。新增 `dispatchPreparedAt`（最后一次 ACK 检查前准备）、`lastAttemptStartedAt` / `lastAttemptFinishedAt`（实际开始/返回）、成功时的 `enqueuedAt`；后者是 CLI 报告接受的本机时间，不是 UI 消费时间。只准备后就被 ACK/失效检查跳过，不会记成实际启动。旧 `lastAttemptAt` 保留其 CLI 返回时间语义。历史记录中不存在的字段不会推算或补造。

读取超时/异常会放行；审计追加采用 best-effort 的短中止信号，不能将它当作硬实时保证。`notification-gate.jsonl` 当前不自动清理，长期日志保留仍列入 backlog，不能声称任意文件系统故障下都绝不会出现冗余。

也可以使用 CLI `inbox --state all --worker <id> --json`。新日志分别记录队列接受与业务 ACK，并保留通知 ID、尝试次数和回执 ID。一次通知可能有多行追加更新，不等于多次业务事件或多次入队。

## 验证范围

单元与模拟队列覆盖：ACK 后旧指针被拒、同 Worker 新 seq 放行、同 ID ACK 后重复消费、未知/损坏/未绑定记录、普通提示与跨会话不误拦、安装备份/幂等/不授予信任、重启不重投已 ACK 事件。

本机 Windows / Codex CLI 0.161.0 已完成真实 TUI + `codex queue` 回归：维持当前回合 → 入队 #445 → 持久化 ACK → 结束当前回合 → hook 拦截旧消息；#445 未触发模型端请求。随后同 Worker 的未 ACK #714 正常到达模型端。模型端为本机替身，HS 通知状态为受控夹具，这不是实际模型质量测试，也不冒充对另一台电脑 0.162.1 Desktop 的验收。

可复核脚本 `scripts/e2e-codex-ack-gate.mjs` 仅支持 Windows 交互终端，要求 Codex 已完成沙箱配置；设置 `CODEX_CLI_ENTRY` 指向本机 npm Codex 的 `bin/codex.js`，可设置 `HS_ACK_EVIDENCE_DIR` 保存证据。运行前构建；出现更新提示选择跳过，然后输入一次 `HS_LOCAL_HOLD` 并提交。脚本只操作自己的测试会话、临时 profile、隔离通知夹具和本机模型端，不更新 Codex、不修改生产 HS。

正式原生测试通过后不继续反复运行收费模型。早期命令引号探测曾有一次 6-luna/low 实调用（20659 输入、其中 9216 缓存、15 输出）；后续及正式原生队列回归使用本机模型替身。不能把单条提示的零额外请求等同于已测量整体任务 Token 节省。

官方能力依据：[Hooks](https://learn.chatgpt.com/docs/hooks)、[Developer commands](https://learn.chatgpt.com/docs/developer-commands)。

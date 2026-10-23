# 0.4.3 通知与最终结果降噪验收

## 交付范围

通知增加投递前有效性检查、每 Worker 默认 1 秒短窗口和短指针正文。失效的未投递请求标为 `superseded`，不伪造 delivered 或消费者 ack；默认待办视图排除失效请求，显式历史与事件仍可核对。消息已被 Codex queue 接受后无法撤回。

MiniMax Code 按原生 messageId 提取最后一条消息；同消息分块完整重组，较早播报留在进度事件中。不对报告增加固定字数上限，既有 maxResultBytes 仍有效。无 messageId 的旧协议只能按工具调用边界分离，不能保证识别连续流中的多条匿名发言。

## 独立审阅

通过生产 HS 委派 Pi Worker `w-mvkxvppy-e5be4518` 实现通知部分，主 Agent 独立实现结果提取并审阅实际代码。补齐取消进行中、resume 后快速终态、撤回请求、在途投递与收件箱读取竞态；没有引入额外模型审批代理、消息服务或后台模型轮询。

纠正 Worker 报告中“真实 Pi / 真实 mcode 撤回”的表述：通知自动化集成用例运行真实 Daemon/IPC，但底层 Harness 与 Codex queue 是协议桩，不能冒充原生模型和桌面唤醒 E2E。另保留旧 Daemon 不含 superseded 计数的样本，将新增字段设为可选，防止兼容性测试被新格式样本掩盖。

## 自动化验证

在独立工作树运行 `npm run build`、`npm run typecheck`、脚本语法检查及 `git diff --check`，通过。

独立完整回归：`node test/run.mjs`，225 项，223 通过，2 跳过，0 失败，约 330 秒。默认未启用的收费真实 Pi 测试跳过，不计为通过。涵盖 Pi/Qoder/mcode 协议、生命周期与竞态、MCP 两种呈现模式、旧服务兼容、通知路由、重启/重试/ack、历史事件及幂等。

修正旧版本硬编码断言，MCP 实际返回版本与当前 VERSION 核对。完整回归日志保留在本机忽略文件 `.smoke-noise-full-suite.log`，不提交私人原始会话。

## 真实 MiniMax 验证

真实 MiniMax Code 0.6.12，独立 Daemon/state/cwd，在用户已授权的 Full access 模式下先发送过程标记、执行工具写入文件、再发送最终标记。核对：文件为 FINAL_TOOL_OK；过程事件包含 NOISE_PROGRESS_ONLY；最终结果严格为 FINAL_REPORT_OK。结果见 `mcode-final-message-261023.json`，方法与限制见 `result-noise-261023.md`。

## 成本与边界

本次减少重复通知正文和投递前已失效的提醒，不以通知字符数冒充实测 Token 节省。不同真实待办仍各自提醒，不能保证每个 Worker 永远只唤醒一次。通知窗口可通过 HARNESS_SUPERVISOR_NOTIFY_DELAY_MS 调整为 0—60000ms；不改变权限策略或通知绑定。

生产实例升级前必须没有活动 Worker，备份 dist/config/state；升级后保留本机既有 Full access 配置。本轮新短消息的真实宿主投递烟测另行记录，自动化桩结果不代表桌面实际新回合唤醒。

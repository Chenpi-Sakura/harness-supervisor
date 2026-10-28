# Qoder Worker 权限模式修复与真实验证（2026-10-28）

## 根因

- 本机 `~/.qoder/settings.json` 的 `general.defaultPermissionMode` 为 `bypass_permissions`。
- 修复前 HS 的 `resolveQoderPermissionMode()` 在未显式配置时返回 `auto`，并拒绝 `bypass_permissions`。
- `buildArgs()` 每次启动都显式传入 `--permission-mode auto`，因此用户配置被覆盖。
- `auto` 模式依赖 Qoder 的自动权限判断服务；该服务不可用（403 `CALL_COUNT_LIMIT`）时，Qoder 退化到逐项询问。HS 侧只看到 `run.needs_input`，无法区分这是用户真正需要决策还是权限服务失败。

## 真实环境

- Qoder CLI：`C:\Users\Lenovo\.qoder\bin\qodercli\qodercli.exe`，版本 **1.1.79**。
- `qodercli --help` 显示 `--permission-mode` 的 choices 为 `bypass_permissions, dont_ask, auto`；同时提供 `--dangerously-skip-permissions`。

## 修复

- 默认值改为 `bypass_permissions`；`bypass`/`yolo` 映射到该值；显式环境变量仍然优先。
- 优先级：`QoderAdapterOptions.permissionMode`（嵌入/测试） > `HARNESS_SUPERVISOR_QODER_PERMISSION_MODE` > 默认 `bypass_permissions`。
- `system/init` 返回的实际 `permissionMode` 与请求不一致时，启动直接失败并报告 requested/effective，不静默回退到 `auto` 或逐项审批。
- 真实运行发现 Qoder 在 init 中回报 **camelCase**（`bypassPermissions`），而命令行使用 snake_case（`bypass_permissions`）。首次真实启动因此被误判为降级；现已用归一化比较修复（`sameQoderPermissionMode`），并补了回归。

## 真实运行证据

环境：独立 state 目录 `hs-qoder-e2e-be23484c`，独立临时工作目录，`HARNESS_SUPERVISOR_QODER_PERMISSION_MODE` 未设置，`--notify-none`。

启动参数（运行中从 `Win32_Process` 读取，见 `process.txt`）：

```text
qodercli.exe --print --output-format stream-json --input-format stream-json
  --permission-prompt-tool stdio --permission-mode bypass_permissions
  --session-id 52977824-37c0-4f98-abf7-beb0359a5803
```

`system/init` 记录（`events.json` 的 seq=2）：`DeepSeek-Flash (bypassPermissions)`。

任务：在临时目录创建 `hs-qoder-permission-check.txt`，内容为 `QODER_BYPASS_OK`，然后读回。

结果：

- Worker `w-mvrnpdge-f7c65da9` 状态 `completed`，exit 0；
- `toolCalls=2`、`toolErrors=0`；`run.needs_input` 数量 **0**；
- `events.json` 中有写文件与读文件的 `tool_start`/`tool_end`，没有权限询问；
- 文件实际内容为 `QODER_BYPASS_OK`（`hs-qoder-permission-check.txt`，15 字节）；
- 最终答复：`File created and read back successfully. Content: QODER_BYPASS_OK`。

首次真实运行（归一化修复前）：HS 以 `bypass_permissions` 启动，init 回报 `bypassPermissions`，HS 因严格比较不等而拒绝启动（`UNSUPPORTED`）。这证明“不一致即失败”的护栏生效，也暴露了命名差异。

## 自动化验证

- 单元：默认 `bypass_permissions`；显式 `auto`/`dont_ask`/`accept_edits` 优先；`yolo` 别名；snake/camel 等价比较。
- 集成：真实 argv 含且仅含一次 `--permission-mode bypass_permissions`；`session_init` 确认；显式 `auto` 覆盖；模拟 init 回报 `auto` 时启动失败且不留活动 Worker；camelCase 回报被接受。
- 全量套件（修复 Qoder 之前构建）：282 项，279 通过、2 跳过、1 失败。失败项是与本修复无关的既有 mcode `noext` steer 计时竞态（turn 在 status 读取与 send 之间结束，得到 `INVALID_STATE`）。已用 `FAKE_MCODE_FINISH_MS` 固定该测试窗口并单独复验：mcode 集成 18/18 通过。原始失败输出保留为 `test-suite-full-before-mcode-fix.txt`，未再跑第二次全量；按用户要求，后续以定向测试为主。

## 剩余限制

- 只对 Qoder 1.1.79 做了真实验证；其他版本对 `bypass_permissions` 的支持可能不同，HS 会显式失败而不是降级。
- 这是一次单任务验证，不代表所有工具类型；已确认文件写入/读取不触发审批，未穷举全部工具。
- `bypass_permissions` 跳过 Qoder 的权限确认，是高风险设置；HS 仍不提供文件系统沙箱，`cwd` 不是隔离边界。
- auto 权限判断服务的 403 属于 Qoder 服务端行为；HS 现在默认不进入 auto，因此不再依赖该服务。显式设置 `HARNESS_SUPERVISOR_QODER_PERMISSION_MODE=auto` 时仍可能遇到 403 并逐项询问，这是显式选择的结果，不会被伪装成完整权限。
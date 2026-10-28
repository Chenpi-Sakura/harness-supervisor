# MiniMax Code Worker 权限模式修复与真实验证（2026-10-28）

## 根因

- 本机 `~/.minimax/config.yaml` 的 `permissionMode` 已是 `bypassPermissions`。
- 但 HS 的 `resolveMcodePermissionMode()` 在未显式配置时返回 `default`（Ask）；`McodeAcpSession.applyPermissionMode()` 在每次 `session/new` 与 `session/load` 后都调用 `session/set_config_option` 写入该值。
- 因此本机配置的 Full access 在每个新会话中被 HS 的默认值覆盖，工具调用重新变成逐项 `session/request_permission`，表现为 `run.needs_input`。这与 Qoder 的问题是同一模式：**改了原生配置，但 HS 启动时又覆盖**。

`docs/backlog.md` 中 2026-10-23 的“本机切 Full access”只改了配置，没有改 HS 的默认；所以之前的措施不足。

## 修复

- `MCODE_DEFAULT_PERMISSION_MODE = "bypassPermissions"`；未配置时不再切 Ask。
- 优先级：`McodeAdapterOptions.permissionMode` > `HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE` > 默认 `bypassPermissions`。
- 需要审批时显式设置 `HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE=default`；`auto` 仍可用。
- `session/set_config_option` 失败仍以 `UNSUPPORTED` 失败，不回退；本次未新增静默降级路径。

## 真实运行证据

- MiniMax Code 版本：**0.7.0**（原生安装于 `C:\Users\Lenovo\.minimax-code`）。
- HS 以隔离 state 目录、临时工作目录启动；`HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE` 未设置；使用 `HARNESS_SUPERVISOR_MCODE_ENTRY` 指向 0.7.0 的 `cli.js`（原生安装目录不在 HS 的默认 npm 查找路径中）。
- 任务：创建 `hs-mcode-permission-check.txt`，内容 `MCODE_BYPASS_OK`，再读回。
- 结果：Worker `w-mvrosrk7-315a3c3f` 状态 `completed`，exit 0；`toolCalls=3`、`toolErrors=0`、`run.needs_input` 数量 **0**；文件实际内容正确（15 字节，含结尾换行）。
- 最终答复确认创建、读回与字节校验，未出现审批请求。

原始文件：`status.json`、`events.json`、`hs-mcode-permission-check.txt`。

## 自动化验证

- 单元：默认 `bypassPermissions`；显式 `default`/`auto` 优先；未知值报错。
- 集成：默认模式下 `permission` 场景直接完成且无 `run.needs_input`；原 Ask 场景显式设置 `default` 后仍能产生审批请求并正常回答/拒绝；显式 `bypassPermissions` 场景保持。
- mcode 集成文件 19/19 通过。

## 剩余限制

- 只做了一次真实文件写入/读取任务，未穷举所有工具类型。
- 原生安装的 MiniMax Code 需要 `HARNESS_SUPERVISOR_MCODE_ENTRY`（或加入 PATH 的 npm 安装）；这与权限模式无关，但会影响开箱即用。
- `bypassPermissions` 跳过审批，是高风险设置；HS 仍不提供文件系统沙箱。
- 若运行时接受 `set_config_option` 但实际未生效，HS 目前无法从 ACP 响应中独立核实；真实运行以“无审批且任务成功”作为结果证据，未声称更强的保证。
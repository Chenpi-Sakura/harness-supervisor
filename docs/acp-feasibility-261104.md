# Pi / Qoder / MiniMax Code 的 ACP 改造可行性评估

- 日期：2026-11-04
- 范围：评估把 Pi、Qoder、MiniMax Code 统一到 Agent Client Protocol（ACP）是否值得做
- 结论性质：评估，不是实施记录；本轮没有修改 Runtime 代码

## 1. 结论

| Runtime | 当前接入 | ACP 现状 | 建议 |
| --- | --- | --- | --- |
| Pi | 原生 RPC（`pi --mode rpc`）+ 扩展 UI | 官方 Pi 1.5.0 没有 ACP；存在第三方 `pi-acp` / `@automatalabs/pi-acp` | **保持原生 RPC** |
| Qoder CLI | stream-json / stdio 控制协议 | 官方 `qoder --acp`；1.1.82 已真实验证初始化、Session、审批和 elicitation | **作为可选 ACP 传输层优先实现** |
| MiniMax Code | ACP over ndJSON（`mcode acp`） | **已经是 ACP** | 不换协议；只考虑抽取共享 ACP 内核 |

统一到 ACP 并不能让 HS 变成“更统一的 Agent 框架”，但可以让 Qoder 和 mcode 共用一套
JSON-RPC/权限/提问处理代码。Pi 走 ACP 需要额外适配层，反而会削弱现有原生 RPC 能力。

## 2. 评估标准

1. 原生支持：Runtime 是否官方发布 ACP Server，而不是第三方桥接。
2. 交互语义：工具审批、用户提问、取消、会话恢复是否能在 ACP 上表达。
3. HS 能力保留：steer、follow-up、扩展 UI、事件粒度、Usage 是否能继续提供。
4. 版本与依赖：是否引入额外运行时包、认证载荷或与已安装 CLI 的版本错位。
5. 可验证性：能否用真实进程完成 spawn、prompt、permission、cancel、resume。

## 3. Qoder CLI：可行，建议优先

官方文档：<https://docs.qoder.com/cli/acp>。`qodercli --acp` 启动 ACP Server，
使用标准输入输出 JSON-RPC；复用 `qodercli login` 的本地登录态。

真实 1.1.82 探测：

- `initialize`：protocolVersion 1，`loadSession=true`，session 支持
  `resume/fork/list/delete/close`，prompt 支持 image/embeddedContext，MCP 支持
  http/sse。
- `session/new`：返回 `sessionId`、模式 `default/acceptEdits/auto/dontAsk/yolo`
  （默认 `yolo`）、模型列表和 `configOptions`（mode/model）。
- `session/set_config_option`（`configId="mode"`, `value="default"`）生效。
- Write 工具在 default 模式下触发 `session/request_permission`，提供
  `allow_always/allow_once/reject_once`，客户端选择后工具完成。
- AskUserQuestion：客户端在 initialize 中声明
  `clientCapabilities.elicitation.form={}` 后，Qoder 发送
  `elicitation/create`（form 模式，带 JSON Schema），客户端返回
  `{action:"accept", content:{...}}` 后模型继续并完成。**未声明 elicitation
  能力时不会发送该请求**，这是此前探测没有看到提问的原因。
- `session/prompt` 结果提供 `stopReason`；本轮真实返回的 token 字段仍为 0，
  `_meta.quota` 只有积分，不能当作 Token 用量。

仍需要在实现阶段验证：

- `session/cancel` 的 turn 终止语义与进程/队列行为。
- `session/load` 的历史回放、与 HS 现有 session 文件/resume 身份校验的对应关系。
- ACP 的 `_meta.qoder.promptQueueing` 是否足以替代当前 stream-json 的 steer；
  如果不足，ACP 版 Qoder 应明确降级 steer。
- 模型 ID 映射：stream-json 用 `DeepSeek-Flash` 等名称，ACP 返回 `dfmodel` 等
  config value，需要显式映射或要求调用方传 ACP ID。
- 旧版 Qoder CLI 的 ACP 可用性；未验证前保留 stream-json 回退。

可行性判断：**高**。HS 已有 ACP JSON-RPC 客户端（mcode），Qoder ACP 的审批和
elicitation 都能映射到现有 `awaiting_input`；不需要引入 SDK 依赖或接管凭据。
推荐先做 `HARNESS_SUPERVISOR_QODER_PROTOCOL=acp` 可选传输，默认仍为
stream-json，真实通过后再考虑对 1.1.82+ 设为默认。

## 4. MiniMax Code：已经是 ACP，只评估共享内核

当前 `src/adapters/mcode/session.ts` 已经实现 ACP：initialize、session/new、
session/load、session/prompt、session/cancel、`session/request_permission`，
以及 mcode 自有扩展 `mcode/session/steer`、`mcode/session/queue/enqueue`。

因此 mcode 不需要“改成 ACP”；可做的是把 JSON-RPC framing、请求关联、反向请求
路由、权限回复等通用部分抽成共享 ACP 核心，让 Qoder 复用。风险在于：

- mcode 的权限模式通过 `session/set_config_option` 的 `permissionMode`；
  Qoder 使用 `mode`，配置 ID 不同，不能硬编码。
- mcode 的 steer/queue 是私有扩展；共享层必须保留未知扩展的透传能力。
- Usage 仍取决于上游；不能因为统一 ACP 就宣称 mcode 有 Token。
- 重构必须重跑真实 0.7.0 的 spawn/权限/取消/resume，协议测试不能替代。

可行性判断：**高（仅重构），收益是减少重复代码；不改变用户可见协议。**

## 5. Pi：不建议改 ACP

官方 Pi 1.5.0 的 CLI/文档只提供 `--mode rpc` 和 TypeScript SDK，没有 `--acp`。
本机安装的 1.4.0 同样没有 ACP 参数。第三方适配器有两个代表：

| 包 | 方式 | 关键限制 |
| --- | --- | --- |
| `pi-acp` 0.0.34（MIT） | 外部进程，桥接 `pi --mode rpc` | MVP；没有找到 ACP `session/request_permission`；无 `fs/*`、`terminal/*`；MCP 参数未接入；没有扩展 UI 的 ACP 映射 |
| `@automatalabs/pi-acp` 0.9.4（Apache-2.0） | 进程内嵌入 Pi SDK | 依赖 Pi SDK 0.87.1，而本机 Pi 是 1.4.0，版本明显落后；支持 steering 扩展、session load、MCP/elicitation，但包代码中未找到 ACP `session/request_permission` |

把 Pi 改成 ACP 的三条路都不理想：

1. 使用 `pi-acp`：需要接受它没有权限/审批映射，并补一个 Pi 扩展 UI 到 ACP 的桥；
   或者让 HS 直接失去 Pi 的 `awaiting_input`。
2. 使用 `@automatalabs/pi-acp`：会引入第三方进程内 SDK，且固定旧版 Pi，违背
   “调用用户已安装原生 Harness”的边界；仍需确认权限语义。
3. 自己写 ACP Server shim：等于在 HS 与 Pi RPC 之间再维护一层协议翻译，
   增加进程/事件/扩展 UI 的复杂度，不产生新的原生能力。

Pi 的 RPC 已经能直接表达 steer、follow-up、cancel、session 文件、扩展 UI 和
settled，ACP 对这些能力的标准表达并不更完整。可行性判断：**技术上可做，但不推荐**；
除非目标变成“让 Pi 接入任意 ACP 编辑器”，而不是 HS 的生命周期管理。

## 6. 建议的下一步

**推荐方案 A（分阶段）**：

1. 先实现 Qoder ACP 可选传输层，保留 stream-json 作为兼容回退。
   - 共享 ACP 传输核：JSON-RPC framing、pending request、反向请求、取消。
   - Qoder profile：`mode` 配置、模型映射、elicitation -> `awaiting_input`、
     `session/request_permission` -> `awaiting_input`、session/load 身份校验。
   - 真实验收：spawn、prompt、Write 审批、AskUserQuestion、cancel、load/resume、
     进程退出、daemon 重启对账。
2. 在 Qoder ACP 稳定后，再把 mcode 的通用部分迁到共享核心；mcode 私有扩展保持原样。
3. Pi 继续使用原生 RPC；不把 ACP 作为 HS 内部统一目标。

**不推荐方案 B**：三个 Runtime 全部走 ACP。它需要为 Pi 维护第三方桥或自写 shim，
引入版本错位和额外的权限映射层，违反 Keep Simple，也不会让 Pi 的 Worker 更可靠。

## 7. 参考证据

- Qoder ACP：`evidence/acp-feasibility-261104/README.md`
- 0.6.6 Qoder stream-json 兼容与限制：`docs/v0.6.6-report.md`
- 当前 mcode ACP 能力：`src/adapters/mcode/adapter.ts` 的 capability notes
- 官方 ACP：<https://agentclientprotocol.com/>
- 官方 Qoder ACP：<https://docs.qoder.com/cli/acp>

## 8. 实施状态（2026-11-04 后续）

本评估之后，Qoder ACP 传输已在 0.7.0 落地，并在真实验收通过后**设为默认**：

- 切换：默认 `acp`；`HARNESS_SUPERVISOR_QODER_PROTOCOL=stream-json` 可回退到
  旧传输。
- 真实 1.1.82 已通过：spawn/prompt、`session/load` resume、Write 审批
  （`session/request_permission`）、AskUserQuestion（`elicitation/create`）和
  `session/cancel`。各场景 `runErrors=0`，取消后进程退出。
- 上述“仍需要验证”的项已有结论：
  - `session/cancel` 能终止 turn；HS 随后关闭进程。
  - `session/load` 的回放不写入新运行的事件/最终答复；HS 使用自己的
    `qoder-acp-session.json` 句柄做身份校验。
  - 模型显示名到 ACP id 的映射在 HS 内完成，并把模型目录保存在句柄中。
  - `promptQueueing` 仍未验证运行段语义，因此 ACP 的 steer/followUp 明确为
    `false`。
  - 1.1.82 的 ACP usage 全零，HS 不写 `run.usage`。
- mcode 仍使用独立 ACP 实现；本轮没有为共享内核重构已验证的 mcode 代码。
- Pi 继续使用原生 RPC。
- 0.7.0 起已默认启用 ACP；多轮并发、长上下文、错误路径与桌面环境仍需补充
  验证，出现回归时可回退 `stream-json`。

证据：`evidence/qoder-acp-real/`；交付说明：`docs/v0.7.0-report.md`。

# HS 通知与读取的上下文预算（阶段 0 需求、阶段 1 实现与验收）

> 状态：阶段 0 与阶段 1 均已完成；阶段 1 于 2026-10-28 通过验收。
> 证据：`evidence/context-budget-baseline/`（测量脚本、原始 JSON、回归输出与测试环境）。
> 范围：本文档只定义"主 Agent 应当收到多少信息"及其验收方式；不涉及投递架构改造。

## 1. 背景

2026-10-27，一台使用 Codex 的机器上出现了三段被注入主会话的长文本：

| 消息 | 长度 | 到达 | 对应 HS 通知的 ACK |
|---|---|---|---|
| `[failed]` | 952 字符 | 12:08:07 | 12:14:43 |
| `[failed/closeout]` | 615 字符 | 未记录 | — |
| `[completed]` | 1178 字符 | 12:20:30 | 12:29:45 |

排查确认了三件事：

1. 它们不是 HS 0.4.3 之后的短指针格式；
2. 它们不在 `notifications.jsonl`，没有 `workerId#seq`；
3. 到达时间早于对应通知被 ACK 的时间，说明当时没有人在等它们。

随后又发现第二个独立问题：即使推送端只有几十个字符，主 Agent 读取 `worker_status` / `worker_events` 时仍可能一次拉回十几到几十 KB。**两端没有统一的上下文预算。**

## 2. 问题陈述

| 编号 | 现象 | 本质 |
|---|---|---|
| P1 | 长文本进入主会话 | 推送端把"报告"当"通知"投递 |
| P2 | 消息没有 `workerId#seq` | 非 HS 生产者写入，无法归因、去重、撤回 |
| P3 | 机器写入与用户输入不可区分 | 宿主侧 provenance 为 `user`，可被冒充 |
| P4 | 读取端一次返回大量过程事件 | 把诊断日志当汇报；默认值没有约束 |
| P5 | 打断策略没有分层 | 投递方式由"哪个快"决定，而不是"够不够格" |

**核心结论**：P1 与 P4 是同一个问题的两端。只修推送端，读取端会把省下的部分再花掉。

## 3. 核心原则（N0）

| 原则 | 含义 |
|---|---|
| **最小必要上下文** | 推送与读取两个方向都只给"不给我就会出错"的部分 |
| **少打扰优先** | 默认静默；只有"不推就会卡住"的事件才允许打断。与"即时"冲突时选少打扰 |
| **默认可安全丢弃** | 唤醒消息必须是可随手丢掉的指针，而不是不可丢的正文 |
| **接口默认值约束** | 靠默认值让"多读"变难，而不是在描述里请求克制 |

## 4. 需求

### 4.1 N1 单一写入者（分两层，不当作安全保证）

**架构约束**：HS 是唯一受支持的 Worker 通知生产路径。Worker 不获得自由注入主会话的 API；需要父端决策时发 `run.needs_input`，交付时正常结束并返回 `result`。

**来源审计**：对能够观测到的投递，记录并关联 `workerId`、事件 `seq`、通知 ID 与投递目标；对无法观测的旁路，**不宣称能够拦截或检测**。

明确边界：

- 同一 Windows 用户下，其他进程可能直接调用宿主接口；HS 无法仅凭自身 MCP 阻止。
- shim、提示词、环境变量都只是护栏，**不是操作系统级安全边界**。
- 若需要真正阻止其他进程写入，必须先验证宿主是否提供可用的权限隔离能力；未验证前不做承诺。

**当前实现（2026-10-28，阶段 2）**：`spawn` / `resume` 的任务提示前置固定协议块；Worker 进程的 PATH 前置 `codex` shim，只拒绝 `queue` 子命令并写 `worker-guard.jsonl`，其他子命令转发。护栏失败不阻断 Worker，绝对路径可绕过（已在测试中固定该边界）。真实验证范围与限制见 [`evidence/worker-write-guard-261028.md`](../evidence/worker-write-guard-261028.md)。

### 4.2 N2 双向最小化

- **推送**：唤醒消息只带 workerId、事件类型、`seq` 和下一步动作，不带正文、不带旧 `requestId`。
- **读取**：默认只返回结果面；过程数据必须显式请求。

### 4.3 N3 可归因 / N4 不丢事件

- 任何可观测投递都能对应到 `workerId#seq`；无法对应时明确标注来源未知，不得默认为 HS。
- 收件箱仍是真相源：拦截、投递失败、重复投递都不改变事件的存在性与顺序。

### 4.4 N5 分级投递 / N6 降级明确

| 级别 | 事件 | 允许的投递方式 |
|---|---|---|
| P0 | `needs_input`（Worker 卡住等决策） | 可就地打断；拿不到即时通道时回落队列 |
| P1 | `completed` / `failed` / `crashed` / `cancelled` / `detached` | 只推短指针，优先在空闲时投递 |
| P2 | 进度、工具调用、中间汇报、Pi `notify` | 只落盘，不进入主会话 |

降级（N6）：无法使用即时通道时必须显式标记为降级，不得让调用方误以为已即时送达。

### 4.5 N7 三层读取 + 编号索引

| 层级 | 默认返回 | 需要更多信息时 |
|---|---|---|
| **L0 结果面** | 状态、错误摘要、结果**预览**、已存字符数、截断标记 | `includeResult` 或 CLI `--full` |
| **L0 输入面** | `pendingInput`：问题预览 + 选项（最多 20）+ 总数 | `includeInput=true` 或 CLI `--full` |
| **L1 生命周期面** | 最近最多 10 条关键事件的紧凑摘要 | `sinceSeq` 增量读取 |
| **L2 过程面** | **不返回任何 `run.progress`** | `includeProgress=true` 或按 `seq` 读取单条 |

约束：

1. **预览不是完整结果**。默认必须同时给出 `chars` 与 `truncated`，不能因为截断就让调用方误以为已拿到全部内容。
2. **区分“已存”与“原文”**。`chars` 是已存文本的长度，不是原始长度；若存储层已按结果上限裁剪，必须额外给出 `storedTruncated: true`，表示即使显式读全文也只能拿到已存部分。
3. **待回答的问题不得静默裁剪**。`pendingInput.message` 同样返回 `{preview, chars, truncated}`；选项最多返回 20 项并给出 `optionsTotal`。裁剪后必须能通过 `includeInput=true` 拿到完整输入。
4. **编号即 `seq`**。单调递增且已在 `lastSeq`/`nextSeq` 中使用，直接作为“按编号查找”的索引；支持单条读取。
5. **不重复**。只有**当前运行**的 `run.completed` 正文与 `worker.result` 重复时才省略；历史完成事件（时间早于 `startedAt`）或无法核实的场景一律保留。
6. **摘要不等于原文**。HS 存储的是归一化摘要（`preview` ≤1000 字符、`detail` ≤500）；完整对话在 runtime 的 session 文件中，由 `worker.session` 事件的 `sessionFile` 指向。按编号查找只能返回 HS 实际持有的内容，不能承诺完整原文。
7. **等待与完整读取都不带工具调用**。`worker_wait` 默认不返回任何 `run.progress`——包括失败的工具调用；唯一例外是 `queue_cleared`（它记录取消时丢弃了多少条排队消息，是取消事实，不是工具数据）。`worker_status` 的完整读取同样过滤 progress。工具调用只能通过 `includeProgress=true` 或 `seq=<n>` 显式取得。
8. **两个显式面互相独立**。`includeResult=true` 只放开结果面（含 `error`），`pendingInput` 仍是 `{preview, chars, truncated}`；`includeInput=true` 只放开输入面，`result`/`error` 仍是预览（`preview` ≤1000 字符）。只有两者同时为 `true` 才同时返回全文。显式读取同时请求 `recentEvents` 时，事件也只返回紧凑摘要，不能从事件旁路取回未请求面的全文。

**默认预算（序列化 UTF-8 字节，不是 Token 估计）**：

| 接口 | 默认上限 |
|---|---|
| `worker_status` | **2 KiB** |
| `worker_events` | **4 KiB** |

预算不足时的裁剪顺序：先丢可选元数据和事件摘要，再缩结果/错误预览；**状态、错误和截断标记不得丢失**。预算按**最终序列化对象**计算，不能只算事件数组再追加外层字段。任何裁剪都必须体现在 `truncated`、`chars`、`eventsOmitted`、`optionsTotal` 或 `budgetExceeded` 上，不得把截断结果伪装成完整结果。

结果预览与完整结果是两种数据：默认可以给出预览和 `chars`，但不能把完整结果塞进默认状态查询；也不能因为截断了结果，就让调用方以为已经拿到全部内容。

### 4.6 N8 技术护栏（可选）

可拦截 Worker 直接调用宿主写入通道，并留下审计事件。定位是"护栏 + 审计"，不是安全边界，不作为 N1 的实现手段。

### 4.7 明确不做

1. 不新增 Worker → Master 的自由消息 API。
2. 不让 Worker 获得打断真人的对称权利。
3. 不伪造宿主能力；不支持就写不支持。
4. 不为即时性牺牲 ACK、审计或去重。
5. 不把 shim、提示词或环境变量描述为安全隔离。
6. 不把 `turn/steer`、`thread/inject_items`、shim 当作需求——它们是候选手段。
7. 不重写现有通知系统，不引入新服务、新数据库或新进程。

## 5. 设计约束

### 5.1 兼容性（按接口与模式分别定义）

| 接口 | 默认 | 显式请求 | 说明 |
|---|---|---|---|
| **MCP production** | 精简（L0 + L0 输入面 + L1≤10 + 无 L2） | `includeResult` / `includeInput` / `includeProgress` / `seq` | 面向主 Agent，是本次预算的主要对象 |
| **MCP development** | 保留现有诊断能力 | 行为不变 | 现有 `--mode development` 语义不变 |
| **CLI** | 精简（同 5.2） | `--full` / `--seq` | 不能只改 MCP 就声称三个接口都完成 |
| **IPC** | **不变** | — | IPC 是内部契约，返回原始数据；裁剪只在展示层做 |

IPC 不变是有意为之：内部消费者（CLI、MCP、测试）依赖完整数据，裁剪必须发生在展示层。

### 5.2 已定决策：CLI 默认精简（方案 A）

阶段 0 审阅结论：CLI 的 `events --json` 实测约 43 KB、`status --json` 约 20 KB，且 `status` 固定请求 `recentEvents: 20`。保留 CLI 全量默认会留下明显绕行路径——主 Agent 改用 CLI 就能绕过 MCP 的预算。

因此：

- `status`、`events` **默认精简**；
- **`--full` 恢复改动前的完整输出**（含全部事件、完整结果、stderr 尾部）；
- 现有 `--since`、`--limit`、`--json` 语义保留；
- `--seq <n>` 按编号读取单条事件。

### 5.3 度量口径

- 字符数与序列化字节数是**响应大小的代理指标**，不是 Token 数；中文文本的字节数约为字符数的 3 倍。
- 验收时同时记录序列化大小；若宿主提供可核验的模型用量，另行记录实际 Token。无法获取时明确标记未知，**不得用字符数冒充 Token 数**。

## 6. 阶段 0 审计结果

### 6.1 V4：三条长消息的归因

**结论：本机无法证实，归为未知。**

已执行的检查与结果：

| 检查 | 结果 |
|---|---|
| 生产状态目录中的 worker `w-mvqkh1td-6f7c0ffb` | 不存在 |
| `notifications.jsonl` 中的 `seq` 641 / 729 | 不存在（本机台账共 66 条，覆盖 2026-10-22 ～ 2026-10-25，台账中出现过的最大 seq 为 86；注意事件 `seq` 与通知 `seq` 同源，此处只说明台账里没有这两个通知记录） |
| `daemon.log` 中的该 worker | 无 |
| `metrics/` 中的该 worker | 无 |
| `~/.codex/sessions`（64 个会话文件）中的 `failed/closeout` | 无匹配 |
| `~/.codex/sessions` 中的 `[harness-supervisor]` | 有 189 处匹配，均为 2026-10-22 ～ 10-25 的 HS 自有消息 |

这 189 处匹配提供了有价值的对照：HS 实际发出的文本只有两种形态——0.4.3 之前的"前缀 + `(seq N): 摘要`"格式，以及 0.4.3 之后的纯指针格式。**两者都带 `[harness-supervisor]` 前缀，都不匹配本次的三段文本。**

因此可以确定的只有：三段文本不是 HS 的标准通知链路产物。**"由 Worker 发出"仍是推断，不是证据。** 要定性，需要在目标机器上检查 Worker 的会话记录与工具调用日志中是否存在 `codex queue` 调用；本机不具备该证据。

同时说明局限：本机台账存在压缩机制，不能仅凭"记录缺失"反证事件未发生；缺失只能说明本机无法证实。

### 6.2 读取开销基线

测量条件：

- 生产 daemon 0.5.0（PID 17624）**只读**访问，未改变任何状态；
- 通过独立 MCP 客户端以 `--mode production` 调用，记录 `content[0].text` 的字符数与 UTF-8 字节数；
- 失败场景使用临时状态目录 + 脚本化 Pi 夹具（生产环境没有失败 Worker）；
- 原始数据：`evidence/context-budget-baseline/result.json`；脚本：`measure.mjs`。

**MCP production 默认值（不传参数）：**

| 场景 | 字符 | 字节 | 事件数 | 其中 progress | 结果正文 |
|---|---|---|---|---|---|
| `worker_status` 完成（165 次工具调用） | 2394 | 3526 | 0 | 0 | 2099 |
| `worker_status` 完成（30 次工具调用） | 3836 | 5894 | 0 | 0 | 3572 |
| `worker_status` 完成（长历史） | 5067 | 6845 | 0 | 0 | 4724 |
| `worker_status` 已取消 | 254 | 294 | 0 | 0 | 0（error 21） |
| `worker_status` 失败（夹具） | 278 | 278 | 0 | 0 | 0（error 19） |
| `worker_status` + `recentEvents=100` | 21883 | 24441 | 100 | **98** | 2099 |
| `worker_events`（30 次工具调用） | 20172 | 22326 | 87 | **80** | — |
| `worker_events`（165 次工具调用） | 17043 | 17043 | 100 | **95** | — |
| `worker_events`（长历史） | 12813 | 12813 | 100 | **91** | — |
| `worker_events` 失败（夹具） | 1435 | 1435 | 10 | 2 | — |

**CLI 对照（同一 Worker，`--json`）：**

| 命令 | 字符 | 字节 | 相对 MCP |
|---|---|---|---|
| `cli status <30 tools>` | 15710 | 20306 | 4.1× |
| `cli events <30 tools>` | 37984 | 42580 | 1.9× |

### 6.3 主要发现

1. **`worker_status` 默认不是主要问题**。它返回 2.4–5 KB，且几乎全是结果正文——那正是主 Agent 需要的内容。此前的"64 KB"是上限，本次样本远未接近。
2. **`worker_events` 才是主要问题**。默认一次 12–22 KB，其中 **80%–98% 是 `run.progress`**（工具调用与助手片段）。
3. **`worker_status` 一旦带上 `recentEvents` 就退化**：`recentEvents=100` 时 21.9 KB，98/100 是进度事件。
4. **CLI 比 MCP production 重 2–4 倍**，且 CLI `status` 固定请求 `recentEvents: 20`。若不处理 CLI，预算会被绕开。
5. **失败场景很轻**（278 字符）：失败时没有 result，只有短 error，问题集中在成功路径的事件流。

## 7. 待验证（V1–V3，不影响阶段 1）

| 编号 | 未知 | 影响 |
|---|---|---|
| V1 | Codex Desktop 的 app-server 是否可达（本机 CLI 托管 socket 不存在） | N5 是否可行 |
| V2 | `turn/steer` 的输入是否触发 `UserPromptSubmit` hook | N5 与 0.4.4 闸门的关系 |
| V3 | 工具调用阻塞期间 steer 内容何时被模型看到 | N5 的实际收益 |

**纪律**：V1–V3 未通过前，不修改投递架构。阶段 1 与这三项无关，可独立推进。

## 8. 分期与准入

| 阶段 | 内容 | 准入条件 |
|---|---|---|
| 阶段 0 | 归因取证 + 读取基线（本文档） | 已完成 |
| 阶段 1 | N7 读取分层 + 编号索引 | 已完成（2026-10-28） |
| **阶段 1 并行** | **派发前通知绑定预检与等待策略**（见 [notification-binding-preflight.md](./notification-binding-preflight.md)） | 独立小项，不等 V1–V3 |
| 阶段 2 | N1 + N3（写入约束 + 归因） | V4 在目标机器取到证据 |
| 阶段 3 | N5 + N6（分级投递） | V1–V3 通过 |
| 阶段 4 | N8 / 静默上下文 | 出现真实需求 |

阶段 1 优先的理由：它不依赖任何宿主能力验证，改动集中在展示层，收益已被基线量化。

## 9. 验收标准与结果（阶段 1）

| 项 | 目标 | 结果 |
|---|---|---|
| 默认 `worker_status` | 序列化 **≤ 2 KiB**；结果为预览 + `chars` + `truncated` | ✅ 2046 / 2047 / 2048 字节（三种生产 Worker） |
| 默认 `worker_events` | 序列化 **≤ 4 KiB**；返回 **0 条** `run.progress` | ✅ 293–1098 字节，`progress=0` |
| 30 次工具调用 Worker 的默认读取 | 总量 **≤ 4 KiB**（阶段 0 实测 20172 字符） | ✅ status 2047 B + events 610 B |
| 任意被省略的过程事件 | 可用 `seq` 单条取回，内容完整 | ✅ `run.progress` 单条 343 B，`data` 完整 |
| 显式 `includeResult` / `includeInput` / `includeProgress` / CLI `--full` | 显式读取不受默认预算限制；每个面只放开自己 | ✅ 完整结果 8293 B；完整问题 2409 B；CLI `--full` 20029 / 41553 B |
| 两个显式面互相独立 | 未请求的面保持精简预览，`recentEvents` 也不能夹带全文 | ✅ 见 9.2 |
| CLI / MCP / IPC | 分别有回归测试 | ✅ `cli.test.ts`、`mcp-modes.test.ts`、`mcp.test.ts`；IPC 契约未改 |
| 度量 | 同时记录序列化大小；Token 用量无法取得时标记未知 | ✅ 只记录字符/字节；Token **未知** |

### 9.1 读取大小（序列化 UTF-8 字节）

同一批生产 Worker、同一组调用，仅更换构建（阶段 0 → 阶段 1）：

| 场景 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| `worker_status` 默认（165 次工具调用） | 3526 | 2046 | −42% |
| `worker_status` 默认（30 次工具调用） | 5894 | 2047 | −65% |
| `worker_status` 默认（长历史） | 6845 | 2048 | −70% |
| `worker_status` + `recentEvents=100` | 24441 | 2046 | −92% |
| `worker_status` 默认（已取消） | 294 | 681 | +132% |
| `worker_status` 默认（失败） | 278 | 864 | +211% |
| `worker_events` 默认（30 次工具调用） | 22326 | 610 | −97% |
| `worker_events` 默认（165 次工具调用） | 17043 | 1098 | −94% |
| `worker_events` 默认（长历史） | 12813 | 293 | −98% |
| `worker_events` 默认（失败） | 1435 | 695 | −52% |

失败与取消场景变大，是因为默认响应现在也带最多 10 条紧凑生命周期事件，绝对值仍在 1 KiB 以内。

### 9.2 显式读取的独立性（隔离夹具：8,040 字符结果、2,000 字符问题、failed Worker）

| 调用 | 结果面 | 输入面 | 事件 | 字节 |
|---|---|---|---|---|
| `includeInput=true`（completed） | `preview` + `chars=8040` + `truncated=true` | 无 | — | 1267 |
| `includeInput=true` + `recentEvents=100`（completed） | 同上 | 无 | 8 条 summary，无 `data` | 1822 |
| `includeResult=true`（awaiting_input） | 无 | 400 字符预览 + `chars=2000` + `truncated=true` | — | 851 |
| `includeResult=true` + `recentEvents=100`（awaiting_input） | 无 | 同上 | 6 条 summary，无 `data` | 1299 |
| `includeInput=true`（awaiting_input） | 无 | 全文 2000 字符 | — | 2409 |
| `includeInput=true`（failed） | `error` 预览（带 `chars`/`truncated`） | 无 | — | 317 |
| `includeResult=true`（failed） | `error` 全文 | 无 | — | 276 |
| `includeResult=true` + `includeInput=true`（completed） | 全文 8040 字符 | — | — | 8293 |
| `includeResult=true` + `recentEvents=100`（completed） | 全文 8040 字符 | — | 8 条 summary，4 条 progress 被过滤 | 8848 |

这组数据说明：显式读取不受 2 KiB 默认预算约束；未请求的面只返回带标记的预览；`recentEvents` 在显式读取中同样只返回紧凑摘要（无 `data`），因此不能从事件旁路取回另一面的全文。完整事件仍可通过 `worker_events` 或 `seq=<n>` 读取。

### 9.3 构建、测试与复现

- 构建：`npx tsc -p tsconfig.json --outDir .smoke-stage1/dist`（隔离输出，未重建生产 `dist`）；
- 类型检查：`npx tsc -p tsconfig.json --noEmit`，退出码 0；
- 完整回归：`node .smoke-stage1/test/run.mjs`（272 个测试，270 通过，2 跳过，0 失败）；
- 能力测量：`HS_DIST_DIR=.smoke-stage1/dist node evidence/context-budget-baseline/measure-stage1.mjs`，18 项预算/独立性断言全部通过，退出码 0；
- 原始输出：`stage1-after.json`、`stage1-capabilities.json`、`test-suite-stage1.txt`。
- 环境与限制：Windows + Node v24.21.0；生产 daemon 0.5.0 只读访问；真实 Codex Desktop 的模型侧行为未验证，Token 用量未知。

阶段 1 的前后实测见 [`evidence/context-budget-baseline/`](../evidence/context-budget-baseline/)（`stage0-before.json` / `stage1-after.json` / `stage1-capabilities.json`）。

### 9.4 阶段 1 未覆盖

1. `worker_wait` 仍返回完整 result（不缩成预览），见第 10 节风险表；
2. 未验证真实宿主模型在收到精简视图后的行为；
3. `includeProgress=true` 的完整事件流仍可能很大，这是显式请求，未加预算；
4. 默认视图的 2 KiB / 4 KiB 是响应字节预算，不是 Token 预算。

## 10. 风险

| 风险 | 应对 |
|---|---|
| 改默认返回破坏现有调用方 | production/development 分层；显式参数可恢复全文，但两个面需分别请求，未请求面保持预览 |
| 读取分层导致多次往返 | L0 一次到位，L1 给目录，L2 逐条 |
| 归因错误，把旁路算到 Worker 头上 | 先取证再改措辞 |
| 把护栏描述为安全隔离 | 文档与报告中显式标注"非安全边界" |
| 需求蔓延 | 每次迭代对照第 4.7 节的"不做"边界 |
| 显式 `includeResult` / `includeInput` 会超出 2 KiB | 这是调用方明确请求；未请求的面只给上限 1000 字符的预览，并以 `chars`/`truncated` 标记 |
| 显式面与 `recentEvents` 同传时事件可能夹带未请求面 | 显式读取的事件也只返回紧凑摘要（无 `data`）；全文只能经 `worker_events`/`seq` 取得 |
| `worker_wait` 仍返回完整 result（阶段 0 实测 2–5 KB），但不再带工具调用 | 有意保留结果：它是拿最终答案的主路径，缩成预览会让绝大多数调用多一跳。阶段 1 不处理，若后续测量证明它成为主要开销再单列 |
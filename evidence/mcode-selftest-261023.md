# MiniMax Code 适配自验记录（0.4.1，2026-10-23）

分支 `fix-261023-mcode-self-validation`，基线 `main` = `d73b95c`（0.4.0），本轮起点 `7cf8ea2`（0.4.1，长回合超时修复）。
本记录只描述本工作树内实际执行过的验证，不重复父 Agent 已完成的 30 项回归。

## 结论

适配实现经过代码审阅、协议桩测试和真实 MiniMax Code 0.6.12 验证；各项覆盖范围以以下表格为准，不能将桩覆盖统称为真实验证。
本轮自验未再发现 P0/P1（不包含父 Agent 此前已修复的 120 秒超时）。发现并修复 2 个 P2：一个是 0.4.1 引入的无上限权限上下文，一个是 mcode 集成测试对
环境变量的隐性依赖。

## 本轮真实 E2E（真实 MiniMax Code 0.6.12，独立 daemon 与独立状态目录）

全部使用真实 `@minimax-ai/code@0.6.12`（入口 `C:/Users/Lenovo/.minimax-code/releases/0.6.12/.../cli.js`），
产物写入本工作树被忽略的 `.smoke-selftest-evidence/`，**未覆盖** `evidence/mcode-real/` 的既有归档。

| 命令 | 结果 | 关键事实 |
| --- | --- | --- |
| `npm run e2e:mcode` | 通过 | 首次回合 `MCODE_E2E_OK`；同一 worker resume 后 `MCODE_E2E_RESUMED`；取消用例以 `cancelled` 收尾，事件序列 `worker.starting → worker.started → worker.session → run.started → run.accepted → worker.cancel_requested → run.cancelled → worker.exited`；权限往返本轮**未触发**，脚本记为 `outcome: "not_requested"` |
| `npm run e2e:mcode:long`（本轮新增脚本） | 通过 | 回合实际耗时 **159,028 ms**，状态 `completed`，结果含 `MCODE_LONG_TURN_OK`，无 `run.error`/`run.failed` 事件。旧实现会在 120s 处报 `session/prompt` 超时，这条用例正是该缺陷的真实回归 |
| `npm run e2e:mcode:steer` | 通过 | 观察到真实工具调用（回合已准入）后发 steer：agent 回执 `mode=steered`、`turnId=84fc50a4-…`，agent 确实照做（结果含 `MCODE_STEER_OK`）；follow-up 回执 `queued @1`、`itemId=queue_1687c658-…`；`run.message_sent` 2 次 |

命令与产物：

```powershell
$env:MCODE_EVIDENCE_DIR = "<worktree>\.smoke-selftest-evidence"
npm run e2e:mcode
npm run e2e:mcode:long
npm run e2e:mcode:steer
```

产物：`.smoke-selftest-evidence/mcode-e2e.json`、`mcode-long-turn-e2e.json`、`mcode-steer-e2e.json`。

## 发现与处理

### F1（P2，已修）0.4.1 的权限上下文没有上限

0.4.1 把 `session/request_permission` 的上下文从 `safeText(message_, 2000)` 改成 `redactText(message_)`，目的是让主 Agent 看到原生
`rawInput`。但 supervisor 会把 `pendingInput` **原样**存进 worker 记录并交给调用方（`mcp-presentation.ts` 的 `pendingOf` 不截断），
所以一次请求就能把任意大的原生工具输入推进主 Agent 上下文；Pi 侧同一路径上限是 2000 字符，两者不一致。

修复：`src/adapters/mcode/session.ts` 改为 `safeText(message_, PERMISSION_MESSAGE_MAX_CHARS)`（上限 8000，可覆盖常见短命令，
并保留可见的截断标记），真实 `rawInput` 仍然可见。回归：`test/unit/mcode-acp-session.test.ts`
「a huge native permission payload stays bounded instead of flooding the caller」用 20,000 字符 payload 断言消息长度 ≤ 8200 且仍能看到真实命令。

### F2（P2，已修）mcode 集成测试依赖环境变量

父 Agent 把生产 Daemon 切到 `full`（即 `bypassPermissions`）后，本工作树 shell 继承了
`HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE=bypassPermissions`。测试 daemon 继承该变量，于是三个权限用例在 bypass 模式下运行，
根本没等到 `awaiting_input`（`current=completed`）而失败。代码没问题，是测试结果取决于开发机环境：同一份代码在有/无该变量时结论不同。

修复：`test/integration/mcode.test.ts` 的 `startMcodeHarness` 固定 `HARNESS_SUPERVISOR_MCODE_PERMISSION_MODE: "default"`
（需要其它模式的用例通过 `extraEnv` 显式声明，原有 bypass 用例已显式声明）。

修复后**在 ambient 变量仍为 `bypassPermissions` 的情况下**重跑：

```
node --test dist/test/unit/mcode-acp-session.test.js dist/test/unit/mcode-launch.test.js dist/test/integration/mcode.test.js
→ tests 37 / pass 37 / fail 0
node --test dist/test/unit/idempotency.test.js dist/test/unit/mcp-presentation.test.js
→ tests 29 / pass 29 / fail 0
npm run typecheck → 通过
```

### F3（观察，未改）本机入口必须显式配置

受管安装 0.6.12 不在 npm 全局前缀路径下：`findMcodePackageEntry` 在没有 `HARNESS_SUPERVISOR_MCODE_ENTRY` 时返回 `null`，
`resolveMcodeLaunch` 抛 `UNSUPPORTED` 并提示该变量。按任务约定不为本机布局扩大核心设计，保留现状，仅如实记录。

## 逐项核验（代码审阅 + 实测）

1. **ACP ndJSON / 双向 id / prompt 接受与完成 / 错误取消超时 / session 恢复**
   - 传输为每行一条 JSON-RPC；HS 自身请求用 `hs-<n>` 字符串 id，与 agent 的数字反向 id 空间分离；`handleMessage` 先按 `method` 分流，
     带 method 的一定是 agent 侧请求/通知，未建模请求回 `-32601`（桩覆盖）。
   - `prompt()` 立即返回 `started`，`settled` 在回合结束时才发；`run.accepted` 不等于完成。
   - 进程退出 → `HARNESS_ERROR`；`stopReason != end_turn` → `run_error(fatal)` + `settled`；控制 RPC 仍有 120s 上限（桩断言超时后主回合不被结算）；
     `session/prompt` 不再有短超时，由取消 / 进程退出 / Supervisor `maxDurationMs` 约束（桩 + 真实 159s 回合双重覆盖）。
   - 取消：`session/cancel` 是 notification，回合存活时被取消 → `run.cancelled`（真实 E2E）。
   - 恢复：`session/load` 真实成功，同一 worker 第二个回合正常完成（真实 E2E）。
2. **权限请求 → needs_input → answer**
   - 回答先按显示名或 `optionId` 精确匹配（`Allow once` / `Always allow` / `Deny`），匹配不到才退回 allow/deny 语义，避免把允许翻成拒绝；
   - agent 撤回请求按 progress 报，不按错误报；权限超时会向 agent 回 `cancelled` 并报非致命错误。
   - **真实进程上的往返本轮未复现**（见「未验证」）。
3. **steer / follow-up 与活跃回合限制**
   - steer 仅在已准入的活跃回合内被 agent 接受（真实 E2E：`mode=steered` 且 agent 照做）；回合结束后同一调用被 agent 拒绝，
     错误如实抛给调用方，且不记成 `steer_accepted`（桩覆盖）。
   - follow-up 只有排队回执（`queued @1` + `itemId`），**不等于已执行**；真实 E2E 中该回合未包含排队内容，
     因此「队列内容在下一次回合被执行」仍是未验证项。`run.message_sent` 只表示已发送；supervisor 在投递期间发现回合已结束时
     会以 `INVALID_STATE` 明确拒绝，并说明「排队消息不会被执行」。
4. **生产精简输出 / Qoder、Pi 不退化 / 幂等 compact 顺序**
   - 生产模式保留最终报告（`worker.result.text`）与 `pendingInput` 全部字段；`run.completed` 事件文本按「已被当前结果包含」才去重。
   - mcode 的生产 notes 为 406 字符（未登记 runtime 回落为 94 字符固定句，不泄漏 adapter 全文）。
   - `d73b95c` 对共享代码的改动都是增量：daemon 多注册一个 adapter、`sendOnce` 保留 `UNSUPPORTED`（对 Pi/Qoder 同样是修正）、
     幂等写名次、production notes 表新增一项；Pi/Qoder 适配器文件未改动。
   - 幂等 `compact()` 以写入名次 `seq` 排序（不依赖毫秒级 `updatedAt`），加载时按文件位置重算 `seq`，写回时按 `seq` 升序，
     使文件顺序恒等于写入顺序；对应四个方向的用例通过。

## 未验证 / 宿主限制

- **Ask 模式下哪些命令会被拦**由 MiniMax Code 运行时的风险分类决定，不是读写之分；本轮真实 E2E 未触发许可请求，
  该结论仍不能作为可复现断言。
- **真实进程上的权限往返**在本工作树没有独立归档产物（脚本如实记为 `not_requested`）；父 Agent 在生产 Daemon 上曾真实收到并回答过
  原生权限请求，但那份证据不在本工作树的归档里。
- `queue/list` 与 `queue/delete` 只有 fake 覆盖，未对真实进程验证；排队内容是否真的在下一次回合被执行，同样未验证。
- 仅验证 MiniMax Code 0.6.12；未声明 `mcode/session/steer` / `mcode/session/queue/enqueue` 的构建会返回 `UNSUPPORTED`（桩覆盖，未在真实旧版本上验证）。
- 本机入口需显式 `HARNESS_SUPERVISOR_MCODE_ENTRY`（见 F3）。
- 本轮未验证：跨 daemon 重启后的状态对账、通知真正唤醒主 Agent（与 mcode 适配无关，属既有边界）。

## 父 Agent 独立验收补充

- 验收修订版本为 0.4.2。父 Agent 独立复跑上述全部 66 项（显式 ambient=`bypassPermissions`）通过，构建、类型检查、脚本语法与 `git diff --check` 通过。首次受限环境执行出现临时会话文件 rename EPERM；正常 Windows 权限、独立测试状态下复跑通过，不将环境失败隐去或计作通过。
- 脱敏结果快照归档为 [mcode-selftest-results-261023.json](mcode-selftest-results-261023.json)，去掉本机入口、临时目录和原生 session handle 等管理信息；原始产物仍保存在被忽略目录中。
- 已直接核对三个 JSON 产物的时间、终态、结果标记与事件记录；真实长回合 159,028ms、steer 实际生效、resume 与取消结果与报告一致。未重新运行收费的长回合 E2E。
- 基础 E2E 的权限步骤记录为 `not_requested`。运行环境曾继承 Auto / Full 配置，不能据此推断 Ask 风险分类行为。生产自验 Worker 本身的原生权限请求与回答曾多次真实发生，但不将其冒充独立 E2E 脚本覆盖。
- Full access 是用户在本轮反复审批后明确授权的配置；撤销此前保持 Ask 的任务约束，不能声称全程使用 Ask。
- 修正新增长回合脚本：设置 Worker maxDuration，退出时先取消测试 Worker、关闭独立 Daemon，避免只杀 Daemon 遗留原生子进程。测试主路径的既有真实结果不变，新增清理路径仅作静态与语法核验。
- Pi/Qoder 本轮没有重新跑真实 E2E；共享代码静态检查与相关回归不能替代其真实生命周期验证。
- 权限上下文上限不限制最终报告字数；出现截断标记时上下文不完整，不能仅凭显示的命令前缀判断并自动放行。

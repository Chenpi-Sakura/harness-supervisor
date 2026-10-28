# 上下文预算基线（阶段 0）

对应需求文档：[docs/notification-context-budget.md](../../docs/notification-context-budget.md)

## 测了什么

主 Agent 通过 MCP / CLI 读取 Worker 时，**实际收到多少字符与字节**，以及其中有多少是 `run.progress` 过程事件。

## 测量条件

- 生产 daemon 0.5.0，只读调用，未改变任何状态；
- 通过独立 MCP 客户端以 `--mode production` 调用，记录 `content[0].text`；
- 生产环境没有失败 Worker，失败场景使用临时状态目录 + 脚本化 Pi 夹具（`dist/test/fixtures/fake-harness.js`）；
- 字符数与 UTF-8 字节数只是响应大小的代理指标，**不是 Token 数**。

## 如何复现

```powershell
# 需要先构建（不要在运行中的生产 dist 上构建）
node evidence/context-budget-baseline/measure.mjs
```

脚本默认连接本机生产状态目录；临时夹具的状态目录会在输出中打印，可自行清理。
MCP 客户端的诊断输出默认关闭，设置 `HS_BASELINE_DEBUG=1` 可打开（会混入 stderr，不影响 stdout 的 JSON）。

### 对比候选构建

`measure.mjs` 支持 `HS_DIST_DIR`，可以对同一批场景分别测量两个构建，得到前后对比：

```powershell
$env:HS_DIST_DIR = "<repo>\dist"              # 改动前
node evidence/context-budget-baseline/measure.mjs > before.json
$env:HS_DIST_DIR = "<repo>\.smoke-stage1\dist" # 改动后
node evidence/context-budget-baseline/measure.mjs > after.json
```

`measure-stage1.mjs` 度量阶段 1 引入的新能力（默认精简与显式完整读取）：

```powershell
$env:HS_DIST_DIR = "<repo>\.smoke-stage1\dist"
node evidence/context-budget-baseline/measure-stage1.mjs
```

脚本自带预算断言，全部通过时退出码为 0。

## 阶段 1 前后对比（序列化 UTF-8 字节）

同一批生产 Worker、同一组调用，仅更换构建：

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

CLI 数字按 `stdout.trimEnd()` 计，末尾换行属于输出框架，不计入序列化响应大小。

`worker_wait` 不在上述表格里：它仍返回完整 result，但默认不再返回任何 `run.progress`（包括失败的工具调用），唯一例外是取消时记录的 `queue_cleared`。CLI `wait` 与 MCP 保持一致，`--include-progress` / `includeProgress=true` 才恢复工具调用。

阶段 1 的新能力（显式完整读取、面间独立性、单条读取、CLI 默认与 `--full`）见 `stage1-capabilities.json`，脚本自带 18 项断言，全部通过时退出码为 0。其中显式面的独立性使用隔离夹具（8,040 字符结果、2,000 字符问题、failed Worker）：

| 调用 | 结果面 | 输入面 | 事件 | 字节 |
|---|---|---|---|---|
| `includeInput=true`（completed） | 预览 + `chars=8040` + `truncated=true` | 无 | — | 1267 |
| `includeInput=true` + `recentEvents=100`（completed） | 同上 | 无 | 8 条 summary，无 `data` | 1822 |
| `includeResult=true`（awaiting_input） | 无 | 预览 400 字符 + `chars=2000` | — | 851 |
| `includeResult=true` + `recentEvents=100`（awaiting_input） | 无 | 同上 | 6 条 summary，无 `data` | 1299 |
| `includeInput=true`（awaiting_input） | 无 | 全文 2000 字符 | — | 2409 |
| `includeInput=true`（failed） | `error` 预览 | 无 | — | 317 |
| `includeResult=true`（failed） | `error` 全文 | 无 | — | 276 |
| `includeResult=true` + `includeInput=true`（completed） | 全文 8040 字符 | — | — | 8293 |
| `includeResult=true` + `recentEvents=100`（completed） | 全文 | — | 8 条 summary，过滤 4 条 progress | 8848 |

显式读取的事件同样只返回紧凑摘要（无 `data`），完整事件只能经 `worker_events` 或 `seq` 取得。

## 构建、测试与环境

- 构建与回归使用隔离输出，**不重建生产 `dist`**：
  ```powershell
  npx tsc -p tsconfig.json --outDir .smoke-stage1/dist
  npx tsc -p tsconfig.json --noEmit
  node .smoke-stage1/test/run.mjs
  ```
- 完整回归输出：`test-suite-stage1.txt`（272 个测试，270 通过，2 跳过，0 失败；跳过的是需要 `RUN_REAL_PI=1` 的真实 Pi 模型测试）。
- 环境：Windows、Node v24.21.0、HS 0.5.0；生产 daemon 只读访问，合成场景使用临时状态目录。
- 字符/字节是响应大小的代理指标；未取得可核验的 Token 用量，**未知不等于 0**。

## 已知局限

- 只覆盖本机 14 个生产 Worker 与 1 个夹具 Worker，不代表所有负载；
- 阶段 0 时结果正文普遍在 2–5 KB，未观测到接近 64 KB 上限的样本；
- 未取得可核验的模型 Token 用量，因此只能报告序列化大小；
- `result.json` 中的 `stateDir` 与失败 Worker ID 属于临时夹具，不具长期意义。
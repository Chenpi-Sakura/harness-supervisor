# MiniMax Code 最新版本 Token 用量探测（0.6.13）

- 日期：2026-10-27
- 运行时：MiniMax Code `0.6.13`（本机 `.minimax-code/current`，`mcode --version` 一致）
- 方式：隔离临时工作目录，直接启动 `mcode acp`（ndJSON），执行一次文本单轮，捕获 `session/update` 与 `session/prompt` 原始报文
- 模型调用：一次，文本单轮，不使用工具

## 结果

- `session/prompt` 响应只有 `stopReason: "end_turn"`，**没有 usage**。
- `session/update` 中出现两次 `usage_update`，内容为：
  - `used = 20269`
  - `size = 1000000`
  - `cost = { amount: 0, currency: "USD" }`
- 未出现 input/output/reasoning/cache token 分项。

原始脱敏结果见 [probe.json](probe.json)。未保存 sessionId、助手文本、工作目录或账户标识。

## 结论

最新 0.6.13 的 ACP 路径提供的是**上下文占用**（used/size）和值为 0 的 USD cost，不是可归因的 Token 消耗。HS 不把它当作 Token 用量，也不把 0 当作真实费用。

因此本阶段 mcode 的 Token 用量保持 `unknown`。headless 模式 `mcode exec --output-format json` 另有结构化 usage，但 HS 的 mcode 适配器走 ACP；不自动读取 mcode 私有会话库。

## 复现要点

1. 用 Node 启动 `<0.6.13>/node_modules/@minimax-ai/code/cli.js acp`。
2. 发送 `initialize`（protocolVersion 1）→ `session/new`（cwd、mcpServers=[]）→ 一次 `session/prompt`。
3. 记录所有 `session/update`；重点检查 `usage_update` 与 prompt 响应顶层字段。

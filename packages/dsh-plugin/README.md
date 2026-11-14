# DSH Harness Supervisor

将 DSH 会话作为 Harness Supervisor 的 Master，委派 Pi、Qoder、MiniMax Code、DeepSeek Harness、Codex、Claude Code 等原生 Worker。社区独立维护。Codex 与 Claude Code 的 ACP 适配器需另行安装，方法见完整项目 README。

[项目仓库](https://github.com/Chenpi-Sakura/harness-supervisor) · [完整项目 README](https://github.com/Chenpi-Sakura/harness-supervisor/blob/main/README.md) · [npm](https://www.npmjs.com/package/dsh-harness-supervisor)

## 安装与使用

默认使用插件内置 HS，WebUI 随 daemon 启动，监听 `127.0.0.1:61115`。在 **设置 → Harness Supervisor** 中，**HS 核心来源**可选择“全局 npm 安装的 HS”，自动查找 `npm install -g harness-supervisor` 的安装位置；无需手填路径。也可选择“自定义安装目录”，填写含 `package.json` 和已构建 `dist/` 的目录后保存。保存会重新连接所选实例，旧 Worker 不会停止；连接结果可用“刷新状态”和“诊断详情”查看。

独立模式默认连接独立 HS 的状态目录（`HARNESS_SUPERVISOR_HOME` 或 `~/.harness-supervisor`），没有运行实例时可代为启动，默认 WebUI 端口为 `61114`。可用 `stateDir` 指定其他目录。已有 daemon 或已验证的托管核心优先复用，选择安装来源不会强行切换它们，也不会在独立模式应用内置核心；更新由独立 HS 自身管理。

在 DSH 自带的「插件 → 添加插件」中输入 `dsh-harness-supervisor@latest`，安装并启用。也可通过 CLI 安装到 Desktop profile：

```powershell
dsh plugin --profile desktop add dsh-harness-supervisor@latest
```

插件包含固定配套的 HS 核心、生产依赖和 WebUI，无需 Clone、编译或额外全局安装 HS。Worker 对应的原生 Harness CLI 仍需安装并配置账号。

启用后，直接让 DSH 委派 Worker；插件会自动配置原生 MCP 连接。从右侧栏入口、对话顶部标签或设置中的 **Harness Supervisor** 打开 WebUI，或使用 `/hs` 在右侧浏览器打开。界面支持 DSH Desktop 和本机 DSH Web。

人工界面可查看本机当前 HS 实例的全部 Worker，按“工作目录 → 会话 → Worker”分组，默认展开当前对话。可读取状态、结果、轨迹与用量，回答输入或取消任务；创建与续接任务由 Master 完成。禁用或卸载插件不会停止已有 Worker。

## 更新插件与配套核心

1. 通过 DSH 插件管理器更新 `dsh-harness-supervisor@latest`，卸载或禁用不会停止已有 Worker。
2. 使用“插件内置 HS”时，新插件自动为兼容的已托管旧核心登记受控升级；独立 npm／自定义来源仍由其自身管理更新。
3. HS 暂停接收新任务，等待已有任务和队列结束，再备份、切换并验证。可通过 **刷新状态** 和 **诊断详情** 查看进展。

等待期间仍可回答输入、取消 Worker 或取消此次更新，没有隐式强杀期限。已登记的更新由 HS 继续执行，不要求设置页一直打开；切换后需重新打开 WebUI。

需要取消排空时，从诊断详情取得更新意图 ID，使用 `harness-sup --state-dir <插件状态目录> runtime cancel --intent-id <ID>`；设置页不增加维护按钮。

插件拥有独立 daemon，各 DSH 会话共用该实例。配套核心会复制到持久缓存，更新仍通过排空与验证完成。插件更新会登记升级，但不跳过排空；不降级、不覆盖其他更新，也不自动重试已取消或失败的同一候选。未托管或不兼容的旧核心需要维护窗口。

## 配置与边界

默认状态目录为 `$DSH_HOME/harness-supervisor`，未设置 `DSH_HOME` 时使用 `~/.dsh/harness-supervisor`。插件从内置核心建立自己的持久运行时缓存，不继承独立 CLI/Codex 的 `HARNESS_SUPERVISOR_HOME` 和运行时指针。可用 `stateDir` 指定另一个独立目录，`nodeExecutable` 指定 Node。

从旧版共享实例升级时，旧任务和记录保留在原状态目录，可由原 CLI/MCP 继续访问；新插件面板展示专属实例的任务。若曾把插件 `stateDir` 配成全局 HS 目录，请清除该配置，使用新的默认目录。现有任务的迁移需要另行安排维护窗口。

每个真实 DSH Agent 复用一个 MCP 连接，固定会话归属与通知策略。模型只能查询和操作所属会话的 Worker 与通知 ACK，不能修改共享通知目标或执行升级。旧 Worker 不自动归入 DSH 会话。会话归属与 `cwd` 是路由和工作目录约定，不是操作系统沙箱。

浏览器入口使用一次性链接兑换独立凭证，不向网页暴露 IPC Token。刷新、查询结果不会唤醒模型或自动 ACK；daemon 重启后需从可信入口重新打开。

无法确认进程状态时，自动切换会停止。恢复线索位于状态目录的 `runtime-update.json`、`runtime-update.log` 与 `runtime-backups/`；不要删除锁或并行启动另一核心强行恢复。

<details>
<summary>离线安装备用方式</summary>

从发布附件下载预构建的 `dsh-harness-supervisor-<version>.tgz`，在 DSH 自带的插件管理器中添加该文件的完整路径，或执行 `dsh plugin --profile desktop add <插件包.tgz>`。无需解压或编译；核心切换仍按上面的更新流程执行。

</details>

## 开发与打包

仅开发时需要 Clone 同一个 HS 仓库。先按[主 README 的源码开发步骤](https://github.com/Chenpi-Sakura/harness-supervisor#源码开发与验证)安装依赖、构建核心，并建立独立状态目录；MCP 诊断使用实际支持的 `--mode development`。

以下命令在仓库根目录执行：

```powershell
npm run build:plugin
npm run test:plugin
npm run pack:core
npm --prefix packages/dsh-plugin run pack:release
```

核心必须先完成当前版本的 `npm run build`。插件打包解包固定核心 `.tgz`，对照 `production-lock.json` 验证生产依赖，再用 `bundleDependencies` 生成独立安装包；安装时不重新编译。DSH SDK、React 等宿主能力不重复打包。

真实宿主联调应使用独立 DSH 测试 profile，例如将生成的插件包安装到 `hs-dev`，并在该 profile 的插件配置中把 `stateDir` 指向独立测试目录。所有开发 CLI/MCP 应指向同一测试目录，避免连接正在使用的共享实例。普通用户按前面的 npm 安装步骤使用即可。

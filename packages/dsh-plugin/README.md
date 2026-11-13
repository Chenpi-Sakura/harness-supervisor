# DSH Harness Supervisor

将 DSH 会话作为 Harness Supervisor 的 Master，委派 Pi、Qoder、MiniMax Code 等原生 Worker。社区独立维护，配套 HS `0.10.4`。插件不声明 DSH 宿主版本限制，通过运行时接口检查兼容性；已在 DSH `0.2.2-rc.1` 验证，其他版本尚需验收。

[项目仓库](https://github.com/Chenpi-Sakura/harness-supervisor) · [完整项目 README](https://github.com/Chenpi-Sakura/harness-supervisor/blob/main/README.md) · [npm](https://www.npmjs.com/package/dsh-harness-supervisor)

## 安装与使用

在 DSH 自带的「插件 → 添加插件」中输入 `dsh-harness-supervisor@latest`，安装并启用。也可通过 CLI 安装到 Desktop profile：

```powershell
dsh plugin --profile desktop add dsh-harness-supervisor@latest
```

插件包含固定配套的 HS 核心、生产依赖和 WebUI，无需 Clone、编译或额外全局安装 HS。Worker 对应的原生 Harness CLI 仍需安装并配置账号。

启用后，直接让 DSH 委派 Worker；插件会自动配置原生 MCP 连接。从右侧栏入口、对话顶部标签或设置中的 **Harness Supervisor** 打开 WebUI，或使用 `/hs` 在右侧浏览器打开。界面支持 DSH Desktop 和本机 DSH Web。

人工界面可查看本机当前 HS 实例的全部 Worker，按“工作目录 → 会话 → Worker”分组，默认展开当前对话。可读取状态、结果、轨迹与用量，回答输入或取消任务；创建与续接任务由 Master 完成。禁用或卸载插件不会停止已有 Worker。

## 更新插件与配套核心

1. 按当前 DSH 自带插件管理器的提示卸载旧版，再添加 `dsh-harness-supervisor@latest`。卸载不会停止已有 Worker；此时只准备配套核心，运行实例保持原版本。
2. 点击 **设置 → Harness Supervisor → 应用配套 HS 核心**。
3. HS 暂停接收新任务，等待已有任务和队列结束，再切换并验证新核心。可通过 **刷新状态** 查看进展。

等待期间仍可回答输入、取消 Worker 或取消此次更新，没有隐式强杀期限。已登记的更新由 HS 继续执行，不要求设置页一直打开；切换后需重新打开 WebUI。

更新作用于同一状态目录中的共享核心，不覆盖源码仓库或全局安装文件。仅更新 npm 包不等于切换运行核心。旧 `0.9.2` 等缺少所需能力的实例，首次迁入须先安排维护窗口、处理活动 Worker 并停止旧 daemon。

## 配置与边界

默认复用 `HARNESS_SUPERVISOR_HOME` 或 `~/.harness-supervisor`。可在插件配置中设置 `stateDir`、`nodeExecutable`；不同状态目录属于不同实例，更新不会跨实例生效。

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
npm --prefix packages/dsh-plugin run pack:release -- --core-tarball ../../.artifacts/harness-supervisor-0.10.4.tgz
```

核心必须先完成当前版本的 `npm run build`。插件打包解包固定核心 `.tgz`，对照 `production-lock.json` 验证生产依赖，再用 `bundleDependencies` 生成独立安装包；安装时不重新编译。DSH SDK、React 等宿主能力不重复打包。

真实宿主联调应使用独立 DSH 测试 profile，例如将生成的插件包安装到 `hs-dev`，并在该 profile 的插件配置中把 `stateDir` 指向独立测试目录。所有开发 CLI/MCP 应指向同一测试目录，避免连接正在使用的共享实例。普通用户按前面的 npm 安装步骤使用即可。

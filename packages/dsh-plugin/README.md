# DSH Harness Supervisor

将 DSH 会话作为 Harness Supervisor 的 Master，委派 Pi、Qoder、MiniMax Code 等原生 Worker。支持 DSH `0.2.2-rc.1`，配套 HS `0.10.1`；其他 DSH 版本尚需验收。

[项目仓库](https://gitcode.com/chenpi_1/harness-supervisor) · [完整项目 README](https://gitcode.com/chenpi_1/harness-supervisor/blob/main/README.md)

## 安装与使用

在 DSH 插件管理器安装 `dsh-harness-supervisor-0.1.1.tgz` 并启用。安装包包含核心、依赖和共用 WebUI，无需额外安装 HS 或编译。

从左侧导航、会话顶部或设置中的 **Harness Supervisor** 打开共用 WebUI。人工视图可查看全部 Worker，默认只展开当前对话分组；没有当前对话时也可在左侧导航和设置页查看。也可用 `/hs` 在右侧浏览器打开同样的全局视图。支持 DSH Desktop 和本机 DSH Web；禁用或卸载插件不会停止已有 Worker。

## 通过插件更新核心

1. 安装新版插件 `.tgz`。此时仅准备配套核心，运行中的 HS 保持原版本。
2. 在设置中点击 **Harness Supervisor → 应用配套 HS 核心**。
3. HS 暂停接收新任务，等待已有任务与队列结束，再切换并验证新核心。可点击 **刷新状态** 查看进展。

等待期间仍可回答请求、取消 Worker 或取消此次更新，不会到时强杀任务。关闭设置页或禁用插件后，已登记的更新仍由 HS 继续执行。切换后需重新打开 WebUI。

更新的是相同状态目录中的共享核心，不会覆盖源码仓库或全局安装文件。当前使用 `.tgz` 分发，尚未提供在线检查新版功能。旧 `0.9.2` 等缺少所需能力的实例须先安排维护窗口、处理活动 Worker 并停止旧 daemon，插件不会自动替换它们。

## 配置与边界

默认复用独立 HS 的状态目录：`HARNESS_SUPERVISOR_HOME` 或 `~/.harness-supervisor`。可在插件配置中设置 `stateDir`、`nodeExecutable`；不同状态目录属于不同实例，更新不会跨实例生效。

插件为每个真实 DSH Agent 复用一个 MCP 连接，固定会话归属和通知策略。模型只能查询和操作所属会话的 Worker 与通知 ACK，不能修改共享通知目标或执行升级。旧 Worker 不会自动归入 DSH 会话。会话范围是路由护栏，不是操作系统隔离。

WebUI 的浏览器入口使用一次性链接兑换独立凭证，不接触 IPC Token。刷新和读取结果不会唤醒模型或自动 ACK；daemon 重启后需重新从入口连接。

无法确认进程状态时，自动切换会停止，不会强杀进程或并行启动另一核心。恢复线索位于状态目录的 `runtime-update.json`、`runtime-update.log` 和 `runtime-backups/`；不要删除锁强行恢复。

## 开发与打包

插件与 HS 核心在同一仓库维护。以下命令在插件目录执行，普通安装无需执行：

```powershell
npm test
npm run build
```

先在仓库根目录运行 `npm run build`、`npm run pack:core`，再在插件目录打包：

```powershell
npm run pack:release -- --core-tarball ../../.artifacts/harness-supervisor-0.10.1.tgz
```

HS 核心发布物已包含经过根锁文件校验的生产依赖。插件打包只解包该固定压缩包，对照 `production-lock.json` 核对依赖版本，再使用 npm `bundleDependencies` 制作可直接安装的发布物；不重新解析依赖版本，不执行安装脚本。DSH SDK、React 等宿主能力不随插件重复打包。

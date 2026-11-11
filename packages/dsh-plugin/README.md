# DSH Harness Supervisor

将 DSH 会话作为 Harness Supervisor 的 Master。插件按真实 Agent 身份挂载原生 MCP client，复用同一个 HS daemon；禁用插件只释放 MCP 连接，不停止 Worker。

支持 DSH `0.2.2-rc.1`，配套 HS `0.10.0`。其他 DSH 版本须重新验收。发布包已携带核心、生产依赖及共用 WebUI，不需要全局安装 HS，也不执行安装时编译。

在 DSH 插件管理器安装发布的 `dsh-harness-supervisor-0.1.0.tgz`，启用后在当前会话输入 `/hs`，或使用设置中的 **Harness Supervisor → 打开当前会话面板**。同一界面支持系统浏览器、DSH Desktop 和本机 DSH Web。面板固定于打开时的会话；切换会话后重新打开对应面板。刷新与结果读取不唤醒模型，也不会自动 ACK 通知。

默认状态目录与独立 HS 相同：`HARNESS_SUPERVISOR_HOME` 或 `~/.harness-supervisor`。可在插件配置中设置 `stateDir`、`nodeExecutable`。会话作用域是路由护栏，不是操作系统隔离。

升级插件仅提供新核心候选。在设置中点击 **应用配套 HS 核心** 后，共享 daemon 暂停新任务准入，等待已有任务与队列结束，再切换已校验版本。排空阶段仍可审批、取消任务或取消更新；不强杀阻塞 Worker。无法确认进程状态时自动切换停止。旧 `0.9.2` 等未托管实例须先安排维护窗口，插件不会替换运行中的不兼容实例。

开发时运行 `npm test` 与 `npm run build`。发布使用固定 HS 构建的压缩包：

```powershell
node scripts/pack.mjs --core-tarball <harness-supervisor-0.10.0.tgz>
```

HS 核心发布物已包含经过根锁文件校验的生产依赖。插件打包只解包该固定压缩包，对照 `production-lock.json` 核对依赖版本，再使用 npm `bundleDependencies` 制作可直接安装的发布物；不重新解析依赖版本，不执行安装脚本。DSH SDK、React 等宿主能力不随插件重复打包。

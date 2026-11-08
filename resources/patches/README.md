# 工作台补丁

`series.json` 是补丁应用顺序的唯一清单，由 `build/build.ps1` 和补丁回归测试共同读取。构建在应用前检查重复、缺失、非法文件名和未登记的补丁。

产品级外观与启动行为优先放在 `resources/app.json` 的 `product` / `settings`；当前 38 个补丁里，大多数修改 workbench DOM、命令调度或自定义侧栏/启动流程，其余是源码安装兼容补丁。少数纯 chrome 细节可以评估改为接受原生行为或改走资产注入，见下文「补丁分层与预算」。不要为了减少补丁数量删除行为补丁，除非同时接受对应功能消失、重写 Custom UI 或完成桌面回归。

这些补丁针对 `resources/app.json` 固定的 Code OSS 源码版本。多个补丁会修改同一文件；不要按文件名排序或直接拼接合并。补丁栈识别会在临时副本中逆序剥离补丁，历史菜单和侧栏补丁还包含专门的升级流程。

| 范围 | 补丁 |
| --- | --- |
| 主对话与编辑区 | core-ui、editor-layout、conversation-chrome |
| 菜单与键盘 | minimal-ui、keyboard-policy |
| 终端与 Worker | terminal-panel、terminal-reveal、worker-panel、worker-sidebar-tabs |
| 侧栏布局与关闭行为 | panel-ui、sidebar-mode、sidebar-size、sidebar-max-width、sidebar-close-tabs、sidebar-title-row、sidebar-empty、sidebar-auto-close、sidebar-no-dnd |
| 会话与文件树 | session-list、session-workspace、explorer-editing、explorer-background |
| 启动与主题 | startup-ui、theme-startup |
| 后台与 Windows 托盘 | background-tray |
| 上游编译兼容 | source-compile-fixes |
| 精简源码安装兼容与成功缓存 | source-postinstall |
| 安装脚本变更与依赖清理缓存检查 | source-install-cache |
| 必需依赖包完整性检查 | source-install-integrity |
| 系统和 CPU 架构缓存检查 | source-install-runtime |

精简源码可以省略 `.github`、`.agents` 中的可选代理说明；安装会记录并跳过缺失的链接源。`source-postinstall` 在 `source install` 执行 npm 前应用，且只在后处理成功后写入安装成功缓存。不要删除 `.npmrc`、`.nvmrc` 或 `build/npm/dirs.ts` 列出的依赖目录。`.vscode/extensions` 仍参与安装和扩展编译；`.eslint-plugin-local` 是 `eslint.config.js` 的直接依赖，删除后上游 ESLint 检查无法运行。

安装前会检查必要配置和脚本。构建、watch 和启动统一调用安装状态检查，缓存失效时自动执行完整安装。缓存包含安装脚本哈希，并检查有依赖的包是否保留 `node_modules` 目录及必需直接依赖的 `package.json`，兼容 npm 向上级目录提升依赖，并排除可选依赖；该检查不验证全部传递依赖或包内文件，怀疑依赖损坏时应执行 `node build/build.mjs source install` 进行完整重装。Git 配置仅写入当前源码仓库，所有权例外仅对该次命令生效。

`node src/main/source-dependencies.mjs vendor/vscode --check-state` 只读检查安装状态：退出码 0 表示缓存有效，1 表示需要安装，2 表示必要源码输入缺失或检查异常。构建入口只对退出码 1 自动安装；退出码 2 会保留诊断并停止。

构建入口对 fetch、apply、install 和单次 build 持有 `.cache/source-mutation.lock` 的系统文件锁；另一进程不能同时修改源码或安装依赖。自动安装在取得锁后再次检查缓存，避免其他进程已完成安装后仍重复重装。嵌套操作共用锁，异常或进程终止后由操作系统释放；残留的锁文件不代表仍在占用，无需删除。长期 watch 和桌面运行不持续持锁。直接调用上游 npm 命令不经过此锁。

安装缓存记录 Node 版本、操作系统和 CPU 架构；复制到不同平台的依赖以及缺少这些字段的旧缓存会触发重装。

新增补丁时，在清单中明确插入位置，同时检查 `build/build.ps1` 是否需要同步预构建产物修补逻辑。修改已有补丁时，应保留或补充旧版补丁升级测试。

## 补丁分层与预算（2026-11）

减少与上游对抗的目标不是一次删掉补丁，而是把新增行为挡在补丁之外，并让补丁集只保留“必须改 workbench 内部”的部分。当前 `series.json` 38 个补丁，目标是在两个上游升级周期内收敛到 ≤24 个。

| 层级 | 手段 | 适用 |
| --- | --- | --- |
| T0 | `resources/app.json` 的 product / settings、扩展 `package.json` 的 contributes、命令与键位 | 产品默认值、菜单可见性、命令注册、视图声明 |
| T1 | 扩展贡献（TreeView / WebviewView / WebviewPanel / 状态栏 / 命令 / when 子句 / `workbench/workbench.css`） | 会话树、Worker/黑板/日志面板、对话框、入口按钮 |
| T2 | 构建期资产注入（`workbench.css`、`startup.html`、product 字段） | 原生 chrome 的样式、启动画面、品牌 |
| T3 | 源码补丁 | 只有 DOM 结构、布局算法、命令调度、原生输入处理必须改变时才使用 |

规则：新增能力先按 T0→T3 的顺序找落点；任何新 T3 补丁必须在 `series.json` 附近写明为什么 T0–T2 不可行。合并同文件补丁（侧栏 9 个、面板 4 个、菜单/键位 3 个、浏览器 4 个）应逐步收敛成组补丁，减少锚点冲突面积。

第一批可评估“接受原生行为或改走 T1/T2”的补丁：`sidebar-no-dnd`、`sidebar-empty`、`sidebar-close-tabs`、`sidebar-auto-close`、`sidebar-event-type`（原生侧栏细节）；`startup-ui`（淡出可改 `workbench.css` 动画）、`theme-startup`（默认主题可由 product settings 保证）；`composer-file-drop`（页面已整页拦截文件拖放，需回归确认宿主不再抢打开编辑器）；`background-tray`（优先在 `src/main` 主进程实现）。这些移除都需要逐项跑桌面回归，不以删补丁数量本身作为验收。

验证命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File src/main/test/source-patches.ps1
node build/build.mjs source apply
node build/build.mjs check
```

第一条在临时副本中验证干净源码应用、重复识别和历史升级，不改动开发中的 `vendor/vscode`。第二条会应用到实际源码，应在回归测试通过后运行。

# UBOVM Core

UBOVM 的工作台扩展，使用 VS Code Extension API 与 CommonJS 入口，在扩展宿主中加载应用内打包的 ESM Harness SDK；Webview 负责界面与消息通信。

协助和探索会话未选择目录时，自动在 `~/.ubovm/workspace/<会话ID>/` 创建独立工作空间（旧会话的非 UUID 标识使用稳定哈希作为目录名），并持久化保存路径。顶部工作空间按钮显示完整路径，可点击选择其他本地目录；已配置的历史会话保留原目录。切换会话后，文件读写、搜索、验证与 Agent 本地命令使用该会话的目录。运行中不可切换工作空间；停止后可切换，执行检查点按工作空间隔离，切回原目录仍可恢复原执行。

## 目录与职责

系统配置的模型页支持命名保存多套模型配置，在默认模型、思考 Agent、执行 Agent 和摘要模型之间复用；选择后点击“保存更改”应用到当前角色。可另存副本、重命名或删除已保存配置，删除不会影响角色现用模型。同一服务商和 API 地址共用凭据，API Key 仅保存在系统凭据库。旧的单模型设置可继续使用。

SSH 页可添加、复制、删除多个连接并选择默认连接；复制仅复制连接参数，密码和私钥口令需重新填写。各连接可独立测试。终端下拉菜单可选择任一已保存 SSH 主机，默认连接用于新建默认 SSH 终端。

```text
renderer/
├─ extension.cjs            # 扩展入口、命令注册与工作台集成
├─ package.json             # 扩展声明
├─ README.md
├─ harness/                 # IDE 侧执行、会话与配置适配层
│  ├─ harness-service.cjs   # Agent 执行、流式状态与恢复
│  ├─ sessions.cjs          # 多会话存储与原生会话树
│  ├─ message-actions.cjs   # 系统剪贴板、外链与工作区文件打开
│  └─ config/
│     ├─ model-config.cjs   # 模型配置与凭据读取
│     ├─ model-presets.cjs  # 当前 SDK 服务商预设
│     ├─ settings-config.cjs # 配置校验、保存、回滚与凭据注入
│     └─ settings-schema.cjs # 字段、选项与默认值
├─ host/
│  ├─ terminal-service.cjs  # SSH Pseudoterminal、终端配置与本机终端入口
│  └─ webview.cjs           # 页面资产顺序、模板组装与 CSP nonce
├─ webview/                 # 浏览器页面与脚本
│  ├─ index.html            # 主空间 HTML 模板
│  ├─ styles.css            # 主空间布局与样式
│  ├─ motion.css            # 全局减少动态效果覆盖
│  ├─ app.js                # 页面状态、事件与宿主消息通信
│  ├─ settings/             # settings.html、settings.css、settings-ui.js
│  ├─ messages/             # message-markdown.js/.css、message-view.js/.css
│  ├─ preview/              # html-preview.js/.css
│  └─ vendor/               # marked.umd.js、marked.LICENSE、marked.NOTICE.md
├─ workbench/               # build.bat 处理的原生工作台资产
│  ├─ startup.html          # 窗口首帧启动画面
│  └─ workbench.css         # 原生工具栏、侧栏与终端样式
├─ media/                   # 图标与界面资源
├─ themes/                  # 工作台主题
└─ test/                    # 原有单元与桌面测试入口
```

`harness/` 是 IDE 侧适配层，使用 Node.js 和 VS Code API 处理文件、凭据、会话持久化与 Agent 调度；通用执行器与 SDK 位于项目的 `src/harness/`，由此处调用。`host/` 保留网页组装逻辑，`webview/` 只运行浏览器代码，通过消息调用宿主；新增界面模块放入对应功能目录。`host/webview.cjs` 集中维护模板、样式与脚本的装配顺序：样式依次为基础布局、功能组件、`motion.css` 的减少动态效果覆盖；脚本先加载依赖和组件，再执行 `webview/app.js`。整页使用同一个随机 CSP nonce。修改或增加页面资产时同步更新此处，不在扩展入口重复拼装。

`workbench/` 面向原生 Code OSS 工作台，独立于 Webview。启动动画注入、工作台样式同步及产品校验值更新由根目录 `build.bat` 处理。`media/`、`themes/` 和 `test/` 路径保持不变。

## 界面与执行

- 扩展标识：`ubovm.ubovm-core`
- 扩展宿主入口：`extension.cjs`；主空间对话：`webview/index.html`；原生启动画面：`workbench/startup.html`。
- 从左到右为会话列表、主对话、文件查看与编辑区、项目文件树。主对话使用 `ubovm.welcome` WebviewPanel，固定在第一个编辑器组；原生标签和标题栏不创建并回收占用高度。打开的文件进入右侧编辑器组，保留文件标签和关闭按钮。
- 右侧原生文件树跟随当前会话的工作空间，切换会话、模式或目录时替换根目录；默认工作空间创建完成后自动展开，空目录显示空文件夹提示。仍可手动展开或收起，右侧文件栏不提供独立选择入口。目录监听、新建文件与空目录判断均使用会话目录。`host/session-explorer.cjs` 串行合并切换请求，`resources/session-workspace.patch` 提供原生 Explorer 桥接，不改变窗口工作区或重启扩展宿主。
- 左侧原生会话树由 `harness/sessions.cjs` 提供，容器为 `ubovm-sessions`，视图为 `ubovm.sessions`。它位于 Secondary Side Bar；Primary Side Bar 位于最右侧并显示原生文件树，内置侧栏 Chat 已禁用。
- 两侧标题栏提供收起按钮；主空间页头两端的侧栏按钮始终保留，可再次展开或收起对应侧栏。会话栏的放大镜打开原生搜索框，搜索当前模式的标题、消息正文、目标、验收项和笔记；选择结果后跳转，取消不改变当前会话。
- 会话列表使用 44 px 原生行高、36 px 圆角选中区域和 14 px 标题；当前会话以圆点与浅色背景标识，完整标题和消息数可悬停查看。中英文界面采用 Segoe UI / 微软雅黑字体链；协助输入与用户消息使用 13 px，回复正文使用 15 px。
- 左侧会话栏顶部可切换“协助模式 / 探索模式”，空状态时也始终可用，支持键盘方向键与 Home / End。切换后左侧列表、页头、新建入口和主页面一起变化。两种模式各自管理会话、消息与草稿，并分别记住最近选择的会话。协助模式保留聊天；探索模式提供目标摘要、验收清单、黑板、笔记和独立的目标对话。主空间页头缩为 52 px。
- 主空间统一页头、按钮、输入框和字体层级，覆盖 Webview 默认的两侧 20 px 留白。协助消息与输入区使用同一阅读列；目标摘要、导航、正文和指令区使用同一内容网格。验收进度仅由用户确认的条目计算。窄窗口自动精简页头文案，长内容在所属区域滚动，模式切换和发送入口始终保留。
- 协助输入采用紧凑卡片：顶部添加上下文和文件标签，底部显示协助模式、模型设置与发送/停止按钮；输入随内容增长，长草稿在框内滚动，接近 8,000 字符时显示计数。Enter 发送、Shift+Enter 换行，中文输入法确认不会提交。执行中可编辑下一条草稿，只有点击停止按钮才会停止当前运行；旧请求的回执不会清除后来编辑的内容。用户消息使用与输入框对齐的浅色整行卡片。
- 文件标签区分自动编辑器上下文和主动附件。移除标签后，该会话不再自动带入文件内容，直到再次选择文件；工作区信息继续保留。文件选择器的晚返回结果只更新发起会话，并在提交时检查该会话是否仍存在、是否已开始执行。
- 自定义工作台主题：`themes/ubovm-light.json`；原生界面精简样式：`workbench/workbench.css`。
- 全局文件搜索、账户、运行与调试、扩展、源代码管理等通用导航隐藏，编辑器工具栏和菜单仅保留当前工作流需要的入口。顶部三个开关分别控制会话列表、终端面板、文件树；终端创建、关闭与命令执行能力保留。
- 原生 `PanelPart` 仅允许打开 `terminal`，忽略旧配置中的 Output、Problems、Debug Console 等面板选择。Output 与诊断服务仍在后台收集信息和日志，不会显示对应面板。
- 新建终端默认使用 `UBOVM SSH` profile，通过 `host/terminal-service.cjs` 将原生终端输入、输出与尺寸连接至独立的 `SSHCommands.openInteractive()` PTY。配置从本机用户设置与 SecretStorage 读取，不依赖模型配置。终端下拉菜单保留“当前系统终端”，工具栏可选择任意已保存 SSH 主机；断线后需新建终端重连。
- NPM Scripts 视图的扩展声明设为 `when: "false"`，同时隐藏旧配置中的 `npm` 视图；不依赖已弃用的 `npm.enableScriptExplorer` 设置。
- 主空间禁止手动分屏，编辑器最多保留主对话与固定右侧文件组，禁止额外列和嵌套分屏。文件以正式标签页打开，即使调用方显式要求 `preview: true`，也不会创建预览标签。
- 命令：`ubovm.openWelcome`、`ubovm.openAssistant`、`ubovm.newChat`、`ubovm.newGoal`、`ubovm.selectConversation`、`ubovm.setMode`、`ubovm.resetLayout`、`ubovm.openTerminal`、`ubovm.openLocalTerminal`、`ubovm.selectTerminal`、`ubovm.openSource`、`ubovm.showRuntimeInfo`
- 对话界面使用主题变量、CSP nonce 与消息白名单，不加载网络资源。
- 启动后主对话常驻，禁止通过关闭标签页、关闭全部编辑器或跨组移动操作移除；窗口重载后自动恢复。使用 `Ctrl+L` 聚焦主对话，`Ctrl+Shift+L` 或会话树标题栏的加号新建对话，已有会话继续保留并可从左侧切换。
- `harness/sessions.cjs` 在 workspaceState 的 `conversations` v3 中持久化当前模式、每种模式的最近会话和历史；自动迁移旧 `conversation` 数据，并把 v2 混合会话的聊天与目标拆分保存。每种模式独立保留最多 50 个会话，每个会话保留最近 40 条消息。当前会话以圆点标识，重启后恢复选择与消息。`list()` / 扩展导出的 `conversationList()` 只返回当前模式，传入模式参数可只读查询另一模式；跨模式 `select` 会被拒绝。
- `harness/config/model-config.cjs` 管理本机模型配置与 SecretStorage 凭据。点击配置入口或执行 `ubovm.configureModel`；Webview 状态不包含凭据，工作区设置不能替换端点或 MCP 命令。模型消息经过 Markdown 与静态 HTML 白名单渲染，工具输出保留纯文本；选中文件与当前工作区编辑内容作为有界上下文发送。
- `ubovm.openSettings` 打开主空间内的系统配置；`webview/settings/settings.html`、`webview/settings/settings.css`、`webview/settings/settings-ui.js` 在宿主组装页面时注入同一 CSP nonce。分组、下拉选项与默认值集中在 `harness/config/settings-schema.cjs`，服务商预设由当前安装 SDK 目录整理到 `harness/config/model-presets.cjs`；服务商切换联动协议、地址与模型参数，MCP 使用含协议下拉框的连接表单。默认值只补齐未配置字段，不覆盖已有值，也不自动写入设置。`harness/config/settings-config.cjs` 负责宿主校验、版本冲突检测、失败回滚和加密凭据。系统配置包含模型、SSH、搜索、摘要、思考Agent和执行Agent；分类临时复用原生会话栏，主空间不再嵌套侧栏。左侧会话栏底部固定显示“管理配置”，MCP、Skills、系统配置三个入口并列，分别调用 `ubovm.openMcp`、`ubovm.openSkills`、`ubovm.openSettings`，在配置页内也可直接切换。各页均接入真实配置读取。`settingsRead/settingsSave` 消息只返回公开值及凭据存在状态，密码留空不覆盖；运行前才在扩展宿主注入凭据。`summaryEnabled` 控制摘要启用并保留参数。桌面端始终启用全部内置工具，兼容忽略旧 `toolsEnabled`、白名单与工具关闭标记，保留连接参数和凭据。`settingsNavigation` 仅在 Webview 接受切换后更新原生导航，未保存提示可取消切换；返回对话恢复会话树与模式选择。
- `harness/harness-service.cjs` 连接真实执行器：协助模式调用 `agents/collaboration/index.mjs` 的 `runCollaboration`，由 Chat 对话按需派生 Swarm Worker；探索模式调用 `createHarness`，继续使用 Reason/Worker 黑板调度。`swarm.status` 提供任务动态，`swarm.worker.event` 只把子 Worker 的工具事件投影到时间线；主对话正文与最终回复由 Chat 提供。会话模式标识仍为 `assist`，沿用已有历史和 `assist.sqlite`。`ubovm.runGoal/cancelRun/resumeRun` 提供开始、停止和恢复，界面显示真实状态、工具活动和证据。运行中可切换会话，后台回复按原会话 ID 保存；过期会话的前台写入会被拒绝。
- 目标使用 SQLite 检查点，重开后只恢复显示，点击继续后才执行。协助保存独立 SQLite 历史、工具记录与摘要。MCP、Skills 和摘要由本机配置接入，基础工作区工具只读，桌面编码工具另外提供带版本检查的编辑、持久化 diff 和撤销。运行需要工作区信任，修改运行中目标前须先停止。
- 目标在读取模型配置前持久化待执行输入，恢复时按输入版本与黑板修订号判断继续执行或补发已完成结果。协助沿用 `worker.maxModelCalls/maxToolCalls` 调用预算，默认 `0` 表示不限次数；中断记录保存有界的实际工具参数，超限不会继续调用模型掩盖错误。
- 高频执行状态通过 `host/state-publisher.cjs` 合并，只传输当前会话的执行增量，不重复携带历史消息；隐藏窗口、设置页与后台会话不推送流式更新，重新显示时补齐状态。流式文本先保留最新值，在实际发布或工具、消息边界时处理，避免每个 token 重复扫描和脱敏整条时间线。
- 主页面同一帧只渲染一次，目标黑板、笔记与聊天内容在选中时更新。流式文本不重建已有消息，自动滚动校验当前会话、目标标签和阅读位置。输入草稿延迟 180 ms 合并保存，切换会话、失焦或离开页面时立即保存；等待恢复时保留草稿，并阻止按钮或 Enter 提交与恢复冲突的新请求。
- 会话首屏和设置初载显示骨架，数据到达即撤下；目标各标签显示实际执行状态。配置刷新保留原表单，按配置指纹复用分栏节点，保留滚动、展开项和焦点；加载失败可重试，已关闭页面的迟到回包不会重新打开页面。新增动画仅使用透明度或变换，并遵守减少动态效果设置。
- `webview/messages/message-markdown.js/.css` 使用随扩展打包的 Marked 解析 GFM，支持标题、列表、任务清单、引用、表格、链接和代码高亮。代码卡片提供语言、复制、长代码展开与 HTML 预览；未闭合代码围栏保持同一节点，流式追加不重置已完成段落、代码展开状态与选区。解析结果只创建白名单 DOM，图片与远端资源不会自动请求。
- `webview/messages/message-view.js/.css` 将 `execution.parts` 和历史 `message.parts` 渲染为正文与嵌入式工具卡片交错的时间线。连续调用共用一组轻量边框，每行展示工具类别、动作、目标、真实状态与耗时；展开后优先显示纯文本输出，参数独立折叠。失败时保持原有展开状态，不自动展开；可手动展开查看原因，后续更新保留用户选择；复制等待宿主回执，HTML 通过隔离预览打开。文件工具可在指定工作区打开原文件，多根工作区不会串到同名文件。追加日志保留文本节点、选区与阅读位置，只在读者已处于底部时跟随新输出。SSH 与本地技能脚本按实际分块累积有界日志，MCP 进度继续按快照更新。执行结束复用流式消息节点，取消保留中断状态，历史与 Goal 补投递保留相同片段 ID；Goal 内部协议不进入正文。
- 模型实际返回的明文 thinking 使用独立的 `type: 'thinking'` 时间线片段，记录来源、运行/完成/中断状态及有据可查的时间。思考默认展开并按安全 Markdown 渲染，手动收起后保留用户选择；细左线和次要文字与正式回答区分，展开、选区及局部滚动在流式更新和历史转存时保留。收起时延迟解析，纯思考阶段不显示正文输入光标。Reason 和 Worker 分别标明来源，思考不会拼接进 `streamText` 或最终回答；签名、加密及被标记为 redacted 的内容不进入界面。单个思考片段最多保留 12,000 字符，并与工具、正文共享时间线预算，优先保留最终回答。
- `webview/preview/html-preview.js/.css` 提供隔离的静态 HTML/CSS/SVG 预览、源码切换、复制与键盘焦点管理，iframe 使用空 sandbox 和独立 CSP。脚本、表单、导航与外部资源禁用。`harness/message-actions.cjs` 将复制交给系统剪贴板，将外链交给系统浏览器；源码链接经工作区边界与 realpath 校验后打开到指定行列。

## 开发与原生工作台

主启动脚本会把本目录复制到 Code OSS 运行时的 `resources/app/extensions/ubovm-core`，作为内置扩展运行。开发时也可以用 `--extensionDevelopmentPath=<本目录绝对路径>` 加载；修改 JavaScript 后执行「开发人员: 重新加载窗口」。

根目录的 `resources/core-ui.patch` 修改 Code OSS 的 Webview 编辑器输入，为主对话增加 `CannotClose`、`ExcludeFromEditorLimit` 和跨组移动限制；`resources/minimal-ui.patch` 精简原生菜单并拦截手动分屏等命令；`resources/editor-layout.patch` 在核心编辑器服务中限制组数量、方向与嵌套布局。`resources/conversation-chrome.patch` 移除主对话的原生标签和标题栏并重新计算布局高度；`resources/terminal-panel.patch` 将底部原生面板限制为终端。`workbench/workbench.css` 负责收起剩余原生工具栏入口，同时保留文件标签关闭按钮、文件操作、终端与窗口控制。

`resources/session-list.patch` 仅为 `ubovm.sessions` 设置更宽松的虚拟列表行高和专用样式类；文件树仍使用原有行高。行高由核心布局管理，滚动、命中区域和键盘导航与视觉位置保持一致。

`resources/sidebar-mode.patch` 在会话视图顶部加入原生模式切换按钮，底部固定显示“管理配置”及 MCP、Skills、系统配置入口，为欢迎页和虚拟列表预留上下导航空间，列表滚动不影响底部入口。模式通过 `ubovm.setMode` 切换，监听 `ubovm.mode` 上下文同步选中状态；管理入口监听 `ubovm.settingsPage`，仅在 Webview 确认导航后更新选中态。按钮与监听器随视图销毁，不在主 Webview 中重复显示。

`resources/panel-ui.patch` 为侧栏和终端提供 140 ms 进入过渡。收起时直接提交原生布局，不再克隆整栏 DOM；快速切换仅取消本栏自己的动画，减少动态效果时跳过。文件与会话栏沿用原生加载进度，模式及管理入口显示实际命令执行状态。终端在进程与 xterm 尚未就绪超过 120 ms 时显示细进度条，隐藏、切换、完成或销毁时清理。文件欢迎页区分无工作区与单个空文件夹；扩展监听文件事件更新上下文，创建首个文件后恢复原生文件树，删除最后一个文件后恢复欢迎页。首次自动创建的空会话作为占位，不进入历史列表或搜索；发送消息、保存目标或手动新建后才显示，旧历史不会被隐藏。

`workbench/startup.html` 包含首帧即可显示的浅色品牌画面、标志微动和不定进度动画，由 `build.bat` 注入原生 `workbench.html` 与 `workbench-dev.html`。`resources/startup-ui.patch` 在 `PartsSplash` 收到首次真实工作台布局事件后触发 180 ms 淡出，并移除启动 DOM 与样式；不设置最低展示时间或模拟百分比。`prefers-reduced-motion: reduce` 下禁用动画，在布局就绪时立即清理。该补丁也将内置 npm 扩展的脚本视图声明设为不可见。

`build.bat` 在源码编译前应用以上补丁、样式和启动 HTML，并在准备固定版本的预构建运行时时应用对应改动。源码提交、补丁适用性、下载包 SHA-256 和运行包代码位置检查继续生效；脚本会为修改后的工作台 HTML、脚本和样式更新产品校验值，保持完整性检查正常。常驻布局由扩展与核心共同实现；仅将扩展加载到未经补丁修改的其他 VS Code 安装中，不具备核心级关闭与分屏保护。

项目的 Electron 主进程入口为 `src/main/index.mjs`；它转发到真实的 Code OSS 主进程。`runtimeInfo().entryPoint` 显示主入口标记，使用上游源码开发模式时显示 `upstream source`。

持久化根目录由 `src/main/data-paths.mjs` 统一为 `~/.ubovm/`，正式、源码、测试环境分别使用 `desktop`、`source`、`smoke`。`workspaceState`、Webview 草稿、用户设置、SecretStorage、备份及 `context.storageUri/harness` 随 Code OSS 的 portable profile 一起迁移；扩展不另建一套存储路径。`runtimeInfo().persistence` 可查看当前实际路径。启动脚本和直接启动 exe 都在创建新 profile 前尝试迁移本项目旧 `.data/<profile>`，保持源目录备份，拒绝覆盖已有目标和迁移活动目录。

## 测试

`harness/workspace-search.cjs` 通过固定的运行时 ripgrep 执行只读代码检索，不提供通用命令入口。`workspace-validation.cjs` 保存修改前诊断基线、观察语言服务诊断，并通过 `validation-worker.cjs` 执行限定内存和时间的 no-emit 编译检查。编译器仅可读取所选工作区和编译器标准库；不执行用户脚本。结果明确区分问题、检查不完整和指定文件检查通过，构建与测试始终标为未运行。运行 `node --test src/renderer/test/workspace-intelligence.cjs src/renderer/test/coding-service.cjs` 验证真实搜索、编译反馈、诊断变化、取消、路径边界和修改恢复；`coding-native.test.mjs` 也覆盖真实桌面搜索及“错误 → 修复 → 复验”。

`harness/selection-context.cjs` 在切换编辑器焦点前同步捕获选区；`ubovm.attachSelection` 将快照排队提交到原会话，`executionContext` 直接传递该快照，不重新读取整个文件。原生右键菜单和快捷键在扩展清单注册，同时在 `resources/minimal-ui.patch` 的工作台菜单允许列表开放。`node --test src/renderer/test/selection-context.cjs` 验证内容边界、行列、未保存状态、排队期间切换会话与执行时快照稳定性。`assist-composer.mjs` 验证标签、草稿保留和移除；`coding-native.test.mjs` 同时验证真实编辑器选区命令和会话隔离。

编码工具与原生 diff 由 `harness/coding-service.cjs` 管理，通过 `harness-service.cjs` 的 `additionalTools` 注入两种执行模式及协作 Worker。编辑操作跨会话排队，先持久化原始快照，再通过 `WorkspaceEdit` 保存；原生只读内容提供器展示快照，撤销检查当前文件与编辑后快照一致。未保存缓冲区、工作区边界、文件版本与 UTF-8 内容均在宿主检查。

`node --test src/renderer/test/coding-service.cjs` 覆盖创建、替换、删除、冲突、取消、持久化、会话隔离与撤销。准备运行时后运行 `node --test src/renderer/test/coding-native.test.mjs`，使用 `.cache/coding-native-*` 内独立用户目录验证真实编辑器保存、原生 diff、撤销及 BOM / CRLF 保留，不复用正在运行的桌面实例。隔离目录保留测试结果供排查。常规 `build.bat test` 也包含原生编码检查。

`node --test src/main/test/data-paths.mjs src/renderer/test/data-migration.mjs` 检查目录规范化、链接逃逸、旧数据复制与校验、并发修改和失败回滚。`build.bat setup` 后运行 `node --test src/main/test/persistence-desktop.mjs`，会在 `~/.ubovm/smoke` 中正常启动并退出两次，验证实际 SQLite、会话选择及测试密钥跨重启恢复。它不使用 `--extensionTestsPath`，因为 Code OSS 会在扩展测试模式将工作台数据库替换为内存存储。

集成测试入口为 `test/smoke.cjs`，向真实桌面运行时传入 `--extensionTestsPath=<测试文件绝对路径>`，并设置：

```text
UBOVM_SMOKE_WORKSPACE=<已打开的隔离测试工作区绝对路径>
UBOVM_SMOKE_RESULT=<该测试工作区中的 JSON 文件绝对路径>
```

结果文件的父目录必须存在。预构建运行时的测试必须经过项目 Electron 主入口，测试会断言 `UBOVM_MAIN_ENTRY=src/main/index.mjs`。测试使用隔离工作区，并清理临时文件、测试凭据和模型设置，保留 JSON 结果。桌面检查覆盖原有布局、编辑器、终端与会话隔离，并使用本地 HTTP 模型验证流式回复、真实文件读取、Reason/Worker、取消、恢复及工具不重复执行，不调用外部付费模型。

`node --test src/renderer/test/session-modes.cjs` 可独立验证旧会话迁移、模式与目标恢复、深拷贝、过期写入拒绝和保存失败时的数据一致性。

`node src/renderer/test/motion.test.mjs` 使用本机 Edge 验证侧栏退出快照、Worker 面板连续开关、多个原生面板独立切换及减少动态效果。原生侧栏使用 View Transitions，布局只提交一次；不支持该 API 时直接使用原生切换。Webview 的退出动画使用离散 display 过渡，收起时立即禁用 Worker 面板交互。首屏和会话切换淡入不随流式更新重复播放。

启动时立即注册会话树和页面恢复器，优先显示 workspaceState 中已有的会话。页面首次绘制确认后再安装内置 Skills、恢复执行记录；隐藏页面使用 1.5 秒后备触发，执行与会话变更仍经过初始化队列。恢复期间可阅读和写草稿，执行按钮暂不可用。原生占位在首次内容绘制后淡出，超过 12 秒提供重新加载入口。`node --test src/renderer/test/startup-order.cjs src/renderer/test/render-performance.mjs` 覆盖延迟存储、延迟恢复和首次绘制握手。

`node --test src/renderer/test/tool-cards.mjs` 使用真实 Edge 验证工具分组与正文顺序、流式节点和选区保留、完成后历史复用、失败默认收起与手动展开、日志滚动、复制回执、工作区文件定位和隔离 HTML 预览，并覆盖 320 px 窄屏、深色主题及减少动态效果。

`node --test src/renderer/test/thinking-cards.mjs` 验证独立思考及上下文摘要区域的状态、折叠、Markdown、耗时、中断、历史复用和窄屏样式；后端事件投影、并发来源隔离及持久化由 `test/harness-streaming.cjs` 覆盖。

目标概览以 Reason 的思考与调度日志为主栏，Worker 状态为侧栏；可用空间不足时改为单列。并排时可拖动中间分隔条调整宽度，左右键微调、Shift 加速、双击恢复默认，Esc 取消拖动；宽度随草稿状态保存，窗口变小时按最小阅读宽度限制。分隔逻辑位于 `webview/goal/overview-split.js`。思考默认展开，工具详情保留手动展开状态。Worker 列表优先展示运行中的任务，显示创建时间、最新动作及运行状态，点击打开独立执行记录。时间线中的创建事件保持“已派发”，结束事件记录最终状态；Worker 思考只进入其详情页。验收清单和运行信息默认折叠，日志流式更新保留已有节点与用户展开选择。

探索概览支持拖动两个面板的标题交换位置，也可通过交换按钮或标题上的 Alt + 方向键操作。标题栏的关闭按钮只隐藏视图；上方“思考日志 / 任务执行”按钮可重新展开。面板顺序与可见性随界面状态保存，交换时保留原有 DOM，关闭不停止执行。

连续的上下文整理和 `wait_workers` 调用在消息中合并为一条可展开状态，原始调用、摘要和错误仍保留在详情中；失败时不自动展开分组。只有时间线末尾正在输出非空正文时显示输出光标，已有内联运行状态时不重复显示底部执行指示。此合并仅影响展示，不改变执行记录或等待时限。

上下文摘要使用与 thinking 相同的轻量折叠区域，默认收起，展开查看实际摘要、估算的上下文 token 用量变化和耗时。摘要中间件仅在生成新摘要时发布 `context.summary_start` / `context.summary_end`，一次整理内的多个分段共用一个提醒；缓存命中和已整理上下文不会重复触发。使用原文摘录的降级结果会明确标注，失败与取消分别显示未完成/已停止。`type: 'summary'` 片段沿用脱敏、12,000 字符和时间线总预算，随历史保存；Worker 的摘要保留在对应 Worker 详情内。

`node --test src/renderer/test/state-publisher.cjs src/renderer/test/harness-streaming.cjs src/renderer/test/render-performance.mjs` 验证高频更新合并、隐藏与后台会话暂停、消息桥背压、流式工具顺序与取消、协作和目标的独立执行入口、子 Worker 工具投影与正文隔离，以及真实浏览器中的首屏加载、选区保留、目标标签按需渲染、草稿保存和减少动态效果。浏览器测试使用本机 Edge，可通过 `UBOVM_STYLE_EDGE` 指定路径。

页面静态资源在扩展宿主生命周期内读取、拼接一次，重新打开面板仅替换工作区名称、版本和独立 CSP nonce；开发时修改页面资源后需重新加载扩展。流式执行更新复用历史消息投影，不重复遍历已发布历史；完整状态仍会核对历史修改和删除。Worker 目录及已关闭的概览面板延迟渲染，重新打开时立即补齐最新状态；隐藏列表暂停计时文本更新，未变化的日志保留标题与交互节点。`webview.cjs` 和 `render-performance.mjs` 的测试覆盖资源读取次数、历史访问次数、隐藏区域 DOM 变更和展开后的新内容。

`node --test src/renderer/test/settings-config.cjs` 验证配置持久化、运行时凭据注入、SSH / MCP 端点隔离、密钥清除与旧配置迁移、摘要开关保留参数、旧工具开关迁移、冲突拒绝和失败回滚，不调用外部服务。

扩展 API 参考：[Tree View](https://code.visualstudio.com/api/extension-guides/tree-view)、[Webview](https://code.visualstudio.com/api/extension-guides/webview)、[Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)。

模型连接页使用本地 SVG 提供商图标；原生增强下拉在选项和已选项中显示图标，不支持增强下拉的内核仍显示当前提供商图标。模型角色标签支持方向键、Home/End 和明确选中态，重复点击当前标签不触发切换；切换角色不会重复聚焦原生侧栏。使用 node --test src/renderer/test/settings-ui.mjs 检查交互、独立保存与三种窗口宽度。
# 聊天内工具审核

人工审核模式下，工具调用直接在聊天流中显示审核卡片，包含工具名、执行者、可展开的完整参数，以及“允许执行”和“拒绝”。批准仅作用于该次调用；多个 Worker 的请求可独立处理，不再打开额外审核页面。已允许、已拒绝和已取消的卡片显示对应状态。

待审核请求由宿主保管，切换会话或重新加载聊天视图后可以恢复；停止任务或扩展退出会取消待处理请求，过期、重复及跨会话操作不能批准执行。已处理的审核卡片最多保留最近 100 条，仅在当前扩展运行期间保存。

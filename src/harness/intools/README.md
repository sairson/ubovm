# 内置工具目录

`index.mjs` 是统一注册、公开导出和会话生命周期入口。工具名称、参数及 SDK 导出保持不变；其他模块的相对路径属于内部实现。

| 目录 | 职责 |
| --- | --- |
| `terminals/python/` | Python 执行与 pip/uv 环境管理工具、内置解释器发现、沙箱策略、队列及宿主初始化 |
| `terminals/local-shell/` | 本机 Shell 工具及执行策略 |
| `terminals/ssh-terminal/` | SSH 命令、连接池、交互终端、SFTP 和部署 |
| `skills/` | 技能资源读取和本机技能脚本执行 |
| `network/browser/` | 浏览器工具入口及运行时适配 |
| `network/obscura/` | 浏览器自动化底层实现 |
| `network/fetch/` | 网页获取与内容提取 |
| `network/websearch/` | 网页搜索 |
| `note/` | 会话笔记工具（资产/漏洞字段、黑板晋升）；与 `../learning/` 被动学习无关 |
| `domain-inventory/` | 域名攻击面台账（种子域、关联资产、覆盖状态）；安全阶段验收门禁 |
| `todo/` | 任务清单工具 |
| `delivery/` | 交付工作流工具与记录校验 |
| `shared/` | 跨工具基础：`common.mjs`、`http/`、`store/`（MemoryStore）、`process/`（输出/进程/持久 shell） |
| `runtime.mjs` | `createInternalTools` 会话编排（证据、学习接线、Worker 工具缓存） |

`index.mjs` 是工具工厂与 `createInternalTools` 的公开导出入口；编排实现位于 `runtime.mjs`。执行类工具在 `terminals/`，联网类工具在 `network/`。被动学习（`learn_capability`、共享库、后台队列）在 `../learning/`，由 runtime 接入。工具专属实现放在对应目录，跨工具复用的基础代码放在 `shared/`。测试与模块同级 `test/` 目录；新增工具仍通过根 `index.mjs` 注册和导出。Python 的 `setup.mjs` 仅供宿主初始化命令调用，不开放给 AI。

内置 Python 由 `src/main/prepare-python.mjs` 按 `resources/python-runtime.json` 下载、校验并准备，构建脚本复制到 SDK 同级的 `runtime/python`。`python/runtime.mjs` 负责源码和打包环境的定位，AI 无权改写解释器配置。

Shell、SSH 与 Python 共用 `shared/process/process-output.mjs`：stdout/stderr 分别进行增量 UTF-8 解码，按到达顺序合并输出，每 16ms 或累计 32KiB 推送一次。连续 stderr 分片只在切入 stderr 时加前缀，避免将网络分片插入单词中。退出、失败和取消收尾时立即刷出剩余输出，结束后的迟到数据不再发布；输出预算包含 stderr 前缀与异常字节解码后的扩张。仅转发模式不重复保留完整结果，最终结果只合并一次。高频批处理、字节边界和结束竞态由 `shared/process/test/process-output.test.mjs`、`shared/process/test/process-stability.test.mjs` 及各工具测试覆盖。

本地 `run_local_shell_command` 和远端 `run_linux_ssh_command` 可传入 `session: "build"` 等命名会话，在同一 Worker 生命周期内保留 shell 变量、环境变量和工作目录。省略 `session` 仍为单次隔离执行；会话不跨应用重启恢复。不同 Worker 的命名空间隔离，每个工具最多 16 个会话，同一会话串行执行，超时从实际开始执行计时。Windows 使用 PowerShell，本地 Unix 使用 `/bin/sh`，SSH 使用非交互 Bash；没有 PTY 提示符和输入回显。stdout/stderr 使用独立随机结束帧，等待两路输出结束后才完成调用。

本地显式 `cwd` 会切换会话目录，省略则保留当前目录。普通非零退出状态会报错并保留会话；执行 `exit`、取消、超时、输出超限或断连会使会话失效，不重放命令，必须传 `reset_session: true` 明确重建。同名会话重建也可用于主动清空状态。禁止在命名会话读取 stdin、启动后台任务或永久重定向 shell 的 stdout/stderr，这些操作会破坏命令边界。独立使用工具工厂时需调用其 `close()`；运行时自动清理所有 Worker 的空闲与活动会话，外部注入的 SSH 连接池仍归调用方所有。

宿主可通过 `onCommand` 注册每次本地/SSH 命令的 `interrupt()` 句柄，调用结束后注销。中断只影响这一次调用，排队命令中断不会终止正在执行的另一条命令，Agent 和其他 Worker 可以继续工作。界面在运行中命令卡片上提供“中断命令”和“放在一边”。本地与 SSH 均支持宿主驻留：`retain=true` 或常见长跑模式（如 `npm run dev` / `vite`）会自动驻留，agent 本轮结束或“停止执行”不会打断；驻留后前台超时取消，命名会话会释放队列并另开新 shell，连接池在仍有驻留工具引用时保持存活。切换工作空间、删除会话或退出应用会清理驻留任务。中断原因与已接收输出保留；不自动重试用户中断的命令。默认执行超时为 120 秒，宿主可设置更小上限。

每个持久会话最多排队 64 条命令，按调用进入顺序执行；本地目录验证也在取得队列位置后进行。取消会立即移除等待项并释放其计时器和监听器。驻留命令可 `park` 释放活动槽，避免 `npm run dev` 堵死同名会话的后续调用。排队等待另设与本次 `timeout_seconds` 相同的上限，等待超时返回 `SHELL_QUEUE_TIMEOUT` 且不会随后执行；队列已满返回 `SHELL_QUEUE_FULL`。命令取得执行位置后单独计算执行超时，目录准备和 shell 启动也在此预算内。结果的 `queue_wait_ms` 记录等待耗时，界面区分排队、准备、运行和停止。无效目录不破坏已有会话状态；工具 `close()` 同时取消隔离执行与持久执行并等待清理。

本地持久 shell 中断后终止进程树并最多等待 2 秒，结果通过 `process_closed` 区分已关闭与未确认清理；启动阶段也能取消，迟到的 shell 会关闭。SSH 命名会话要求 Linux `setsid` 和 `/proc`，以独立进程组启动，取消时用额外 SSH exec 通道校验随机环境标识后终止整组进程，不只关闭输出通道。控制通道最多等待 1.5 秒，失败或断连时返回 `remote_termination_confirmed: false` 并保留警告；不可把网络断开当成远端进程已终止。

SSH 工具的 `close()` 同时取消本工具的连接等待、单次命令和命名会话；重复关闭复用同一清理操作，不影响共用连接池中的其他工具。取消连接等待会立即释放监听器，迟到的 exec 通道会被关闭，不再发布输出。单次 SSH 命令中断时发送 KILL 并关闭通道，但协议无法确认整个远端进程树已结束，因此错误明确携带 `remote_termination_confirmed: false`，保留输出和不确定性提示。

运行全部工具回归：

```sh
node --test "src/harness/intools/**/*.test.mjs"
```

真实浏览器和系统沙箱集成测试仍需各自的本机环境配置，默认跳过的测试不代表通过了真实环境验收。

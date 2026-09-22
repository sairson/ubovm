# UBOVM IDE

<p align="center">
  <img src="src/renderer/media/app-icon.png" width="112" alt="UBOVM IDE 图标">
</p>

<p align="center">
  面向 AI 协作、代码探索与自动化执行的桌面开发环境。
</p>

UBOVM IDE 是一个基于 Code OSS 工作台深度定制的 AI 原生 IDE。它将对话、目标规划、多 Agent 协作、代码编辑、执行记录、终端和项目文件组织在同一个桌面工作流中，让模型不只回答问题，也能围绕真实工作区持续理解、执行、验证和恢复任务。

项目当前版本为 **0.1.0**，固定基于 Code OSS **1.135.0**，Windows 预构建运行时来自 VSCodium **1.135.06055**。

## 核心能力

### 两种工作模式

- **协助模式**：适合日常问答、代码分析、修改与调试。支持多会话、文件上下文、流式回复、工具调用时间线，以及按需派生的协作 Worker。
- **探索模式**：面向更长、更复杂的目标。使用目标摘要、验收清单、黑板、笔记、Reason/Worker 调度和 SQLite 检查点组织执行过程，可在中断后继续。

### AI 与 Agent 工作流

- 支持为默认模型、思考 Agent、执行 Agent 和摘要任务分别配置模型。
- 同一服务商可复用连接信息，API Key 通过系统凭据存储保存，不写入 Webview 状态或项目文件。
- 支持多 Agent 协作、并行 Worker、调用预算、停止与恢复，以及工具执行证据的持久化。
- 工具调用以时间线卡片呈现；启用人工审核时，可逐次允许或拒绝敏感操作。
- 支持 MCP 服务和本地 Skills，将外部工具接入统一执行流程。

### 工作区感知的编码体验

- 每个会话可绑定独立工作区；未选择目录时，会自动创建隔离工作空间。
- 支持工作区文件搜索、上下文选择、文件打开与编辑、持久化 diff、撤销和路径边界检查。
- 修改后可结合语言服务诊断和受限的 no-emit 编译检查进行验证。
- 会话、草稿、消息、目标和执行检查点相互隔离，切换会话不会串用工作目录。

### 专注的桌面界面

- 左侧为会话与模式导航，中间为对话或目标空间，右侧保留编辑器和原生文件树。
- 精简 Code OSS 的通用导航，将主要空间留给 AI 工作流、代码和终端。
- Markdown 消息支持表格、任务列表、代码高亮、复制、长代码展开和隔离的 HTML 预览。
- 内置浅色主题、紧凑布局、启动画面，并支持减少动态效果设置。

### 本地与远程终端

- 保留本机终端入口。
- 可保存多个 SSH 连接、独立测试连接并选择默认主机。
- SSH 终端通过独立 PTY 接入原生终端视图；密码和私钥口令存入系统 SecretStorage。

## 隐私与数据

- 默认关闭产品遥测、更新检查和扩展自动更新。
- 正式运行、源码运行和测试数据分别隔离。
- 用户数据默认保存在 `~/.ubovm/`，包括会话、配置、检查点和 portable profile。
- 模型请求仍会发送到你所配置的模型服务；请根据所选服务商的政策管理敏感代码和数据。
- Webview 使用 CSP nonce、消息白名单和本地资源，不主动加载远程页面资源。

## 系统要求

当前主要支持并测试以下环境：

- Windows 10/11 x64
- Git 与 [Git LFS](https://git-lfs.com/)
- Node.js `>= 24.18.0 < 25`
- PowerShell 5.1 或 PowerShell 7

从源码编译完整 Code OSS 内核还需要：

- Python 3
- Visual Studio 2022 C++ Build Tools
- MSVC v143、对应架构的 Spectre 缓解库和 Windows SDK

生成 Windows 安装包还需要：

- Inno Setup 6，或通过 `UBOVM_ISCC` 指向 `ISCC.exe`
- `rcedit.exe`，由源码依赖安装步骤提供

## 快速开始

```powershell
git clone https://github.com/sairson/ubovm.git
cd ubovm
git lfs install
git lfs pull
npm run setup
npm start
```

`npm run setup` 会下载并校验固定版本的 Windows 桌面运行时，准备 UBOVM 主程序、Harness SDK 和扩展文件。首次运行需要联网下载依赖。

也可以在启动时指定工作区：

```powershell
node build.mjs start "D:\path\to\workspace"
```

开发界面扩展时使用：

```powershell
npm run dev -- "D:\path\to\workspace"
```

## 从源码运行

仓库已经包含经过 UBOVM 定制的 Code OSS 源码，位于 `vendor/vscode/`。构建产物、依赖和缓存不会提交到 Git。

先检查本机工具链：

```powershell
node build.mjs source doctor
```

安装 Code OSS 依赖并应用 UBOVM 补丁：

```powershell
node build.mjs source install
```

编译并启动源码版本：

```powershell
npm run build
node build.mjs source start
```

持续监听源码变化：

```powershell
node build.mjs source watch
```

> 完整 Code OSS 首次依赖安装和编译耗时较长，并会占用较多磁盘空间。生成的 `node_modules/`、`out/`、`.build/`、`.cache/` 和 `.runtime/` 均已加入忽略规则。

## 构建安装包

完成 `npm run setup` 和源码依赖准备后运行：

```powershell
npm run installer
```

输出位于 `dist/`：

```text
dist/
├─ UBOVM-Setup-0.1.0-x64.exe
└─ UBOVM-Setup-0.1.0-x64.exe.sha256
```

如果 Inno Setup 安装在非标准位置：

```powershell
$env:UBOVM_ISCC = "C:\path\to\Inno Setup 6\ISCC.exe"
npm run installer
```

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run setup` | 下载并准备固定版本的桌面运行时 |
| `npm start` | 启动 UBOVM IDE |
| `npm run dev` | 使用 `src/renderer` 中的开发版界面启动 |
| `npm run build` | 安装所需依赖并编译 Code OSS 源码 |
| `npm run check` | 检查已准备的运行时是否完整 |
| `npm test` | 运行真实桌面集成测试 |
| `npm run installer` | 生成 Windows x64 安装程序与 SHA-256 文件 |
| `node build.mjs migrate` | 将旧桌面数据迁移到 `~/.ubovm/`，但不启动 IDE |
| `node build.mjs source apply` | 幂等应用 UBOVM 的 Code OSS 源码补丁 |

运行 `node build.mjs help` 可查看完整命令列表。

## 项目结构

```text
ubovm/
├─ resources/          # 产品配置、源码补丁、品牌资源和安装器脚本
├─ src/
│  ├─ harness/        # 通用 Agent、工具、黑板、检查点和会话执行器
│  ├─ main/           # Electron 主进程入口、数据路径与迁移
│  └─ renderer/       # Code OSS 扩展、Webview、主题、界面资源和测试
├─ vendor/vscode/     # 固定版本并应用 UBOVM 定制的 Code OSS 源码
├─ build.mjs          # 跨平台 Node 构建入口
├─ build.ps1          # Windows 构建、运行、测试和打包逻辑
└─ package.json
```

更详细的工作台实现说明位于 [`src/renderer/README.md`](src/renderer/README.md)。

## 开发状态

UBOVM 目前处于早期开发阶段，界面、配置格式和 Agent 协议仍可能变化。提交问题时，建议附上：

- 使用的 UBOVM 提交版本
- Windows 与 Node.js 版本
- 执行的命令和完整错误信息
- 是否使用预构建运行时或源码运行时

请勿在 Issue、日志或截图中提交 API Key、SSH 密码、私钥或其他凭据。

## 上游与许可

UBOVM 使用并修改 Code OSS/VSCodium 相关组件。上游许可及第三方声明保留在：

- [`vendor/vscode/LICENSE.txt`](vendor/vscode/LICENSE.txt)
- [`vendor/vscode/ThirdPartyNotices.txt`](vendor/vscode/ThirdPartyNotices.txt)
- [`src/renderer/themes/LICENSE-vscode.txt`](src/renderer/themes/LICENSE-vscode.txt)

仓库自身尚未声明独立许可证；除上游许可证明确允许的部分外，请勿推定额外授权。

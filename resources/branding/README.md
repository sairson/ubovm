# UBOVM 产品标志

`src/renderer/media/icon.svg` 是单色矢量源文件：U 形框架代表工作空间，悬浮菱形代表智能核心。启动页、对话页、欢迎页与侧栏共享此文件，跟随主题前景色。

`app-icon.svg`、`app-icon.png`（256px）和 `app-icon.ico`（16–256px）是深绿色底的独立应用图标。安装依赖并安装 Microsoft Edge 后，运行 `node resources/branding/generate-icons.mjs` 可从源文件重新生成。

`build/build.bat setup` 同步桌面运行时；重新启动后窗口采用新图标。预编译 VSCodium.exe 内嵌的文件图标不由窗口 API 修改；资源管理器中的 EXE 文件图标仍属于上游程序。

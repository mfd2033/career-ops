# dashboard-ui/

career-ops **网页版 dashboard** 的自包含 Windows 启动器——把 web UI（`web/`）打包成一个可双击运行的 `career-dashboard-ui.exe`。

## 它是什么

exe 内嵌了：

- **web 应用的 Next.js standalone 服务器**构建（`app/`），
- **Node 运行时**（`node.exe`），
- 应用**图标 + 版本资源**（通过 go-winres）。

启动时它会：

1. 以**自身可执行文件目录**为锚点确定 career-ops 根目录——从 exe 所在位置读取 `cv.md` / `data/` / `reports/`（与 Go TUI 一致），
2. 首次运行时把内嵌运行时解压到 `%LOCALAPPDATA%\career-ops-dashboard-ui\v{N}`（带缓存；重复启动近乎秒开），
3. 选取空闲端口（3000+），设置 `CAREER_OPS_ROOT` / `PORT` / `HOSTNAME` 后启动服务器，并等待其响应，
4. 在 `http://127.0.0.1:<port>` 打开默认浏览器，然后保持常驻（若已有实例在运行则复用之——再次双击只会重新打开浏览器）。

它是 Windows GUI 程序（`-H windowsgui`）：没有控制台窗口，用户机器上无需安装 Node。

## 目录结构

| 文件 | 用途 |
|------|------|
| `main.go` | Go 启动器——嵌入、解压、运行服务器、打开浏览器 |
| `open_windows.go` / `open_other.go` | 平台相关的打开浏览器 / 错误对话框辅助 |
| `go.mod` / `go.sum` | 模块（唯一依赖：`golang.org/x/sys`） |
| `gen-icon.py` | 用 Pillow 绘制应用图标（`icon.ico`）的脚本 |
| `winres/winres.json` | go-winres 资源定义（图标 + 版本信息） |
| `winres/icon.ico` | 应用图标（受版本控制；可用 `gen-icon.py` 重新生成） |
| `build-dashboard-ui.mjs` | 端到端打包脚本 |

## 构建

```bash
node dashboard-ui/build-dashboard-ui.mjs
```

脚本会：

1. 在 `web/` 中运行 `next build`（standalone 输出），
2. 把 `.next/static` 复制进 standalone 目录树（Next 不会自动做），
3. 从 standalone 目录树剥离开发/追踪杂物（`src/`、`tests/`、日志、配置），
4. 把干净的目录树复制进 `app/`（Go embed 源），并把当前运行的 Node 二进制复制为 `node.exe`，
5. 用 go-winres 重新生成 `.syso` 资源（图标 + manifest + 版本），
6. 把 `career-dashboard-ui.exe` 编译到仓库根目录。

需要 **Node 20+**（Next 16 引擎下限）、**Go 1.24+** 和 **go-winres**（首次运行时自动安装到 `.gobin/`）。

## 说明

- `app/`、`node.exe`、`.gobin/` 和 `*.syso` 是构建产物，已在 git 中忽略。
- 每当内嵌应用变化时，记得更新 `main.go` 里的 `cacheVersion`，以免旧缓存被复用而不是重新解压。
- web 构建自托管字体（`web/public/fonts`，通过 Fontsource + `next/font/local`），因此生产构建可以离线运行——无需访问 `fonts.googleapis.com`。
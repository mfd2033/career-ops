# Fork 同步流程（mfd2033/career-ops）

> 目的：在独立 fork 上保留 Windows/非 C 盘定制，同时持续追官方（santifer/career-ops）更新。

## Remote 配置（已设好，勿改）
- `origin`    = https://github.com/mfd2033/career-ops.git  ← 你的 fork（public）
- `upstream`  = https://github.com/santifer/career-ops.git   ← 官方源

## 追官方更新（每次都一样）
```bash
git fetch upstream
git merge upstream/main
git push origin main
```

### 冲突处理要点
合并时通常只在你改过的 3 个文件附近冲突，分两类：
1. **与你的定制无关的差异**（如官方把 `workspaceRoot` 全局变量重构为 `currentWorkspaceRoot()` 函数调用）→ 直接取官方版（`git checkout --theirs <文件>` 后按需重加定制）。
2. **你的增强**必须重新叠加到官方版对应位置：
   - `dashboard/main.go`：保留 `defaultOpsPath()`（exe 锚定自身目录）。
   - `generate-pdf.mjs`：在 `renderHtmlToPdf` / `renderBatch` 的 `chromium.launch(...)` 处叠加
     `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 环境变量支持（见下）。
   - `README.md`：Windows 双击 exe 的说明段落。

`generate-pdf.mjs` 增强片段（叠加到官方 `chromium.launch(options)` 处）：
```js
const launchBrowser = opts.launchBrowser || ((options) => chromium.launch({
  ...options,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
}));
```

## 你的本地定制（不要被 upstream 覆盖）
| 文件 | 定制内容 |
|------|---------|
| `README.md` | Windows 双击 `career-dashboard.exe` 启动 TUI 的说明 |
| `dashboard/main.go` | exe 锚定自身所在目录（`defaultOpsPath`），双击即可用 |
| `generate-pdf.mjs` | `chromium.launch` 支持 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定非 C 盘 Chromium |

## 注意事项
- **`check` 提示 `system-files-changed` 是预期的**（本地定制与官方 main 不同），无害，不是故障。
- **dashboard 改动后必须重新 build**：`cd dashboard && go build -o ../career-dashboard.exe .`（exe 不进 git，仅本地用）。
- **提交时只 `git add` 那 3 个文件，绝不用 `git add .` / `git add -A`** —— 工作区还有未跟踪脚本/缓存（`.cache/`、`.omo/`、`MEMORY.md`、`parse-inbound.mjs` 等），public fork 不应包含它们。
- 未跟踪的私有脚本如需备份，单独放 private 分支或本地另存，勿推 public fork。

# career-ops web（alpha）

面向 career-ops 的**实验性、可选启用的 web UI**。它是一个本地优先的*视图*，浏览的就是 CLI 读写的那同一批文件（`data/pipeline.md`、`data/applications.md`、`reports/`、`config/`）：没有并行的引擎、没有独立的数据库、没有服务端。如果你从不运行它，你的 CLI 工作流程一切照旧。

> **状态：alpha。** 可能有粗糙之处。反馈 → [Discussion #1142](https://github.com/santifer/career-ops/discussions/1142) · 路线图上下文 → [Discussion #156](https://github.com/santifer/career-ops/discussions/156)。

## 快速开始

需要 Node 22+（见[测试](#测试)——`npm test` 的 glob 发现机制需要它）。

```bash
cd web
npm ci
npm run dev
```

打开 http://localhost:3000。应用读取它所在的 career-ops 检出目录（父目录）——你现有的简历、管道和报告会原样显示。

## 目前可用的功能

- **Pipeline（管道）**——把追踪表做成可排序、可筛选的表格；状态修改通过核心自身的脚本写回。
- **Explore（探索）**——免费的逆向 ATS 扫描，带如实标注的部分数据集提示，以及 AI 辅助发现（自带 CLI/密钥）。
- **Apply（申请）**——带硬性规则的辅助表单预填，规则继承自核心：**它绝不会替你提交**——永远由你按下按钮。
- **Today / Analytics / CV / Config**——操作队列、漏斗、带预览的简历编辑、设置。

## 安全

- **本地优先：** 本地 web 应用完全运行在你的机器上——没有云端、无需账号。你的简历和数据留在你自己的文件里。
- **绝不自动提交：** 申请流程只起草和预填；提交永远是人类操作。
- **简历生成从不要求代理写文件：** `pdf` worker 定制你的简历并以 `<<cv-html>>` 信封的形式内联输出；后端解析该信封、写入 HTML，并自行渲染 PDF。职位发布和评估报告是会到达该代理的不可信输入，所以最安全的做法是让它完全不持有写工具——在 Claude Code 上，该模式禁用了所有可写工具（`Write`、`Edit`、`MultiEdit`、`NotebookEdit` 和 `Bash`）。其他 CLI 以裸提示词调用并保留各自的默认工具权限，因此在这些 CLI 上代理仍然*持有*写工具——管道所保证的是：最终渲染的简历是后端从信封中解析出的那一份，绝不是代理在背后写入的文件。
- **加法式：** web 与核心的打包、CI 和发布自动化相互隔离。没有它，CLI 的工作方式完全不变。

## 开发

```bash
npm run dev          # dev server (Turbopack)
npm test             # unit suites (node --test, no framework)
npx tsc --noEmit     # typecheck
npm run build        # production build
```

> 字体已自托管（`public/fonts`，通过 `next/font/local` 接入 Fontsource woff2），因此生产构建无需访问 Google Fonts——这正是离线 `career-dashboard-ui.exe` 打包器能运行的原因。应用还支持 `WEB_STANDALONE=1` 以输出 `output: "standalone"` 服务器供打包器使用，而不改变默认构建形态。

在 `web/.env.local` 中设置 `CAREER_OPS_ROOT=/path/to/checkout` 可将应用指向另一个 career-ops 目录（对用示例数据测试很有用）。

### 测试

测试套件位于 `web/tests/`，路径与它们所测内容在 `web/src/` 下的路径一一对应——所以 `src/lib/clean-chips.mjs` 由 `tests/lib/clean-chips.test.mjs` 测试。测试文件命名为 `{module}.test.mjs`。

`npm test` 用 glob（`tests/**/*.test.mjs`）发现它们，所以新套件**无需注册**——直接加文件即可。**需要 Node ≥ 22**：更早的版本不会为 `node --test` 展开 CLI glob，因此 `npm test` 会打印 `Could not find '…'`、什么都不跑并退出 1。因此 `web/package.json` 里才有 `engines.node`——比 `next` 本身要求的更高。

由此衍生出三条约束：

- **别把测试放进 `src/`。** `src/` 是 Next.js 应用自己的目录树，会被 `next build` 的文件追踪和 `tsc --noEmit` 扫描；测试文件放在那里会把夹具与构建和路由约定搅在一起。
- **用 `.mjs`，不要用 `.ts`。** 有意不引入测试框架和 TypeScript 加载器——`node --test` 无法运行 `.ts` 套件，那样看起来有覆盖率却永远不会执行。把被测逻辑抽成一个纯 `.mjs` 模块（`src/lib/pdf-paths.mjs` 和 `src/lib/pdf-render.mjs` 遵循的就是这个模式），再从测试里 import 它。
- **web 套件用 `node:test`；核心套件不用。** 在这里你写 `import { test } from "node:test"` 配合 `node:assert/strict`。根目录的 `tests/` 套件刻意两者都不用——它有自己的 `pass`/`fail` 辅助函数，因为 [#1440](https://github.com/santifer/career-ops/issues/1440) 要求核心套件能在裸克隆上运行，且"无框架，连 `node:test` 都不用"。不要把任一种风格带过这条边界。

根套件中的 `tests/web-test-layout.test.mjs` 在每次 PR 上强制以上所有约束，包括 `npm test` 永远不能回到按名称列出套件的方式（[#2360](https://github.com/santifer/career-ops/issues/2360)）。
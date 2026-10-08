# ADR-0072: 评分方法论落地为站内文档（取代 career-ops.org 外链）

- **Status:** Accepted (2026-10-08)
- **Context:** 需求（2026-10-08 grill 会话，三轮问答全部锁定）：报告页折叠区里的「完整方法论 ↗」原指向 `https://career-ops.org/methodology`，要改为打开项目内文档，中英双语、默认中文。现状与约束（均经代码核实）：
  1. **站内已有半份抄本**：`web/src/components/score-methodology.tsx` 的六维度与 Block A–G 文案，其顶部注释自称"career-ops.org/methodology 的 CANONICAL 逐字版"，实际存在 i18n 键里（`clusters/pipeline.ts`）。再搬一篇全文进来就是第三份副本。
  2. **三处口径互不一致**：上游文章写"five dimensions"、Block 表只列到 G；站内组件写"六个维度"（把综合分算作一维）；`modes/_shared.md:63` 权威写"五个评分维度 + 一个 global"，并声明报告结构是 A–H；`modes/oferta.md:622` 的输出骨架确有 `H) Draft Application Answers`（仅当分数 ≥ 4.5）。
  3. **上游文章含过期与 fork 无关内容**：`As of 7 May 2026` 的在途清单（#363/#561/#557/#572）、Open Collective 募资段、作者自述。
  4. **上游只有英文版**，中文必须新写；`config/profile.yml` 的 `language.output` 与 web 端 i18n 是两条独立的轴。
  5. **打包运行时不服务仓库树**：`career-dashboard-launcher.exe` 跑的是 `.dashboard-runtime\v{cacheVersion}\app\server.js`（Next standalone），任何界面/文案改动必须重打包才可见（本轮实测两次）。`careerOpsRoot()` 能反查仓库根，所以"运行时读盘"技术上可行，但依赖 runtime 留在 checkout 内。
  6. **web 组件无渲染单测基建**（known gap，ADR-0057/0059/0060/0061/0068 同口径）：可判定约束一律用源码守卫测试锁住，先例 `tests/lib/pipeline-single-nav-entry.test.mjs`。
  7. **AGENTS.md 的两条相关约束**：规则要住在 harness 自动读取的文件里（不要造需要手动加载的 sidecar 文档）；Data Contract 区分 User Layer（永不自动更新，个人化写这里）与 System Layer（可自动更新，不放用户数据）。

- **Scope:** 新增 `web/src/content/methodology.{zh,en}.ts`、`web/src/app/methodology/page.tsx`、`web/src/components/methodology-doc.tsx`、`web/tests/lib/no-upstream-site-links.test.mjs`；改 `web/src/components/score-methodology.tsx`、`web/src/lib/i18n/clusters/pipeline.ts`。**不动**：`modes/_shared.md`、`modes/oferta.md`（权威定义源）、NAV_ITEMS（新页不进侧栏）、`web/next.config.mjs`（试过为 .md 加 turbopack rules，最终不需要，已回退）。

## Decision

1. **内容基底 = 以上游文章为底、纠正后重写**，不是逐字复制。删除在途清单、募资段、作者自述；保留阈值表、维度表、"LLM 判断非闭式公式"、Block 逐块、边界情形、反特征清单六块评分口径本体。
2. **口径以仓库为准**：写"五个评分维度 + 一个综合分"（不是"六个维度"），Block 补到 H 并注明"仅当综合分 ≥ 4.5 生成"。顺带修 `score-methodology.tsx` 的摘要文案与区块列表，使摘要、全文页、`modes/_shared.md` 三处同源。
3. **载体 = 字符串模块随 build 打包**（`web/src/content/methodology.{zh,en}.ts`，命名导出 markdown 正文），不是运行时读盘、不是 i18n 键值对、不是 `web/public/` 静态 HTML。理由：长文塞进 `clusters/*.ts` 的扁平键值对会让 diff 不可读且丢翻译上下文；读盘方案依赖 runtime 位置且多一个 IO 失败分支；public 静态页脱离 AppShell 主题与 i18n。
4. **不用 `.md` 文件：Next 16.3 + Turbopack 下三条路全部走不通**（逐个实测，不是推断）：
   - `turbopack.rules` 的 `type: "text"`（Turbopack 文档给的写法）→ 构建直接报错，合法类型列表里没有 `text`；
   - `type: "raw"` → 构建成功但**默认导出是 `undefined`**（预渲染 HTML 里 `<article>` 为空，靠临时调试节点定性），且它不发射任何 `.md` 产物，等于静默丢内容；
   - `loaders: ["raw-loader"]` → Turbopack 声明支持 webpack loader，但本仓库该次构建直接失败（2 errors）。
     因此退回到模板字符串模块，并卸掉试装的 `raw-loader`。**代价：正文里的反引号与 `${` 需 `\` 转义**（文件头注释已写明）。渲染端仍是 markdown（`react-markdown` + `remark-gfm`），读者看不出载体差异。
5. **语言 = 跟随全站 `useI18n().lang`**，不新增文档级开关、不做"默认中文"的特殊分支。用户当前语言是 zh，因此实际观感即"默认中文"；SSR 首帧恒为 en 的水合约束（`i18n/context.tsx` 注释）保持不变，不为单页破例。
6. **入口 = 只从报告页折叠区进入**。新路由 `/methodology` 挂根布局的 AppShell（自带侧栏），但不加入 `NAV_ITEMS`——它是报告的附属说明，不是工作页。图标由 `ExternalLink ↗` 改 `BookOpen`、去掉 `target="_blank"`，因为语义从"往外走"变成"站内阅读"。
7. **署名与许可进文档页脚**：`来源与许可` 段保留上游链接、MIT、原作者署名，并列出**本 fork 与上游的五条差异**（维度口径、Block H、删除的过期段、反特征清单的 fork 校准、`ofertas` 权重补写）。改写而非抄写，不等于可以不署名。
8. **约束用测试锁住**（`no-upstream-site-links.test.mjs`）：(a) `web/src` 下所有代码文件剥注释后不得出现上游域名字符串，`src/content/` 整目录例外——上游 merge 带回外链当场变红；(b) 摘要入口必须 `href="/methodology"` 且无 `target="_blank"`；(c) 两份文档必须保留出处链接、MIT 与作者署名，且正文不短于 3000 字符，署名丢失或文档被清空同样是回归。
9. **文档纳入 git，按 System Layer 对待**：它是 fork 自有的说明文本，不是用户数据；放 `local/`（gitignored）会丢版本历史，且随 build 打包的载体要求它在 `web/` 树内。

## Consequences

- 正面：报告页与全文页口径一致，读者不需要联网就能看懂分数怎么来的；上游 merge 带回外链会被测试拦住；改文案只需 `npm run build` 验证，不需起 runtime。
- 代价：**摘要、全文页、`modes/_shared.md` 仍是三份文本**，本次靠人工对齐 + 口径注释，没有机制证明同源（全文页页脚已写明权威在 modes/）。上游方法论若更新，本页不会自动跟随。
- 代价：改文档文案要重打包才在界面生效（与所有 web 改动同等对待，非本页特有问题）。
- 已知偏差：Next/Turbopack 升级时应重测一次 `.md` 文本导入是否变得可用；可用则可把两份文档退回真 markdown 文件（改动面只有 import 语句、`next.config.mjs` 与守卫测试里的两个路径）。
- 代价：文档正文存在模板字符串里，编辑要转义反引号，比 `.md` 难受；这是机制缺失换来的确定性，不是偏好。

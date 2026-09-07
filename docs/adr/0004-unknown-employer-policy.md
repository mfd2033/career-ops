# ADR-0004：未知雇主处理策略可配置化（`?` 默认 / 显示代招公司名）

- 状态：提议（Proposed）
- 日期：2026-09-06
- 相关：`modes/oferta.md`（未知雇主规则）、`web/src/app/api/run/route.ts`、`web/src/app/api/batch-evaluate/route.ts`、`web/src/app/api/config/route.ts`、`web/src/lib/app-config.ts`、`web/src/components/config-form.tsx`、`web/src/components/report-view.tsx`、`extension/content.js`（快评）

## 背景

完整评估（oferta 链路）遇到**代招 / 隐藏雇主**（Agency-mediated posting）时，当前规则强制把终端雇主写成 `?`（`modes/oferta.md`），报告标题/`company:` 写成「某大型公司」，代招公司（发帖方，如 FESCO河南）只进 `Via:` 字段。web 端 `report-view.tsx` 用 `app?.company ?? meta?.title` 渲染公司名，于是这种行显示成 `?`，用户判读困难（曾以 #44 为实例反馈）。

用户的诉求：把「未知雇主处理策略」做成 web 配置页的可配置项，默认保持不变（`?`），并允许切到「显示代招公司名」。

### 既有约束（源自 ADR-0002 与 AGENTS.md）

- 完整评估 worker 是 headless CLI（opencode exec），由 server 端 `api/run` / `api/batch-evaluate` 拼 prompt、用 `withModelFlag` 注入 CLI argv 启动。worker 不读 web localStorage，用户自定义值只能经 **server → prompt** 传导（与 `model` 注入同机制）。
- `modes/oferta.md` 是系统层规则文件，禁止写入用户级策略；`?` 语义、`confidential-{agency}` slug、`via=` TSV tag 是既定约定，不得破坏。
- web 配置写入 localStorage `career-ops:config` + 服务端 `~/.career-ops-web/config.json`（`AppConfig`）；`/api/config` 现有白名单只放行 `cliId/model`。
- WEB 端评估引擎隔离承诺：不复制评估逻辑、不改完整评估引擎，仅新增「偏好口径」注入。
- `?` 是 locale-invariant sentinel（未知终端雇主）；代招发帖方随时可得且公开，显示它不泄漏机密。

## 决策

### D1：生效范围——新报告正确写入 + web 对既有历史行回退显示

策略同时作用于两类：

1. **新产生的评估**：tracker `Company`、报告 `title` / `company:` 按策略写入。
2. **既有历史 `?` 行**（如 #44）：web 渲染时按当前策略即时回退，不改底层数据；默认 `?`，启用「显示代招名」则用报告 meta 的发帖方/via 名显示。

### D2：双档语义（非三态）

- **`?`（默认）**：维持现状——终端雇主未知 → Company=`?`、报告「某大型公司」。
- **显示代招公司名**：若 JD 顶部发帖方公司名可得（BOSS 代招页总是显示发帖中介，如 FESCO河南），则 Company/报告标题/`company:` 用它，并在 Notes 保留「代招 + 匿名客户公司」标记；仅当连发帖方都不可得（极少数）才退回 `?`。

不做第三档「未知时降级为 Via 原文」——BOSS 代招页发帖名恒在，中间态几乎不触发，两档即可解释。

### D3：传导路径（方案 A）——server 端 prompt 注入

- 扩展 `AppConfig`（`web/src/lib/app-config.ts`）与 `/api/config` 白名单，新增字段 `unknownEmployer`，允许写 `"placeholder" | "agency"`。
- 配置页 `config-form.tsx` 保存时写入 localStorage + POST `/api/config`。
- 完整评估 worker 启动前，`api/run` / `api/batch-evaluate` 在 `buildPrompt` / prompt 组装处读取该策略，向 worker 的指令追加一条：`本次未知雇主处理策略=显示代招公司名`（或默认不注，保持现状）。
- **不改** `modes/oferta.md`、不引入新项目数据文件、不污染 `config/profile.yml`。

### D4：报告本体同步写

启用「显示代招名」时，worker 产出统一改为：

- 报告标题：`{发帖方}（{agency}·代招） — {role}`
- YAML/正文 `company:`：发帖方名
- `Via:`：保留发帖方（与 company 同源，冗余但不矛盾）
- **文件名 slug 保持** `confidential-{agency}`：遵守「报告文件永不被重命名，仅更新标题/header/YAML」的现有约定。

### D5：快评跟随同一策略

- 快评 text 当前不含公司名（`extension/content.js` `extractDetailJd` 只取职位名+薪资+职责）。启用「显示代招名」时，快评 text 前缀追加发帖公司名，与完整评估口径一致，避免快评"某大型公司"、完整评估显示发帖名的两张皮。
- 扩展从服务端 config（`resolveEvalConfig` 通道）拉取策略；空/未配置时保持现状（不含公司名）。
- CONFINE：这属于「新增偏好口径」，不触碰 WEB 评估引擎逻辑，与隔离承诺相容。

### D6：配置 UI

配置页新增一个 dropdown，两选项，默认「`?`」；文案「未知雇主/代招处理」。不加「一键迁移历史行」按钮——历史行显示靠 D1 的即时回退，无需批量改数据。

## 理由

- **四两拨千斤的传导**：复用 `model → withModelFlag` 同款 server→prompt 注入机制，零改动 worker 侧读取逻辑，改动集中在 server prompt 组装 + 一处配置读写。
- **不改 oferta 规则文件**：策略是用户级偏好，走运行时注入而非改系统层规则，系统更新不覆盖、也不破坏 `?`/slug/Via 既定约定。
- **历史行即时生效**：不用数据迁移、不重命名文件，只改渲染回退，低风险低侵入。
- **快评/完整评估口径统一**：同一策略两端遵从，避免展示分裂。

## 取舍 / 风险

- **prompt 注入的稳定性**：策略靠一条追加指令传达给 headless worker，指令需措辞明确以防模型忽略（默认档「不注指令」最稳，仅「显示代招名」档注入）。
- **快评拉取配置的鉴权**：扩展经 `resolveEvalConfig` 拉 config，需沿用 origin-guard 放行口径，不得放宽到任意 origin。
- **发帖名 ≠ 雇主**：代招公司是中介非雇主，显示其名可误导粗心读者；用「（代招）」后缀 + Notes「匿名客户公司」显式消歧。
- **既有报告不一致**：切策略只影响新报告；历史报告标题仍「某大型公司」；web 回退显示用 meta 的发帖名，但报告文件本体不批量改写。

## 测试

- **unit**：`AppConfig` 读写 `unknownEmployer` 序列化；`/api/config` 白名单放行/拒绝该字段；prompt 组装在两种策略下指令有无；`report-view` 回退逻辑（默认 `?` / 显示代招名 / 发帖名缺失退 `?`）。
- **integration 冒烟**：配置页切「显示代招名」→ 构造一条带 FESCO 式代招 URL 的评估 → 报告标题/`company:`/tracker `Company` 为发帖名 + 代招标注；切回默认 → 保持 `?` 行为。
- **回归**：web 侧 tsc + 既有测试全绿；快评默认档不含公司名（无回归）；`merge-tracker` 解析不受新增字段影响。

## Out of scope

- 自动评估 / 浏览即评估（沿用手动触发）。
- 三态档位与历史数据批量迁移。
- 修改 `modes/oferta.md` 的 `?`/confidential slug/Via 既定语义。
- 非代招场景（终端雇主本就知道）的公司名展示。
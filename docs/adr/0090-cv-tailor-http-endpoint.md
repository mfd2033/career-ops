# ADR-0090: 定制简历 HTTP 触发器 POST /api/cv-tailor（agent 可调用，无 UI）

- 状态：采纳（2026-10-27）
- 决策人：用户（job-hunting 主线，工单 `.scratch/generate-tailored-cv`）
- 关系：与 ADR-0026/0027/0033（单体检前哨 + 在跑守卫 + replace 语义）对称；沿用 ADR-0020（事件总线传输）、ADR-0014（全局并发池）、ADR-0076/2172/2185（web 定制简历产物与渲染登记）

## 背景

「生成定制简历」此前只有两条路：交互式 CLI 里 agent 驱动 `modes/pdf.md`（`build-cv-html.mjs` + `generate-pdf.mjs`），或 web 报告页的 `pdf` 工作器（`/api/run kind:"pdf"`，需前端按钮触发、agent 在环）。两者都不适合「一个脚本/agent 直接 POST 一把就把某行的定制简历离线跑出来并登记好」——上游缺一个**纯后端、零 UI、可被 HTTP 直接调用**的触发器。

公司体检有精确的模板：`POST /api/checkup-request` 做前哨（解析目标 + 同 tracker# 在跑守卫 + replace），实际执行交 `/api/run` 的 checkup worker 经全局并发池跑、经 `/api/events` 广播。定制简历要的就是这条通路的对偶。

## 决策

1. **新增 `POST /api/cv-tailor { n, replace? }`**，路由形态与 `checkup-request` 对称，但**合前哨与派发于一体**：校验通过后立即由全局并发池起 worker、`after()` 转后台、秒回 `{runId}`，请求内**绝不同步等待完成**。无 UI 按钮、无前端产物——这是它与此前 web 通路的唯一但决定性的区别。
2. **入口服务 `findTailorTarget(n)`**（工单 01）：纯函数解析出 `{ company, role, jdText, reportPath }`，`reason` 闭集 `row-not-found`(404)/`missing-jd`(400)，与 `findCheckupTarget` 的 reason 语义对齐。company 复用 `findCheckupTarget` 的 `?`→Via 回退；jdText 优先取 `jds/` 归档正文，回退报告正文；报告缺失即 `missing-jd`（`openai-tailor.mjs` 硬要求 `--report`）。判定住在 `web/src/lib/tailor-target.mjs`（依赖注入，`node --test` 锁定），`career-ops.ts` 只接真实读盘。
3. **worker = 离线编排壳**（工单 02），不重写任何 CLI：按序 spawn `application-artifacts.mjs`（建 `output/<key>/cv/tailored/vNNN/` 并回吐路径 JSON）→ `openai-tailor.mjs`（headless OpenAI 兼容定制引擎，适合无交互 agent 的 worker）→ `generate-pdf.mjs --report=N`（渲染 PDF 且写 `data/pdf-index.tsv`，使 `GET /api/cv-pdf?report=N` 精确命中，含中文公司名）。tailor 引擎二选一以 `modes/pdf.md` 为准：headless 离线路选 `openai-tailor.mjs`；agent 在环的富排版仍走 `build-cv-html.mjs`（本触发器不带 agent，故取前者）。所有外部效应收进注入 deps，`web/tests/lib/tailor-worker.test.mjs` 用 fake 复刻脚本效应来锁编排。
4. **并发护栏与 replace**（工单 04）：`decideTailorPreflight` 是纯决策，**委托给通用的 `decideCheckupPreflight`**（它只依赖 `{live, replace}` 形状、与 kind 无关），不复制会漂移的副本。在跑登记表逻辑抽成通用工厂 `live-registry.mjs`，checkup 与 tailor 各持一具**独立实例**（tracker# 空间互不污染）：`checkup-live.mjs` 变薄封装、契约一字未改（原回归锁仍 17/17 绿）。同 tracker# 在跑 → 409（带 runId 供轮询或 `/api/run/cancel`）；`replace:true` → 先 `awaitTailorGone` 等旧进程真不在再派新的；任一等待 timeout → 放行但如实标 `unconfirmed`。
5. **传输与可观测**：走 ADR-0020 事件总线——`registerRun` → `phase:queued/running/tailoring/finalizing:render` 阶段事件 → 唯一终态 `done|error`；`registerTailor` 在进入并发池之前、runId 回到调用方之前完成（跨标签页/跨浏览器权威）。终态落运行账本（`appendRunRecord kind:"cv-tailor"`），无 UI 也能事后回看。取消经 `setCancelHandler`：排队中出队、运行中杀当前子进程。
6. **worker 阶段失败以终态 ERROR 上报，绝不静默**：LLM 调用失败 / 渲染失败 / tailor 退 0 却没报保存路径，各自映射到 `{ok:false, stage, error}` 并发 error 事件。
7. **凭据 = 密钥库使用中密钥束，经 env 注入**（修订 2026-10-27，首跑实弹报障）：初版假设 `.env` 里的 `OPENAI_*` 变量，但本机密钥唯一事实源是 ADR-0083 密钥库（配置页可维护、`.env` 没有也不该有明文）。现在派发时读 `readVault`/`activeKey`，把使用中那把的 key/baseUrl/model 写进 `openai-tailor.mjs` 子进程 env（不进 argv/事件流/台账；dotenv 不覆盖既有 env，注入即生效）；库里无可用密钥时前哨当场 400 `no-tailor-credential`，不派必死的 worker。

## 范围（不动）

- **不动 checkup 语义**：工厂抽取后 checkup-live 对外 API 与测试完全不变。
- **不动 `openai-tailor.mjs` / `build-cv-html.mjs` / `generate-pdf.mjs` / `application-artifacts.mjs`**：只编排、不改写。
- **不加任何 UI**：本 feature 明确无前端按钮/卡片，纯 HTTP 能力。

## 后果

- 「生成定制简历」成为 agent/脚本可直接 `POST` 的能力：`POST /api/cv-tailor {n}` 秒回 runId，再订阅 `/api/events` 或直接轮询 `GET /api/cv-pdf?report=N` 取产物。
- 依赖 ADR-0083 密钥库里有一把使用中的 OpenAI 兼容密钥束（配置页「AI 引擎」维护，切换即生效）；库里无密钥时端点当场 400，缺 baseUrl 指向非 https 远端时 `openai-tailor.mjs` 自己的守卫拒跑（tailor 阶段 ERROR）。
- 请求/响应契约详见 [docs/cv-tailor-api.md](../cv-tailor-api.md)。

## 关键文件

`web/src/app/api/cv-tailor/route.ts`、`web/src/lib/tailor-target.mjs`、`web/src/lib/tailor-worker.mjs`、`web/src/lib/tailor-live.mjs`、`web/src/lib/tailor-request.mjs`、`web/src/lib/live-registry.mjs`、`web/src/lib/checkup-live.mjs`（薄封装）、`web/src/lib/career-ops.ts`（`findTailorTarget`）。测试：`web/tests/lib/tailor-*.test.mjs`。

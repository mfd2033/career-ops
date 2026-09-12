# ADR-0018: 工作器的报告跳转——报告号是导航关系，与评估用时口径解耦

- **Status:** Accepted (2026-09-12)
- **Context:** 工作器历史（`/jobs`）、侧栏的工作器卡片、以及点进去的工作器详情页（`/jobs/{id}`）需要能跳到该工作器对应的报告页。现状：报告入口（`ReportNumLink`，一枚 `#N`）与「评估用时」共用同一个解析函数 `useJobTiming`（`web/src/lib/eval-duration-client.ts`），它把报告号压在两条来源上——`input` 是 http(s) URL 且命中 `/api/report-status`（归一 URL → tracker 行号），或 `subtitle` 形如 `#N`。而 pdf（定制简历 PDF）工作器的启动参数是 `input: n`（裸报告号）+ `subtitle: "针对该职位定制"`（`generate-pdf-button.tsx:22`、`registry.ts:258`），两条都不满足 → pdf 工作器在列表行、侧栏卡片、详情页三处都拿不到报告跳转。

  为什么只有 pdf 是缺口：web 单条 evaluate 的 agent 在运行中段才经 `reserve-report-num.mjs` 拿到报告号（ADR-0017 §1），worker 侧根本不知道号，只能靠 URL join tracker 行（行里没有 URL 时本就没有可跳的报告）；应用内 `batch-evaluate` 一条汇总工作器对应多份报告；`research`/`fix-portal` 不产报告。pdf 是唯一"启动时就知道号"却解析不出来的种类。

## Decision

1. **工作器显式携带报告号**（Q2）。`Job` 与两个启动参数类型（`job-store.tsx` 的 `StartOpts`、`registry.ts` 的 `StartJobInput`）加 `reportNum?`，两个 pdf 启动点写入。解析不再依赖"按 kind 猜 `input` 的语义"——`input` 已是每 kind 各自解释的重载字段（evaluate 是 URL、fix-portal 是公司名、research 是 target、批量是多行 URL），拿它当报告号是把语义压在约定上。
2. **旧记录派生兜底**（Q2）。localStorage 里已存的工作器（上限 40 条，`job-store.tsx:188`）没有该字段，读取时按 `kind === "pdf" && /^\d+$/.test(input)` 派生，否则那批历史记录永远点不动。
3. **报告号是导航关系，不等于评估用时的归属**（Q3/Q8）。`useJobTiming` 一旦为 pdf 解析出报告号，就会顺带把那份报告的评估用时贴到 CV 生成工作器的卡片上——把"评估出这份报告花了多久"标成"生成简历花了多久"。因此解析出报告号**不等于**显示用时：评估用时只在评估类工作器（evaluate / batch-evaluate）上生效，pdf 继续显示自身墙钟（`doneDurationSeconds` 的兜底分支）。评估用时的口径本身不变，仍是 ADR-0016 的白名单。
4. **跳捕获时的号，不跟随 tracker 当前链接**（Q5）。pdf 工作器跳它启动时捕获的 n；`reports/{NNN}-*.md` 不可变，旧号永远有效。这与 ADR-0017 §4 的 pipeline 表格 join 规则（跟随行的当前报告链接）方向相反，但不冲突：那里问的是"这一行的当前报告是哪份"，这里问的是"这份简历是照着哪份报告定制的"。
5. **不扩到其它种类**（Q6）。`research`/`fix-portal` 不产报告，应用内 `batch-evaluate` 对应多份报告，都不补跳转；`evaluate` 已能靠 URL join 解析。解析改在共用层（`useJobTiming`）后，侧栏卡片、`/jobs` 列表行、`/jobs/{id}` 三处一并生效，不逐个改 UI。
6. **入口形态与文案**（Q12/默认 A/B）。详情页的报告入口照抄列表行的既有模式——标题右侧一枚 `#N`（悬停「查看报告」），保留 `subtitleIsNum`（池卡片的 `#N` 副标题）分支以免出现两个入口；顺带把 `jobs.pipeline` 的中文从「流水线」对齐成「求职管道」（与 `nav.pipeline` 一致），它只被 `/jobs/[id]` 两处使用——而"指向 `/pipeline` 却自称流水线"正是这次设计反复误判靶子的根源。

## Alternatives considered

- **把数字 `input` 直接当报告号**（Q2 否决）：3 行就能修，但把报告号解析押在"按 kind 白名单"的约定上，未来任何新 kind 复用数字 input 都会静默错跳。
- **从 `page` 抠 `/pipeline/(\d+)`**（Q2 否决）：`page` 是来源路由而非报告号；`reevaluate-button.tsx:39` 里它是复评**前**的旧号，ADR-0017 §4 已说明复评后行的报告链接会换新——会过期。
- **让 pdf 卡片一并显示报告的评估用时**（Q3 否决）：指标串味，且事后无从看出这个数字属于哪件事。
- **用 pdf 步埋点（ADR-0017 §3 后端已写 `pdf start/end`）给 pdf 做独立指标**（Q8 否决）：那是一个新指标，按 ADR-0016 §Consequences 应并列展示，而不是改本口径混进这次改动。
- **跟随 tracker 当前报告链接**（Q5 否决）：会让跳转指向一份简历未曾参考的报告。
- **只改详情页、不动侧栏与列表**（Q7 否决）：三处共用同一套解析与同一个 `ReportNumLink`，只改一处等于人为制造不一致。

## Consequences

- pdf 工作器在 `/jobs` 行、侧栏工作器卡片、`/jobs/{id}` 三处获得 `#N` 报告跳转（跳 `/report/{n}`）；`research`/`fix-portal`/应用内批量维持现状。
- `报告号 → 用时` 的耦合被切断：`useJobTiming` 里"解析报告号"与"取评估用时"必须能分开提问。后来者若把两者重新绑在一起，pdf 卡片会静默显示评估耗时——这正是本 ADR 要拦的那一步。
- 纯解析落在 `web/src/lib/report-num.mjs`（房规：plain `.mjs` 才能被 `node --test` 锁住，同 `eval-timings.mjs`/`eval-timing-key.mjs`），配 `web/tests/lib/report-num.test.mjs`。
- `Job.reportNum` 是"启动时已知"的值，与 `/api/report-status` 那套 URL 归一 join 是两个独立来源，互不覆盖：前者答"这个工作器引用了哪份报告"，后者答"这个职位被评估成了哪份报告"。
- `CONTEXT.md` 补「工作器」词条，并在「报告号」「评估用时」词条里记下这条边界。

# ADR-0041: 已评估页批量体检（batch-checkup）

- **Status:** Accepted (2026-09-18)
- **Context:** 公司体检（checkup）目前只有单个体检通路：报告页「体检这家/复检」按钮（`CheckupRequestButton`，按钮按下即 ADR-0025 决议 2 的人类在环确认）→ `POST /api/checkup-request` 唯一闸门（在跑冲突 409、`replace` 语义 ADR-0033）→ `startJob({kind:"checkup"})` → `/api/run` 无头 worker → 产物门禁（ADR-0030：台账行数增量 + HTML 文件存在）→ `lib/log-checkup.mjs` 守护写入 `data/company-checkups.tsv`（append-only，星级 0.5 步进、risks 8 因子闭集、tracker# 允许 `?` 空键）。已评估 tab 已有星级徽章（`web/src/lib/company-checkups.mjs` 的 `checkupIndex` join，ADR-0025/0031），但候选公司多时只能逐个点按钮。用户（2026-09-18）要求在「已评估」页增加批量体检。约束与既有事实：
  1. 已评估 tab 的勾选基建现成：`pipeline-view.tsx` 的 `selected` 集合（按报告号 `r.n` 键控）、批量操作条（「重新评估」「批量跳过」两按钮）、屏外勾选计数（`countSelectedOffView`）。批量体检只需在批量条加第三个按钮。
  2. 批量评估（`web/src/app/api/batch-evaluate/route.ts`）已验证了一套批量编排形态：有界 worker 池 `MAX_PARALLEL=3` + 全局 `concurrencyPool` 槽位、`MAX_URLS=20`、NDJSON 流式事件（`status/item/done/error/keepalive`）、`ok=0 && failed>0 → error` 的诚实门禁、取消路径、`co-job-done` 事件刷新 + ADR-0031 僵尸卡片对账。
  3. worker 引擎走配置页 `cliId`（`~/.career-ops-web/config.json`，`clis.ts` 支持 8 个 CLI）；工具授权只有 claude 一条轴（`permissionFlags`），其他引擎无头运行无授权机制（known gap，挂 #2507）。
  4. 单个体检 worker 每家 30 分钟 `killMs`；体检抓取经 `browser-extract.mjs`（中文站路由 bsk 到用户已登录浏览器），外部站点反爬/验证码敏感，部分失败概率高于评估。
  5. 台账 append-only 天然支持复检（多行，徽章取最新、显示复检次数）；`checkup-live.mjs` 是在跑体检的存活登记。

- **Scope:** 新增 `web/src/app/api/batch-checkup/route.ts`（批量编排，镜像 batch-evaluate 形态）；`web/src/components/pipeline-view.tsx`（批量条加「批量体检」按钮 + 「建议体检」角标）；`web/src/lib/i18n/clusters/pipeline.ts`（文案）；`web/src/lib/run-prompts.mjs` 或其 checkup prompt 生成段按需抽出可复用函数（不改变单个体检 prompt 语义）；回归测试 `web/tests/lib/batch-checkup-*.test.mjs`（门禁/冲突判定纯函数）。不改动：`lib/log-checkup.mjs` 写入约束、ADR-0030 产物门禁逻辑、ADR-0031 对账机制、单个体检通路（`/api/checkup-request`、`/api/run`）。

## Decision

1. **候选 = 用户多选**：不做 ADR-0025 口径的自动预选。用户在已评估 tab 勾选公司，点批量条新按钮「批量体检」启动；一次最多 20 家（沿用批量评估 `MAX_URLS`）。请求体携带勾选的 `r.n` 列表 + `cliId/model`，服务端解析公司名与 tracker#；无法解析目标（行不存在、或 `?` 行无 Via）的行作为**失败项**在结果清单中标注原因，不 spawn worker——批量项永远来自 tracker 行号（数字键），台账的 `?` 空键只属 CLI 技能路径。
2. **「建议体检」轻量角标**：已评估行若满足 ADR-0025 口径（score≥4.0 或 Block G ⚠）且 `checkupIndex` 无该 tracker# 记录，显示小角标提示。只提示不强制——勾选完全由用户决定。**详情页延伸（2026-09-18 补充决议）**：`/pipeline/{n}` 与 `/report/{n}` 两个报告详情页的页头徽章行渲染同款角标——服务端用同一口径函数（`suggestsCheckup`）判定后传 `suggestedCheckup` prop，纯静态提示零联动；路由 parity 守卫（report-route-parity.test.mjs）把该 prop 纳入必传契约。
3. **worker 引擎跟随配置**：与单个体检 `/api/run` 行为一致，`resolveCli(cliId)` 分发。claude worker 附加 `permissionFlags` 的 checkup 工具域（checkup 已在 `PERSISTING_KINDS` 中、复用 persisting 域，无需新档；「只借 permission tail」拼法与批量评估一致）；非 claude 引擎维持现状（无授权机制运行，风险已知，不在本 ADR 解决）。
4. **并发复用批量评估配置**：`MAX_PARALLEL=3` + 全局 `concurrencyPool` 槽位。不为体检单设参数——两个批量功能共享一套并发语义。
5. **冲突处理——跳过在跑 + 允许复检**：启动时逐项查 `checkup-live.mjs`，该公司已有在跑体检的项**跳过**并在结果流中标注（`skipped-running`），不自动 replace（批量场景替用户做 ADR-0033 的停止/替换决定太激进）；已有台账记录的项允许勾选 = 复检，跑完 append-only 追加一行，徽章取最新。启动后（检查与 spawn 间隙）新出现的冲突由产物门禁兜底：worker 产物验收失败即记 `failed`。
6. **逐项产物门禁 + 诚实汇总**：spawn 前记录该 tracker# 的台账基线行数；worker 结束后按 ADR-0030 验产物（台账行数增量 + `reports/checkups/` 下 HTML 真实存在）→ `ok` / `failed`（携带 reason，弥补批量评估「逐项 reason 不落盘」的观测性缺口）。全部结束后：`ok=0 && failed>0` → 发 `error`（沿用批量评估诚实门禁，全失败不得伪装 done）；否则发 `done`，附逐项清单（ok/failed/skipped-running 各自列出）。**不自动重试**——失败项进清单，用户稍后可对失败项再跑批量体检（复检语义天然覆盖）。
7. **进度 = 复用流式卡片**：NDJSON 事件流（`status/item/done/error/keepalive`），前端复用 job-store 的流式卡片与 `co-job-done` 刷新；ADR-0031 僵尸卡片对账（`job-ledger-reconcile.mjs`）无需改动即覆盖本功能卡片。
8. **取消与超时**：复用 job-store 取消；取消时已完成项的台账行保留（append-only 不回滚），未完成项标 interrupted。**不设批量总超时**——单 worker 各自 30 分钟 `killMs` 已是硬上限，总时长由用户取消控制。
9. **worker prompt 复用单体检 prompt**：每家公司独立 worker，prompt 由单个体检同一生成逻辑产生（含 ADR-0035 的已解析公司名注入），批量层只做编排与产物验收，不引入第二套体检方法论。

## Alternatives considered

- **按 ADR-0025 口径自动预选候选集**：用户实测后选择纯手动多选——口径只是提示（角标），选择权保留给人。
- **纯脚本抓取 / 固定规则打分**：省 token 但口碑/仲裁/工商分析能力大幅弱化，且体检结论（星级、风险因子）依赖 LLM 判断；否。
- **批量沿用 ADR-0033 replace 语义（自动取消在跑）**：批量场景下连环 replace 可能把用户明知在跑的体检静默杀掉；改为跳过+标注，冲突决定权留在人。
- **设批量总超时（如 4 小时）**：会误杀长尾任务（3 并发 × 20 家最坏 3+ 小时）；单 worker 30 分钟硬超时 + 手动取消已够。
- **失败自动重试一次**：反爬/验证码类失败立即重试大概率仍失败，还会放大对外部站点的压力；不重试，清单化交人。

## Consequences

- **非 claude 引擎（opencode）的无头 worker 会因权限 ask 静默死亡（2026-09-18 实测）**：`external_directory` 与 `doom_loop` 默认 `ask`、`.env` 读取在本机表现为 `ask`——无头运行无人应答，进程以 exit 0 零输出静默终止（诚实门禁只能报「ran but never added a ledger row」，根因不可见）。修复在仓库根 `opencode.json`（本地未跟踪用户层文件）：`external_directory/doom_loop: allow` + `read: { .env: deny }`（deny 是干净拒绝，agent 继续跑；不放行 .env 防密钥泄漏）。任何新的 ask 类权限键出现都需同样处理；验证回路：`node local/batch-checkup-repro.mjs <tracker#...>`（本地未跟踪）。oh-my-openagent 插件曾以自身配置掩盖 external_directory 的 ask，卸载后暴露——headless 引擎环境的权限配置是本功能的前置条件。
- **argv 手拼漂移事故（2026-09-25 实测，codebuddy 批量 3/3 全败）**：本路由在 ADR-0054（worker argv 唯一选择器 `resolveWorkerInvocation`）落地时漏迁——非 claude 引擎只发裸 `-p <prompt> --model`，codebuddy 无头 worker 的每个工具调用被 CLI 权限层拒绝（模型自述 "permission prompts aren't available in this non-interactive mode"）：写不了 HTML、跑不了 `log-checkup.mjs add`、追不了 appendix，exit 0、零 stderr，诚实门禁只能报「ran but never added a ledger row」。同一引擎的单体检经 `/api/run`→`streamArgsFor` 全程成功，差异即根因；A/B 实证回路 `node local/probe-codebuddy-argv.mjs`（本地未跟踪）。修复：路由改走 `resolveWorkerInvocation(spec, {kind:"checkup"})`，`batch-stream-events.test.mjs` 的路由源码守卫扩至 batch-checkup（禁手拼、kind 必须透传）。教训同 2026-09-15：同一策略写两份，其中一份必漂——凡新增批量编排路由，守卫测试须与路由同 PR 落地。
- 已评估页具备批量体检能力：勾选 → 一键 → 流式卡片逐项看成败 → 台账/HTML 产物自动落盘 → 星级徽章直接更新。
- 「建议体检」角标让 ADR-0025 口径在列表上可视化，批量勾选有据可依；不改变任何 gate/score 语义（零分影响原则不变：体检永不改 oferta score/tracker 状态）。
- 非 claude 引擎跑批量体检 = 无授权限制 agent 的既有风险在批量下被放大（N 个 worker）；已在本 ADR 显式记录并挂 #2507，不在本范围内解决。
- 逐项 `reason` 落入事件流（进 run 台账），体检侧不再复刻批量评估「全失败零原因」的观测性缺口。
- 并发 worker 共享用户浏览器 bsk 会话：批量评估已验证该并发档位可行，但口碑类站点更敏感——若实测出现封禁，第一收缩点是把 `MAX_PARALLEL` 下调（本 ADR 不预设动态退避）。

## References

- ADR-0025（体检编排与建议口径）、ADR-0026/0027（体检按钮通路）、ADR-0030（产物门禁）、ADR-0031（僵尸卡片对账）、ADR-0033（在跑冲突 replace 语义）、ADR-0035（prompt 注入已解析公司名）。
- `web/src/app/api/batch-evaluate/route.ts`（批量编排形态蓝本）、`web/src/app/api/run/route.ts`（单体检 worker 启动）、`web/src/app/api/checkup-request/route.ts`（单体检冲突闸门）。
- `web/src/lib/claude-invocation.mjs`（`permissionFlags`）、`web/src/lib/clis.ts`（`resolveCli`/8 CLI）、`web/src/lib/checkup-live.mjs`（在跑登记）、`web/src/lib/company-checkups.mjs`（`checkupIndex`）、`lib/log-checkup.mjs`（台账守护写入）、`web/src/lib/run-prompts.mjs`（体检 prompt）。
- 术语表：`docs/glossary-batch-checkup.md`。

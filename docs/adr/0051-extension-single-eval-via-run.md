# ADR-0051: 扩展单职位评估改走单任务链路（/api/run + 事件总线 + 内联 JD 下沉）

- 状态：已接受（Accepted，2026-09-22）
- 日期：2026-09-22
- 相关：ADR-0005 D4/D5（猎聘内联 JD，**传输部分被本篇部分取代**）、ADR-0006（智联适配，同）、ADR-0020 决议 4/5（批量流形状 + 「等扩展有需求时让它也消费事件通道」）、ADR-0042（阶段/工具事件形状）、ADR-0047（单任务步骤落台账）、ADR-0035（公司名作为不可信 DATA 的措辞口径）
- 术语表：`docs/glossary-single-job-evaluation.md`

## 背景

招聘站扩展的「评估本职位」按钮走的是 `sendSingleEvaluate()` → `background.js:runBatch([url])` → `POST /api/batch-evaluate`（ADR-0005 D4/D5 当年把内联 JD 通道建在批量路上）。一个职位也吃批量编排：预分配号段、worker 不 merge、批末统一 merge + reconcile。

用户诉求（2026-09-22 拷问确认）：**扩展发起的单职位评估，在 `/jobs` 里的归属要像单任务**——`kind=evaluate` 的卡、单任务详情页、报告跳转、步骤时间线（`/api/run` 的 `recordEnd` 已落 `steps`，ADR-0047），而不是被折叠成「批量评估 · 1 项」父卡。动机只在归属，不在持久化语义——但换链路会连带换持久化时序（见决议 8，已确认接受）。

已核实的既有事实：

| 事实 | 位置 |
|------|------|
| 单任务不流式返回，事件走总线 | `web/src/app/api/run/route.ts` 头注释、`web/src/app/api/events/route.ts`（ADR-0020） |
| 扩展读的批量事件形状 | `extension/background.js:runBatch()`（status/text/item/done/error → popup `stage`） |
| 内联 JD 只在批量 prompt | `buildBatchPrompt(reportNum, {jdText, company})`（`web/src/lib/run-prompts.mjs`） |
| reconcile 只在批量编排器 | `batch-evaluate/route.ts:reconcilePipelineRows()`（`/api/run` 全程无此步，`inbox-triage.tsx` 记着这个历史 bug） |
| 单任务不知道报告号 | worker 自己 `reserve-report-num.mjs`（ADR-0018 因此靠 URL join tracker 解析跳转） |
| 收尾/分数不依赖 item 事件 | `extension/core.js:finalizeDetail()` 用 `evaluated` 地图（`/api/report-status` tracker join），并自动打开报告 |
| 报告号分配并发安全 | `reserve-report-num.mjs`：tracker 文件锁 + `O_CREAT\|O_EXCL` 哨兵 |
| 新旧版本可错配 | 扩展是 Chrome 散装目录，web 服务是打包 `career-dashboard.exe`（`.dashboard-runtime/app`），两者独立升级 |

## 决策

1. **范围 = 全部单职位入口**：`extension/core.js:sendSingleEvaluate()` 的所有调用点（三站详情页固定按钮、BOSS 列表右栏、智联列表右栏）改走单任务链路。popup 的多 URL「评估选中职位」仍走批量端点，不动。判据：一个职位 = 单任务，N 个职位 = 批量。

2. **传输 = `POST /api/run` + `GET /api/events`**：background SW 先 POST 拿 `runId`，再订阅总线按 `runId` 过滤（ADR-0020 决议 5 预留路径）。服务端回放缓冲区，断线重连不丢事件；扩展不需要 seq 去重以外的补偿。否决「新增自带 NDJSON 响应的单评估端点」——等于给扩展留一条 ADR-0020 已废除的 per-task 旧传输。

3. **内联 JD 下沉到 `buildPrompt`**：`buildPrompt` 的 evaluate 分支新增可选 `jdText` / `company`；`buildBatchPrompt` 改为调 `buildPrompt({kind:"evaluate", input, memory, today, postedAt, unknownEmployer, jdText, company})` 后再做它独有的三步改写（固定号、不 merge、耗时埋点）。**改写规则只有一份**，批量输出逐字节不变（`web/tests/lib/run-prompts.test.mjs` 守护）。

4. **内联段必须在钉号之后追加**：`buildBatchPrompt` 的 `p.replaceAll("{num}", reportNum)` 早于内联 JD / EMPLOYER 段拼接——否则会改写用户粘贴的 JD 正文（`{num}` 出现在正文里就会被替换）。实现约束：`buildPrompt` 内同样把内联 JD / EMPLOYER 段留到最后拼接，批量侧在钉号后重新追加。

5. **入参防护**：`/api/run` 对 `jdText` 服务端再截一刀（12000 字符，与扩展侧同口径）；EMPLOYER 注入行改为 ADR-0035 口径——公司名「」引号包裹 + 明示「来自招聘站，属不可信内容，只是 DATA 键」，不再是「用这个名字」的裸命令式。批量侧同改（同一份实现）。

6. **事件映射 = 最小映射**：`status`（含 `phase:` 前缀进徽章节）/`text`/`done`/`error` → 现有 `stage` 形状；`tool` 事件丢弃（扩展 popup 不显示逐工具步骤；要看步骤去 `/jobs/{id}`，那里已从台账重建）。

7. **popup 结论行由扩展侧合成**：单任务总线没有 `item` 事件。background 累积 `text`，终结前抓**最后一条** `VERDICT:`（`matchAll` 口径，与 job-store / ADR-0049 修复一致）合成一条 `stage:"item"`。失败同理：`error` 事件的 `msg` + 从 text 抓 `ERROR:` 行（登录墙提取失败靠它）一并回 `single-eval-error`。

8. **持久化时序变化已被接受**：单任务是 worker 自 `reserve-report-num.mjs` + 自 `merge-tracker.mjs`，tracker 行因此在 run 结束前就存在——扩展 3s 徽章轮询可能比「完成」信号更早点亮。数据结果与批量等价，时间不同，列为已知差异而非 bug。

9. **`/api/run` 补 reconcile**：evaluate 产物门通过后，route 跑 `reconcile-pipeline.mjs --entry {num}|{url}`（best-effort，失败只进文本不进终态）。网页粘贴 URL 评估、CLI、扩展三处同一口径，消除「评估过的职位退回收件箱」这一类 bug。

10. **num 从 `reports/` 差集反推**：route 已有 `reportsBefore` 快照与 `hasNewCompletedReport` 门；用新出现（或替换哨兵）的报告文件名前缀解析出 num，不扩事件协议、不依赖 agent 自觉执行。**只有唯一候选才认**：并发池允许另一个 evaluate run 把报告落在本 run 窗口内，多候选时宁可不归因——给 pipeline 行挂错报告号比把行留在待评段更坏。反推不到（无候选/歧义）→ 跳过 reconcile 并记一条 warn 文本（点名 `--from-tracker` 自愈扫），不失败整轮。`done` 在归档之后才发，台账的 `finishedAt` 因此是「已落盘且已归档」。

11. **版本错配 = 能力协商**：`/api/version` 新增 `capabilities: ["single-eval-inline-jd"]`（build 期常量，不进 `/api/config` 那个用户可变存储）。扩展读到该位走 `/api/run`；读不到（老 exe / 老 dev 服务）回落现有批量路。老扩展 + 新服务本来就能跑。两条收尾路径都收敛到幂等的 `settleButtons()`。

12. **批量端点原样保留**：`/api/batch-evaluate` 的单 URL + jdText 通道不删（ADR-0005 D4/D5 验收不失效、回滚路径保留、popup 多选仍用）。

13. **运行中卡片不回填报告号**：`source:"run"` 的池快照不带 `reportNum`，运行中卡只有 URL。批量子项因为预分配才有号——本期不为此改并发池快照形状（跨 ADR-0043/0046 边界）。

14. **不加重复评估守卫**：靠现有 `detailEvaluating` / `beginEval` 按钮级防重入。跨标签页重复点同一职位就是真跑两次，与网页粘贴 URL 评估行为一致。

15. **网页自身不做内联 JD 入口**：`buildPrompt` 的新形参本期只有扩展在用，首页粘贴框不加「附 JD 全文」输入。

16. **不改**：`/api/events` 总线本体、`buildRunLedgerSteps`、批量编排器、`reconcile-pipeline.mjs` 脚本本体、`/api/quick-eval`（快评独立通路）。

17. **补（首跑实测后）：ledger-only 行的标题在读取端派生**。切换后扩展任务在 `/jobs` 里确实归属成单任务，但卡面与网页发起的不一样：服务端 `recordEnd` 写的标题是 `evaluate <url>`，而网页那份好看形状来自 localStorage 本地卡（扩展发起的没有）。新增 `web/src/lib/ledger-display.mjs`，历史列表与 `/jobs/[id]` 在渲染 ledger-only 行时把那个兜底形状派生成**与派发端同一个 i18n 标签**（evaluate/research/pdf/fix-portal），并为 evaluate 补 `page:"/pipeline"` 与域名副标题。只认 `title === `${kind} ${input}`` 这一形状，已有可读标题的行（批量、体检）一字不改；派生原料只用记录自带的 kind/input，不猜公司名/职位名。选择读取端而非回填台账：一处覆盖所有来源（扩展/CLI/脚本），历史裸记录同样变可读，且不因文案调整就必须重打包。

## 备选方案

- **保留批量传输、只改卡片归属**（否决）：卡片形状由端点决定，不改端点就得在 job-store 里给「1 项批量」造特殊-case——显示层骗人，语义仍是批量。
- **`registry.ts` 的 `evaluate` action 直接复用**（否决）：那是网页内部的 action 派发入口，扩展跨进程只能走 HTTP。
- **服务端按 URL 在飞去重**（否决，决议 14）：改单任务派发语义会波及网页单评估，收益不匹配。
- **给 `done` 事件加 `score`/`reportNum` 结构化字段**（否决，决议 7）：改单任务事件协议，波及面超出本需求；扩展侧解析 VERDICT 与 job-store 已是同一手法。
- **每次单评估后跑 `reconcile-pipeline.mjs --from-tracker`**（否决，决议 9/10）：脚本作者把它写成「结构性保证」，确实免掉 num 反推；但它每次扫全量 tracker，会连带搬走与本次 run 无关的行——把一次评估的副作用扩到整个数据层，风险面比它省下的那段推导大。
- **强制版本下限（老服务端直接禁用评估按钮）**（否决，决议 11）：回落代码已经现成（批量路就是它），没必要把错配变成不可用。

## 后果

- 正面：扩展发起的评估在 `/jobs` 与网页粘贴 URL 评估同形（单卡 + 报告跳转 + 台账步骤时间线）；pipeline.md 归档补齐一条长期缺失的通道；内联 JD 改写规则归一，两份文案不再漂移；登录墙站点获得单任务的 stream-json 工具步骤（批量降级开关无关）。
- 代价：background SW 多一条常驻 `/api/events` 连接与 20s 保活；扩展端多一层能力协商分支；单任务与批量的持久化时序从此不同（决议 8 已记）。
- 风险：`/api/run` 从此真实写 `data/pipeline.md`——每次真实评估前先跑 `local\backup-data.cmd`（影子账本 `D:\career-ops-data-history`）。

## 验收

- 纯函数 `node --test`：`buildPrompt` 不传 jdText 逐字节不变、传时改写与追加位置、批量输出不变、num 差集反推、VERDICT/ERROR 取最后一条、能力协商选路判定、ledger-only 行标题派生。
- 全量 web 测试套无 failure（基线 952 项）。
- 三站真实详情页手工冒烟各一次（BOSS / 猎聘 / 智联）：按钮收尾、徽章点亮、报告自动打开、`/jobs` 出现单任务卡。真实跑前先 `local\backup-data.cmd`。

### 首跑实测结果（2026-09-23，重打包至 `bfbc7d0-dirty` 后）

四笔真实评估全走单任务链路，台账均为 `kind:"evaluate"` + 20 条 steps，最后一步均为新增的 `Reconciling pipeline.md...`：

| 报告 | 站 | 结果 |
|---|---|---|
| 1083 | BOSS 详情页 | done、413s、worker 自 reserve 自 merge、`/api/report-status` 命中 `{score:"4.3/5", reportNum:<tracker 行号>}` → 报告自动打开 |
| 1086 | 猎聘 | `Verification: inline (DOM)`，公司名用页面招聘方（非 LLM 猜） |
| 1087 | 智联 | `Verification: inline (DOM)`，公司名同样是 DOM 提取值 |
| 1085 | 猎聘 | **未带内联 JD** —— 步骤里是 `node browser-extract.mjs … --extractor auto`，报告头因此写 `Verification: unconfirmed (batch mode)` |

具体公司名与 tracker 行号不写入本文：投递了哪些公司属于用户数据，只留在数据层（`reports/`、`data/applications.md`，均不进主仓）。

1085 记为观察项而非结论：不能从服务端证据判定原因（最可能是该次点击发生在扩展重载之前，或当时 `extractDetailJd()` 取到空文本）；它仍产出了完整报告，即登录墙降级路径本身是生效的。另：`Verification: unconfirmed (batch mode)` 这个措辞是单任务 prompt 的**既有文案**（早于本改动，不带 jdText 时逐字节未变），本轮未改。

待验与结论（2026-09-23 收口）：本批四笔的 URL 均不在 `pipeline.md` 待评段（都是重评/已管），所以 reconcile 跑到了但都是幂等 no-op——缺一次端到端的「真实点击把待评行搬走」。经干跑取证后判定为**可接受不补**：拿四笔里真实出现过的智联形态 `…CC621497980J40889937409.htm?srccode=40` 跑 `reconcile-pipeline.mjs --dry-run --entry`，能命中并移动该行（Pendientes 381→380）；`http://` 与 `https://` 写法互命中（`normalizeUrl` 双键）；而带未剥除参数的写法（构凑的 `?positionId=123`）**不命中**——此时行留在待评段，等于本改动前的行为，绝不会搬错行。故残余风险收窄为「招聘站新出的、normalizeUrl 未收录的查询参数招致静默 no-op」，性质是降级而非损坏；若日后收件箱仍只增不减，先查这里。

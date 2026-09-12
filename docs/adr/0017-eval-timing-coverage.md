# ADR-0017: 评估耗时埋点覆盖全部评估路径——打点主体、残缺会话与重评口径

- **Status:** Accepted (2026-09-12)
- **Context:** 评估用时面板（ADR-0016）只对有埋点数据的报告显示，而 `data/eval-timings.tsv` 此前只有批量评估会写入打点（`batch-prompt.md` 的 instrumentation 指令）。评估实际有三条入口：web 单条、web 批量、CLI 交互式——后两者此前均无埋点，历史报告的绝大多数永远不会出现面板。目标：让以后每份报告都有数据。约束：web 单条评估的 agent 在运行中段才经 `reserve-report-num.mjs` 拿到报告号（抓取 JD 之后）；pdf 类工作器在 Claude 路径是只读的（#2172 剥夺 Bash 且不得恢复）。

## Decision

1. **evaluate 的打点走 agent 侧（prompt 级）**：打点指令写进 `modes/oferta.md`（三条路径经"follow oferta.md EXACTLY"共同继承），web evaluate prompt 显式重申为双保险；批量变体（`buildBatchPrompt`）用**精确字符串替换**换成预分配号变体（extract/eval 也可打点，单条变体只能打 report/tracker）。
2. **reserve 顺序不动**：不为打点把 reserve 前移到抓取之前。web 单条会话因此没有 `extract` 行，成为无起点的**残缺会话**（#703 先例，解析器照常求和）——数字含义为"从拿到号到报告交付"，小于批量口径但诚实。
3. **web pdf 步由后端打点**：pdf 类工作器无 Bash（#2172），agent 无法自计时；后端在 spawn 时打 `pdf start`、渲染确认成功后打 `pdf end`，仍经 `log-eval-timing.mjs` 写入以保持 TSV 单一写者。CLI pdf 路径维持 agent 侧（`modes/pdf.md` 指令，web 运行明确跳过）。
4. **面板 join 跟随行的当前报告链接**：重评会新取报告号而 tracker 旧行原地更新（行号不变、Report 链接换新），按行号 join 将永远错失重评用时。`/pipeline/{n}` 与 `/pipeline` 列表统一按"行的当前报告链接号（回退行号）"join。

## Alternatives considered

- **evaluate 由后端自测总时长**：后端只见 spawn→close，无分步明细，且单一笼统步骤名会污染 ADR-0016 的步骤白名单语义。
- **reserve 前移换取完整 extract 计时**：每个死链/验活失败的 JD 都会烧掉一个报告号，tracker 出现废行——报告号连续性优先于完整的 extract 数字。
- **给 pdf 恢复 Bash 以便 agent 自计时**：#2172 明令禁止，安全边界不因埋点重开。
- **面板按行号 join**：重评后的新号用时永远不可见，"最近一次评估"名不副实。

## Consequences

- 三条评估路径全部产生埋点；web 单条会话为残缺会话（report/tracker），web 批量与 CLI 批量为完整会话（extract/eval/report/tracker），CLI 交互式与 web 单条同口径。跨路径比较用时数值时须注意口径差异。
- 后端打点为 fire-and-forget：渲染失败会留下孤立的 `pdf start` 状态标记（`log-eval-timing.mjs` 容忍，`clear` 可清）。
- `CONTEXT.md` 的"残缺会话"词条与本 ADR 配套；解析器（`eval-timings.mjs`）零改动。

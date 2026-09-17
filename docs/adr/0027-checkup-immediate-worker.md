# ADR-0027: 体检按钮改为即时执行——worker kind=checkup

- **Status:** Accepted (2026-09-15)
- **Context:** ADR-0026 把「体检这家」设计为 agent-inbox 异步通路（按下 → 入队 → 下次会话 drain）。实际使用暴露了体验问题：按下后 /jobs 工作器列表无任何任务显示，用户不知道发生了什么；执行要等下次会话。用户裁决改为**按下即执行**。当时否决 worker 方案的理由（技能住 agent 侧，内联编排会形成第二份实现）有一个未检视的漏洞：现有 evaluate worker 本来就是**指针式 prompt**（引用 `modes/oferta.md`），checkup worker 同样可以只做指针——编排规则的单一来源（`_custom.md`）不因 worker 化而破坏。决议于 2026-09-15 grill 会话确认（4 项）。

## Decision

1. **通路 = worker kind=checkup。** 按钮触发新 worker：走全局并发池、使用引擎模式选定的 CLI runtime，/jobs 实时进度。ADR-0026 决议 1（agent-inbox 异步）就此废止。
2. **prompt = 指针式。** 只含 tracker#、公司名（含 `?` 行招聘主体场景说明）与「读 `modes/_custom.md`『公司体检』规则并按其执行」——7 维编排细节一概不内联。规则演化时 worker 行为自动跟上，ADR-0026 否决 worker 的漂移理由因此消除。
3. **agent-inbox 仍记账，但记的是审计轨迹。** 按钮触发时同步写一条**已标记**（`[x]`）的行，含触发时间与派发的 worker job id；drain 规则同步改为「已标记的体检请求跳过」。
4. **去重语义随之更新。** 同 tracker# 当天已派发（dispatched 行）或已在队列的请求 → 409；台账 append-only 不变。
5. **旧异步语义保留。** `_custom.md` 的 drain 直接执行规则不动：历史上已入队未执行的 pending 体检请求（如 #131）仍会在下一次会话被执行。两条路并存、各自闭环。
6. **继承 ADR-0026 其余决议**：按钮仅行详情页、`?` 行体检招聘主体、挂触发行、零分影响、复检 = append 新行、独立全预算（worker 调研期间不受评估 5 查询上限约束——该预算条款本就只约束 oferta 评估流程）。**（其中「按钮仅行详情页」已被 ADR-0032 取代；其余决议继续有效。）**

## Consequences

- **/jobs 出现新 kind=checkup**：input 为 tracker#（附公司名显示），进度/结果与 evaluate 同等可见性；工作器失败的排查路径与 evaluate 相同（stderr + job 详情页）。
- **worker 的调研能力取决于所选 CLI runtime 的工具面**（WebSearch/browser 等）：`_custom.md` 的「中文招聘站抓取顺序」规则（bsk/browser-extract 优先）在 worker 会话内同样适用，因为它读的是同一份规则文件。
- **审计三方可查**：agent-inbox dispatched 行（触发时刻 + job id）、/jobs 运行记录、台账结果行。
- **去重判定从「pending 入队」扩展为「pending 入队 ∪ 当天已派发」**，实现收敛在 `web/src/lib/checkup-request.mjs` 一处。
- ADR-0026 决议 1/7 被本 ADR 取代；决议 2/3/4/5/6/8 继续有效。

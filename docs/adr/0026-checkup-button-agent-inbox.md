# ADR-0026: 行详情页「体检这家」按钮经 agent-inbox 异步执行

- **Status:** Accepted (2026-09-14) — **部分被 ADR-0027 取代（2026-09-15）**：决议 1（agent-inbox 异步通路）与决议 7（仅 pending 去重）由 ADR-0027 的 worker kind=checkup 即时执行取代；决议 2/3/4/5/6/8 继续有效。
- **Context:** ADR-0025 落地后，体检的触发入口只有对话（用户对 agent 说「体检这家」）。需求：web 行详情页提供「体检这家」按钮。核心矛盾：体检能力（offer体检 技能 + bsk + 多轮搜索）住在本机 agent 侧，web 前端自己不会做调研；web 的 CLI worker 体系虽能即时执行，但其内建 prompt 运行时（claude/codex/opencode CLI）并没有装 offer体检 技能，内联体检编排会造成与 `_custom.md` 规则的第二份实现。决议于 2026-09-14 grill 会话逐条确认（7 项）。

## Decision

1. **通路 = agent-inbox 异步队列。** 按钮调新 web API，由 API 调 `node agent-inbox.mjs add "<体检请求>"` 写入 `data/agent-inbox.md`（复用其锁与并发安全，零系统层改动）；下次用户在仓库开 AI 会话时 drain 执行。不做 worker kind=checkup——即时体验不值得背上编排双实现的漂移成本。
2. **按钮位置 = 仅 `/pipeline/{n}` 行详情页。** 有 tracker# 与公司上下文，是「这家」最自然的指代处；`/report/{n}` 保持纯阅读。
3. **已有体检时 = 展示★ + 复检。** 详情页直接展示体检星级/主要风险/HTML 链接（数据来自 `pipelineSummary` 已有的 `checkups` 索引），按钮变「复检」；复检 append 新台账行，历史对比是台账天然能力。
4. **关联 = 挂触发行。** 体检记录只关联触发行 tracker#，同公司其他行不自动关联——与台账 join 语义一致，不在 web 侧实现 company-slug 归一（ADR-0025 明确回避的坑）。
5. **drain 后直接执行。** 按钮按下即用户确认（agent-inbox 协议本义就是 human-in-the-loop intent），drain 到请求后按 `_custom.md` 公司体检规则直接跑，不再二次询问。请求文本自带全部上下文（tracker#、公司名、规则引用），agent 无需追问。
6. **未知雇主行（company=`?`）体检对象 = 招聘主体**（报告 Via 字段公司名）——猎头代理正是尽调价值最高的对象；Via 缺失时按钮禁用并提示原因。
7. **防重 = API 侧当天 pending 去重。** 同 tracker# 当天已有未 drain 的体检请求 → API 拒绝并提示「已在队列」；跨天可复检。去重只作用于请求队列，台账 append-only 语义不变。
8. **按钮不限辖区。** 辖区判定只约束 agent 的「主动建议」（ADR-0025 决议 3）；按钮是用户显式点名，海外公司也可点（技能自行标注「未获取到」）。

## Consequences

- **体检编排规则仍然只有一份**（`_custom.md`）；按钮只是把「用户说体检这家」变成「用户按一下，队列替用户说」——语义等价，无第二实现。
- **执行是异步的**：按下后 UI 明示「已加入体检队列，下次会话执行」，不制造即时完成的错觉。
- **`?` 行 Via 缺失时按钮禁用**是第一处「按钮不可用」状态，实现需给出禁用原因文案。
- 请求去重按「同 tracker# + 当天 + 未 drain」三元组判定，实现放 API 侧（后端设防），前端不做自己的去重逻辑。
- agent drain 侧的行为补充（体检请求直接执行）写入 `_custom.md`，不改系统层 `modes/agent-inbox.md`。

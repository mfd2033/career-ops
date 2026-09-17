# ADR-0031: /jobs 僵尸卡片对账——账本终态胜出滞留 running 的卡片

- **Status:** Accepted (2026-09-16)
- **Context:** 2026-09-16 #27（蜜雪冰城）体检实测：worker 22:25:47 派发，88 秒后即被 ADR-0030 诚实门禁以 `error` 终止并入账本（`.career-ops-web/runs/index.jsonl`），但用户视角「跑了 30 多分钟还没结束」。根因有两层：① 终止事件走 `/api/events`（ADR-0020）单通道投递，标签页断连/休眠/错过 replay 后，内存中的 job 卡片永远停在 `running`（job-store 只在页面加载时对 localStorage 遗留的 running 卡片做 interrupted 标记，长开标签页无任何对账路径）；② `/jobs` 页合并策略是「知道 runId 的卡片胜出」（ADR-0027 follow-up 的原文语义），僵尸卡片据此屏蔽了账本里的 `error` 终态记录，刷新也救不回来。
- **Scope:** 只改展示层对账；worker 落盘参数拼错与代理「敏感内容」误拒（#27 的真实死因）是模型/代理层问题，不在此修——门禁已能诚实拦截。

## Decision

1. **对账规则（纯函数抽缝）：** 卡片同时满足「状态 running/queued，或带 `interruptedAt` 标记的猜测性 error（localStorage restore 把遗留 running 卡标记为 interrupted 时打的戳——无此标记，猜测性 error 与 SSE 真实投递的 error 无法区分，而后者是终态不可改）· 有 runId · 账本同 runId 存在终态记录，且该记录已落盘超过宽限窗（30 秒）」时，账本终态胜出：卡片改为 done/error，`endedAt` 取账本 `finishedAt`，失败文案取账本 `msg`，治愈时清除 `interruptedAt`。服务器账本只记 TERMINATED run——「卡片声称活跃 + 账本已终态」矛盾时卡片必然过时，此规则无误伤面。反之，账本无记录或记录尚新时卡片不动（run 可能仍在跑或 live 事件尚在投递竞态窗口内）。
2. **接线点在 `JobsProvider`（job-store），不在 `/jobs` 页。** 已有 3 秒 `/api/active-runs` 轮询证明 store 级轮询可行；对账放在 store 让所有消费面（/jobs、pipeline 徽章、浮层）一起受益。轮询 `/api/runs/history` 低频（15 秒）即可——僵尸对账不追求实时，只为自愈。`/jobs` 页的「card wins」合并策略保持不变，在对账存在后它是安全的。
3. **与 live 事件路径的竞态用宽限窗解决（2026-09-17 修正，#73 实测）：** v1 用「`accs` 中仍有 accumulator 即跳过」保护 live 路径，但假设不成立——SSE 通道恰在 run 收尾时断线，重连 replay 只覆盖 live run，已终结 run 的 done/error 事件永久丢失，而孤儿 accumulator 会永久挡住对账（#73 深圳国超：worker 10 分钟成功落盘三项交付、账本记 done，卡片却继续转圈）。改为 30 秒宽限窗：live 路径在收尾后约 1 秒内投递，从不与 30 秒竞态；超窗即视为事件已丢，账本胜出。刚 startJob、POST 尚未返回 runId 的卡片天然不满足条件，无需特判。
4. **回归测试锁纯函数**（ADR-0030 同款教训：内联在 tsx 里没有可断言的测试缝）：`reconcileJobsWithLedger()` 抽成 `web/src/lib/job-ledger-reconcile.mjs` 纯 .mjs，`web/tests/lib/job-ledger-reconcile.test.mjs` 覆盖：僵尸 running 卡片被账本 error 治愈（#27 场景）、done 同理、账本无记录不动、live accumulator 存在时不动、queued 卡片同理、无 runId 卡片永不参与对账、interrupted 猜测卡被账本升级且真实 error 永不被改、同 runId 多条记录取最新。

## Consequences

- 断连/休眠标签页里的僵尸卡片最迟 15 秒自愈；`clearFinished` 与 interrupted 标记对已治愈卡片恢复语义（error 可被清掉，不再永久占列表）。
- 页面刷新后的 localStorage restore（running → interrupted）在对账生效后变为临时中间态：若 run 实际已终态，卡片会被账本纠正为真实结果，比「interrupted」更诚实。
- 账本为 done 而卡片仍 running 的对账会让卡片显示完成——文案与 score 解析仍来自卡片自身累积（僵尸卡片通常无累积），score 为空可接受，事实正确性由账本保证。

# ADR-0034: 失败终态的可观测性——agent 输出尾部（stdout 侧）入运行账本

- **Status:** Accepted (2026-09-17)
- **Context:** #119（悠桦林）体检 worker 零产物失败（runId `4842f226`，14:38→14:53，15 分 12 秒）：账本（`.career-ops-web/runs/index.jsonl`）里只有 ADR-0030 门禁那一句话——「finished without adding a row to the checkup ledger」——而真因躺在 agent 的正文里：**26× `API Error: Content block not found`**（本地代理 `127.0.0.1:15721` 的流式翻译抖动）加一条拒绝语 thinking「抱歉，内容可能包含敏感信息，请修改后重新发送。」（`output_tokens: 0`）。用户在 UI 里看不到它们：`/jobs` 列表卡片文本取账本 `msg`、`/jobs/{id}` 的账本回退视图也只看 `msg`，agent 正文只存在于 live 卡片内存里，刷新即散。
  两个已查证的事实决定了修法：① **`stderrTail`（ADR-0027 决议 3）在本机账本里 0 条命中**——这类失败信号走 stdout 的 assistant text，不走 stderr，所以那个机制至今没派上用场；② `recordEnd` 把 `msg` 截到 **300 字**，而门禁那一句 checkup 文案本身就 175 字，即使有尾巴也几乎被吃掉。
  **Scope:** 只补「失败终态入账本的证据」。不改门禁判定（ADR-0030 的结论不变：代理层中止是环境问题，本仓库只保证它可见）、不碰 CLI/代理配置、不回溯改写历史记录。

## Decision

1. **新增 stdout 侧尾巴（`stdoutTail`），与既有 `stderrTail` 同形**：在 `sendAgentText` 里累积 agent 的可见正文（尾部保留 ~4000 字，供筛选），pdf 的 `<<cv-html>>` 信封已被 `cvEnvelopeFilter` 挡在这一层之外，不会进尾巴。
2. **只挑像错误的行，相邻重复折叠成 `×N`**：候选行由闭集正则声明（`API Error`、`敏感`、`refus`、`rate limit`、`overloaded`、`quota`、`Error:`、`timeout`、`ECONN`），相邻相同行折叠；超出上限时保留**靠后**的行（离失败最近）。闭集与折叠规则住在 `run-cli-support.mjs` 的纯函数 `failureEvidence()` 里，`node --test` 锁定。
3. **msg 上限 300 → 800 字**，由新的纯函数 `failureLedgerMsg()` 组装：`<一句话原因> ｜ stderr: … ｜ 输出尾部: …`（谁有算谁，各段可选）。上限提升是必须的：不提升，证据就等于没入账本。
4. **不新增账本字段**：`msg` 是唯一证据载体，三处消费面（`/jobs` 列表卡片文本、`/jobs/{id}` 详情段落、ADR-0031 对账后的卡片文本）自动受益；托盘一行是 `truncate`，长 msg 视觉上安全。
5. **内容纪律**：尾巴是本地观测数据（账本 gitignored），可能含抓取到的外部文本 → 一律按 Untrusted External Content 当数据存与显示，绝不作为指令执行；渲染面是纯文本（不经 markdown/HTML），无注入面。
6. **不改门禁文案**：门禁那一句仍然逐字保留在前，证据只是追加——诚实门禁的语义不因观测补丁漂移。

## Alternatives considered

- **整段尾巴原样入账本**：噪声（15 次搜索的空结果、工具回显）会淹没信号，且把 msg 变成不可读的长文本。
- **独立 `tail` 字段**：改动面 ~5 处（route、/jobs 详情、reconcile、类型、列表），漏一处就「看不到」；而 `msg` 本来就是三处消费面的共同载体。
- **只留 stderr**：本机实测 0 命中——信号不在那条通道上。
- **失败时把 transcript 路径写进账本**：用户仍要自己去挖 `~/.claude/projects/…jsonl`，且路径随会话漂移。

## Consequences

- 下一次「零产物 / 代理拒绝」的失败，`/jobs` 里能直接读到 `API Error: Content block not found ×26` 这类证据，不必再挖 transcript；`/jobs/{id}` 的账本视图同样带上它。
- 同类失败在 evaluate / pdf 上也一样受益（`send()` 是所有 kind 共用的一条路）。
- 账本行变大：每条 error 最多 +600 字（上限 800 内的证据段）。账本 append-only，历史行不变。
- 门禁判定与失败分类完全不变：本 ADR 只让既有失败更可读，不新增/减少任何一种失败。

# ADR-0094: 引擎/模型无关的「出错即停」

- **Status:** Accepted (2026-11-03)
- **Context:** 2026-11-03 现场事故：`active-pool-12`（OpenCode + `deepseek-v4.1-flash-free`，报告号 1239）在评估开始约 9 秒后额度耗尽，页面显示「处理中」整整 **61 分钟**，池槽被占满，排在后面的 `pool-13`/`pool-14` 一起饿死。取证结果是四层缺口叠在一起：

  1. **外部 CLI 不退出**：OpenCode 的 `AI_APICallError: Free usage limit reached …` 只写进它自己的日志文件（`~/.local/share/opencode/log/opencode.log`），既不走 stdout/stderr，也不以非零码退出；进程随后只剩每分钟一次的 `cleanup prune` 心跳（CPU 61 分钟仅 22 秒、无子进程）。
  2. **编排层只认 `close`**：`batch-evaluate` 的完成与池槽释放都在 `child.on("close")` → `finish()` → `release(poolId)` 这一条路上；进程不退出 = 任务永远 running、槽位永不归还。
  3. **错误只被标记，不驱动控制流**：stderr 命中只置 `sawError`，`error` 事件只做终结，没有任何一处会因此终止进程。
  4. **分类器漏词**：OpenCode 走 `isFatalOpenCodeStderr`，其额度正则是 `/quota|rate limit/i`，而它的措辞是 `Free usage limit reached … subscribe to keep going`——不匹配；同义措辞 `usage limit reached` 只写在 Claude 的专属正则里。且 OpenCode 无 `parseEvent`（plain-text 分支），错误连 `VERDICT:`/`ERROR:` 通道都进不去。

  约束：`/api/run`（单任务）已有 30 分钟 `killer`，但批量两条路由——`batch-evaluate` 一道都没有，`batch-checkup` 只有 30 分钟总阀、无静默检测；且总阀只能覆盖「慢」，覆盖不了「静默挂死」。

- **Scope:** `web/src/lib/run-cli-support.mjs`（跨引擎致命分类器 + `persistRunOutcome` 的死因入文案）、`web/src/app/api/run/route.ts`、`web/src/app/api/batch-evaluate/route.ts`、`web/src/app/api/batch-checkup/route.ts`、两份测试。**不动**：CLI 安装/认证流程、评分逻辑、批量数据结构、`/api/active-runs` 快照格式、重试语义（ADR-0061/0093）。

## Decision

1. **新增与引擎、模型都无关的致命分类器** `classifyFatalStderr(line)`（`run-cli-support.mjs`），四类：`auth`（未登录/凭据无效/API key 无效）、`model`（模型不存在或不可用）、`usage`（额度/计费/限流：`quota`、`rate limit`、`usage limit`、`free usage`、`credit balance`、`insufficient credits`、`402`、`429`、`subscribe to keep going`）、`transport`（`AI_APICallError`、`ECONN*`、`fetch failed`、`socket hang up` 等）。`fatalStopMessage(hit)` 把结论与引擎原文压成单行，供卡片与台账使用。
2. **命中即终止，不等进程自己退**：三条路由在 stderr 行（以及结构化引擎的 `ev.error` 事件）上先跑这个分类器，命中就 `terminateCli(child)`（按进程树 kill），并**立即结案**——写原因、释放池槽、把失败写进子项。批量的 `finish` 加 `settled` 幂等守卫，随后到达的 `close` 不会把已停机的失败覆盖成「干净退出 = 成功」。
3. **补齐批量路由的两道停机阀**（与 `batch-checkup` 的 30 分钟总阀同口径）：总时长 `WORKER_KILL_MS = 30min`；静默看门狗 `WORKER_SILENCE_MS = 15min`（任何 stdout/stderr 字节都会重置它，所以只有真停在原地才触发；慢速 CLI 的工具间隔实测 1–4 分钟，余量充足）。触发同样是 `stopNow(reason)` → 终止 + 立即结案。
4. **原因必须写明白**：`persistRunOutcome` 接受 `fatalReason`，它**优先于**通用门文案——「模型额度用尽」不再显示成 `is it installed and authenticated?`。批量侧把原因写进子项 `reason`/子台账 `errMsg`；`/api/run` 侧随 error 终态进实时卡片与台账（`failureLedgerMsg` 会再附 stderr/输出尾部），pdf 分支单独拼接死因。
5. **终止判定刻意窄于标记判定**：per-CLI 的 `stderrIsFatal`（含 `FATAL_GENERIC_STDERR_RE` 的 `\berror\b` / `not found` / `denied`）继续只做 `sawError` 标记，**不**触发终止；触发终止的只有上面四类确定失败。理由见下条。
6. **自恢复重试有豁免**：行内声明自己在重试（`retrying` / `retry in` / `will retry`）的额度或传输错误不判死——CLI 还在处理，判断插进去就是打断一次本可成功的运行；认证类不豁免（重试治不好认证）。

## Alternatives considered

- **把 `FATAL_GENERIC_STDERR_RE` 直接升级成终止条件**（"只要出现 error 字样就停"）：最贴近字面要求，但那是 #2085 / #1974 两次「干净运行被判红」的原路——`Authentication successful`、`0 errors`、MCP 透传都曾命中。标记错的代价是卡片变红，终止错的代价是**杀掉一个本会写完报告的评估**，两者不能共用同一套词表。否决。
- **只扩充各 CLI 的 `stderrIsFatal` 正则**：能补上 OpenCode 的额度措辞，但仍然是「标记」而非「终止」，事故的第 2/3 层缺口原样保留。否决。
- **给 OpenCode 单独写一个 parseEvent 解析它的 JSON 结构化输出**：能拿到错误事件，但 OpenCode 的 `run` 在本次事故里根本没把错误发到 stdout/stderr，且这会让「跨引擎一致」退化成「逐引擎打补丁」。留作后续可选项，不作为本 ADR 的前提。
- **只加总时长阀（30 分钟）**：能兜住「慢」，兜不住「静默挂死」，事故仍然要 30 分钟才收尾；而且批量评估正常耗时 2–3 分钟，30 分钟的止损对用户毫无感知价值。保留总阀，但必须再加静默检测。
- **在 `child.kill()` 后同步 `finish()` 等待 `close`**：`close` 可能因进程僵死而迟迟不来，池槽会被继续占用——这正是事故的表现。决议是「先结案、后清理」，等 `close` 只用于兜底。

## Consequences

- 额度耗尽/认证失效/模型选错/API 不可达这四类失败，从「占用池槽直到超时」变成「数秒内终止并写明原因」；`/jobs` 卡片、批量子项、台账行都能直接读到死因原文。
- 批量评估最短有了明确的下界行为：静默 15 分钟即停，30 分钟必停；`pool-13/14` 这类排队 worker 不再被一个僵死进程饿死。
- 误杀风险：新分类器只覆盖四类确定失败，且豁免自报重试的行；仍可能存在「工具输出里恰好出现 quota/429 字样」的极端误判——代价是一次可重跑的失败，而不是静默挂死一小时。若出现误杀，修的是分类器词表，不是把终止退回标记。
- `persistRunOutcome` 新增可选参数，既有调用点行为不变；`fatalReason` 为 null 时文案字节不变。
- 未覆盖：`cv-tailor` 等其他 `execFile` 派发点（它们自带 `timeout` 且不走 CLI 长跑链路），以及 CLI 完全不写 stderr 的静默死法——后者靠静默看门狗兜底，而非错误分类。

## References

- 事故现场：`active-pool-12` / 报告号 1239（2026-11-03 14:32 → 15:33，池槽占用 61 分钟）
- ADR-0014（全局 CLI 并发池）、ADR-0042（工作器卡诚实时间链）、ADR-0034（失败证据入账本）、ADR-0030（诚实门）
- `web/src/lib/run-cli-support.mjs`、`web/src/app/api/run/route.ts`、`web/src/app/api/batch-evaluate/route.ts`、`web/src/app/api/batch-checkup/route.ts`
- 测试：`web/tests/lib/run-cli-support.test.mjs`、`web/tests/lib/agent-fail-fast-wiring.test.mjs`

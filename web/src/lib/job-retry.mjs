/**
 * 工作器任务重试的判定与重置逻辑 — 纯函数，零 DOM 依赖，客户端可导入
 * （.mjs 供 node --test 锁定，同 row-click.mjs / inbox-url.mjs 模式）。
 *
 * ADR-0061：失败（error 终态）的本地卡可手动重试——原卡复用、attempt+1。
 * 重试的取参来源是卡上的派发参数快照：单任务凭 kind+input，批量凭 urls/ns
 * （这是原始清单的唯一可靠来源）。池源卡（active-*）是轮询临时投影、没有
 * 完整参数，永远不可重试。ledger-only 行（ADR-0061 修订 1）：单次卡台账存了
 * kind+input，可重试（retryJob 对不在本地 store 的卡种子一张全新本地卡）；
 * 批量卡台账只有结论清单、无 urls/ns，仍然不可重试。
 *
 * ADR-0095：批量评估（batch-evaluate）的整卡重试不再整批从头跑——`batchRetryPlan`
 * 从 items 结论里挑出失败/无结论的项作为本轮清单，已成功项跳过（省掉重复烧
 * token）。原始 urls 仍是取参来源：items 只用来判定「哪些已经有结论」，不会被
 * 当作清单反推。被跳过的成功项结论原样留在卡上（`retryKept`），失败证据不会
 * 因为重试而消失——这正是 ADR-0093 当初否决「失败子集塞回父卡」的理由，本
 * 版用「保留成功项 items」正面解决。checkup 批量维持全量重跑（决策见 ADR-0095）。
 *
 * 注意区分两类「快照」：派发参数（kind/input/urls/ns）重试必须原样复用；
 * 运行引擎（cliId/model）**不是**重试的取参来源——ADR-0061 修订 2 起，重试
 * 一律取派发那一刻的最新模型配置（失败往往就出在那个模型上）。
 */

/** 批量任务的 kind——它们的派发参数是 urls/ns 而非单个 input。 */
export const BATCH_JOB_KINDS = Object.freeze(["batch-evaluate", "batch-checkup"]);

/**
 * 批量卡本轮重试要跑哪些项（ADR-0095）。
 *
 * - `field`：落到卡上的派发参数字段（evaluate 看 urls，checkup 看 ns，二者互斥，
 *   与 `dispatchJob` 的批量二分同口径）。
 * - `retry`：本轮真正要跑的清单；`kept`：已定结论、本轮跳过（仅 scoped 时非空）。
 * - `scoped`：是否真的做了子集化。`false` = 沿旧行为整批重跑（checkup 批量、
 *   items 缺失的旧卡），此时 `retry` 即全量清单。
 *
 * 子集化只对 `batch-evaluate` 开放：
 * 1. checkup 的单次体检必须先过 `/api/checkup-request` 前哨（no-via 门、同
 *    tracker# 在跑去重、替换语义，ADR-0093 决议 4）——整卡重试已经是既有例外，
 *    再按项挑会放大绕过面，本期不动。
 * 2. 判「已定结论」用 `ok === true || skipped === true`（跳过不算失败，ADR-0041
 *    决议 5）。失败项与「结论丢失」的 `item-running` 占位（ok=false 无 reason，
 *    ADR-0093 修订 1）一律留在重试清单里。
 * 3. items 为空（早于 ADR-0042 的旧卡、快照被 cap 截断）时判不了成功项，退回
 *    全量——宁可重复也不漏跑失败项。
 *
 * @param {{ kind?: string, urls?: string[], ns?: string[], items?: Array<{ key?: string, ok?: boolean, skipped?: boolean }> } | null | undefined} job
 * @returns {{ field: "urls" | "ns", retry: string[], kept: string[], scoped: boolean } | null}
 *   null = 不是可重试的批量卡（单任务 / 无 urls 与 ns）。
 */
export function batchRetryPlan(job) {
  if (!job || typeof job !== "object") return null;
  if (!BATCH_JOB_KINDS.includes(job.kind)) return null;
  const field = (job.ns?.length ?? 0) > 0 ? "ns" : "urls";
  const all = field === "ns" ? job.ns : job.urls;
  if (!Array.isArray(all) || all.length === 0) return null;
  const items = Array.isArray(job.items) ? job.items : [];
  if (job.kind !== "batch-evaluate" || items.length === 0) {
    return { field, retry: all.slice(), kept: [], scoped: false };
  }
  const settled = new Set(
    items.filter((it) => it && (it.ok === true || it.skipped === true)).map((it) => String(it.key)),
  );
  const retry = all.filter((k) => !settled.has(k));
  const kept = all.filter((k) => settled.has(k));
  return { field, retry, kept, scoped: true };
}

/**
 * 这张卡当前能否发起重试。
 * 规则（ADR-0061 决议 4/8 + 修订 1 + ADR-0095）：status === "error"（含跨会话
 * 恢复的 interruptedAt 卡）且 id 不是池源前缀（active-*）——本地卡（job-）与
 * ledger-only 单次卡（id = 服务端 runId）都可重试。批量卡必须留有非空
 * urls/ns 快照（ledger-only 批量卡没有，天然被拦），且本轮还得有项要跑：
 * batch-evaluate 全部成功（items 里没有失败/无结论项）时无可重试，返回 false。
 * 单任务卡必须留有 kind+input。取消/完成不提供入口；判不了就 false。
 *
 * @param {{ id?: string, status?: string, kind?: string, input?: string, urls?: string[], ns?: string[], items?: Array<{ key?: string, ok?: boolean, skipped?: boolean }> } | null | undefined} job
 * @returns {boolean}
 */
export function canRetryJob(job) {
  if (!job || typeof job.id !== "string" || job.id.length === 0) return false;
  // 池源卡（active- 前缀）是 /api/active-runs 轮询的临时投影，不落 localStorage、
  // 没有可持久化的派发快照，取消后下次轮询即消失——永远不可重试（修订 1）。
  if (job.id.startsWith("active-")) return false;
  if (job.status !== "error") return false;
  if (BATCH_JOB_KINDS.includes(job.kind)) {
    // ADR-0095：批量评估的本轮清单可能为空（全成功）——那就没有可重试的项。
    return (batchRetryPlan(job)?.retry.length ?? 0) > 0;
  }
  // 本地卡与 ledger-only 单次卡都凭 kind+input 整卡重发。
  return !!job.kind && !!job.input;
}

/**
 * 下一次尝试的序号——缺省视为第 1 次（功能前创建的旧卡没有 attempt 字段）。
 * @param {{ attempt?: number } | null | undefined} job
 * @returns {number}
 */
export function nextAttempt(job) {
  return (job?.attempt ?? 1) + 1;
}

/**
 * 为重试重置一张卡（原卡复用，ADR-0061 决议 3）：不换 id、不新增卡。
 * 保留展示与派发字段（title/subtitle/page/input/kind/cliId/model/reportNum/
 * batchId/urls/ns，引擎字段会被本次派发改写——见下），attempt+1、状态回
 * running、时间线追加「第 N 次尝试」
 * 分隔行后保留旧步骤（STEPS_CAP 滚动窗口自然截断更早的尝试）；上次运行的
 * 运行态与结论（items/batchPos/serverBatchId/text/result/cost/runId/
 * interruptedAt/时间戳/阶段）全部清除，由新 run 重建。
 *
 * `retry`（ADR-0095，`batchRetryPlan` 的产物）把「本轮只跑失败项」落到卡上：
 * `scoped` 时 urls/ns 收窄为本轮清单，且**已成功的子项结论保留**（`items` 只留
 * ok/skipped 项，键记进 `retryKept`）——否则一次重试就把成功项的报告号、分数、
 * 子详情链接一起抹掉。非 scoped 时与旧行为一致：清空 items、urls/ns 原样。
 *
 * @param {Record<string, unknown>} job - 原卡（须已通过 canRetryJob）。
 * @param {{ now: number, separatorLabel: string, retry?: { field: "urls" | "ns", retry: string[], kept: string[], scoped: boolean } | null }} opts - now = 重试发起时刻；
 *   separatorLabel = 分隔行文案（调用方用 i18n 生成，如 t("jobs.retryAttempt", { n })）；
 *   retry = 本轮的项清单计划，缺省/非 scoped 即整批重跑。
 * @returns {Record<string, unknown>} 重置后的新卡对象（原对象不变）。
 *
 * `cliId`/`model` 仍照抄原卡，但它们描述的是**上一轮**尝试；本次尝试的引擎由
 * 派发前解析的最新设置覆盖（ADR-0061 修订 2），这里保留只为避免重置瞬间卡片
 * 上「派发给」一栏闪成未记录。
 */
export function resetJobForRetry(job, { now, separatorLabel, retry = null }) {
  const scoped = retry?.scoped === true && (retry.retry?.length ?? 0) > 0;
  const keptItems = scoped
    ? (job.items ?? []).filter((it) => it && (it.ok === true || it.skipped === true))
    : [];
  return {
    id: job.id,
    title: job.title,
    subtitle: job.subtitle,
    page: job.page,
    input: job.input,
    kind: job.kind,
    cliId: job.cliId,
    model: job.model,
    reportNum: job.reportNum,
    batchId: job.batchId,
    urls: scoped && retry.field === "urls" ? retry.retry.slice() : job.urls,
    ns: scoped && retry.field === "ns" ? retry.retry.slice() : job.ns,
    attempt: nextAttempt(job),
    status: "running",
    steps: [...(job.steps ?? []), { kind: "status", label: separatorLabel, ts: now }],
    text: "",
    startedAt: now,
    // 成功项结论与「本轮未重跑」的键：只在真的跳过时存在（非 scoped 时旧行为，
    // 键整体缺省 —— 既有单测按 `k in r === false` 锁定过这一点）。
    ...(scoped && keptItems.length > 0 ? { items: keptItems, retryKept: (retry.kept ?? []).slice() } : {}),
  };
}

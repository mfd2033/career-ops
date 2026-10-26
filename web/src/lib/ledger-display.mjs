/**
 * ledger-display.mjs — ledger-only 行的可读形状（ADR-0051 后果条目的补丁）。
 *
 * 服务端 `recordEnd` 写台账时，标题一律是 `${kind} ${input}`（run/route.ts），且
 * 只有 checkup 会写 `page`。网页发起的任务有 localStorage 本地卡兜着，历史页显示
 * 的是本地卡的漂亮形状；但**扩展 / CLI / 脚本发起的任务没有本地卡**，于是历史列表
 * 与详情页只能印那串裸标题 —— 同一个「评估」，从网页点进去叫「评估」，从招聘站
 * 扩展点进去叫「evaluate https://www.zhipin.com/job_detail/c08d86….html」。
 * ADR-0045 当年把这类来源称作历史页的主要盲区，这是它在单任务侧的同一表现。
 *
 * 这里做的是**读取端**的派生，不回填台账：历史裸记录与新记录一样可读，且不需要
 * 每次改文案就重打包。派生的原料只有记录自己带的 `kind`/`input`——不去猜公司名、
 * 不猜职位名（那些在报告和 tracker 行里，本层拿不到，硬编就是编造）。
 *
 * Plain .mjs：node --test 锁定（同 ledger-merge.mjs）。
 */

import { ledgerOnlyRuns } from "./ledger-merge.mjs";

/** 派发端用的标题 i18n 键；缺这个键的种类一律原样显示标题。 */
const KIND_TITLE_KEY = {
  evaluate: "jobs.evaluateTitle",
  research: "jobs.researchTitle",
  "fix-portal": "jobs.fixPortalTitle",
  pdf: "jobs.cvPdfTitle",
};

/** 派发端会带、而 recordEnd 不写的落地页（只写有把握的两个）。 */
const KIND_PAGE = {
  evaluate: "/pipeline",
};

const httpUrl = (input) => typeof input === "string" && /^https?:\/\//i.test(input);

/** 招聘站域名，去掉协议与 www. —— 唯一能从 input 诚实读出的锚点。 */
function hostOf(input) {
  if (!httpUrl(input)) return "";
  try {
    return new URL(input).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

/**
 * ledger-only 行应该显示成什么。
 *
 * 只在标题**正是** `${kind} ${input}`（即 recordEnd 的兜底形状）时才派生——批量行
 * 有自己的「批量评估 · N 项」、体检行有「公司体检：X」，都不该被改写。
 *
 * @param {{kind?: string, input?: string, title?: string, page?: string, t?: (k: string, p?: Record<string, string | number>) => string}} args
 * @returns {{title: string, subtitle?: string, page?: string}}
 */
export function ledgerCardFields({ kind, input, title, page, t } = {}) {
  const raw = typeof title === "string" ? title : "";
  const translate = typeof t === "function" ? t : (k) => k;
  // 非兜底形状（已经有人写过可读标题）或服务端本就写了落地页 → 不动。
  const isRawFallbackShape = !!kind && raw === `${kind} ${input ?? ""}`;
  if (!isRawFallbackShape) {
    return { title: raw, page };
  }
  const key = KIND_TITLE_KEY[kind];
  if (!key) return { title: raw, page };

  // fix-portal 的 input 就是公司名，pdf 的是裸报告号 —— 各自喂进模板要的参数。
  const anchor = String(input ?? "");
  const params = kind === "fix-portal" ? { company: anchor } : kind === "pdf" ? { company: `#${anchor}` } : undefined;
  const out = { title: translate(key, params), page: page || KIND_PAGE[kind] };
  if (kind === "evaluate") {
    const host = hostOf(input);
    if (host) out.subtitle = host;
  }
  return out;
}

/**
 * 台账行 → 展示卡片的单一映射（/jobs 主列表与侧栏托盘共用）。
 *
 * 以前这段映射内联在 page.tsx 里；托盘要合并同一批 ledger-only 行时必然
 * 复制粘贴（Duplicated Code），抽出来两边吃同一个形状。去重口径不变：
 * 本地卡（凭 runId/serverBatchId）胜出，批量子行不进列表。生成的卡标
 * `ledgerOnly: true`——它不是本地状态，托盘凭这个标记不挂「✕ 忽略」
 * 这种对台账行无效的死按钮，详情页凭 id 未命中本地卡走 ledger 兑底。
 *
 * @param {Array<{runId?: string, serverBatchId?: string}>} jobs 本地卡（含池投影）
 * @param {Array<{id?: string, kind?: string, input?: string, title?: string, page?: string, status?: string, startedAt?: number, finishedAt?: number, msg?: string, cliId?: string, model?: string, items?: unknown[], total?: number, parentId?: string, reportNum?: number | string}>} ledgerRuns /api/runs/history 的行
 * @param {(k: string, p?: Record<string, string | number>) => string} [t] i18n 翻译（缺失时保留裸标题）
 * @returns {Array<Record<string, unknown>>} 台账序（最新在前）的终态卡
 */
export function ledgerRunsToCards(jobs, ledgerRuns, t) {
  return ledgerOnlyRuns(jobs, ledgerRuns).map((r) => ({
    id: r.id,
    ...ledgerCardFields({ kind: r.kind, input: r.input, title: r.title, page: r.page, t }),
    input: r.input,
    kind: r.kind,
    runId: r.id,
    cliId: r.cliId,
    model: r.model,
    status: r.status === "done" ? "done" : "error",
    steps: [],
    text: r.msg || "",
    startedAt: r.startedAt,
    endedAt: r.finishedAt,
    // ADR-0045：台账落盘的逐项快照随卡带出，供列表展开/详情页消费；
    // 旧行无 items 时为 undefined，展示端自行保持诚实空白。
    items: r.items,
    batchTotal: r.total,
    // ADR-0089：台账行显式记的报告号（捕获值）——ledger-only 卡凭它直接跳报告，
    // 不必退回 URL join / kind 猜。缺失 = 未记录，不占位、不回填。
    reportNum: r.reportNum != null ? String(r.reportNum) : undefined,
    ledgerOnly: true,
  }));
}

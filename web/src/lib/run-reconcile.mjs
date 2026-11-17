/**
 * run-reconcile.mjs — what a single /api/run evaluate owes data/pipeline.md
 * (ADR-0051 决议 9/10).
 *
 * The batch orchestrator reserves a contiguous report-number range up front, so it
 * always knows which (num, url) pair each worker scored and can hand those pairs to
 * `reconcile-pipeline.mjs --entry` when the batch ends.
 *
 * 2026-11-17 起单任务也预占号了（POST /api/run → reserve-report-num.mjs，见
 * `hasCompletedReportForNum`）：归属判定锚在本 run 的独占号上，不再依赖
 * `deriveRunReportNum` 的「窗口内新增」观测。后者保留为本文件原始契约的兼容
 * 实现与历史断言（并发下它只会拒绝猜，不会给出错号）。
 *
 * Pure — no fs, no Next — so the refusal to guess is assertable rather than emergent.
 */
import { completedReportNames } from "./run-cli-support.mjs";
import { isReservedReportFile } from "./report-files.mjs";

/** Report numbers are 3+ digits, zero-padded by the allocator but historically
 *  unpadded in the wild (`1001-taken.md` is a real report name). */
const REPORT_NUM_RE = /^(\d{3,})-/;

/**
 * The report number this run persisted, or null when it cannot be established.
 *
 * Exactly one new completed report → that one. None → the run produced nothing
 * (its own honesty gate already says so). More than one → another evaluate run
 * landed its report inside this run's window, and attaching the wrong number to a
 * pipeline row is worse than leaving the row for `reconcile-pipeline.mjs
 * --from-tracker`, the script's own documented self-heal sweep.
 *
 * @param {{beforeEntries: string[], afterEntries: string[]}} args
 * @returns {number | null}
 */
export function deriveRunReportNum({ beforeEntries, afterEntries }) {
  const before = completedReportNames(beforeEntries ?? []);
  const after = completedReportNames(afterEntries ?? []);
  const candidates = [];
  for (const name of after) {
    if (before.has(name)) continue;
    const m = REPORT_NUM_RE.exec(name);
    if (m) candidates.push(Number(m[1]));
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * 本 run **预占的那个号**是否已经落成正式报告？
 *
 * 与 `deriveRunReportNum` 的区别是归属锚点：这里不看「窗口内新增了什么」，
 * 只看「我独有的号是否存在非 RESERVED 的 .md」。并发池里别的 worker 写下的
 * 报告永远不会命中本号，所以既不会把空跑洗成 done，也不会把别人的号认成自己的
 * （2026-11-17 云宝三连同挂 #1341、17 条并发里 5 条空跑却被记 done）。
 *
 * @param {string[]} entries reports/ 目录项
 * @param {number} num 本 run 预占的报告号
 * @returns {boolean}
 */
export function hasCompletedReportForNum(entries, num) {
  if (!Number.isSafeInteger(num) || num < 1) return false;
  const prefix = `${String(num).padStart(3, "0")}-`;
  return (entries ?? []).some(
    (name) => typeof name === "string" && name.startsWith(prefix) && name.endsWith(".md") && !isReservedReportFile(name),
  );
}

/**
 * The argv for `reconcile-pipeline.mjs`, or null when there is nothing to do.
 *
 * Only an evaluate run whose input IS a posting URL can be reconciled: pdf takes a
 * bare report number, checkup a tracker row number, fix-portal a company name —
 * moving an inbox row on any of those keys would move the wrong row.
 *
 * @param {{kind: string, input: string, num: number | null | undefined}} args
 * @returns {string[] | null}
 */
export function buildReconcileArgs({ kind, input, num }) {
  if (kind !== "evaluate") return null;
  if (num == null) return null;
  if (typeof input !== "string" || !/^https?:\/\//i.test(input)) return null;
  return ["--entry", `${num}|${input}`];
}

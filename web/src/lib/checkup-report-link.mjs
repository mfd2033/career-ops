// 体检（checkup）工作器的报告入口目标。
//
// 与 report-num.mjs 的分工：那个函数回答「这张卡对应的评估报告是哪份」，跳
// /report/{n}；体检卡的数字虽然同形（tracker#），跳转目标却是
// /api/checkup-report?n= 的体检 HTML。两者必须分开解析，否则体检卡会被送进
// 别人的评估报告页（2026-11-18 工作器里体检任务的真实表现）。
//
// 「不渲染无法生效的入口」：status 必须是 done。失败/中断的 run 没有本次产物，
// 即使该行历史上体检过，也不把旧报告冒充成本次结果。HTML 是否真的落盘由
// /api/checkup-report 的 HEAD 探测回答，不在这一层猜。
//
// Plain .mjs 便于 node --test 锁定契约（web/tests/lib/checkup-report-link.test.mjs）。
const NUMERIC = /^\d+$/;

/**
 * 体检卡的体检报告号（= 该行的 tracker#），或 null。
 * @param {{ kind?: string, input?: string, status?: string } | null | undefined} job
 * @returns {string | null}
 */
export function checkupReportNum(job) {
  if (!job || job.kind !== "checkup") return null;
  if (job.status !== "done") return null;
  const input = typeof job.input === "string" ? job.input.trim() : "";
  return NUMERIC.test(input) ? input : null;
}

/**
 * 体检 HTML 的站内地址；非法号返回 null（不拼一个必然 400 的链接）。
 * @param {string | number | null | undefined} n
 * @returns {string | null}
 */
export function checkupReportHref(n) {
  const s = String(n ?? "").trim();
  return NUMERIC.test(s) ? `/api/checkup-report?n=${s}` : null;
}
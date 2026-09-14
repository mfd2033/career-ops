// inbox-salary.mjs — 收件箱行的薪资识别（ADR-0023）。
//
// 事实源是 pipeline.md 行 note 的尾段——确认入管时核心写入器（scan.mjs
// formatPipelineOffer 的 ` | note: …` 标签段）落库的形态：确认时 note 被
// web/src/lib/core/pipeline.ts 拼成 `[原note, salaryText || 薪资未知].join(" · ")`，
// 所以薪资要么是「 · 」分隔的末段薪资文本，要么是末段的「薪资未知」标记。
//
// 仅认尾段是 ADR-0023 的硬边界：用户手写的 note 内容（「周三面试 35K 岗」）
// 不是「 · 」分隔的末段薪资形态，永不被解析成薪资。尾段还要通过一个锚定的
// 薪资形态校验（数字开头 / 字面「面议」），双保险拦住任何恰好落在末段的
// 手写文字。数值解析复用探索页的 parseSalaryText（口径约定见 CONTEXT.md
// 「薪资文本」词条），绝不在此另写第二套折算。

import { parseSalaryText, cleanSalaryText } from "./browser-search.mjs";

/** 确认入管写入的「薪资未知」标记字面量（与 core/pipeline.ts 的写入一致）。 */
export const SALARY_NOTE_UNKNOWN = "薪资未知";

/**
 * 锚定的尾段薪资形态：数字开头（可选单位、区间、元/天·月口径、·N薪系数），
 * 或字面「面议」。手写句子（含空格夹词、标点收尾）进不了这个形态。
 * 纯常量 — 导出给测试锁定。
 */
export const SALARY_TAIL_RE =
  /^(?:面议|\d+(?:\.\d+)?\s*[千Kk万元]?(?:元\s*\/\s*(?:天|日|时|小时|周|月))?(?:\s*[-–—~～]\s*\d+(?:\.\d+)?\s*[千Kk万元]?)?(?:元\s*\/\s*(?:天|日|时|小时|周|月))?(?:\s*·\s*\d+薪)?)$/;

/**
 * 从 note 原文提取薪资尾段。纯 — 导出给测试。
 * @param {string} [note] pipeline.md 行的 note 标签段原文（可能为空）
 * @returns {{ text: string } | { unknown: true } | null}
 *   { text }    末段是薪资文本（已做 PUA 清洗，展示/解析共用）
 *   { unknown } 末段就是「薪资未知」标记
 *   null        没有「 · 」尾段，或尾段不是薪资形态（手写内容等）
 */
export function noteSalaryTail(note) {
  const raw = String(note ?? "").trim();
  if (!raw) return null;
  // 分隔符是「 · 」（空格-点-空格，core/pipeline.ts 的 join 写法）。绝不能用裸
  // 「·」切：薪资文本自带的「·14薪」年度系数会被误切成「14薪」尾段。
  // 剥掉开头悬挂的「· 」——用户删掉原 note 首段后会留下「 · salaryText」形态，
  // 尾段不该因首段缺席而丢失（确认入管写入本身不会产出这种形态）。
  const norm = raw.replace(/^(?:·\s+)+/, "");
  const sep = norm.lastIndexOf(" · ");
  // 无分隔符：整条 note 就是确认时写入的薪资文本（原 note 为空的情形）。
  const tail = (sep === -1 ? norm : norm.slice(sep + 3)).trim();
  const cleaned = cleanSalaryText(tail);
  if (!cleaned) return null;
  if (cleaned === SALARY_NOTE_UNKNOWN) return { unknown: true };
  if (!SALARY_TAIL_RE.test(cleaned)) return null;
  return { text: cleaned };
}

/**
 * 薪资解析所属站点：猎聘裸「万」是年薪、智联是月薪——口径逐站不同
 * （CONTEXT.md「薪资文本」）。收件箱行不带 source 列，从 URL host 推。
 * 纯 — 导出给测试。
 * @param {string} [url]
 * @returns {string} "zhipin" | "liepin" | "zhaopin" | ""（未知站点按缺省口径）
 */
export function salaryBoardFromUrl(url) {
  let host = "";
  try {
    host = new URL(String(url ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (host === "zhipin.com" || host.endsWith(".zhipin.com")) return "zhipin";
  if (host === "liepin.com" || host.endsWith(".liepin.com")) return "liepin";
  if (host === "zhaopin.com" || host.endsWith(".zhaopin.com")) return "zhaopin";
  return "";
}

/**
 * 收件箱行的薪资格式（ADR-0023 决定 1）：note 尾段 → 解析。
 * 纯 — 导出给测试。
 * @param {string} [note]
 * @param {string} [url] 行的职位 URL，用于站点口径
 * @returns {{ salaryText?: string, salaryUnknown: boolean }}
 *   salaryText   展示用原文（PUA 已清洗）；尾段缺失时缺省
 *   salaryUnknown 解析不出月薪（含无尾段/手写行/面议/元·天口径）——「不误删」
 *                取向：过滤放行、排序沉底、展示打标
 */
export function inboxSalaryFromNote(note, url) {
  const tail = noteSalaryTail(note);
  if (!tail) return { salaryUnknown: true };
  if (tail.unknown) return { salaryUnknown: true };
  const parsed = parseSalaryText(tail.text, salaryBoardFromUrl(url));
  if (!parsed) return { salaryText: tail.text, salaryUnknown: true };
  return { salaryText: tail.text, salaryUnknown: false, range: parsed };
}

/**
 * 收件箱行的月薪区间（过滤/排序的数值源）：行携带的薪资文本 → parseSalaryText，
 * 站点口径从 URL 推。无薪资文本或解析不出（薪资未知）→ null。
 * 纯 — 导出给测试。
 * @param {string} [salaryText]
 * @param {string} [url]
 * @returns {{ minK: number, maxK: number } | null}
 */
export function inboxSalaryRange(salaryText, url) {
  const t = String(salaryText ?? "").trim();
  if (!t) return null;
  return parseSalaryText(t, salaryBoardFromUrl(url));
}

/**
 * 薪资下限门（语义与探索页 applyBrowserSalaryGate 一致——「不误删」）：
 * 区间重叠（区间上限 ≥ 下限）即保留；无区间（薪资未知）放行；下限 0/缺省 = 门关。
 * 纯 — 导出给测试。
 * @param {{ minK: number, maxK: number } | null} [range]
 * @param {number | null} [salaryMinK] 月薪下限（K）；null/0 = 门关
 * @returns {boolean}
 */
export function passesInboxSalaryFloor(range, salaryMinK) {
  const floor = Number(salaryMinK) || 0;
  if (floor <= 0) return true;
  if (!range) return true; // 薪资未知 → 放行并打标，绝不静默丢弃
  return range.maxK >= floor;
}

/**
 * 薪资排序键（ADR-0023 决定 4）：区间中位值（月薪 K）。薪资未知 → null（排序沉底）。
 * 纯 — 导出给测试。
 * @param {{ minK: number, maxK: number } | null} [range]
 * @returns {number | null}
 */
export function inboxSalaryMedian(range) {
  if (!range) return null;
  return Math.round(((range.minK + range.maxK) / 2) * 10) / 10;
}

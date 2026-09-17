// report-salary.mjs — 「报告薪资」（ADR-0037）：tracker 行的薪资，事实源是该行
// 评估报告 Machine Summary 的 `advertised_comp`。
//
// 与探索页 / 收件箱的薪资是两套口径，故不复用它们的入口函数：
//   • 收件箱薪资 = pipeline.md note 尾段的**采集卡片**原文（ADR-0023），展示原文直出；
//   • 报告薪资 = 评估员写进报告 Machine Summary 的**招聘方薪资**，展示归一化月薪 K 区间。
// 数值解析仍复用 parseSalaryText（不修改它：探索页/收件箱/薪资下限共用，行为由
// web/tests/lib/browser-search.test.mjs 锁定），本模块只补报告串特有的归一化层。
//
// 为什么需要这一层（实测本机 685 份报告，492 条字段有文本）：
//   1. `10-15K CNY/月`、`8-12K CNY/month` 这类币种后缀会撞上 parseSalaryText 的
//      `(?![a-zA-Z])` 尾守卫而整体判失败——直解只有 294/492，归一化后 489/492；
//   2. 站点口径在报告语境是错层的：55 条含「万」里有 22 条是既无 `/月` 也无「年」的
//      裸「万」（`1.5–2.5万` 等），都是月薪——若按猎聘口径（裸万 = 年薪 ÷12）会算错
//      一个数量级。故 source 一律传空（未知站点 = 裸万按月薪），只有报告里显式的
//      「/年」「年薪」才 ÷12（parseSalaryText 内部处理）。
//
// 普通 .mjs（同 pipeline-order.mjs / score-num.mjs）：供 node --test 直接 import。
// 契约与验收见 .scratch/tracker-salary-column/issues/01-report-salary-parser.md。

import { parseSalaryText, cleanSalaryText } from "./browser-search.mjs";

/** Machine Summary 的字段行（YAML 围栏内，行首、可能带缩进与引号）。 */
const COMP_LINE_RE = /^[ \t]*advertised_comp:[ \t]*(.*)$/m;
/** YAML 里的「没有值」写法——不算原文，不产出可悬停文本。 */
const NO_TEXT_RE = /^(null|~|none|n\/a|-)$/i;
/** 非人民币币种：一律不解析（ADR-0037 决议 3）。实测 1 条日元，且报告里作者
 *  往往已写好折算注记（「25万~55万日元/月（约1.2万~2.6万CNY）」），按汇率再算
 *  一遍是重复劳动且引入汇率波动。 */
const NON_CNY_RE = /日元|美元|USD|JPY|欧元|EUR|HKD|SGD|港币|[$€£]/i;
/** 币种视同「元」——这是直解率从 294/492 提到 489/492 的那一刀：
 *  parseSalaryText 只认 千|k|K|万|元，不认 CNY/RMB。 */
const CURRENCY_AS_YUAN_RE = /CNY|RMB|人民币|￥|¥/gi;
/** 括号补充说明（中英文括号）：`15-30K CNY（底薪5000-11000 + 提成）` 去掉尾注，
 *  否则括号里的第二个数字区间可能被当成薪资。原文不受影响（悬停仍给全量）。 */
const PARENTHETICAL_RE = /[（(][^）)]*[）)]/g;

/**
 * 抽报告正文里的 `advertised_comp` 原值。第一个匹配（Machine Summary 在最前）
 * 即事实源；缺行 / 值为 `null`/`~`/空 → ""（调用方据此判定「无可悬停原文」）。
 * 注：parseReport（web/src/lib/parse-report.mjs）只读报告头部的 `**粗体:**` 字段，
 * 不覆盖 Machine Summary 的 YAML 围栏，故此处单独抽。
 * @param {string} reportMd - 报告全文
 * @returns {string} 去引号的字段原文，或 ""
 */
export function extractAdvertisedComp(reportMd) {
  const m = String(reportMd ?? "").match(COMP_LINE_RE);
  if (!m) return "";
  const text = m[1].trim().replace(/^["']|["']$/g, "").trim();
  return NO_TEXT_RE.test(text) ? "" : text;
}

/**
 * 报告薪资：字段原文 + 归一化后的月薪 K 区间。
 * @param {string} comp - `extractAdvertisedComp` 的产物（也接受直接粘贴的字段值）
 * @returns {{ text: string, range: { minK: number, maxK: number, medianK: number } | null } | null}
 *   null 表示字段缺失/为 null（连原文都没有，行里既无区间也无悬停）
 *   range null 表示有原文但解析不出月薪（展示为「—」，悬停仍是原文）
 */
export function parseReportSalary(comp) {
  const text = String(comp ?? "").trim();
  if (!text) return null;
  return { text, range: rangeFromComp(text) };
}

/** 归一化 + 解析。顺序不可调换：先剔外币，再去尾注，再把币种换成「元」。 */
function rangeFromComp(text) {
  if (NON_CNY_RE.test(text)) return null;
  const normalized = cleanSalaryText(text)
    .replace(PARENTHETICAL_RE, " ")
    .replace(CURRENCY_AS_YUAN_RE, "元")
    .replace(/month/gi, " ");
  const parsed = parseSalaryText(normalized, "");
  if (!parsed) return null;
  const medianK = Math.round(((parsed.minK + parsed.maxK) / 2) * 10) / 10;
  return { minK: parsed.minK, maxK: parsed.maxK, medianK };
}

/**
 * 展示用串：`10-15K`（单值不写 `30-30K`，小数保留一位如 `6.5K`）。
 * @param {{minK: number, maxK: number} | null | undefined} range
 * @returns {string} 无 range 时 ""
 */
export function formatSalaryRange(range) {
  if (!range || typeof range.minK !== "number" || typeof range.maxK !== "number") return "";
  const num = (v) => String(Math.round(v * 10) / 10);
  return range.minK === range.maxK ? `${num(range.minK)}K` : `${num(range.minK)}-${num(range.maxK)}K`;
}

/**
 * 排序值：区间中位值（ADR-0037 决议 5，与收件箱 ADR-0024 同一口径）。
 * 未披露 / 无报告 / 老行没有该字段 → null（调用方按「恒沉底」处理）。
 * @param {{reportSalary?: {range?: {medianK?: number}|null}|null}} row
 * @returns {number | null}
 */
export function salaryMedian(row) {
  const m = row?.reportSalary?.range?.medianK;
  return typeof m === "number" && Number.isFinite(m) ? m : null;
}

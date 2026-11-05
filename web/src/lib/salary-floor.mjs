/**
 * salary-floor.mjs — portals.yml `salary_filter.min`（年薪）→ 探索页「薪资下限」
 * （月薪 K）的换算。纯函数落 plain .mjs，node --test 可直接加载（房规）。
 *
 * 为什么需要换算：两处说的是同一个约束，量纲却不同。
 *   • `portals.yml` 的 `salary_filter` 是 CLI 扫描器（scan.mjs::buildSalaryFilter）
 *     的口径，min/max 都是**年薪**（template 注释原文：「use annualized values」）。
 *   • 探索页采集门的薪资门（browser-search.mjs::applyBrowserSalaryGate）取
 *     **月薪 K**（千元/月），输入框是可选的 `ExploreFilters.zhSalaryMin`。
 *
 * 种子一侧此前完全没播种这个字段，于是出现「配置里写着年薪 24 万（月薪 20K），
 * 采集时薪资门却是关的」——8-11K 的卡片照样进结果区、也照样落进 scan-history
 * 台账，最后堆在今日页「本周新匹配」里。这不是用户忘了填，是配置两条链没接上。
 *
 * 边界（宁可不播种，也不要播种一个错量纲的数）：
 *   • min 缺失 / 非有限 / ≤0 → 不播种。max-only 的配置推不出「下限」。
 *   • currency 明确不是人民币（CNY / RMB）→ 不播种。站点卡片的薪资文本由
 *     parseSalaryText 按人民币/月解析，拿 USD 年薪水换算出来的数去比会让门的
 *     行为变得不可解释（放行或误杀都不对）。currency 缺省按人民币处理，与
 *     template 的默认配置一致（CLI 侧此时也不限币种）。
 *   • 结果四舍五入到 1 位小数，与 ExploreFilters 的清洗口径（explore.ts）一致。
 */

/** 人民币币种标记：CLI 配置里大小写与 RMB 写法都出现过。 */
const CNY_MARKERS = new Set(["CNY", "RMB"]);

/**
 * 把 `portals.yml` 的 `salary_filter` 换算成探索页的月薪下限（K）。
 *
 * @param {unknown} salaryFilter - portals.yml 的 `salary_filter` 块
 * @returns {number | undefined} 月薪下限（千元/月，1 位小数）；不可换算时为 undefined
 */
export function monthlyFloorKFromSalaryFilter(salaryFilter) {
  if (!salaryFilter || typeof salaryFilter !== "object") return undefined;
  const min = Number(salaryFilter.min ?? 0);
  if (!Number.isFinite(min) || min <= 0) return undefined;
  const currency = String(salaryFilter.currency ?? "").trim().toUpperCase();
  if (currency && !CNY_MARKERS.has(currency)) return undefined;
  const monthlyK = Math.round((min / 12 / 1000) * 10) / 10;
  return monthlyK > 0 ? monthlyK : undefined;
}

// URL 域名 → 职位来源标签 / 投递时机平台 id 的映射。纯客户端安全（无 node import），
// pipeline 表的"来源"列、以及任何需要把 posting URL 还原成来源名的
// 前端共用此模块。
//
// 说明：本模块负责 HOST → label（已知招聘平台域名），与 explore.ts 的
// BROWSER_LABEL / ATS_LABEL（扫描来源 ID → label）是两套正交映射，
// 各自独立，避免耦合。
//
// 第三列是「投递时机」平台 id（ADR-0085）：只有 Boss直聘 / 猎聘 / 智联 有
// 时段矩阵，其余来源（拉勾、ATS、公司官网）为 null——报告详情页据此判断
// 该不该给这条建议，而不是拿三平台的平均值套在别处。

/** 已知平台域名后缀 → [展示标签, 投递时机平台 id（无矩阵为 null）]。按特异性降序、无交叉重叠。 */
const HOST_LABELS = [
  ["zhipin.com", "BOSS直聘", "boss"],
  ["liepin.com", "猎聘", "liepin"],
  ["zhaopin.com", "智联招聘", "zhaopin"],
  ["lagou.com", "拉勾", null],
  ["greenhouse.io", "Greenhouse", null],
  ["lever.co", "Lever", null],
  ["ashbyhq.com", "Ashby", null],
  ["myworkdayjobs.com", "Workday", null],
];

/**
 * 把职位 URL 解析成 HOST_LABELS 里的那条记录。
 *
 * 匹配用域名后缀（endswith / 全等），避免子串误伤
 * （如 "notzhipin.com" 不应命中 "zhipin.com"）。
 *
 * @param {string | null | undefined} url 职位原始 URL
 * @returns {[string, string, string | null] | null} 命中的记录；非法/空/未知域名 → null
 */
function knownHost(url) {
  if (!url || typeof url !== "string") return null;

  let hostname;
  try {
    // URL 非绝对地址（缺协议）时 constractor 会抛异常，统一按无法识别处理。
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  for (const entry of HOST_LABELS) {
    const suffix = entry[0];
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return entry;
  }
  return null;
}

/**
 * 将职位 URL 解析为来源展示标签。
 *
 * - 非法/空 URL → null（调用方回退占位符，如 "—"）
 * - 已知平台 → 标签（如 www.zhipin.com → "BOSS直聘"）
 * - 未知平台 → null
 *
 * @param {string | null | undefined} url 职位原始 URL
 * @returns {string | null} 来源标签，识别不出时返回 null
 */
export function sourceLabel(url) {
  const entry = knownHost(url);
  return entry ? entry[1] : null;
}

/**
 * 将职位 URL 解析为「投递时机」平台 id（ADR-0085）。
 *
 * - Boss直聘 → "boss"；猎聘 → "liepin"；智联招聘 → "zhaopin"
 * - 其余已知来源（拉勾、ATS…）与未知域名 → null：这些来源没有时段矩阵，
 *   调用方应据此隐藏建议或明说「该来源没有已知规律」，而不是套用别家的口径。
 *
 * @param {string | null | undefined} url 职位原始 URL
 * @returns {"boss" | "liepin" | "zhaopin" | null}
 */
export function sourcePlatform(url) {
  const entry = knownHost(url);
  return entry && entry[2] ? entry[2] : null;
}

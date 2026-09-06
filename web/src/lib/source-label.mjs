// URL 域名 → 职位来源标签 的映射。纯客户端安全（无 node import），
// pipeline 表的"来源"列、以及任何需要把 posting URL 还原成来源名的
// 前端共用此模块。
//
// 说明：本模块负责 HOST → label（已知招聘平台域名），与 explore.ts 的
// BROWSER_LABEL / ATS_LABEL（扫描来源 ID → label）是两套正交映射，
// 各自独立，避免耦合。

/** 已知平台域名后缀 → 展示标签。按特异性降序、无交叉重叠。 */
const HOST_LABELS = [
  ["zhipin.com", "BOSS直聘"],
  ["liepin.com", "猎聘"],
  ["zhaopin.com", "智联招聘"],
  ["lagou.com", "拉勾"],
  ["greenhouse.io", "Greenhouse"],
  ["lever.co", "Lever"],
  ["ashbyhq.com", "Ashby"],
  ["myworkdayjobs.com", "Workday"],
];

/**
 * 将职位 URL 解析为来源展示标签。
 *
 * - 非法/空 URL → null（调用方回退占位符，如 "—"）
 * - 已知平台 → 标签（如 www.zhipin.com → "BOSS直聘"）
 * - 未知平台 → null
 *
 * 匹配用域名后缀（endswith / 全等），避免子串误伤
 * （如 "notzhipin.com" 不应命中 "zhipin.com"）。
 *
 * @param {string | null | undefined} url 职位原始 URL
 * @returns {string | null} 来源标签，识别不出时返回 null
 */
export function sourceLabel(url) {
  if (!url || typeof url !== "string") return null;

  let hostname;
  try {
    // URL 非绝对地址（缺协议）时 constractor 会抛异常，统一按无法识别处理。
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  for (const [suffix, label] of HOST_LABELS) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return label;
  }
  return null;
}
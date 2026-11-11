/**
 * 工作器卡片（/jobs 行 + /jobs/[id] 详情页）上「打开职位原帖」的链接口径。
 *
 * 数据源是 Job.input：单任务（evaluate）就是那一条招聘站 URL，但同一个字段
 * 还装着别的东西——批量派发写的是 `urls.join("\n")`（多行清单），pdf 写裸
 * 报告号，fix-portal 写公司名。只有「恰好一条 http(s) URL」能变成外链，其余
 * 一律返回 null，调用方不渲染按钮（无数据不占位，也不做死链）。
 *
 * 为什么不直接用 openableUrl：WHATWG URL 解析会把换行当可忽略字符剔除，
 * `"https://a\nhttps://b"` 会被解析成一条畸形 URL 而通过校验——批量卡就会
 * 得到一个点开即错的链接。所以这里先挡掉任何内部空白。
 *
 * Plain .mjs：node --test 锁定（同 inbox-url.mjs）。
 */

import { openableUrl } from "./inbox-url.mjs";

/**
 * @param {string} [input] - Job.input（可能是 URL、多行 URL 清单、报告号或公司名；旧卡可能没有这个字段）。
 * @returns {string | null} 可原样打开的单条 http(s) URL；其余情况 null。
 */
export function jobPostingUrl(input) {
  const s = String(input ?? "").trim();
  // 内部含空白 = 批量清单（或被人手拼坏的值），不是单条可跳转的地址。
  if (!s || /\s/.test(s)) return null;
  return openableUrl(s);
}

/**
 * explore 结果区「移除所选」的持久层。
 *
 * 语义：轻量 triage（ADR-0010 与收件箱 hidden/shortlist 同款），只影响显示，
 * 不写 pipeline.md。存在 localStorage 而不是服务端：移除是单个浏览器的个人
 * 处置，不该进入共享数据层；跨设备清除也不需要一个同步机制。
 *
 * 这里是唯一的键名与读写入口 —— explore 的 provider 写、今日页的
 * 「本周新匹配」读。两边都从这里拿键，避免各写一份字面量后悄悄漂移。
 */
export const EXPLORE_REMOVED_KEY = "career-ops:explore-removed";

/**
 * 读取被移除的 URL 集合。存储缺失、损坏或不可用时一律返回空集合：
 * 移除是显示层提示，读失败不该让页面崩掉。
 *
 * @returns {Set<string>}
 */
export function readRemovedUrls() {
  try {
    const raw = localStorage.getItem(EXPLORE_REMOVED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((u) => typeof u === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * 覆盖写入被移除的 URL 集合。quota/隐私模式等失败静默：本次会话内移除仍生效。
 *
 * @param {Set<string>|string[]} urls
 */
export function writeRemovedUrls(urls) {
  try {
    localStorage.setItem(EXPLORE_REMOVED_KEY, JSON.stringify([...urls]));
  } catch {
    /* localStorage full/unavailable — non-fatal */
  }
}

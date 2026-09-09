// 浏览器扫描每站采集条数上限配置。
//
// 扩展 content script 的采集累积器有硬编码上限 SCAN_MAX=400（extension/scan-pure.js），
// 懒加载平台（BOSS/智联滚动）防无限滚合理；但**分页型平台（猎聘）每页 40 条**，大关键词
// 会撞 400 上限把末页截掉（如技术经理 11 页=440 条，采到第 10 页就 reachedMax 收尾）。
//
// 故本配置按站点分别设置采集上限，默认猎聘 1200（分页有限，多采无妨）、BOSS/智联保持
// 400。值持久化在 localStorage 的 career-ops:config（与 cliId/model/applyBehavior 同处），
// 探索页发起 drive-scan 时逐站读入并随消息传给扩展。
//
// 站点 key 用探索页浏览器源名（explore.ts BrowserSource：zhipin/liepin/zhaopin），与
// buildSearchUrls / expandSearchTargets 同口径，保证驱动消息能一一对上。

/** 三站采集上限默认值。猎聘分页型抬到 1200；BOSS/智联懒加载保持 400 防风控。 */
export const SCAN_MAX_DEFAULT = {
  zhipin: 400,
  liepin: 1200,
  zhaopin: 400,
};

/** 限制站点 key 白名单（给 TS 端用；单测/消歧义引用同一默认对象）。 */
export const SCAN_MAX_SITES = ["zhipin", "liepin", "zhaopin"];

/** 配置值存放的 localStorage 主键（与扫描方式等共享同一个 career-ops:config 对象）。 */
export const SCAN_MAX_KEY = "career-ops:config";

/** 字段名，写入 career-ops:config 对象的属性。 */
export const SCAN_MAX_FIELD = "scanMaxBySource";

/** 数值规整：非法（非正整数）回落站点默认值。 */
export function clampSafe(value, fallback) {
  const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  return n > 0 ? n : fallback;
}

/** 规整整份配置：只保留合法的三站 key，非法值回落该站默认。 */
export function cleanScanMax(value) {
  const obj = value && typeof value === "object" ? value : {};
  const out = {};
  for (const k of Object.keys(SCAN_MAX_DEFAULT)) {
    out[k] = clampSafe(obj[k], SCAN_MAX_DEFAULT[k]);
  }
  return out;
}

/** 读取当前配置的每站采集上限。仅在客户端可用（依赖 localStorage）；SSR 用默认。 */
export function readScanMax() {
  try {
    const raw = localStorage.getItem(SCAN_MAX_KEY);
    const value = raw ? (JSON.parse(raw) || {})[SCAN_MAX_FIELD] : undefined;
    return cleanScanMax(value);
  } catch {
    return { ...SCAN_MAX_DEFAULT };
  }
}

/** 持久化每站采集上限，不影响 career-ops:config 中其它字段。 */
export function persistScanMax(max) {
  try {
    const raw = localStorage.getItem(SCAN_MAX_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(SCAN_MAX_KEY, JSON.stringify({ ...prev, [SCAN_MAX_FIELD]: cleanScanMax(max) }));
  } catch {
    /* quota / private mode */
  }
}
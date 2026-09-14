// 扫描收尾开关（ADR-0007 E9）。
//
// 探索页发起的浏览器扫描（BOSS直聘/猎聘/智联，扩展驱动）会在扫描期间自动打开招聘站
// tab，用户原本会停在那几个 tab 上，而结果渲染在他已经离开的探索页里。开关开启时
// （默认），全部平台跑完后扩展后台把焦点切回探索页 tab。
//
// 只管「切焦点」这一件事：关掉后扫描跑完停在原页面，但「探索页 tab 被关闭 → 中止仍在
// 跑的采集」不受本开关影响（那是省浪费，与用户的展示偏好无关）。
//
// 开关值持久化在 localStorage 的 career-ops:config（与 scanMax/scanSource/cliId 同处），
// 探索页发起 drive-scan 时随消息传给扩展——扩展 content script / service worker 读不到
// localStorage，只能由页面侧读出来带过去。
//
// 导出面刻意与 scan-max.mjs 对齐（同一套五件套：KEY / FIELD / clean / read / persist
// + DEFAULT）——两个开关同住 career-ops:config、由同一批调用方按同一形状读写，形状一致
// 才能一眼看出某个字段归哪个模块、也知道该抄哪个文件改。所以 KEY / FIELD /
// cleanScanWrapUp 当前只有本模块内部使用也不收回导出：它们是这套形状的一部分，
// 不是留着等人调用的预留接口（review 若按 Speculative Generality 报，答案在这里）。

/** 未配置时的默认值：开启（用户点「开始扫描」时期待结果回来）。 */
export const SCAN_WRAPUP_DEFAULT = true;

/** 配置值存放的 localStorage 主键（与 scan-max.mjs / scan-mode.ts 的 CONFIG_KEY 同值）。 */
export const SCAN_WRAPUP_KEY = "career-ops:config";

/** 字段名，写入 career-ops:config 对象的属性。 */
export const SCAN_WRAPUP_FIELD = "scanWrapUp";

/** 规整：只接受真正的布尔，其余（缺失/字符串/1/0）一律回落默认，避免 "false" 被当假。 */
export function cleanScanWrapUp(value) {
  return typeof value === "boolean" ? value : SCAN_WRAPUP_DEFAULT;
}

/** 读取当前配置的收尾开关。仅在客户端可用（依赖 localStorage）；SSR 用默认。 */
export function readScanWrapUp() {
  try {
    const raw = localStorage.getItem(SCAN_WRAPUP_KEY);
    const value = raw ? (JSON.parse(raw) || {})[SCAN_WRAPUP_FIELD] : undefined;
    return cleanScanWrapUp(value);
  } catch {
    return SCAN_WRAPUP_DEFAULT;
  }
}

/** 持久化收尾开关，不影响 career-ops:config 中其它字段。 */
export function persistScanWrapUp(enabled) {
  try {
    const raw = localStorage.getItem(SCAN_WRAPUP_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(SCAN_WRAPUP_KEY, JSON.stringify({ ...prev, [SCAN_WRAPUP_FIELD]: cleanScanWrapUp(enabled) }));
  } catch {
    /* quota / private mode */
  }
}

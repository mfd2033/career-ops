// 探索页「扫描」tab 的扫描方式配置。
//
// 扫描 tab 统一显示各扫描引擎，其内部通过子 tab 选择用哪个引擎跑：
//   - "ats"（老「扫描」tab）：公开 ATS 网络（Greenhouse/Lever/Ashby/Workday），免费、纯 HTTP + JSON；
//   - "bsk"（老「浏览器」tab）：通过用户自己登录的浏览器抓取国内平台（BOSS直聘/猎聘/智联），免费、需 bsk CLI。
//
// 配置项「扫描方式」多选，决定扫描 tab 内可见的子 tab 集合（勾了才显示）。
// 值持久化在 localStorage 的 career-ops:config（与 cliId/model/applyBehavior 同处），
// 缺失或非法值回落到默认 ["bsk"]，保证老用户/SSR 行为一致、无异常。

export type ScanSource = "ats" | "bsk";

/** 可选的扫描方式集合（保持固定顺序，勾选显示顺序稳定）。 */
export const SCAN_SOURCES: ScanSource[] = ["ats", "bsk"];

/** 配置值存放的 localStorage 主键（与 saved-cli.ts/apply-behavior.ts 的 CONFIG_KEY 同值）。 */
export const SCAN_SOURCE_KEY = "career-ops:config";

/** 字段名，写入 career-ops:config 对象的属性。 */
export const SCAN_SOURCE_FIELD = "scanSource";

/** 未配置时的默认扫描方式（多选集合）。默认 BSK —— 老「扫描」(ATS) 非默认。 */
export const SCAN_SOURCE_DEFAULT: ScanSource[] = ["bsk"];

/** 去重并只保留合法的扫描方式；结果至少保留一个（为空则回落默认），保证总有可用的子 tab。 */
export function cleanScanSources(value: unknown): ScanSource[] {
  const out = Array.isArray(value)
    ? Array.from(new Set(value.map((v) => String(v)).filter((v): v is ScanSource => SCAN_SOURCES.includes(v as ScanSource))))
    : [];
  return out.length ? out : [...SCAN_SOURCE_DEFAULT];
}

/**
 * 读取当前配置的扫描方式集合。仅在客户端可用（依赖 localStorage）；
 * SSR 时调用方应在 useEffect 等浏览器阶段调用，或以默认值/加载态兜底。
 */
export function readScanSources(): ScanSource[] {
  try {
    const raw = localStorage.getItem(SCAN_SOURCE_KEY);
    const value = raw ? (JSON.parse(raw) as Record<string, unknown>)[SCAN_SOURCE_FIELD] : undefined;
    return cleanScanSources(value);
  } catch {
    return [...SCAN_SOURCE_DEFAULT];
  }
}

/** 持久化扫描方式集合，不影响 career-ops:config 中其它字段。 */
export function persistScanSources(sources: ScanSource[]) {
  try {
    const raw = localStorage.getItem(SCAN_SOURCE_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(SCAN_SOURCE_KEY, JSON.stringify({ ...prev, [SCAN_SOURCE_FIELD]: cleanScanSources(sources) }));
  } catch {
    /* quota / private mode */
  }
}
// 探索页初始化的一小段纯逻辑：URL 里到底有没有「过滤器参数」？
//
// 判定只认 filtersToParams（explore.ts）能编码的那组 key —— 它们合起来构成
// 「一份完整的可分享搜索」。动作参数不携带任何过滤条件，必须与过滤器参数分开：
// 把 onboarding 交接的 ?run=1 当成「URL 有参数 ⇒ 用 URL」，会让初始 filters 全空，
// 丢掉从用户 portals.yml / profile.yml 播种（seedExploreFilters）的关键词。
// 全空 filters 序列化出的临时 portals.yml 只剩注释 —— js-yaml 视作空文档，
// 核心扫描器 scan-ats-full.mjs 的 yaml.load 抛 "expected a document, but the
// input is empty"，Fatal 退出且没打印 JSON，页面只报
// "The scanner returned no readable output."
//
// 纯函数 + .mjs：web 测试套件（node --test）无法加载 explore.ts，key 集合的
// 漂移守卫测试（tests/lib/explore-params.test.mjs）直接对 explore.ts 源码切片比对。

/** filtersToParams 的编码面 —— 与 explore.ts 的漂移由测试守卫，增删 key 两边一起改。 */
export const FILTER_PARAM_KEYS = Object.freeze([
  "q",
  "not",
  "loc",
  "noloc",
  "hardno",
  "home",
  "since",
  "ats",
  "limit",
]);

/**
 * URL 是否携带过滤器参数（= 一份可解码的完整搜索）。
 *
 * @param {URLSearchParams} sp
 * @returns {boolean}
 */
export function carriesFilterParams(sp) {
  for (const k of FILTER_PARAM_KEYS) if (sp.has(k)) return true;
  return false;
}

/**
 * ?run=1 交接（pipeline 空态 CTA / CV 导入 WOW）落地时，是否自动开跑扫描。
 *
 * 挂钩配置页的「扫描方式」（localStorage career-ops:config.scanSource）：
 *  - 含 "ats" → 自动跑。ATS 扫描无人值守（纯 HTTP），到达即可开跑；
 *  - 纯 "bsk" → 停在探索页的表单上。BSK 采集驱动用户已登录的浏览器，
 *    需要先选关键词/城市，也只会国内平台——自动跑一个用户没配过的扫描
 *    是错误行为（「设置bsk就只跳转」）。
 * 多选时「含 ats 即自动」：重勾会改变集合顺序，不能按顺序取「首选」。
 *
 * 传非数组（未配置/损坏）一律 false（不自动跑）——静默开跑比不跑贵得多。
 *
 * @param {ReadonlyArray<string>|null|undefined} sources 配置的扫描方式集合
 * @returns {boolean}
 */
export function shouldAutoRunOnHandoff(sources) {
  return Array.isArray(sources) && sources.includes("ats");
}

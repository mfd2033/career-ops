// report-status-map.mjs — /api/report-status 的 map 装配（纯函数，接缝 A）。
//
// 扩展在职位详情页加载时一次性拉这份索引，据此判断「这个职位评估过没有、几分、报告
// 号多少、走到哪一步」。装配以前直接躺在 route.ts 的循环里：读文件、拼 key、判首
// 胜出，全跟 Next 的路由处理器绑在一起，没法在 node 里测。抽出来之后路由只剩
// 「取数据 + 发响应」，规则在这里，规则才测得起。
//
// 契约不变量（ADR-0074）：
//   1. 语言不进接口 —— status 放 tracker 的**原始规范值**（`Applied`、`SKIP`…，见
//      templates/states.yml），中文标签由扩展侧字典映射；接口本身永远只有码。
//   2. key 用 normalizeUrl（与 core.js 逐字节一致，url-key.test.mjs 门住），否则
//      扩展看到的职位会被误判成「未评估」。
//   3. 一个 URL 多行时**首个 app 胜出** —— tracker 里每个职位只列一次，重复行不该
//      把先前的评估结果覆盖掉。
//   4. checkupStar 只供展示 —— 体检星不参与评分、过滤或任何门禁（ADR-0064 同一条
//      约束在这个接口上的延伸）；它只是胜出那一行自己的最近一次体检结论，读不到
//      就给 null（null ≠ 0 分）。

/**
 * @typedef {object} StatusEntry
 * @property {string} score           tracker 的分数原文（如 `"4.3/5"`）
 * @property {string} reportNum       tracker 行号 `n`，同时是 /report/{n} 的路由段
 * @property {string} [status]        原始规范状态值；tracker 该行没状态时省略（不放空串）
 * @property {(number|null)} checkupStar 该 tracker 行最近一次公司体检的 star（1.0–5.0）；
 *   无台账 / 读到非数字 → null。键恒定存在，供浮窗「体检」行显示 `推荐 x/5`。
 */

/**
 * 装配 evaluated map。
 *
 * @param {Array<object>} apps                 tracker 行（readApplications() 的形状）
 * @param {object} [deps]
 * @param {(app: any) => (string|undefined)} [deps.urlOf]        取职位 URL；默认取
 *   `app.url`，路由侧传 readApplicationUrl（从报告头 `**URL:**` 读，那里才是被评估的
 *   那个 URL）
 * @param {(app: any) =>*} [deps.checkupOf]   取本行最近一次体检 star；默认读
 *   `app.checkupStar`（路由侧由 withCheckupStars 预先 join 好，join 口径就是
 *   checkupIndex 的「日期最近」）。缺这个依赖时退化成 null，不抛错 —— 体检行是
 *   锦上添花，不该把整个状态接口拖下马。
 * @param {(raw: string) => string} [deps.normalizeUrl]           归一 key
 * @returns {Record<string, StatusEntry>}
 */
export function buildReportStatusMap(apps, deps = {}) {
  const { urlOf = (app) => app.url, checkupOf = (app) => app.checkupStar, normalizeUrl } = deps;
  if (typeof normalizeUrl !== "function") throw new TypeError("buildReportStatusMap 需要 normalizeUrl");
  const out = {};
  for (const app of apps || []) {
    const url = urlOf(app);
    if (!url) continue;
    const key = normalizeUrl(url);
    if (!key || key in out) continue; // 首个 app 胜出
    // 体检星只在真的是「大于 0 的有限数」时进契约。两个坑：
    //   • Number(null) 是 0 —— 直接 Number() 会把「没体检」伪装成「体检 0 分」；
    //   • 台账写入口（lib/log-checkup.mjs）的合法值域是 1.0–5.0，所以 ≤ 0 / NaN /
    //     非数字都是坏数据，统一退 null（展示上等价于「未体检」），不拿它当信号。
    const star = Number(checkupOf(app));
    const checkupStar = Number.isFinite(star) && star > 0 ? star : null;
    /** @type {StatusEntry} */
    const entry = {
      score: app.score,
      reportNum: app.n,
      checkupStar,
    };
    // 只透传原始码：tracker 行可能写着别名或带空格，trim 后非空才进契约。
    const raw = typeof app.status === "string" ? app.status.trim() : "";
    if (raw) entry.status = raw;
    out[key] = entry;
  }
  return out;
}

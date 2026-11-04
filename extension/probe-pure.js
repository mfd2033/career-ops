// probe-pure.js — 本地 web 服务端口探测的纯判定层（ADR-0002 D3 / ADR-0063 修订三）。
//
// 端口自 ADR-0063 起固定为 3000，探测口径随之从「区间里谁的 200 先回来」改成
// 「3000 优先，不通再放宽到备选区间」。备选区间不再是「端口会漂」的遗产，只剩一个
// 用途：本 fork 的 dev 入口 `node local/dev-web.mjs -p 3101`（3000 上通常跑着托盘壳，
// 见 AGENTS.md）。收窄成只探 3000 会让 dev 实例对扩展彻底不可见，故保留区间作兜底。
//
// 抽成纯函数的三件事（同 badge-pure.js 口径）：
//   • classifyProbe —— 一次 /api/version 的原始结果 → 归一形状（ok / kind / ms）；
//   • decideProbe   —— 3000 主探 + 备选区间 + 二次复探 → 命中端口与失败原因；
//   • diagOf        —— 逐端口结果 → popup 诊断框里的扁平表。
//
// background.js 以经典 service worker 方式 importScripts 本文件，经
// self.__careerOpsProbePure 取用；node 单测以 module.exports 守卫直接 import。
// 本文件严禁引用 chrome/window/document/fetch —— 只做判定，不发请求。

(function () {
  "use strict";

  // 固定端口（ADR-0063 决策 1：绝不回退）。
  const PRIMARY_PORT = 3000;
  // 备选区间：只为 dev 实例留着，不是扫描区间遗产。
  const ALT_PORT_MIN = 3001;
  const ALT_PORT_MAX = 3040;

  // 3000 主探的预算。3s 是 ADR-0050 时代的取值，那时唯一的慢因是 Chromium 对环回
  // 地址的首次连接预热（~0.6-1.2s）；现在真正的慢因是 web 端单线程事件循环被
  // /api/tracker 一类重路由占住（并发实测 /api/version 会涨到 0.2-1.5s，重活叠加时
  // 更长）。探的是本地版本端点，慢的原因只可能是服务忙，不是网络差，给足 6s。
  const PROBE_TIMEOUT_MS = 6000;
  // 备选区间短扫：40 个口并发，没人的口立刻拒连，1.5s 足够。
  const ALT_PROBE_TIMEOUT_MS = 1500;
  // 二次复探（只复探 3000）：第一次已经付过预热代价，不必再给满 6s。
  const RETRY_TIMEOUT_MS = 4000;

  /** 备选区间的端口列表（3001-3040，含两端）。 */
  function altPorts() {
    const out = [];
    for (let port = ALT_PORT_MIN; port <= ALT_PORT_MAX; port++) out.push(port);
    return out;
  }

  /**
   * 把一次 /api/version 探测归一成可判定、可诊断的形状。
   *
   * kind 的取值是闭集，popup 与诊断框全靠它区分「服务忙」与「没起服务」：
   *   ok       —— 200 且带合法 version（严格版本校验，避免误连别的本地服务）
   *   timeout  —— 到点仍未答复（服务进程在，事件循环被占住）
   *   refused  —— 连接被拒 / 被拦 / CORS，立刻失败（端口上没人听）
   *   http     —— 答复了但不是 2xx
   *   invalid  —— 2xx 但没有 version 字段（端口上是别的服务）
   *
   * @param {{ms?:number, timedOut?:boolean, error?:?string, status?:number, body?:?object}} raw
   * @returns {{ok:boolean, kind:string, ms:number, status?:number, version?:string, detail?:string}}
   */
  function classifyProbe({ ms = 0, timedOut = false, error = null, status = 0, body = null } = {}) {
    if (timedOut) return { ok: false, kind: "timeout", ms };
    if (error) return { ok: false, kind: "refused", ms, detail: String(error) };
    if (!status || status < 200 || status >= 300) return { ok: false, kind: "http", ms, status };
    const version = body && typeof body === "object" ? body.version : null;
    if (!version) return { ok: false, kind: "invalid", ms };
    return { ok: true, kind: "ok", ms, version: String(version) };
  }

  /** 逐端口结果 → 一句人话（诊断框用）。 */
  function brief(outcome) {
    const status = outcome.kind === "http" && outcome.status ? `(${outcome.status})` : "";
    const ms = typeof outcome.ms === "number" ? `${outcome.ms}ms` : "";
    return [outcome.kind + status, ms].filter(Boolean).join(" ");
  }

  /**
   * 依「3000 优先 → 备选区间 → 3000 二次复探」的顺序决定命中端口。
   *
   * @param {{primary?:?object, alt?:object[], retry?:?object}} p 三段的 probeOutcome
   * @returns {{port:?number, reason:?string, source:?string}}
   *   port=null 时 reason 是**主端口**的 kind（用户关心的是 3000 为什么不通，
   *   3001-3040 那 40 个口的结果只进诊断表）。
   */
  function decideProbe({ primary = null, alt = [], retry = null } = {}) {
    if (primary && primary.ok) return { port: PRIMARY_PORT, reason: null, source: "primary" };
    const hit = alt.find((o) => o && o.ok);
    if (hit) return { port: hit.port, reason: null, source: "alt" };
    if (retry && retry.ok) return { port: PRIMARY_PORT, reason: null, source: "retry" };
    return { port: null, reason: reasonOf(primary, retry), source: null };
  }

  /** 没命中时的失败原因：复探是最后一次事实，优先采信它。 */
  function reasonOf(primary, retry) {
    if (retry && retry.kind) return retry.kind;
    if (primary && primary.kind) return primary.kind;
    return "unknown";
  }

  /**
   * 逐端口结果 → 诊断框用的扁平表。刻意不把 40 个 refused 全列出来（那是噪声），
   * 只留一个计数；非 refused 的口逐个列（那些才是线索）。
   */
  function diagOf({ primary = null, alt = [], retry = null } = {}) {
    const table = {};
    if (primary) table[String(PRIMARY_PORT)] = brief(primary);
    if (retry) table[`${PRIMARY_PORT}@retry`] = brief(retry);
    let refused = 0;
    for (const o of alt) {
      if (!o) continue;
      if (o.kind === "refused") {
        refused += 1;
        continue;
      }
      table[String(o.port)] = brief(o);
    }
    if (refused) table.altRefused = refused;
    return table;
  }

  const api = {
    PRIMARY_PORT,
    ALT_PORT_MIN,
    ALT_PORT_MAX,
    PROBE_TIMEOUT_MS,
    ALT_PROBE_TIMEOUT_MS,
    RETRY_TIMEOUT_MS,
    altPorts,
    brief,
    classifyProbe,
    decideProbe,
    diagOf,
  };

  // service worker（经典脚本，background.js 经 importScripts 引入）：挂 self。
  if (typeof self !== "undefined" && self && !self.__careerOpsProbePure) {
    self.__careerOpsProbePure = api;
  }
  // node 单测：module.exports 守卫（同 badge-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

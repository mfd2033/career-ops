// scan-pure.js — 扩展 scan mode 的纯逻辑层（ADR-0007 E5/E7）。
//
// 承载三类可脱离 DOM 单测的逻辑:
//   • createScanAccumulator —— 本页已采 URL Set 增量去重 + 分批切分(50条/批);
//   • toDiscoveredOffer   —— cardMeta → web /api/explore/add 的 DiscoveredOffer 契约;
//   • defaultNormalizeKey —— 未注入 core.normalizeUrl 时的去重键回退(仅 strip 常见
//                             跟踪参数哈希/协议/大小写,保持纯净可测)。
//
// core.js 在 manifest 的 js 数组里置于本文件之后,通过 window.__careerScanPure 复用;
// node 单测以 module.exports 守卫直接 import(与 site-*.js 同口径)。本文件严禁引用
// window/document/chrome/location 之外的运行态 —— 加载即崩。

(function () {
  "use strict";

  // 上限 / 批大小 — 与 ADR-0007 E7(400)、E5(50条/批) 对齐;核心以常量引用,避免魔数漂移。
  const SCAN_MAX = 400;
  const SCAN_BATCH_SIZE = 50;

  /**
   * 回退去重键:注入 normalizeKey 前的轻量归一。core 传入其站点级 normalizeUrl
   * (带 extraTrackingParams 全量 strip);node 单测直接用本回退。
   */
  function defaultNormalizeKey(url) {
    if (typeof url !== "string") return "";
    const s = url.trim();
    if (!s) return "";
    let u;
    try {
      u = new URL(s);
    } catch {
      return "";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    return u.toString();
  }

  /**
   * 采集累积器:同一归一 URL 只进一次(绝不重报已采),新卡 {key, meta} 挂 pending,
   * 由 flush(batchSize) 切成小批返回。count = seen.size = 本页已采唯一职位数。
   */
  function createScanAccumulator({ normalizeKey = defaultNormalizeKey, maxCount = SCAN_MAX } = {}) {
    const seen = new Set();
    let pending = [];

    return {
      /**
       * 尝试收录一条卡片元数据。URL 空 / 已采则 {added:false}(不重复进池)。
       */
      add(meta) {
        const url = meta && typeof meta.url === "string" ? meta.url.trim() : "";
        const key = url ? normalizeKey(url) : "";
        if (!key || seen.has(key)) return { added: false, key: key || "" };
        seen.add(key);
        pending.push({ key, meta });
        return { added: true, key, count: seen.size };
      },
      /**
       * 切出最多 batchSize 条(默认 50)返回,其余留待下次。返回 {batch, flushed, remaining}。
       */
      flush(batchSize) {
        const take = typeof batchSize === "number" && batchSize > 0 ? batchSize : SCAN_BATCH_SIZE;
        const batch = pending.slice(0, take);
        pending = pending.slice(take);
        return { batch, flushed: batch.length, remaining: pending.length };
      },
      get seenSize() {
        return seen.size;
      },
      get count() {
        return seen.size;
      },
      get pendingCount() {
        return pending.length;
      },
      get reachedMax() {
        return seen.size >= maxCount;
      },
    };
  }

  /**
   * cardMeta → DiscoveredOffer(web /api/explore/add 入参契约)。缺省字段空串;
   * city 进 location,note 按是否带城市拼"browser · {platform} · {city}"。
   */
  function toDiscoveredOffer(meta, platform) {
    const p = typeof platform === "string" && platform ? platform : "browser";
    const city = meta && typeof meta.city === "string" && meta.city.trim() ? meta.city.trim() : "";
    return {
      url: meta && typeof meta.url === "string" ? meta.url : "",
      company: (meta && meta.company) || "",
      title: (meta && meta.title) || "",
      location: city,
      postedAt: "",
      ats: "browser",
      source: `browser-${p}`,
      note: city ? `browser · ${p} · ${city}` : `browser · ${p}`,
    };
  }

  const api = { SCAN_MAX, SCAN_BATCH_SIZE, defaultNormalizeKey, createScanAccumulator, toDiscoveredOffer };

  // 浏览器:暴露给 core.js(core 在 manifest js 数组里位于本文件之后)。
  if (typeof window !== "undefined" && window && !window.__careerScanPure) {
    window.__careerScanPure = api;
  }
  // node 单测:module.exports 守卫(同 site-*.js 口径)。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();
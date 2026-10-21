/**
 * market-modes.mjs — `language.modes_dir` 解析：给定 profile.yml 里写的模式目录，
 * 找出该模式集的「评估模式文件」与对应的 `_shared.md`。
 *
 * 为什么需要映射而不是猜：每个语言目录的评估文件名是本地化的，没有统一规律 ——
 * de 是 `angebot.md`、fr 是 `offre.md`、ja 是 `kyujin.md`、zh 是 `oferta.md`。
 * 目录里同时还有 `apply.md`/`pipeline.md`/`_shared.md`，靠「排除法」无法唯一确定评估文件，
 * 所以这里用一张显式表；表里没有的目录一律回落根版 `modes/oferta.md`，绝不猜。
 *
 * 纯函数、零 fs：目录是否存在由调用方（career-ops.ts）扫盘后传入 `available`，
 * 这样单测不需要造目录。
 */

/** 目录 → 该目录下的评估模式文件（上游 v1.27.0 起未变过的命名）。 */
export const MARKET_EVAL_FILES = Object.freeze({
  ar: "fursah.md",
  da: "oferta.md",
  de: "angebot.md",
  es: "oferta.md",
  fr: "offre.md",
  hi: "naukri.md",
  id: "lowongan.md",
  it: "annuncio.md",
  ja: "kyujin.md",
  ko: "gonggo.md",
  nl: "vacature.md",
  pl: "oferta.md",
  pt: "oferta.md",
  ru: "oferta.md",
  tr: "is-ilani.md",
  ua: "oferta.md",
  zh: "oferta.md",
  "zh-TW": "oferta.md",
});

/** 根版评估模式文件 —— 任何解析失败都回落到它。 */
export const ROOT_EVAL_FILE = "modes/oferta.md";

const DIR_RE = /^modes\/([A-Za-z]{2}(?:-[A-Za-z]{2})?)$/;

/**
 * 把 profile.yml 里的原始值规范成目录 slug（`zh` / `zh-TW`），非法返回 null。
 * 只接受 `modes/<两字母>` 或 `modes/<两字母>-<两字母>`，堵住 `..` 与绝对路径。
 *
 * @param {unknown} raw
 * @returns {string|null} 目录 slug（不含 `modes/`），或 null
 */
export function normalizeModesDir(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (!trimmed) return null;
  const m = trimmed.match(DIR_RE);
  return m ? m[1] : null;
}

/**
 * 解析 `language.modes_dir` 到实际要读的评估文件。
 *
 * 回落顺序：值非法 → 目录不在 `available` 里 → 目录没有映射条目 → 全部回落到根版，
 * 每次回落都带一条可读 `warning`（调用方负责写进运行账本，绝不静默）。
 *
 * @param {{ raw?: unknown, available?: Iterable<string> }} args
 *   raw = profile.yml 里的原值；available = 实际存在的模式目录 slug 集合（不含 `modes/`）
 * @returns {{ dir: string|null, evalFile: string, sharedFile: string, warning: string|null }}
 */
export function resolveMarketMode({ raw, available } = {}) {
  const fallback = {
    dir: null,
    evalFile: ROOT_EVAL_FILE,
    sharedFile: "modes/_shared.md",
    warning: null,
  };
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;

  const slug = normalizeModesDir(raw);
  if (!slug) {
    return { ...fallback, warning: `language.modes_dir "${String(raw).trim()}" 不合法（应为 modes/<语言代码>），已回落通用模式` };
  }
  const known = new Set([...(available ?? [])].map((d) => String(d)));
  if (!known.has(slug)) {
    return { ...fallback, warning: `language.modes_dir 指向的 modes/${slug} 不存在或不是模式集，已回落通用模式` };
  }
  const evalName = MARKET_EVAL_FILES[slug];
  if (!evalName) {
    return { ...fallback, warning: `modes/${slug} 没有登记的评估模式文件，已回落通用模式` };
  }
  return {
    dir: `modes/${slug}`,
    evalFile: `modes/${slug}/${evalName}`,
    sharedFile: `modes/${slug}/_shared.md`,
    warning: null,
  };
}

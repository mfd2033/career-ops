// Company identity helpers — PURE, client-safe (no node imports).
//
// 公司标以前靠「按名字猜域名 + 抓 favicon」：一张 100 行的 curated 域名表加上
// slug+.com 兜底。fork-local（2026-11-12）之后 /api/logo 不再外呼、只读本地缓存，
// 猜域名这条路整体下线（连同 DOMAIN_OVERRIDES 一并删除）—— 中文雇主名本来也猜不出
// ASCII 域名。留下来的只有两件不依赖网络的事：字母组合（initials）与确定性色相，
// 二者共同构成离线可用的 monogram 兜底。

const LEGAL_SUFFIX = /\b(inc|llc|ltd|limited|gmbh|co|corp|corporation|sa|s\.a|ag|plc|sl|s\.l|bv|oy|ab|company|group|holdings|technologies|technology|labs|systems)\b/gi;

/** 1–2 uppercase initials for the monogram fallback. */
export function companyInitials(name: string | undefined | null): string {
  if (!name) return "?";
  const words = name
    .replace(LEGAL_SUFFIX, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return name.trim().slice(0, 1).toUpperCase() || "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic hue (0–359) from the name, so a company is always one color. */
export function monogramHue(name: string | undefined | null): number {
  const s = (name ?? "").trim().toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

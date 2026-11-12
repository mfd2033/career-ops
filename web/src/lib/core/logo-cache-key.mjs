import { createHash } from "node:crypto";

// Cache identity for company logos (see app/api/logo/route.ts).
//
// fork-local 决策（2026-11-12）：路由不再向任何第三方抓取 favicon，只读磁盘缓存。
// 起因是原实现把「网络失败」与「这家公司确实没有 favicon」写成同一个 0 字节哨兵，
// 而哨兵永不重试 —— 本机到 Google favicon 服务不通时，45 个缓存 key 里 40 个在几秒内
// 被永久写死，网络恢复也不会再看一眼。既然只读缓存，缓存 key 的稳定性就成了唯一正确性
// 来源，因此下面三条约束仍然成立，且都由测试（tests/lib/logo-resolve.test.mjs）兜住：
//
//  1. 同一品牌的写法差异（"Acme, Inc." / "acme inc"）必须折叠成同一个 key；
//  2. 两家不同公司绝不能共用一个 key（否则一家永久顶着另一家的 logo）；
//  3. key 必须是文件系统安全的相对文件名，绝不能逃出缓存目录。

/** Cache key for a company name, or null if the name carries nothing to key on.
 *
 *  Normalizing before hashing is deliberate: "Acme, Inc." and "acme inc" are one
 *  brand and should share one cached favicon across every card, this search and
 *  every future one. The digest is taken over the full normalized name so that
 *  truncating the readable prefix to 40 characters — which keeps cache files
 *  greppable by eye — cannot merge two long legal entity names into one entry. */
export function companyCacheKey(company) {
  const normalized = String(company ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return `co_${COMPANY_KEY_VERSION}_${normalized.slice(0, 40)}_${digest}`;
}

/** Bump whenever `companyCacheKey` changes how it normalizes or digests a name.
 *  The version is part of every key, so bumping it makes entries written by the
 *  previous key function unreachable (an old key can never be re-derived).
 *  v2: curated brand domains preceded slug guesses (resolver era). */
export const COMPANY_KEY_VERSION = "v2";

/** 一个「域名」得像个域名：点分标签，每段不以连字符开头/结尾，TLD 至少两位。
 *  比「含点即可」更严 —— `-.com`、`notion..so` 这类畸形输入必须停在 400，
 *  否则它们会变成一次磁盘查找（甚至写进缓存目录）。 */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^(?:${LABEL}\\.)+[a-z]{2,63}$`, "i");

/**
 * 把 /api/logo 的查询参数解析成缓存 key（纯函数，路由只负责读文件）。
 *
 * 返回四种结果，语义互不相同，混用就是原实现那次的 bug：
 *   - `ok`         找到了可查的 key，路由去磁盘找图；
 *   - `bad-domain` 客户端传了畸形 domain（400，不该变成一次磁盘查找）；
 *   - `not-found`  参数合法但必然没有 logo（纯 CJK 公司名等），404 + 可缓存；
 *   - `bad-request` 两个参数都没给（400）。
 *
 * @param {{ domain?: string | null, company?: string | null }} params
 */
export function resolveLogoKey({ domain, company } = {}) {
  const d = String(domain ?? "").trim().toLowerCase();
  const c = String(company ?? "").trim();

  // domain 优先：它是调用方的精确意图，company 只是名字猜测。
  if (d) {
    if (!DOMAIN_RE.test(d) || d.includes("..")) return { status: "bad-domain" };
    return { status: "ok", key: d.replace(/[^a-z0-9.-]/g, "_") };
  }
  if (!c) return { status: "bad-request" };

  const key = companyCacheKey(c);
  // 纯 CJK 名字没有任何 ASCII 可 key —— 必然 miss，不是客户端错误。
  if (!key) return { status: "not-found" };
  return { status: "ok", key };
}

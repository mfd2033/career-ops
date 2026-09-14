import { NextRequest } from "next/server";
import path from "node:path";
import { recordSeenOffers, loadSeenUrlKeys } from "@/lib/core/pipeline";
import { partitionNewOffers, loadScanMap, saveScanMap, scanIdempotencyPath } from "@/lib/scan-idempotency.mjs";
import { careerOpsRoot } from "@/lib/career-ops";
import { normalizeUrl } from "@/lib/core/url-key.mjs";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 采集记「见过」（ADR-0021）：扩展 content script 分批上报的卡片只写
// data/scan-history.tsv（first_seen = 发现日期），**绝不碰 pipeline.md** ——
// 「扫描 ≠ 加入管道」，入管是用户在探索页结果区显式确认后的另一个动作
// （POST /api/explore/add）。
//
// 幂等（ADR-0007 E5 第二层 + ADR-0021 命名空间）：按 (seen:<scanId>, 归一URL)
// 去重，防前端连点/重放重复写台账；与确认入管的 `add:<scanId>` 共表但互不可见。
// 另有一道内容级闸：URL 已在 scan-history 里（此前任何路径记过）→ 视为已见过，
// 直接跳过 —— appendToScanHistory 不去重，靠这里挡跨扫描的重复台账行。
export async function POST(req: NextRequest) {
  let offers: DiscoveredOffer[] = [];
  let scanId = "";
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[]; scanId?: string };
    offers = Array.isArray(body.offers) ? body.offers : [];
    scanId = typeof body.scanId === "string" ? body.scanId.trim() : "";
  } catch {
    return Response.json({ seen: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length === 0) return Response.json({ seen: 0 });

  const idemPath = scanIdempotencyPath(path.join(careerOpsRoot(), "data"));
  const map = loadScanMap(idemPath);
  const ns = scanId ? `seen:${scanId}` : "";
  const { newOffers, skipped, keysToAdd } = partitionNewOffers(map, ns, offers);

  // 内容级闸：台账里已有的 URL 不重记（规范键比对）。
  const seenKeys = loadSeenUrlKeys();
  const fresh = newOffers.filter((o) => {
    const k = normalizeUrl(o.url);
    return !k || !seenKeys.has(k);
  });
  const alreadySeen = newOffers.length - fresh.length;

  if (fresh.length === 0) {
    if (ns && keysToAdd.length) {
      if (!map.has(ns)) map.set(ns, new Set());
      for (const k of keysToAdd) map.get(ns)!.add(k);
      saveScanMap(idemPath, map);
    }
    return Response.json({ seen: 0, skipped: skipped + alreadySeen, idempotent: true });
  }

  const result = await recordSeenOffers(fresh);
  if (result.error) return Response.json({ seen: 0, error: result.error });
  if (ns) {
    if (!map.has(ns)) map.set(ns, new Set());
    for (const k of keysToAdd) map.get(ns)!.add(k);
    saveScanMap(idemPath, map);
  }
  return Response.json({ seen: result.added ?? fresh.length, skipped: skipped + alreadySeen });
}

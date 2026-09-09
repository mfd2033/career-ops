import { NextRequest } from "next/server";
import path from "node:path";
import { addOffersToPipeline } from "@/lib/core/pipeline";
import { partitionNewOffers, loadScanMap, saveScanMap, scanIdempotencyPath } from "@/lib/scan-idempotency.mjs";
import { careerOpsRoot } from "@/lib/career-ops";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Free + reversible: append chosen discovered offers to data/pipeline.md AND
// record them in data/scan-history.tsv, via the core's CANONICAL exported writers
// (no parallel writer). No tokens spent.
//
// Per-scan idempotency (ADR-0007 E5 layer 2): pipeline/scan-history don't dedup,
// so the route must. A repeating POST with the same scanId cannot double-write the
// same normalized posting URL — the content script already only sends each URL once
// per page (inner URL Set), and this guard catches the front-end's re-start/replay.
export async function POST(req: NextRequest) {
  let offers: DiscoveredOffer[] = [];
  let scanId = "";
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[]; scanId?: string };
    offers = Array.isArray(body.offers) ? body.offers : [];
    scanId = typeof body.scanId === "string" ? body.scanId.trim() : "";
  } catch {
    return Response.json({ added: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length === 0) return Response.json({ added: 0 });

  // 无 scanId → 原路径,不做幂等(每次全写)。有 scanId → 按 (scanId, 归一URL) 去重:
  // 已写过的 URL 跳过,只写新增;写成功才记录键,下次同键重放即幂等返回。
  if (scanId) {
    const idemPath = scanIdempotencyPath(path.join(careerOpsRoot(), "data"));
    const map = loadScanMap(idemPath);
    const { newOffers, skipped, keysToAdd } = partitionNewOffers(map, scanId, offers);
    if (newOffers.length === 0) {
      // 全是已采/无效 → 幂等命中,不触碰 pipeline/scan-history。
      return Response.json({ added: 0, skipped, idempotent: true });
    }
    const result = await addOffersToPipeline(newOffers);
    if (result.error) return Response.json(result);
    if (!map.has(scanId)) map.set(scanId, new Set());
    for (const k of keysToAdd) map.get(scanId).add(k);
    saveScanMap(idemPath, map);
    return Response.json({ added: result.added ?? newOffers.length, skipped, idempotent: true });
  }

  const result = await addOffersToPipeline(offers);
  return Response.json(result);
}
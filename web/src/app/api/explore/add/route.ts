import { NextRequest } from "next/server";
import path from "node:path";
import { addOffersToPipeline, loadSeenUrlKeys } from "@/lib/core/pipeline";
import { partitionNewOffers, loadScanMap, saveScanMap, scanIdempotencyPath } from "@/lib/scan-idempotency.mjs";
import { careerOpsRoot } from "@/lib/career-ops";
import { normalizeUrl } from "@/lib/core/url-key.mjs";
import type { DiscoveredOffer } from "@/lib/explore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 确认入管（ADR-0021）：把用户在探索页结果区**显式选中**的 offer 写进 pipeline.md。
// 自 ADR-0021 起，扩展采集阶段只写「见过」台账（/api/explore/seen），本路由是
// pipeline.md 的唯一写入口 —— 「扫描 ≠ 加入管道」。
//
// 已见过 / 全新 的切分：确认的 offer 若已在见过台账（扩展路径必然如此），只补
// pipeline.md —— appendToScanHistory 不去重，重写就是重复台账行；不在的（bsk 兜底
// 路径的发现，采集时未记台账）两个都写，保持 bsk 路径「确认即记录发现」的旧行为。
//
// 幂等（ADR-0007 E5 第二层 + ADR-0021 命名空间）：`add:<scanId>` 防同一确认重放；
// 与 `seen:<scanId>` 共用 data/scan-idempotency.tsv 但互不可见。
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

  const idemPath = scanIdempotencyPath(path.join(careerOpsRoot(), "data"));
  const map = loadScanMap(idemPath);
  const ns = scanId ? `add:${scanId}` : "";
  const { newOffers, skipped, keysToAdd } = partitionNewOffers(map, ns, offers);
  if (newOffers.length === 0) {
    return Response.json({ added: 0, skipped, idempotent: true });
  }

  // 已见过 → 只补 pipeline；全新 → pipeline + 台账。
  const seenKeys = loadSeenUrlKeys();
  const inLedger = (o: DiscoveredOffer) => {
    const k = normalizeUrl(o.url);
    return !!k && seenKeys.has(k);
  };
  const seen = newOffers.filter(inLedger);
  const unseen = newOffers.filter((o) => !inLedger(o));

  let added = 0;
  let error: string | undefined;
  if (seen.length > 0) {
    const r = await addOffersToPipeline(seen, { skipScanHistory: true });
    added += r.added;
    error = r.error;
  }
  if (!error && unseen.length > 0) {
    const r = await addOffersToPipeline(unseen);
    added += r.added;
    error = error || r.error;
  }
  if (error) return Response.json({ added, error });

  if (ns && keysToAdd.length) {
    if (!map.has(ns)) map.set(ns, new Set());
    for (const k of keysToAdd) map.get(ns)!.add(k);
    saveScanMap(idemPath, map);
  }
  return Response.json({ added, skipped });
}

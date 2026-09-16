import { NextRequest } from "next/server";
import path from "node:path";
import { recordSeenOffers, loadSeenUrlKeys, type SeenStatus } from "@/lib/core/pipeline";
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
//
// `status: "skipped_title"`（ADR-0029 决议 4）走同一条写入，但语义相反：它不是
// 一次「发现」，而是「发现过、且被采集门毙掉」。所以两处都要与 added 分开——
// 见下方 fresh 的那道闸与 ns 的推导。
export async function POST(req: NextRequest) {
  let offers: DiscoveredOffer[] = [];
  let scanId = "";
  let status: SeenStatus = "added";
  try {
    const body = (await req.json()) as { offers?: DiscoveredOffer[]; scanId?: string; status?: string };
    offers = Array.isArray(body.offers) ? body.offers : [];
    scanId = typeof body.scanId === "string" ? body.scanId.trim() : "";
    // 只认闭集里的另一个取值；其余一律按 added（status 列被去重、whats-new 与
    // recheck/cooldown 消费，塞进无人认识的取值只会让它们静默失准）。
    if (body.status === "skipped_title") status = "skipped_title";
  } catch {
    return Response.json({ seen: 0, error: "bad request" }, { status: 400 });
  }
  if (offers.length === 0) return Response.json({ seen: 0 });

  const idemPath = scanIdempotencyPath(path.join(careerOpsRoot(), "data"));
  const map = loadScanMap(idemPath);
  // 命名空间不能复用 seen:<scanId>：扩展采集时已把同一批 URL 记进那个命名空间，
  // 复用会让「被过滤」这批整批被判为重复而一条不写。也不能叫 seen:… 的子键——
  // scan-progress 按 `seen:` 前缀统计本次采集条数，会把它算进去。故另起
  // `filtered:` 前缀，与 add:/seen: 同表不同空间。
  const ns = scanId ? (status === "skipped_title" ? `filtered:${scanId}` : `seen:${scanId}`) : "";
  const { newOffers, skipped, keysToAdd } = partitionNewOffers(map, ns, offers);

  // 内容级闸：台账里已有的 URL 不重记（规范键比对）。**只对 added 生效** ——
  // skipped_title 是关于同一 URL 的另一条事实（「见过，且被采集门毙掉」），不是
  // 重复行：扩展路径在采集时就已写掉 added，若在这里一并跳过，「被过滤」这件事
  // 永远不落台账，ADR-0029 决议 4 的那扇窗就白留了。
  const seenKeys = loadSeenUrlKeys();
  const fresh = status === "skipped_title"
    ? newOffers
    : newOffers.filter((o) => {
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

  const result = await recordSeenOffers(fresh, status);
  if (result.error) return Response.json({ seen: 0, error: result.error });
  if (ns) {
    if (!map.has(ns)) map.set(ns, new Set());
    for (const k of keysToAdd) map.get(ns)!.add(k);
    saveScanMap(idemPath, map);
  }
  return Response.json({ seen: result.added ?? fresh.length, skipped: skipped + alreadySeen });
}

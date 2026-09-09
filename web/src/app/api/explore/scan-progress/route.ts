import { NextRequest } from "next/server";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { loadScanMap, scanIdempotencyPath } from "@/lib/scan-idempotency.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 扩展驱动采集的进度信号(ADR-0007 E5/E14 修正实现)。
//
// ADR 原案是"前端 2s 轮询 whats-new 对比新增数作进度",但 whats-new 会剔除
// 已在 pipeline 的 offer(经 /api/explore/add 写入即 pending → 被 #pipeline-leak
// 维过滤),逐个新采集的职位根本不会在 whats-new 出现 → 字面轮询永远显示 0。
// 故改用真正反映"本 scanId 已采到几条"的权威信号 —— 路由幂等表
// data/scan-idempotency.tsv(scanId → 已写 URL 集合,/api/explore/add 每次成功写
// 一批就 +N)。读取它给前端按 scanId 查已采集条数,温和轮询(2s)。
//
// 采集"是否收尾"由前端另用扩展 SW 的 scan-status(active 平台列表为空即全收尾)
// 判定;本条只管条数。
export async function GET(req: NextRequest) {
  const scanId = req.nextUrl.searchParams.get("scanId")?.trim() ?? "";
  if (!scanId) return Response.json({ collected: 0 });

  const map = loadScanMap(scanIdempotencyPath(path.join(careerOpsRoot(), "data")));
  const keys = map.get(scanId);
  return Response.json({ collected: keys ? keys.size : 0 });
}
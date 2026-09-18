// ADR-0042 决议 6：批量逐项状态的读取端。批量路由把 item 事件同步写入进程内
// 登记表（web/src/lib/batch-items.mjs）；详情页在其他页签打开、或本页签的流式
// 累积丢失时，凭 open 事件下发的 batchId 拉一次恢复清单，之后仍靠事件流增量。
//
// 生命周期与批量 run 一致：进程重启即清；未知/已淘汰的 batchId 返回 404——与
// 空清单区分，前端据此显示「查不到」而非「零结果」。
import { NextResponse } from "next/server";
import { getBatchItems } from "@/lib/batch-items.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const batchId = new URL(req.url).searchParams.get("batchId")?.trim() ?? "";
  if (!batchId) {
    return NextResponse.json({ error: "batchId required" }, { status: 400 });
  }
  const items = getBatchItems(batchId);
  if (items === null) {
    return NextResponse.json({ error: "unknown batchId (expired or never registered)" }, { status: 404 });
  }
  return NextResponse.json({ batchId, items });
}

import { readCadencePayload } from "@/lib/followups-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The DEMAND loop: surface follow-ups due, via the core's own
// followup-cadence.mjs --json (the SAME calculator the CLI uses) — we never
// reimplement the cadence logic, we read its verdict (mirrors /api/doctor).
// Default: capped list for the home card. `?full=1`: the complete cadence
// (entries + metadata + cadenceConfig) for the /followups tracker page.
export async function GET(req: Request) {
  const full = new URL(req.url).searchParams.get("full") === "1";
  // 读取（spawn + 解析 + fail-closed）的唯一实现在 followups-server.ts
  // （ADR-0075 决议 7）：报告页的「记录跟进」入口读的就是这一份判定。
  const payload = await readCadencePayload();
  if (!payload.available) return Response.json({ available: false, metadata: null, entries: [] });
  try {
    if (full) {
      return Response.json({
        available: true,
        metadata: payload.metadata,
        entries: payload.entries,
        cadenceConfig: payload.cadenceConfig ?? null,
      });
    }
    // Overdue first; cap for the home (full list lives in /followups).
    // Check BOTH fields — not urgency-with-status-fallback — so output where
    // either one signals overdue/urgent lands in the priority bucket.
    // Important: return empty when no overdue/urgent — do NOT fall back to
    // all active entries, otherwise waiting/cold items leak into the home
    // "follow-ups due" section after the user has already followed up.
    const overdue = payload.entries.filter((e) => /overdue|urgent/i.test(`${e.urgency ?? ""} ${e.status ?? ""}`)).slice(0, 8);
    return Response.json({ available: true, metadata: payload.metadata, entries: overdue });
  } catch {
    // 组装期异常一律 fail-closed 成 available:false（与工单 01 之前的整体
    // try/catch 行为等价），而不是让路由 500。
    return Response.json({ available: false, metadata: null, entries: [] });
  }
}

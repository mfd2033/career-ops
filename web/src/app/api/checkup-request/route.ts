// POST /api/checkup-request — 「体检这家」按钮的前置校验（ADR-0027）。
//
// The button dispatches a WORKER (kind=checkup) that runs the checkup
// immediately through the global concurrency pool (ADR-0026's agent-inbox
// async path is superseded). This route is the pre-flight: target resolution
// (`?` rows → the recruiting agency from the report's Via; missing Via → 400,
// the button disables itself) and same-day dedup (pending legacy request OR
// dispatched worker audit line → 409). The actual dispatch happens when the
// client calls /api/run with kind=checkup — that route also writes the
// already-marked agent-inbox audit line (with its runId); the ledger stays
// append-only. Pure helpers live in @/lib/checkup-request.mjs (node --test
// locked); this route is the transport layer the repo leaves untested by
// design (same as /api/status, /api/tracker/delete).
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, findCheckupTarget } from "@/lib/career-ops";
import { hasPendingCheckupRequest } from "@/lib/checkup-request.mjs";
// 本地日历日（ADR-0027 决议 4 的「当天」= 用户所在的今天，不是 UTC 日——
// UTC+8 的早上 8 点前 UTC 日还是昨天，会静默放行重复请求）。复用 followups
// 的既有实现，不另起副本。
import { localISODate } from "@/lib/followups";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: { n?: string | number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const n = String(body.n ?? "").trim();
  if (!/^\d+$/.test(n)) {
    return Response.json({ error: "a numeric application number is required" }, { status: 400 });
  }

  // 体检对象判定：company / `?`→Via / Via 缺失 → 400（前端据此禁用按钮）。
  const target = findCheckupTarget(n);
  if (!target.ok) {
    return Response.json({ error: target.reason }, { status: target.reason === "row-not-found" ? 404 : 400 });
  }

  // 当天去重：同 tracker# 已有 pending 请求或已派发的 worker → 409（跨天可复检）。
  // 「当天」是用户本地日历日（lib/local-today.mjs 纪律），绝非 UTC 日。
  const today = localISODate();
  const inboxPath = path.join(careerOpsRoot(), "data", "agent-inbox.md");
  const inboxText = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, "utf8") : "";
  if (hasPendingCheckupRequest(inboxText, n, today)) {
    return Response.json({ error: "已在体检队列", deduped: true }, { status: 409 });
  }

  return Response.json({ ok: true, company: target.company, target: target.source });
}

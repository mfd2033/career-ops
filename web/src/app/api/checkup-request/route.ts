// POST /api/checkup-request — 「体检这家」按钮的入口（ADR-0026）。
//
// The button does NOT run a checkup (the capability lives agent-side, in the
// offer体检 skill): it writes one intent line into data/agent-inbox.md via the
// root `agent-inbox.mjs add` CLI — reusing its lock/append machinery, zero
// system-layer changes. The press IS the human confirmation; the request text
// is self-contained so the draining session executes without asking again.
//
// Guards (ADR-0026 决议 6/7): numeric n only; `?` rows target the report Via
// (recruiting agency) and 400 when Via is missing; same-tracker#-same-day
// pending requests → 409. Dedup is queue-level only — the ledger stays
// append-only. Pure helpers live in @/lib/checkup-request.mjs (node --test
// locked); this route is the transport layer the repo leaves untested by
// design (same as /api/status, /api/tracker/delete).
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { careerOpsRoot, findCheckupTarget, rootScript } from "@/lib/career-ops";
import { checkupRequestText, hasPendingCheckupRequest } from "@/lib/checkup-request.mjs";
// 本地日历日（ADR-0026 决议 7 的「当天」= 用户所在的今天，不是 UTC 日——
// UTC+8 的早上 8 点前 UTC 日还是昨天，会静默放行重复请求）。复用 followups
// 的既有实现，不另起副本。
import { localISODate } from "@/lib/followups";

export const runtime = "nodejs";

const ADD_TIMEOUT_MS = 30_000;

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

  const root = careerOpsRoot();
  const addScript = rootScript("agent-inbox");
  if (!fs.existsSync(addScript)) {
    return Response.json({ error: "agent-inbox script not found" }, { status: 503 });
  }

  // 体检对象判定：company / `?`→Via / Via 缺失 → 400（前端据此禁用按钮）。
  const target = findCheckupTarget(n);
  if (!target.ok) {
    return Response.json({ error: target.reason }, { status: target.reason === "row-not-found" ? 404 : 400 });
  }

  // 当天 pending 去重：同 tracker# 已有未 drain 的体检请求 → 409（跨天可复检）。
  // 「当天」是用户本地日历日（lib/local-today.mjs 纪律），绝非 UTC 日。
  const today = localISODate();
  const inboxPath = path.join(root, "data", "agent-inbox.md");
  const inboxText = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, "utf8") : "";
  if (hasPendingCheckupRequest(inboxText, n, today)) {
    return Response.json({ error: "已在体检队列", deduped: true }, { status: 409 });
  }

  const text = checkupRequestText({ n, company: target.company, date: today });
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [addScript, "add", text],
        { cwd: root, timeout: ADD_TIMEOUT_MS, env: process.env },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  } catch (err: unknown) {
    // stderr 不回显（避免泄露绝对路径），与 /api/status 同纪律。
    console.error("[checkup-request] agent-inbox add failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "failed to queue the checkup request" }, { status: 500 });
  }

  return Response.json({ ok: true, company: target.company, target: target.source });
}

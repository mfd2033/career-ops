import { cancelRun } from "@/lib/core/run-events";

// POST /api/run/cancel {runId} — explicit cancellation for a background worker
// (ADR-0020). With the old per-task streaming response, closing the connection
// cancelled the run; now the POST returns immediately and the run continues
// headless, so the worker card's X button needs a real cancel endpoint.
//
// For a QUEUED run this dequeues it from the pool (never spawns); for a
// RUNNING run it terminates the CLI process tree and releases the write token
// and pool slot. No-op (ok:false) for unknown/already-finished runIds.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { runId?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const { runId } = body;
  if (!runId) {
    return Response.json({ ok: false, error: "runId required" }, { status: 400 });
  }
  const ok = cancelRun(runId);
  return Response.json({ ok });
}

// Cancel a task in the global concurrency pool.
//
// QUEUED: the task has not spawned a CLI child yet, so dequeuing it is the whole
// stop (the awaiting route's "granted" resolve turns false and its SSE closes
// with status=error·cancelled; a batch route also releases the URL's reserved
// report number), ADR-0014 Q5.
//
// RUNNING single-run worker: the pool itself cannot terminate a child, but the
// pool entry carries the /api/run event-bus runId, so hand it to cancelRun —
// that is the same tree-terminate path the worker card's stop button uses.
// RUNNING batch workers carry no runId (one stream, no per-id handle); the
// response says so honestly instead of pretending the batch stopped.

import { cancel as poolCancel, listPool } from "@/lib/core/concurrency-pool";
import { cancelRun } from "@/lib/core/run-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let id: unknown;
  try {
    const body = await req.json();
    id = body?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== "string" || !id) {
    return Response.json({ error: "id required" }, { status: 400 });
  }
  const result = poolCancel(id);
  if (!result.removed) {
    const running = listPool().running.find((entry) => entry.id === id);
    if (running?.runId && cancelRun(running.runId)) {
      return Response.json({ ...result, cancelled: true });
    }
  }
  return Response.json({ ...result, cancelled: result.removed });
}
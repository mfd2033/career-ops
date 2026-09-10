// Cancel a task that is QUEUED in the global concurrency pool.
//
// A queued task has not spawned a CLI child yet, so cancelling it is safe from
// the pool alone: dequeue it and the awaiting route's "granted" resolve turns
// false, closing that worker's SSE with status=error·cancelled (and the batch
// route releases the URL's reserved report number). Running tasks keep their
// existing cancel path (tree-terminate the child), which the pool cannot do —
// this endpoint only dequeues, ADR-0014 Q5.

import { cancel as poolCancel } from "@/lib/core/concurrency-pool";

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
  return Response.json(result);
}
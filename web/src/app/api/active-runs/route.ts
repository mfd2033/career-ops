import { listActiveRuns } from "@/lib/core/active-runs";

// Read-only snapshot of in-flight+queued evaluations, server-wide.
//
// Polled by the frontend worker list so evaluations started OUTSIDE the in-app
// job-store — i.e. from the BOSS直聘 browser extension — still appear as
// running/queued workers. Same-origin/loopback only, like /api/report-status; the
// proxy guard admits the request before this handler runs.
//
// Now includes both `running` (executing) and `queued` (waiting for a slot in
// the global concurrency pool) entries — both visible to the worker list.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(listActiveRuns());
}
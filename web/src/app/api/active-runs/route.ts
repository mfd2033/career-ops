import { listActiveRuns } from "@/lib/core/active-runs";

// Read-only snapshot of in-flight batch evaluations, server-wide.
//
// Polled by the frontend worker list so evaluations started OUTSIDE the in-app
// job-store — i.e. from the BOSS直聘 browser extension — still appear as
// running workers. Same-origin/loopback only, like /api/report-status; the
// proxy guard admits the request before this handler runs.
//
// Counts can exceed the UI's local job-store because every registered batch URL
// is listed, regardless of which process started it. The frontend keys workers
// by a client-side id and merges only these, so a snapshot that outlives a
// finished evaluation (server hasn't unregistered yet) could briefly show a
// stale card — the frontend treats any entry missing from consecutive polls as
// done and drops it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ runs: listActiveRuns() });
}
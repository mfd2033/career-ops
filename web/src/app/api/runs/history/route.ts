import { readRunHistory } from "@/lib/run-ledger.mjs";
import { careerOpsRoot } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/history — server-side ledger of TERMINATED runs (newest first).
// The /jobs history page merges this with the browser's localStorage cards so
// runs dispatched outside the UI (API, script) are visible too. Tolerant: a
// missing/corrupt ledger yields an empty list, never an error page.
export async function GET() {
  return Response.json({ runs: readRunHistory(careerOpsRoot(), 200) });
}

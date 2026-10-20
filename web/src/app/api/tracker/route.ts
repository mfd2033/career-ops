import {
  badRequest,
  coreScriptAvailable,
  coreScriptMissing,
  failResponse,
  okResponse,
  runTrackerScript,
} from "@/lib/tracker-api";
import { addArgv, queryArgv } from "@/lib/tracker-cli.mjs";
import { canonicalizeStatus } from "@/lib/core/states";

export const runtime = "nodejs";
// Tracker reads are always fresh: the CLI auto-resyncs its index when the
// markdown moved, and a cached route response would serve yesterday's rows back.
export const dynamic = "force-dynamic";

/**
 * GET /api/tracker — list and filter application rows.
 *
 * Thin wrapper over `tracker.mjs query --json`: rows come from the derived
 * SQLite index, which the CLI re-syncs whenever applications.md changed. No
 * consistency handling happens here — a route that re-read the markdown itself
 * would be a second reader of the same source, which is how readers drift.
 *
 * @param req - Incoming request; `status`, `company`, `role`, `since`, `limit`.
 * @returns `{ok, data: {rows, total}}`.
 */
export async function GET(req: Request): Promise<Response> {
  if (!coreScriptAvailable("tracker")) return coreScriptMissing();

  const url = new URL(req.url);
  const params = url.searchParams;
  // Resolved here rather than in the CLI: tracker.mjs rejects an unknown status
  // by exiting without a JSON document, which the route could only report as a
  // generic 500. Canonicalizing first keeps the rejection specific and cheap.
  const status = params.get("status");
  if (status !== null && status !== "") {
    const canonical = canonicalizeStatus(status);
    if (!canonical) return badRequest("invalid-state", `not a canonical status: ${status}`);
    params.set("status", canonical);
  }

  const built = queryArgv(params);
  if ("error" in built) return badRequest(built.error.code, built.error.message);

  const run = await runTrackerScript("tracker", built.argv);
  if (run.status !== 200) return failResponse("", run);
  if (!run.rows) {
    return badRequest("internal", "tracker query returned no rows document");
  }
  return okResponse({ rows: run.rows, total: run.rows.length });
}

/**
 * POST /api/tracker — create one row.
 *
 * Delegates to tracker-add.mjs, which holds the shared tracker lock, validates
 * the state against templates/states.yml and de-duplicates on the normalized
 * posting URL. A duplicate is a SUCCESS with `verdict: "duplicate"` and the
 * existing row number — retrying a create must not be able to produce a second
 * row for the same posting.
 *
 * @param req - Request whose JSON body carries the row fields.
 * @returns `{ok, data: {num, verdict, …}}`.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("usage", "body must be JSON");
  }
  const built = addArgv(body);
  if ("error" in built) return badRequest(built.error.code, built.error.message);
  if (!coreScriptAvailable("tracker-add")) return coreScriptMissing();

  const run = await runTrackerScript("tracker-add", [...built.argv, "--json"]);
  if (run.status !== 200) return failResponse("", run);
  return okResponse(run.parsed);
}

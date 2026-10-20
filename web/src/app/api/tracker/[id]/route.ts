import {
  badRequest,
  coreScriptAvailable,
  coreScriptMissing,
  failResponse,
  notFound,
  okResponse,
  runTrackerScript,
} from "@/lib/tracker-api";
import { editArgv, trackerRowArg } from "@/lib/tracker-cli.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tracker/[id] — one row plus its status history.
 *
 * Two core reads, both read-only: `tracker.mjs query --id N` (the row, from the
 * auto-resynced index) and `tracker.mjs history --id N` (the transition events
 * that index has observed across syncs). The row is resolved FIRST, so "no such
 * row" is answered as 404 before paying for a second spawn.
 *
 * @param _req - Unused.
 * @param context.params - Promise resolving to the route's `id` segment.
 * @returns `{ok, data: {row, history}}`.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const row = trackerRowArg(id);
  if (!row) return badRequest("usage", "id must be a tracker row number");
  if (!coreScriptAvailable("tracker")) return coreScriptMissing();

  const queried = await runTrackerScript("tracker", ["query", "--id", row, "--json"]);
  if (queried.status !== 200) return failResponse(`/${row}`, queried);
  if (!queried.rows) return badRequest("internal", "tracker query returned no rows document");
  if (queried.rows.length === 0) return notFound(`no tracker row #${row}`);

  const history = await runTrackerScript("tracker", ["history", "--id", row, "--json"]);
  // A row that vanished between the two reads is a 404 on the same resource, not
  // a server fault; anything else is a real failure worth surfacing.
  if (history.status !== 200 && history.cliCode !== "not-found") {
    return failResponse(`/${row}`, history);
  }

  return okResponse({
    row: queried.rows[0],
    history: history.status === 200 ? history.parsed : null,
  });
}

/**
 * PATCH /api/tracker/[id] — edit named fields of one row.
 *
 * Delegates to tracker-edit.mjs: it takes the shared lock, validates the state
 * against templates/states.yml, appends the transition ledger line on a status
 * change, and refuses the write if the markdown changed inside its critical
 * section. Only the fields named in the body change; every other byte of the
 * tracker round-trips.
 *
 * @param req - Request whose JSON body carries the fields to change.
 * @param context.params - Promise resolving to the route's `id` segment.
 * @returns `{ok, data: {changed, num, changedFields, …}}`.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("usage", "body must be JSON");
  }
  const built = editArgv(body, id);
  if ("error" in built) return badRequest(built.error.code, built.error.message);
  if (!coreScriptAvailable("tracker-edit")) return coreScriptMissing();

  const run = await runTrackerScript("tracker-edit", [...built.argv, "--json", "--source", "web"]);
  if (run.status !== 200) return failResponse(`/${id}`, run);
  return okResponse(run.parsed);
}

import {
  badRequest,
  coreScriptAvailable,
  coreScriptMissing,
  failResponse,
  okResponse,
  runTrackerScript,
} from "@/lib/tracker-api";
import { upsertArgv } from "@/lib/tracker-cli.mjs";

export const runtime = "nodejs";

/**
 * PUT /api/tracker/upsert — write one row keyed on the posting URL.
 *
 * Same body as POST /api/tracker, plus `updateOnMatch` (default false). The core
 * does the work: `tracker-add.mjs --update-on-match` updates the fields the
 * caller supplied on the row a duplicate resolves to, and reports
 * `verdict: "updated"`; without the flag it reports `"duplicate"` and writes
 * nothing.
 *
 * Kept as its own endpoint rather than folded into POST because the semantics
 * differ: POST is "record this application", which must never silently rewrite a
 * row, while PUT is "this is the current state of this posting", which should.
 *
 * @param req - Request whose JSON body carries the row fields.
 * @returns `{ok, data: {num, verdict, …}}`.
 */
export async function PUT(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("usage", "body must be JSON");
  }
  const built = upsertArgv(body);
  if ("error" in built) return badRequest(built.error.code, built.error.message);
  if (!coreScriptAvailable("tracker-add")) return coreScriptMissing();

  const run = await runTrackerScript("tracker-add", [...built.argv, "--json"]);
  if (run.status !== 200) return failResponse("/upsert", run);
  return okResponse(run.parsed);
}

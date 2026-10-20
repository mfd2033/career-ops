import {
  badRequest,
  coreScriptAvailable,
  coreScriptMissing,
  failResponse,
  okResponse,
  runTrackerScript,
} from "@/lib/tracker-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/tracker/sync — rebuild the derived SQLite index from the markdown.
 *
 * Body: `{checkOnly?: boolean}`; `true` adds `--check` (diagnose only, write
 * nothing).
 *
 * `--check` finding problems is a NORMAL outcome, not a server error: the CLI
 * exits 1 in that case and prints its diagnostics, and the route answers 200
 * with `data.issues` so a caller can read what is wrong. Only a sync that could
 * not run at all is a 5xx — that distinction is the whole point of the endpoint.
 *
 * @param req - Request whose optional JSON body selects check-only mode.
 * @returns `{ok, data: {ok, checkOnly, rowCount, issues, …}}`.
 */
export async function POST(req: Request): Promise<Response> {
  let checkOnly = false;
  // An absent body is valid (a plain "rebuild" POST); a body that is not JSON is
  // not, and silently ignoring it would run the write the caller meant to avoid.
  const text = await req.text();
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return badRequest("usage", "body must be JSON");
    }
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const value = (body as Record<string, unknown>).checkOnly;
      if (value !== undefined && typeof value !== "boolean") {
        return badRequest("usage", "checkOnly must be a boolean");
      }
      checkOnly = value === true;
    } else {
      return badRequest("usage", "body must be a JSON object");
    }
  }

  if (!coreScriptAvailable("tracker")) return coreScriptMissing();

  const args = ["sync", ...(checkOnly ? ["--check"] : []), "--json"];
  const run = await runTrackerScript("tracker", args);
  // Exit 1 with a check document is the diagnostic path described above; any
  // other non-zero exit is a real failure (unreadable states.yml, bad db path…).
  const diagnostic = run.cliCode === null && run.parsed?.checkOnly === true;
  if (run.status !== 200 && !diagnostic) return failResponse("/sync", run);
  return okResponse(run.parsed);
}

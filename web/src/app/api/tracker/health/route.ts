import {
  coreScriptAvailable,
  coreScriptMissing,
  failResponse,
  okResponse,
  runTrackerScript,
} from "@/lib/tracker-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/tracker/health — pre-flight probe before writing anything.
 *
 * One delegation to `tracker.mjs health --json`, which reports the diagnostics
 * `sync --check` produces plus whether another process holds the shared tracker
 * lock. The probe lives in the core because the lock directory is named from a
 * hash of the canonical tracker path: a second copy of that rule here would
 * drift and then silently probe a directory nobody locks.
 *
 * HTTP is 200 whenever the probe RAN — `data.ok` carries the verdict, and
 * `data.lockHeld` means "busy, retry shortly" rather than "this request failed".
 * The envelope repeats that as top-level `retryable` so a caller can branch on
 * either shape.
 *
 * @returns `{ok, data: {ok, mdPath, dbPath, rowCount, issues, lockHeld}}`.
 */
export async function GET(): Promise<Response> {
  if (!coreScriptAvailable("tracker")) return coreScriptMissing();

  const run = await runTrackerScript("tracker", ["health", "--json"]);
  if (run.status !== 200) return failResponse("/health", run);
  if (!run.parsed) {
    return okResponse({ ok: false, issues: [], lockHeld: false, reason: "health probe returned no result" });
  }
  return okResponse(run.parsed, run.parsed.lockHeld === true ? { retryable: true } : {});
}

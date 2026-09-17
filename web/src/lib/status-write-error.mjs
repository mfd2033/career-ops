// What to tell the user when POST /api/status fails (ADR-0036).
//
// The writeback control used to revert the dropdown in silence: the value the
// user had just picked simply snapped back, with no reason and no next step.
// This module owns the mapping from "how it failed" to "what we say", as a pure
// function — the component itself has no test surface in this repo (no jsdom /
// React test setup), so the testable part deliberately lives here.
//
// Three rules, all of them from cases seen in the wild:
//   1. Never invent a diagnosis. An unrecognized failure carries the server's own
//      message (or the HTTP status) as `detail`, single-lined and truncated —
//      hidden failures become guesses, and guesses become wrong fixes.
//   2. A timeout is not a failure report. `/api/status` answers 504 with "may or
//      may not have been applied", and the copy must say the same: telling the
//      user "it didn't save" there would make them retry a write that may have
//      landed, or re-triage a row that already moved.
//   3. The user-facing text lives in the i18n cluster (`pipeline.statusError.*`);
//      this returns the key, so both languages stay in one place.
//
// Plain .mjs (like pipeline-order.mjs / status-alias.mjs) so `node --test` can
// import it. Kept honest by web/tests/lib/status-write-error.test.mjs.

/** Longest server message we echo back into the header row. */
const DETAIL_MAX = 160;

/** Collapse whatever the server said into one short, displayable line. */
function oneLine(text) {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX).trimEnd()}…` : flat;
}

/**
 * Map a failed status write to the message the user should see.
 *
 * @param {number} httpStatus - the response status (0/none is treated as generic).
 * @param {Record<string, unknown> | null} body - the parsed response body, if any.
 *   `code` is set by the route from set-status.mjs's own error code
 *   (`ambiguous`, `lock-timeout`, `not-found`, …); `error` is the human message.
 * @returns {{key: string, detail?: string}} an i18n key plus, for unrecognized
 *   failures, the short detail to interpolate.
 */
export function describeStatusWriteError(httpStatus, body) {
  const code = typeof body?.code === "string" ? body.code : "";
  // The CLI's own code comes first, and it decides alone: the route maps several
  // different failures onto 503 (a data-only root answers `core-script-missing`
  // with 503 too), so keying off the status first would tell a user with a
  // missing script that the tracker is merely busy — a wrong, unactionable
  // diagnosis. An unrecognized code therefore falls through to `generic` and
  // carries the server's own sentence.
  // A duplicated tracker number: no selector can name the row, so no retry can
  // help until the data is repaired. Say which command does that.
  if (code === "ambiguous") return { key: "pipeline.statusError.ambiguous" };
  // The row is gone (deleted tracker row) — refreshing is the fix, not retrying.
  if (code === "not-found") return { key: "pipeline.statusError.gone" };
  // Another writer holds the tracker lock (set-status exit 4) — transient.
  if (code === "lock-timeout") return { key: "pipeline.statusError.locked" };
  // Our own kill timeout: the outcome is genuinely unknown.
  if (httpStatus === 504) return { key: "pipeline.statusError.timeoutUnknown" };
  // No code at all: fall back to the status, where the only meaningful ones are
  // the two the route also sets a code for (404 missing, 503 busy). A code we
  // merely do not recognize must NOT be guessed at from the status.
  if (!code && httpStatus === 404) return { key: "pipeline.statusError.gone" };
  if (!code && httpStatus === 503) return { key: "pipeline.statusError.locked" };
  return { key: "pipeline.statusError.generic", detail: oneLine(body?.error) || `HTTP ${httpStatus}` };
}

/** fetch() itself threw: the dashboard is down or the tab lost its server. */
export function offlineStatusWriteError() {
  return { key: "pipeline.statusError.offline" };
}

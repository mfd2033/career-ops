// The decisions the /api/tracker routes make around their core child process:
// which argv a request becomes, which HTTP status a CLI exit maps to, and which
// JSON document on stdout is the result.
//
// Imports tracker-cli.mjs directly (the single source of truth) so the test and
// the routes can never drift.
//
// Run:  node --test tests/lib/tracker-cli.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addArgv,
  boundedLockWait,
  editArgv,
  failureBody,
  httpStatusFor,
  isRetryable,
  parseCliJson,
  parseCliJsonArray,
  queryArgv,
  trackerRowArg,
  upsertArgv,
} from "../../src/lib/tracker-cli.mjs";

test("a query result printed as a bare array is the document, not a parse failure", () => {
  // tracker.mjs prints `JSON.stringify(rows)` — an array. An object-only reader
  // would report "no result" for a perfectly successful read.
  const stdout = [
    "(index stale — resyncing from data/applications.md)",
    '[{"id":1,"company":"Acme"},{"id":2,"company":"Beta"}]',
  ].join("\n");
  assert.deepEqual(parseCliJsonArray(stdout), [{ id: 1, company: "Acme" }, { id: 2, company: "Beta" }]);
  assert.equal(parseCliJson(stdout), null);
});

test("an object document and an array document never masquerade as each other", () => {
  assert.deepEqual(parseCliJson('{"ok":true}'), { ok: true });
  assert.equal(parseCliJsonArray('{"ok":true}'), null);
  assert.equal(parseCliJson(""), null);
  assert.equal(parseCliJsonArray(""), null);
});

test("exit codes map to the statuses the spec names, exit 4 stays retryable", () => {
  assert.equal(httpStatusFor({ exitCode: 2 }), 404);
  assert.equal(httpStatusFor({ exitCode: 3 }), 409);
  assert.equal(httpStatusFor({ exitCode: 4 }), 503);
  assert.equal(isRetryable(503), true);
  assert.equal(isRetryable(504), true);
  assert.equal(isRetryable(409), false);
});

test("exit 1 is split by the CLI's own code instead of blaming the caller", () => {
  assert.equal(httpStatusFor({ exitCode: 1, cliCode: "usage" }), 400);
  assert.equal(httpStatusFor({ exitCode: 1, cliCode: "invalid-state" }), 400);
  assert.equal(httpStatusFor({ exitCode: 1, cliCode: "no-column" }), 400);
  // A broken checkout or filesystem is ours, not the caller's.
  assert.equal(httpStatusFor({ exitCode: 1, cliCode: "states-error" }), 500);
  assert.equal(httpStatusFor({ exitCode: 1, cliCode: "write-failure" }), 500);
  // An exit-1 code this file has never seen is far more likely to be ours.
  assert.equal(httpStatusFor({ exitCode: 1, cliCode: "something-new" }), 500);
  assert.equal(httpStatusFor({ exitCode: 1 }), 500);
});

test("conflicts, not-found and lock contention are decided before the exit table", () => {
  assert.equal(httpStatusFor({ exitCode: 3, cliCode: "ambiguous" }), 409);
  assert.equal(httpStatusFor({ exitCode: 3, cliCode: "concurrent-modification" }), 409);
  assert.equal(httpStatusFor({ exitCode: 1, cliCode: "not-found" }), 404);
  // A killed child has no meaningful exit code; a timeout is not a caller error.
  assert.equal(httpStatusFor({ exitCode: -1, timedOut: true }), 504);
  assert.equal(httpStatusFor({ exitCode: -1, spawnFailed: true }), 500);
});

test("the failure body never echoes child stderr", () => {
  const body = failureBody({
    parsed: { error: 'row #9 not found', code: "not-found" },
    cliCode: "not-found",
    exitCode: 2,
  });
  assert.deepEqual(body, {
    ok: false,
    error: { code: "not-found", message: "row #9 not found" },
    retryable: false,
  });

  const retry = failureBody({ parsed: { error: "busy", code: "lock-timeout" }, cliCode: "lock-timeout", exitCode: 4 });
  assert.equal(retry.retryable, true);

  const opaque = failureBody({ parsed: null, exitCode: 1 });
  assert.equal(opaque.error.code, "internal");
  assert.match(opaque.error.message, /exit 1/);
});

test("a create body becomes the CLI's argv, and the Notes field is --note", () => {
  const built = addArgv({
    company: "Acme",
    role: "Engineer",
    url: "https://acme.test/1",
    score: "4.2/5",
    notes: "recruiter call",
  });
  assert.equal("error" in built, false);
  assert.deepEqual(built.argv, [
    "--company", "Acme",
    "--role", "Engineer",
    "--url", "https://acme.test/1",
    "--score", "4.2/5",
    "--note", "recruiter call",
  ]);
});

test("a create body is refused for missing required fields or fields outside the whitelist", () => {
  assert.equal(addArgv({ role: "Engineer" }).error.code, "usage");
  assert.equal(addArgv({ company: "  ", role: "Engineer" }).error.code, "usage");
  assert.equal(addArgv(null).error.code, "usage");
  assert.equal(addArgv([]).error.code, "usage");
  const unknown = addArgv({ company: "Acme", role: "Engineer", verdict: "created" });
  assert.equal(unknown.error.code, "usage");
  assert.match(unknown.error.message, /verdict/);
  // An object/array value would reach the CLI as "[object Object]".
  assert.equal(addArgv({ company: "Acme", role: "Engineer", score: { v: 1 } }).error.code, "usage");
  // A control character cannot survive the markdown row; a newline can (the CLI
  // single-lines free text), so only the former is refused here.
  assert.equal(addArgv({ company: "Acme", role: "Engineer", notes: "nul\u0000byte" }).error.code, "usage");
  assert.equal("error" in addArgv({ company: "Acme", role: "Engineer", notes: "two\nlines" }), false);
});

test("upsert accepts updateOnMatch (boolean only) and shares the field whitelist", () => {
  const built = upsertArgv({ company: "Acme", role: "Engineer", updateOnMatch: true });
  assert.deepEqual(built.argv.slice(-1), ["--update-on-match"]);
  assert.equal(upsertArgv({ company: "Acme", role: "Engineer", updateOnMatch: "yes" }).error.code, "usage");
  assert.equal(upsertArgv({ company: "Acme", role: "Engineer", updateOnMatch: false }).argv.includes("--update-on-match"), false);
});

test("an edit body needs a row number and at least one whitelisted field", () => {
  const built = editArgv({ score: "4.6/5", status: "Interview" }, "7");
  assert.equal("error" in built, false);
  assert.deepEqual(built.argv, ["--row", "7", "--score", "4.6/5", "--status", "Interview"]);

  assert.equal(editArgv({}, "7").error.code, "usage");
  assert.equal(editArgv({ score: "4.6/5" }, "abc").error.code, "usage");
  assert.equal(editArgv({ score: "4.6/5" }, "1.5").error.code, "usage");
  assert.equal(editArgv({ company: "Acme" }, "7").argv.length > 0, true);
});

test("query argv carries only the filters that were sent, plus a bounded limit", () => {
  const bare = queryArgv(new URLSearchParams(""));
  assert.deepEqual(bare.argv, ["query", "--json", "--limit", "20"]);
  assert.equal(bare.limit, 20);

  const filtered = queryArgv(new URLSearchParams("status=Applied&company=acme&since=2026-01-01&limit=5"));
  assert.deepEqual(filtered.argv, [
    "query", "--json", "--status", "Applied", "--company", "acme", "--since", "2026-01-01", "--limit", "5",
  ]);

  // An over-large limit is clamped rather than rejected: the caller asked for
  // "more than we serve", which is a request we can answer.
  assert.equal(queryArgv(new URLSearchParams("limit=100000")).limit, 500);

  assert.equal(queryArgv(new URLSearchParams("limit=0")).error.code, "usage");
  assert.equal(queryArgv(new URLSearchParams("limit=abc")).error.code, "usage");
  assert.equal(queryArgv(new URLSearchParams("since=2026-1-1")).error.code, "usage");
});

test("row numbers are validated before any spawn", () => {
  assert.equal(trackerRowArg("12"), "12");
  assert.equal(trackerRowArg(12), "12");
  assert.equal(trackerRowArg(" 12 "), "12");
  assert.equal(trackerRowArg("12x"), null);
  assert.equal(trackerRowArg("-1"), null);
  assert.equal(trackerRowArg(""), null);
  assert.equal(trackerRowArg(null), null);
  assert.equal(trackerRowArg({}), null);
});

test("the child's lock wait is bounded below our own kill timeout", () => {
  assert.deepEqual(boundedLockWait(30_000, {}), { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "10000" });
  assert.deepEqual(
    boundedLockWait(30_000, { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "2000" }),
    { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "2000" },
  );
  // Above the ceiling the two settings contradict each other, so the operator's
  // value is clamped instead of letting the child outlive its killer.
  assert.deepEqual(
    boundedLockWait(30_000, { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "600000" }),
    { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "25000" },
  );
  assert.deepEqual(
    boundedLockWait(30_000, { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "not-a-number" }),
    { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: "10000" },
  );
});

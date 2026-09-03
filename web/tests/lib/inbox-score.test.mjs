// Tests for inbox score resolution: which evaluation facts drive the "scored"
// signal on a triage row (live session job-store vs durable tracker/reports).
// Regression for: postings already evaluated on disk (CLI pipeline, batch,
// prior sessions) showed a false "not scored" in the web inbox because the
// score lookup only read this browser's job-store.
//
// Run:  node --test tests/lib/inbox-score.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRowScore, buildScoreByUrl } from "../../src/lib/inbox-score.mjs";

// ── resolveRowScore: live session entry vs persisted disk score ─────────────

test("live running spinner always wins", () => {
  const live = { score: null, running: true, jobId: "job-1" };
  const persisted = { score: 3.8, tone: "warn" };
  assert.equal(resolveRowScore(live, persisted), live);
});

test("live with a verdict always wins", () => {
  const live = { score: 4.5, running: false, jobId: "job-1" };
  const persisted = { score: 3.0, tone: "muted" };
  assert.equal(resolveRowScore(live, persisted), live);
});

test("live done-but-verdictless (failed eval) falls back to persisted", () => {
  const live = { score: null, running: false, jobId: "job-9", tone: "muted" };
  const persisted = { score: 3.8, tone: "warn", jobId: "" };
  assert.deepEqual(resolveRowScore(live, persisted), persisted);
});

test("live done-but-verdictless and no persisted → undefined (honest not scored)", () => {
  const live = { score: null, running: false, jobId: "job-9", tone: "muted" };
  assert.equal(resolveRowScore(live, undefined), undefined);
});

test("no live entry → persisted is the displayable fact", () => {
  const persisted = { score: 2.5, tone: "bad", jobId: "" };
  assert.equal(resolveRowScore(undefined, persisted), persisted);
});

test("neither source evaluated → undefined", () => {
  assert.equal(resolveRowScore(undefined, undefined), undefined);
});

// ── buildScoreByUrl: durable tracker/report map ─────────────────────────────

const readUrl = (app) => (app.n === "no-report" ? undefined : `https://Boards.greenhouse.io/${app.n}/jobs/4?gh_src=abc&utm_source=news`);

test("maps each app's posting URL to its tracker score", () => {
  const m = buildScoreByUrl(
    [
      { n: "11", score: "3.2/5" },
      { n: "12", score: "3.5/5" },
    ],
    readUrl,
  );
  assert.equal(Object.keys(m).length, 2);
  assert.deepEqual(m["https://boards.greenhouse.io/11/jobs/4"], { score: "3.2/5" });
  assert.deepEqual(m["https://boards.greenhouse.io/12/jobs/4"], { score: "3.5/5" });
});

test("keys are normalized: tracking params stripped, host lowercased, trailing slash dropped", () => {
  const m = buildScoreByUrl([{ n: "1", score: "4.0/5" }], readUrl);
  const key = Object.keys(m)[0];
  assert.equal(key, "https://boards.greenhouse.io/1/jobs/4");
  assert.ok(!key.includes("utm_") && !key.includes("gh_src") && key === key.toLowerCase());
});

test("apps without a resolvable http(s) URL are dropped", () => {
  const m = buildScoreByUrl(
    [
      { n: "1", score: "4.0/5" },
      { n: "2", score: "3.0/5" },
      { n: "3", score: "2.0/5" },
    ],
    (a) => (a.n === "1" ? "https://lever.co/acme" : a.n === "2" ? "ftp://not-http" : undefined),
  );
  assert.deepEqual(Object.keys(m).sort(), ["https://lever.co/acme"]);
});

test("duplicate URLs keep the first app's score", () => {
  const m = buildScoreByUrl(
    [
      { n: "1", score: "4.0/5" },
      { n: "2", score: "2.0/5" },
    ],
    () => "https://jobs.ashbyhq.com/acme",
  );
  assert.deepEqual(m["https://jobs.ashbyhq.com/acme"], { score: "4.0/5" });
});

test("unparseable URLs cannot become keys", () => {
  const m = buildScoreByUrl([{ n: "1", score: "4.0/5" }], () => "not a url at all");
  assert.equal(Object.keys(m).length, 0);
});
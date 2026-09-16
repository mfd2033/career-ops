// seen-status.test.mjs — the skipped_title plumbing behind ADR-0029 决议 4.
//
// The collection gates reject a posting BEFORE it reaches the results area, so the
// only trace a reject leaves is one row in data/scan-history.tsv with
// status=skipped_title. That row is the answer to "why is this URL not in my
// results" — and the whole value is lost if any link in the chain drops it:
//
//   page → POST /api/explore/seen {status} → recordSeenOffers(offers, status)
//        → runWriter(…) → appendToScanHistory(offers, date, status)
//
// Every link is un-runnable in a unit test (an HTTP route, a spawned child), so
// these are source assertions — the same stance browser-scan.test.mjs takes for
// its own un-reachable call sites. What they guard is the failure mode this repo
// keeps re-learning: a new write path that creates records nobody can attribute.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const flat = (rel) => readFileSync(join(here, "../../src", rel), "utf8").replace(/\s+/g, " ");

const PIPELINE = "lib/core/pipeline.ts";
const ROUTE = "app/api/explore/seen/route.ts";

test("recordSeenOffers hands its status through to the writer", () => {
  const src = flat(PIPELINE);
  assert.match(
    src,
    /export function recordSeenOffers\(offers: DiscoveredOffer\[\], status: SeenStatus = "added"\): Promise<AddResult> \{ return runWriter\(offers, "history", status\); \}/,
    "recordSeenOffers must forward status to runWriter — otherwise every skip row silently becomes added",
  );
  assert.match(
    src,
    /const \{ offers, mode, status \} = JSON\.parse\(input\)/,
    "the child-process snippet must read status off the payload",
  );
  assert.match(
    src,
    /appendToScanHistory\(offers, date, status\)/,
    "and pass it to the canonical writer, which is the only thing that stamps scan-history.tsv",
  );
});

test("SeenStatus stays a closed set", () => {
  const src = flat(PIPELINE);
  assert.match(
    src,
    /export type SeenStatus = "added" \| "skipped_title"/,
    "the status column is read by dedup, whats-new and the recheck/cooldown logic — an open string would let an unrecognised value silently mislead all three",
  );
});

test("the seen route accepts skipped_title and keeps it out of the added namespace", () => {
  const src = flat(ROUTE);
  assert.match(src, /if \(body\.status === "skipped_title"\) status = "skipped_title"/, "the route must accept the skip status (and nothing else)");
  assert.match(
    src,
    /status === "skipped_title" \? `filtered:\$\{scanId\}` : `seen:\$\{scanId\}`/,
    "a skip batch needs its OWN idempotency namespace: extension collection already recorded those URLs under seen:<scanId>, and reusing it would mark the whole filtered batch a replay and write nothing",
  );
  assert.match(
    src,
    /const fresh = status === "skipped_title" \? newOffers :/,
    "the content-level gate must not apply to skip rows — they are a second fact about a URL, not a duplicate row",
  );
  assert.match(src, /recordSeenOffers\(fresh, status\)/, "the validated status must be the one written");
});

test("the page stamps the rejects, from both drivers", () => {
  const src = flat("components/explore/explore-provider.tsx");
  assert.match(src, /status: "skipped_title"/, "the POST body must carry the status");
  assert.match(src, /recordFiltered\(gated\.dropped, scanId\)/, "the extension path's rejects");
  assert.match(src, /recordFiltered\(foldedAcc, bskScanId\)/, "the bsk path's rejects, delivered via the folded event");
});

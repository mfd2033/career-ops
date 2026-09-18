// Tests for the batch-checkup per-tracker# artifact gate helper (ADR-0041 决议 6).
//
// `checkupArtifactRowCount` is a GLOBAL count — correct for a single checkup
// run, but a batch has N workers appending to the SAME ledger concurrently, so
// a global before/after diff cannot be attributed to any one company. The batch
// gate counts verifiable rows whose key column equals the item's tracker#:
//   - declared HTML must exist on disk (the #1022「行在、报告不在」rule),
//   - `-` / empty / truncated rows are tolerated (ADR-0030 决议 1 unchanged),
//   - `?` empty-key rows belong to `?`, never to a numeric tracker.
//
// Run:  node --test tests/lib/batch-checkup-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkupArtifactRowCountForTracker } from "../../src/lib/run-cli-support.mjs";

const HEADER = "tracker\tdate\tslug\tcompany\tstar\trisks\thtml\tnote\n";

const ledgerOf = (...rows) => HEADER + rows.join("\n") + "\n";

test("counts verifiable rows for the item's own tracker# only", () => {
  const text = ledgerOf(
    "917\t2026-09-16\thanen-lanhui\t河南蓝辉\t1.5\tsocial-zero\treports/checkups/917-henan-lanhui-2026-09-16.html\tx",
    "918\t2026-09-17\tacme\tAcme\t4.0\t-\treports/checkups/918-acme-2026-09-17.html\ty",
  );
  const exists = (rel) => rel.includes("918-"); // only #918's HTML is on disk
  assert.equal(checkupArtifactRowCountForTracker(text, "918", exists), 1);
  // #917's row declares an HTML that does not exist → NOT a verifiable artifact.
  assert.equal(checkupArtifactRowCountForTracker(text, "917", exists), 0);
});

test("rows without a declared HTML (`-` or empty) count", () => {
  const text = ledgerOf(
    "42\t2026-09-18\ta\tA\t3.0\t-\t-\tno html attached",
    "42\t2026-09-18\tb\tA\t3.5\t-\t\tempty html cell",
  );
  assert.equal(checkupArtifactRowCountForTracker(text, "42", () => false), 2);
});

test("? empty-key rows never count toward a numeric tracker#", () => {
  const text = ledgerOf("?\t2026-09-18\ts\tS\t2.0\t-\t-\tunmatched");
  assert.equal(checkupArtifactRowCountForTracker(text, "42", () => true), 0);
});

test("`?` empty-key items count nothing — batch items are always numeric tracker rows", () => {
  // The `?` key is the CLI-path sentinel (invite-match miss). The batch route
  // dispatches per tracker ROW number, so the gate is defined for numeric keys
  // only; a `?` item is a caller bug, not a countable key.
  const text = ledgerOf("?\t2026-09-18\ts\tS\t2.0\t-\t-\tunmatched");
  assert.equal(checkupArtifactRowCountForTracker(text, "?", () => true), 0);
});

test("prefix collision: #102 must not count #1022's row", () => {
  const text = ledgerOf("1022\t2026-09-18\tother\tOther\t3.0\t-\t-\tx");
  assert.equal(checkupArtifactRowCountForTracker(text, "102", () => true), 0);
  assert.equal(checkupArtifactRowCountForTracker(text, "1022", () => true), 1);
});

test("unreadable ledger (undefined) counts 0 — a read failure never relaxes the gate", () => {
  assert.equal(checkupArtifactRowCountForTracker(undefined, "42", () => true), 0);
  assert.equal(checkupArtifactRowCountForTracker("not\teven\tthe\theader", "42", () => true), 0);
});

test("non-numeric tracker keys count nothing (defensive)", () => {
  const text = ledgerOf("42\t2026-09-18\ta\tA\t3.0\t-\t-\tx");
  assert.equal(checkupArtifactRowCountForTracker(text, "", () => true), 0);
  // @ts-expect-error - runtime guard: a non-string tracker# must not throw
  assert.equal(checkupArtifactRowCountForTracker(text, null, () => true), 0);
});

test("missing probe function treats declared HTML as missing (never widen)", () => {
  const text = ledgerOf("42\t2026-09-18\ta\tA\t3.0\t-\treports/checkups/42-a.html\tx");
  assert.equal(checkupArtifactRowCountForTracker(text, "42", undefined), 0);
});

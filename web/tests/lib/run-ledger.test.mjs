// Tests for the server run ledger contract (ADR-0027 follow-up observability
// fix): append → read round-trip, newest first; tolerant of malformed lines
// and a missing ledger; limit caps the read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRunRecord, readRunHistory, runsLedgerPath } from "../../src/lib/run-ledger.mjs";

test("append → read round-trip, newest first", () => {
  const root = mkdtempSync(join(tmpdir(), "co-ledger-"));
  try {
    appendRunRecord(root, { id: "r1", kind: "checkup", input: "917", title: "t1", status: "error", startedAt: 1, finishedAt: 2, msg: "boom" });
    appendRunRecord(root, { id: "r2", kind: "evaluate", input: "u", title: "t2", status: "done", startedAt: 3, finishedAt: 4 });
    const runs = readRunHistory(root);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].id, "r2"); // newest first
    assert.equal(runs[1].status, "error");
    assert.equal(runs[1].msg, "boom");
    assert.match(runsLedgerPath(root), /index\.jsonl$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tolerant: malformed lines and blanks are skipped, not fatal", () => {
  const root = mkdtempSync(join(tmpdir(), "co-ledger-"));
  try {
    mkdirSync(join(root, ".career-ops-web", "runs"), { recursive: true });
    appendFileSync(runsLedgerPath(root), "{broken json\n\n{\"id\":\"ok\",\"kind\":\"checkup\",\"status\":\"done\"}\n");
    const runs = readRunHistory(root);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing ledger → empty array (graceful degradation)", () => {
  const root = mkdtempSync(join(tmpdir(), "co-ledger-"));
  try {
    assert.deepEqual(readRunHistory(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("limit caps the read", () => {
  const root = mkdtempSync(join(tmpdir(), "co-ledger-"));
  try {
    for (let i = 0; i < 5; i++) appendRunRecord(root, { id: `r${i}`, status: "done" });
    assert.equal(readRunHistory(root, 3).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

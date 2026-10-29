// The blacklist-gate ledger contract, asserted across BOTH sides at once.
//
// The defect this pins: the writer only ever put a Chinese explanation in `msg`
// (and a `done` row carries no `msg` at all), while the reader matched the
// English word "blacklist" — so the page's per-company block counts stayed at 0
// while the gate worked perfectly. Either side alone looked reasonable; only a
// round-trip test catches that.
//
// Run: node --test tests/lib/blacklist-gate-ledger.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { blacklistGateLedgerFields, detectBlacklistGate } from "../../src/lib/run-cli-support.mjs";
import { foldBlacklistGates } from "../../src/lib/blacklist-gate.mjs";

// Stands in for the core's normalizeCompanySafe: the fold must receive the key
// it is given, not re-derive its own.
const normalize = (value) => value.trim().toLowerCase().replace(/\s+/g, "");

test("writer → reader round-trip: a gate stop lights up the counters", () => {
  const gate = detectBlacklistGate("…\n[[BLACKLIST-GATE]] company=中犇科技有限公司\n");
  assert.deepEqual(gate, { company: "中犇科技有限公司" });

  const fields = blacklistGateLedgerFields(gate);
  const ledger = JSON.stringify({ id: "r1", kind: "evaluate", status: "done", ...fields });
  const folded = foldBlacklistGates(ledger, normalize);

  assert.equal(folded.totalBlocked, 1);
  assert.deepEqual(folded.blockedKeys, [normalize("中犇科技有限公司")]);
});

test("a gate stop with no company still counts, without inventing a key", () => {
  const fields = blacklistGateLedgerFields({ company: "" });
  assert.deepEqual(fields, { blockedByBlacklist: true });
  const folded = foldBlacklistGates(JSON.stringify({ status: "done", ...fields }), normalize);
  assert.equal(folded.totalBlocked, 1);
  assert.deepEqual(folded.blockedKeys, []);
});

test("no gate → no fields: an ordinary done row stays clean", () => {
  assert.deepEqual(blacklistGateLedgerFields(null), {});
  assert.deepEqual(blacklistGateLedgerFields(undefined), {});
  const folded = foldBlacklistGates(JSON.stringify({ status: "done", msg: "done" }), normalize);
  assert.equal(folded.totalBlocked, 0);
});

test("prose is not a signal — the pre-fix row shape must NOT be counted", () => {
  // This is the exact shape the old reader keyed on (English "blacklist" in msg).
  // It must stay uncounted now: the marker never reached the ledger, so trusting
  // it would count runs that were never blocked.
  const legacy = JSON.stringify({ kind: "evaluate", status: "done", msg: "hit the blacklist gate" });
  const chinese = JSON.stringify({ kind: "evaluate", status: "done", msg: "命中黑名单，已按规则停止" });
  const folded = foldBlacklistGates(`${legacy}\n${chinese}`, normalize);
  assert.equal(folded.totalBlocked, 0);
});

test("blank and malformed lines are skipped, never fatal", () => {
  const good = JSON.stringify({ blockedByBlacklist: true, blockedCompany: "Acme" });
  const folded = foldBlacklistGates(`\n{broken json\n${good}\n`, normalize);
  assert.equal(folded.totalBlocked, 1);
  assert.deepEqual(folded.blockedKeys, [normalize("Acme")]);
});

test("a normalizer that rejects the name drops the key, not the count", () => {
  const folded = foldBlacklistGates(JSON.stringify({ blockedByBlacklist: true, blockedCompany: "???" }), () => "");
  assert.equal(folded.totalBlocked, 1);
  assert.deepEqual(folded.blockedKeys, []);
});

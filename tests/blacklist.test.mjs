// ADR-0084 — blacklist table single source of truth (lib/blacklist.mjs).
// Covers the header-driven parser (5-col / 4-col / reordered), the serializer
// round-trip, the exemption-window predicate, and the pure row mutators the
// /api/blacklist route builds on. node --test, auto-discovered from tests/**.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBlacklist,
  readBlacklistTable,
  renderBlacklistTable,
  isExemptActive,
  addRow,
  removeRow,
  setExempt,
  BLACKLIST_HEADER,
} from "../lib/blacklist.mjs";

const FIVE = [
  "# Company Blacklist",
  "",
  "some user prose that must survive a rewrite.",
  "",
  "| Company | Since | Scope | Exempt until | Reason |",
  "|---------|-------|-------|--------------|--------|",
  "| Initech | 2026-09-23 | company | 2026-11-01 | low comp |",
  "| Umbrella | 2026-10-01 | company |  | hard gate |",
].join("\n");

test("parseBlacklist reads Exempt until by header name; reason is not shifted", () => {
  const ini = parseBlacklist(FIVE).get("initech");
  assert.equal(ini.exemptUntil, "2026-11-01");
  assert.equal(ini.reason, "low comp");
  const umb = parseBlacklist(FIVE).get("umbrella");
  assert.equal(umb.exemptUntil, "");
  assert.equal(umb.reason, "hard gate");
});

test("parseBlacklist still parses the historical 4-column file", () => {
  const four = "| Company | Since | Scope | Reason |\n|---|---|---|---|\n| Acme | 2026-01-15 | company | old |";
  const acme = parseBlacklist(four).get("acme");
  assert.equal(acme.reason, "old");
  assert.equal(acme.exemptUntil, "");
});

test("parseBlacklist maps columns by name even when reordered", () => {
  const t = "| Reason | Company | Exempt until | Since | Scope |\n|---|---|---|---|---|\n| biz | Hooli | 2026-12-31 | 2026-05-05 | company |";
  const h = parseBlacklist(t).get("hooli");
  assert.equal(h.reason, "biz");
  assert.equal(h.exemptUntil, "2026-12-31");
  assert.equal(h.since, "2026-05-05");
});

test("readBlacklistTable preserves the preamble and row order", () => {
  const { preamble, rows } = readBlacklistTable(FIVE);
  assert.match(preamble, /must survive a rewrite/);
  assert.deepEqual(rows.map((r) => r.company), ["Initech", "Umbrella"]);
});

test("renderBlacklistTable round-trips and keeps the preamble verbatim", () => {
  const { preamble, rows } = readBlacklistTable(FIVE);
  const out = renderBlacklistTable(preamble, rows);
  assert.match(out, /must survive a rewrite/);
  assert.ok(out.includes(BLACKLIST_HEADER));
  // re-parse yields the same rows
  const again = parseBlacklist(out);
  assert.equal(again.get("initech").exemptUntil, "2026-11-01");
  assert.equal(again.get("umbrella").reason, "hard gate");
});

test("renderBlacklistTable sanitizes cell pipes so columns never shift", () => {
  const out = renderBlacklistTable("# Blacklist", [{ company: "A|B", since: "2026-01-01", scope: "company", exemptUntil: "", reason: "x | y" }]);
  const row = out.split("\n").find((l) => l.startsWith("| A"));
  // the pipe inside company/reason became " / ", so the row still has exactly 5 cells
  assert.equal(row.split("|").length - 2, 5);
});

test("isExemptActive: future/today active, past/blank/malformed inactive", () => {
  assert.equal(isExemptActive("2026-12-31", "2026-10-17"), true);
  assert.equal(isExemptActive("2026-10-17", "2026-10-17"), true); // inclusive of the day
  assert.equal(isExemptActive("2026-10-16", "2026-10-17"), false); // expired → re-armed
  assert.equal(isExemptActive("", "2026-10-17"), false);
  assert.equal(isExemptActive("not-a-date", "2026-10-17"), false);
});

test("addRow is idempotent on the normalized key; removeRow/setExempt target by key", () => {
  let rows = readBlacklistTable(FIVE).rows;
  rows = addRow(rows, { company: "Initech", since: "2027-01-01", reason: "dup" }); // no-op
  assert.equal(rows.filter((r) => r.company === "Initech").length, 1);
  rows = addRow(rows, { company: "Soylent Corp.", since: "2026-10-17", reason: "new" });
  assert.ok(rows.some((r) => r.company === "Soylent Corp."));
  rows = setExempt(rows, "soylent corp", "2026-11-30"); // matches by normalized key
  assert.equal(rows.find((r) => r.company === "Soylent Corp.").exemptUntil, "2026-11-30");
  rows = removeRow(rows, "UMBRELLA");
  assert.ok(!rows.some((r) => r.company === "Umbrella"));
});

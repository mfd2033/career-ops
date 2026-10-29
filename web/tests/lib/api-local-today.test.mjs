// Guard: API routes must not answer "what day is it" with the UTC day.
//
// `new Date().toISOString().slice(0, 10)` is the UTC calendar day. Used as
// "today" it is wrong in both directions: west of Greenwich an evening run gets
// TOMORROW, east of it the user's own today reads as a future date for the first
// hours of their local day (#2765, #2932 — lib/local-today.mjs exists for exactly
// this). The blacklist route shipped with that bug, so its exemption gate could
// be a day off.
//
// Baseline, not a blanket ban: the four routes below already did this before the
// guard existed, and each one is a behaviour change of its own (they seed dates,
// not gate decisions). The list may SHRINK, never grow — a new occurrence fails
// this test. Use lib/local-today.mjs (`localToday()`) instead.
//
// Run: node --test tests/lib/api-local-today.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const API_DIR = fileURLToPath(new URL("../../src/app/api/", import.meta.url));

// `toISOString().slice(0, 10)` / `.slice(0,10)` — the UTC-day shape, in any spacing.
const UTC_DAY_RE = /toISOString\s*\(\s*\)\s*\.\s*(?:slice|substring|substr)\s*\(\s*0\s*,\s*10\s*\)/;

// Pre-existing occurrences, with why each is still here. Adding a line to this
// list is the thing this guard is meant to make visible in review.
const BASELINE = new Set([
  "batch-checkup/route.ts",
  "batch-evaluate/route.ts",
  "explore/candidates/route.ts",
  "run/route.ts",
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(?:ts|tsx|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

test("the detector matches the UTC-day shape (so the guard cannot rot silently)", () => {
  assert.ok(UTC_DAY_RE.test("const today = new Date().toISOString().slice(0, 10);"));
  assert.ok(UTC_DAY_RE.test("new Date().toISOString().slice(0,10)"));
  // The replacement shape the guard is pushing people toward is not flagged.
  assert.equal(UTC_DAY_RE.test("const today = await localTodayStr();"), false);
  assert.equal(UTC_DAY_RE.test("const d = new Date().getFullYear();"), false);
});

test("no API route outside the baseline derives a date from the UTC day", () => {
  const offenders = [];
  for (const file of walk(API_DIR)) {
    const source = readFileSync(file, "utf8");
    if (!UTC_DAY_RE.test(source)) continue;
    const rel = relative(API_DIR, file).split(sep).join("/");
    if (!BASELINE.has(rel)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these routes answer "today" with the UTC day — use lib/local-today.mjs instead: ${offenders.join(", ")}`,
  );
});

test("the blacklist route is not among the offenders (the defect this guard was written for)", () => {
  assert.equal(BASELINE.has("blacklist/route.ts"), false);
});

// fmtStartedAt / isSameLocalDay — the worker 「始于」 clock formatter (ADR-0044).
// Timestamps are built with the LOCAL Date(...) constructor so the day/hour
// assertions hold regardless of the machine's timezone.
//
// Run:  node --test tests/lib/started-at.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtStartedAt, isSameLocalDay } from "../../src/lib/started-at.mjs";

const local = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

test("same local day renders HH:MM only", () => {
  const now = local(2026, 9, 20, 15, 0);
  assert.equal(fmtStartedAt(local(2026, 9, 20, 14, 32), now), "14:32");
  assert.equal(fmtStartedAt(local(2026, 9, 20, 9, 5), now), "09:05", "single-digit parts are zero-padded");
});

test("yesterday appends the date", () => {
  const now = local(2026, 9, 20, 0, 30); // just past midnight
  assert.equal(fmtStartedAt(local(2026, 9, 19, 23, 50), now), "09-19 23:50");
});

test("cross-month and cross-year both append the date", () => {
  const now = local(2026, 1, 1, 12, 0);
  assert.equal(fmtStartedAt(local(2025, 12, 31, 23, 59), now), "12-31 23:59");
  const nowAug = local(2026, 9, 20, 12, 0);
  assert.equal(fmtStartedAt(local(2026, 7, 4, 8, 0), nowAug), "07-04 08:00");
});

test("midnight and last-minute boundaries", () => {
  const now = local(2026, 9, 20, 12, 0);
  assert.equal(fmtStartedAt(local(2026, 9, 20, 0, 0), now), "00:00");
  assert.equal(fmtStartedAt(local(2026, 9, 20, 23, 59), now), "23:59");
});

test("isSameLocalDay agrees with the formatter across the midnight boundary", () => {
  const a = local(2026, 9, 20, 0, 0);
  const b = local(2026, 9, 20, 23, 59);
  const c = local(2026, 9, 21, 0, 0);
  assert.equal(isSameLocalDay(a, b), true);
  assert.equal(isSameLocalDay(a, c), false);
});

test("invalid or missing input returns null (caller takes 缺失不占位)", () => {
  const now = local(2026, 9, 20, 12, 0);
  assert.equal(fmtStartedAt(null, now), null);
  assert.equal(fmtStartedAt(undefined, now), null);
  assert.equal(fmtStartedAt(NaN, now), null);
  assert.equal(fmtStartedAt(0, now), null);
  assert.equal(fmtStartedAt(-5, now), null);
});

test("nowMs defaults to Date.now() when omitted", () => {
  const label = fmtStartedAt(Date.now());
  assert.match(label, /^\d{2}:\d{2}$/, "a timestamp from right now is today → HH:MM");
});

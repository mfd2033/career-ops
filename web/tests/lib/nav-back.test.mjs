// Run:  node --test tests/lib/nav-back.test.mjs
//
// Locks the detail-page back-button decision (ADR-0019): back() only when the
// in-app stack has a previous route AND browser history actually has a back
// entry — a new tab inherits the opener's sessionStorage, which fakes a "prev"
// that browser history cannot serve, and back() there is a silent no-op.
import { test } from "node:test";
import assert from "node:assert/strict";

import { backNavPlan } from "../../src/lib/nav-back.mjs";

test("backNavPlan: in-app prev + real history → back()", () => {
  assert.deepEqual(backNavPlan("/explore", 3, "/jobs"), { kind: "back" });
  assert.deepEqual(backNavPlan("/pipeline", 2, "/jobs"), { kind: "back" });
});

test("backNavPlan: prev from an inherited sessionStorage but no back entry → replace prev", () => {
  // Chrome copies sessionStorage into target="_blank" tabs: the stack claims a
  // previous route, but history length 1 means back() would do nothing —
  // deterministically go to the claimed prev instead.
  assert.deepEqual(backNavPlan("/pipeline", 1, "/jobs"), { kind: "replace", url: "/pipeline" });
});

test("backNavPlan: no in-app prev (direct open / reload with a lone entry) → fallback", () => {
  // The fallback is the caller's list page: /jobs for worker detail (a worker
  // detail page is NOT a pipeline page), /pipeline for the report view.
  assert.deepEqual(backNavPlan(null, 5, "/jobs"), { kind: "replace", url: "/jobs" });
  assert.deepEqual(backNavPlan(null, 1, "/jobs"), { kind: "replace", url: "/jobs" });
});

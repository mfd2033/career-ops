// Tests for patchToProfile() — mapping the config form's JD evaluation/exclusion
// rule fields onto the config/profile.yml YAML structure.
//
// The config page ("JD 评估/排除规则") edits `deal_breakers` (a string list) and
// `location_flexibility` (free text) that live in profile.yml under
// `narrative.deal_breakers` and `compensation.location_flexibility`. This mapper
// is the test seam: it converts the form patch into the nested keys the
// merge-safe /api/profile writer deep-merges into the real file, so a save from
// the web and a hand-edit in profile.yml produce the same shape.
//
// Run:  node --test tests/lib/profile-patch.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { patchToProfile } from "../../src/lib/profile-patch.mjs";

// ── the two JD rules this feature exposes ────────────────────────────────────

test("dealBreakers maps to narrative.deal_breakers, trimmed + deduped", () => {
  const out = patchToProfile({
    dealBreakers: ["  出差较多的职位不考虑（含频繁出差）  ", "", "不做纯外包", "出差较多的职位不考虑（含频繁出差）"],
  });
  assert.deepEqual(out, {
    narrative: { deal_breakers: ["出差较多的职位不考虑（含频繁出差）", "不做纯外包"] },
  });
});

test("locationFlexibility maps to compensation.location_flexibility", () => {
  const out = patchToProfile({
    locationFlexibility: "郑州本地优先，可接受远程，不接受出差（含频繁与较多出差），不做纯外包",
  });
  assert.deepEqual(out, {
    compensation: { location_flexibility: "郑州本地优先，可接受远程，不接受出差（含频繁与较多出差），不做纯外包" },
  });
});

test("both rules combine into their distinct nested keys", () => {
  const out = patchToProfile({
    dealBreakers: ["不做纯外包"],
    locationFlexibility: "可接受远程",
  });
  assert.deepEqual(out, {
    narrative: { deal_breakers: ["不做纯外包"] },
    compensation: { location_flexibility: "可接受远程" },
  });
});

test("dealBreakers that are all blank yield no narrative key", () => {
  assert.deepEqual(patchToProfile({ dealBreakers: ["", "  ", "\n"] }), {});
});

test("empty locationFlexibility is omitted rather than clobbering the field", () => {
  assert.deepEqual(patchToProfile({ locationFlexibility: "" }), {});
});

test("absent fields yield {} — never a partial write", () => {
  assert.deepEqual(patchToProfile({}), {});
  assert.deepEqual(patchToProfile({ dealBreakers: undefined, locationFlexibility: undefined }), {});
});

// ── legacy fields must keep working (regression guard) ──────────────────────

test("remote still maps to compensation.location_flexibility", () => {
  const out = patchToProfile({ remote: "Remote (EU)" });
  assert.deepEqual(out, { compensation: { location_flexibility: "Remote (EU)" } });
});

test("roles/comp/candidate legacy mappings are preserved", () => {
  const out = patchToProfile({
    name: "马富荻",
    email: "a@b.com",
    roles: ["软件项目经理", "技术经理"],
    compMin: 25,
    compMax: 30,
    currency: "CNY",
  });
  assert.equal(out.candidate.full_name, "马富荻");
  assert.equal(out.candidate.email, "a@b.com");
  assert.deepEqual(out.target_roles, { primary: ["软件项目经理", "技术经理"] });
  assert.deepEqual(out.compensation, { target_range: "25-30", currency: "CNY" });
});

test("mapper never fabricates keys the form did not send", () => {
  const out = patchToProfile({ locationFlexibility: "仅远程" });
  assert.ok(!("candidate" in out));
  assert.ok(!("target_roles" in out));
  assert.deepEqual(out.compensation, { location_flexibility: "仅远程" });
});

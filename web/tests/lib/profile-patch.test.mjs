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
import {
  extractCompensation,
  patchToProfile,
  splitCompRange,
} from "../../src/lib/profile-patch.mjs";

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
    name: "张三",
    email: "a@b.com",
    roles: ["软件项目经理", "技术经理"],
    compMin: 25,
    compMax: 30,
    currency: "CNY",
  });
  assert.equal(out.candidate.full_name, "张三");
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

// ── 评估模式（CO-51 / CO-65）→ language.modes_dir 的三态 ──────────────────

test("marketMode: a directory value maps to language.modes_dir", () => {
  assert.deepEqual(patchToProfile({ marketMode: "modes/zh" }), { language: { modes_dir: "modes/zh" } });
  assert.deepEqual(patchToProfile({ marketMode: "  modes/de  " }), { language: { modes_dir: "modes/de" } });
});

test("marketMode: \"root\" and empty string both mean clear (null, deleted by the route)", () => {
  assert.deepEqual(patchToProfile({ marketMode: "root" }), { language: { modes_dir: null } });
  assert.deepEqual(patchToProfile({ marketMode: "" }), { language: { modes_dir: null } });
});

test("marketMode: absent means leave it alone (no language key at all)", () => {
  const out = patchToProfile({ dealBreakers: ["不做纯外包"] });
  assert.ok(!("language" in out));
  assert.deepEqual(patchToProfile({ marketMode: undefined }), {});
});

test("marketMode coexists with the JD rules in one patch", () => {
  const out = patchToProfile({ dealBreakers: ["不做纯外包"], marketMode: "modes/zh" });
  assert.deepEqual(out.narrative, { deal_breakers: ["不做纯外包"] });
  assert.deepEqual(out.language, { modes_dir: "modes/zh" });
});

// ── 薪资三项（目标下限/上限/底线）→ compensation ──────────────────────────

test("salary: floor maps to compensation.minimum and the range keeps its format", () => {
  const out = patchToProfile({ compMin: 30, compMax: 35, compFloor: 22, compUnit: "K" });
  assert.deepEqual(out, { compensation: { target_range: "30K-35K", minimum: "22K" } });
});

test("salary: a currency prefix and unit survive the round-trip", () => {
  const out = patchToProfile({ compMin: 150, compMax: 200, compFloor: 120, compPrefix: "$", compUnit: "K" });
  assert.deepEqual(out, { compensation: { target_range: "$150K-$200K", minimum: "$120K" } });
});

test("salary: a legacy caller sending no format still writes the bare range", () => {
  // assistant setProfile sends 70000/95000 — must not invent a unit.
  const out = patchToProfile({ compMin: 70000, compMax: 95000 });
  assert.deepEqual(out, { compensation: { target_range: "70000-95000" } });
});

test("salary: a lone bound never writes a half range", () => {
  assert.deepEqual(patchToProfile({ compMin: 25 }), {});
  assert.deepEqual(patchToProfile({ compMax: 30 }), {});
});

test("salary: numeric strings are accepted, blank strings are not zero", () => {
  const out = patchToProfile({ compMin: "25", compMax: "30", compFloor: "" });
  assert.deepEqual(out, { compensation: { target_range: "25-30" } });
});

test("splitCompRange parses the shipped formats and refuses free text", () => {
  assert.deepEqual(splitCompRange("25K-30K"), { min: 25, max: 30, prefix: "", unit: "K" });
  assert.deepEqual(splitCompRange("25\u201330K"), { min: 25, max: 30, prefix: "", unit: "K" });
  assert.deepEqual(splitCompRange("$150K-200K"), { min: 150, max: 200, prefix: "$", unit: "K" });
  assert.deepEqual(splitCompRange("30万-40万"), { min: 30, max: 40, prefix: "", unit: "万" });
  assert.equal(splitCompRange("面议"), null);
  assert.equal(splitCompRange("25K"), null);
  assert.equal(splitCompRange(""), null);
});

test("extractCompensation prefills the three fields from a real profile block", () => {
  const profile = {
    compensation: { target_range: "25K-30K", currency: "CNY", minimum: "20K" },
  };
  assert.deepEqual(extractCompensation(profile), {
    compMin: 25,
    compMax: 30,
    compFloor: 20,
    compPrefix: "",
    compUnit: "K",
  });
});

test("extractCompensation reports unset values as null, never 0", () => {
  assert.deepEqual(extractCompensation({}), {
    compMin: null,
    compMax: null,
    compFloor: null,
    compPrefix: "",
    compUnit: "",
  });
  // 自由文本区间解析不出上下限——如实留空，不猜一个数字。
  assert.deepEqual(extractCompensation({ compensation: { target_range: "面议" } }), {
    compMin: null,
    compMax: null,
    compFloor: null,
    compPrefix: "",
    compUnit: "",
  });
});

test("salary patch coexists with the other config cards' fields", () => {
  const out = patchToProfile({
    compMin: 30,
    compMax: 35,
    compFloor: 22,
    compUnit: "K",
    locationFlexibility: "郑州本地优先",
  });
  assert.deepEqual(out.compensation, {
    target_range: "30K-35K",
    minimum: "22K",
    location_flexibility: "郑州本地优先",
  });
});

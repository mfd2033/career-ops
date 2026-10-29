// Tests for the modes/_profile.md ↔ config/profile.yml deal-breakers sync
// helpers — extractDealBreakers() (read the hand-written section) and
// replaceDealBreakersSection() (rewrite only that section, preserving the rest
// of the user's profile markdown byte-for-byte).
//
// Why this file exists: the JD-rule form writes config/profile.yml, but the
// evaluation pipeline ALSO reads modes/_profile.md (SKILL.md loads it for every
// mode; context-budget injects both). A rule typed in the web form is only
// visible to the agent if it reaches _profile.md too — this mirror is the
// two-way bridge. Pure functions, no filesystem, so tests run under Node.
//
// Run:  node --test tests/lib/profile-md-sync.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDealBreakers, replaceCompTargetsSection, replaceDealBreakersSection } from "../../src/lib/profile-md-sync.mjs";

const SAMPLE = `# User Profile Context -- career-ops

## Your Target Roles

| Archetype | Thematic axes |
|-----------|---------------|
| 软件项目经理 | 端到端交付 |

## Your Deal-Breakers

- 出差较多的职位不考虑（含频繁出差）；可接受远程，不接受出差
- 不做纯外包

## Your Portfolio / Demo

暂无公开作品或演示链接。
`;

// ── extractDealBreakers: read the hand-written section ──────────────────────

test("extractDealBreakers parses the section's bullet list", () => {
  assert.deepEqual(extractDealBreakers(SAMPLE), [
    "出差较多的职位不考虑（含频繁出差）；可接受远程，不接受出差",
    "不做纯外包",
  ]);
});

test("extractDealBreakers returns [] when the heading is absent", () => {
  assert.deepEqual(extractDealBreakers("# No deal-breakers here\n\n- 不相关"), []);
});

test("extractDealBreakers stops at the next section heading", () => {
  const md = `## Your Deal-Breakers\n\n- 规则一\n- 规则二\n\n## Something Else\n\n- 不是规则\n`;
  assert.deepEqual(extractDealBreakers(md), ["规则一", "规则二"]);
});

test("extractDealBreakers handles a section with no bullets", () => {
  assert.deepEqual(extractDealBreakers(`## Your Deal-Breakers\n\n## Next\n`), []);
});

test("extractDealBreakers tolerates CRLF line endings", () => {
  assert.deepEqual(extractDealBreakers(SAMPLE.replace(/\n/g, "\r\n")), [
    "出差较多的职位不考虑（含频繁出差）；可接受远程，不接受出差",
    "不做纯外包",
  ]);
});

// ── replaceDealBreakersSection: rewrite only the section ────────────────────

test("replaceDealBreakersSection replaces the bullets and keeps the rest", () => {
  const { markdown, found } = replaceDealBreakersSection(SAMPLE, ["不做纯外包", "不接受出差"]);
  assert.equal(found, true);
  assert.ok(markdown.includes("## Your Target Roles"));
  assert.ok(markdown.includes("| 软件项目经理 | 端到端交付 |"));
  assert.ok(markdown.includes("## Your Portfolio / Demo"));
  assert.ok(markdown.includes("暂无公开作品或演示链接。"));
  // the section itself now carries the new rules, no trace of the old ones
  assert.deepEqual(extractDealBreakers(markdown), ["不做纯外包", "不接受出差"]);
  assert.ok(!markdown.includes("出差较多的职位不考虑"));
});

test("replaceDealBreakersSection preserves the blank-line rhythm", () => {
  const { markdown } = replaceDealBreakersSection(SAMPLE, ["仅此一条"]);
  const lines = markdown.split(/\n/);
  const heading = lines.findIndex((l) => l.trim() === "## Your Deal-Breakers");
  // heading, blank, bullet, blank, next heading — same cadence as the source
  assert.equal(lines[heading + 1], "");
  assert.equal(lines[heading + 2], "- 仅此一条");
  assert.equal(lines[heading + 3], "");
  assert.equal(lines[heading + 4].trim(), "## Your Portfolio / Demo");
});

test("replaceDealBreakersSection with an empty list leaves heading + blank only", () => {
  const { markdown, found } = replaceDealBreakersSection(SAMPLE, []);
  assert.equal(found, true);
  assert.deepEqual(extractDealBreakers(markdown), []);
  assert.ok(markdown.includes("## Your Deal-Breakers"));
  assert.ok(markdown.includes("## Your Portfolio / Demo"));
});

test("replaceDealBreakersSection trims and drops blanks from the input list", () => {
  const { markdown } = replaceDealBreakersSection(SAMPLE, ["  补一条  ", "", "  "]);
  assert.deepEqual(extractDealBreakers(markdown), ["补一条"]);
});

test("replaceDealBreakersSection returns found:false when the heading is absent", () => {
  const md = "# Just a header\n\nSome content without the section.";
  const { markdown, found } = replaceDealBreakersSection(md, ["规则"]);
  assert.equal(found, false);
  assert.equal(markdown, md); // untouched
});

test("replaceDealBreakersSection is tolerant of CRLF input", () => {
  const crlf = SAMPLE.replace(/\n/g, "\r\n");
  const { markdown, found } = replaceDealBreakersSection(crlf, ["新规则"]);
  assert.equal(found, true);
  assert.deepEqual(extractDealBreakers(markdown), ["新规则"]);
});

// ── replaceCompTargetsSection: 薪资三项只动「## Your Comp Targets」 段 ──────

const COMP_SAMPLE = `# User Profile Context -- career-ops

## Your Comp Targets

- 目标薪资：25\u201330K（CNY/月，郑州）
- 底线：20K（低于 20K 即 hard_stop；与 \`config/profile.yml\` → \`compensation.minimum\` 同值）
- 触线不算出局：**广告薪资上限 = 20K 只降 Comp 维度分**；只有上限 < 20K 才记 \`hard_stop\`。
- 低于目标 25\u201330K、但 \u2265 20K 的区间，不因此单独拒投。

## Your Negotiation Scripts

> "我的期望薪资区间是 25\u201330K，结构上可以谈。"
`;

test("replaceCompTargetsSection rewrites both anchor lines and keeps their notes", () => {
  const { markdown, found } = replaceCompTargetsSection(COMP_SAMPLE, { min: 30, max: 35, floor: 22, unit: "K" });
  assert.equal(found, true);
  // 原文是「25–30K」（只在末尾带 K），改写后也只在末尾带 K——不替用户改书写习惯
  assert.ok(markdown.includes("- 目标薪资：30–35K（CNY/月，郑州）"), markdown);
  assert.ok(markdown.includes("- 底线：22K（低于 22K 即 hard_stop"), markdown);
});

test("replaceCompTargetsSection keeps the rest of the section numerically consistent", () => {
  const { markdown } = replaceCompTargetsSection(COMP_SAMPLE, { min: 30, max: 35, floor: 22, unit: "K" });
  // 触线规则与「低于目标」行里的旧数字跟着换，不留两个互相矛盾的底线
  assert.ok(markdown.includes("广告薪资上限 = 22K"), markdown);
  assert.ok(markdown.includes("只有上限 < 22K 才记"), markdown);
  assert.ok(markdown.includes("低于目标 30–35K、但 ≥ 22K 的区间"), markdown);
  assert.ok(!markdown.includes("20K"));
});

test("replaceCompTargetsSection never touches content outside the section", () => {
  const { markdown } = replaceCompTargetsSection(COMP_SAMPLE, { min: 30, max: 35, floor: 22, unit: "K" });
  assert.ok(markdown.startsWith("# User Profile Context -- career-ops"));
  // 谈判话术在段外，保留用户原话（含旧数字）
  assert.ok(markdown.includes('"我的期望薪资区间是 25\u201330K，结构上可以谈。"'), markdown);
});

test("replaceCompTargetsSection falls back to the existing format when none is given", () => {
  // 不带 unit 的调用方（assistant setProfile）不能把 25–30K 写成 25–30
  const { markdown } = replaceCompTargetsSection(COMP_SAMPLE, { min: 30, max: 35, floor: 22 });
  assert.ok(markdown.includes("- 目标薪资：30–35K"), markdown);
  assert.ok(markdown.includes("- 底线：22K"), markdown);
});

test("replaceCompTargetsSection keeps a currency prefix and both-sided unit", () => {
  const md = `## Your Comp Targets\n\n- 目标薪资：$150K-200K（USD/月）\n- 底线：$120K（walk-away）\n`;
  const { markdown } = replaceCompTargetsSection(md, { min: 160, max: 210, floor: 130 });
  assert.ok(markdown.includes("- 目标薪资：$160K-210K（USD/月）"), markdown);
  assert.ok(markdown.includes("- 底线：$130K（walk-away）"), markdown);
});

test("replaceCompTargetsSection writes only the fields it was given", () => {
  const { markdown } = replaceCompTargetsSection(COMP_SAMPLE, { floor: 22 });
  assert.ok(markdown.includes("- 目标薪资：25\u201330K"), "区间未提交时不该被改写");
  assert.ok(markdown.includes("- 底线：22K"), markdown);
});

test("replaceCompTargetsSection returns found:false when the section is absent", () => {
  const md = "# Only a header\n\n- 目标薪资：25–30K";
  const { markdown, found } = replaceCompTargetsSection(md, { min: 30, max: 35, floor: 22 });
  assert.equal(found, false);
  assert.equal(markdown, md);
});

test("replaceCompTargetsSection is tolerant of CRLF input", () => {
  const crlf = COMP_SAMPLE.replace(/\n/g, "\r\n");
  const { markdown, found } = replaceCompTargetsSection(crlf, { min: 30, max: 35, floor: 22, unit: "K" });
  assert.equal(found, true);
  assert.ok(markdown.includes("- 目标薪资：30–35K"), markdown);
});

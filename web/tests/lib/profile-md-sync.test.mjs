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
import { extractDealBreakers, replaceDealBreakersSection } from "../../src/lib/profile-md-sync.mjs";

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

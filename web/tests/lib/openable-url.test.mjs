// Tests for openableUrl — which inbox/shortlist entries may become a real
// navigation link to the original posting vs plain text.
//
// Run:  node --test tests/lib/openable-url.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { openableUrl } from "../../src/lib/inbox-url.mjs";

test("http url opens verbatim — no https upgrade", () => {
  // 智联 rows in pipeline.md are http://; navigation must not force https
  // (normalizeUrl upgrades for identity keys — navigation must not inherit that).
  assert.equal(openableUrl("http://www.zhaopin.com/jobdetail/CC468463280J40863197215.htm"), "http://www.zhaopin.com/jobdetail/CC468463280J40863197215.htm");
});

test("https url opens verbatim", () => {
  assert.equal(openableUrl("https://boards.greenhouse.io/acme/jobs/123"), "https://boards.greenhouse.io/acme/jobs/123");
});

test("angle-bracket markdown autolink is not stripped here — parser's job", () => {
  // readInbox already strips <https://…>; openableUrl stays honest about raw cells.
  assert.equal(openableUrl("<https://example.com/job>"), null);
});

test("tracking params survive — navigation is not a dedup key", () => {
  assert.equal(openableUrl("https://www.zhipin.com/job_detail/abc.html?securityId=x&ka=sel"), "https://www.zhipin.com/job_detail/abc.html?securityId=x&ka=sel");
});

test("unparseable garbage → null (plain text, no dead link)", () => {
  assert.equal(openableUrl("not a url"), null);
  assert.equal(openableUrl(""), null);
  assert.equal(openableUrl(undefined), null);
});

test("non-http protocols → null", () => {
  assert.equal(openableUrl("javascript:alert(1)"), null);
  assert.equal(openableUrl("ftp://example.com/job"), null);
  assert.equal(openableUrl("file:///C:/job.html"), null);
});

test("whitespace-padded url is trimmed but otherwise verbatim", () => {
  assert.equal(openableUrl("  https://example.com/job  "), "https://example.com/job");
});

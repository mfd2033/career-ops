// Parity + regression tests for the web's normalizeUrl (posting-key) mirror.
// Imports the core and the web copy side-by-side so they can never drift, same
// pattern as normalize-text-key.test.mjs (#2369/#2666).
//
// Run:  node --test tests/lib/url-key.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUrl as webKey } from "../../src/lib/core/url-key.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { normalizeUrl: coreKey } = await import(pathToFileURL(join(ROOT, "url-key.mjs")).href);

test("web mirror matches core on ordinary postings (https upgrade, hostname lowercase, trailing slash)", () => {
  const CASES = [
    "http://Boards.Greenhouse.io/acme/jobs/apply",
    "https://boards.greenhouse.io/acme/jobs/apply/",
    "https://jobs.example.com/role#applyNow",
  ];
  for (const input of CASES) {
    assert.equal(webKey(input), coreKey(input), `parity: ${input}`);
  }
});

test("web mirror strips the same tracking-param denylist as core, in the same sorted order", () => {
  const url = "https://boards.greenhouse.io/acme/jobs/apply?utm_source=li&gh_jid=4471829005&fbclid=xyz";
  assert.equal(
    webKey(url),
    "https://boards.greenhouse.io/acme/jobs/apply?gh_jid=4471829005",
  );
  assert.equal(webKey(url), coreKey(url));
});

test("two RETAINED (non-tracking) params in opposite input order sort to the same key, on both sides", () => {
  // A single retained param (the test above) never exercises keep.sort() —
  // there is nothing to order. This pins order-independence with two.
  const orderA = "https://boards.greenhouse.io/acme/jobs/apply?location=paris&gh_jid=4471829005&utm_source=li";
  const orderB = "https://boards.greenhouse.io/acme/jobs/apply?utm_source=li&gh_jid=4471829005&location=paris";
  const expected = "https://boards.greenhouse.io/acme/jobs/apply?gh_jid=4471829005&location=paris";
  assert.equal(webKey(orderA), expected);
  assert.equal(webKey(orderB), expected, "opposite input order must sort to the identical key");
  assert.equal(webKey(orderA), coreKey(orderA));
  assert.equal(webKey(orderB), coreKey(orderB));
});

test("the reported bug: two DIFFERENT Greenhouse postings (same host+path, distinct gh_jid) key DIFFERENTLY", () => {
  const jobA = "https://boards.greenhouse.io/acme/jobs/apply?gh_jid=4471829005";
  const jobB = "https://boards.greenhouse.io/acme/jobs/apply?gh_jid=5501203417";
  assert.notEqual(webKey(jobA), webKey(jobB), "two distinct openings collapsed to one dedup key");
  assert.equal(webKey(jobA), coreKey(jobA));
  assert.equal(webKey(jobB), coreKey(jobB));
});

test("host+pathname-only shape must not return (regression lock on the pre-fix canon())", () => {
  // The pre-fix canon() discarded the ENTIRE query string, so both of these
  // collapsed to "boards.greenhouse.io/acme/jobs/apply". If that shape comes
  // back, this fails loudly.
  const jobA = "https://boards.greenhouse.io/acme/jobs/apply?gh_jid=4471829005";
  const jobB = "https://boards.greenhouse.io/acme/jobs/apply?gh_jid=5501203417";
  assert.notEqual(webKey(jobA), "boards.greenhouse.io/acme/jobs/apply");
  assert.notEqual(webKey(jobB), "boards.greenhouse.io/acme/jobs/apply");
});

test("unparseable / non-http(s) input keys to '' on both sides (NO KEY IS NOT A KEY)", () => {
  for (const bad of ["not a url", "ftp://example.com/x", "", "   "]) {
    assert.equal(webKey(bad), "", `web: ${JSON.stringify(bad)}`);
    assert.equal(coreKey(bad), "", `core: ${JSON.stringify(bad)}`);
  }
  assert.equal(webKey(null), "");
  assert.equal(webKey(undefined), "");
});

// 猎聘 ADR-0005 D7：全量反爬/跟踪参数 strip 后仅留 /job/{id}.shtml（或 /a/{id}.shtml），
// web 镜像与 core 必须逐字节一致——否则 /api/report-status 已评估判定漂移。
test("liepin: all ADR-0005 tracking params strip to job/{id}.shtml, on both sides", () => {
  const TRACKING =
    "pgRef=1&d_sfrom=search_feed&d_ckId=abc&d_curPage=0&d_pageSize=40&d_headId=xyz" +
    "&d_posi=0&skId=sk123&fkId=fk123&ckId=ck123&sfrom=search_job_pc&curPage=0" +
    "&pageSize=40&index=5";
  const url = `https://www.liepin.com/job/1985305711.shtml?${TRACKING}`;
  const expected = "https://www.liepin.com/job/1985305711.shtml";
  assert.equal(webKey(url), expected);
  assert.equal(webKey(url), coreKey(url), "parity: web mirror must match core");
});

test("liepin: /a/{id}.shtml recommendation variant strips the same params", () => {
  const url = "https://www.liepin.com/a/1985305711.shtml?pgRef=1&skId=sk123&curPage=0";
  const expected = "https://www.liepin.com/a/1985305711.shtml";
  assert.equal(webKey(url), expected);
  assert.equal(webKey(url), coreKey(url));
});

test("liepin: a NON-tracking retained query param survives beside stripped ones", () => {
  // 确认 strip 只删反爬参数,不清掉无关保留参数(与核心 denylist 语义一致)。
  const url = "https://www.liepin.com/job/1985305711.shtml?pgRef=1&sl=active";
  const expected = "https://www.liepin.com/job/1985305711.shtml?sl=active";
  assert.equal(webKey(url), expected);
  assert.equal(webKey(url), coreKey(url));
});

// 智联 ADR-0006 D5：页内跳转锚点带 refcode/srccode/preactionid(尤其 preactionid
// 每次操作即变 uuid),strip 后职位详情 URL 保持干净;web 镜像与 core 逐字节一致。
test("zhaopin: all ADR-0006 tracking params strip, on both sides", () => {
  const TRACKING = "refcode=4019&srccode=401901&preactionid=7c0a3b98-0000-1000-8000-000000000000";
  const url = `https://www.zhaopin.com/companydetail/CZ445905420.htm?${TRACKING}`;
  const expected = "https://www.zhaopin.com/companydetail/CZ445905420.htm";
  assert.equal(webKey(url), expected);
  assert.equal(webKey(url), coreKey(url), "parity: web mirror must match core");
});

test("zhaopin: jobdetail posting URL is clean even with the preactionid that anchors carry", () => {
  // 详情页 URL 本身无参数,但页内锚点可能带;strip 后仅留 /jobdetail/{number}.htm。
  const url =
    "https://www.zhaopin.com/jobdetail/CC445905420J40842265001.htm?refcode=1&preactionid=abc123";
  const expected = "https://www.zhaopin.com/jobdetail/CC445905420J40842265001.htm";
  assert.equal(webKey(url), expected);
  assert.equal(webKey(url), coreKey(url));
});

test("zhaopin: retained search-query params (jl/kw) survive beside stripped beacon params", () => {
  // jl/kw 是搜索查询条件,非反爬统计参数,应保留;只删 refcode/srccode/preactionid。
  const url =
    "https://www.zhaopin.com/jobs?jl=489&kw=%E5%B7%A5%E7%A8%8B%E5%B8%88&refcode=4019&preactionid=xyz";
  const expected = "https://www.zhaopin.com/jobs?jl=489&kw=%E5%B7%A5%E7%A8%8B%E5%B8%88";
  assert.equal(webKey(url), expected);
  assert.equal(webKey(url), coreKey(url));
});

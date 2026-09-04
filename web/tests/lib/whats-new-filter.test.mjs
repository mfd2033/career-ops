import { test } from "node:test";
import assert from "node:assert/strict";
import { rowToOfferOrNull } from "../../src/lib/whats-new-filter.mjs";

// Regression (#whats-new browser-board leak): scan-history rows written by
// browser-mode boards (智联/BOSS — runBrowserDiscovery hardcodes company:"")
// carry an EMPTY company column, so the old company-only evaluated guard
// short-circuited and an already-evaluated posting resurfaced as "new this
// week". The fix keys the evaluated set by normalized URL as well, so an
// empty-company row whose URL is already in the tracker is dropped.
//
// Regression (#whats-new pipeline leak): a browser-mode scan writes the SAME
// discovery to both scan-history.tsv (a "first seen this week" row) and
// data/pipeline.md (a pending `- [ ]` inbox row). The supply loop then
// re-offered postings the user already queued — "已在管道中" cards under
// "本周新匹配". The `pipelineUrls` dimension drops those, even when the
// posting was never evaluated (so the evaluated dimensions miss it).
const ctx = {
  norm: (s) => String(s).trim().toLowerCase(),
  evaluated: new Set(["acme"]), // tracker companies (normalized)
  evaluatedUrls: new Set([
    "https://www.zhipin.com/job_detail/d8932d746b1526cf0nB_29W8GFZU.html",
    "https://www.zhaopin.com/jobdetail/CCL1249412290J40925268604.htm",
  ]),
  // Pending `- [ ]` inbox rows from data/pipeline.md (NORMALIZED — the route
  // keys them through normalizeUrl before adding to the set, so the fixture
  // must store canonical https keys even when pipeline.md holds the raw http
  // link the browser saw; an http row URL folds onto the same key on lookup).
  pipelineUrls: new Set([
    "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4507304662",
    "https://www.zhaopin.com/jobdetail/CC602192630J40839408516.htm",
  ]),
};

const row = (url, company = "", status = "added") => [
  url, "2026-09-03", "browser-zhipin", "PLM项目经理", company, status, "",
];

test("empty-company row whose URL is already evaluated is dropped", () => {
  assert.equal(
    rowToOfferOrNull(ctx, row("https://www.zhipin.com/job_detail/d8932d746b1526cf0nB_29W8GFZU.html")),
    null,
  );
});

test("scheme/host/trailing-slash drift on the evaluated URL still matches", () => {
  // normalizeUrl lowercases host, forces https, drops trailing slash — the
  // two sides of a same posting must collapse to one key even when one was
  // recorded with http:// or a trailing slash.
  assert.equal(
    rowToOfferOrNull(ctx, row("http://www.zhaopin.com/jobdetail/CCL1249412290J40925268604.htm")),
    null,
  );
});

test("unknown URL with empty company is NOT dropped", () => {
  const offer = rowToOfferOrNull(ctx, row("https://www.zhipin.com/job_detail/someOtherJob123.html"));
  assert.ok(offer);
  assert.equal(offer.company, "");
  assert.equal(offer.source, "whats-new");
  assert.equal(offer.ats, "browser-zhipin");
  assert.equal(offer.postedAt, "2026-09-03");
});

test("known company drops the row even when its URL is not in the tracker", () => {
  assert.equal(
    rowToOfferOrNull(ctx, row("https://unknown.example.com/job/9", "Acme")),
    null,
  );
});

test("expired/skipped rows are dropped regardless of URL or company", () => {
  assert.equal(rowToOfferOrNull(ctx, row("https://x.example.com/job/1", "", "skipped_expired")), null);
  assert.equal(rowToOfferOrNull(ctx, row("https://x.example.com/job/2", "", "skipped_no_apply_control")), null);
});

test("malformed rows (no http URL) are dropped", () => {
  assert.equal(rowToOfferOrNull(ctx, ["not-a-url", "2026-09-03", "browser-zhipin", "t", "", "added", ""]), null);
});

test("empty-company row pending in the pipeline is dropped (even though never evaluated)", () => {
  // Browser-mode row with empty company, URL already queued in pipeline.md as
  // `- [ ]` — the exact real-data case (美团 jobUnionId=4507304662 ×9 rows).
  assert.equal(
    rowToOfferOrNull(ctx, row("https://zhaopin.meituan.com/web/position/detail?jobUnionId=4507304662")),
    null,
  );
});

test("pipeline URL with scheme drift still matches (http vs https, trailing slash)", () => {
  // normalizeUrl forces https + drops trailing slash; pipeline.md may record
  // the raw http link the browser saw while scan-history stores the https form.
  assert.equal(
    rowToOfferOrNull(ctx, row("http://www.zhaopin.com/jobdetail/CC602192630J40839408516.htm")),
    null,
  );
});

test("URL only in the pipeline stays dropped even when the company is known and un-evaluated", () => {
  // A scan row WITH a company name still loses to the pipeline dimension —
  // the company is not in `evaluated` (never evaluated), but the posting is
  // already queued, so it must not resurface as "new".
  assert.equal(
    rowToOfferOrNull(ctx, row("https://zhaopin.meituan.com/web/position/detail?jobUnionId=4507304662", "美团")),
    null,
  );
});

test("no pipelineUrls in ctx → pipeline filtering is a no-op (backward compatible)", () => {
  // Old callers that build ctx without the pipeline dimension keep the
  // pre-pipeline behavior; the route always passes it, but a unit caller must
  // not accidentally filter on an undefined set.
  const ctxNoPipeline = { norm: ctx.norm, evaluated: ctx.evaluated, evaluatedUrls: ctx.evaluatedUrls };
  const offer = rowToOfferOrNull(ctxNoPipeline, row("https://zhaopin.meituan.com/web/position/detail?jobUnionId=4507304662"));
  assert.ok(offer);
  assert.equal(offer.url, "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4507304662");
});

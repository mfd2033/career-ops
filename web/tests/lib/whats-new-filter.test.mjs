import { test } from "node:test";
import assert from "node:assert/strict";
import { rowToOfferOrNull } from "../../src/lib/whats-new-filter.mjs";

// Regression (#whats-new browser-board leak): scan-history rows written by
// browser-mode boards (智联/BOSS — runBrowserDiscovery hardcodes company:"")
// carry an EMPTY company column, so the old company-only evaluated guard
// short-circuited and an already-evaluated posting resurfaced as "new this
// week". The fix keys the evaluated set by normalized URL as well, so an
// empty-company row whose URL is already in the tracker is dropped.
const ctx = {
  norm: (s) => String(s).trim().toLowerCase(),
  evaluated: new Set(["acme"]), // tracker companies (normalized)
  evaluatedUrls: new Set([
    "https://www.zhipin.com/job_detail/d8932d746b1526cf0nB_29W8GFZU.html",
    "https://www.zhaopin.com/jobdetail/CCL1249412290J40925268604.htm",
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { rowToOfferOrNull } from "../../src/lib/whats-new-filter.mjs";
import { buildTitleFilterExplained } from "../../src/lib/core/title-keywords.mjs";

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

test("salary column (array index 12) is read back into offer.salaryText", () => {
  // 工单 03 全链路：浏览器采集把薪资落进 scan-history 的追加尾列（col 13 /
  // array index 12），今日页 whats-new 读回它，卡片才能对「本周新匹配」直接显示
  // 薪资。前面 7 列沿用 row() 形态，第 8~12 列（fingerprint…normalized_company）
  // 对本读取无关，用占位填充。
  const withSalary = [
    "https://www.zhipin.com/job_detail/newjob999.html", "2026-10-27", "browser-zhipin",
    "医疗高级项目交付经理", "", "added", "", "fp", "", "", "", "", "25-40K·14薪",
  ];
  const offer = rowToOfferOrNull(ctx, withSalary);
  assert.ok(offer);
  assert.equal(offer.salaryText, "25-40K·14薪");
});

test("missing salary column (legacy 7-col row) → salaryText is undefined, not empty string", () => {
  // Older rows predate the salary column and carry only the first 7 cells; the
  // DiscoveredOffer contract wants an ABSENT salaryText (so the card falls to
  // the 「薪资未知」 marker), never a spurious "".
  const offer = rowToOfferOrNull(ctx, row("https://www.zhipin.com/job_detail/legacyRow1.html"));
  assert.ok(offer);
  assert.equal(offer.salaryText, undefined);
});

test("empty salary cell trims to undefined (scan surfaced no comp)", () => {
  const blankSalary = [
    "https://www.zhipin.com/job_detail/nosalary777.html", "2026-10-27", "browser-zhipin",
    "项目经理", "", "added", "", "fp", "", "", "", "", "   ",
  ];
  const offer = rowToOfferOrNull(ctx, blankSalary);
  assert.ok(offer);
  assert.equal(offer.salaryText, undefined);
});

// ── 标题门维度：今日页与探索页同一份判定 ──────────────────────────
//
// 台账 status 只记采集当时的门判，但 portals.yml title_filter 是活的——用户在
// 规则弹窗里改词后，旧扫描里放行的行就成了当前词表下的该毙行。ctx.titleGate
// 是当前词表编译出的门（buildTitleFilterExplained，与探索页结果区/两路采集
// driver 同一份实现）；被它毙掉的行不得再进「本周新匹配」。

// 与路由同一份编译：positive 含「项目经理」（含则留），negative 含「销售」。
const gate = buildTitleFilterExplained({
  positive: ["项目经理", "word:intern"],
  negative: ["销售"],
});

const gatedRow = (title) => [
  `https://www.zhipin.com/job_detail/gate-${encodeURIComponent(title)}.html`,
  "2026-10-30", "browser-zhipin", title, "", "added", "",
];

test("title gate: negative hit drops the row", () => {
  // 采集当时的词表没拦住（status 是 added），当前词表的黑名单词命中 → 毙。
  assert.equal(rowToOfferOrNull({ ...ctx, titleGate: gate }, gatedRow("销售项目经理")), null);
});

test("title gate: no positive match drops the row", () => {
  // 相关推荐式标题（叉车司机）：positive 一个不中 → no-positive 毙。
  assert.equal(rowToOfferOrNull({ ...ctx, titleGate: gate }, gatedRow("叉车司机")), null);
});

test("title gate: positive hit keeps the row", () => {
  const offer = rowToOfferOrNull({ ...ctx, titleGate: gate }, gatedRow("高级项目经理"));
  assert.ok(offer);
  assert.equal(offer.title, "高级项目经理");
});

test("title gate judges the trimmed title the card will display", () => {
  // 猎聘会把城市/经验粘在标题上；台账 title 列去尾空格后就是卡片展示面，
  // 门看的是同一块表面（与采集门「不剥尾、误杀靠调词表」同一取向）。
  const c = [
    "https://www.zhipin.com/job_detail/trim1.html", "2026-10-30", "browser-zhipin",
    "  叉车司机  ", "", "added", "",
  ];
  assert.equal(rowToOfferOrNull({ ...ctx, titleGate: gate }, c), null);
});

test("empty title_filter compiles to a gate that passes everything (no constraint)", () => {
  // 空 positive 是「无正向约束」，不是「全拒」；空词表绝不能清空整个回路。
  const emptyGate = buildTitleFilterExplained({ positive: [], negative: [] });
  const offer = rowToOfferOrNull({ ...ctx, titleGate: emptyGate }, gatedRow("叉车司机"));
  assert.ok(offer);
});

test("negative-only title_filter rejects a few and keeps the rest", () => {
  const negOnly = buildTitleFilterExplained({ negative: ["销售"] });
  assert.equal(rowToOfferOrNull({ ...ctx, titleGate: negOnly }, gatedRow("销售助理")), null);
  const offer = rowToOfferOrNull({ ...ctx, titleGate: negOnly }, gatedRow("叉车司机"));
  assert.ok(offer);
});

test("no titleGate in ctx → gate filtering is a no-op (backward compatible)", () => {
  // 旧调用方/单测不传 titleGate 时保持原行为；路由没读到 portals.yml 时也是这条路。
  const offer = rowToOfferOrNull(ctx, gatedRow("叉车司机"));
  assert.ok(offer);
  assert.equal(offer.title, "叉车司机");
});

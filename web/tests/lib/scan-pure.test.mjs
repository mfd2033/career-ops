// scan-pure 纯逻辑单测(ADR-0007 E5/E7):URL Set 增量去重 / 分批切分 / 上限 /
// cardMeta → DiscoveredOffer 映射。无 DOM 依赖,直接 import extension/scan-pure.js。
//
// Run:  node --test tests/lib/scan-pure.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "scan-pure.js")).href);
const { SCAN_MAX, SCAN_BATCH_SIZE, defaultNormalizeKey, createScanAccumulator, toDiscoveredOffer } =
  mod.default ?? mod;

const mkMeta = (url, extra = {}) => ({ url, title: "AI 工程师", company: "示例公司", salary: "20-40K", city: "", ...extra });

test("exposed constants match ADR-0007 (E5/E7)", () => {
  assert.equal(SCAN_MAX, 400);
  assert.equal(SCAN_BATCH_SIZE, 50);
});

test("accumulator dedups by normalized URL: same posting never re-adds", () => {
  const acc = createScanAccumulator({ normalizeKey: defaultNormalizeKey });
  const a = acc.add(mkMeta("https://www.zhipin.com/job_detail/1.html"));
  // 同一职位:hash / 协议 / 大小写差异被归一判重 → 不重报(hash 由统一回退键 strip)。
  const b = acc.add(mkMeta("https://WWW.zhipin.com/job_detail/1.html#section"));
  assert.equal(a.added, true);
  assert.equal(b.added, false);
  assert.equal(acc.count, 1);
  assert.equal(acc.seenSize, 1);
  const { batch } = acc.flush();
  assert.equal(batch.length, 1); // 只上报首次那条
});

test("accumulator ignores empty / non-http URLs", () => {
  const acc = createScanAccumulator({ normalizeKey: defaultNormalizeKey });
  assert.equal(acc.add({ url: "" }).added, false);
  assert.equal(acc.add({ url: "javascript:void(0)" }).added, false);
  assert.equal(acc.add({ url: "#tag" }).added, false);
  assert.equal(acc.count, 0);
});

test("flush splits into 50-size batches, remainder kept for next flush", () => {
  const acc = createScanAccumulator({ normalizeKey: defaultNormalizeKey });
  for (let i = 0; i < 120; i++) acc.add(mkMeta(`https://x.com/job/${i}`));
  const r1 = acc.flush(); // 50
  const r2 = acc.flush(); // 50
  const r3 = acc.flush(); // 20
  assert.equal(r1.flushed, 50);
  assert.equal(r2.flushed, 50);
  assert.equal(r3.flushed, 20);
  assert.equal(r3.remaining, 0);
});

test("flush(Infinity) drains everything (terminal flush path)", () => {
  const acc = createScanAccumulator({ normalizeKey: defaultNormalizeKey });
  for (let i = 0; i < 160; i++) acc.add(mkMeta(`https://x.com/job/${i}`));
  const r = acc.flush(Infinity);
  assert.equal(r.flushed, 160);
  assert.equal(r.remaining, 0);
});

test("reachedMax flips once the accumulated set reaches the cap", () => {
  const acc = createScanAccumulator({ normalizeKey: defaultNormalizeKey, maxCount: 400 });
  assert.equal(acc.reachedMax, false);
  for (let i = 0; i < 400; i++) acc.add(mkMeta(`https://x.com/job/${i}`));
  assert.equal(acc.reachedMax, true);
});

test("toDiscoveredOffer maps cardMeta to the /api/explore/add contract", () => {
  const offer = toDiscoveredOffer(
    { url: "https://www.zhaopin.com/jobdetail/1.htm", title: "AI", company: "甲", city: "上海", salary: "30K" },
    "zhaopin",
  );
  assert.equal(offer.url, "https://www.zhaopin.com/jobdetail/1.htm");
  assert.equal(offer.title, "AI");
  assert.equal(offer.company, "甲");
  assert.equal(offer.location, "上海"); // city → location
  assert.equal(offer.postedAt, "");
  assert.equal(offer.ats, "browser");
  assert.equal(offer.source, "browser-zhaopin");
  assert.equal(offer.note, "browser · zhaopin · 上海");
  assert.equal(offer.salaryText, "30K"); // 工单 04: salary 原文透传,不再丢弃
});

test("toDiscoveredOffer without a city leaves location empty and drops city from note", () => {
  const offer = toDiscoveredOffer({ url: "https://www.zhipin.com/job_detail/1.html", title: "AI", company: "", city: "" }, "zhipin");
  assert.equal(offer.location, "");
  assert.equal(offer.note, "browser · zhipin");
  assert.equal(offer.company, "");
});

test("toDiscoveredOffer: missing salary text omits salaryText entirely (contract stays lean)", () => {
  const offer = toDiscoveredOffer({ url: "https://www.zhipin.com/job_detail/2.html", title: "AI", salary: "" }, "zhipin");
  assert.equal(Object.prototype.hasOwnProperty.call(offer, "salaryText"), false);
});

test("toDiscoveredOffer: BOSS PUA 数字按实证映射解码（E031+n = 数字 n，用户对照 2026-09-14）", () => {
  // 真实取证（data/pipeline.md + 用户在 BOSS 页面人工对照）：
  // {E032}{E036}-{E034}{E031}K = 15-30K
  const offer = toDiscoveredOffer(
    { url: "https://www.zhipin.com/job_detail/12b516d2077e1d8b0nN709S8FFBY.html", title: "AI", salary: "\uE032\uE036-\uE034\uE031K" },
    "zhipin",
  );
  assert.equal(offer.salaryText, "15-30K");
  const offer2 = toDiscoveredOffer({ url: "https://x.com/2", title: "AI", salary: "\uE033\uE031-\uE034\uE031K·\uE032\uE034薪" }, "zhipin");
  assert.equal(offer2.salaryText, "20-30K·13薪");
});

test("toDiscoveredOffer: E03A=9 —— 含 9 的薪资不再被丢成「薪资未知」（2026-09-14 修复）", () => {
  // 修复前 E03A 落在映射范围外 → hasUnmappedPua → 整条薪资被丢弃 → 前端「薪资未知」徽章。
  // 卡片实测取证（四个搜索列表页，card-probe）：E032..E039 覆盖 1..8，E03A 只在需要 9 的
  // 薪资里出现；"10" 一律写作两个字形 {E032}{E031}，故 E03A 不可能是 10。详情页明文反查：
  // {E039}-{E03A}K ↔ 8-9K、{E037}-{E03A}K ↔ 6-9K。
  const cases = [
    ["\uE039-\uE03AK", "8-9K"],
    ["\uE037-\uE03AK", "6-9K"],
    ["\uE036-\uE03AK", "5-9K"],
    ["\uE03A-\uE032\uE031K", "9-10K"], // 报障职位（详情页明文 9-10K）在卡片上的形状
  ];
  for (const [raw, want] of cases) {
    const offer = toDiscoveredOffer({ url: "https://x.com/9", title: "AI", salary: raw }, "zhipin");
    assert.equal(offer.salaryText, want);
  }
});

test("toDiscoveredOffer: 至今零观测的 PUA 码点（E030）→ 不携带 salaryText", () => {
  // E030 至今零观测，未经实证不猜——含未映射码点的薪资归「薪资未知」。
  const offer = toDiscoveredOffer({ url: "https://x.com/3", title: "AI", salary: "1\uE030-15K" }, "zhipin");
  assert.equal(Object.prototype.hasOwnProperty.call(offer, "salaryText"), false);
  // 纯 PUA 无 ASCII 数字（旧乱码场景）同样不带
  const offer2 = toDiscoveredOffer({ url: "https://x.com/4", title: "AI", salary: "\uE030\uE030" }, "zhipin");
  assert.equal(Object.prototype.hasOwnProperty.call(offer2, "salaryText"), false);
});

test("toDiscoveredOffer: 混有未映射 PUA 的 ASCII 薪资 → 部分解码失真，整体归「薪资未知」", () => {
  const offer = toDiscoveredOffer({ url: "https://x.com/1", title: "AI", salary: "15-\uE0305K" }, "zhipin");
  assert.equal(Object.prototype.hasOwnProperty.call(offer, "salaryText"), false);
});

test("toDiscoveredOffer tolerates a missing platform by falling back to browser", () => {
  const offer = toDiscoveredOffer({ url: "https://x.com/1", title: "AI" });
  assert.equal(offer.source, "browser-browser"); // source 根缺省 browser
});
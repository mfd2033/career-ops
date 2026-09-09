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
});

test("toDiscoveredOffer without a city leaves location empty and drops city from note", () => {
  const offer = toDiscoveredOffer({ url: "https://www.zhipin.com/job_detail/1.html", title: "AI", company: "", city: "" }, "zhipin");
  assert.equal(offer.location, "");
  assert.equal(offer.note, "browser · zhipin");
  assert.equal(offer.company, "");
});

test("toDiscoveredOffer tolerates a missing platform by falling back to browser", () => {
  const offer = toDiscoveredOffer({ url: "https://x.com/1", title: "AI" });
  assert.equal(offer.source, "browser-browser"); // source 根缺省 browser
});
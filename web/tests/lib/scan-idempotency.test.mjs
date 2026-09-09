// scan-idempotency 纯逻辑单测(ADR-0007 E5 第二层):scanId 幂等去重 / TSV 落盘往返。
//
// Run:  node --test tests/lib/scan-idempotency.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { partitionNewOffers, loadScanMap, saveScanMap, scanIdempotencyPath } from "../../src/lib/scan-idempotency.mjs";

const mkOffer = (url) => ({ url, title: "AI", company: "", location: "", source: "browser-zhipin", note: "" });

// ── partitionNewOffers ──────────────────────────────────────────────────────

test("partition divides a batch into new vs skipped by (scanId, normalizedUrl)", () => {
  const map = new Map([["scan-a", new Set(["https://www.zhipin.com/job_detail/1.html"])]]);
  // 1 已写(同 URL 归一命中) + 1 新增(换一个职位)
  const { newOffers, skipped, keysToAdd } = partitionNewOffers(map, "scan-a", [
    mkOffer("https://www.zhipin.com/job_detail/1.html?ka=abc"),
    mkOffer("https://www.zhipin.com/job_detail/2.html"),
  ]);
  assert.equal(newOffers.length, 1);
  assert.equal(newOffers[0].url, "https://www.zhipin.com/job_detail/2.html");
  assert.equal(skipped, 1);
  assert.deepEqual(keysToAdd, ["https://www.zhipin.com/job_detail/2.html"]);
});

test("duplicate batch under the same scanId writes nothing (no new rows)", () => {
  const map = new Map([["s", new Set(["https://x.com/1"])]]);
  const { newOffers, skipped } = partitionNewOffers(map, "s", [mkOffer("https://x.com/1")]);
  assert.equal(newOffers.length, 0);
  assert.equal(skipped, 1);
});

test("differing scanIds are isolated (same URL can exist in both)", () => {
  const map = new Map([["s1", new Set(["https://x.com/1"])]]);
  const p1 = partitionNewOffers(map, "s1", [mkOffer("https://x.com/1")]);
  const p2 = partitionNewOffers(map, "s2", [mkOffer("https://x.com/1")]);
  assert.equal(p1.newOffers.length, 0);
  assert.equal(p2.newOffers.length, 1); // 另一个扫描会话不误杀
});

test("incremental batches sharing a scanId each keep their new URLs (no session-level nuke)", () => {
  const map = new Map([["s", new Set(["https://x.com/1"])]]);
  const p2 = partitionNewOffers(map, "s", [mkOffer("https://x.com/2"), mkOffer("https://x.com/3")]);
  assert.equal(p2.newOffers.length, 2); // 同 scanId 第二批,全新 URL → 照写
});

test("empty scanId passes the batch through untouched (legacy path)", () => {
  const { newOffers, skipped } = partitionNewOffers(new Map(), "", [mkOffer("https://x.com/1")]);
  assert.equal(newOffers.length, 1);
  assert.equal(skipped, 0);
});

test("invalid URLs are skipped, not written", () => {
  const { newOffers, skipped } = partitionNewOffers(new Map(), "s", [mkOffer("javascript:void(0)"), mkOffer("")]);
  assert.equal(newOffers.length, 0);
  assert.equal(skipped, 2);
});

// ── loadScanMap / saveScanMap round-trip ───────────────────────────────────

test("load/save round-trips a (scanId, url) table through TSV", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-idem-"));
  const file = path.join(dir, "scan-idempotency.tsv");
  try {
    const map = new Map([
      ["s1", new Set(["https://x.com/1", "https://x.com/2"])],
      ["s2", new Set(["https://x.com/3"])],
    ]);
    saveScanMap(file, map);
    const back = loadScanMap(file);
    assert.equal(back.size, 2);
    assert.deepEqual([...back.get("s1")], ["https://x.com/1", "https://x.com/2"]);
    assert.deepEqual([...back.get("s2")], ["https://x.com/3"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadScanMap tolerates a missing file (first run) and blank lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-idem-"));
  const file = path.join(dir, "nope.tsv");
  try {
    assert.equal(loadScanMap(file).size, 0); // 无表 → 空
    fs.writeFileSync(file, "\ns1\t\n\t\ns2\tkey\n");
    const map = loadScanMap(file);
    assert.equal(map.size, 1); // 只有 s2→key 合法,其余跳过
    assert.deepEqual([...map.get("s2")], ["key"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scanIdempotencyPath joins default filename under the given data dir", () => {
  assert.equal(scanIdempotencyPath("data"), "data/scan-idempotency.tsv");
  assert.equal(scanIdempotencyPath(""), ""); // 缺 dataDir → 空,防拼接根路径
});
// browser-progress.test.mjs — ADR-0069 逐平台进度纯逻辑单测。
//
// Run: node --test tests/lib/browser-progress.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { chipProgressPct, countByBoard, maxSnapshotByBoard } from "../../src/lib/browser-progress.mjs";
import { SCAN_MAX_DEFAULT } from "../../src/lib/scan-max.mjs";

test("countByBoard: 三站 URL 各归各桶（含 www 与子域）", () => {
  const keys = [
    "https://www.zhipin.com/job_detail/abc.html",
    "https://zhipin.com/job_detail/x.html",
    "https://liepin.com/job/1998394056.shtml",
    "https://fanyi.liepin.com/job/1.shtml",
    "https://www.zhaopin.com/jobdetail/CC123.htm",
  ];
  assert.deepEqual(countByBoard(keys), { zhipin: 2, liepin: 2, zhaopin: 1 });
});

test("countByBoard: 非三站与坏 URL 不进任何桶", () => {
  const keys = [
    "https://boards.greenhouse.io/company/jobs/123",
    "https://www.example.com/job",
    "not a url",
    "",
  ];
  assert.deepEqual(countByBoard(keys), { zhipin: 0, liepin: 0, zhaopin: 0 });
});

test("countByBoard: 空/缺省输入得到全 0 桶（路由向后兼容）", () => {
  assert.deepEqual(countByBoard([]), { zhipin: 0, liepin: 0, zhaopin: 0 });
  assert.deepEqual(countByBoard(undefined), { zhipin: 0, liepin: 0, zhaopin: 0 });
});

test("countByBoard: 不修改传入集合", () => {
  const set = new Set(["https://www.liepin.com/job/1.shtml"]);
  countByBoard(set);
  assert.equal(set.size, 1);
});

test("maxSnapshotByBoard: 单 target 平台直接落桶", () => {
  const targets = [{ source: "zhipin", maxCount: 400 }];
  assert.deepEqual(maxSnapshotByBoard(targets), { zhipin: 400, liepin: 0, zhaopin: 0 });
});

test("maxSnapshotByBoard: 猎聘拆词多 target 求和（ADR-0069 决议 3）", () => {
  const targets = [
    { source: "liepin", maxCount: 1200 },
    { source: "liepin", maxCount: 1200 },
    { source: "zhaopin", maxCount: 400 },
  ];
  assert.deepEqual(maxSnapshotByBoard(targets), { zhipin: 0, liepin: 2400, zhaopin: 400 });
});

test("maxSnapshotByBoard: 非法 maxCount 回落该站默认值（与 clampSafe 同口径）", () => {
  const targets = [
    { source: "liepin", maxCount: 0 },
    { source: "liepin", maxCount: "1200" },
    { source: "zhipin" },
  ];
  assert.deepEqual(maxSnapshotByBoard(targets), {
    zhipin: SCAN_MAX_DEFAULT.zhipin,
    liepin: SCAN_MAX_DEFAULT.liepin * 2,
    zhaopin: 0,
  });
});

test("maxSnapshotByBoard: 未知 source 与坏条目跳过，空输入得全 0", () => {
  assert.deepEqual(
    maxSnapshotByBoard([{ source: "greenhouse", maxCount: 400 }, null, { maxCount: 400 }]),
    { zhipin: 0, liepin: 0, zhaopin: 0 },
  );
  assert.deepEqual(maxSnapshotByBoard([]), { zhipin: 0, liepin: 0, zhaopin: 0 });
});
test("chipProgressPct: swept 有分母也满格（ADR-0069 决议 5：采完即满，不留残缺 bar）", () => {
  assert.equal(chipProgressPct({ done: 240, total: 400 }, "swept"), 100);
  assert.equal(chipProgressPct({ done: 0, total: 400 }, "swept"), 100);
  assert.equal(chipProgressPct(undefined, "swept"), 100);
});

test("chipProgressPct: active 按 done/total；queued 空；noisy 无分母满格、有分母定格", () => {
  assert.equal(chipProgressPct({ done: 120, total: 400 }, "active"), 30);
  assert.equal(chipProgressPct({ done: 400, total: 400 }, "active"), 100);
  assert.equal(chipProgressPct({ done: 5 }, "queued"), 0);
  assert.equal(chipProgressPct(undefined, "queued"), 0);
  assert.equal(chipProgressPct(undefined, "noisy"), 100);
  assert.equal(chipProgressPct({ done: 90, total: 400 }, "noisy"), 23);
});

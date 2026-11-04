// report-status-store 单测（ADR-0098 决议 4/5/7）：/api/report-status 的缓存与合流规则。
//
// WHY: 这条接口原先同步读 824 份报告（约 850ms 连续占住事件循环），三个并发请求
// 还把 `/api/version` 探针一起拖到 2.6 秒——托盘与扩展于是同时报「服务异常」。
// 修法不是"让它快一点"，而是三层签名缓存 + 异步读 + 并发合流。这些规则全在
// report-status-store.mjs 里，用假盘钉死：命中/失效边界错一次，用户就会看到
// 「刚评完的职位仍显示未评估」，或者每来一个请求就重读 6.3MB。
//
// Run:  node --test web/tests/lib/report-status-store.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createReportStatusStore } from "../../src/lib/report-status-store.mjs";

/**
 * 假盘：reports/ 里 name → { md, mtimeMs }；applications.md 交给签名桩。
 * 记录 stat/read 次数，用来断言"没有白干活"。
 */
function fakeDisk({ reports = {}, appsSignature = "apps-1", apps = [] } = {}) {
  const state = { reports: { ...reports }, appsSignature, apps, stats: 0, reads: 0, loads: 0 };
  const deps = {
    appsSignature: async () => state.appsSignature,
    listReports: async () => Object.keys(state.reports),
    numberIndex: (names) => {
      const index = new Map();
      for (const name of names.slice().sort()) {
        const num = parseInt(name, 10);
        if (!Number.isNaN(num) && !index.has(num)) index.set(num, name);
      }
      return index;
    },
    reportPathOf: (app, index) => {
      const name = index.get(parseInt(app.n, 10));
      return name ? `/reports/${name}` : null;
    },
    statFile: async (file) => {
      state.stats += 1;
      const name = file.replace("/reports/", "");
      const entry = state.reports[name];
      if (!entry) return null;
      return { mtimeMs: entry.mtimeMs, size: entry.md.length };
    },
    readUrl: async (file) => {
      state.reads += 1;
      const name = file.replace("/reports/", "");
      const entry = state.reports[name];
      if (!entry) return null;
      const found = /\*\*URL:\*\* (\S+)/.exec(entry.md);
      return found ? found[1] : null;
    },
    loadApps: async () => {
      state.loads += 1;
      return state.apps;
    },
    buildMap: (apps, urlByNum) => {
      const out = {};
      for (const app of apps) {
        if (urlByNum[app.n]) out[urlByNum[app.n]] = { reportNum: app.n };
      }
      return out;
    },
  };
  return { state, deps, store: createReportStatusStore(deps) };
}

const ROW_1 = { n: "1", report: "" };
const ROW_2 = { n: "2", report: "" };

test("首次构建逐份读报告，第二次一份都不重读（但仍按签名判新鲜）", async () => {
  const { state, store } = fakeDisk({
    apps: [ROW_1, ROW_2],
    reports: {
      "001-a.md": { md: "**URL:** https://a.example/1", mtimeMs: 1000 },
      "002-b.md": { md: "**URL:** https://b.example/2", mtimeMs: 1000 },
    },
  });

  const first = await store.get();
  assert.deepEqual(first, {
    "https://a.example/1": { reportNum: "1" },
    "https://b.example/2": { reportNum: "2" },
  });
  assert.equal(state.reads, 2);
  assert.equal(state.loads, 1);

  const statsAfterFirst = state.stats;
  const second = await store.get();
  assert.deepEqual(second, first);
  assert.equal(state.reads, 2, "内容未变 → 不再读报告正文");
  assert.equal(state.loads, 1, "tracker 签名未变 → 不再解析 applications.md");
  assert.equal(state.stats - statsAfterFirst, 2, "每份报告仍 stat 一次（in-place 改写要能发现）");
});

test("单份报告改写 → 只重读那一份", async () => {
  const { state, store } = fakeDisk({
    apps: [ROW_1, ROW_2],
    reports: {
      "001-a.md": { md: "**URL:** https://a.example/1", mtimeMs: 1000 },
      "002-b.md": { md: "**URL:** https://b.example/2", mtimeMs: 1000 },
    },
  });
  await store.get();
  assert.equal(state.reads, 2);

  state.reports["002-b.md"] = { md: "**URL:** https://b.example/fixed", mtimeMs: 2000 };
  const after = await store.get();
  assert.deepEqual(Object.keys(after).sort(), ["https://a.example/1", "https://b.example/fixed"]);
  assert.equal(state.reads, 3, "只有改动的那一份被重读（新报告不该让 824 份全部重来）");
});

test("报告被删掉 → URL 从结果里消失，缓存条目一并清掉", async () => {
  const { state, store } = fakeDisk({
    apps: [ROW_1, ROW_2],
    reports: {
      "001-a.md": { md: "**URL:** https://a.example/1", mtimeMs: 1000 },
      "002-b.md": { md: "**URL:** https://b.example/2", mtimeMs: 1000 },
    },
  });
  await store.get();
  delete state.reports["002-b.md"];

  const after = await store.get();
  assert.deepEqual(Object.keys(after), ["https://a.example/1"]);
  assert.equal(store.stats().urlEntries, 1, "幽灵缓存不该留着");
});

test("tracker 行变化 → 重新读行，但报告正文仍走缓存", async () => {
  const { state, store } = fakeDisk({
    apps: [ROW_1],
    reports: { "001-a.md": { md: "**URL:** https://a.example/1", mtimeMs: 1000 } },
  });
  await store.get();
  assert.equal(state.reads, 1);

  state.appsSignature = "apps-2";
  state.apps = [ROW_1, ROW_2];
  state.reports["002-b.md"] = { md: "**URL:** https://b.example/2", mtimeMs: 3000 };

  const after = await store.get();
  assert.deepEqual(Object.keys(after).sort(), ["https://a.example/1", "https://b.example/2"]);
  assert.equal(state.loads, 2, "签名变了要重读 tracker");
  assert.equal(state.reads, 2, "旧报告没变 → 仍不重读");
});

test("并发请求共享同一次构建（三个请求只读一遍报告）", async () => {
  const { state, store } = fakeDisk({
    apps: [ROW_1, ROW_2],
    reports: {
      "001-a.md": { md: "**URL:** https://a.example/1", mtimeMs: 1000 },
      "002-b.md": { md: "**URL:** https://b.example/2", mtimeMs: 1000 },
    },
  });

  const [a, b, c] = await Promise.all([store.get(), store.get(), store.get()]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(state.reads, 2, "合流失效会让三个请求各读一遍 824 份报告");
  assert.equal(state.loads, 1);
});

test("没有报告的行不产生 URL（缺报告 ≠ 未评估以外的东西）", async () => {
  const { state, store } = fakeDisk({
    apps: [ROW_1, ROW_2],
    reports: { "001-a.md": { md: "**URL:** https://a.example/1", mtimeMs: 1000 } },
  });
  const map = await store.get();
  assert.deepEqual(Object.keys(map), ["https://a.example/1"]);
  assert.equal(state.stats, 1, "只有能解析到报告的行才 stat（缺链的行不进 stat 循环）");
});

test("缺依赖 → 构造时报错（缓存层不许半残地跑起来）", () => {
  assert.throws(() => createReportStatusStore({}), /缺少依赖/);
  assert.throws(
    () =>
      createReportStatusStore({
        appsSignature: async () => "",
        listReports: async () => [],
        numberIndex: () => new Map(),
        reportPathOf: () => null,
        statFile: async () => null,
        readUrl: async () => null,
        loadApps: async () => [],
        // buildMap 缺失
      }),
    /buildMap/,
  );
});

test("invalidate() 丢掉 tracker 与目录缓存，不丢报告 URL 缓存（level=all 才全清）", async () => {
  const { state, store } = fakeDisk({
    apps: [ROW_1],
    reports: { "001-a.md": { md: "**URL:** https://a.example/1", mtimeMs: 1000 } },
  });
  await store.get();
  assert.equal(store.stats().reads, 1);

  store.invalidate();
  await store.get();
  assert.equal(state.loads, 2, "tracker 要重读");
  assert.equal(store.stats().reads, 1, "报告正文没变，不该重读");

  store.invalidate("all");
  await store.get();
  assert.equal(store.stats().reads, 2, "level=all 连报告缓存一起清");
});

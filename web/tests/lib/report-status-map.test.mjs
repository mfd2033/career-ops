// report-status-map 契约回归（工单 03 / ADR-0074 不变量一）：/api/report-status 的
// 装配规则——key 归一、首个 app 胜出、status 只放原始规范码。
//
// 「语言不进接口」是这里最要紧的一条：中文标签由扩展侧字典（detail-panel-pure.js）
// 映射，接口一旦开始吐中文，web 端换语言就得改扩展，契约也就再不是数据契约了。
//
// Run:  node --test web/tests/lib/report-status-map.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUrl } from "../../src/lib/core/url-key.mjs";
// 体检台账的「最近一次」口径只有一份定义（ADR-0025）：这里直接用真读者，确保契约
// 拼的是同一个 star，而不是自己再推一套「取最后一行」的近似规则。
import { checkupIndex } from "../../src/lib/company-checkups.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "web", "src", "lib", "report-status-map.mjs")).href);
const { buildReportStatusMap } = mod.default ?? mod;

const app = (o = {}) => ({ n: "1121", score: "4.3/5", status: "Applied", url: "https://www.zhipin.com/job_detail/1.html", ...o });
const URL_A = "https://www.zhipin.com/job_detail/1.html";
const URL_B = "https://www.liepin.com/job/2.shtml";
const assemble = (apps, deps = {}) => buildReportStatusMap(apps, { normalizeUrl, ...deps });

test("status 透传 tracker 原始规范值，接口里不出现任何中文", () => {
  const out = assemble([app({ status: "SKIP" })]);
  const entry = out[normalizeUrl(URL_A)];
  assert.equal(entry.status, "SKIP");
  assert.equal(JSON.stringify(out).match(/[\u4e00-\u9fff]/), null, "语言不进接口");
});

test("既有字段形状不变：{ score, reportNum, checkupStar } 是契约主体", () => {
  const out = assemble([app()]);
  assert.deepEqual(out[normalizeUrl(URL_A)], {
    score: "4.3/5",
    reportNum: "1121",
    status: "Applied",
    checkupStar: null,
  });
});

test("一个 URL 多行 → 首个 app 胜出，后来的行不覆盖先前的评估", () => {
  const out = assemble([app({ n: "1121", score: "4.3/5", status: "Applied" }), app({ n: "1188", score: "2.0/5", status: "Rejected" })]);
  assert.equal(Object.keys(out).length, 1);
  assert.equal(out[normalizeUrl(URL_A)].reportNum, "1121");
  assert.equal(out[normalizeUrl(URL_A)].status, "Applied");
});

test("不同 URL 各自建行，key 用 normalizeUrl（与 core.js 同源）", () => {
  const out = assemble([app(), app({ n: "12", url: URL_B + "?utm_source=push" })]);
  assert.deepEqual(Object.keys(out).sort(), [normalizeUrl(URL_A), normalizeUrl(URL_B)].sort());
});

test("tracker 行没有状态（空串 / 缺字段 / 只有空格）→ 省略 status，不放空串", () => {
  for (const status of ["", "   ", undefined]) {
    const out = assemble([app({ status })]);
    const entry = out[normalizeUrl(URL_A)];
    assert.equal("status" in entry, false, JSON.stringify(status));
    assert.equal(entry.score, "4.3/5", "缺状态不影响其余字段");
  }
});

test("状态带空格 → trim 后仍是规范码原样", () => {
  const out = assemble([app({ status: "  Interview  " })]);
  assert.equal(out[normalizeUrl(URL_A)].status, "Interview");
});

test("无 URL 的行直接跳过（报告缺失 / 非 http 链接）", () => {
  const out = assemble([app({ url: undefined }), app({ url: "" })]);
  assert.deepEqual(out, {});
});

test("urlOf 可注入：路由侧用报告头 URL，而不是 tracker 的 URL 列", () => {
  const rows = [{ n: "7", score: "5/5", status: "Hired", url: "https://stale.example/x" }];
  const out = buildReportStatusMap(rows, {
    normalizeUrl,
    urlOf: (a) => (a.n === "7" ? URL_B : undefined),
  });
  assert.deepEqual(Object.keys(out), [normalizeUrl(URL_B)]);
  assert.equal(out[normalizeUrl(URL_B)].status, "Hired");
});

test("空 tracker → 空 map；缺 normalizeUrl 直接抛错（不静默产出坏 key）", () => {
  assert.deepEqual(buildReportStatusMap([], { normalizeUrl }), {});
  assert.deepEqual(buildReportStatusMap(null, { normalizeUrl }), {});
  assert.throws(() => buildReportStatusMap([app()]), TypeError);
});

// ---- checkupStar（工单 04 / ADR-0074 不变量二）--------------------------
//
// 体检星只是展示信号，跟列表页的 sort 同一条约束（ADR-0064）：不进评分、不进
// 过滤、不进任何门禁。契约里它必须是「有就报、没有就 null」，绝不拿 null 当 0。

/** 同一 tracker# 两行历史（旧 3.0 / 新 4.5）的台账样本。 */
const LEDGER_1121 = [
  "1121\t2026-01-05\tacme\t某公司\t3.0\ttactics\treports/checkups/a.html\t旧",
  "1121\t2026-06-18\tacme\t某公司\t4.5\t-\treports/checkups/b.html\t新",
  "1188\t2026-07-01\tbother\t别家\t2.0\tarbitration\treports/checkups/c.html\t",
].join("\n");
const joinCheckup = (a) => checkupIndex(LEDGER_1121)[a.n]?.star ?? null;

test("有体检台账 → checkupStar 是数字；无台账 → null（键恒定存在）", () => {
  const done = assemble([app()], { checkupOf: joinCheckup });
  const other = assemble([app({ n: "9999" })], { checkupOf: joinCheckup });
  assert.equal(done[normalizeUrl(URL_A)].checkupStar, 4.5);
  assert.equal(other[normalizeUrl(URL_A)].checkupStar, null);
});

test("历史多行取最近日期的 star（复用 checkupIndex，不自推一套「取最后一行」）", () => {
  const out = assemble([app()], { checkupOf: joinCheckup });
  assert.equal(out[normalizeUrl(URL_A)].checkupStar, 4.5, "2026-06-18 的 4.5 而不是 2026-01-05 的 3.0");
});

test("checkupStar 不参与任何评分 / 过滤 / 门禁：分数原文不变、首个胜出规则不变", () => {
  // 同 URL 两行：胜出的是第一行（1121），体检星取的也是它自己的结论；后来行
  // （1188，自己体检过 2.0）既不能抢位，也不能把自己的星沾到胜出行上。
  const out = buildReportStatusMap([app({ n: "1121", status: "Applied" }), app({ n: "1188", score: "2.0/5", status: "Rejected" })], {
    normalizeUrl,
    checkupOf: joinCheckup,
  });
  const entry = out[normalizeUrl(URL_A)];
  assert.equal(entry.reportNum, "1121");
  assert.equal(entry.score, "4.3/5", "tracker 分数原文不动，不被体检星改写");
  assert.equal(entry.status, "Applied", "状态也不受体检影响");
  assert.equal(entry.checkupStar, 4.5, "取胜出那行（1121）自己的体检结论，不是后来行（1188）的 2.0");
});

test("缺 checkupOf / 台账读到垃圾 → 一律 null，不抛错也不出 NaN", () => {
  const noJoin = assemble([app()]);
  assert.equal(noJoin[normalizeUrl(URL_A)].checkupStar, null, "没接 join 时优雅降级");
  const junk = assemble([app()], { checkupOf: () => "不是数字" });
  assert.equal(junk[normalizeUrl(URL_A)].checkupStar, null);
  const nan = assemble([app()], { checkupOf: () => NaN });
  assert.equal(nan[normalizeUrl(URL_A)].checkupStar, null, "NaN 也不能泄漏进契约");
  // Number(null) 的 0 陷阱：未体检行读到 null 也不能变成「体检 0 分」。
  const zero = assemble([app()], { checkupOf: () => null });
  assert.equal(zero[normalizeUrl(URL_A)].checkupStar, null);
});

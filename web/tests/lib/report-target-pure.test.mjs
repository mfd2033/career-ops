// report-target-pure 纯逻辑单测（ADR-0055）：点击评分徽章时解析跳转目标——
// 候选筛选（origin + 端口区间粗判）、端口优先、「最近活跃」近似规则、同 URL 幂等、
// 端口探测失败/无候选两条兜底。无 chrome / DOM 依赖，直接 import
// extension/report-target-pure.js。
//
// Run:  node --test web/tests/lib/report-target-pure.test.mjs
//
// 放在 web/tests/lib 与同族扩展侧测试（badge-pure / single-eval-pure / scan-pure /
// wrapup-pure）同级，由 test-all.mjs 的 web/tests/lib 批次一并门住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "report-target-pure.js")).href);
const { pickReportTarget, parseWebTab, reportPath, reportUrl, urlKey, NO_SERVICE_ERROR, WEB_PORT_MIN, WEB_PORT_MAX } = mod.default ?? mod;

/** 造一个 chrome.tabs.query 形状的标签页。 */
const tab = (url, { id = 1, windowId = 1, active = false } = {}) => ({ id, windowId, active, url });

// ---- parseWebTab：什么算「本项目 web 端」 ----------------------------------

test("localhost:{3000-3040} 的 http 页是候选", () => {
  const c = parseWebTab(tab("http://localhost:3002/pipeline"));
  assert.equal(c.port, 3002);
});

test("127.0.0.1:{3000-3040} 同样算候选（手敲 IP 的 web 端）", () => {
  const c = parseWebTab(tab("http://127.0.0.1:3040/report/12"));
  assert.equal(c.port, 3040);
});

test("https / 不带端口 / 端口越界 / 非 web 页 一律不是候选", () => {
  assert.equal(parseWebTab(tab("https://localhost:3000/report/1")), null, "https 不在家规内");
  assert.equal(parseWebTab(tab("http://localhost/report/1")), null, "默认 80 端口不是家规端口");
  assert.equal(parseWebTab(tab(`http://localhost:${WEB_PORT_MIN - 1}/`)), null);
  assert.equal(parseWebTab(tab(`http://localhost:${WEB_PORT_MAX + 1}/`)), null);
  assert.equal(parseWebTab(tab("https://www.zhipin.com/job_detail/abc.html")), null, "招聘站页不是候选");
  assert.equal(parseWebTab(tab("chrome://extensions/")), null);
  assert.equal(parseWebTab({ id: 1, windowId: 1, active: false }), null, "无 url 字段");
  assert.equal(parseWebTab({ id: 1, windowId: 1, active: false, url: "not a url" }), null);
});

// ---- 两条兜底分支（ADR-0055 决策 8） --------------------------------------

test("端口探测失败 → error，即便有 web 页开着也不复用、不新开", () => {
  const r = pickReportTarget({
    livePort: null,
    tabs: [tab("http://localhost:3000/report/12")],
    currentWindowId: 1,
    num: 12,
  });
  assert.equal(r.action, "error");
  assert.equal(r.error, NO_SERVICE_ERROR);
});

test("报告号非法 → error（不拼 URL、不跳转）", () => {
  for (const num of ["", "abc", null, undefined]) {
    const r = pickReportTarget({ livePort: 3000, tabs: [], currentWindowId: 1, num });
    assert.equal(r.action, "error", `num=${String(num)}`);
    assert.equal(r.error, "无效报告号");
  }
});

test("服务活着但没有 web 端标签页 → 退回新开，URL 走 localhost", () => {
  const r = pickReportTarget({ livePort: 3003, tabs: [tab("https://www.zhipin.com/job_detail/x.html")], currentWindowId: 1, num: 7 });
  assert.deepEqual(r, { action: "create", url: "http://localhost:3003/report/7", path: "/report/7" });
});

test("报告号里的非数字被剥掉（#12 → 12）", () => {
  const r = pickReportTarget({ livePort: 3000, tabs: [], currentWindowId: 1, num: "#12" });
  assert.equal(r.url, "http://localhost:3000/report/12");
});

// ---- 端口优先 + 「最近活跃」近似规则（决策 3、4） -------------------------

test("端口命中优先于「活跃」：报告交给存活端口上的 web 页，不交给别的实例", () => {
  const active3010 = tab("http://localhost:3010/report/1", { id: 11, windowId: 1, active: true });
  const livePort3000 = tab("http://localhost:3000/report/1", { id: 22, windowId: 1 });
  const r = pickReportTarget({ livePort: 3000, tabs: [active3010, livePort3000], currentWindowId: 1, num: 12 });
  assert.equal(r.tabId, 22);
  assert.equal(r.url, "http://localhost:3000/report/12");
});

test("端口无命中 → 退到任意候选，当前窗口内 active 的最优先", () => {
  const a = tab("http://localhost:3000/pipeline", { id: 1, windowId: 1 });
  const b = tab("http://127.0.0.1:3001/report/2", { id: 2, windowId: 1, active: true });
  const r = pickReportTarget({ livePort: 3010, tabs: [a, b], currentWindowId: 1, num: 12 });
  assert.equal(r.tabId, 2);
});

test("同端口多窗口：当前窗口内的候选优先于别处 active 的那个", () => {
  const here = tab("http://localhost:3000/report/3", { id: 1, windowId: 1 });
  const elsewhereActive = tab("http://localhost:3000/jobs", { id: 2, windowId: 2, active: true });
  const r = pickReportTarget({ livePort: 3000, tabs: [elsewhereActive, here], currentWindowId: 1, num: 12 });
  assert.equal(r.tabId, 1);
  assert.equal(r.windowId, 1);
});

test("当前窗口内没有候选 → 看全库，同样是 active 优先", () => {
  const a = tab("http://localhost:3000/pipeline", { id: 1, windowId: 9 });
  const b = tab("http://localhost:3000/report/3", { id: 2, windowId: 9, active: true });
  const r = pickReportTarget({ livePort: 3000, tabs: [a, b], currentWindowId: 1, num: 12 });
  assert.equal(r.tabId, 2);
});

test("currentWindowId 未知（取不到窗口）时退化为全库首个", () => {
  const a = tab("http://localhost:3000/pipeline", { id: 1, windowId: 1 });
  const b = tab("http://localhost:3000/jobs", { id: 2, windowId: 2 });
  const r = pickReportTarget({ livePort: 3000, tabs: [a, b], currentWindowId: null, num: 12 });
  assert.equal(r.tabId, 1);
});

// ---- 同 URL 幂等（决策 6） ------------------------------------------------

test("目标标签页已在同一报告 URL → 只聚焦不重载", () => {
  const r = pickReportTarget({
    livePort: 3000,
    tabs: [tab("http://localhost:3000/report/12", { id: 5 })],
    currentWindowId: 1,
    num: 12,
  });
  assert.equal(r.action, "reuse");
  assert.equal(r.navigate, false);
});

test("尾斜杠与跟踪参数不算换了页面（幂等判定忽略 query/hash/尾斜杠）", () => {
  assert.equal(urlKey("http://localhost:3000/report/12/"), urlKey("http://localhost:3000/report/12"));
  assert.equal(urlKey("http://localhost:3000/report/12?from=ext#top"), urlKey("http://localhost:3000/report/12"));
});

test("停在别的报告页 → 需要导航", () => {
  const r = pickReportTarget({
    livePort: 3000,
    tabs: [tab("http://localhost:3000/report/9", { id: 5 })],
    currentWindowId: 1,
    num: 12,
  });
  assert.equal(r.navigate, true);
});

test("同端口但 host 是 127.0.0.1 → 仍导航一次（归一为 localhost 家规 origin）", () => {
  const r = pickReportTarget({
    livePort: 3000,
    tabs: [tab("http://127.0.0.1:3000/report/12", { id: 5 })],
    currentWindowId: 1,
    num: 12,
  });
  assert.equal(r.navigate, true);
  assert.equal(r.url, "http://localhost:3000/report/12");
});

// ---- reportPath / reportUrl：家规 + 前端路由目标 --------------------------

test("reportUrl 一律用 localhost（打开给用户看的页面走家规 origin）", () => {
  assert.equal(reportUrl(3007, "42"), "http://localhost:3007/report/42");
});

test("reuse 结果同时带 url 与 path：path 是 web 端的前端路由目标（不刷新跳转用）", () => {
  const r = pickReportTarget({
    livePort: 3000,
    tabs: [tab("http://localhost:3000/pipeline", { id: 5 })],
    currentWindowId: 1,
    num: 12,
  });
  assert.equal(r.path, "/report/12");
  assert.equal(reportPath("12"), "/report/12");
  assert.ok(r.url.endsWith(r.path), "整页 URL 必须以同一个 path 收尾（回退导航与前端路由指向同一张报告）");
});
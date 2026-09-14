// wrapup-pure 纯逻辑单测（ADR-0007 E9）：扫描收尾判定 / 探索页关闭后的中止判定。
// 无 chrome / DOM 依赖，直接 import extension/wrapup-pure.js。
//
// Run:  node --test web/tests/lib/wrapup-pure.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "wrapup-pure.js")).href);
const { REASON, decideWrapUp, decideAfterExploreGone, decideDeadDrives } = mod.default ?? mod;

const SCAN = "scan-1";
/** 登记快照里一条驱动的最小形状（key 只为可读，判定只认 scanId）。 */
const drive = (scanId, key = `liepin|${scanId}`) => ({ key, scanId });
/** 默认输入：单平台扫描结束、登记表已摘空、开关开、探索页 tab 记录在案、未收尾过。 */
const base = (over = {}) => ({
  drives: [],
  scanId: SCAN,
  wrapUpEnabled: true,
  exploreTabId: 42,
  wrappedUpScans: [],
  ...over,
});

test("last platform finished → activate the explore tab, once", () => {
  const d = decideWrapUp(base());
  assert.equal(d.settle, true);
  assert.equal(d.scanId, SCAN);
  assert.equal(d.activateTabId, 42);
  assert.equal(d.reason, REASON.ACTIVATED);
});

test("still-active: 同 scanId 的其它驱动（猎聘拆词）还在采 → 不收尾", () => {
  const d = decideWrapUp(base({ drives: [drive(SCAN), drive(SCAN, "liepin|scan-1#b")] }));
  assert.equal(d.settle, false);
  assert.equal(d.activateTabId, null);
  assert.equal(d.reason, REASON.STILL_ACTIVE);
});

test("归口：别的 scanId 的残留登记不参与判定，压不住本次收尾", () => {
  // 上一次扫描的登记没被摘掉（tab 消失得连 onRemoved 都没赶上）——它是别的 scanId，
  // 不该让本次扫描永远收不了尾。
  const d = decideWrapUp(base({ drives: [drive("scan-old", "zhipin|https://x/")] }));
  assert.equal(d.settle, true);
  assert.equal(d.activateTabId, 42);
});

test("归口：本次与残留同时存在时，仍以本次的登记为准", () => {
  const still = decideWrapUp(base({ drives: [drive(SCAN), drive("scan-old")] }));
  assert.equal(still.settle, false);
  assert.equal(still.reason, REASON.STILL_ACTIVE);
});

test("idempotent: 同一 scanId 第二次判定不再切焦点", () => {
  const d = decideWrapUp(base({ wrappedUpScans: [SCAN] }));
  assert.equal(d.settle, false);
  assert.equal(d.activateTabId, null);
  assert.equal(d.reason, REASON.ALREADY);
});

test("idempotent: 只认这个 scanId，别的 scanId 的历史记录不挡", () => {
  const d = decideWrapUp(base({ wrappedUpScans: ["scan-0", "scan-old"] }));
  assert.equal(d.settle, true);
  assert.equal(d.activateTabId, 42);
});

test("switch off → 不切焦点，但仍要把这次扫描标记为已收尾", () => {
  const d = decideWrapUp(base({ wrapUpEnabled: false }));
  assert.equal(d.settle, true);
  assert.equal(d.scanId, SCAN);
  assert.equal(d.activateTabId, null);
  assert.equal(d.reason, REASON.DISABLED);
});

test("探索页 tab 不可用（用户已关掉） → 收尾但什么都不切", () => {
  for (const exploreTabId of [null, undefined]) {
    const d = decideWrapUp(base({ exploreTabId }));
    assert.equal(d.settle, true);
    assert.equal(d.activateTabId, null);
    assert.equal(d.reason, REASON.NO_EXPLORE_TAB);
  }
});

test("tabId 为 0 是合法 id，不能被当成不可用", () => {
  const d = decideWrapUp(base({ exploreTabId: 0 }));
  assert.equal(d.activateTabId, 0);
  assert.equal(d.reason, REASON.ACTIVATED);
});

test("没有 scanId 就无从归口 → 不动，也不记幂等账", () => {
  for (const scanId of [null, undefined, "", "   "]) {
    const d = decideWrapUp(base({ scanId }));
    assert.equal(d.settle, false);
    assert.equal(d.activateTabId, null);
    assert.equal(d.reason, REASON.NO_SCAN_ID);
  }
});

test("全平台启动就失败：登记表本来就空 → 一样要收尾（05 用例）", () => {
  const d = decideWrapUp(base({ drives: [], scanId: "scan-all-failed" }));
  assert.equal(d.settle, true);
  assert.equal(d.activateTabId, 42);
});

test("空输入不抛错（事件竞态下可能拿到空快照）", () => {
  // 没有 scanId 就无从归口 → 什么都不做（也不记幂等账）。
  for (const input of [undefined, {}, { drives: [] }, { drives: null }]) {
    const d = decideWrapUp(input);
    assert.equal(d.settle, false);
    assert.equal(d.activateTabId, null);
  }
  // 有 scanId 但登记快照缺失/为 null → 等价于"本次没有登记在跑"，照常收尾（与 05 同形）。
  const d = decideWrapUp(base({ drives: null }));
  assert.equal(d.settle, true);
  assert.equal(d.activateTabId, 42);
});

test("探索页被关 → 停掉全部采集 tab 并摘掉全部登记", () => {
  const d = decideAfterExploreGone({
    drives: [
      { key: "zhipin|https://www.zhipin.com/web/geek/job?query=a", tabId: 7 },
      { key: "liepin|https://www.liepin.com/zhaopin/?key=a", tabId: 8 },
    ],
  });
  assert.deepEqual(d.stopTabIds, [7, 8]);
  assert.deepEqual(d.clearKeys, [
    "zhipin|https://www.zhipin.com/web/geek/job?query=a",
    "liepin|https://www.liepin.com/zhaopin/?key=a",
  ]);
});

test("探索页被关：不按 scanId 归口 —— 别的 scanId 的采集也要停", () => {
  const d = decideAfterExploreGone({
    drives: [{ key: "k-old", tabId: 5, scanId: "scan-old" }, { key: "k-new", tabId: 6, scanId: SCAN }],
  });
  assert.deepEqual(d.stopTabIds, [5, 6]);
});

test("探索页被关的判定不接开关：签名里没有 wrapUpEnabled，行为与之无关", () => {
  // 传进去也不该改变结果 —— 这条钉住 ADR-0007 E9「本动作不受收尾开关管辖」。
  const withFlag = decideAfterExploreGone({ drives: [{ key: "k", tabId: 3 }], wrapUpEnabled: false });
  assert.deepEqual(withFlag, { stopTabIds: [3], clearKeys: ["k"] });
});

test("探索页被关：无采集在跑 / 字段缺失时不产出动作，且不抛错", () => {
  assert.deepEqual(decideAfterExploreGone({ drives: [] }), { stopTabIds: [], clearKeys: [] });
  assert.deepEqual(decideAfterExploreGone({}), { stopTabIds: [], clearKeys: [] });
  assert.deepEqual(decideAfterExploreGone(), { stopTabIds: [], clearKeys: [] });
  assert.deepEqual(decideAfterExploreGone({ drives: [null, {}, { tabId: "8" }] }), { stopTabIds: [], clearKeys: [] });
});

// ── 存活探测（06 / ADR-0007 E10）──────────────────────────────────────────────
const live = (key, scanId = SCAN) => ({ key, scanId, started: true });

test("探活：明确答活着 → 不判死", () => {
  const d = decideDeadDrives({ drives: [live("a"), live("b")], probes: [{ key: "a", alive: true }, { key: "b", alive: true }] });
  assert.deepEqual(d, { deadKeys: [], scanId: null });
});

test("探活：答不在采集（被站点重注入的新实例）→ 判死", () => {
  const d = decideDeadDrives({ drives: [live("a")], probes: [{ key: "a", alive: false }] });
  assert.deepEqual(d, { deadKeys: ["a"], scanId: SCAN });
});

test("探活：无应答（sendMessage 抛错 / 内容脚本被换掉）→ 判死（fail-closed）", () => {
  const d = decideDeadDrives({ drives: [live("a")], probes: [] });
  assert.deepEqual(d, { deadKeys: ["a"], scanId: SCAN });
});

test("探活：还没完成启动握手 → 不判死（让开内容脚本尚未注入的窗口）", () => {
  const starting = { key: "a", scanId: SCAN, started: false };
  assert.deepEqual(decideDeadDrives({ drives: [starting], probes: [] }), { deadKeys: [], scanId: null });
  // 同一批里，握完手的照常判死，没握手的留着。
  const d = decideDeadDrives({ drives: [starting, live("b")], probes: [{ key: "b", alive: false }] });
  assert.deepEqual(d, { deadKeys: ["b"], scanId: SCAN });
});

test("探活：只判死该判死的，活着的登记原样留着", () => {
  const d = decideDeadDrives({
    drives: [live("a"), live("b"), live("c")],
    probes: [{ key: "a", alive: true }, { key: "b", alive: false }, { key: "c", alive: true }],
  });
  assert.deepEqual(d.deadKeys, ["b"]);
});

test("探活：scanId 取死掉登记里第一个非空值", () => {
  const d = decideDeadDrives({
    drives: [live("a", "scan-x"), live("b", "scan-y")],
    probes: [{ key: "a", alive: false }, { key: "b", alive: false }],
  });
  assert.deepEqual(d, { deadKeys: ["a", "b"], scanId: "scan-x" });
});

test("探活：空输入 / 字段缺失不抛错，也不凭空判死", () => {
  for (const input of [undefined, {}, { drives: [] }, { drives: null, probes: null }]) {
    assert.deepEqual(decideDeadDrives(input), { deadKeys: [], scanId: null });
  }
  assert.deepEqual(decideDeadDrives({ drives: [null, {}, { key: "", started: true }] }), { deadKeys: [], scanId: null });
});

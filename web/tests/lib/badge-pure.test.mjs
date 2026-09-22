// badge-pure 纯逻辑单测（ADR-0050）：徽章刷新的节流判定 + 连接态视觉映射。
// 无 chrome / DOM 依赖，直接 import extension/badge-pure.js。
//
// Run:  node --test web/tests/lib/badge-pure.test.mjs
//
// 放在 web/tests/lib 与同族扩展侧测试（scan-pure / wrapup-pure）同级，由
// test-all.mjs 的 web/tests/lib 批次一并门住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "badge-pure.js")).href);
const {
  decideBadge,
  badgeVisual,
  BADGE_GREEN,
  BADGE_RED,
  BADGE_TEXT_CONNECTED,
  BADGE_TEXT_DISCONNECTED,
  BADGE_THROTTLE_MS,
} = mod.default ?? mod;

// ---- decideBadge：要不要真的重新扫端口 ------------------------------------

test("首次刷新（结果未知 lastConnected=null）必须探测", () => {
  const d = decideBadge({ now: 1000, lastAt: 0, lastConnected: null, force: false });
  assert.equal(d.probe, true);
  assert.equal(d.throttled, false);
  assert.equal(d.connected, null);
});

test("force 绕过节流，即便刚扫过也要重探", () => {
  const d = decideBadge({ now: 1001, lastAt: 1000, lastConnected: true, force: true });
  assert.equal(d.probe, true);
  assert.equal(d.throttled, false);
});

test("节流窗口内的非强制刷新 → 复用上次结果、不探测", () => {
  const d = decideBadge({
    now: 1000 + (BADGE_THROTTLE_MS - 1),
    lastAt: 1000,
    lastConnected: true,
    force: false,
  });
  assert.equal(d.probe, false);
  assert.equal(d.throttled, true);
  assert.equal(d.connected, true);
});

test("节流窗口内上次是未连接 → 复用为 false（不是 null）", () => {
  const d = decideBadge({ now: 1000, lastAt: 1000, lastConnected: false, force: false });
  assert.equal(d.probe, false);
  assert.equal(d.throttled, true);
  assert.equal(d.connected, false);
});

test("达到/超过节流窗口 → 重新探测", () => {
  const at = decideBadge({ now: 1000 + BADGE_THROTTLE_MS, lastAt: 1000, lastConnected: true, force: false });
  assert.equal(at.probe, true, "恰好等于窗口应重探");
  const over = decideBadge({ now: 1000 + BADGE_THROTTLE_MS + 1, lastAt: 1000, lastConnected: true, force: false });
  assert.equal(over.probe, true);
});

test("默认节流窗口就是 BADGE_THROTTLE_MS（可无参调用）", () => {
  const d = decideBadge({ now: 1000, lastAt: 1000, lastConnected: true });
  assert.equal(d.throttled, true);
});

// ---- badgeVisual：连接态 → 文案 + 底色 ------------------------------------

test("badgeVisual(true) → 连接文案 + 绿底", () => {
  assert.deepEqual(badgeVisual(true), { text: BADGE_TEXT_CONNECTED, color: BADGE_GREEN });
});

test("badgeVisual(false) → 断连文案 + 红底", () => {
  assert.deepEqual(badgeVisual(false), { text: BADGE_TEXT_DISCONNECTED, color: BADGE_RED });
});

test("断连文案必须是纯 ASCII（渲染最稳）", () => {
  assert.match(BADGE_TEXT_DISCONNECTED, /^[\x00-\x7F]+$/);
});

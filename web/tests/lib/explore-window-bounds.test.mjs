// explore-window-bounds 纯逻辑单测（ADR-0066）：下半屏采集窗口按 N 等宽平铺。
// 无 DOM / chrome 依赖，直接 import lib。
//
// Run:  node --test web/tests/lib/explore-window-bounds.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { computeBottomHalfBounds } = await import(
  pathToFileURL(join(ROOT, "web", "src", "lib", "explore-window-bounds.mjs")).href
);

// 1920×1080、无任务栏偏移的可用区（availTop=0, availLeft=0）。
const SCREEN = { availLeft: 0, availTop: 0, availWidth: 1920, availHeight: 1080 };

test("N=1：满宽半屏，铺下半部", () => {
  const b = computeBottomHalfBounds(1, SCREEN);
  assert.equal(b.length, 1);
  assert.deepEqual(b[0], { left: 0, top: 540, width: 1920, height: 540 });
});

test("N=2：各半宽，左右并排，等高下半屏", () => {
  const b = computeBottomHalfBounds(2, SCREEN);
  assert.equal(b.length, 2);
  assert.deepEqual(b[0], { left: 0, top: 540, width: 960, height: 540 });
  assert.deepEqual(b[1], { left: 960, top: 540, width: 960, height: 540 });
});

test("N=3：各⅓宽并排", () => {
  const b = computeBottomHalfBounds(3, SCREEN);
  assert.equal(b.length, 3);
  assert.deepEqual(b[0], { left: 0, top: 540, width: 640, height: 540 });
  assert.deepEqual(b[1], { left: 640, top: 540, width: 640, height: 540 });
  assert.deepEqual(b[2], { left: 1280, top: 540, width: 640, height: 540 });
});

test("末窗吸收整除余数，右侧不留缝", () => {
  // 1000 宽 3 窗：per=333，前两窗 333+333，末窗应为 334 铺到 1000。
  const b = computeBottomHalfBounds(3, { availWidth: 1000, availHeight: 800, availLeft: 0, availTop: 0 });
  assert.equal(b[0].width, 333);
  assert.equal(b[1].width, 333);
  assert.equal(b[2].width, 334);
  assert.equal(b[2].left + b[2].width, 1000);
});

test("非零可用原点整体平移（多显示器/任务栏偏移）", () => {
  const b = computeBottomHalfBounds(2, { availLeft: 1920, availTop: 0, availWidth: 1280, availHeight: 720 });
  assert.deepEqual(b[0], { left: 1920, top: 360, width: 640, height: 360 });
  assert.deepEqual(b[1], { left: 2560, top: 360, width: 640, height: 360 });
});

test("N=0 返回空数组；缺 screen 不炸", () => {
  assert.deepEqual(computeBottomHalfBounds(0, SCREEN), []);
  assert.deepEqual(computeBottomHalfBounds(-3, SCREEN), []);
  assert.equal(computeBottomHalfBounds(2).length, 2); // screen 缺省全 0，不抛
});

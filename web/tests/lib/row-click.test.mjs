// 收件箱行点击选中的判定纯函数测试（ADR-0060 决议 1/3/7）+ 行光标源码守卫
// （ADR-0062 增补 #2：「点行 = 勾选的行用默认箭头」升级为通用规范后覆盖收件箱）。
// 零 DOM 依赖：入参用结构化最小对象（带 closest 的假元素 / 坐标点 / 选区形状），
// 组件侧只剩事件接线；源码守卫同 pipeline-single-nav-entry.test.mjs 口径——
// 先剥注释、在语义切片上量，不在散文中计数。
//
// Run:  node --test tests/lib/row-click.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ROW_CLICK_EXEMPT_SELECTOR,
  DRAG_THRESHOLD_PX,
  isExemptClickTarget,
  isDragGesture,
  isTextSelectionActive,
} from "../../src/lib/row-click.mjs";

// 假元素：closest 命中给定选择器时返回自身，否则 null。
function fakeEl(hit) {
  return { closest: (sel) => (hit ? { sel } : null) };
}

test("排除选择器逐字锁定 — a/button/input 三类控件", () => {
  assert.equal(ROW_CLICK_EXEMPT_SELECTOR, "a,button,input");
});

test("拖拽阈值逐字锁定 — 5px 是 ADR-0060 的工程常数", () => {
  assert.equal(DRAG_THRESHOLD_PX, 5);
});

test("命中交互控件（或其后代）的点击被排除", () => {
  // closest 语义已在浏览器端覆盖后代冒泡，这里只需模拟命中/未命中两分支。
  assert.equal(isExemptClickTarget(fakeEl(true)), true);
  assert.equal(isExemptClickTarget(fakeEl(false)), false);
});

test("无 closest 能力的目标保守排除 — 判不了就不切换", () => {
  assert.equal(isExemptClickTarget(null), true);
  assert.equal(isExemptClickTarget(undefined), true);
  assert.equal(isExemptClickTarget({}), true);
});

test("位移恰等于阈值不算拖拽，超过才算", () => {
  const down = { x: 100, y: 50 };
  assert.equal(isDragGesture(down, { x: 105, y: 50 }), false); // 恰 5px
  assert.equal(isDragGesture(down, { x: 106, y: 50 }), true); // 6px
  assert.equal(isDragGesture(down, { x: 103, y: 54 }), false); // 斜向 5px
  assert.equal(isDragGesture(down, { x: 104, y: 54 }), true); // 斜向 ≈5.66px
});

test("缺少按下记录不视为拖拽 — 无参照时放行切换", () => {
  assert.equal(isDragGesture(null, { x: 100, y: 100 }), false);
});

test("非折叠选区判为拖选复制 — 抑制行点击", () => {
  assert.equal(isTextSelectionActive({ isCollapsed: false }), true);
  assert.equal(isTextSelectionActive({ isCollapsed: true }), false);
});

test("无选区对象（环境不支持）保守放行", () => {
  assert.equal(isTextSelectionActive(null), false);
  assert.equal(isTextSelectionActive(undefined), false);
});

// —— 源码守卫（ADR-0062 增补 #2）——
// TSX 不可在 node --test 里导入（web 组件无渲染测试基建，ADR-0057/0059/0060
// 同口径），光标规范是纯声明式的结构事实，只能钉源码。没有守卫，下次有人
// 「为了方便」把 cursor-pointer 加回 <li> 不会有任何东西变红（ADR-0060 决议 6
// 原文就是这么写的）。量之前先剥注释：接线处的解释性注释提到字面量，不剥就假红。

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TRIAGE_SRC = readFileSync(join(WEB, "src", "components", "inbox", "triage-row.tsx"), "utf8");

function stripComments(src) {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
}

const TRIAGE_CODE = stripComments(TRIAGE_SRC);

test("收件箱数据行 <li> 不挂 cursor-pointer — 点行只是勾选，手型留给真链接", () => {
  // 语义切片：从 <li 到行首 checkbox 之前，覆盖行的全部 className；行内控件的
  // 手型（标题 <a>、徽章 <Link>、按钮）不在本规则约束内，不归本切片量。
  const start = TRIAGE_CODE.indexOf("<li");
  assert.ok(start > 0, "triage-row.tsx 结构变了 — 未找到 <li>，本断言需随宿主改写");
  const end = TRIAGE_CODE.indexOf("<input", start);
  assert.ok(end > start, "未找到行首 checkbox — 结构变了，本断言需随宿主改写");
  assert.ok(!/cursor-pointer/.test(TRIAGE_CODE.slice(start, end)),
    "数据行不该用 cursor-pointer；可勾选线索靠 hover 底色，不靠光标（ADR-0062 增补 #2）");
});

test("收件箱 checkbox 显式保留手型 — 与 tracker 表勾选框对齐", () => {
  // <li> 摘掉手型后，勾选框若靠继承会变箭头，与 tracker（pipeline-view.tsx 显式
  // cursor-pointer）不一致——两表同一控件一个手型一个箭头就是新困惑点。
  const input = TRIAGE_CODE.match(/<input[\s\S]*?\/>/)?.[0];
  assert.ok(input, "未找到 checkbox <input> — 结构变了，本断言需随宿主改写");
  assert.match(input, /cursor-pointer/,
    "勾选框是原生控件，必须显式挂手型与 tracker 对齐");
});

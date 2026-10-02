// bsk-progress-wiring.test.mjs — ADR-0069 接线守卫（源码级单测）。
//
// provider/chip 的 React 态无法在 node:test 里跑（known gap，ADR-0057/0061 同口径），
// 这里用源码字符串守卫把关键接线锁住：轮询必须把 perSource/maxSnap 灌进 sources、
// chip 必须按 isBrowser 才显数。任何一侧断线，本测试先红。
//
// Run: node --test tests/lib/bsk-progress-wiring.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const provider = readFileSync(join(here, "../../src/components/explore/explore-provider.tsx"), "utf8");
const chips = readFileSync(join(here, "../../src/components/explore/discovering-state.tsx"), "utf8");

/** 剥块注释后再断言，防止注释里的字面量冒充接线证据（守卫单测惯例）。 */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("provider: 轮询把 perSource 与分母快照灌进 sources", () => {
  const src = strip(provider);
  assert.match(src, /maxSnapshotByBoard\(driveTargets\)/, "分母快照必须来自 driveTargets（与驱动消息同一份列表）");
  assert.match(src, /driveTargets\.map|sources: driveTargets/, "drive-scan 消息与快照共用 driveTargets");
  assert.match(src, /progress\.perSource/, "scan-progress 的 perSource 必须被消费");
  assert.match(src, /done: perSource\[id\][\s\S]*total: maxSnap\[id\]/, "每轮轮询按平台灌 done/total");
  assert.match(src, /finalPerSource\[k\]/, "收尾要再读一次 scan-progress，✓n 定格在真实采到数");
});

test("provider: active 列表驱动 chip 状态机（浏览器模式不再全程 queued）", () => {
  const src = strip(provider);
  assert.match(src, /everActive\.add\(a\)/, "active 平台要登记，消失即转 swept");
  assert.match(src, /if \(activeSet\.has\(id\)\) state = "active"/, "active 判定：在 active 列表即 active");
  assert.match(src, /else if \(everActive\.has\(id\)\) state = "swept"/, "曾 active 后消失即 swept");
});

test("chips: 数字只在浏览器模式显示，ATS 分支不带数字", () => {
  const src = strip(chips);
  assert.match(src, /!isBrowser \|\| !s\?\.total/, "显数门 = 浏览器模式且分母已知");
  assert.match(src, /`—\/\$\{s\.total\}`/, "queued 显示 —/上限");
  assert.match(src, /`✓ \$\{s\.done \?\? 0\}`/, "swept 显示 ✓ n");
  assert.match(src, /`\$\{s\.done \?\? 0\}\/\$\{s\.total\}`/, "active 显示 n/上限");
  assert.match(src, /isBrowser=\{isBrowser\}/, "DiscoveringState 把 isBrowser 传进 chip");
});

test("chips: swept 的 bar/数字转绿且只限浏览器引擎（ATS 视觉不变）", () => {
  const src = strip(chips);
  assert.match(src, /\[data-engine="browser"\]\[data-state="swept"\] \.co-src__bar\{background:hsl\(160/, "swept bar 绿仅限 browser 引擎");
  assert.match(src, /\[data-state="swept"\] \.co-src__num\{color:hsl\(160/, "swept 数字绿");
  assert.match(src, /data-engine=\{isBrowser \? "browser" : "ats"\}/, "chip 带引擎标记供 CSS 收口");
  assert.match(src, /co-src__num\{font-variant-numeric:tabular-nums/, "数字用 tabular-nums 防跳动");
});

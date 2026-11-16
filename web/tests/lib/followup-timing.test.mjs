// 跟进时机（ADR-0102）接线守卫：组件无测试面（ADR-0077），逻辑全部下沉在
// delivery-window.mjs / source-label.mjs 既有纯函数里，这里只锁「接线正确 +
// 不出现第二份口径」。风格沿用 delivery-window.test.mjs 的 UI 接线守卫。
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ── i18n：键对称 + 新键存在 ──────────────────────────────────────────────

test("i18n：followups 语料簇 en/zh 键集合对称且同序", () => {
  const src = readFileSync(join(here, "../../src/lib/i18n/clusters/followups.ts"), "utf8");
  const keys = [...src.matchAll(/"([^"]+)":\s*"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0 && keys.length % 2 === 0, "语料簇应分成 en/zh 两块等量键");
  const half = keys.length / 2;
  assert.deepEqual(keys.slice(0, half), keys.slice(half));
});

test("i18n：跟进时机列头与列提示键在 en/zh 两块都存在", () => {
  const src = readFileSync(join(here, "../../src/lib/i18n/clusters/followups.ts"), "utf8");
  for (const key of ["followups.col.timing", "followups.colHint.timing"]) {
    const hits = src.split(key).length - 1;
    assert.equal(hits, 2, `${key} 应在 en 与 zh 两块各出现一次`);
  }
});

// ── 组件接线：三处挂载点 ─────────────────────────────────────────────────

test("组件接线：跟进页表格挂上了跟进时机列（列头走 i18n，行体传 postingUrl）", () => {
  const view = readFileSync(join(here, "../../src/components/followups/followups-view.tsx"), "utf8");
  assert.match(view, /import \{[^}]*\bFollowupTimingBadge\b[^}]*\} from "@\/components\/followups\/followup-timing-badge"/);
  assert.match(view, /t\("followups\.col\.timing"\)/);
  assert.match(view, /<FollowupTimingBadge postingUrl=\{e\.postingUrl\} \/>/);
  // 展开行 colSpan 随新列 +1（COLUMNS 之外还有展开箭头/报告号/跟进时机/操作 4 列）
  assert.match(view, /colSpan=\{COLUMNS\.length \+ 4\}/);
});

test("组件接线：今日页待跟进卡片挂上了跟进时机徽章", () => {
  const card = readFileSync(join(here, "../../src/components/home/follow-up-card.tsx"), "utf8");
  assert.match(card, /import \{ FollowupTimingBadge \} from "@\/components\/followups\/followup-timing-badge"/);
  assert.match(card, /<FollowupTimingBadge postingUrl=\{followup\.postingUrl\} \/>/);
});

test("组件接线：报告详情页仍是单平台 DeliveryTimeHint，未重复挂第二条条", () => {
  const reportView = readFileSync(join(here, "../../src/components/report-view.tsx"), "utf8");
  assert.match(reportView, /import \{ DeliveryTimeHint \} from "@\/components\/delivery-time-hint"/);
  assert.doesNotMatch(reportView, /FollowupTimingBadge/, "报告页同矩阵同平台，不该再挂跟进徽章");
});

// ── 单一口径：徽章复用既有引擎，不建第二份矩阵 ──────────────────────────

test("单一口径：徽章复用 windowAt/sourcePlatform/LEVEL_TONE，源码中无第二份矩阵", () => {
  const badge = readFileSync(join(here, "../../src/components/followups/followup-timing-badge.tsx"), "utf8");
  assert.match(badge, /windowAt\(platform, now\)/);
  assert.match(badge, /sourcePlatform\(postingUrl\)/);
  assert.match(badge, /LEVEL_TONE\[level\]/);
  // 文案复用 delivery.* 既有键（chip/level/platform/windowNow/next/noSource）
  assert.match(badge, /t\("delivery\.chip"/);
  assert.match(badge, /t\("delivery\.noSource"\)/);
  // 不出现第二份矩阵或新造等级枚举
  assert.doesNotMatch(badge, /BOSS_WINDOWS|OUTBOUND_WINDOWS/);
  // 组件正文不应含硬编码中文（注释除外）
  const code = badge.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /[\u4e00-\u9fa5]/, "组件正文不应含硬编码中文（注释除外）");
});

// ── 服务端：postingUrl 经 readApplicationUrls 批量装配 ───────────────────

test("服务端：readCadencePayload 用 readApplicationUrls 批量挂 postingUrl", () => {
  const server = readFileSync(join(here, "../../src/lib/followups-server.ts"), "utf8");
  assert.match(server, /readApplicationUrls\(/);
  assert.match(server, /postingUrl: urlMap\[String\(e\.num\)\] \?\? null/);
  // 单点提取：不允许再出现自写的报告头 URL 解析
  assert.match(server, /import \{[^}]*\breadApplicationUrls\b[^}]*\} from "@\/lib\/career-ops"/);
});

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "../../src");
const read = (relative) => readFileSync(join(SRC, relative), "utf8");

const COMPONENTS = [
  "components/cost/cost-hint.tsx",
  "components/quick-evaluate.tsx",
  "components/generate-pdf-button.tsx",
  "components/reevaluate-button.tsx",
  "components/inbox/shortlist-tray.tsx",
  "components/explore/ai-search-box.tsx",
  "components/explore/explore-mode-toggle.tsx",
  "components/explore/results-list.tsx",
];

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test("成本提示只保留消耗 tokens 一种：图标 + 悬浮说明", () => {
  const hint = read("components/cost/cost-hint.tsx");
  assert.match(hint, /CircleAlert/, "图标应为圆圈内感叹号");
  assert.match(hint, /t\("shared\.cost\.spendTip"\)/, "悬浮说明走 spendTip 文案");
  assert.match(hint, /aria-label=\{t\("shared\.cost\.spend"\)\}/, "无障碍标签为「消耗 tokens」");
});

test("旧的 CostBadge 徽章及其样式已彻底移除", () => {
  assert.equal(existsSync(join(SRC, "components/cost/cost-badge.tsx")), false);
  const offenders = walk(SRC)
    .filter((file) => /\.(tsx?|css)$/.test(file))
    .filter((file) => /CostBadge|co-cost/.test(readFileSync(file, "utf8")));
  assert.deepEqual(offenders, [], "不得残留 CostBadge / .co-cost 引用");
});

test("所有原先挂徽章的操作点改用 CostHint", () => {
  for (const relative of COMPONENTS.slice(1)) {
    assert.match(read(relative), /<CostHint\b/, `${relative} 应使用 CostHint`);
  }
  const results = read("components/explore/results-list.tsx");
  assert.match(results, /\{isAi && <CostHint /, "免费扫描分支不再显示徽章");
});

test("模式切换只在 AI 搜索一侧提示消耗", () => {
  const toggle = read("components/explore/explore-mode-toggle.tsx");
  assert.equal((toggle.match(/<CostHint\b/g) ?? []).length, 1, "扫描按钮不挂任何成本提示");
  const scanStart = toggle.indexOf('t("explore.mode.scan")');
  const aiStart = toggle.indexOf('t("explore.mode.aiSearch")');
  const hintAt = toggle.indexOf("<CostHint");
  assert.ok(hintAt > aiStart && scanStart < aiStart, "唯一提示必须落在 AI 搜索按钮内");
});

test("成本图标嵌在按钮内部，不挂在按钮外侧", () => {
  for (const relative of ["components/generate-pdf-button.tsx", "components/reevaluate-button.tsx"]) {
    const src = read(relative);
    const open = src.lastIndexOf("<button");
    const close = src.lastIndexOf("</button>");
    const hint = src.lastIndexOf("<CostHint");
    assert.ok(open !== -1 && close !== -1 && hint !== -1, `${relative} 应同时含按钮与成本图标`);
    assert.ok(open < hint && hint < close, `${relative} 的成本图标必须在按钮开始与结束标签之间`);
  }
});

test("i18n 只保留消耗 tokens 的键，免费类文案已清除", () => {
  const dict = read("lib/i18n/clusters/shared.ts");
  assert.match(dict, /"shared\.cost\.spend": /);
  assert.match(dict, /"shared\.cost\.spendTip": /);
  for (const dead of ["shared.cost.free\"", "shared.cost.freeGemini\"", "shared.cost.freeNetworkTip", "shared.cost.freeTip", "shared.cost.freeGeminiTip"]) {
    assert.equal(dict.includes(dead), false, `应删除 ${dead}`);
  }
});
// Tests for extractBrowserQuery() — the CLI scan_queries → browser-mode
// keyword seed. Imports directly from browser-search.mjs (single source of
// truth) so test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/browser-search.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBrowserQuery, buildSearchUrls, expandSearchTargets, parseSalaryText, matchesBrowserSalary, isSalaryUnknown, browserToParams, applyBrowserSalaryGate, cleanSalaryText } from "../../src/lib/browser-search.mjs";

// ── cleanSalaryText —— 字形反爬清洗（工单 03 缺陷修复）──

test("cleanSalaryText: 剥离 PUA 码点（BOSS 数字字体混淆），保留可读文本", () => {
  assert.equal(cleanSalaryText("\uE032\uE036-\uE034\uE031K"), "-K");
  assert.equal(cleanSalaryText("15-\uE0325K·14薪"), "15-5K·14薪");
  assert.equal(cleanSalaryText("20-35K·14薪"), "20-35K·14薪");
  assert.equal(cleanSalaryText("\uE032\uE036"), "");
  assert.equal(cleanSalaryText(undefined), "");
});

// ── browserToParams —— smin 编码（工单 02）──

test("browserToParams: 薪资下限编码为 smin，0/缺省省略", () => {
  assert.ok(browserToParams("项目经理", ["zhipin"], "郑州", 20).includes("smin=20"));
  assert.ok(!browserToParams("项目经理", ["zhipin"], "郑州", 0).includes("smin"));
  assert.ok(!browserToParams("项目经理", ["zhipin"], "郑州", undefined).includes("smin"));
  assert.ok(!browserToParams("项目经理", ["zhipin"], "郑州", -5).includes("smin"));
  // 小数保留 1 位
  assert.ok(browserToParams("项目经理", ["zhipin"], "", 22.25).includes("smin=22.3"));
});

test("drops site:/OR/city tokens and keeps every position keyword across OR groups", () => {
  assert.equal(
    extractBrowserQuery("site:zhipin.com 项目经理 郑州 OR 技术经理 郑州 OR IT项目经理 郑州"),
    "项目经理 技术经理 IT项目经理",
  );
});

test("typical first entry with liepin domain — city stripped, all groups kept", () => {
  assert.equal(
    extractBrowserQuery("site:liepin.com 项目经理 郑州 OR 技术经理 郑州 OR 软件项目经理 郑州"),
    "项目经理 技术经理 软件项目经理",
  );
});

test("no OR → keeps every non-site, non-city token", () => {
  assert.equal(extractBrowserQuery("site:zhaopin.com 技术经理 郑州"), "技术经理");
});

test("no site:, no OR → plain phrase passes with city dropped", () => {
  assert.equal(extractBrowserQuery("项目经理 郑州"), "项目经理");
});

test("site: token not at the front", () => {
  assert.equal(extractBrowserQuery("技术经理 郑州 site:liepin.com OR 测试"), "技术经理 测试");
});

test("case-insensitive OR — tokens across OR kept, city/descriptors remain", () => {
  assert.equal(extractBrowserQuery("软件工程师 site:a.com or 高级 or 资深"), "软件工程师 高级 资深");
});

test("empty / whitespace-only input → empty string", () => {
  assert.equal(extractBrowserQuery(""), "");
  assert.equal(extractBrowserQuery("   "), "");
  assert.equal(extractBrowserQuery(undefined), "");
  assert.equal(extractBrowserQuery(null), "");
});

test("only site: tokens → empty string", () => {
  assert.equal(extractBrowserQuery("site:zhipin.com site:liepin.com"), "");
});

test("site:-only first group → falls through and keeps later position keywords", () => {
  assert.equal(extractBrowserQuery("site:liepin.com OR 项目经理 郑州 OR 技术经理"), "项目经理 技术经理");
});

test("leading OR does not crash — yields the following phrase without city", () => {
  assert.equal(extractBrowserQuery("OR 项目经理 郑州"), "项目经理");
});

// ── buildSearchUrls / expandSearchTargets —— 多关键词展开与猎聘单关键词限制 ──

test("buildSearchUrls keeps one URL per source with OR-joined query", () => {
  const urls = buildSearchUrls(["zhipin", "liepin", "zhaopin"], "经理 OR 工程师", "郑州");
  assert.equal(urls.length, 3);
  for (const u of urls) assert.ok(u.includes("OR"), `期望 OR 保留在整串查询里: ${u}`);
});

test("expandSearchTargets splits liepin multi-keyword into one URL per word", () => {
  // 猎聘搜索框不支持 OR/空格分隔的多关键词 —— 逐词拆成多条搜索 URL。
  const targets = expandSearchTargets(["liepin"], "经理 OR 工程师 OR 架构师", "郑州");
  assert.equal(targets.length, 3);
  assert.ok(targets.every((t) => t.source === "liepin"));
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("经理"))), "含第一词 URL");
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("工程师"))), "含第二词 URL");
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("架构师"))), "含第三词 URL");
});

test("expandSearchTargets keeps BOSS/zhaopin as a single OR-joined URL (they accept multi keywords)", () => {
  const targets = expandSearchTargets(["zhipin", "zhaopin"], "经理 OR 工程师", "郑州");
  assert.equal(targets.length, 2); // 每源仍一条
  for (const t of targets) assert.ok(t.url.includes("OR"));
});

test("expandSearchTargets mixes sources correctly without heal-order drift", () => {
  const targets = expandSearchTargets(["zhipin", "liepin"], "经理 OR 工程师", "");
  // order: zhipin×1, liepin×2
  assert.equal(targets.length, 3);
  assert.equal(targets[0].source, "zhipin");
  assert.equal(targets[1].source, "liepin");
  assert.equal(targets[2].source, "liepin");
});

test("expandSearchTargets empty liepin query degrades to a single national search", () => {
  const targets = expandSearchTargets(["liepin"], "  ", "郑州");
  assert.equal(targets.length, 1);
  assert.ok(targets[0].url.startsWith("https://www.liepin.com/zhaopin/?key="));
});

// ── parseSalaryText —— 薪资文本 → 月薪 K 区间（工单 01）──

test("parseSalaryText: BOSS K 区间按月薪直取，忽略「·14薪」系数", () => {
  assert.deepEqual(parseSalaryText("20-35K·14薪", "zhipin"), { minK: 20, maxK: 35 });
  assert.deepEqual(parseSalaryText("20-35K", "zhipin"), { minK: 20, maxK: 35 });
  assert.deepEqual(parseSalaryText("20K-35K", "zhipin"), { minK: 20, maxK: 35 });
});

test("parseSalaryText: 智联「万」按月薪 ×10 折算", () => {
  assert.deepEqual(parseSalaryText("1.5-2.5万·13薪", "zhaopin"), { minK: 15, maxK: 25 });
  assert.deepEqual(parseSalaryText("2万-3万", "zhaopin"), { minK: 20, maxK: 30 });
});

test("parseSalaryText: 猎聘裸「万」按年薪 ÷12 折算", () => {
  const r = parseSalaryText("20-35万", "liepin");
  assert.equal(r.minK, Math.round((200 / 12) * 10) / 10);
  assert.equal(r.maxK, Math.round((350 / 12) * 10) / 10);
  // 猎聘的 K 形态仍是月薪，不受万口径影响
  assert.deepEqual(parseSalaryText("15-25K·14薪", "liepin"), { minK: 15, maxK: 25 });
});

test("parseSalaryText: 显式「/年」「年薪」标记一律按年薪 ÷12，与站点无关", () => {
  const r = parseSalaryText("24-36万/年", "zhaopin");
  assert.equal(r.minK, 20);
  assert.equal(r.maxK, 30);
});

test("parseSalaryText: 单值形态取同值区间", () => {
  assert.deepEqual(parseSalaryText("30K", "zhipin"), { minK: 30, maxK: 30 });
  assert.deepEqual(parseSalaryText("2.5万", "zhaopin"), { minK: 25, maxK: 25 });
});

test("parseSalaryText: 非月薪口径与乱文本 → null（归入薪资未知）", () => {
  assert.equal(parseSalaryText("200-350元/天", "zhipin"), null);
  assert.equal(parseSalaryText("面议", "zhaopin"), null);
  assert.equal(parseSalaryText("", "liepin"), null);
  assert.equal(parseSalaryText(undefined, "zhaopin"), null);
  assert.equal(parseSalaryText("3个月", "zhipin"), null);
  assert.equal(parseSalaryText("100人", "zhaopin"), null);
});

test("parseSalaryText: 未知站点来源的裸「万」按月薪保守处理", () => {
  assert.deepEqual(parseSalaryText("2-3万", ""), { minK: 20, maxK: 30 });
});

test("parseSalaryText: 混合单位区间各按自身单位折算（8千-1.2万）", () => {
  assert.deepEqual(parseSalaryText("8千-1.2万", "zhaopin"), { minK: 8, maxK: 12 });
  assert.deepEqual(parseSalaryText("20K-3.5万", "zhaopin"), { minK: 20, maxK: 35 });
});

// ── applyBrowserSalaryGate —— 两条驱动路径共享的门控组合（工单 03/04）──

test("applyBrowserSalaryGate: 丢弃不达标、保留达标、未知打标、门关时原样返回", () => {
  const jobs = [
    { salary: "10-18K", source: "zhipin" },
    { salary: "20-35K", source: "zhipin" },
    { salary: "", source: "zhaopin" },
    { salary: "面议", source: "liepin" },
  ];
  const gated = applyBrowserSalaryGate(jobs, 20);
  assert.equal(gated.length, 3); // 10-18K 丢弃，其余保留
  assert.equal(gated[0].salary, "20-35K");
  assert.equal(gated[0].salaryUnknown, undefined);
  assert.equal(gated[1].salaryUnknown, true); // 无薪资 → 打标
  assert.equal(gated[2].salaryUnknown, true);
  // 门关（0/缺省）→ 原数组原样返回（含不达标者）
  assert.equal(applyBrowserSalaryGate(jobs, 0).length, 4);
  assert.equal(applyBrowserSalaryGate(undefined, 20).length, 0);
});

// ── matchesBrowserSalary —— 重叠判定门控（工单 01）──

test("matchesBrowserSalary: 区间上限 ≥ 薪资下限即保留（重叠判定）", () => {
  assert.equal(matchesBrowserSalary({ salary: "15-25K", source: "zhipin" }, 20), true);
  assert.equal(matchesBrowserSalary({ salary: "20-35K", source: "zhipin" }, 20), true);
  assert.equal(matchesBrowserSalary({ salary: "10-18K", source: "zhipin" }, 20), false);
});

test("matchesBrowserSalary: 无薪资/解析失败放行（薪资未知，不误删）", () => {
  assert.equal(matchesBrowserSalary({ salary: "", source: "zhipin" }, 20), true);
  assert.equal(matchesBrowserSalary({ salary: "面议", source: "zhaopin" }, 20), true);
  assert.equal(matchesBrowserSalary({}, 20), true);
  assert.equal(matchesBrowserSalary(undefined, 20), true);
});

test("matchesBrowserSalary: 薪资下限为 0/缺省时全放行（门未启用）", () => {
  assert.equal(matchesBrowserSalary({ salary: "10-18K", source: "zhipin" }, 0), true);
  assert.equal(matchesBrowserSalary({ salary: "10-18K", source: "zhipin" }, undefined), true);
});

test("matchesBrowserSalary: source 兼容 browser- 前缀（DiscoveredOffer.source 形态）", () => {
  // 猎聘裸万按年薪：20-35万 → ≈16.7-29.2K，上限 ≥ 20 保留
  assert.equal(matchesBrowserSalary({ salary: "20-35万", source: "browser-liepin" }, 20), true);
  // 12-18万（年薪）→ 10-15K，上限 < 20 丢弃
  assert.equal(matchesBrowserSalary({ salary: "12-18万", source: "browser-liepin" }, 20), false);
});

test("isSalaryUnknown: 无薪资或解析不出数值即未知（与门是否启用无关）", () => {
  assert.equal(isSalaryUnknown({ salary: "", source: "zhipin" }), true);
  assert.equal(isSalaryUnknown({ salary: "面议", source: "zhaopin" }), true);
  assert.equal(isSalaryUnknown({ salary: "200-350元/天", source: "zhipin" }), true);
  assert.equal(isSalaryUnknown({ salary: "20-35K", source: "zhipin" }), false);
});
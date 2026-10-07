// site-liepin 适配对象契约测试（ADR-0005）。
//
// 覆盖 ADR 测试清单里可脱离 DOM 的部分：
//   • isDetailPath —— /job/ 与 /a/ 变体识别、列表路径排除；
//   • site 对象契约形状 —— hostMatch、选择器非空、extraTrackingParams 全量、
//     evaluateInlineJd 声明、猎聘缺失的可选能力键不声明（core 以 typeof 守卫）。
// DOM 依赖的提取函数（extractDetailJd / extractPosterName / cardIsList）在真实
// 浏览器手工验证（已随 猎聘功能验证 通过），node 无 jsdom 不重复测。
//
// Run:  node --test tests/lib/liepin-site.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "site-liepin.js")).href);
// CJS 互操作: module.exports 对象即 default; 具名导出走 cjs-module-lexer 也能拿到。
const { LIEPIN_SITE, isDetailPath, extractSalaryFromCardText, pickPosterName } = mod.default ?? mod;

test("pickPosterName: 报告 1106 事故回归——「继续聊」聊天按钮不得被当成公司名", () => {
  // fixture 来自 2026-10-07 对 liepin.com/a/79396987.shtml 登录态 DOM 的真实探针：
  // 文档序上 a.btn-chat（href="javascript:;"）先于公司链接，旧实现直接把它当结果。
  const candidates = [
    { text: "继续聊", href: "javascript:;" },
    { text: "新文溯科技\n计算机软件 融资未公开 50-99人", href: "https://www.liepin.com/company/2660976/" },
    { text: "新文溯科技", href: "" },
  ];
  assert.equal(pickPosterName(candidates), "新文溯科技");
});

test("pickPosterName: 候选过滤规则逐条钉住", () => {
  // javascript: href 即文本像公司名也拒（按钮形态不可信）
  assert.equal(pickPosterName([{ text: "某某科技", href: "javascript:void(0)" }]), "");
  // CTA 黑名单：全等与前缀都拒（「立即沟通，了解更多」类变体）
  assert.equal(pickPosterName([{ text: "立即沟通", href: "" }]), "");
  assert.equal(pickPosterName([{ text: "立即沟通，了解更多", href: "" }]), "");
  // 取首个非空行（公司块带换行的行业/规模尾巴）
  assert.equal(pickPosterName([{ text: "\n  空调国际\n汽车零部件 2000-5000人", href: "" }]), "空调国际");
  // 去「· 」前缀（ADR-0005 记录的公司链接文本形态）
  assert.equal(pickPosterName([{ text: "· 天原集团", href: "" }]), "天原集团");
  // 无合格候选 / 空输入 → 空串（快评退回不前缀）
  assert.equal(pickPosterName([]), "");
  assert.equal(pickPosterName(undefined), "");
  assert.equal(pickPosterName([{ text: "   ", href: "" }]), "");
  // 截断 40 字符上限保持旧契约
  assert.equal(pickPosterName([{ text: "字".repeat(50), href: "" }]).length, 40);
});

test("extractSalaryFromCardText: 猎聘卡片文本级薪资提取（class 选择器落空时的兜底）", () => {
  // 真实卡片文本形态（data/pipeline.md 取证的 title 即 anchor label 全文）
  assert.equal(extractSalaryFromCardText("服务端开发（Java · 全栈） 【 郑州-郑东新区 】 8-13k 3-5年 本科"), "8-13k");
  assert.equal(extractSalaryFromCardText("电解铝厂设备安装项目经理 【 郑州 】 20-30k·13薪 5-10年 大专"), "20-30k·13薪");
  assert.equal(extractSalaryFromCardText("高级项目经理 20-35万 五年以上经验"), "20-35万");
  // 经验年限（5-10年）与「13薪」单独出现不得误判为薪资
  assert.equal(extractSalaryFromCardText("项目经理 5-10年 大专"), "");
  assert.equal(extractSalaryFromCardText("项目经理"), "");
  assert.equal(extractSalaryFromCardText(""), "");
  assert.equal(extractSalaryFromCardText(undefined), "");
});

test("isDetailPath: /job/{id}.shtml and /a/{id}.shtml are detail pages", () => {
  assert.equal(isDetailPath("/job/1985305711.shtml"), true);
  assert.equal(isDetailPath("/a/1985305711.shtml"), true);
  assert.equal(isDetailPath("/job/1.shtml"), true);
});

test("isDetailPath: list/search/other paths are NOT detail pages", () => {
  for (const p of [
    "/zhaopin/",
    "/zhaopin/?key=java",
    "/",
    "/job/",
    "/a/",
    "/job/abc.shtml",
    "/job/1985305711.html",
    "",
  ]) {
    assert.equal(isDetailPath(p), false, `pathname=${JSON.stringify(p)}`);
  }
});

test("LIEPIN_SITE: contract shape required keys are present and non-empty", () => {
  assert.ok(LIEPIN_SITE, "site object must be exported");
  assert.ok(LIEPIN_SITE.hostMatch instanceof RegExp, "hostMatch must be a RegExp");
  assert.equal(LIEPIN_SITE.hostMatch.test("www.liepin.com"), true);
  assert.equal(LIEPIN_SITE.hostMatch.test("x.liepin.com"), true);
  assert.equal(LIEPIN_SITE.hostMatch.test("zhipin.com"), false);
  assert.ok(typeof LIEPIN_SITE.cardSelector === "string" && LIEPIN_SITE.cardSelector.length > 0);
  assert.ok(typeof LIEPIN_SITE.linkSelector === "string" && LIEPIN_SITE.linkSelector.length > 0);
  assert.equal(typeof LIEPIN_SITE.isDetailPath, "function");
  assert.equal(typeof LIEPIN_SITE.cardIsList, "function");
  assert.equal(typeof LIEPIN_SITE.cardUrl, "function");
  assert.equal(typeof LIEPIN_SITE.extractDetailJd, "function");
  assert.equal(typeof LIEPIN_SITE.extractPosterName, "function");
  // 分页型平台扫描契约(猎聘改版为分页显示):core scan mode 以此为据走 DOM 翻页
  // 而非滚动。isPageMode 必须为 true,findNextPageBtn 必须可调(有下一页即返回)。
  assert.equal(LIEPIN_SITE.isPageMode, true, "猎聘搜索页是分页型,不是懒加载滚动");
  assert.equal(typeof LIEPIN_SITE.findNextPageBtn, "function", "分页扫描需提供「下一页」定位函数");
});

test("LIEPIN_SITE: cardSelector 同时锁定漂移后的 camelCase 容器与旧 kebab 形态（防回归）", () => {
  // 实证 2026-10：猎聘把卡片容器 class 从 kebab-case `job-card-pc-container` 改成
  // camelCase `jobCardPcContainer`，旧串整页匹配 0 → 扩展采集「猎聘恒为 0」。
  // 本断言把修正后的选择器钉住为「两个形态都覆盖」，挡掉未来意外删掉 camelCase 分支的
  // “清理”。真正的 DOM 命中靠浏览器实测（见上方注释：本仓无 jsdom 不重复测）。
  const sel = LIEPIN_SITE.cardSelector;
  assert.ok(sel.includes("jobCardPcContainer"), "cardSelector 必须匹配漂移后的 camelCase 容器");
  assert.ok(sel.includes("job-card-pc-container"), "cardSelector 应保留旧 kebab 形态作兼容兜底");
  // 链接锚点是采集去重的实际锚点，改名不应连带被动。
  assert.equal(LIEPIN_SITE.linkSelector, 'a[data-nick="job-detail-job-info"]');
});

test("LIEPIN_SITE: evaluateInlineJd is declared (detail-page eval inlines DOM JD)", () => {
  assert.equal(LIEPIN_SITE.evaluateInlineJd, true);
});

test("LIEPIN_SITE: extraTrackingParams covers the full ADR-0005 denylist", () => {
  const PARAMS = [
    "pgRef", "d_sfrom", "d_ckId", "d_curPage", "d_pageSize", "d_headId", "d_posi",
    "skId", "fkId", "ckId", "sfrom", "curPage", "pageSize", "index",
  ];
  assert.ok(Array.isArray(LIEPIN_SITE.extraTrackingParams));
  assert.equal(LIEPIN_SITE.extraTrackingParams.length, PARAMS.length,
    `expected ${PARAMS.length} entries, got ${LIEPIN_SITE.extraTrackingParams.length}`);
  for (const name of PARAMS) {
    assert.ok(
      LIEPIN_SITE.extraTrackingParams.some((re) => re.test(name)),
      `tracking param ${name} must be stripped`,
    );
  }
});

test("LIEPIN_SITE: BOSS-only optional capabilities are NOT declared (typeof-guard contract)", () => {
  // 猎聘无列表右栏面板;core 以 typeof 守卫这些键,缺失即跳过。
  assert.equal("ids" in LIEPIN_SITE, false);
  assert.equal("ensureRightPaneButton" in LIEPIN_SITE, false);
  assert.equal("extractListPaneJd" in LIEPIN_SITE, false);
  assert.equal("currentActiveUrl" in LIEPIN_SITE, false);
});

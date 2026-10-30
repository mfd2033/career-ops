// result-tags.test.mjs — 探索页结果标签条的纯逻辑层（交互口径来自 ADR-0068 收件箱
// 关键词条）。覆盖：标签的来源面与去空白、词典命中（ASCII 大小写不敏感 / CJK 直接
// 子串）、exclude 抑制、不改原对象、chip 之间 OR、计数口径（chip 数字 = 点击后的
// 匹配条数）、选中项永不隐形，以及组件与页面的接线（含 i18n 成对）。
//
// 分两半，因为任一半单独存在都能在坏代码上通过：
//   1. 口径本身 —— 命中、过滤、计数；
//   2. 接线 —— 组件读的是这套派生（另写一份会让第 1 半继续绿、页面却是另一回事）。
//
// Run:  node --test tests/lib/result-tags.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESULT_TAG_TOP_N,
  offerTagFaces,
  offerTags,
  withTags,
  filterByTags,
  countOfferTags,
  withSelectedCounts,
} from "../../src/lib/result-tags.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, "../../src", rel), "utf8");
const flat = (rel) => read(rel).replace(/\s+/g, " ");

const VOCAB = ["AI", "Python", "大模型", "RAG"];

// 三种真实形态：英文 token 在职位名、中文词在职位名、公司名里带词、以及完全无命中。
const OFFERS = [
  { url: "https://x/1", title: "AI 平台工程师", company: "甲公司", location: "北京" },
  { url: "https://x/2", title: "大模型工程师", company: "乙公司", location: "" },
  { url: "https://x/3", title: "Python 后端（RAG 方向）", company: "丙公司", location: "远程" },
  { url: "https://x/4", title: "行政专员", company: "丁公司", location: "郑州" },
  { url: "https://x/5", title: "平台工程师", company: "戊AI研究院", location: "" },
];

// ── 1. 默认值锁定 ────────────────────────────────────────────────────────────

test("RESULT_TAG_TOP_N is pinned to 12 (与收件箱同一视觉纪律)", () => {
  assert.equal(RESULT_TAG_TOP_N, 12);
});

// ── 2. 文本面 ────────────────────────────────────────────────────────────────

test("可匹配文本面 = 职位名 + 公司 + 地点，空白段丢弃", () => {
  assert.deepEqual(offerTagFaces({ title: "AI 工程师", company: "", location: "北京" }), ["AI 工程师", "北京"]);
  assert.deepEqual(offerTagFaces({ title: "  ", company: "甲公司" }), ["甲公司"]);
  assert.deepEqual(offerTagFaces({}), [], "缺字段按空处理，不炸");
});

// ── 3. 命中口径（与收件箱 matchVocab 同一实现）───────────────────────────────

test("ASCII 词大小写不敏感、CJK 直接子串", () => {
  assert.ok(offerTags({ title: "python 后端" }, VOCAB).includes("Python"), "小写词命中词表里的原文词形");
  assert.ok(offerTags({ title: "大模型工程师" }, VOCAB).includes("大模型"), "中文直接子串");
  assert.ok(offerTags({ title: "RAG 检索" }, VOCAB).includes("RAG"));
});

test("公司名与地点也算命中（与收件箱行的面相一致）", () => {
  assert.deepEqual(offerTags({ title: "平台工程师", company: "戊AI研究院" }, VOCAB), ["AI"], "公司名里的词同样计入");
  assert.deepEqual(offerTags({ title: "平台工程师", location: "AI 园区" }, VOCAB), ["AI"]);
});

test("无命中 / 空词表 → 空标签数组", () => {
  assert.deepEqual(offerTags({ title: "行政专员", company: "丁公司" }, VOCAB), []);
  assert.deepEqual(offerTags({ title: "AI 工程师" }, []), []);
  assert.deepEqual(offerTags({ title: "AI 工程师" }, undefined), [], "词表缺失不抛错");
});

test("exclude 压掉命中（用户的抑制词）", () => {
  assert.deepEqual(offerTags({ title: "AI 工程师" }, VOCAB, ["AI"]), []);
  assert.deepEqual(offerTags({ title: "AI 大模型工程师" }, VOCAB, ["ai"]), ["大模型"], "抑制词大小写不敏感");
});

// ── 4. 批量打标 ──────────────────────────────────────────────────────────────

test("withTags 逐行挂 tags，不改原对象、不改顺序", () => {
  const before = OFFERS.map((o) => ({ ...o }));
  const out = withTags(OFFERS, VOCAB);
  assert.deepEqual(OFFERS, before, "输入对象不被就地修改");
  assert.deepEqual(out.map((o) => o.url), OFFERS.map((o) => o.url), "顺序保持");
  assert.deepEqual(out[1].tags, ["大模型"]);
  assert.deepEqual(out[3].tags, [], "无命中行仍有一枚空数组（组件据此判断整条是否渲染）");
});

test("withTags 空词表 → 每行空标签（标签条整条隐藏、过滤恒放行）", () => {
  const out = withTags(OFFERS, []);
  assert.ok(out.every((o) => Array.isArray(o.tags) && o.tags.length === 0));
  assert.equal(filterByTags(out, new Set(["AI"])).length, 0, "空标签集下选中任何 chip 都匹配不到行——所以组件必须先隐藏标签条");
});

// ── 5. 过滤口径 ──────────────────────────────────────────────────────────────

test("未选 chip → 全放行；选中 → 命中任一即保留（OR）", () => {
  const rows = withTags(OFFERS, VOCAB);
  assert.equal(filterByTags(rows, new Set()).length, 5, "空选择不窄化");
  assert.equal(filterByTags(rows, null).length, 5);
  const onlyAi = filterByTags(rows, new Set(["AI"]));
  assert.deepEqual(onlyAi.map((o) => o.url), ["https://x/1", "https://x/5"], "两行命中 AI（职位名 + 公司名）");
  const orSet = filterByTags(rows, new Set(["AI", "大模型"]));
  assert.deepEqual(orSet.map((o) => o.url), ["https://x/1", "https://x/2", "https://x/5"], "chip 之间是 OR，不是 AND");
});

// ── 6. 计数口径 ──────────────────────────────────────────────────────────────

test("计数按命中行数降序、同数按词形升序，每行同一词只计一次", () => {
  const rows = withTags(
    [
      { url: "a", title: "AI 大模型", company: "" },
      { url: "b", title: "AI 工程师", company: "" },
      { url: "c", title: "AI AI AI", company: "" },
      { url: "d", title: "大模型", company: "" },
      { url: "e", title: "行政", company: "" },
    ],
    VOCAB,
  );
  assert.deepEqual(countOfferTags(rows), [
    ["AI", 3],
    ["大模型", 2],
  ], "行内重复出现只计一次；零命中词不进计数");
});

test("chip 上的数字恒等于点击后的匹配条数（死 chip 不许出现）", () => {
  const rows = withTags(OFFERS, VOCAB);
  const counts = countOfferTags(rows);
  for (const [tag, n] of counts) {
    assert.equal(
      filterByTags(rows, new Set([tag])).length,
      n,
      `chip「${tag}」显示 ${n} 条，点下去必须正好剩 ${n} 行`,
    );
  }
});

test("选中项补进计数集：不在计数里的补 0，已在的不重复", () => {
  const counts = [["AI", 2]];
  assert.deepEqual(withSelectedCounts(counts, new Set(["AI"])), [["AI", 2]], "已在计数里的选中项不重复添加");
  assert.deepEqual(withSelectedCounts(counts, new Set(["AI", "RAG"])), [["AI", 2], ["RAG", 0]], "看不见的选中项补一枚 0 计数 chip，才能取消");
  assert.deepEqual(withSelectedCounts(counts, new Set()), [["AI", 2]], "空选择原样返回");
});

// ── 7. 接线 ──────────────────────────────────────────────────────────────────

test("命中实现只有一份：标签复用收件箱的 assembleRowKeywords / countKeywords", () => {
  const src = flat("lib/result-tags.mjs");
  assert.match(src, /import \{ assembleRowKeywords, countKeywords \} from "\.\/inbox-keywords\.mjs"/, "标签与收件箱关键词必须共用同一套匹配/计数实现");
  assert.ok(!/toLowerCase\(\)\.includes/.test(src), "不许在标签模块里另写一套子串匹配");
});

test("结果区把标签条挂在分组 tab 与卡片之间，渲染行读同一套派生", () => {
  const src = flat("components/explore/results-list.tsx");
  assert.match(src, /import \{ countOfferTags, filterByTags, withSelectedCounts, withTags \} from "@\/lib\/result-tags\.mjs"/, "派生必须来自共享模块");
  assert.match(src, /<TagBar counts=\{tagCounts\} selected=\{tags\}/, "标签条渲染");
  assert.match(src, /const tagScope = useMemo\(\(\) => visibleOffers\(remaining, tab, q\), \[remaining, tab, q\]\)/, "计数基底 = 通过其余条件的行集");
  assert.match(src, /const view = useMemo\(\(\) => \{ const list = filterByTags\(salaryScope, tags\)/, "渲染行 = 同一基底再过标签（薪资下限上线后基底链为 tagScope → salaryScope → view，源头仍是 tagScope）");
  // tab 徽标仍看全集（与搜索框同一分层），标签只在行上做窄化。
  assert.match(src, /for \(const o of remaining\) c\[resultTabOf\(o\)\] \+= 1/, "tab 徽标不被标签收窄");
});

test("词表来自服务端装配、下发给客户端匹配（不接受客户端自编词条）", () => {
  const page = flat("app/explore/page.tsx");
  assert.match(page, /tagVocab = readTagVocab\(\)/, "页面从 career-ops 装配词表");
  assert.match(page, /<ExplorerView [^>]*tagVocab=\{tagVocab\}/, "词表下发给客户端");
  const view = flat("components/explore/explorer-view.tsx");
  assert.match(view, /<ResultsList offers=\{enriched\} tagVocab=\{tagVocab\} \/>/, "结果区拿到词表");
  const lib = flat("lib/career-ops.ts");
  assert.match(lib, /export function readTagVocab\(\): \{ vocab: string\[\]; exclude: string\[\] \}/, "词表装配与收件箱关键词条共用 readVocabSources");
  assert.match(lib, /const \{ vocab, exclude \} = readVocabSources\(\)/, "收件箱侧也读同一份来源，两页口径不会漂");
});

test("标签条文案 en / zh 成对", () => {
  const src = read("lib/i18n/clusters/explore.ts");
  for (const key of [
    "explore.results.tagsAria",
    "explore.results.tagChipTitle",
    "explore.results.tagExpand",
    "explore.results.tagCollapse",
    "explore.results.tagsClear",
    "explore.results.noTagMatch",
  ]) {
    const hits = (src.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) ?? []).length;
    assert.equal(hits, 2, `${key} must exist in both locales`);
  }
});

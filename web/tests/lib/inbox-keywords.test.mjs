// Tests for inbox-keywords.mjs — 收件箱关键词条的纯逻辑层（ADR-0068）。
// 覆盖：报告词节提取（红线：正文不参与）、三源词表解析（含对 skill-extract.mjs
// 当前源码格式的上锁）、词典匹配、行级装配与 exclude 抑制、chip 计数口径、
// URL 参数 kwd 的归一往返。
//
// Run:  node --test tests/lib/inbox-keywords.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  KEYWORD_TOP_N,
  isValidTerm,
  splitKeywordList,
  extractSectionKeywords,
  parseSkillTokens,
  cvSkillsFromMd,
  buildVocab,
  matchVocab,
  assembleRowKeywords,
  countKeywords,
  parseKwdParam,
  serializeKwd,
  splitHighlight,
  deadKeywords,
} from "../../src/lib/inbox-keywords.mjs";

// ── 默认值锁定（ADR-0068 决议 4：前 12 枚）─────────────────────────────

test("KEYWORD_TOP_N is pinned to 12", () => {
  assert.equal(KEYWORD_TOP_N, 12);
});

// ── isValidTerm / splitKeywordList ────────────────────────────────────

test("分隔符 、，,;； 与换行统一拆分，去空去重保留首词形", () => {
  assert.deepEqual(
    splitKeywordList("大模型、RAG，LLM; Python、python、  \n 产品经理"),
    ["大模型", "RAG", "LLM", "Python", "产品经理"],
  );
});

test("markdown 强调与列表符被剥掉", () => {
  assert.deepEqual(splitKeywordList("- **项目管理**、**交付**"), ["项目管理", "交付"]);
});

test("句子残留（>24 字）被丢弃，合法短语保留", () => {
  assert.deepEqual(splitKeywordList("a".repeat(25) + "、真词"), ["真词"]);
  assert.equal(isValidTerm("含，逗号的词"), false);
  assert.equal(isValidTerm("a".repeat(25)), false);
});

// ── extractSectionKeywords（红线：只认词节）───────────────────────────

const reportFixture = [
  "# Evaluation: 某公司 — 某职位",
  "",
  "**URL:** https://example.com/job/1",
  "",
  "## B) Match with CV",
  "评估正文里提到 Python 与 大模型 —— 这些一律不许成为关键词。",
  "",
  "## Keywords extracted",
  "",
  "建筑项目经理、一二级建造师、PMP、项目管理、郑州招聘",
  "",
  "## Risk Summary",
  "- 风险行",
].join("\n");

test("只提取 `## Keywords extracted` 节，到下一个 ## 为止", () => {
  assert.deepEqual(extractSectionKeywords(reportFixture), [
    "建筑项目经理", "一二级建造师", "PMP", "项目管理", "郑州招聘",
  ]);
});

test("红线：报告正文（Block B 等）里的词不会因出现在全文而被提取", () => {
  const kws = extractSectionKeywords(reportFixture);
  assert.ok(!kws.includes("Python"));
  assert.ok(!kws.includes("大模型"));
});

test("词节在文件末尾（无后继标题）同样提取；CRLF 不干扰", () => {
  const md = "## A) x\r\n正文\r\n## Keywords extracted\r\n产品经理、AI产品\r\n";
  assert.deepEqual(extractSectionKeywords(md), ["产品经理", "AI产品"]);
});

test("无词节 → 空数组（未评估行的诚实形态）", () => {
  assert.deepEqual(extractSectionKeywords("# Report\n## B)\n没有词节\n"), []);
  assert.deepEqual(extractSectionKeywords(""), []);
});

// ── parseSkillTokens（词源 3：对 skill-extract.mjs 当前格式上锁）──────

test("fixture：剥注释、抓引号串、按 DISPLAY 规则去转义", () => {
  const src = [
    "export const SKILL_TOKENS = [",
    "  // Languages",
    "  'Python', 'Go', 'Vue\\.?js',",
    "  /* block 'fake' comment */",
    "  'Kubernetes', 'GraphQL',",
    "];",
  ].join("\n");
  assert.deepEqual(parseSkillTokens(src), ["Python", "Go", "Vue.js", "Kubernetes", "GraphQL"]);
});

test("结构不符（上游改格式）→ 空集降级，不抛错", () => {
  assert.deepEqual(parseSkillTokens("const x = 1;"), []);
  assert.deepEqual(parseSkillTokens(""), []);
});

test("真文件上锁：仓库的 skill-extract.mjs 必须能解析出成规模的词表", () => {
  const src = fs.readFileSync(new URL("../../../skill-extract.mjs", import.meta.url), "utf8");
  const tokens = parseSkillTokens(src);
  assert.ok(tokens.length > 100, `expected >100 tokens, got ${tokens.length}`);
  assert.ok(tokens.includes("Kubernetes"), "Kubernetes 必须在词表中");
  assert.ok(!tokens.some((t) => t.includes("\\")), "去转义必须彻底");
});

// ── cvSkillsFromMd（词源 2）───────────────────────────────────────────

test("Skills 节切到下一个任意标题为止；无节 → 空", () => {
  const md = ["# CV", "## Summary", "做过很多事", "## Skills", "Python、Docker、Kubernetes", "## Experience", "- 带过团队"].join("\n");
  assert.deepEqual(cvSkillsFromMd(md), ["Python", "Docker", "Kubernetes"]);
  assert.deepEqual(cvSkillsFromMd("# CV\n## Experience\n无技能节"), []);
});

// ── buildVocab / matchVocab ───────────────────────────────────────────

test("buildVocab 并集去重（大小写不敏感）且过 isValidTerm", () => {
  const vocab = buildVocab({
    a: ["产品经理", "Python"],
    b: ["python", "含，坏词", "大模型"],
  });
  assert.deepEqual(vocab, ["产品经理", "Python", "大模型"]);
});

test("matchVocab：拉丁词形大小写不敏感，CJK 直接子串", () => {
  const vocab = ["python", "大模型", "RAG"];
  assert.deepEqual(matchVocab("资深 Python 工程师（大模型方向）", vocab), ["python", "大模型"]);
  assert.deepEqual(matchVocab("LLM RAG pipeline", vocab), ["RAG"]);
  assert.deepEqual(matchVocab("", vocab), []);
});

// ── assembleRowKeywords ───────────────────────────────────────────────

test("词节来源优先，词典命中并入，同词去重（词节词形胜出）", () => {
  const out = assembleRowKeywords({
    sectionKeywords: ["项目管理", "PMP"],
    faces: ["高级项目经理 · 某公司"],
    vocab: ["产品经理", "项目管理"],
    exclude: [],
  });
  assert.deepEqual(out, ["项目管理", "PMP"]);
});

test("exclude 同时压掉词节与词典两个来源（大小写不敏感）", () => {
  const out = assembleRowKeywords({
    sectionKeywords: ["郑州招聘", "PMP"],
    faces: ["Python 大模型工程师"],
    vocab: ["python", "大模型"],
    exclude: ["郑州招聘", "PYTHON"],
  });
  assert.deepEqual(out, ["PMP", "大模型"]);
});

// ── countKeywords ─────────────────────────────────────────────────────

test("按命中行数降序、同数按词形升序；行内同词只计一次", () => {
  const rows = [
    { keywords: ["RAG", "RAG", "大模型"] },
    { keywords: ["RAG", "产品经理"] },
    { keywords: ["产品经理"] },
  ];
  assert.deepEqual(countKeywords(rows), [["RAG", 2], ["产品经理", 2], ["大模型", 1]]);
});

// ── kwd URL 参数 ──────────────────────────────────────────────────────

test("parseKwdParam 对 、，, 归一并丢空段；serializeKwd 往返稳定", () => {
  const set = parseKwdParam("RAG、大模型，LLM,，");
  assert.deepEqual([...set], ["RAG", "大模型", "LLM"]);
  assert.equal(serializeKwd(set), "RAG,大模型,LLM");
  assert.equal(serializeKwd(new Set()), "");
  assert.equal(parseKwdParam("").size, 0);
});

// ── splitHighlight（命中高亮分段，ADR-0068 决议 6）────────────────────

test("无 terms → 单段不命中（行渲染零变化）", () => {
  assert.deepEqual(splitHighlight("某公司 AI 产品经理", undefined), [{ t: "某公司 AI 产品经理", hit: false }]);
  assert.deepEqual(splitHighlight("某公司", []), [{ t: "某公司", hit: false }]);
  assert.deepEqual(splitHighlight("", ["x"]), []);
});

test("CJK 子串命中切段；拉丁形态大小写不敏感", () => {
  assert.deepEqual(splitHighlight("高级产品经理", ["产品经理"]), [
    { t: "高级", hit: false },
    { t: "产品经理", hit: true },
  ]);
  assert.deepEqual(splitHighlight("Senior python Engineer", ["PYTHON"]), [
    { t: "Senior ", hit: false },
    { t: "python", hit: true },
    { t: " Engineer", hit: false },
  ]);
});

test("重叠/邻接区间合并，不重复不丢字；多处命中全高亮", () => {
  const segs = splitHighlight("大模型平台，大模型应用", ["大模型平台", "模型"]);
  assert.equal(segs.map((s) => s.t).join(""), "大模型平台，大模型应用");
  assert.deepEqual(segs, [
    { t: "大模型平台", hit: true },
    { t: "，大", hit: false },
    { t: "模型", hit: true },
    { t: "应用", hit: false },
  ]);
});

test("匹配口径单源：命中判定与高亮分段对同一输入一致，空词两处都不命中", () => {
  const vocab = ["python", "大模型", "RAG", "Kubernetes"];
  const text = "资深 Python 工程师（大模型方向），熟悉 RAG";
  const hits = matchVocab(text, vocab);
  assert.deepEqual(hits, ["python", "大模型", "RAG"]);
  const hitText = splitHighlight(text, vocab)
    .filter((s) => s.hit)
    .map((s) => s.t)
    .join("");
  for (const term of hits) {
    const found = /^[\x00-\x7F]+$/.test(term)
      ? hitText.toLowerCase().includes(term.toLowerCase())
      : hitText.includes(term);
    assert.ok(found, `${term} 命中后必须产出对应高亮段`);
  }
  // 空词：共享实现下命中判定与高亮分段都视为不命中（不产生假阳性）
  assert.deepEqual(matchVocab("任意文本", [""]), []);
  assert.deepEqual(splitHighlight("任意文本", [""]), [{ t: "任意文本", hit: false }]);
});

// ── deadKeywords（删除命中行后的死词剪枝，回归锁）──────────────────

test("回归：选中词的行全被删除后，该词判死可剪（页面不再停在 0 匹配）", () => {
  const before = new Set(["alpha"]);
  assert.deepEqual(deadKeywords(before, [
    { keywords: ["alpha", "工程师"] },
    { keywords: ["beta"] },
  ]), []);
  // 删除 alpha 行后的剩余数据：alpha 已无任何存活行 → 死词
  assert.deepEqual(deadKeywords(before, [{ keywords: ["beta"] }]), ["alpha"]);
});

test("部分存活只剪死词；hidden 行（skip 可撤销）仍算存活；空集/无行为 no-op", () => {
  const sel = new Set(["alpha", "beta"]);
  assert.deepEqual(deadKeywords(sel, [{ keywords: ["beta"] }]), ["alpha"]);
  assert.deepEqual(deadKeywords(sel, []), ["alpha", "beta"]);
  assert.deepEqual(deadKeywords(new Set(), [{ keywords: ["x"] }]), []);
  assert.deepEqual(deadKeywords(null, undefined), []);
});

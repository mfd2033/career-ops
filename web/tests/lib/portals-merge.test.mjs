// portals-merge.test.mjs — 「目标职位」保存后，手写词表与文件注释必须还在
// (工单 02 / gate-visibility).
//
// The write path replaced `title_filter.positive` wholesale, and it did it by
// load-then-dump: js-yaml round-tripping the whole document silently deletes every
// comment in it. portals.yml is where this user's targeting decisions are written
// down — 「刻意不用裸「项目经理/PM」——否则「工程项目经理」(土建) 会一并进来」,
// 「原为裸"产品"，误中酒类产品经理（啤酒）；改为软件产品」. Those lines are the
// rationale for the word list; losing them means the next edit is made blind, and
// nothing on screen warns you it happened.
//
// So the writer is text surgery, not a round-trip: locate the block, splice it,
// leave every other byte alone. These tests pin the surgical properties that a
// round-trip cannot give you — including the two that are easy to get wrong:
// items must land BEFORE the comment that introduces the next block, and a
// replace must not eat the blank line + comment that separate two sections.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as yaml from "js-yaml";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { upsertYamlList, normalizeWordList } from "../../src/lib/core/portals-merge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
/** Source with whole-line comments dropped — the route's header explains the two
 *  rules by naming the code it replaced, and that prose must not trip the checks
 *  on the code itself. */
const code = (rel) =>
  readFileSync(join(here, "../../src", rel), "utf8")
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .join("\n")
    .replace(/\s+/g, " ");

const FIXTURE = `# Portal Scanner Configuration — Example User
# 目标岗位：软件项目经理 / 技术经理 · 期望城市：郑州

# -- Location filter --
location_filter:
  allow:
    - "郑州"

# -- Title filter --
title_filter:
  # 软件域限定词：标题含任一即算软件向。
  # 刻意不用裸「项目经理/PM」——否则「工程项目经理」(土建) 会一并进来；
  positive:
    - "软件"
    - "技术"
    - "软件产品"          # 原为裸"产品"，误中酒类产品经理（啤酒）；改为软件产品
    - "解决方案"          # titles模式(2026-08-23): 解决方案架构师/工程师/专家

  # -- 黑名单 --
  negative:
    - "销售"
    - "啤酒"              # 新增：拦截酒类/快消误中（如美团酒类产品经理）
  seniority_boost:
    - "资深"
`;

const lines = (s) => s.split(/\r?\n/);
const TITLE = ["title_filter", "positive"];
const ALLOW = ["location_filter", "allow"];

test("append keeps every existing line and adds only the words that are missing", () => {
  const out = upsertYamlList(FIXTURE, TITLE, ["IT", "软件", "Engineer"]);
  assert.deepEqual(out.added, ["IT", "Engineer"], "「软件」 is already in the block — re-adding it would duplicate a word the scanner already matches");
  assert.deepEqual(out.skipped, ["软件"]);
  assert.equal(out.changed, true);

  // Strongest statement of "nothing else moved": drop the inserted lines and the
  // file must be byte-identical to what it was.
  const added = lines(out.text).filter((l) => /^\s*- "?(IT|Engineer)"?$/.test(l));
  assert.equal(added.length, 2, "expected exactly the two new items");
  assert.deepEqual(lines(out.text).filter((l) => !added.includes(l)), lines(FIXTURE), "every original line must survive, in order");
});

test("new items land right after the last existing one, before the next block", () => {
  const out = upsertYamlList(FIXTURE, TITLE, ["IT"]);
  const ls = lines(out.text);
  const i = ls.findIndex((l) => l.includes('"IT"'));
  assert.ok(ls[i - 1].includes("解决方案"), `new items go after the block's last item, got:\n${ls.slice(i - 2, i + 3).join("\n")}`);
  // Regression guard for the case that is easy to get wrong: blank lines and
  // comments between the block and the next key belong to the NEXT block
  // (「# -- 黑名单 --」 introduces `negative`), so an append must step back over
  // them instead of parking the new words underneath that heading.
  assert.equal(ls[i + 1], "", "the blank line that separated the two blocks must stay after the new items");
  assert.match(ls[i + 2], /^\s*# -- 黑名单 --$/, "and the heading must still sit directly above the block it introduces");
});

test("dedupe normalizes case and surrounding whitespace only", () => {
  const src = `title_filter:\n  positive:\n    - "IT"\n    - "Software"\n`;
  const out = upsertYamlList(src, TITLE, ["it", "  software  ", "IT 经理"]);
  assert.deepEqual(out.skipped, ["it", "software"], "「it」 folds onto the stored 「IT」 — a second copy is a word the scanner matches twice");
  assert.deepEqual(out.added, ["IT 经理"], "and nothing beyond case/edge-space folding: 「IT 经理」 is a different word");
  const noop = upsertYamlList(FIXTURE, TITLE, ["软件", " 技术 "]);
  assert.deepEqual(noop.added, []);
  assert.deepEqual(noop.skipped, ["软件", "技术"]);
  assert.equal(noop.changed, false);
  assert.equal(noop.text, FIXTURE, "nothing to add → the file must not be rewritten (a no-op write still churns a backup)");
});

test("an empty word list is a no-op, never a clear", () => {
  const out = upsertYamlList(FIXTURE, TITLE, []);
  assert.equal(out.changed, false);
  assert.equal(out.text, FIXTURE);
  assert.deepEqual(out.added, []);
});

test("a missing child key is created without duplicating its parent", () => {
  const noPositive = FIXTURE.replace(/  positive:\n(?:    .*\n)+/, "");
  assert.ok(!noPositive.includes("positive:"), "fixture setup");
  const out = upsertYamlList(noPositive, TITLE, ["IT"]);
  assert.equal(out.created, true);
  assert.equal((out.text.match(/^title_filter:$/gm) ?? []).length, 1, "appending a second `title_filter:` would give the document a duplicate top-level key");
  const doc = yaml.load(out.text);
  assert.deepEqual(doc.title_filter.positive, ["IT"]);
  assert.deepEqual(doc.title_filter.negative, ["销售", "啤酒"], "the sibling that was already there must be untouched");
  assert.deepEqual(doc.title_filter.seniority_boost, ["资深"]);
});

test("a missing parent key is appended at EOF and the document stays parseable", () => {
  const bare = "# my portals\nlocation_filter:\n  allow:\n    - \"郑州\"\n";
  const out = upsertYamlList(bare, TITLE, ["IT", "技术"]);
  assert.equal(out.created, true);
  const doc = yaml.load(out.text);
  assert.deepEqual(doc.title_filter.positive, ["IT", "技术"]);
  assert.deepEqual(doc.location_filter.allow, ["郑州"], "appending at column 0 closes the previous block-sequence instead of nesting inside it");
  assert.ok(out.text.startsWith("# my portals\n"), "the header comment survives even on the create path");
});

test("replace mode rewrites the block and nothing else", () => {
  const out = upsertYamlList(FIXTURE, ALLOW, ["郑州", "洛阳"], { mode: "replace" });
  assert.equal(out.changed, true);
  const doc = yaml.load(out.text);
  assert.deepEqual(doc.location_filter.allow, ["郑州", "洛阳"]);
  assert.deepEqual(doc.title_filter.positive, ["软件", "技术", "软件产品", "解决方案"], "the replace must be scoped to the block it names");
  assert.match(out.text, /# -- Salary filter --|# -- Title filter --/, "section headings survive");
  assert.deepEqual(
    lines(out.text).filter((l) => !l.includes('"洛阳"')),
    lines(FIXTURE),
    "a replace removes exactly the old items and adds exactly the new ones — the blank line + comment separating the two sections are not part of the block",
  );
});

test("existing entries are read through their quoting and trailing comments", () => {
  const src = `title_filter:\n  positive:\n    - "软件产品"          # 原为裸"产品"，误中酒类产品经理（啤酒）；改为软件产品\n    - 'IT'\n    - 技术\n`;
  const out = upsertYamlList(src, TITLE, ["软件产品", "IT", "技术", "啤酒"]);
  assert.deepEqual(out.added, ["啤酒"], "a trailing comment must not turn 「软件产品」 into a different word, and single-quoted / bare scalars must count too");
});

test("a word that would break YAML is quoted on the way in", () => {
  const out = upsertYamlList(FIXTURE, TITLE, ["Project Manager: senior", "- not a list item"]);
  const doc = yaml.load(out.text);
  assert.deepEqual(doc.title_filter.positive.slice(-2), ["Project Manager: senior", "- not a list item"]);
});

test("CRLF files stay CRLF", () => {
  const crlf = FIXTURE.replace(/\n/g, "\r\n");
  const out = upsertYamlList(crlf, TITLE, ["IT"]);
  assert.ok(out.text.includes("\r\n"), "line endings must be the file's, not the code's");
  assert.equal(out.text.split("\r\n").length, crlf.split("\r\n").length + 1, "one item added, one line added");
});

test("the write path is the surgery, and a no-op writes nothing", () => {
  const src = code("app/api/portals/route.ts");
  assert.match(
    src,
    /upsertYamlList\(base, \["title_filter", "positive"\], roles, \{ mode: seeding \? "replace" : "append" \}\)/,
    "the route must append into an existing portals.yml, and only replace when it is seeding the file from our own template",
  );
  assert.ok(!/yaml\.dump/.test(src), "a dump write deletes every comment in portals.yml — that is the whole reason this module exists");
  assert.ok(!/tf\.positive = roles/.test(src), "the wholesale replace is what silently dropped the user's hand-written words");
  assert.match(src, /if \(roles\.length === 0\) return/, "an empty role list must return before any write — 「no new roles」 is not 「clear the list」");
  assert.match(src, /if \(text === existing\) \{/, "...and an unchanged document must not be rewritten (a no-op write still churns a backup and the file's mtime)");
});

// ── 词表写回口（gate-visibility 工单 03）────────────────────────────────────
// `[]` 是合法指令（这一侧清空），畸形请求不是。把后者读成前者，会因为一个坏请求删掉用户
// 整张表——所以校验返回 null，路由拒写，而不是「按空表处理」。

test("normalizeWordList: 清空是合法指令，畸形不是", () => {
  assert.deepEqual(normalizeWordList([]), [], "空表 = 清空这一侧，必须被当作合法指令放行");
  assert.deepEqual(normalizeWordList([" IT ", "it", "技术", ""]), ["IT", "技术"], "去首尾空白、按大小写归一去重、保持顺序");
  assert.deepEqual(normalizeWordList(["软件", 42, null, "   ", "技术"]), ["软件", "技术"], "表里的非字符串跳过，不该让整次保存失败");
  for (const bad of [undefined, null, "IT", 42, {}]) {
    assert.equal(normalizeWordList(bad), null, `${JSON.stringify(bad)} 不是词表：拒写，而不是当成清空`);
  }
  assert.equal(normalizeWordList(["x".repeat(121)]), null, "超长词是配置事故，不是功能");
  assert.equal(normalizeWordList(Array.from({ length: 201 }, (_, i) => `w${i}`)), null, "词表要有上限：每个词都要在每张卡片上匹配一次");
});

test("the word-list route replaces both blocks through the comment-preserving surgery", () => {
  const src = code("app/api/portals/title-filter/route.ts");
  assert.match(
    src,
    /upsertYamlList\(text, \["title_filter", "positive"\], positive, \{ mode: "replace" \}\)/,
    "the editor must be able to REMOVE a word, so this side is a replace — appending keeps the user's words but makes a deletion impossible",
  );
  assert.match(
    src,
    /upsertYamlList\(next, \["title_filter", "negative"\], negative, \{ mode: "replace" \}\)/,
    "both sides, or the panel silently loses the ability to edit one of them",
  );
  assert.ok(!/yaml\.dump/.test(src), "a dump write deletes every comment in portals.yml — those comments are the rationale for the list");
  assert.match(
    src,
    /if \(!positive \|\| !negative\) return Response\.json\(\{ error: "invalid word list" \}, \{ status: 400 \}\)/,
    "a malformed list must be refused BEFORE the file is touched",
  );
  assert.match(src, /atomicWriteWithBackup\(file, next\)/, "and the write stays atomic + backed up");
});

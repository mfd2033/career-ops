// web 端不得再有指向 career-ops.org 的出链（本 fork 决策）。
//
// 为什么钉在源码上：TSX 不能在 node --test 里导入（无渲染基建，ADR-0057/0059/0060
// 同口径），而这条约束是纯结构事实。先例：pipeline-single-nav-entry.test.mjs、
// report-route-parity.test.mjs。上游 merge 只要把外链带回来，这里当场变红——
// 靠人记住「那个链接我们删过」是守不住的。
//
// 唯一的豁免是方法论全文里的「来源与许可」段：那是署名与出处，是引用，
// 不是产品出口。它住在 src/content/（不参与代码扫描），本测试反过来钉住它
// 必须存在——署名丢了同样是回归。
//
// Run:  node --test tests/lib/no-upstream-site-links.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(WEB, "src");
const NEEDLE = "career-ops.org";
const CODE_EXT = /\.(ts|tsx|mjs|js|jsx)$/;
// src/content 是方法论文档正文的存放地（字符串模块，见 ADR-0072），
// 它按设计包含上游出处链接，因此整目录不参与出链扫描。
const CONTENT_DIR = join(SRC, "content") + sep;

/** 递归列出 src 下所有文件（相对路径），不依赖 git。 */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/**
 * 剥掉注释，只留代码。源码守卫量的是结构不是散文：一句提到上游域名的
 * 说明注释（比如「基于上游方法论文改写」）不该让计数假性变红。
 * 只处理块注释与行注释两种形态，够用且不误伤字符串。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

const codeFiles = walk(SRC).filter((f) => CODE_EXT.test(f) && !f.startsWith(CONTENT_DIR));
// 只钉方法论那两份文档：src 下将来可能还有别的文件，不该被这条断言误伤。
const METHODOLOGY_DOCS = [join(CONTENT_DIR, "methodology.zh.ts"), join(CONTENT_DIR, "methodology.en.ts")];

test("no source file under web/src links to career-ops.org", () => {
  assert.ok(codeFiles.length > 40, `scan found only ${codeFiles.length} code files — the walker is broken`);
  const offenders = codeFiles
    .map((f) => [relative(SRC, f), stripComments(readFileSync(f, "utf8")).split(NEEDLE).length - 1])
    .filter(([, n]) => n > 0);
  assert.deepEqual(offenders, [], "web 源码里出现了指向 career-ops.org 的字符串（注释除外）——改回站内 /methodology 或删除");
});

test("the methodology entry links in-app, not outward", () => {
  const code = stripComments(readFileSync(join(SRC, "components", "score-methodology.tsx"), "utf8"));
  assert.equal(code.includes('href="/methodology"'), true, "「完整方法论」必须指向站内 /methodology");
  assert.equal(code.includes("target=\"_blank\""), false, "站内文档不该开新标签页");
});

test("the methodology docs keep the upstream attribution", () => {
  for (const f of METHODOLOGY_DOCS) {
    const text = readFileSync(f, "utf8");
    assert.ok(text.length > 3000, `${relative(SRC, f)} 正文短于 3000 字符，不像一份完整文档`);
    assert.ok(text.includes("career-ops.org/methodology"), `${relative(SRC, f)} 丢了上游原文出处（署名与许可）`);
    assert.match(text, /MIT/, `${relative(SRC, f)} 丢了 MIT 许可声明`);
    assert.match(text, /Santiago/, `${relative(SRC, f)} 丢了原作者署名`);
  }
});

// Markdown 简历导入：纯逻辑单测 + UI 接线守卫。
//
// 逻辑层（isImportableName / normalizeImportedMarkdown / readMarkdownCv）直接
// import 生产模块，测与线上永不漂移；组件层无测试面（同 ADR-0077 的做法），
// 用源码字符串守卫确认入口真的挂在简历页、文案真的走 i18n 键。
//
// Run:  node --test tests/lib/cv-import.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CV_BYTES,
  isImportableName,
  normalizeImportedMarkdown,
  readMarkdownCv,
} from "../../src/lib/cv/import.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** 结构兼容的 File 替身：只关心 name / size / text()。 */
function fakeFile(name, text, size = Buffer.byteLength(text, "utf8")) {
  return { name, size, text: async () => text };
}

// ── 扩展名 ────────────────────────────────────────────────────────────────
test("isImportableName：只认 .md / .markdown / .txt（大小写不敏感）", () => {
  for (const name of ["cv.md", "CV.MD", "resume.markdown", "简历.txt", " cv.md "]) {
    assert.equal(isImportableName(name), true, `${name} 应可导入`);
  }
  for (const name of ["cv.pdf", "cv.docx", "cv", "", "cv.md.pdf", ".md.bak"]) {
    assert.equal(isImportableName(name), false, `${name} 不应可导入`);
  }
});

// ── 归一化 ────────────────────────────────────────────────────────────────
test("normalizeImportedMarkdown：去 BOM，否则首行 `# 姓名` 会被当成普通文本", () => {
  assert.equal(normalizeImportedMarkdown("\uFEFF# 张三"), "# 张三");
  // 只动开头，正文里的 U+FEFF 原样保留
  assert.equal(normalizeImportedMarkdown("# 张\uFEFF三"), "# 张\uFEFF三");
});

test("normalizeImportedMarkdown：CRLF 与孤立 CR 统一成 LF，尾部空白剥掉", () => {
  assert.equal(normalizeImportedMarkdown("# A\r\n\r\n- x\r\n"), "# A\n\n- x");
  assert.equal(normalizeImportedMarkdown("# A\r\r- x"), "# A\n\n- x");
  assert.equal(normalizeImportedMarkdown("  \n# A\n  "), "# A");
  assert.equal(normalizeImportedMarkdown(undefined), "");
});

// ── 读取 ──────────────────────────────────────────────────────────────────
test("readMarkdownCv：合法 .md → ok，内容是归一化后的 Markdown", async () => {
  const res = await readMarkdownCv(fakeFile("cv.md", "\uFEFF# 张三\r\n\r\n## 经历\r\n- 工程师\r\n"));
  assert.deepEqual(res, { ok: true, content: "# 张三\n\n## 经历\n- 工程师" });
});

test("readMarkdownCv：非 .md 扩展名直接拒，不读文件内容", async () => {
  let read = false;
  const res = await readMarkdownCv({
    name: "cv.pdf",
    size: 10,
    text: async () => {
      read = true;
      return "x";
    },
  });
  assert.deepEqual(res, { ok: false, reason: "ext" });
  assert.equal(read, false, "扩展名不合格时不应消耗读取");
});

test("readMarkdownCv：超过 200KB 直接拒（与 /api/cv 保存上限同源）", async () => {
  const res = await readMarkdownCv(fakeFile("cv.md", "# 张三", MAX_CV_BYTES + 1));
  assert.deepEqual(res, { ok: false, reason: "too-large" });
});

test("readMarkdownCv：恰好 200KB 仍可导入（边界不误伤）", async () => {
  const body = "a".repeat(MAX_CV_BYTES);
  const res = await readMarkdownCv(fakeFile("cv.md", body));
  assert.equal(res.ok, true);
  assert.equal(res.content.length, MAX_CV_BYTES);
});

test("readMarkdownCv：归一化后按真实字节复核——size 撒谎的多字节文件也拦得住", async () => {
  // 汉字 3 字节：size 报小值绕过第一道闸，归一化后的字节复核必须兜住
  const text = "简".repeat(Math.floor(MAX_CV_BYTES / 3) + 1);
  const res = await readMarkdownCv({ name: "cv.md", size: 1, text: async () => text });
  assert.deepEqual(res, { ok: false, reason: "too-large" });
});

test("readMarkdownCv：空白文件 → empty（不让空内容顶掉现有 cv.md）", async () => {
  for (const text of ["", "   ", "\r\n\r\n", "\uFEFF"]) {
    const res = await readMarkdownCv(fakeFile("cv.md", text));
    assert.deepEqual(res, { ok: false, reason: "empty" }, JSON.stringify(text));
  }
});

test("readMarkdownCv：读取异常 → read（交给 UI 提示重试，不抛）", async () => {
  const res = await readMarkdownCv({
    name: "cv.md",
    size: 10,
    text: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(res, { ok: false, reason: "read" });
});

// ── UI 接线守卫 ───────────────────────────────────────────────────────────
test("接线：简历页页头挂了导入按钮，accept 限定纯文本，保存仍走 POST /api/cv", () => {
  const editor = readFileSync(join(here, "../../src/components/cv-editor.tsx"), "utf8");

  assert.match(editor, /import \{ readMarkdownCv, type CvImportError \} from "@\/lib\/cv\/import"/);
  assert.match(editor, /accept="\.md,\.markdown,\.txt"/);
  assert.match(editor, /void pickFile\(file\)/);
  // 不新增写路径：导入只填编辑器，落盘仍是原有保存接口（旧版先被快照）
  assert.match(editor, /fetch\("\/api\/cv", \{/);
  // 已有内容时先确认，避免静默覆盖手改内容
  assert.match(editor, /if \(content\.trim\(\)\) \{\s*setPendingImport/);
});

test("接线：保存上限单一来源——路由复用 lib/cv/import 的 MAX_CV_BYTES", () => {
  const route = readFileSync(join(here, "../../src/app/api/cv/route.ts"), "utf8");
  assert.match(route, /import \{ MAX_CV_BYTES \} from "@\/lib\/cv\/import"/);
  assert.doesNotMatch(route, /const MAX_CV_BYTES\s*=\s*200_000/, "不应再有第二份硬编码上限");
});

test("i18n：cv 语料簇 en/zh 键集合对称且同序", () => {
  const src = readFileSync(join(here, "../../src/lib/i18n/clusters/cv.ts"), "utf8");
  const keys = [...src.matchAll(/"([^"]+)":\s*"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0 && keys.length % 2 === 0, "语料簇应分成 en/zh 两块等量键");
  const half = keys.length / 2;
  assert.deepEqual(keys.slice(0, half), keys.slice(half));
  // 导入相关的键必须两语都有
  for (const key of ["cv.import.button", "cv.import.confirmTitle", "cv.import.errTooLarge"]) {
    assert.ok(keys.slice(0, half).includes(key), `en 缺 ${key}`);
  }
});

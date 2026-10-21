// Tests for market-modes.mjs — profile.yml 的 `language.modes_dir` → 实际评估模式文件。
//
// 为什么值得锁：
//   1. 每个语言目录的评估文件名不同（de=angebot、fr=offre、ja=kyujin、zh=oferta），
//      猜错就是「静默换了套评分规则」，比报错难查得多；
//   2. `language.modes_dir` 直接来自用户可编辑的 profile.yml，必须挡住 `..` 与绝对路径；
//   3. 回落必须带 warning —— 静默回落等于让用户以为中国口径生效了，其实没生效。
//
// Run:  node --test tests/lib/market-modes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveMarketMode,
  normalizeModesDir,
  MARKET_EVAL_FILES,
  ROOT_EVAL_FILE,
} from "../../src/lib/market-modes.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const AVAILABLE = Object.keys(MARKET_EVAL_FILES);

test("unset / empty value → root mode set, no warning", () => {
  for (const raw of [undefined, null, "", "   "]) {
    assert.deepEqual(resolveMarketMode({ raw, available: AVAILABLE }), {
      dir: null,
      evalFile: ROOT_EVAL_FILE,
      sharedFile: "modes/_shared.md",
      warning: null,
    });
  }
});

test("modes/zh resolves to the Chinese evaluation file and its own _shared.md", () => {
  const out = resolveMarketMode({ raw: "modes/zh", available: AVAILABLE });
  assert.equal(out.dir, "modes/zh");
  assert.equal(out.evalFile, "modes/zh/oferta.md");
  assert.equal(out.sharedFile, "modes/zh/_shared.md");
  assert.equal(out.warning, null);
});

test("localized evaluation filenames are not guessed", () => {
  assert.equal(resolveMarketMode({ raw: "modes/de", available: AVAILABLE }).evalFile, "modes/de/angebot.md");
  assert.equal(resolveMarketMode({ raw: "modes/fr", available: AVAILABLE }).evalFile, "modes/fr/offre.md");
  assert.equal(resolveMarketMode({ raw: "modes/ja", available: AVAILABLE }).evalFile, "modes/ja/kyujin.md");
  assert.equal(resolveMarketMode({ raw: "modes/zh-TW", available: AVAILABLE }).evalFile, "modes/zh-TW/oferta.md");
});

test("trailing slashes and backslashes normalize to the same directory", () => {
  for (const raw of ["modes/zh/", "modes/zh", " modes/zh ", "modes\\zh"]) {
    assert.equal(resolveMarketMode({ raw, available: AVAILABLE }).dir, "modes/zh", `raw=${JSON.stringify(raw)}`);
  }
});

test("a directory that does not exist falls back WITH a warning", () => {
  const out = resolveMarketMode({ raw: "modes/xx", available: AVAILABLE });
  assert.equal(out.dir, null);
  assert.equal(out.evalFile, ROOT_EVAL_FILE);
  assert.match(out.warning ?? "", /不存在|不是模式集/);
});

test("path traversal and absolute paths are rejected before touching the filesystem", () => {
  for (const raw of ["modes/../../etc", "/etc/passwd", "modes/zh/../de", "modes/zh/oferta.md", "../modes/zh"]) {
    const out = resolveMarketMode({ raw, available: AVAILABLE });
    assert.equal(out.dir, null, `raw=${JSON.stringify(raw)}`);
    assert.match(out.warning ?? "", /不合法/, `raw=${JSON.stringify(raw)}`);
  }
});

test("an existing directory with no registered evaluation file falls back WITH a warning", () => {
  // 目录名的语法要合法（两字母），只是映射表里没有它 —— 这才是「目录存在但未登记」
  const out = resolveMarketMode({ raw: "modes/xx", available: ["xx"] });
  assert.equal(out.dir, null);
  assert.match(out.warning ?? "", /没有登记的评估模式文件/);
});

test("normalizeModesDir keeps only two-letter / two-letter-region slugs", () => {
  assert.equal(normalizeModesDir("modes/zh"), "zh");
  assert.equal(normalizeModesDir("modes/zh-tw"), "zh-tw"); // 保持原大小写：可用性校验会挡住与 modes/zh-TW 不匹配的写法
  assert.equal(normalizeModesDir("modes/ZH"), "ZH");
  assert.equal(normalizeModesDir("modes/en-US"), "en-US");
  assert.equal(normalizeModesDir("modes/english"), null);
  assert.equal(normalizeModesDir("modes/"), null);
  assert.equal(normalizeModesDir(null), null);
  assert.equal(normalizeModesDir(42), null);
});

test("every mapped directory really ships the file it declares", () => {
  // 集成型守卫：映射表写错（或上游重命名了文件）会让 zh 模式静默读不到规则。
  for (const [slug, file] of Object.entries(MARKET_EVAL_FILES)) {
    const dir = path.join(REPO_ROOT, "modes", slug);
    if (!fs.existsSync(dir)) continue; // 上游没带这个语言目录时不算错
    assert.ok(fs.existsSync(path.join(dir, file)), `modes/${slug}/${file} is missing`);
    assert.ok(fs.existsSync(path.join(dir, "_shared.md")), `modes/${slug}/_shared.md is missing`);
  }
});

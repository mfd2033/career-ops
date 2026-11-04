// ADR-0097：未检测到的 CLI 可以指定安装目录，并在保存前就地测试。
//
// 这条特性的失败方式都很安静，所以守卫分两半：
//   1. 纯函数（cli-dirs.mjs）—— 归一化/清洗/归属判定，直接测真值。
//   2. 接线 —— clis.ts / app-config.ts / 两条路由 / 配置页以文本断言（这些文件是
//      TS/TSX，本套件是 .mjs，与 clis-coverage.test.mjs 同一取舍：不需要构建即可守
//      住「检测与派发用同一条解析路径」「测试接口只在这个目录里找」这两个要害）。
//
// Run:  node --test tests/lib/cli-custom-dirs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cliDirsSignature,
  isInsideDir,
  normalizeCliDir,
  sanitizeCliDirs,
} from "../../src/lib/cli-dirs.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(WEB, ...parts), "utf8");

const HOME = path.resolve("home", "tester");
/** 一个平台无关的绝对目录（不同平台拼出来的形状不同，期望值也用 path 算）。 */
const ABS = path.resolve("tools", "engine", "bin");

// --- normalizeCliDir ---------------------------------------------------------

test("normalizeCliDir keeps an absolute dir and drops a trailing separator", () => {
  assert.equal(normalizeCliDir(ABS, HOME), ABS);
  assert.equal(normalizeCliDir(`${ABS}${path.sep}`, HOME), ABS);
  assert.equal(normalizeCliDir(`  ${ABS}  `, HOME), ABS, "surrounding whitespace is not part of a path");
});

test("normalizeCliDir strips the quotes Explorer's Copy as path adds", () => {
  assert.equal(normalizeCliDir(`"${ABS}"`, HOME), ABS);
  assert.equal(normalizeCliDir(`'${ABS}'`, HOME), ABS);
  // A lone quote is not a wrapper — it must survive rather than be sliced away.
  assert.equal(normalizeCliDir(`"${ABS}`, HOME), null, "an unterminated quote cannot be an absolute path");
});

test("normalizeCliDir expands ~ against the injected home", () => {
  assert.equal(normalizeCliDir("~", HOME), HOME);
  assert.equal(normalizeCliDir(`~${path.sep}tools`, HOME), path.join(HOME, "tools"));
});

test("normalizeCliDir rejects what a server-side resolver cannot use", () => {
  // 相对路径的基准是被派发子进程的 cwd，用户无从知道 —— 拒绝而不是猜。
  assert.equal(normalizeCliDir("tools/bin", HOME), null);
  assert.equal(normalizeCliDir(".", HOME), null);
  assert.equal(normalizeCliDir("", HOME), null);
  assert.equal(normalizeCliDir("   ", HOME), null);
  assert.equal(normalizeCliDir(null, HOME), null);
  assert.equal(normalizeCliDir(42, HOME), null);
  assert.equal(normalizeCliDir(`"${""}"`, HOME), null);
  assert.equal(normalizeCliDir(path.sep + "x".repeat(600), HOME), null, "an absurdly long value is a paste error");
});

test("normalizeCliDir does not expand ~ in the middle of a path", () => {
  const notAPrefix = path.join(ABS, "~backup");
  assert.equal(normalizeCliDir(notAPrefix, HOME), notAPrefix);
});

// --- sanitizeCliDirs ---------------------------------------------------------

test("sanitizeCliDirs keeps engine ids and drops everything unusable", () => {
  const out = sanitizeCliDirs(
    {
      claude: ABS,
      "qoder-cn": `${ABS}${path.sep}`,
      relative: "bin/tools", // value unusable
      "Bad Key": ABS, // key is not an engine id
      claude2: "", // empty
    },
    HOME,
  );
  assert.deepEqual(out, { claude: ABS, "qoder-cn": ABS });
});

test("sanitizeCliDirs tolerates anything that is not a map", () => {
  assert.deepEqual(sanitizeCliDirs(undefined), {});
  assert.deepEqual(sanitizeCliDirs(null), {});
  assert.deepEqual(sanitizeCliDirs("claude"), {});
  assert.deepEqual(sanitizeCliDirs([ABS]), {}, "an array is not an engine→dir map");
  assert.deepEqual(sanitizeCliDirs({}), {});
});

// --- isInsideDir -------------------------------------------------------------

test("isInsideDir answers 'did this binary come from the folder I chose'", () => {
  assert.equal(isInsideDir(ABS, path.join(ABS, "claude.exe")), true);
  assert.equal(isInsideDir(ABS, path.join(ABS, "nested", "claude")), true);
  // /opt/bin2/x must not be counted as inside /opt/bin (string-prefix would).
  assert.equal(isInsideDir(ABS, `${ABS}2${path.sep}claude`), false);
  assert.equal(isInsideDir(ABS, ABS), false, "a directory is not the binary");
  assert.equal(isInsideDir("", ABS), false);
});

// --- cliDirsSignature --------------------------------------------------------

test("cliDirsSignature ignores insertion order", () => {
  const a = cliDirsSignature({ claude: ABS, codex: HOME });
  const b = cliDirsSignature({ codex: HOME, claude: ABS });
  assert.equal(a, b);
  assert.notEqual(a, cliDirsSignature({ claude: ABS }));
  assert.equal(cliDirsSignature(undefined), cliDirsSignature({}));
});

// --- wiring: clis.ts ---------------------------------------------------------
//
// clis.ts 是 TS 而本套件是 .mjs，接线按文本断言（同 clis-coverage.test.mjs）。
// 注释先剥掉：一个把实现注释里的字样也算进去的守卫永远不会变红。

const CLIS_TS = read("src", "lib", "clis.ts");
const stripComments = (src) => src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const clisSrc = stripComments(CLIS_TS);

test("the fixture this guard reads still looks like itself", () => {
  assert.ok(clisSrc.includes("function findBinFor"), "clis.ts shape changed — has resolution moved?");
  assert.ok(clisSrc.includes("function detectClis"), "clis.ts shape changed — has detection moved?");
});

test("a user-specified dir is searched BEFORE the auto-discovered ones", () => {
  // ADR-0097 决议 2：显式指定是一次覆盖，必须真的覆盖 —— 「我改了目录但用的还是
  // PATH 里那个」是这个功能最容易出的谎。
  const body = /function dirsFor[\s\S]*?\n}/.exec(clisSrc);
  assert.ok(body, "dirsFor is gone — has the resolution path changed shape?");
  assert.match(body[0], /customDir\s*\?\s*\[customDir,\s*\.\.\.shared\]\s*:\s*shared/, "the custom dir must be prepended");
});

test("detection and dispatch both pass the engine's custom dir through findBinFor", () => {
  // 检测说已安装、派发却 spawn 不到，是 ADR-0052 立过规矩的那个 bug。目录必须
  // 走同一条路：两处调用都带上自定义目录。
  assert.match(clisSrc, /findBinFor\(c,\s*customDir\)/, "detectClis must hand its custom dir to findBinFor");
  assert.match(
    clisSrc,
    /findBinFor\(spec,\s*readCustomCliDirs\(\)\[id\]\)/,
    "resolveCli must hand the configured dir to findBinFor",
  );
});

test("the custom dirs are read from the server config, not from the browser", () => {
  // 派发是 headless 子进程，读不到 localStorage（ADR-0004 D3）。
  const body = /export function readCustomCliDirs[\s\S]*?\n}/.exec(clisSrc);
  assert.ok(body, "readCustomCliDirs is gone");
  assert.match(body[0], /readAppConfig\(\)/, "the dirs must come from the server-side config");
  assert.match(body[0], /sanitizeCliDirs\(/, "and be sanitized before use");
});

test("detection cache is invalidated by the dir map, not only by ?refresh=1", () => {
  // 写目录的是 /api/config，读检测的是 /api/clis：靠调用方记得刷就是押前端记性。
  const body = /export (?:async )?function detectClisCached[\s\S]*?\n}/.exec(clisSrc);
  assert.ok(body, "detectClisCached is gone");
  assert.match(body[0], /cliDirsSignature\(readCustomCliDirs\(\)\)/, "the cache key must fold in the dir signature");
});

test("the dir probe looks ONLY inside the given folder", () => {
  // 回落 PATH 会让「测试通过」可能测的是另一个位置的同类二进制（ADR-0097 决议 5）。
  const body = /export (?:async )?function verifyCliDir[\s\S]*?\n}/.exec(clisSrc);
  assert.ok(body, "verifyCliDir is gone");
  assert.match(body[0], /findBin\(spec\.bin,\s*\[dir\]\)/, "verifyCliDir must search the one dir it was given");
  assert.doesNotMatch(body[0], /searchDirs\(\)/, "the probe must not fall back to the auto chain");
});

test("every failure of the probe is a class code, never an internal message", () => {
  const body = /export (?:async )?function verifyCliDir[\s\S]*?\n}/.exec(clisSrc);
  assert.ok(body);
  for (const code of ["unknown-cli", "not-absolute", "not-found", "no-output"]) {
    assert.match(body[0], new RegExp(`"${code}"`), `verifyCliDir never reports ${code}`);
  }
});

// --- wiring: config plumbing -------------------------------------------------

const APP_CONFIG = read("src", "lib", "app-config.ts");
const CONFIG_ROUTE = read("src", "app", "api", "config", "route.ts");
const VERIFY_ROUTE = read("src", "app", "api", "clis", "verify", "route.ts");
const FORM = read("src", "components", "config-form.tsx");
const SAVED_CLI = read("src", "lib", "saved-cli.ts");
const DICT = read("src", "lib", "i18n", "clusters", "config.ts");

test("cliDirs is part of the persisted server config and is sanitized on read", () => {
  assert.match(APP_CONFIG, /cliDirs\?: Record<string, string>/, "AppConfig must carry cliDirs");
  assert.match(APP_CONFIG, /sanitizeCliDirs\(raw\.cliDirs/, "readAppConfig must sanitize what it reads");
  assert.match(CONFIG_ROUTE, /"cliDirs"/, "POST /api/config must accept cliDirs");
  assert.match(CONFIG_ROUTE, /sanitizeCliDirs\(rec\.cliDirs/, "and sanitize it before writing");
});

test("the probe is a read-only POST route", () => {
  assert.match(VERIFY_ROUTE, /export async function POST/, "POST /api/clis/verify must exist");
  assert.match(VERIFY_ROUTE, /verifyCliDir\(cliId, dir\)/, "the route must delegate to verifyCliDir");
  assert.doesNotMatch(VERIFY_ROUTE, /writeAppConfig/, "testing a dir must never write config");
});

test("the page reads saved dirs from the server and saves them through the unified save bar", () => {
  assert.match(SAVED_CLI, /export async function readSavedCliDirs/, "readSavedCliDirs must exist");
  assert.match(FORM, /readSavedCliDirs\(\)\.then\(setCliDirs\)/, "the page must prefill from the server");
  assert.match(FORM, /pushServerConfig\(\{ cliId, model: nextModel, cliDirs: dirsPayload \}\)/, "save() must persist the dirs");
  assert.match(FORM, /\/api\/clis\/verify/, "the test button must call the verify route");
  assert.match(FORM, /touch\("cliDirs"\)/, "editing a dir must count as an unsaved change");
});

test("the not-installed panel offers a folder input and a test button", () => {
  // ADR-0097 决议 7：测试与保存分离 —— 按钮只验证草稿。
  assert.match(FORM, /setCliDirs\(\(prev\) => \(\{ \.\.\.prev, \[c\.id\]: e\.target\.value \}\)\)/, "missing engines need a dir input");
  assert.match(FORM, /onClick=\{\(\) => void testCliDir\(c\.id\)\}/, "missing engines need a test button");
});

test("the folder row holds up to the UI checklist (cursor, live region, no hover shift, a11y)", () => {
  // hover 只换颜色：hover 里挂 padding / 尺寸 / 缩放都会让整行跳一下。
  assert.doesNotMatch(FORM, /hover:(?:p-|m-|w-|h-|scale|text-\[|gap-)/, "hover must not change geometry");
  // Tailwind v4 的 preflight 把 button 设成 cursor: default，手型必须显式给。
  assert.match(FORM, /cursor-pointer items-center justify-center rounded-lg/, "the test button needs a pointer cursor");
  assert.match(FORM, /disabled:cursor-not-allowed/, "the busy/empty state must not look clickable");
  // 回执区常驻：只在有结果时成形，空态 sr-only —— 否则读屏用户永远听不到结论。
  assert.match(FORM, /role="status"\s*\n\s*aria-live="polite"/, "the result must be a persistent live region");
  assert.match(FORM, /: "sr-only",/, "an empty result must collapse without taking space");
  // 输入一改旧回执即作废，否则「✓ 可用」指的是上一个目录。
  assert.match(FORM, /clearDirCheck\(c\.id\);/, "editing the dir must drop the stale result");
  // 对比度：占位符走 AA token（浏览器默认灰 ~4.0:1 不过）；小字不低于 12px。
  assert.match(FORM, /placeholder:text-faint/, "the placeholder needs the AA token");
  assert.match(FORM, /font-mono text-xs text-foreground outline-none transition-colors placeholder:text-faint/, "the path field stays at 12px, not 11px");
  // 触控目标：手机上补 44px。
  assert.match(FORM, /max-sm:min-h-\[44px\]/, "touch targets need 44px on phones");
});

test("the new copy exists in BOTH dictionaries", () => {
  const [enBlock, zhBlock] = DICT.split("export const zh");
  assert.ok(enBlock && zhBlock, "config.ts shape changed — key parsing is stale");
  const KEYS = [
    "config.aiToolInstallLink",
    "config.cliDirTitle",
    "config.cliDirPlaceholder",
    "config.cliDirTest",
    "config.cliDirTesting",
    "config.cliDirOk",
    "config.cliDirNotFound",
    "config.cliDirNotAbsolute",
    "config.cliDirNoOutput",
    "config.cliDirProbeFailed",
    "config.cliDirUnknownCli",
    "config.cliDirSaveHint",
    "config.cliDirFromCustom",
  ];
  for (const key of KEYS) {
    assert.ok(enBlock.includes(`"${key}":`), `English dict is missing ${key}`);
    assert.ok(zhBlock.includes(`"${key}":`), `Chinese dict is missing ${key}`);
  }
});

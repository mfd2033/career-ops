// ADR-0097 决议 9：目录除了手输，还能点一下从系统文件夹对话框里选。
//
// 这条特性有两个不容易被注意到的失败面，所以守卫分三层：
//   1. 回执解析 —— 路径可能带中文/空格，PowerShell 管道的编码会把它嚼碎；
//   2. 选择器本身 —— 只有一个对话框、只走环境变量传参、失败后还能再用；
//   3. 接线 —— route/配置页/i18n 以文本断言（与 cli-custom-dirs.test.mjs 同一取舍：
//      TS/TSX 不构建也能守住「取消不留提示」「选完即验」这些契约）。
//
// Run:  node --test tests/lib/pick-dir.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PICK_SCRIPT,
  PICK_START_ENV,
  createDirectoryPicker,
  decodePickerOutput,
} from "../../src/lib/pick-dir.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts) => readFileSync(join(WEB, ...parts), "utf8");

/** 脚本那一侧的输出格式（base64 里装 UTF-8 字节）。 */
const encode = (value) => Buffer.from(value, "utf8").toString("base64");

// --- decodePickerOutput ------------------------------------------------------

test("a picked folder comes back byte-exact, including non-ASCII and spaces", () => {
  for (const dir of ["D:\\tools\\claude\\bin", "C:\\Program Files\\Mozilla\\x", "D:\\工具\\claude", "E:\\作業\\claude-agent"]) {
    assert.deepEqual(decodePickerOutput(`OK:${encode(dir)}\r\n`), { status: "picked", dir }, dir);
  }
});

test("cancelling is its own outcome, not a failure", () => {
  assert.deepEqual(decodePickerOutput("CANCEL\r\n"), { status: "cancelled" });
});

test("an in-dialog error is reported as a failure with the reason attached", () => {
  assert.deepEqual(decodePickerOutput("FAIL:Add-Type failed\r\n"), { status: "failed", reason: "Add-Type failed" });
});

test("silence is never read as a cancel: an empty stdout maps to timeout or spawn failure", () => {
  assert.deepEqual(decodePickerOutput("", Object.assign(new Error("killed"), { killed: true })), {
    status: "failed",
    reason: "timeout",
  });
  assert.deepEqual(decodePickerOutput("", new Error("spawn powershell ENOENT")), {
    status: "failed",
    reason: "spawn-failed",
  });
  assert.deepEqual(decodePickerOutput("   "), { status: "failed", reason: "no-output" });
});

test("an OK carrying a blank path is a failure, not a pick of nothing", () => {
  assert.deepEqual(decodePickerOutput(`OK:${encode("   ")}`), { status: "failed", reason: "empty-path" });
  // 没有 base64 载荷的裸 `OK:` 连回执都不算——别把它猜成一个目录。
  assert.deepEqual(decodePickerOutput("OK:"), { status: "failed", reason: "no-output" });
});

// --- the script itself -------------------------------------------------------

test("the script hands the path back as base64, because the console code page eats CJK paths", () => {
  assert.match(PICK_SCRIPT, /FolderBrowserDialog/, "it must be the shell's own folder picker");
  assert.match(PICK_SCRIPT, /ToBase64String/, "the path must not travel through the console encoding");
  assert.doesNotMatch(PICK_SCRIPT, /Write-Output\s+\$dialog\.SelectedPath/, "raw path on stdout gets re-encoded");
  assert.match(PICK_SCRIPT, new RegExp(`\\$env:${PICK_START_ENV}`), "the start folder arrives via the environment");
});

// --- createDirectoryPicker ---------------------------------------------------

test("the start folder travels through the environment, not the command line", async () => {
  let seen = null;
  const picker = createDirectoryPicker({
    platform: "win32",
    run: async (command, args, opts) => {
      seen = { command, args, opts };
      return { stdout: "CANCEL", error: null };
    },
  });
  await picker.pick({ start: "  D:\\Program Files\\claude  " });

  assert.equal(seen.command, "powershell");
  assert.equal(seen.opts.env[PICK_START_ENV], "D:\\Program Files\\claude", "quotes/spaces must survive untouched");
  assert.ok(seen.args.includes(PICK_SCRIPT), "the script itself is the last argument, unquoted by the shell");
  assert.ok(!seen.args.join(" ").includes("Program Files"), "a path in argv would need quoting rules we cannot test");
});

test("a second click while the dialog is open is refused instead of stacking dialogs", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const picker = createDirectoryPicker({
    platform: "win32",
    run: async () => {
      calls.push(1);
      await gate;
      return { stdout: "CANCEL", error: null };
    },
  });

  const first = picker.pick();
  assert.deepEqual(await picker.pick(), { status: "busy" });
  release();
  assert.deepEqual(await first, { status: "cancelled" });
  assert.equal(calls.length, 1, "the busy click must not spawn a second native dialog");
});

test("a failed pick releases the guard — the next click works", async () => {
  let attempt = 0;
  const picker = createDirectoryPicker({
    platform: "win32",
    run: async () => {
      attempt += 1;
      return attempt === 1 ? { stdout: "", error: Object.assign(new Error("killed"), { killed: true }) } : { stdout: "CANCEL", error: null };
    },
  });

  assert.deepEqual(await picker.pick(), { status: "failed", reason: "timeout" });
  assert.deepEqual(await picker.pick(), { status: "cancelled" });
  assert.equal(attempt, 2);
});

test("a spawn the environment refuses is a notice, not a 500", async () => {
  const picker = createDirectoryPicker({
    platform: "win32",
    run: async () => {
      // 沙箱/杀软/作业对象会在 spawn 这一步直接抛，而不是走 callback。
      throw Object.assign(new Error("spawn EPERM"), { code: "EPERM" });
    },
  });
  assert.deepEqual(await picker.pick(), { status: "failed", reason: "spawn-failed" });
  // 抛完之后 busy 必须已经释放，否则用户重试只会拿到 busy。
  assert.deepEqual(await picker.pick(), { status: "failed", reason: "spawn-failed" });
});

test("a platform without a verified picker says so and never runs a command", async () => {
  const picker = createDirectoryPicker({
    platform: "darwin",
    run: async () => {
      throw new Error("must not spawn anything");
    },
  });
  assert.deepEqual(await picker.pick(), { status: "unsupported", reason: "platform" });
});

// --- wiring ------------------------------------------------------------------

test("the route is a thin, side-effect-free bridge to the picker", () => {
  const route = read("src", "app", "api", "clis", "pick-dir", "route.ts");
  assert.match(route, /export async function POST/, "the page calls POST");
  assert.match(route, /pickDirectory\.pick\(\{ start \}\)/, "the chosen folder must come from the picker, not from the request");
  assert.doesNotMatch(route, /writeAppConfig|saveAppConfig|unlink|writeFile/, "picking a folder writes nothing (ADR-0073 决议 2)");
});

test("the folder row wires browse → draft → test, and stays quiet on cancel", () => {
  const form = read("src", "components", "config-form.tsx");
  assert.match(form, /onClick=\{\(\) => void pickCliDir\(c\.id\)\}/, "the browse button is per engine");
  assert.match(form, /fetch\("\/api\/clis\/pick-dir"/, "it must go through the route");
  assert.match(form, /void testCliDir\(cliId, picked\)/, "a picked folder is verified immediately (state is stale at that moment)");
  assert.match(form, /data\.status !== "cancelled"/, "cancelling is the user's intent and gets no notice");
  assert.match(form, /disabled=\{choosing\}/, "the button cannot be double-fired by hand");
  assert.match(form, /title=\{t\("config\.cliDirBrowse"\)\}/, "an icon-only button still needs a hover title");
  assert.match(form, /max-sm:min-w-\[44px\]/, "touch targets need 44px on phones");
  assert.match(form, /clearPickNotice\(c\.id\);/, "editing the path drops a stale picker notice");
});

test("both locales carry the picker copy — no half-translated row", () => {
  const cluster = read("src", "lib", "i18n", "clusters", "config.ts");
  for (const key of [
    "config.cliDirBrowse",
    "config.cliDirPickUnsupported",
    "config.cliDirPickBusy",
    "config.cliDirPickTimeout",
    "config.cliDirPickFailed",
  ]) {
    const hits = cluster.match(new RegExp(`"${key.replace(/\./g, "\\.")}"`, "g")) ?? [];
    assert.equal(hits.length, 2, `${key} must exist in en and zh`);
  }
  assert.doesNotMatch(cluster, /cliDirPick\w+": "[^"]*\\u[0-9a-fA-F]{4}/, "escape sequences leaked into user-facing copy");
});

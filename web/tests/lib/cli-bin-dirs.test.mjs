// Engine `binDirs` resolution: the rules live in src/lib/cli-bin-dirs.mjs, the
// why in ADR-0052. Beyond the pure-function cases below, the last block pins the
// WIRING — that both call sites in clis.ts (detection and dispatch) really use
// the engine's dirs. That is the failure this feature can have silently: an
// engine reported as installed in the list and unresolvable at spawn.
//
// Run:  node --test tests/lib/cli-bin-dirs.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path, { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliSearchDirs, expandHome, parseWorkbuddyCliDirs } from "../../src/lib/cli-bin-dirs.mjs";

const HOME = path.join(path.sep, "home", "tester");

test("expandHome leaves an absolute path alone", () => {
  const abs = path.join(path.sep, "opt", "bin");
  assert.equal(expandHome(abs, HOME), abs);
});

test("expandHome resolves ~ and ~/… against the injected home", () => {
  assert.equal(expandHome("~", HOME), HOME);
  assert.equal(expandHome("~/bin", HOME), path.join(HOME, "bin"));
  assert.equal(expandHome("~\\bin", HOME), path.join(HOME, "bin"));
});

test("expandHome passes an empty entry through — cliSearchDirs is what drops it", () => {
  assert.equal(expandHome("", HOME), "");
});

test("expandHome does not touch a ~ that is not a path prefix", () => {
  const notAPrefix = "/tmp/~backup";
  assert.equal(expandHome(notAPrefix, HOME), notAPrefix);
});

test("cliSearchDirs appends the engine's vendor dirs AFTER the shared dirs", () => {
  const shared = [path.join(path.sep, "usr", "bin")];
  const out = cliSearchDirs(shared, ["~/.qodersec/bin"], HOME);
  assert.deepEqual(out, [shared[0], path.join(HOME, ".qodersec", "bin")]);
});

test("cliSearchDirs keeps PATH first even when a vendor dir repeats one of its entries", () => {
  const shared = [path.join(HOME, ".qodersec", "bin"), path.join(path.sep, "usr", "bin")];
  const out = cliSearchDirs(shared, ["~/.qodersec/bin"], HOME);
  assert.deepEqual(out, shared, "a duplicate must not be re-appended behind PATH");
});

test("cliSearchDirs returns the shared dirs untouched for an engine with no vendor dirs", () => {
  const shared = [path.join(path.sep, "usr", "bin")];
  assert.deepEqual(cliSearchDirs(shared, undefined, HOME), shared);
  assert.deepEqual(cliSearchDirs(shared, [], HOME), shared);
});

test("cliSearchDirs drops empty entries instead of handing findBin a bare cwd join", () => {
  const shared = [path.join(path.sep, "usr", "bin"), ""];
  const out = cliSearchDirs(shared, ["", "~/.qodersec/bin"], HOME);
  assert.deepEqual(out, [shared[0], path.join(HOME, ".qodersec", "bin")]);
});

test("cliSearchDirs preserves the shared order (PATH precedence is the caller's)", () => {
  const shared = ["a", "b", "c"];
  assert.deepEqual(cliSearchDirs(shared, ["v"], HOME), ["a", "b", "c", "v"]);
});

// --- wiring -----------------------------------------------------------------
//
// clis.ts is TypeScript and this suite is .mjs, so the wiring is asserted as
// text — the same technique the repo's other clis.ts guards use. Two things are
// pinned: the qoder-cn row declares the dir its installer really uses, and NO
// `findBin(...)` call omits the second argument. A bare `findBin(c.bin)` is
// precisely how an engine detects as installed and then fails at spawn.

const CLIS_TS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "lib", "clis.ts");
const clisSrc = readFileSync(CLIS_TS, "utf8");

test("the fixture this guard reads still looks like itself", () => {
  const calls = [...clisSrc.matchAll(/findBin\(/g)];
  assert.ok(calls.length >= 2, "no findBin(...) calls parsed — has clis.ts changed shape?");
});

test("every findBin call passes a dir list, so detection and dispatch agree", () => {
  const calls = [...clisSrc.matchAll(/findBin\(([^)]*)\)/g)].map((m) => m[1]);
  const bare = calls.filter((args) => !args.includes(","));
  assert.deepEqual(bare, [], `findBin called without an engine-aware dir list: ${bare.join(" | ")}`);
});

test("the qoder-cn row declares the vendor dir its installer actually uses", () => {
  const row = /id:\s*"qoder-cn"[^\n]*/.exec(clisSrc);
  assert.ok(row, "KNOWN has no qoder-cn row");
  assert.match(row[0], /bin:\s*"qoderclicn"/, "the row must spawn the qoderclicn binary");
  assert.match(row[0], /binDirs:\s*\["~\/\.qodersec\/bin"\]/, "the row must declare ~/.qodersec/bin");
});

test("the codebuddy row declares both of its channels", () => {
  // ADR-0053: the vendor's own installer target, plus the copy WorkBuddy
  // bundles inside its install tree. The second cannot be a `binDirs` entry —
  // it depends on where that product was installed — so it is located at
  // runtime and searched only as a fallback.
  const row = /id:\s*"codebuddy"[^\n]*/.exec(clisSrc);
  assert.ok(row, "KNOWN has no codebuddy row");
  assert.match(row[0], /bin:\s*"codebuddy"/, "the row must spawn the codebuddy binary");
  assert.match(
    row[0],
    /binDirs:\s*\["~\/AppData\/Local\/codebuddy\/bin"\]/,
    "the row must declare the vendor native-installer bin dir",
  );
  assert.match(row[0], /fallbackDirs:\s*workbuddyBundledCliDirs/, "the row must wire the bundled-cli locator");
});

test("the fallback dirs are consulted only after the primary lookup failed", () => {
  // The laziness is the point: locating the bundled copy spawns `reg query`,
  // and a sweep must not pay that for an engine that already resolved. Pinned
  // as source order, because that is what laziness means here — no test can
  // observe a subprocess that must not happen.
  const body = /function findBinFor[\s\S]*?\n}/.exec(clisSrc);
  assert.ok(body, "findBinFor is gone — has the resolution path changed shape?");
  const primary = body[0].indexOf("findBin(spec.bin, dirsFor(");
  const fallback = body[0].indexOf("spec.fallbackDirs()");
  assert.ok(primary !== -1 && fallback !== -1, "findBinFor no longer looks like itself");
  assert.ok(primary < fallback, "the fallback dirs must be searched after the primary dirs");
  assert.match(body[0], /if \(found \|\| !spec\.fallbackDirs\) return found;/, "a found binary must short-circuit the fallback");
});

// --- the WorkBuddy-bundled CLI locator ---------------------------------------
//
// Pure parser, injected registry text: the shapes below are trimmed copies of
// what `reg query HKCU\…\Uninstall /s /f WorkBuddy /d` really prints on the
// machine this was built on (whose `InstallLocation` is empty — only
// DisplayIcon/UninstallString carry the path).

const BUNDLED = path.join("D:\\", "workbuddy", "resources", "app.asar.unpacked", "cli", "bin");

test("parseWorkbuddyCliDirs reads the install dir out of DisplayIcon", () => {
  const dump = [
    "",
    "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BFD312E9-1019-4F57-9F44-F86246833B50",
    "    DisplayName    REG_SZ    WorkBuddy 5.5.6",
    "    UninstallString    REG_SZ    \"D:\\workbuddy\\Uninstall WorkBuddy.exe\" /currentuser",
    "    DisplayIcon    REG_SZ    D:\\workbuddy\\WorkBuddy.exe,0",
    "",
    "End of search: 5 match(es) found.",
  ].join("\r\n");
  assert.deepEqual(parseWorkbuddyCliDirs(dump), [BUNDLED]);
});

test("parseWorkbuddyCliDirs survives a quoted path with switches and spaces", () => {
  const dump = [
    "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WorkBuddy",
    "    DisplayName    REG_SZ    WorkBuddy 5.5.6",
    "    UninstallString    REG_SZ    \"C:\\Program Files\\WorkBuddy\\Uninstall WorkBuddy.exe\" /currentuser /S",
  ].join("\n");
  assert.deepEqual(parseWorkbuddyCliDirs(dump), [
    path.join("C:\\Program Files\\WorkBuddy", "resources", "app.asar.unpacked", "cli", "bin"),
  ]);
});

test("parseWorkbuddyCliDirs expands variables, and drops what it cannot resolve", () => {
  const withEnv = [
    "HKEY_CURRENT_USER\\…\\Uninstall\\WorkBuddy",
    "    DisplayName    REG_SZ    WorkBuddy 5.5.6",
    "    DisplayIcon    REG_SZ    %USERPROFILE%\\workbuddy\\WorkBuddy.exe,0",
  ].join("\n");
  assert.deepEqual(parseWorkbuddyCliDirs(withEnv, { USERPROFILE: "C:\\Users\\tester" }), [
    path.join("C:\\Users\\tester\\workbuddy", "resources", "app.asar.unpacked", "cli", "bin"),
  ]);
  assert.deepEqual(parseWorkbuddyCliDirs(withEnv, {}), [], "an unresolved variable must not become a path");
});

test("parseWorkbuddyCliDirs ignores keys that are not that product", () => {
  const dump = [
    "HKEY_CURRENT_USER\\…\\Uninstall\\SomethingElse",
    "    DisplayName    REG_SZ    Something Else 1.0",
    "    DisplayIcon    REG_SZ    D:\\other\\other.exe,0",
  ].join("\n");
  assert.deepEqual(parseWorkbuddyCliDirs(dump), []);
});

test("parseWorkbuddyCliDirs tolerates empty and junk input", () => {
  assert.deepEqual(parseWorkbuddyCliDirs(""), []);
  assert.deepEqual(parseWorkbuddyCliDirs("ERROR: The system was unable to find the specified registry key or value."), []);
  assert.deepEqual(parseWorkbuddyCliDirs(null), []);
});

test("no engine smuggles a machine-specific path into binDirs", () => {
  // A drive letter or UNC root is one machine's layout, frozen into shipped
  // code: correct on the author's box, silently wrong on every other
  // (ADR-0053 决议 4). Vendor dirs must stay `~`-relative or POSIX-absolute.
  const lists = [...clisSrc.matchAll(/binDirs:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(lists.length >= 2, "no binDirs lists parsed — has the row shape changed?");
  for (const list of lists) {
    for (const entry of [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1])) {
      assert.doesNotMatch(entry, /^[A-Za-z]:/, `machine-specific drive path in binDirs: ${entry}`);
      assert.doesNotMatch(entry, /^\\\\/, `machine-specific UNC path in binDirs: ${entry}`);
    }
  }
});

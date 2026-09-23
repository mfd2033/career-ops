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
import { cliSearchDirs, expandHome } from "../../src/lib/cli-bin-dirs.mjs";

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

test("the codebuddy row declares the vendor native-installer dir", () => {
  // ADR-0053: the vendor's native installer is the ONLY channel whose
  // `codebuddy` is a directly spawnable executable. The WorkBuddy-bundled copy
  // and npm's global copy are extensionless node scripts — wiring either would
  // report an engine as installed and then fail at spawn.
  const row = /id:\s*"codebuddy"[^\n]*/.exec(clisSrc);
  assert.ok(row, "KNOWN has no codebuddy row");
  assert.match(row[0], /bin:\s*"codebuddy"/, "the row must spawn the codebuddy binary");
  assert.match(
    row[0],
    /binDirs:\s*\["~\/AppData\/Local\/codebuddy\/bin"\]/,
    "the row must declare the vendor native-installer bin dir",
  );
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

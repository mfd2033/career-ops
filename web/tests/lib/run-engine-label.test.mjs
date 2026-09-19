// ADR-0043 运行引擎 — the label rule plus the two invariants the worker
// surfaces depend on: one display-name source, and client-safe purity.
//
// Run:  node --test tests/lib/run-engine-label.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_LABELS, cliDisplayName, formatRunEngine } from "../../src/lib/cli-labels.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(WEB, "src", rel), "utf8");

test("formatRunEngine: runtime · model, runtime alone, or null when nothing was recorded", () => {
  assert.equal(formatRunEngine("claude", "agnes-2.5-flash"), "Claude Code · agnes-2.5-flash");
  assert.equal(formatRunEngine("claude", ""), "Claude Code", "no model requested → runtime only");
  assert.equal(formatRunEngine("claude"), "Claude Code");
  assert.equal(formatRunEngine("claude", "  "), "Claude Code", "blank model is not a model");
  // 缺失 = 未记录（列表不占位、详情页写「未记录」），绝不是空字符串。
  assert.equal(formatRunEngine(undefined, undefined), null);
  assert.equal(formatRunEngine(null, "x"), null);
  assert.equal(formatRunEngine("", "x"), null);
});

test("an unknown runtime id shows the raw id — never a guess, never blank", () => {
  assert.equal(cliDisplayName("my-local-fork"), "my-local-fork");
  assert.equal(formatRunEngine("my-local-fork", "m1"), "my-local-fork · m1");
  assert.equal(cliDisplayName(undefined), "");
});

test("every KNOWN runtime in clis.ts names itself from the shared table", () => {
  const src = read("lib/clis.ts");
  const rows = [...src.matchAll(/id:\s*"([^"]+)",\s*name:\s*cliDisplayName\("([^"]+)"\)/g)].map((m) => [m[1], m[2]]);
  assert.ok(rows.length >= 8, `KNOWN rows not parsed (${rows.length}) — has clis.ts changed shape?`);
  assert.equal(new Set(rows.map((r) => r[0])).size, rows.length, "duplicate runtime id in clis.ts");
  for (const [id, nameArg] of rows) {
    assert.equal(nameArg, id, `clis.ts row '${id}' must read its own label: cliDisplayName("${id}")`);
    assert.ok(CLI_LABELS[id], `CLI_LABELS is missing '${id}' — its workers would show the raw id`);
  }
});

test("cli-labels stays importable from client components", () => {
  // job-store / worker-card / the detail page are CLIENT components — a `node:`
  // import here breaks the browser bundle, which is the whole reason the labels
  // live in their own module instead of being read off clis.ts.
  assert.doesNotMatch(read("lib/cli-labels.mjs"), /from\s+"node:/, "node: imports would break the client bundle");
});

test("the run-engine keys exist in both locales", () => {
  // Read as text (the cluster is TypeScript): a key present in only one
  // dictionary renders as the raw key for the other market's users.
  const cluster = read("lib/i18n/clusters/jobs.ts");
  for (const key of ["jobs.runEngine", "jobs.runEngineNotRecorded", "jobs.runEngineHint"]) {
    const hits = (cluster.match(new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g")) ?? []).length;
    assert.equal(hits, 2, `${key} must exist in both locales (found ${hits})`);
  }
});

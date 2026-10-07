import assert from "node:assert/strict";
import { test } from "node:test";

// Mirror of pickDefaultInstalled in src/lib/saved-cli.ts (TS; this suite is .mjs).
// 引擎模式默认值：本机安装的第一个可用 CLI（usable !== false 优先，
// 全部不可用时退回第一个 installed），一个都没装才留空。
function pickDefaultInstalled(clis) {
  const list = clis || [];
  const firstUsable = list.find((c) => c.installed && c.usable !== false);
  const firstInstalled = list.find((c) => c.installed);
  return (firstUsable || firstInstalled || {}).id ?? null;
}

test("sole installed CLI is the default", () => {
  assert.equal(
    pickDefaultInstalled([
      { id: "claude", installed: false },
      { id: "grok", installed: true },
    ]),
    "grok",
  );
});

test("several installed CLIs default to the first one", () => {
  assert.equal(
    pickDefaultInstalled([
      { id: "claude", installed: true },
      { id: "grok", installed: true },
    ]),
    "claude",
  );
});

test("installed-but-unusable is skipped for the first usable", () => {
  assert.equal(
    pickDefaultInstalled([
      { id: "opencode", installed: true, usable: false },
      { id: "grok", installed: true, usable: true },
    ]),
    "grok",
  );
});

test("falls back to first installed when none is usable", () => {
  assert.equal(
    pickDefaultInstalled([
      { id: "opencode", installed: true, usable: false },
      { id: "claude", installed: false },
    ]),
    "opencode",
  );
});

test("zero installed CLIs stay unset", () => {
  assert.equal(pickDefaultInstalled([]), null);
  assert.equal(
    pickDefaultInstalled([
      { id: "claude", installed: false },
      { id: "grok", installed: false },
    ]),
    null,
  );
});

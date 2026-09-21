// /api/version 的核心版本折叠守卫（fork #8）。
//
// WHY THIS EXISTS: 打包版是 Next standalone 树，运行时 cwd 落在
// `.dashboard-runtime\v{ver}\app\`，那里既没有仓库根的 VERSION 文件、旧打包的
// build-info.json 也不含 core 版本，导致 `coreVersion` 静默塌成空串；若哪天打
// RC 包，channel 也会因读不到 core 后缀而误报。把「coreVersion / channel /
// version 如何从三个来源折出来」抽成纯函数，就能在不启服务的前提下锁死口径。
//
// 来源优先级（与 route.ts 注释一致）：打包冻结的 build-info.coreVersion 胜出，
// dev 无 build-info → 回落磁盘 VERSION 文件。
//
// Run: node --test tests/lib/version-info.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveVersionChannels } from "../../src/lib/version-info.mjs";

test("dev: no build-info → coreVersion falls back to the on-disk VERSION file", () => {
  const r = resolveVersionChannels({ fileVersion: "1.28.0", webVersion: "0.7.2" });
  assert.equal(r.coreVersion, "1.28.0");
  assert.equal(r.version, "web 0.7.2");
  // web is pre-1.0 → the web component itself is the alpha signal.
  assert.equal(r.channel, "alpha");
});

test("packaged: build-info.coreVersion wins over the (absent) on-disk VERSION", () => {
  // The reported bug: packaged cwd carries no VERSION file (""), but the
  // build-info.json stamped at pack time knows the core version.
  const r = resolveVersionChannels({ fileVersion: "", buildInfoCoreVersion: "1.28.0", webVersion: "0.7.2" });
  assert.equal(r.coreVersion, "1.28.0", "packaged coreVersion must not be empty when build-info carries it");
});

test("an RC/beta core pre-release suffix decides the channel over the web 0.x alpha", () => {
  const rc = resolveVersionChannels({ fileVersion: "", buildInfoCoreVersion: "1.29.0-rc.1", webVersion: "0.7.2" });
  assert.equal(rc.channel, "rc", "core pre-release suffix must win — an RC pack should not mis-report as alpha");
  const beta = resolveVersionChannels({ fileVersion: "2.0.0-beta", webVersion: "1.5.0" });
  assert.equal(beta.channel, "beta");
});

test("stable: no core suffix and web >= 1.0 → stable channel", () => {
  const r = resolveVersionChannels({ fileVersion: "1.28.0", webVersion: "1.0.0" });
  assert.equal(r.channel, "stable");
});

test("everything empty (stale pack, no VERSION) degrades to empty core, not a crash", () => {
  const r = resolveVersionChannels({ fileVersion: "", buildInfoCoreVersion: "", webVersion: "" });
  assert.equal(r.coreVersion, "");
  assert.equal(r.version, "", "no web version → version is the (empty) core, matching prior behaviour");
  assert.equal(r.channel, "stable");
});

test("surrounding whitespace / release-please trailing comment is trimmed to the bare token", () => {
  const r = resolveVersionChannels({ fileVersion: "  1.28.0  # x-release-please-version", webVersion: " 0.7.2 " });
  assert.equal(r.coreVersion, "1.28.0");
  assert.equal(r.version, "web 0.7.2");
});

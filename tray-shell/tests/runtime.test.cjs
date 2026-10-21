"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { locateRuntime, resolveCareerRoot } = require("../src/runtime.cjs");

const REPO = "C:\\repo";
const TRAY = "C:\\repo\\career-tray";

function io({ files = [], dirs = {}, mtimes = {} }) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const fileSet = new Set(files.map(norm));
  return {
    exists: (p) => fileSet.has(norm(p)),
    readdir: (dir) => {
      const entries = dirs[norm(dir)];
      if (!entries) throw new Error("ENOENT");
      return entries;
    },
    stat: (p) => ({ mtimeMs: mtimes[norm(p)] || 0 }),
  };
}

const dirEntry = (name) => ({ name, isDirectory: () => true });

test("career root：打包形态（exe 在 career-tray/ 里）命中父目录", () => {
  const api = io({ files: [path.join(REPO, "data", "applications.md")] });
  assert.equal(resolveCareerRoot([TRAY], api), REPO);
});

test("career root：开发态（仓库根）命中自身", () => {
  const api = io({ files: [path.join(REPO, "data", "applications.md")] });
  assert.equal(resolveCareerRoot([REPO], api), REPO);
});

test("career root：都没有 → 空串（调用方据此给 fatal 提示）", () => {
  assert.equal(resolveCareerRoot([TRAY, "D:\\nowhere"], io({})), "");
});

test("运行时：自带布局（node.exe + app/server.js 与根同级）", () => {
  const api = io({
    files: [path.join(REPO, "node.exe"), path.join(REPO, "app", "server.js")],
  });
  const found = locateRuntime({ careerRoot: REPO, exeDir: TRAY, io: api });
  assert.equal(found.source, "self-hosted");
  assert.equal(found.nodePath, path.join(REPO, "node.exe"));
  assert.equal(found.serverDir, path.join(REPO, "app"));
});

test("运行时：版本目录优先于更新的 mtime（重建不会服务旧构建）", () => {
  const good = path.join(REPO, ".dashboard-runtime", "vabc1234");
  const stale = path.join(REPO, ".dashboard-runtime", "vold");
  const api = io({
    files: [path.join(good, "node.exe"), path.join(good, "app", "server.js"), path.join(stale, "node.exe"), path.join(stale, "app", "server.js")],
    dirs: { [path.resolve(path.join(REPO, ".dashboard-runtime")).toLowerCase()]: [dirEntry("vabc1234"), dirEntry("vold")] },
    mtimes: { [path.resolve(stale).toLowerCase()]: 9_999_999_999 },
  });
  const found = locateRuntime({ careerRoot: REPO, exeDir: TRAY, cacheVersion: "abc1234", io: api });
  assert.equal(found.source, "versioned");
  assert.equal(found.runtimeDir, good);
});

test("运行时：版本目录缺失时退回最新 mtime（且要求 node.exe + app/server.js 齐全）", () => {
  const fresh = path.join(REPO, ".dashboard-runtime", "vfresh");
  const broken = path.join(REPO, ".dashboard-runtime", "vbroken");
  const api = io({
    files: [path.join(fresh, "node.exe"), path.join(fresh, "app", "server.js"), path.join(broken, "node.exe")],
    dirs: { [path.resolve(path.join(REPO, ".dashboard-runtime")).toLowerCase()]: [dirEntry("vfresh"), dirEntry("vbroken"), dirEntry("notes")] },
    mtimes: {
      [path.resolve(fresh).toLowerCase()]: 1_000,
      [path.resolve(broken).toLowerCase()]: 9_999,
    },
  });
  const found = locateRuntime({ careerRoot: REPO, exeDir: TRAY, cacheVersion: "missing", io: api });
  assert.equal(found.source, "newest");
  assert.equal(found.runtimeDir, fresh);
});

test("运行时：什么都没有 → null", () => {
  assert.equal(locateRuntime({ careerRoot: REPO, exeDir: TRAY, io: io({}) }), null);
});

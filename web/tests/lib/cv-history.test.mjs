// cv-history.mjs 的锁定测试（ADR-0048）。库是纯 fs 逻辑 + 白名单解析，
// 用真实临时目录验证扫描/排序/清理三条路径；注入类用例（路径遍历）单独一组。
//
// Run:  node --test tests/lib/cv-history.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseBakTs, snapshotFileName, listCvSnapshots, pruneCvSnapshots } from "../../src/lib/cv-history.mjs";

/** 建一个一次性根目录，写入若干快照（可选带非快照噪声文件），返回其路径。 */
function makeRoot(files = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cv-hist-"));
  for (const f of files) fs.writeFileSync(path.join(root, f), "x".repeat(10));
  return root;
}

const GOOD_TS = "2026-09-21T07-48-13-938Z";

describe("parseBakTs", () => {
  test("解析合法快照文件名", () => {
    assert.equal(parseBakTs(`cv.md.bak-${GOOD_TS}`), GOOD_TS);
  });

  test("拒绝非快照文件与非法时间戳形态", () => {
    assert.equal(parseBakTs("cv.md"), null);
    assert.equal(parseBakTs("profile.yml.bak-2026-09-21T07-48-13-938Z"), null);
    // 缺毫秒段 / 多余字符 / 前导杂音——都不是备份函数会产出的形态
    assert.equal(parseBakTs("cv.md.bak-2026-09-21T07-48-13Z"), null);
    assert.equal(parseBakTs(`cv.md.bak-..${GOOD_TS}`), null);
    assert.equal(parseBakTs(`x-cv.md.bak-${GOOD_TS}`), null);
    assert.equal(parseBakTs(null), null);
  });
});

describe("snapshotFileName", () => {
  test("白名单时间戳重组文件名", () => {
    assert.equal(snapshotFileName(GOOD_TS), `cv.md.bak-${GOOD_TS}`);
  });

  test("路径遍历与任意输入一律拒绝（API 防遍历的唯一闸门）", () => {
    for (const evil of ["..", "../../etc/passwd", "", "cv.md", `${GOOD_TS}/x`, `${GOOD_TS}\\x`, "2026-09-21T07:48:13.938Z"]) {
      assert.equal(snapshotFileName(evil), null, evil);
    }
  });
});

describe("listCvSnapshots", () => {
  test("按时间倒序列出快照并带字节数", () => {
    const root = makeRoot([
      `cv.md.bak-2026-09-20T02-39-44-335Z`,
      `cv.md.bak-${GOOD_TS}`,
      `cv.md.bak-2026-08-29T16-01-18-891Z`,
    ]);
    const snaps = listCvSnapshots(root);
    assert.deepEqual(
      snaps.map((s) => s.ts),
      [GOOD_TS, "2026-09-20T02-39-44-335Z", "2026-08-29T16-01-18-891Z"],
    );
    assert.equal(snaps[0].bytes, 10);
  });

  test("忽略非快照文件与其他文件的备份", () => {
    const root = makeRoot([`cv.md.bak-${GOOD_TS}`, "cv.md", "profile.yml.bak-x", "README.md"]);
    assert.equal(listCvSnapshots(root).length, 1);
  });

  test("空目录与不存在的目录都返回空列表（tolerant reader）", () => {
    assert.deepEqual(listCvSnapshots(makeRoot()), []);
    assert.deepEqual(listCvSnapshots(path.join(os.tmpdir(), "cv-hist-not-exist")), []);
  });
});

describe("pruneCvSnapshots", () => {
  test("超过上限时从最旧端删除，保留最近 N 份", () => {
    const files = [];
    for (let d = 1; d <= 21; d++) {
      const mm = String(d).padStart(2, "0");
      files.push(`cv.md.bak-2026-08-${mm}T00-00-00-000Z`);
    }
    const root = makeRoot(files);
    const removed = pruneCvSnapshots(root, 20);
    assert.equal(removed.length, 1);
    // 最旧的 08-01 被删，08-02 起保留
    assert.ok(fs.existsSync(path.join(root, "cv.md.bak-2026-08-02T00-00-00-000Z")));
    assert.ok(!fs.existsSync(path.join(root, "cv.md.bak-2026-08-01T00-00-00-000Z")));
    assert.equal(listCvSnapshots(root).length, 20);
  });

  test("不足上限时一个都不删", () => {
    const root = makeRoot([`cv.md.bak-${GOOD_TS}`]);
    assert.deepEqual(pruneCvSnapshots(root, 20), []);
    assert.equal(listCvSnapshots(root).length, 1);
  });

  test("目录不存在不报错", () => {
    assert.deepEqual(pruneCvSnapshots(path.join(os.tmpdir(), "cv-hist-not-exist"), 20), []);
  });
});

// ── 路由接线（ADR-0048）：TS 路由无法在 node --test 中执行，
// 沿 portals-merge.test.mjs 的源码断言惯例锁定关键行为防回归。──

describe("route wiring", () => {
  const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

  test("cv 保存路由成功后做上限清理，且只挂在该路由", () => {
    const src = read("../../src/app/api/cv/route.ts");
    assert.match(src, /pruneCvSnapshots\(careerOpsRoot\(\)/, "保存成功后清理超限快照");
  });

  test("通用 backup 函数未被塞入清理逻辑（其他文件的 .bak 行为不变）", () => {
    const src = read("../../src/lib/core/safe-write.ts");
    assert.ok(!src.includes("pruneCvSnapshots"), "清理不得进通用写路径");
    assert.ok(!src.includes("cv.md"), "backup 不得耦合 cv 专属语义");
  });

  test("history 路由经白名单重组文件名，不接受原始文件名", () => {
    const src = read("../../src/app/api/cv/history/route.ts");
    assert.match(src, /snapshotFileName\(ts\)/, "ts 必须过白名单");
    assert.ok(!src.includes("path.join(root, ts)"), "禁止调用方输入直接拼路径");
  });

  test("i18n：cv.history.* 在 en/zh 两份字典里键完全对齐", () => {
    const dict = read("../../src/lib/i18n/clusters/cv.ts");
    const en = dict.slice(0, dict.indexOf("export const zh"));
    const zh = dict.slice(dict.indexOf("export const zh"));
    const keys = (s) => new Set([...s.matchAll(/"(cv\.history\.[a-zA-Z]+)"/g)].map((m) => m[1]));
    const enKeys = keys(en);
    assert.ok(enKeys.size > 0, "en 段必须存在 cv.history.* 键");
    assert.deepEqual(keys(zh), enKeys, "zh 缺键或多键");
  });
});

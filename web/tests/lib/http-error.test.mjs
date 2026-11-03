// 接口失败 → 错误类 → i18n 键。守的是同一类缺陷的第三次不回潮：
// UI 审计 FAIL #11 修过黑名单页（短码映射），2026-11-03 的审查又抓到标题门把
// `"portals.yml not found"` 直接甩上屏。判定一旦重复实现，第三个页面必然再漏。

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ERROR_CLASSES, errorClass, errorKey } from "../../src/lib/http-error.mjs";

const SRC = path.join(import.meta.dirname, "..", "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const KEYS = {
  server: "x.server",
  network: "x.network",
  bad_request: "x.bad_request",
  not_found: "x.not_found",
};

test("errorClass: 状态码归到闭集里的类", () => {
  assert.equal(errorClass(400), "bad_request");
  assert.equal(errorClass(422), "bad_request");
  assert.equal(errorClass(404), "not_found");
  assert.equal(errorClass(409), "conflict");
  assert.equal(errorClass(500), "server");
  assert.equal(errorClass(503), "server");
  for (const status of [400, 404, 500]) {
    assert.ok(ERROR_CLASSES.includes(errorClass(status)), `${status} must map into the closed set`);
  }
});

test("errorClass: 没有状态码就是网络失败（fetch 抛、断网、被取消）", () => {
  // 算成 server 会让文案指向「服务端出错」，而真实原因是本地服务没起。
  for (const empty of [undefined, null, "", 0, NaN, "not-a-number"]) {
    assert.equal(errorClass(empty), "network", `${String(empty)} must be a network failure`);
  }
});

test("errorKey: 每个类走自己的键", () => {
  assert.equal(errorKey(KEYS, 400), "x.bad_request");
  assert.equal(errorKey(KEYS, 404), "x.not_found");
  assert.equal(errorKey(KEYS, 500), "x.server");
  assert.equal(errorKey(KEYS), "x.network", "omitting status means the fetch itself threw");
});

test("errorKey: 没覆盖的类回落到 server 键，绝不回吐裸键名或空串", () => {
  // conflict 没给键；调用方也不该因此看到 "x.conflict" 或 undefined。
  assert.equal(errorKey({ server: "x.server" }, 409), "x.server");
  assert.equal(errorKey({ server: "x.server" }, 500), "x.server");
  assert.equal(errorKey({ server: "x.server" }), "x.server");
});

test("errorKey: 返回值一定是 i18n 键，不是译文、也不含状态码", () => {
  const key = errorKey(KEYS, 404);
  assert.equal(typeof key, "string");
  assert.doesNotMatch(key, /\d{3}/, "a status code must never leak into the key");
  assert.doesNotMatch(key, /\s/, "a translated sentence would contain spaces; keys do not");
});

// 两个已知的漏点都不得回潮：判定一旦在本文件之外重新实现，第三个页面就还会漏。
test("两个调用点都走共享判定，且不再把接口错误串当界面文案", () => {
  const blacklist = read("components/blacklist-view.tsx");
  const gate = read("components/explore/gate-panel.tsx");

  for (const [name, file] of [["blacklist", blacklist], ["title gate", gate]]) {
    assert.match(file, /errorKey\(/, `${name} must use the shared status→key mapping`);
    assert.ok(
      !/j\??\.error\s*\|\|/.test(file),
      `${name} must not fall back to the API's own error string — that is internal wording, not UI copy`,
    );
  }

  // 黑名单页的哨兵短码（"error" / "network"）也不该再出现在组件里。
  assert.ok(!/err === "network"/.test(blacklist), "the old sentinel-code branch must be gone, not kept as a second path");
  assert.match(blacklist, /const errText = err \? t\(err\) : null;/);
});

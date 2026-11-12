// /api/logo 的纯逻辑：把请求参数解析成缓存 key。
//
// 背景（fork-local 决策，2026-11-12）：本机到 Google favicon 服务不通，而原实现
// 把「网络失败」和「这家公司确实没有 favicon」都写成同一个 0 字节哨兵，且哨兵永不
// 重试 —— 45 个缓存 key 里 40 个就此永久作废。现在路由彻底不外呼，只读磁盘缓存，
// 所以「参数 → key」这段判定必须完全在纯函数里、有测试兜住：
//   - 非法 domain 必须是 400，不能变成一次磁盘查找；
//   - 纯中文公司名是「必然 miss」，不是客户端错误；
//   - key 不允许逃出缓存目录（公司名来自 tracker，属不可信输入）。
//
// Run:  node --test tests/lib/logo-resolve.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveLogoKey } from "../../src/lib/core/logo-cache-key.mjs";

test("a valid domain resolves to its own cache key", () => {
  assert.deepEqual(resolveLogoKey({ domain: "notion.so", company: "" }), { status: "ok", key: "notion.so" });
});

test("domain is normalized to lowercase before keying", () => {
  assert.deepEqual(resolveLogoKey({ domain: "Notion.SO", company: "" }), { status: "ok", key: "notion.so" });
});

test("malformed domains are a client error, not a cache lookup", () => {
  for (const bad of ["notadomain", "http://notion.so", "notion", "notion..so", "../etc/passwd", "-.com"]) {
    assert.deepEqual(resolveLogoKey({ domain: bad, company: "" }), { status: "bad-domain" }, `expected bad-domain for ${bad}`);
  }
});

test("a latin company name resolves through the versioned company key", () => {
  const r = resolveLogoKey({ domain: "", company: "BYD" });
  assert.equal(r.status, "ok");
  assert.match(r.key, /^co_v\d+_byd_[0-9a-f]{10}$/);
});

test("a name with nothing to key on is a guaranteed miss, not a client error", () => {
  // 纯 CJK 名字没有任何 ASCII 可 key，也没有可猜的域名 —— 永远不会有 logo。
  for (const name of ["锋维数字", "西安卓远众信人力资源有限公司", "---"]) {
    assert.deepEqual(resolveLogoKey({ domain: "", company: name }), { status: "not-found" }, `expected not-found for ${name}`);
  }
});

test("no domain and no company is a client error", () => {
  assert.deepEqual(resolveLogoKey({ domain: "", company: "" }), { status: "bad-request" });
});

test("domain wins when both are supplied", () => {
  assert.deepEqual(resolveLogoKey({ domain: "byd.com", company: "某公司" }), { status: "ok", key: "byd.com" });
});

test("keys can never escape the cache directory", () => {
  const hostile = ["../../etc/passwd", "..\\..\\windows\\system32", "a/b/c", "x y", "café/../../root"];
  for (const name of hostile) {
    const r = resolveLogoKey({ domain: "", company: name });
    if (r.status !== "ok") continue;
    assert.match(r.key, /^co_v\d+_[a-z0-9]{1,40}_[0-9a-f]{10}$/, `unsafe key for ${JSON.stringify(name)}: ${r.key}`);
  }
});

test("surrounding whitespace does not change the outcome", () => {
  assert.deepEqual(resolveLogoKey({ domain: "  notion.so  ", company: "" }), { status: "ok", key: "notion.so" });
  assert.equal(resolveLogoKey({ domain: "", company: "  " }).status, "bad-request");
});

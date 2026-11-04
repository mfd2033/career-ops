// query-cache 单测（ADR-0098 决议 4/5）：/api/tracker 的签名失效与并发合流。
//
// WHY: 每个 `/api/tracker` 请求 spawn 一个 Node 子进程（实测 411ms）。页面一次刷新
// 打好几次、托盘与扩展同时在探活，几个 Node 启动就撞在同一个单事件循环上，探针跟着
// 超时。缓存规则错一格的两种后果都很难看：太松 → 刚改完的 tracker 列表还是旧的；
// 太紧 → 每次刷新还是 spawn。这里把两边的边界都钉住。
//
// Run:  node --test web/tests/lib/query-cache.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createQueryCache } from "../../src/lib/query-cache.mjs";

function harness({ initialSignature = "sig-1", cacheable = () => true, maxEntries } = {}) {
  let signature = initialSignature;
  let runs = 0;
  const cache = createQueryCache({
    signatureOf: async () => signature,
    isCacheable: cacheable,
    ...(maxEntries ? { maxEntries } : {}),
  });
  return {
    cache,
    runs: () => runs,
    bumpSignature: (next = `sig-${Math.random()}`) => {
      signature = next;
    },
    async get(key = "query", value = "rows") {
      return cache.get(key, async () => {
        runs += 1;
        return value;
      });
    },
  };
}

test("签名未变 → 第二次直接命中，不再执行 run", async () => {
  const h = harness();
  assert.equal(await h.get(), "rows");
  assert.equal(await h.get(), "rows");
  assert.equal(h.runs(), 1);
});

test("签名变了 → 立刻重建（用户刚写的行不会被旧结果盖住）", async () => {
  const h = harness();
  await h.get();
  h.bumpSignature();
  await h.get();
  assert.equal(h.runs(), 2);
});

test("并发同 key → 只执行一次（合流），返回同一份结果", async () => {
  const h = harness();
  const [a, b, c] = await Promise.all([h.get(), h.get(), h.get()]);
  assert.deepEqual([a, b, c], ["rows", "rows", "rows"]);
  assert.equal(h.runs(), 1, "三个并发请求不该 spawn 三个子进程");
});

test("不同 key 各自独立（筛选条件不同就是不同的问题）", async () => {
  const h = harness();
  await h.get("status=Applied");
  await h.get("status=SKIP");
  assert.equal(h.runs(), 2);
  await h.get("status=Applied");
  assert.equal(h.runs(), 2, "两个 key 都已缓存");
});

test("失败不缓存：下一次仍会重试", async () => {
  const h = harness();
  let attempt = 0;
  const failThenSucceed = () => h.cache.get("query", async () => {
    attempt += 1;
    if (attempt === 1) throw new Error("子进程超时");
    return "rows";
  });
  await assert.rejects(() => failThenSucceed(), /子进程超时/);
  assert.equal(await failThenSucceed(), "rows");
  assert.equal(attempt, 2);
});

test("isCacheable 说不 → 结果照常返回但不进缓存", async () => {
  const h = harness({ cacheable: () => false });
  assert.equal(await h.get(), "rows");
  assert.equal(await h.get(), "rows");
  assert.equal(h.runs(), 2);
  assert.equal(h.cache.stats().entries, 0);
});

test("旧世代在飞的结果不许写进新世代（签名已变）", async () => {
  const h = harness();
  // 第一次调用在飞时改签名：它的结果落地时世代已经 +1，必须被丢弃。
  let release;
  const slow = h.cache.get("query", () => new Promise((resolve) => {
    release = () => resolve("stale");
  }));
  h.bumpSignature();
  assert.equal(await h.get(), "rows"); // 新世代，真实执行
  release();
  assert.equal(await slow, "stale", "调用方仍拿到自己的结果");
  // 新世代缓存里是 rows，不是 stale
  assert.equal(await h.get(), "rows");
  assert.equal(h.cache.stats().entries, 1);
});

test("invalidate() 作废全部条目并推进世代", async () => {
  const h = harness();
  await h.get();
  const before = h.cache.stats().generation;
  h.cache.invalidate();
  assert.equal(h.cache.stats().entries, 0);
  assert.ok(h.cache.stats().generation > before);
  await h.get();
  assert.equal(h.runs(), 2);
});

test("maxEntries 是安全阀：满了淘汰最老的", async () => {
  const h = harness({ maxEntries: 2 });
  await h.get("a");
  await h.get("b");
  await h.get("c");
  assert.equal(h.cache.stats().entries, 2);
  await h.get("c");
  assert.equal(h.runs(), 3, "最老的 a 被淘汰后才轮到它重跑");
});

test("缺 signatureOf → 构造时报错", () => {
  assert.throws(() => createQueryCache({}), /signatureOf/);
});

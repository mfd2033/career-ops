// 扩展 SW 本机请求超时守卫（诊断「connected:false + 3000:timeout，但服务正常」）。
//
// 根因：background.js 里若干 fetch 没有超时。一个卡住的 /api/report-status（索引体积大）
// 会一直占着浏览器对 127.0.0.1 的同源连接（HTTP/1.1 上限 6 条），后续 /api/version
// 探针只能排在队尾，等自己的 6s abort 计时 —— popup 报「本地服务在忙」，而 PowerShell /
// 托盘壳打同一端口是 1-2ms。ADR-0098 只治了服务端事件循环，管不到浏览器连接池。
//
// 锁三条不变量：
//   1. localFetch 存在，超时后 invalidatePort()，默认超时是有限的合理值；
//   2. 「小响应」接口必须走 localFetch，不许裸 fetch；
//   3. 长连接（/api/events、/api/batch-evaluate）保持流式，不加普通超时。
//
// Run: node --test web/tests/lib/extension-local-fetch-timeout.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BG = readFileSync(join(ROOT, "extension", "background.js"), "utf8");
const CORE = readFileSync(join(ROOT, "extension", "core.js"), "utf8");

test("localFetch 有有限默认超时，且超时后失效缓存端口", () => {
  const m = BG.match(/const LOCAL_FETCH_TIMEOUT_MS = (\d+);/);
  assert.ok(m, "缺少命名超时常量 LOCAL_FETCH_TIMEOUT_MS");
  const ms = Number(m[1]);
  assert.ok(ms >= 5000 && ms <= 60000, `默认超时 ${ms}ms 不在 5s-60s 的合理区间`);
  assert.match(
    BG,
    /if \(ctrl\.signal\.aborted\) \{[\s\S]{0,200}?invalidatePort\(\);/,
    "超时分支必须 invalidatePort()，否则会继续复用这次没答上来的端口",
  );
});

test("小响应接口一律走 localFetch，不许裸 fetch", () => {
  const lines = BG.split("\n");
  // localFetch 的大写 F 不会命中 /(^|[^A-Za-z])fetch\(/，两种写法都算「请求点」。
  const isCallLine = (l) => l.includes("localFetch(") || /(^|[^A-Za-z])fetch\(/.test(l);
  for (const api of ["/api/config", "/api/clis", "/api/report-status", "/api/active-runs", "/api/explore/seen", "/api/run"]) {
    const hits = lines.filter((l) => l.includes(api) && isCallLine(l));
    assert.ok(hits.length > 0, `${api} 的请求不见了，测试选择器需同步`);
    for (const l of hits) {
      assert.ok(l.includes("localFetch("), `${api} 又回到裸 fetch（会无限占同源连接）：${l.trim()}`);
    }
  }
});

test("长连接接口保持流式，不被套上普通超时", () => {
  const lines = BG.split("\n");
  const isCallLine = (l) => l.includes("localFetch(") || /(^|[^A-Za-z])fetch\(/.test(l);
  for (const api of ["/api/events", "/api/batch-evaluate"]) {
    const hits = lines.filter((l) => l.includes(api) && isCallLine(l));
    assert.ok(hits.length > 0, `${api} 的请求不见了`);
    for (const l of hits) {
      assert.ok(!l.includes("localFetch("), `${api} 是长连接，套普通超时会中途切断评估：${l.trim()}`);
    }
  }
});

test("诊断快照统计行内胶囊与按钮行", () => {
  // 状态胶囊可编辑后是 <button>（分数/临时态仍是 <span>），按属性计数两种都算。
  assert.match(CORE, /__diag\.chips = document\.querySelectorAll\("\[data-career-chip\]"\)\.length;/);
  assert.match(CORE, /__diag\.actionRows = document\.querySelectorAll\('\[data-career-actions="row"\]'\)\.length;/);
});

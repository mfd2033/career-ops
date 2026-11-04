// probe-pure 纯逻辑单测（ADR-0063 修订三）：本地 web 端口探测的判定——
// 单次探测归形（ok / timeout / refused / http / invalid）、「3000 优先 → 备选区间 →
// 二次复探」的采集顺序、以及诊断表的取舍。无 chrome / DOM / fetch 依赖，直接 import
// extension/probe-pure.js。
//
// Run:  node --test web/tests/lib/probe-pure.test.mjs
//
// 放在 web/tests/lib 与同族扩展侧测试（badge-pure / report-target-pure / scan-pure）
// 同级，由 test-all.mjs 的 web/tests/lib 批次一并门住。

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "probe-pure.js")).href);
const {
  PRIMARY_PORT,
  ALT_PORT_MIN,
  ALT_PORT_MAX,
  PROBE_TIMEOUT_MS,
  ALT_PROBE_TIMEOUT_MS,
  RETRY_TIMEOUT_MS,
  altPorts,
  classifyProbe,
  decideProbe,
  diagOf,
} = mod.default ?? mod;

// ---- 常量：端口固定 3000，备选区间只为 dev 入口留着 --------------------------

test("主端口就是 ADR-0063 固定的 3000", () => {
  assert.equal(PRIMARY_PORT, 3000);
});

test("备选区间是 3001-3040，且不含主端口（共 40 个）", () => {
  const ports = altPorts();
  assert.equal(ports.length, 40);
  assert.equal(ports[0], ALT_PORT_MIN);
  assert.equal(ports[ports.length - 1], ALT_PORT_MAX);
  assert.ok(!ports.includes(PRIMARY_PORT));
});

test("主探窗口不再是 3s——服务忙时 3s 会把「在跑」误判成「没跑」", () => {
  assert.ok(PROBE_TIMEOUT_MS >= 6000, "主探至少 6s");
  assert.ok(ALT_PROBE_TIMEOUT_MS < PROBE_TIMEOUT_MS, "备选区间是短扫");
  assert.ok(RETRY_TIMEOUT_MS <= PROBE_TIMEOUT_MS, "复探不必再给满预算");
});

// ---- classifyProbe：原始结果 → 归一形状 ------------------------------------

test("到点未答复 → timeout（不是没起服务）", () => {
  const r = classifyProbe({ ms: 6001, timedOut: true });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "timeout");
  assert.equal(r.ms, 6001);
});

test("立刻失败的错 → refused，并保留原始错误串", () => {
  const r = classifyProbe({ ms: 3, error: "Failed to fetch" });
  assert.equal(r.kind, "refused");
  assert.equal(r.detail, "Failed to fetch");
});

test("非 2xx → http，带状态码", () => {
  const r = classifyProbe({ ms: 12, status: 403 });
  assert.equal(r.kind, "http");
  assert.equal(r.status, 403);
  assert.equal(r.ms, 12);
});

test("2xx 但没有 version 字段 → invalid（端口上坐着别的服务）", () => {
  assert.equal(classifyProbe({ status: 200, body: {} }).kind, "invalid");
  assert.equal(classifyProbe({ status: 200, body: null }).kind, "invalid");
});

test("2xx 且带 version → ok，version 转字符串", () => {
  const r = classifyProbe({ ms: 8, status: 200, body: { version: "web 0.7.2" } });
  assert.equal(r.ok, true);
  assert.equal(r.kind, "ok");
  assert.equal(r.version, "web 0.7.2");
});

test("status 缺省（0）也算 http 失败，不会被当成 ok", () => {
  const r = classifyProbe({ body: { version: "x" } });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "http");
});

// ---- decideProbe：3000 优先 → 备选区间 → 二次复探 ---------------------------

const ok = (port) => ({ port, ok: true, kind: "ok", ms: 5 });
const timeout = (port) => ({ port, ok: false, kind: "timeout", ms: PROBE_TIMEOUT_MS });
const refused = (port) => ({ port, ok: false, kind: "refused", ms: 2 });

test("3000 通 → 直接命中，压根不看备选区间", () => {
  const d = decideProbe({ primary: ok(3000), alt: [ok(3101)] });
  assert.deepEqual(d, { port: 3000, reason: null, source: "primary" });
});

test("3000 不通但备选区间有 dev 实例 → 命中的那个口", () => {
  const d = decideProbe({ primary: refused(3000), alt: [refused(3001), ok(3101)] });
  assert.equal(d.port, 3101);
  assert.equal(d.reason, null);
  assert.equal(d.source, "alt");
});

test("备选区间全空 + 复探通 → 仍是 3000（兜冷启动预热）", () => {
  const d = decideProbe({ primary: timeout(3000), alt: [refused(3001)], retry: ok(3000) });
  assert.deepEqual(d, { port: 3000, reason: null, source: "retry" });
});

test("全程不通 → port=null，reason 取最后一次事实（复探优先）", () => {
  const d = decideProbe({ primary: timeout(3000), alt: [refused(3001)], retry: refused(3000) });
  assert.equal(d.port, null);
  assert.equal(d.reason, "refused");
  assert.equal(d.source, null);
});

test("没有复探时，reason 就是主探口的 kind（用户关心 3000 为什么不通）", () => {
  const d = decideProbe({ primary: timeout(3000), alt: [refused(3101)] });
  assert.equal(d.port, null);
  assert.equal(d.reason, "timeout");
});

test("什么都没给 → 不崩，reason 落到 unknown", () => {
  const d = decideProbe();
  assert.equal(d.port, null);
  assert.equal(d.reason, "unknown");
});

test("备选区间里只认 ok：http/invalid 的口不算命中", () => {
  const d = decideProbe({
    primary: timeout(3000),
    alt: [
      { port: 3101, ok: false, kind: "http", status: 404, ms: 4 },
      { port: 3102, ok: false, kind: "invalid", ms: 4 },
    ],
  });
  assert.equal(d.port, null);
});

// ---- diagOf：诊断表不淹没在 40 个 refused 里 -------------------------------

test("主探与复探各自成条，备选的 refused 只计数", () => {
  const table = diagOf({
    primary: timeout(3000),
    alt: [refused(3001), refused(3002), { port: 3101, ok: false, kind: "http", status: 404, ms: 9 }],
    retry: refused(3000),
  });
  assert.equal(table["3000"], "timeout 6000ms");
  assert.equal(table["3000@retry"], "refused 2ms");
  assert.equal(table["3101"], "http(404) 9ms", "非 refused 的口逐个列出");
  assert.equal(table.altRefused, 2);
  assert.ok(!("3001" in table), "refused 的口不逐个列");
});

test("没有复探就不出现 @retry 键", () => {
  const table = diagOf({ primary: ok(3000) });
  assert.equal(table["3000"], "ok 5ms");
  assert.ok(!("3000@retry" in table));
  assert.ok(!("altRefused" in table));
});

// 定制前哨判定 + tailor 在跑登记表的契约测试（工单 generate-tailored-cv/04）。
//
// 锁三态：dispatch（无在跑放行）/ blocked（有在跑，报 running）/ replace（用户已裁决，
// 停全部后放行），以及替换应答在 timeout 时如实标 unconfirmed。判定委托给通用的
// decideCheckupPreflight，这里验证 tailor 命名入口的转发正确、且与 checkup 判定同形。
// 另验 tailor-live 是与 checkup-live 独立的一具实例（tracker# 空间互不污染）。
//
// Run:  node --test web/tests/lib/tailor-request.test.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { decideTailorPreflight, tailorReplaceBody } from "../../src/lib/tailor-request.mjs";
import {
  registerTailor,
  markTailorRunning,
  listLiveTailors,
  clearTailor,
  awaitTailorGone,
  __resetTailorLiveForTest,
} from "../../src/lib/tailor-live.mjs";
import { listLiveCheckups, registerCheckup, __resetCheckupLiveForTest } from "../../src/lib/checkup-live.mjs";

const QUEUED = [{ runId: "r-q", state: "queued", startedAt: null }];
const RUNNING = [{ runId: "r-x", state: "running", startedAt: 1789700000000 }];

test("decideTailorPreflight：无在跑 → dispatch（replace 与否都放行）", () => {
  assert.deepEqual(decideTailorPreflight({ live: [], replace: undefined }), { action: "dispatch" });
  assert.deepEqual(decideTailorPreflight({ live: [], replace: true }), { action: "dispatch" });
  assert.deepEqual(decideTailorPreflight({}), { action: "dispatch" });
});

test("decideTailorPreflight：有在跑、未带 replace → blocked 并报 running（含 runId）", () => {
  const d = decideTailorPreflight({ live: RUNNING, replace: undefined });
  assert.equal(d.action, "blocked");
  assert.deepEqual(d.running, [{ runId: "r-x", state: "running", startedAt: 1789700000000 }]);
});

test("decideTailorPreflight：非严格真的 replace 不放行（决定杀进程，须显式 true）", () => {
  for (const loose of [1, "true", {}, [], "yes"]) {
    assert.equal(decideTailorPreflight({ live: RUNNING, replace: loose }).action, "blocked", `loose=${String(loose)}`);
  }
});

test("decideTailorPreflight：排队中的定制也算在跑（blocked）", () => {
  const d = decideTailorPreflight({ live: QUEUED, replace: undefined });
  assert.equal(d.action, "blocked");
  assert.equal(d.running[0].state, "queued");
});

test("decideTailorPreflight：replace:true 且有在跑 → replace，带全部 running", () => {
  const d = decideTailorPreflight({ live: [...QUEUED, ...RUNNING], replace: true });
  assert.equal(d.action, "replace");
  assert.equal(d.running.length, 2);
});

test("tailorReplaceBody：任一 timeout → 放行但标 unconfirmed；gone/unknown 视为已停", () => {
  assert.deepEqual(tailorReplaceBody({ replaced: ["a"], outcomes: ["gone"] }), { ok: true, replaced: ["a"] });
  assert.deepEqual(tailorReplaceBody({ replaced: ["a"], outcomes: ["unknown"] }), { ok: true, replaced: ["a"] });
  assert.deepEqual(tailorReplaceBody({ replaced: ["a", "b"], outcomes: ["gone", "timeout"] }), {
    ok: true,
    replaced: ["a", "b"],
    unconfirmed: true,
  });
});

beforeEach(() => {
  __resetTailorLiveForTest();
  __resetCheckupLiveForTest();
});

test("tailor-live：登记即 queued、占槽后 running、终态清除后放开", () => {
  registerTailor("50", "run-50");
  assert.deepEqual(listLiveTailors("50"), [{ runId: "run-50", state: "queued", startedAt: null }]);
  markTailorRunning("50", "run-50", 1789700000000);
  assert.deepEqual(listLiveTailors("50"), [{ runId: "run-50", state: "running", startedAt: 1789700000000 }]);
  clearTailor("50", "run-50", { processGone: true });
  assert.deepEqual(listLiveTailors("50"), []);
});

test("tailor-live 与 checkup-live 是独立实例：同一 tracker# 各行其是", () => {
  registerTailor("50", "tailor-run");
  registerCheckup("50", "checkup-run");
  assert.deepEqual(listLiveTailors("50").map((e) => e.runId), ["tailor-run"]);
  assert.deepEqual(listLiveCheckups("50").map((e) => e.runId), ["checkup-run"]);
});

test("tailor-live：未登记的 run 等死返回 unknown（按已停处理）", async () => {
  assert.equal(await awaitTailorGone("50", "never", 5), "unknown");
});

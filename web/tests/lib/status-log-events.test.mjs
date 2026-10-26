// status-log 逐行状态变化解析器（状态记录弹窗的数据层）纯逻辑测试 —— 直接引
// web/src/lib/status-log.mjs（生产代码同一份），并加一条与根 status-log.mjs 的
// 漂移守卫：同一输入两处必须逐事件一致，否则弹窗与 CLI/台账口径会分叉。
//
// Run:  node --test tests/lib/status-log-events.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { statusEventsFromStatusLog } from "../../src/lib/status-log.mjs";
import { statusEventsFromStatusLog as coreStatusEvents } from "../../../status-log.mjs";

const LOG = [
  "\uFEFFnum\tdate\tfrom\tto\tsource\tnote", // 表头 + BOM
  "814\t2026-09-13\tEvaluated\tDiscarded\tweb\t",
  "815\t2026-09-14\tEvaluated\tApplied\tset-status\t",
  "814\t2026-09-18\tDiscarded\tSKIP\tset-status\t",
  "bad-line",
  "814\tnot-a-date\tEvaluated\tApplied\tweb\t", // 坏日期舍弃
].join("\r\n");

test("只取目标行，按日期倒序（最新在前）", () => {
  const events = statusEventsFromStatusLog(LOG, 814);
  assert.deepEqual(
    events.map((e) => [e.date, e.from, e.to]),
    [
      ["2026-09-18", "Discarded", "SKIP"],
      ["2026-09-13", "Evaluated", "Discarded"],
    ],
  );
});

test("同日多次转换：文件靠后的（较新）排前", () => {
  const log = [
    "814\t2026-09-18\tEvaluated\tApplied\tweb\t",
    "814\t2026-09-18\tApplied\tResponded\tweb\t",
  ].join("\n");
  const events = statusEventsFromStatusLog(log, 814);
  assert.deepEqual(
    events.map((e) => e.to),
    ["Responded", "Applied"],
  );
});

test("字符串行号同样命中；无记录返回空数组而非 null", () => {
  assert.equal(statusEventsFromStatusLog(LOG, "814").length, 2);
  assert.deepEqual(statusEventsFromStatusLog(LOG, 999), []);
});

test("缺 source/note 列 → 空字符串，不污染事件", () => {
  const events = statusEventsFromStatusLog("814\t2026-09-18\tDiscarded\tSKIP", 814);
  assert.deepEqual(events, [
    { date: "2026-09-18", from: "Discarded", to: "SKIP", source: "", note: "" },
  ]);
});

test("未知 from/to 哨兵 `-` 原样保留（显示层再决定破折号）", () => {
  const events = statusEventsFromStatusLog("814\t2026-09-18\t-\tApplied\tset-status\tseeded", 814);
  assert.equal(events[0].from, "-");
  assert.equal(events[0].note, "seeded");
});

test("空文本 / 缺文件 / 坏行号 → 空数组", () => {
  assert.deepEqual(statusEventsFromStatusLog("", 814), []);
  assert.deepEqual(statusEventsFromStatusLog("   ", 814), []);
  assert.deepEqual(statusEventsFromStatusLog("814\t2026-09-18\tA\tB", "abc"), []);
  assert.deepEqual(statusEventsFromStatusLog(LOG, ""), []);
});

// 漂移守卫：events 解析器是根版 + web 副本两份实现（turbopack.root 禁跨根
// import，见 web/src/lib/status-log.mjs 头注）。同一输入必须逐事件一致。
test("web status-log events 解析器与根版逐事件一致（防副本漂移）", () => {
  const inputs = [LOG, "814\t2026-09-18\t-\tApplied\tset-status\tseeded", "", "bad-line"];
  for (const text of inputs) {
    assert.deepEqual(
      statusEventsFromStatusLog(text, 814),
      coreStatusEvents(text, 814),
      `drift on input: ${JSON.stringify(text.slice(0, 24))}`,
    );
  }
});
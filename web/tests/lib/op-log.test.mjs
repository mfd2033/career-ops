// 操作日志聚合层（web/src/lib/op-log.mjs）与写入台账（op-log-store.mjs）的单测。
//
// 这一层是 /logs 页面的唯一数据来源，四个事实源各有一套脏数据：status-log 有表头
// 与坏行、follow-ups 有 [unread] 尾巴和老 bullet、runs 台账有未收录的 kind、
// scan-runs 的列序会随扫描器演进。断言重点不是「解析成功」，而是「坏数据不进页面、
// 同一天的同一条操作只出现一次」。
//
// Run: node --test web/tests/lib/op-log.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OP_LOG_WINDOW_DAYS,
  dayStart,
  entriesFromFollowUps,
  entriesFromRuns,
  entriesFromScanRuns,
  entriesFromStatusLog,
  isOpLogType,
  localDay,
  makeEntry,
  mergeOperationLog,
  windowDates,
} from "../../src/lib/op-log.mjs";
import { appendOpLog, opLogPath, readOpLog } from "../../src/lib/op-log-store.mjs";

const TODAY = "2026-11-11";
const trackerIndex = new Map([
  ["1317", "#1317 致远互联 · Java项目经理"],
  ["27", "#27 蜜雪冰城 · IT项目经理"],
]);

/** 本地某个时刻的 epoch，避免用 UTC 字符串——窗口是本地日。 */
const at = (y, m, d, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

test("windowDates：今天起算、最新在前、共 7 天，边界不越界", () => {
  const dates = windowDates(TODAY);
  assert.equal(dates.length, OP_LOG_WINDOW_DAYS);
  assert.deepEqual(dates, ["2026-11-11", "2026-11-10", "2026-11-09", "2026-11-08", "2026-11-07", "2026-11-06", "2026-11-05"]);
  // 跨月/跨年同样成立
  assert.equal(windowDates("2026-03-02")[6], "2026-02-24");
  assert.equal(windowDates("2027-01-02")[3], "2026-12-30");
  assert.deepEqual(windowDates("not-a-date"), []);
});

test("status-log：忽略表头与坏行，来源/迁移/去重键齐备", () => {
  const text = [
    "\uFEFF3\t2026-11-11\tEvaluated\tRejected\tset-status\t",
    "1317\t2026-11-11\tEvaluated\tRejected\tweb\t按报告结论",
    "bad-line",
    "\t2026-11-11\tA\tB\tweb\t",
    "9\t2026-13-45\tA\tB\tweb\t", // 假日期
  ].join("\r\n");

  const entries = entriesFromStatusLog(text, trackerIndex);
  assert.equal(entries.length, 2);

  const [first, second] = entries;
  assert.equal(first.trigger, "manual");
  assert.equal(first.type, "status-change");
  assert.equal(first.hasTime, false); // 台账只有日期
  assert.equal(first.date, "2026-11-11");
  assert.deepEqual(first.meta, [
    { k: "from", v: "Evaluated" },
    { k: "to", v: "Rejected" },
    { k: "source", v: "set-status" },
  ]);

  // tracker 索引存在时标题补全成「#N 公司 · 岗位」，否则退回 #N
  assert.equal(second.title, "#1317 致远互联 · Java项目经理");
  assert.deepEqual(second.meta.at(-1), { k: "note", v: "按报告结论" });
  assert.equal(second.dedupeKey, "status:1317:2026-11-11:Evaluated->Rejected");
  assert.equal(second.href, "/pipeline?q=1317");
});

test("follow-ups：表格行解析、跳过表头、[unread] 尾巴不污染备注", () => {
  const md = [
    "# Follow-ups",
    "",
    "| num | appNum | date | company | role | channel | contact | notes |",
    "|---|---|---|---|---|---|---|---|",
    "| 12 | 27 | 2026-11-10 | 蜜雪冰城 | IT项目经理 | Email |  | 已发追问 |",
    "| 13 | 27 | 2026-11-10 | 蜜雪冰城 | IT项目经理 | Email |  |  | [unread]",
    "- 老格式 bullet 行不该被当成表格",
  ].join("\n");

  const entries = entriesFromFollowUps(md, trackerIndex);
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.dedupeKey),
    ["followup:12", "followup:13"],
  );
  assert.equal(entries[0].type, "follow-up");
  assert.equal(entries[0].trigger, "manual");
  assert.equal(entries[0].title, "#27 蜜雪冰城 · IT项目经理");
  assert.deepEqual(entries[0].meta, [
    { k: "channel", v: "Email" },
    { k: "note", v: "已发追问" },
  ]);
  // [unread] 不进 notes
  assert.deepEqual(entries[1].meta, [{ k: "channel", v: "Email" }]);
});

test("runs 台账：kind 映射、状态映射、时长与跳转", () => {
  const records = [
    {
      id: "run-a",
      kind: "evaluate",
      title: "中犇科技 · 项目经理（APP定制产品）",
      status: "done",
      startedAt: at(2026, 11, 11, 14, 0),
      finishedAt: at(2026, 11, 11, 14, 2) + 12_000,
      cliId: "qoder-cn",
      model: "Qwen3.8-Flash",
      reportNum: "1332",
    },
    {
      id: "run-b",
      kind: "checkup",
      title: "河南奋景电子科技有限公司",
      status: "error",
      startedAt: at(2026, 11, 11, 11, 30),
      finishedAt: at(2026, 11, 11, 11, 40),
      page: "/pipeline/1318",
      msg: "interrupted",
    },
    { id: "run-c", kind: "cv-tailor", title: "定制简历", status: "done", startedAt: at(2026, 11, 10, 9, 0), finishedAt: at(2026, 11, 10, 9, 0) },
    { id: "run-d", kind: "unknown-kind", title: "x", status: "done", startedAt: 1, finishedAt: 2 },
    { id: "run-e", kind: "evaluate", title: "无时刻" },
  ];

  const entries = entriesFromRuns(records);
  assert.deepEqual(
    entries.map((e) => e.type),
    ["evaluate", "checkup", "cv"],
  );
  const [evaluate, checkup] = entries;
  assert.equal(evaluate.trigger, "auto");
  assert.equal(evaluate.status, "done");
  assert.equal(evaluate.durationSec, 132);
  assert.deepEqual(evaluate.meta, [
    { k: "engine", v: "qoder-cn / Qwen3.8-Flash" },
    { k: "report", v: "#1332" },
  ]);
  assert.equal(evaluate.href, "/report/1332");
  assert.equal(checkup.status, "failed");
  assert.equal(checkup.href, "/pipeline/1318");
});

test("scan-runs：按表头取列，UTC 时间戳换成本地日，0 值不占位", () => {
  const tsv = [
    "timestamp\tstatus\tcompanies\tboards\tfound\tfiltered_title\tnew_added",
    "2026-11-11T06:15:00.000Z\tcompleted\t3\t3\t5\t4\t0",
    "2026-11-10T22:00:00.000Z\tfailed\t0\t0\t0\t0\t0",
    "not-a-date\tcompleted\t1\t1\t1\t0\t1",
  ].join("\n");

  const entries = entriesFromScanRuns(tsv);
  assert.equal(entries.length, 2);
  const [ok, failed] = entries;
  assert.equal(ok.type, "scan");
  assert.equal(ok.trigger, "auto");
  assert.equal(ok.status, "done");
  assert.equal(ok.title, ""); // 无实体标题，页面回落到类型名
  assert.equal(ok.date, localDay(Date.parse("2026-11-11T06:15:00.000Z")));
  // 0 值的列不占位：只有非零的 found / companies / boards
  assert.deepEqual(ok.meta, [
    { k: "companies", v: "3" },
    { k: "boards", v: "3" },
    { k: "found", v: "5" },
  ]);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.meta, []);
});

test("makeEntry：未知类型、缺时刻、非法 href 一律收敛掉", () => {
  assert.equal(makeEntry({ at: 1, type: "not-a-type" }), null);
  assert.equal(makeEntry({ type: "evaluate" }), null);

  const entry = makeEntry({
    at: at(2026, 11, 11, 9, 5),
    type: "evaluate",
    title: "  多行\n标题  ",
    href: "https://evil.example.com",
    meta: [{ k: "Bad Key", v: "x" }, { k: "engine", v: "  cli  " }, { k: "empty", v: "" }],
    dedupeKey: "run:1",
  });
  assert.equal(entry.title, "多行 标题");
  assert.equal(entry.href, null);
  assert.deepEqual(entry.meta, [{ k: "engine", v: "cli" }]);
  assert.equal(entry.hasTime, true);
});

test("merge：裁到七日窗口，op-log 优先去重，按时间倒序", () => {
  const today = TODAY;
  const opLog = [
    // 与 status-log 同一件事：op-log 有精确时刻，旧台账那条要消失
    {
      id: "op-1",
      at: at(2026, 11, 11, 16, 40),
      trigger: "manual",
      type: "status-change",
      title: "#1317 致远互联 · Java项目经理",
      meta: [
        { k: "from", v: "Evaluated" },
        { k: "to", v: "Rejected" },
      ],
      status: "done",
      dedupeKey: "status:1317:2026-11-11:Evaluated->Rejected",
    },
    // 窗口外（今天 -7）必须被裁掉
    { id: "op-old", at: at(2026, 11, 4, 10, 0), type: "config", status: "done" },
    // 未知类型不进页面
    { id: "op-bad", at: at(2026, 11, 11, 10, 0), type: "made-up" },
  ];
  const statusLog = ["1317\t2026-11-11\tEvaluated\tRejected\tweb\t", "3\t2026-11-11\tApplied\tRejected\tset-status\t"].join("\n");
  const followUps = ["| num | appNum | date | company | role | channel | contact | notes |", "| 9 | 27 | 2026-11-10 | 蜜雪冰城 | IT项目经理 | Email |  |  |"].join("\n");
  const runs = [
    {
      id: "run-a",
      kind: "evaluate",
      title: "中犇科技 · 项目经理",
      status: "done",
      startedAt: at(2026, 11, 11, 14, 0),
      finishedAt: at(2026, 11, 11, 14, 2),
    },
    // 窗口外
    { id: "run-old", kind: "evaluate", title: "旧的", status: "done", startedAt: at(2026, 10, 1, 9, 0), finishedAt: at(2026, 10, 1, 9, 5) },
  ];

  const { entries, dates } = mergeOperationLog({
    opLog,
    statusLog,
    runs,
    followUps,
    today,
    trackerIndex,
  });

  assert.equal(dates[0], "2026-11-11");
  assert.equal(dates.length, 7);
  assert.ok(!entries.some((e) => e.id === "op-old"), "窗口外的 op-log 记录必须裁掉");
  assert.ok(!entries.some((e) => e.id === "run-old"), "窗口外的 run 记录必须裁掉");
  assert.ok(!entries.some((e) => e.type === "made-up"), "未知类型不能进页面");

  // 同键去重：只剩 op-log 那条（带时刻），status-log 的 1317 行不再出现
  const statusEntries = entries.filter((e) => e.type === "status-change");
  assert.equal(statusEntries.length, 2);
  assert.equal(statusEntries.filter((e) => e.title.includes("1317")).length, 1);
  assert.equal(statusEntries.find((e) => e.title.includes("1317")).hasTime, true);
  // 另一条来自 status-log，只有日期
  assert.equal(statusEntries.find((e) => !e.title.includes("1317")).hasTime, false);

  // 时间倒序：16:40 > 14:02 > 00:00（无时刻的手动行排在当天末尾）
  const ats = entries.map((e) => e.at);
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a));
  const first = entries[0];
  assert.equal(first.id, "op-1");

  // 跟进记录进来且归属手动
  const followUp = entries.find((e) => e.type === "follow-up");
  assert.ok(followUp);
  assert.equal(followUp.trigger, "manual");
  assert.equal(followUp.date, "2026-11-10");
});

test("merge：空输入不炸，返回空列表与完整日期轴", () => {
  const { entries, dates } = mergeOperationLog({ today: TODAY });
  assert.deepEqual(entries, []);
  assert.equal(dates.length, 7);
});

test("写入台账：追加即可读回，未知类型拒绝落盘，坏行不影响读取", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "op-log-"));
  try {
    const rec = appendOpLog(root, {
      trigger: "manual",
      type: "tracker-delete",
      title: "#1317 致远互联 · Java项目经理",
      meta: [{ k: "orphan", v: "reports/1317-x.md" }, { k: "Bad Key", v: "x" }],
      status: "done",
      href: "/pipeline?q=1317",
      dedupeKey: "delete:1317",
      at: at(2026, 11, 11, 15, 0),
    });
    assert.ok(rec);
    assert.equal(rec.type, "tracker-delete");
    assert.equal(rec.trigger, "manual");
    assert.deepEqual(rec.meta, [{ k: "orphan", v: "reports/1317-x.md" }]);
    assert.equal(rec.href, "/pipeline?q=1317");

    // 未知类型直接拒绝（返回 null），且不落盘
    assert.equal(appendOpLog(root, { type: "nope" }), null);
    // 合法类型照常写入，trigger 原样保留
    const autoRec = appendOpLog(root, { type: "evaluate", trigger: "auto", title: "评估" });
    assert.equal(autoRec.type, "evaluate");
    assert.equal(autoRec.trigger, "auto");
    // 手工塞一行坏 JSON，读取必须跳过而不是抛
    fs.appendFileSync(opLogPath(root), "{not json}\n");
    fs.appendFileSync(opLogPath(root), "\n");

    const read = readOpLog(root);
    assert.equal(read.length, 2);
    assert.equal(read[0].type, "tracker-delete");
    assert.equal(read[1].type, "evaluate");

    // 目录不存在、台本缺失都是「没有日志」，不是错误
    assert.deepEqual(readOpLog(path.join(root, "missing")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dayStart / localDay 互逆（本地日口径）", () => {
  const ms = dayStart("2026-11-11");
  assert.equal(localDay(ms), "2026-11-11");
  assert.equal(dayStart("2026-11-11"), new Date(2026, 10, 11, 0, 0, 0, 0).getTime());
  assert.equal(dayStart("2026-13-45"), null);
});

test("类型白名单：手动/自动两组的代表性类型都在，拼错的类型不在", () => {
  assert.equal(isOpLogType("status-change"), true);
  assert.equal(isOpLogType("scan"), true);
  assert.equal(isOpLogType("follow-up-delete"), true);
  assert.equal(isOpLogType("Status-Change"), false);
  assert.equal(isOpLogType(""), false);
});

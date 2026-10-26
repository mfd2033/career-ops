// ledger-only 台账行 → 展示卡片的映射纯函数 — 托盘与 /jobs 主列表共用的
// 单一映射（原先只在 page.tsx 里内联一份，侧栏托盘要合并同一批行时必然
// 复制粘贴，抽出来锁住）。
//
// 背景：别的页签/扩展发起的单任务在本页签没有本地卡，只活在服务端台账
// （/api/runs/history）。/jobs 主列表凭 ledgerOnlyRuns 合并它们，但左侧
// 托盘只渲染本地卡 + 池投影——跨页签完成的任务在托盘里彻底消失。托盘要
// 吃同一份映射，映射必须先出组件。
//
// Run:  node --test tests/lib/ledger-cards.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { ledgerRunsToCards } from "../../src/lib/ledger-display.mjs";

const t = (k, p) => (p ? `${k}:${JSON.stringify(p)}` : k);

const doneRun = (over = {}) => ({
  id: "r-uuid-1", kind: "evaluate", input: "https://www.liepin.com/job/1984129495.shtml",
  title: "evaluate https://www.liepin.com/job/1984129495.shtml", status: "done",
  startedAt: 1000, finishedAt: 2000, cliId: "claude", ...over,
});

test("a done ledger row maps to a settled card with the derived readable shape", () => {
  const cards = ledgerRunsToCards([], [doneRun()], t);
  assert.equal(cards.length, 1);
  const c = cards[0];
  assert.equal(c.id, "r-uuid-1");
  assert.equal(c.title, "jobs.evaluateTitle"); // ADR-0051 读取端派生，不印裸标题
  assert.equal(c.subtitle, "liepin.com");
  assert.equal(c.status, "done");
  assert.equal(c.runId, "r-uuid-1", "runId 回填台账 id——本地卡凭它去重、详情页凭它走 ledger 兜底");
  assert.equal(c.startedAt, 1000);
  assert.equal(c.endedAt, 2000);
  assert.equal(c.cliId, "claude");
  assert.equal(c.ledgerOnly, true, "托盘凭这个标记不渲染对死按钮（✕ 删不掉台账行）");
});

test("an error ledger row carries its msg as text and never fakes done", () => {
  const cards = ledgerRunsToCards([], [doneRun({ status: "error", msg: "cli crashed" })], t);
  assert.equal(cards[0].status, "error");
  assert.equal(cards[0].text, "cli crashed");
});

test("rows whose runId already has a local card are skipped (local wins)", () => {
  const jobs = [{ id: "local-1", runId: "r-uuid-1", status: "done", steps: [], text: "", startedAt: 1, title: "t" }];
  assert.deepEqual(ledgerRunsToCards(jobs, [doneRun()], t), []);
});

test("batch child rows (parentId) never become cards", () => {
  assert.deepEqual(ledgerRunsToCards([], [doneRun({ parentId: "batch-1" })], t), []);
});

test("malformed rows degrade instead of throwing", () => {
  const cards = ledgerRunsToCards([], [null, { status: "done" }, doneRun({ id: undefined })], t);
  assert.deepEqual(cards, [], "无 id 的行（去重键缺失）不生成卡");
});

test("a missing translator degrades without throwing (tolerant reader)", () => {
  const url = "https://x/1";
  const cards = ledgerRunsToCards([], [{ id: "r1", kind: "evaluate", input: url, title: `evaluate ${url}`, status: "done", startedAt: 1, finishedAt: 2 }]);
  assert.equal(cards.length, 1);
  // ledgerCardFields 的既有约定：缺 t 时回退恒等函数 → 标题是键名（生产总传 t）。
  assert.equal(cards[0].title, "jobs.evaluateTitle");
});
test("ADR-0089：台账行记的报告号原样透传到卡，缺失不占位", () => {
  // recordEnd 落的是字符串（pdf/checkup 的 input 即号），子台账落的是数字。
  assert.equal(ledgerRunsToCards([], [doneRun({ reportNum: "812" })], t)[0].reportNum, "812");
  assert.equal(ledgerRunsToCards([], [doneRun({ reportNum: 42 })], t)[0].reportNum, "42");
  assert.equal(ledgerRunsToCards([], [doneRun()], t)[0].reportNum, undefined, "未记录不回填、不猜测");
});

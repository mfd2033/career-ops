// card-status-pure 纯逻辑单测：列表卡「状态胶囊 + 分数胶囊」的组合规则。
//
// 三站共用一套胶囊，真正会出错的地方只有几条：临时态顶掉状态胶囊、状态胶囊的
// 可编辑判定（有 tracker 行号才写回得去）、↗ 只出现在可点的临时态上、完整评估
// 压过快评。这些分支在真实招聘站页面上几乎没法稳定复现（要等评估真进池、又要抢
// 在卡片重渲染的同一帧里观察），所以全在纯函数上钉住。
//
// Run:  node --test web/tests/lib/card-status-pure.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mod = await import(pathToFileURL(join(ROOT, "extension", "card-status-pure.js")).href);
const {
  RUN_RUNNING_COLOR,
  RUN_QUEUED_COLOR,
  RUN_LINK_SUFFIX,
  EVAL_POLL_MAX_TRIES,
  isRunState,
  statusChip,
  scoreChip,
  cardChips,
  chipFingerprint,
  cardEvalGate,
  evalPollVerdict,
  evalButtonState,
} = mod.default ?? mod;

const RUN_ID = "3f2b8c1e-9d4a-4c77-8f10-2a5b6c7d8e9f";
const status = (raw, text, color, reportNum = "42") => ({ raw, text, color, reportNum });
const score = (text, color = "#00c68d", reportNum = "42") => ({ text, color, reportNum });
const quick = (score_, color = "#7c5cff") => ({ score: score_, grade: "值得聊", reason: "岗位对口", color });

// ---- isRunState ----------------------------------------------------------

test("isRunState：只认 running / queued，大小写与空白归一", () => {
  assert.equal(isRunState("running"), "running");
  assert.equal(isRunState(" QUEUED "), "queued");
  assert.equal(isRunState("finished"), null);
  assert.equal(isRunState(""), null);
  assert.equal(isRunState(null), null);
  assert.equal(isRunState(undefined), null);
});

// ---- 状态胶囊：临时态优先 ------------------------------------------------

test("评估中：顶掉 tracker 状态、可点、带 ↗ 后缀与 runId，且不可改状态", () => {
  const chip = statusChip({ status: status("Applied", "已申请", "#4aa3ff"), run: { status: "running", runId: RUN_ID } });
  assert.equal(chip.kind, "run");
  assert.equal(chip.text, "评估中" + RUN_LINK_SUFFIX);
  assert.equal(chip.color, RUN_RUNNING_COLOR);
  assert.equal(chip.clickable, true);
  assert.equal(chip.editable, false, "临时态点击去 Worker，不提供改状态");
  assert.equal(chip.runId, RUN_ID);
});

test("排队中：同样顶掉状态、可点，取中性灰", () => {
  const chip = statusChip({ status: status("Applied", "已申请", "#4aa3ff"), run: { status: "queued", runId: RUN_ID } });
  assert.equal(chip.text, "排队中" + RUN_LINK_SUFFIX);
  assert.equal(chip.color, RUN_QUEUED_COLOR);
  assert.equal(chip.clickable, true);
});

test("run 状态认不出（finished 之类）→ 退回 tracker 状态，不显示临时态", () => {
  const chip = statusChip({ status: status("Applied", "已申请", "#4aa3ff"), run: { status: "done", runId: RUN_ID } });
  assert.equal(chip.kind, "status");
  assert.equal(chip.text, "已申请");
  assert.equal(chip.clickable, false);
});

// ---- 状态胶囊：哪些不出 --------------------------------------------------

test("Evaluated 也出状态胶囊，带 raw / reportNum 供菜单写回", () => {
  for (const raw of ["Evaluated", "evaluated"]) {
    const chip = statusChip({ status: status(raw, "已评估", "#6ea8fe") });
    assert.equal(chip.kind, "status", raw);
    assert.equal(chip.text, "已评估", raw);
    assert.equal(chip.color, "#6ea8fe", raw);
    assert.equal(chip.raw, raw, raw);
    assert.equal(chip.editable, true, raw);
    assert.equal(chip.reportNum, "42", raw);
    assert.equal(chip.title, "点击修改状态", raw);
  }
});

test("拿不到 tracker 行号 → 状态照显示，但不可编辑", () => {
  const chip = statusChip({ status: status("Applied", "已申请", "#4aa3ff", null) });
  assert.equal(chip.text, "已申请");
  assert.equal(chip.editable, false);
  assert.equal(chip.reportNum, null);
  assert.match(chip.title, /状态：Applied/);
});

test("tracker 行没有状态值 / 没有 tracker 行 → 不出状态胶囊", () => {
  assert.equal(statusChip({ status: null }), null);
  assert.equal(statusChip({ status: status("   ", "已评估", "#8a8f98") }), null);
  assert.equal(statusChip({}), null);
});

test("其它规范状态：照字典文案取色，可编辑但不可点跳转", () => {
  for (const [raw, text, color] of [
    ["Applied", "已申请", "#4aa3ff"],
    ["Responded", "已回复", "#00b8d9"],
    ["Interview", "面试中", "#f5a623"],
    ["Offer", "录用通知", "#14b8a6"],
    ["SKIP", "跳过", "#8a8f98"],
  ]) {
    const chip = statusChip({ status: status(raw, text, color) });
    assert.equal(chip.text, text, raw);
    assert.equal(chip.color, color, raw);
    assert.equal(chip.raw, raw, raw);
    assert.equal(chip.editable, true, raw);
    assert.equal(chip.clickable, false, raw);
    assert.equal(chip.runId, undefined, raw);
    assert.ok(!chip.text.includes("↗"), `${raw} 不可点跳转就不该带 ↗`);
  }
});

// ---- 分数胶囊 ------------------------------------------------------------

test("完整评估：文本照抄 tracker（4.3/5），可点开报告", () => {
  const chip = scoreChip({ score: score("4.3/5", "#00c68d", "42") });
  assert.equal(chip.text, "4.3/5");
  assert.equal(chip.color, "#00c68d");
  assert.equal(chip.clickable, true);
  assert.equal(chip.reportNum, "42");
});

test("报告号缺失 → 分数照显示但不可点（没有报告可开）", () => {
  const chip = scoreChip({ score: score("4.3/5", "#00c68d", null) });
  assert.equal(chip.clickable, false);
  assert.equal(chip.reportNum, null);
});

test("快评：补 /5、保留紫色通道色、不可点", () => {
  const chip = scoreChip({ quick: quick(4) });
  assert.equal(chip.text, "4/5");
  assert.equal(chip.color, "#7c5cff");
  assert.equal(chip.clickable, false);
  assert.equal(chip.reportNum, null);
  assert.match(chip.title, /值得聊/);
});

test("快评 0 分也算有值（不能被 falsy 当成缺值）", () => {
  assert.equal(scoreChip({ quick: quick(0) }).text, "0/5");
});

test("完整评估优先于快评（两者都在时只出评估分）", () => {
  const chip = scoreChip({ score: score("4.3/5", "#00c68d", "42"), quick: quick(3) });
  assert.equal(chip.text, "4.3/5");
  assert.equal(chip.color, "#00c68d");
});

test("两者都没有 → 没有分数胶囊", () => {
  assert.equal(scoreChip({}), null);
  assert.equal(scoreChip({ score: { text: "  " }, quick: { score: null } }), null);
});

// ---- 组合：cardChips -----------------------------------------------------

test("评估过但状态为空：只有分数胶囊（不额外贴「已评估」）", () => {
  const chips = cardChips({ status: null, score: score("4.3/5", "#f5a623", "7") });
  assert.equal(chips.status, null);
  assert.equal(chips.score.text, "4.3/5");
});

test("已申请 + 分数：状态在左、分数在右", () => {
  const chips = cardChips({ status: status("Applied", "已申请", "#4aa3ff"), score: score("3.5/5", "#f5a623", "9") });
  assert.deepEqual(
    [chips.status.text, chips.score.text],
    ["已申请", "3.5/5"],
  );
});

test("评估中：临时态可点，分数胶囊仍在（评估中不该丢掉上一次的分）", () => {
  const chips = cardChips({
    status: status("Applied", "已申请", "#4aa3ff"),
    score: score("3.5/5", "#f5a623", "9"),
    run: { status: "running", runId: RUN_ID },
  });
  assert.equal(chips.status.kind, "run");
  assert.equal(chips.status.clickable, true);
  assert.equal(chips.score.text, "3.5/5");
});

test("未评估的卡片：两颗胶囊都没有（操作区只剩按钮）", () => {
  assert.deepEqual(cardChips({}), { status: null, score: null });
});

// ---- 指纹：原地重绘的短路条件 --------------------------------------------

test("指纹对同内容稳定、对内容变化敏感", () => {
  const a = cardChips({ status: status("Applied", "已申请", "#4aa3ff") });
  const b = cardChips({ status: status("Applied", "已申请", "#4aa3ff") });
  assert.equal(chipFingerprint(a), chipFingerprint(b), "同样输入必须同指纹，否则每次 observer 都重建节点");

  const c = cardChips({ status: status("Interview", "面试中", "#f5a623") });
  assert.notEqual(chipFingerprint(a), chipFingerprint(c));

  const run = cardChips({ run: { status: "running", runId: RUN_ID } });
  const queued = cardChips({ run: { status: "queued", runId: RUN_ID } });
  assert.notEqual(chipFingerprint(run), chipFingerprint(queued), "评估中 → 排队中要重绘");
});

test("指纹把「点了会去哪」纳入：换了 runId 必须重绘", () => {
  const a = cardChips({ run: { status: "running", runId: RUN_ID } });
  const b = cardChips({ run: { status: "running", runId: RUN_ID.replace("3f2b", "aaaa") } });
  assert.notEqual(chipFingerprint(a), chipFingerprint(b));
});

test("指纹纳入可编辑性：同一文案，有行号与无行号必须区分", () => {
  const withNum = cardChips({ status: status("Applied", "已申请", "#4aa3ff") });
  const withoutNum = cardChips({ status: status("Applied", "已申请", "#4aa3ff", null) });
  assert.notEqual(chipFingerprint(withNum), chipFingerprint(withoutNum));
});

test("指纹不纳入 title 之类提示文案（不可见变化不必重绘）", () => {
  const base = { kind: "score", text: "4.3/5", color: "#00c68d", clickable: true, reportNum: "42" };
  assert.equal(
    chipFingerprint({ status: null, score: { ...base, title: "" } }),
    chipFingerprint({ status: null, score: { ...base, title: "换了个提示" } }),
  );
});

// ---- 点击闸门：完整评估同 URL 单飞（2026-11-10 改版） ----------------------
//
// 服务端全局并发池满员时 FIFO 入队（ADR-0014），卡片凭 /api/active-runs 出
// 「排队中」胶囊 —— 扩展不再全局单飞，第二张卡的「评估」必须放行。闸门只挡：
//   • 按钮自身禁用（文案就是「评估中…」）—— 静默，可见状态已足够；
//   • 同一 URL 已在评估（另一张卡 / 按钮被站点重渲染重建后 disabled 丢失）—— 必须开口。

test("cardEvalGate：同 URL 已在飞 → 挡下并给可读 toast", () => {
  const gate = cardEvalGate({ urlInFlight: true });
  assert.equal(gate.allow, false);
  assert.ok(gate.toast && gate.toast.includes("评估"), "toast 必须解释为什么点不动");
});

test("cardEvalGate：空闲 → 放行、不说话（其他卡在飞也不再挡）", () => {
  assert.deepEqual(cardEvalGate({}), { allow: true, toast: null });
  assert.deepEqual(cardEvalGate(null), { allow: true, toast: null });
});

test("cardEvalGate：按钮自身禁用 → 挡下但不再 toast（按钮已显示评估中）", () => {
  const gate = cardEvalGate({ btnDisabled: true });
  assert.equal(gate.allow, false);
  assert.equal(gate.toast, null);
});

test("cardEvalGate：按钮禁用优先于同 URL 在飞（都挡下，安静）", () => {
  const gate = cardEvalGate({ btnDisabled: true, urlInFlight: true });
  assert.equal(gate.allow, false);
  assert.equal(gate.toast, null);
});

test("cardEvalGate：脏值按布尔归一，truthy 即挡下", () => {
  assert.equal(cardEvalGate({ urlInFlight: 1 }).allow, false);
  assert.equal(cardEvalGate({ urlInFlight: "yes" }).allow, false);
  assert.equal(cardEvalGate({ urlInFlight: 0 }).allow, true);
});

// ---- 收尾轮询裁决：到期必须解锁按钮（不能只停轮询） -------------------------
//
// 回归点：轮询 240 次（12min）到期若只 stopEvalPoll，cardEvalInFlight 永久为 true，
// 之后所有卡片的「评估」点击永远无反应 —— 必须同时 settle（解锁）并告知用户。

test("evalPollVerdict：未到期 → 不停、不解锁", () => {
  assert.deepEqual(evalPollVerdict(EVAL_POLL_MAX_TRIES - 1), { stop: false, settle: false, toast: null });
  assert.deepEqual(evalPollVerdict(0), { stop: false, settle: false, toast: null });
});

test("evalPollVerdict：到期 → 停轮询 + 解锁按钮 + 告知用户", () => {
  const v = evalPollVerdict(EVAL_POLL_MAX_TRIES);
  assert.equal(v.stop, true);
  assert.equal(v.settle, true, "到期必须解锁，否则单飞锁永久卡死");
  assert.ok(v.toast && v.toast.includes("评估"), "toast 必须解释按钮为什么自己恢复了");
});

test("evalPollVerdict：脏 tries 不误停", () => {
  for (const bad of [null, undefined, NaN, -1, "abc"]) {
    assert.deepEqual(evalPollVerdict(bad), { stop: false, settle: false, toast: null }, String(bad));
  }
});

test("evalPollVerdict：上限可覆盖（测试注入小上限即可验证到期分支）", () => {
  assert.deepEqual(evalPollVerdict(3, 3).stop, true);
  assert.deepEqual(evalPollVerdict(2, 3).stop, false);
});

// ---- 评估按钮状态派生（2026-11-10 个人中心实测第二组缺陷） ------------------
//
// 胶囊吃 /api/active-runs 快照（刷新可重建），按钮却只吃页内内存 —— 实测出两条：
//   • 第一份评估在跑时刷新页面，按钮回到可点的「评估」，看起来什么都没发生；
//   • 点击时按钮硬编码「评估中…」，任务进池排队后也永远不跟着改成「排队中…」。
// 修法与胶囊同源：按钮态从同一份 run 快照派生，纯层钉住。

test("evalButtonState：快照 running → 禁用 + 评估中…（刷新后按钮恢复在跑态）", () => {
  assert.deepEqual(evalButtonState({ run: { status: "running", runId: RUN_ID } }), {
    disabled: true,
    text: "评估中…",
  });
});

test("evalButtonState：快照 queued → 禁用 + 排队中…（按钮跟胶囊同口径）", () => {
  assert.deepEqual(evalButtonState({ run: { status: "queued", runId: RUN_ID } }), {
    disabled: true,
    text: "排队中…",
  });
});

test("evalButtonState：无 run 且不在飞 → 可点「评估」", () => {
  assert.deepEqual(evalButtonState({}), { disabled: false, text: "评估" });
  assert.deepEqual(evalButtonState(null), { disabled: false, text: "评估" });
  assert.deepEqual(evalButtonState({ run: null, inFlight: false }), { disabled: false, text: "评估" });
});

test("evalButtonState：页内在飞（点击后、进池前）→ 乐观评估中…", () => {
  assert.deepEqual(evalButtonState({ inFlight: true }), { disabled: true, text: "评估中…" });
});

test("evalButtonState：快照优先于页内在飞（queued 不能被乐观态盖回评估中…）", () => {
  assert.deepEqual(
    evalButtonState({ run: { status: "queued", runId: RUN_ID }, inFlight: true }),
    { disabled: true, text: "排队中…" },
  );
});

test("evalButtonState：run 状态认不出（done 之类）→ 退回在飞/空闲口径", () => {
  assert.deepEqual(evalButtonState({ run: { status: "done", runId: RUN_ID }, inFlight: true }), {
    disabled: true,
    text: "评估中…",
  });
  assert.deepEqual(evalButtonState({ run: { status: "done", runId: RUN_ID } }), {
    disabled: false,
    text: "评估",
  });
});

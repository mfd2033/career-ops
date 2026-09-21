// Tests for the zombie-card ledger reconciliation (ADR-0031).
//
// The #27 checkup (2026-09-16) exposed the seam: a live-tab job card whose
// /api/events terminal event was missed stays "running" forever, and /jobs's
// "card wins" merge then shadows the server run-ledger's TERMINATED record.
// reconcileJobsWithLedger is the pure rule: a card that claims running/queued,
// holds a runId, has NO live event accumulator, and whose runId appears in the
// ledger with a terminal status, IS a zombie — the ledger wins.
//
// Run:  node --test tests/lib/job-ledger-reconcile.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileJobsWithLedger } from "../../src/lib/job-ledger-reconcile.mjs";

const NOW = 1789570000000;

// ADR-0027 follow-up ledger shape (run-ledger.mjs): TERMINATED runs only.
const REC_27_ERROR = {
  id: "02525145-66b1-4007-8fb8-f711bbd4b857",
  kind: "checkup",
  input: "27",
  status: "error",
  startedAt: 1789568747925,
  finishedAt: 1789568835877,
  msg: "This checkup finished without adding a row to the checkup ledger — nothing was persisted.",
};
const REC_DONE = { id: "run-done-1", kind: "evaluate", input: "u1", status: "done", startedAt: 1, finishedAt: 2 };

const zombie = (id, runId, status = "running") => ({
  id,
  runId,
  status,
  steps: [],
  text: "",
  startedAt: NOW - 60000,
});

test("reconcile: the #27 scenario — a running card whose ledger record says error is healed", () => {
  const jobs = [zombie("job-1", REC_27_ERROR.id)];
  const { jobs: out, healed } = reconcileJobsWithLedger(jobs, [REC_27_ERROR], { now: NOW, doneLabel: "done", errorLabel: "error" });

  assert.deepEqual(healed, ["job-1"], "the zombie card must be reported as healed");
  assert.equal(out[0].status, "error");
  assert.equal(out[0].endedAt, REC_27_ERROR.finishedAt, "endedAt comes from the ledger, not wall clock");
  assert.ok(out[0].text.includes("nothing was persisted"), "the ledger msg becomes the card text");
  const last = out[0].steps.at(-1);
  assert.equal(last.kind, "status");
  assert.ok(last.label.includes("nothing was persisted"), "the failure msg is surfaced on the step");
});

test("reconcile: a running card whose ledger record says done is healed too", () => {
  const jobs = [zombie("job-2", REC_DONE.id)];
  const { jobs: out, healed } = reconcileJobsWithLedger(jobs, [REC_DONE], { now: NOW, doneLabel: "done", errorLabel: "error" });

  assert.deepEqual(healed, ["job-2"]);
  assert.equal(out[0].status, "done");
  assert.equal(out[0].endedAt, REC_DONE.finishedAt);
  assert.equal(out[0].steps.at(-1).label, "done", "done healing uses the caller's label (no msg on ledger)");
});

test("reconcile: no ledger record for the runId → untouched (the run may still be going)", () => {
  const jobs = [zombie("job-3", "run-not-in-ledger")];
  const { jobs: out, healed } = reconcileJobsWithLedger(jobs, [REC_27_ERROR], { now: NOW, doneLabel: "d", errorLabel: "e" });

  assert.deepEqual(healed, []);
  assert.equal(out[0].status, "running");
  assert.equal(out[0].endedAt, undefined);
});

test("reconcile: a ledger record inside the grace window is left to the live SSE path", () => {
  const jobs = [zombie("job-4", REC_27_ERROR.id)];
  // Record settled 5s ago (< default 30s grace) — the live path may still deliver.
  const { jobs: out, healed } = reconcileJobsWithLedger(jobs, [REC_27_ERROR], { now: REC_27_ERROR.finishedAt + 5000, doneLabel: "d", errorLabel: "e" });

  assert.deepEqual(healed, [], "inside the grace window the live event wins the race");
  assert.equal(out[0].status, "running");
});

test("reconcile: beyond the grace window even a still-accumulating card is healed (#73 hole)", () => {
  // The SSE channel dropped at settle: the accumulator is present but the
  // terminal event can never arrive (settled runs are not replayed). 30s past
  // finishedAt, the ledger wins regardless of any local accumulator.
  const jobs = [zombie("job-4b", REC_27_ERROR.id)];
  const { jobs: out, healed } = reconcileJobsWithLedger(jobs, [REC_27_ERROR], { now: REC_27_ERROR.finishedAt + 31000, doneLabel: "d", errorLabel: "e" });

  assert.deepEqual(healed, ["job-4b"]);
  assert.equal(out[0].status, "error");
});

test("reconcile: a queued card is healed the same way", () => {
  const jobs = [zombie("job-5", REC_27_ERROR.id, "queued")];
  const { jobs: out, healed } = reconcileJobsWithLedger(jobs, [REC_27_ERROR], { now: NOW, doneLabel: "d", errorLabel: "e" });

  assert.deepEqual(healed, ["job-5"]);
  assert.equal(out[0].status, "error");
});

test("reconcile: cards without a runId never participate (nothing to join on)", () => {
  const jobs = [{ ...zombie("job-6", undefined), runId: undefined }];
  const { jobs: out, healed } = reconcileJobsWithLedger(jobs, [REC_27_ERROR], { now: NOW, doneLabel: "d", errorLabel: "e" });

  assert.deepEqual(healed, []);
  assert.equal(out[0].status, "running");
});

test("reconcile: terminal cards (done/error) are never touched, and unchanged jobs pass through by identity", () => {
  const finished = { ...zombie("job-7", REC_27_ERROR.id), status: "error", endedAt: 123 };
  const untouched = zombie("job-8", "run-not-in-ledger");
  const { jobs: out, healed } = reconcileJobsWithLedger([finished, untouched], [REC_27_ERROR], { now: NOW, doneLabel: "d", errorLabel: "e" });

  assert.deepEqual(healed, []);
  assert.equal(out[0], finished, "terminal cards pass through by identity");
  assert.equal(out[1], untouched);
});

test("reconcile: when a runId appears more than once, the NEWEST ledger record wins", () => {
  // #131 history: an early error record, later a real done record. Newest first.
  const ledger = [REC_DONE, REC_27_ERROR];
  const jobs = [zombie("job-9", REC_DONE.id)];
  const { jobs: out } = reconcileJobsWithLedger(jobs, ledger, { now: NOW, doneLabel: "d", errorLabel: "e" });

  assert.equal(out[0].status, "done", "readRunHistory returns newest first; the newest record is authoritative");
});

test("reconcile: a restore-interrupted guess card (interruptedAt) is upgraded to the ledger's truth", () => {
  // Reload marked a still-settling run "interrupted"; the run then settled as
  // done — the reconciler replaces the guess with the real result.
  const guessed = { ...zombie("job-10", REC_DONE.id), status: "error", interruptedAt: NOW - 1000, steps: [{ kind: "status", label: "interrupted", ts: NOW - 1000 }] };
  const { jobs: out, healed } = reconcileJobsWithLedger([guessed], [REC_DONE], { now: NOW, doneLabel: "d", errorLabel: "e" });

  assert.deepEqual(healed, ["job-10"]);
  assert.equal(out[0].status, "done", "the interrupted guess yields to the ledger's done");
  assert.equal(out[0].interruptedAt, undefined, "the cure clears the guess marker");
});

test("reconcile: a REAL error card (no interruptedAt) is never touched", () => {
  const realError = { ...zombie("job-11", REC_DONE.id), status: "error", endedAt: 5 };
  const { jobs: out, healed } = reconcileJobsWithLedger([realError], [REC_DONE], { now: NOW, doneLabel: "d", errorLabel: "e" });

  assert.deepEqual(healed, []);
  assert.equal(out[0], realError, "errors reached via the live SSE path are terminal, not guesses");
});

// --- ADR-0047: durable step reconstruction on heal --------------------------

test("reconcile: ledger steps rebuild the timeline (seed + reconstruction + Done)", () => {
  const rec = {
    ...REC_DONE,
    steps: [
      { kind: "tool", label: "WebFetch: https://x.com/jobs/1", ts: 100 },
      { kind: "status", label: "正在评分", ts: 200 },
    ],
  };
  const card = { ...zombie("job-12", REC_DONE.id), steps: [{ kind: "status", label: "正在启动…", ts: NOW - 60000 }] };
  const { jobs: out } = reconcileJobsWithLedger([card], [rec], { now: NOW, doneLabel: "Done", errorLabel: "error" });

  assert.deepEqual(
    out[0].steps.map((s) => s.label),
    ["正在启动…", "WebFetch: https://x.com/jobs/1", "正在评分", "Done"],
    "本地种子在前，台账重建填充中间，终态在后",
  );
});

test("reconcile: no ledger steps → byte-for-byte the old behaviour (local + terminal)", () => {
  const card = { ...zombie("job-13", REC_DONE.id), steps: [{ kind: "status", label: "正在启动…", ts: NOW - 60000 }] };
  const { jobs: out } = reconcileJobsWithLedger([card], [REC_DONE], { now: NOW, doneLabel: "Done", errorLabel: "error" });

  assert.deepEqual(out[0].steps.map((s) => s.label), ["正在启动…", "Done"]);
});

test("reconcile: local partial steps dedupe against the reconstruction (by kind:label)", () => {
  const rec = {
    ...REC_DONE,
    steps: [
      { kind: "tool", label: "Read: cv.md", ts: 100 },
      { kind: "tool", label: "Write: reports/1.md", ts: 200 },
    ],
  };
  // Local tab was half-live: it saw the Read step (its own clock) but missed Write.
  const card = { ...zombie("job-14", REC_DONE.id), steps: [{ kind: "tool", label: "Read: cv.md", ts: NOW - 500 }] };
  const { jobs: out } = reconcileJobsWithLedger([card], [rec], { now: NOW, doneLabel: "Done", errorLabel: "error" });

  assert.deepEqual(
    out[0].steps.map((s) => s.label),
    ["Read: cv.md", "Write: reports/1.md", "Done"],
    "同名同步骤降不重复（ts 不同仍去重）",
  );
});

test("reconcile: 长 label 本地全串 vs 台账截断串仍去重（Major#1 回归）", () => {
  const full = `Bash: ${"x".repeat(300)}`; // > RUN_STEP_LABEL_MAX
  const clipped = `${full.slice(0, 199)}…`;
  const rec = { ...REC_DONE, steps: [{ kind: "tool", label: clipped, ts: 100 }] };
  const card = { ...zombie("job-15", REC_DONE.id), steps: [{ kind: "tool", label: full, ts: NOW - 500 }] };
  const { jobs: out } = reconcileJobsWithLedger([card], [rec], { now: NOW, doneLabel: "Done", errorLabel: "error" });

  const bashRows = out[0].steps.filter((s) => s.kind === "tool");
  assert.equal(bashRows.length, 1, "同一步骤不得因裁剪口径不一致而露两行");
});

test("reconcile: 台账重建保留真实重复的工具调用（不自去重）", () => {
  const rec = {
    ...REC_DONE,
    steps: [
      { kind: "tool", label: "Read: cv.md", ts: 100 },
      { kind: "tool", label: "Read: cv.md", ts: 150 },
    ],
  };
  const card = { ...zombie("job-16", REC_DONE.id), steps: [{ kind: "status", label: "正在启动…", ts: NOW - 60000 }] };
  const { jobs: out } = reconcileJobsWithLedger([card], [rec], { now: NOW, doneLabel: "Done", errorLabel: "error" });

  assert.deepEqual(
    out[0].steps.map((s) => s.label),
    ["正在启动…", "Read: cv.md", "Read: cv.md", "Done"],
    "重建段内的合法重复保留，与 ledger-only 视图同口径",
  );
});

// Tests for lib/core/run-events.ts — the in-process worker-event bus behind
// /api/run's {runId} + /api/events multiplexed transport (ADR-0020).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerRun,
  setCancelHandler,
  publish,
  completeRun,
  cancelRun,
  subscribeRuns,
  getRunBuffer,
  listRunIds,
  isRunDone,
  MAX_EVENTS_PER_RUN,
  MAX_RECORDED_RUNS,
  __resetRunEventsForTest,
} from "../../src/lib/core/run-events.ts";

beforeEach(() => __resetRunEventsForTest());

test("publish stamps a monotonic per-run seq and buffers events", () => {
  registerRun("r1");
  publish("r1", { type: "status", label: "a" });
  publish("r1", { type: "text", text: "b" });
  const buf = getRunBuffer("r1");
  assert.equal(buf.length, 2);
  assert.deepEqual(buf.map((e) => e.seq), [1, 2]);
  assert.equal(buf[0].type, "status");
  assert.equal(buf[1].text, "b");
});

test("publish for an unregistered or completed run is a no-op", () => {
  publish("ghost", { type: "text", text: "x" }); // must not throw
  assert.equal(listRunIds().includes("ghost"), false);

  registerRun("r1");
  completeRun("r1");
  publish("r1", { type: "text", text: "late" });
  assert.equal(getRunBuffer("r1").length, 0);
  assert.equal(isRunDone("r1"), true);
});

test("subscribeRuns fans out live events and unsubscribes cleanly", () => {
  registerRun("r1");
  const seen = [];
  const unsub = subscribeRuns((runId, ev) => seen.push([runId, ev.type]));
  publish("r1", { type: "tool", name: "Bash" });
  assert.deepEqual(seen, [["r1", "tool"]]);
  unsub();
  publish("r1", { type: "text", text: "after" });
  assert.equal(seen.length, 1);
  // the buffer still got it (replay source), and a throwing subscriber must not break others
  assert.equal(getRunBuffer("r1").length, 2);
});

test("a throwing subscriber does not break the fan-out to others", () => {
  registerRun("r1");
  const seen = [];
  subscribeRuns(() => { throw new Error("dead client"); });
  const unsub = subscribeRuns((_id, ev) => seen.push(ev.type));
  publish("r1", { type: "status", label: "ok" });
  assert.deepEqual(seen, ["status"]);
  unsub();
});

test("cancelRun invokes the registered handler and reports unknown runs", () => {
  assert.equal(cancelRun("ghost"), false);
  registerRun("r1");
  assert.equal(cancelRun("r1"), false); // no handler yet
  let called = 0;
  setCancelHandler("r1", () => called++);
  assert.equal(cancelRun("r1"), true);
  assert.equal(called, 1);
});

test("buffer is capped at MAX_EVENTS_PER_RUN (oldest shifted out)", () => {
  registerRun("r1");
  for (let i = 0; i < MAX_EVENTS_PER_RUN + 10; i++) publish("r1", { type: "text", text: String(i) });
  const buf = getRunBuffer("r1");
  assert.equal(buf.length, MAX_EVENTS_PER_RUN);
  assert.equal(buf[0].text, "10"); // the first 10 were shifted
  assert.equal(buf.at(-1).text, String(MAX_EVENTS_PER_RUN + 9));
});

test("completed runs beyond the cap are reaped FIFO; live runs survive", () => {
  // saturate with done runs
  for (let i = 0; i < MAX_RECORDED_RUNS + 5; i++) {
    registerRun(`done-${i}`);
    completeRun(`done-${i}`);
  }
  assert.ok(listRunIds().length <= MAX_RECORDED_RUNS);
  // a live run registered before the flood is never reaped
  registerRun("live");
  for (let i = 0; i < MAX_RECORDED_RUNS + 5; i++) {
    registerRun(`more-${i}`);
    completeRun(`more-${i}`);
  }
  assert.equal(listRunIds().includes("live"), true);
});

test("getRunBuffer returns a copy — mutating it cannot corrupt the bus", () => {
  registerRun("r1");
  publish("r1", { type: "text", text: "keep" });
  getRunBuffer("r1").length = 0;
  assert.equal(getRunBuffer("r1").length, 1);
});

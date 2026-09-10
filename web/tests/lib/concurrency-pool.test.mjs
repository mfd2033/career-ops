// Global concurrency pool: single-acquire, FIFO queue ordering, queued-cancel,
// and live size re-reading (ADR-0014 Q1-Q5, Q8).
//
// The pool is intentionally decoupled from app-config (no @/ alias) so it is
// importable directly here; tests drive its size via the __setPoolSizeForTest
// hook so config isn't needed.
//
// Run:  node --test tests/lib/concurrency-pool.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquire,
  release,
  cancel,
  listPool,
  __setPoolSizeForTest,
  __resetPoolForTest,
} from "../../src/lib/core/concurrency-pool.ts";

const meta = (url) => ({ url, title: url, source: "run" });

test.beforeEach(() => __resetPoolForTest());

test("with a full initial pool, later tasks stay queued with increasing positions", async () => {
  __setPoolSizeForTest(2);
  const a = acquire(meta("a"));
  const b = acquire(meta("b"));
  const c = acquire(meta("c"));
  assert.equal(await a.ready, true, "first slot granted immediately");
  assert.equal(await b.ready, true, "second slot granted immediately");
  assert.equal(listPool().running.length, 2);
  assert.equal(listPool().queued.length, 1);
  assert.equal(listPool().queued[0].url, "c");
  assert.equal(listPool().queued[0].position, 1, "newest is 1st in line by itself");
  // c is still waiting — its ready is not yet settled.
  let cSettled = false;
  void c.ready.then(() => (cSettled = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cSettled, false, "queued task must NOT be reported ready while waiting");
});

test("releasing a slot re-dispatches the FIFO head and shifts remaining positions", async () => {
  __setPoolSizeForTest(1);
  const a = acquire(meta("a"));
  const b = acquire(meta("b"));
  const c = acquire(meta("c"));
  assert.equal(await a.ready, true);
  assert.equal(listPool().queued.map((q) => q.url).join(","), "b,c");

  release(a.id);
  await b.ready; // head of line b takes the freed slot
  assert.equal(listPool().running.map((r) => r.url).join(","), "b");
  assert.equal(listPool().queued.map((q) => q.url).join(","), "c");
  assert.equal(listPool().queued[0].position, 1);
});

test("cancel() dequeues a queued task (ready resolves false, it never runs)", async () => {
  __setPoolSizeForTest(1);
  const a = acquire(meta("a"));
  const doomed = acquire(meta("doomed"));
  assert.equal(await a.ready, true);
  const r = cancel(doomed.id);
  assert.deepEqual(r, { removed: true, wasRunning: false });
  assert.equal(await doomed.ready, false, "dequeued task reports not-granted");
  assert.equal(listPool().queued.length, 0, "dequeued task leaves the queue");
  // The slot for the cancelled task is never consumed; the pool size is unchanged.
  assert.equal(listPool().running.length, 1);
});

test("handle.cancel() (used by a client disconnect) also dequeues cleanly", async () => {
  __setPoolSizeForTest(1);
  const a = acquire(meta("a"));
  const doomed = acquire(meta("doomed"));
  assert.equal(await a.ready, true);
  doomed.cancel();
  assert.equal(await doomed.ready, false);
  assert.equal(listPool().queued.length, 0);
});

test("a running task's cancel only marks it — it stays in the running set (route owns termination)", async () => {
  __setPoolSizeForTest(1);
  const a = acquire(meta("a"));
  assert.equal(await a.ready, true);
  a.cancel(); // running + marked, slot not freed by the pool alone
  assert.equal(listPool().running.length, 1);
  release(a.id); // route frees after terminating the child
  assert.equal(listPool().running.length, 0);
});

test("resizing the pool live re-admits queued tasks on the next dispatch", async () => {
  __setPoolSizeForTest(1);
  const a = acquire(meta("a"));
  const b = acquire(meta("b"));
  assert.equal(await a.ready, true);
  assert.equal(listPool().queued.length, 1);

  __setPoolSizeForTest(2); // config-page save; no restart
  release(a.id); // any release re-runs dispatch and sees the new size
  assert.equal(await b.ready, true, "enlarged pool admits the queued head");
  assert.equal(listPool().queued.length, 0);
});

test("acquire is granted immediately when the pool has free slots", async () => {
  __setPoolSizeForTest(3);
  const h = acquire(meta("x"));
  assert.equal(await h.ready, true);
  assert.equal(h.isRunning(), true);
  assert.equal(listPool().running.length, 1);
});
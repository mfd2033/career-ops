// In-process worker-event bus — the single channel every /api/run worker's
// events flow through (ADR-0020).
//
// Why it exists: the old /api/run transport held ONE long-lived streaming HTTP
// response per task (running OR queued — the route returned its stream before
// the pool granted a slot). Each task therefore pinned one of the browser's 6
// sockets per HTTP/1.1 host, so ~6 concurrent tasks starved every NEW same-
// origin request and the whole dashboard felt dead ("点击没有反应"). Now the
// POST returns {runId} immediately and every worker publishes its events here;
// /api/events multiplexes ALL runs onto ONE held connection per tab.
//
// Same single-process reasoning as run-registry.ts / concurrency-pool.ts: the
// web server is one local Node process and every spawner imports this module,
// so a shared in-memory bus is the whole point.
//
// API surface:
//   registerRun(id)            create the run's record (call BEFORE returning
//                              {runId} to the client, so nothing is lost).
//   setCancelHandler(id, fn)   the owning route registers how this run is
//                              cancelled (terminate child / dequeue pool /
//                              release tokens). Replaces the old stream-
//                              disconnect cancel(): there IS no held stream
//                              to disconnect from anymore, so /api/run/cancel
//                              is now the only cancel path.
//   publish(id, ev)            buffer + fan out one event. A monotonic `seq`
//                              is stamped onto each event so a client that
//                              replays the buffer after a reconnect can drop
//                              already-seen events (no duplicated steps).
//   completeRun(id)            terminal marker; buffer is RETAINED for late
//                              subscribers / reconnect replay.
//   cancelRun(id) -> bool      invoke the registered cancel handler.
//   subscribeRuns(fn)          live fan-out for /api/events; returns unsubscribe.
//   getRunBuffer(id)           replay copy (each event object carries its seq).
//   listRunIds()               ids of all recorded (live or retained) runs.
//
// Retention: completed runs' buffers are kept for reconnect replay and reaped
// FIFO past MAX_RECORDED_RUNS; a run's buffer is capped at MAX_EVENTS_PER_RUN
// (long agent runs emit text deltas — the tail is what a reconnecting client
// needs, plus its own lastSeq dedup makes partial replay harmless).

export type RunEvent = { type: string; seq?: number; [key: string]: unknown };

type RunRecord = {
  id: string;
  buffer: RunEvent[];
  subscribers: Set<(runId: string, ev: RunEvent) => void>;
  done: boolean;
  seq: number;
  cancel: (() => void) | null;
};

const runs = new Map<string, RunRecord>();

export const MAX_RECORDED_RUNS = 50;
export const MAX_EVENTS_PER_RUN = 500;

function record(id: string): RunRecord | undefined {
  return runs.get(id);
}

/** Create a run's record. Must happen before the client learns the runId. */
export function registerRun(id: string): void {
  if (record(id)) return;
  runs.set(id, { id, buffer: [], subscribers: new Set(), done: false, seq: 0, cancel: null });
  reapIfOverCap();
}

/** Oldest DONE runs beyond the cap are reaped; live runs are never reaped. */
function reapIfOverCap(): void {
  if (runs.size <= MAX_RECORDED_RUNS) return;
  for (const [id, r] of runs) {
    if (runs.size <= MAX_RECORDED_RUNS) break;
    if (r.done) runs.delete(id);
  }
}

/** The owning route registers how this run terminates on cancel. */
export function setCancelHandler(id: string, fn: () => void): void {
  const r = record(id);
  if (r) r.cancel = fn;
}

/** Buffer + fan out one worker event, stamped with the run's next seq. */
export function publish(id: string, ev: Omit<RunEvent, "seq">): void {
  const r = record(id);
  if (!r || r.done) return;
  const stamped = { ...ev, seq: ++r.seq } as RunEvent;
  r.buffer.push(stamped);
  if (r.buffer.length > MAX_EVENTS_PER_RUN) r.buffer.shift();
  for (const fn of r.subscribers) {
    try {
      fn(id, stamped);
    } catch {
      /* a dead subscriber must not break the fan-out */
    }
  }
}

/** Terminal marker. The buffer is retained for late subscribers / reconnect. */
export function completeRun(id: string): void {
  const r = record(id);
  if (!r) return;
  r.done = true;
  reapIfOverCap();
}

/** Invoke the owning route's cancel handler. True if a handler ran. */
export function cancelRun(id: string): boolean {
  const r = record(id);
  if (!r || !r.cancel) return false;
  try {
    r.cancel();
  } catch {
    /* best-effort, like the old terminateCli */
  }
  return true;
}

/** Replay copy for /api/events' connect phase and reconnects. */
export function getRunBuffer(id: string): RunEvent[] {
  return record(id)?.buffer.slice() ?? [];
}

export function isRunDone(id: string): boolean {
  return record(id)?.done ?? false;
}

/** Live fan-out for the /api/events channel. Returns an unsubscribe fn. */
export function subscribeRuns(fn: (runId: string, ev: RunEvent) => void): () => void {
  for (const r of runs.values()) r.subscribers.add(fn);
  return () => {
    for (const r of runs.values()) r.subscribers.delete(fn);
  };
}

export function listRunIds(): string[] {
  return [...runs.keys()];
}

// --- test hooks (unit tests only; not part of the runtime surface) ----------

export function __resetRunEventsForTest(): void {
  runs.clear();
}

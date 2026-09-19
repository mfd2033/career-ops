// Global CLI-concurrency pool — the ONE number that caps how many heavy agent
// CLI sub-processes run at once across every entry (web single-run, web batch,
// and the BOSS直聘 extension, all of which live in this same Node process).
//
// Why it exists: before this, /api/run spawned one CLI per request with no cap
// and /api/batch-evaluate capped each batch at MAX_PARALLEL=3 but not across
// batches — fire N batches from the frontend and N×3 claude/openCode processes
// chew through the machine. ADR-0014 decides the unit of scheduling is ONE CLI
// (per worker, not per batch) and the pool reads its size from app-config with
// a default of 4, re-reading it on every dispatch so a config-page change takes
// effect without restart.
//
// The pool is module-level state, the same single-process reasoning as
// run-registry.ts / active-runs.ts: the web server is one local Node process
// and every spawner imports this module, so a shared in-memory scheduler is
// the whole point — a cross-process coordinator would be a different feature.
//
// API surface:
//   acquire(meta) -> handle    queue the task, resolve handle.ready when a slot
//                              is granted (true) or the task is cancelled while
//                              still queued (false). Never blocks the spinner.
//   release(id)                free a slot after the CLI settles (re-dispatch).
//   cancel(id)                 dequeue a QUEUED task (no child to kill yet); for
//                              a RUNNING task it only marks it — the owning route
//                              keeps owning tree-termination of its child.
//   list()                     {running, queued} snapshot for /api/active-runs.
// Ticket: .scratch/concurrency-pool/issues/01-global-pool-core.md / ADR-0014.
//
// Size source: the pool is deliberately decoupled from app-config so it stays
// importable by `node --test` (no `@/` alias). The run/batch routes (which DO
// import app-config) register a live getter via __setSizeSource; absent that,
// it falls back to DEFAULT_POOL_SIZE.

export const DEFAULT_POOL_SIZE = 4;

// Registered by the transport routes so the pool re-reads the configured size on
// EVERY dispatch (a config-page change takes effect without restart, ADR-0014 Q3).
let sizeSource: () => number = () => DEFAULT_POOL_SIZE;
export function __setSizeSource(fn: () => number): void {
  if (typeof fn === "function") sizeSource = fn;
}

export type PoolSource = "run" | "batch";
export type PoolTaskMeta = {
  url: string;
  title: string;
  reportNum?: number;
  source: PoolSource;
  // ADR-0043 运行引擎: the CLI runtime + model requested at dispatch. Carried
  // into the /api/active-runs snapshot because an extension-dispatched worker
  // has NO other channel onto the worker list — without these it would read as
  // 「未记录」 on a task that was in fact dispatched with a known engine.
  // Display-only facts: the pool never inspects them, it just holds them.
  cliId?: string;
  model?: string;
};

export type PoolHandle = {
  id: string;
  /** true when the task has been granted an execution slot; false when dequeued. */
  ready: Promise<boolean>;
  isRunning: () => boolean;
  cancel: () => void;
};

type Entry = {
  id: string;
  url: string;
  title: string;
  reportNum?: number;
  source: PoolSource;
  cliId?: string;
  model?: string;
  enqueuedAt: number;
  running: boolean;
  cancelled: boolean;
  resolveReady: (granted: boolean) => void;
};

let seq = 0;
const queue: Entry[] = [];
const running: Entry[] = [];

/** Pool size — re-read on EVERY dispatch so config-page edits apply live. */
function currentPoolSize(): number {
  if (_testSize != null) return _testSize;
  return sizeSource();
}

let _testSize: number | null = null;

/** Grant slots while room remains; FIFO order for the queue. */
function dispatch(): void {
  while (queue.length > 0 && running.length < currentPoolSize()) {
    const entry = queue.shift()!;
    running.push(entry);
    entry.running = true;
    entry.resolveReady(true);
  }
}

export function acquire(meta: PoolTaskMeta): PoolHandle {
  const id = `pool-${++seq}`;
  let resolveReady!: (granted: boolean) => void;
  const ready = new Promise<boolean>((res) => {
    resolveReady = res;
  });
  const entry: Entry = {
    id,
    url: meta.url,
    title: meta.title,
    reportNum: meta.reportNum,
    source: meta.source,
    cliId: meta.cliId,
    model: meta.model,
    enqueuedAt: Date.now(),
    running: false,
    cancelled: false,
    resolveReady,
  };
  queue.push(entry);
  dispatch();
  return {
    id,
    ready,
    isRunning: () => entry.running,
    cancel: () => {
      if (entry.cancelled) return;
      const qi = queue.findIndex((e) => e.id === id);
      if (qi !== -1) {
        // Still queued (no child spawned) — remove it and let the awaiting route
        // abort without spawning. This is the "dequeue" path of ADR-0014 Q5.
        entry.cancelled = true;
        queue.splice(qi, 1);
        resolveReady(false);
        return;
      }
      // Running — dequeue can't touch it. Mark for the owner (it terminates its
      // own child and frees the slot via release()); the //comment above never
      // leaves, so callers must not rely on this marking alone to stop it.
      if (running.some((e) => e.id === id)) {
        entry.cancelled = true;
      }
    },
  };
}

/** Free a slot after a task settles; re-dispatch waiting tasks. */
export function release(id: string): void {
  const idx = running.findIndex((e) => e.id === id);
  if (idx === -1) return;
  running.splice(idx, 1);
  dispatch();
}

/** Dequeue a queued task by id (no-op for running/unknown). Returns the outcome. */
export function cancel(id: string): { removed: boolean; wasRunning: boolean } {
  const qi = queue.findIndex((e) => e.id === id);
  if (qi !== -1) {
    const entry = queue[qi];
    entry.cancelled = true;
    queue.splice(qi, 1);
    entry.resolveReady(false);
    return { removed: true, wasRunning: false };
  }
  if (running.some((e) => e.id === id)) return { removed: false, wasRunning: true };
  return { removed: false, wasRunning: false };
}

export type PoolRunningTask = {
  id: string;
  url: string;
  title: string;
  reportNum?: number;
  source: PoolSource;
  cliId?: string;
  model?: string;
  startedAt: number;
};
export type PoolQueuedTask = {
  id: string;
  url: string;
  title: string;
  reportNum?: number;
  source: PoolSource;
  cliId?: string;
  model?: string;
  enqueuedAt: number;
  position: number; // 1-based slot in the FIFO queue
};

/** Snapshot for /api/active-runs. */
export function listPool(): { running: PoolRunningTask[]; queued: PoolQueuedTask[] } {
  return {
    running: running.map((e) => ({
      id: e.id,
      url: e.url,
      title: e.title,
      reportNum: e.reportNum,
      source: e.source,
      cliId: e.cliId,
      model: e.model,
      startedAt: e.enqueuedAt,
    })),
    queued: queue.map((e, i) => ({
      id: e.id,
      url: e.url,
      title: e.title,
      reportNum: e.reportNum,
      source: e.source,
      cliId: e.cliId,
      model: e.model,
      enqueuedAt: e.enqueuedAt,
      position: i + 1,
    })),
  };
}

// --- test hooks (unit tests only; not part of the runtime surface) ----------

export function __setPoolSizeForTest(n: number | null): void {
  _testSize = n;
}
export function __resetPoolForTest(): void {
  __setPoolSizeForTest(null);
  queue.length = 0;
  running.length = 0;
}
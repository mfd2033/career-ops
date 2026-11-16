import {
  subscribeRuns,
  getRunBuffer,
  listRunIds,
  type RunEvent,
} from "@/lib/core/run-events";
import {
  dataChangeFrame,
  subscribeDataChanges,
} from "@/lib/data-events.mjs";

// GET /api/events — the ONE multiplexed worker-event channel (ADR-0020).
//
// NDJSON frames `{runId, ev}` for every in-flight run (buffer replay first, so
// a reconnecting or late-arriving client catches up; event `seq` lets clients
// dedup), then live frames as workers publish them. The tab's job-store holds
// this ONE connection for ALL workers — before ADR-0020 every task held its
// own streaming response, and ~6 concurrent tasks exhausted the browser's 6
// sockets per HTTP/1.1 host, freezing every click on the page.
//
// Same-origin/loopback only, like the other local APIs. Completed runs' buffers
// are retained briefly (see run-events.ts retention) so a refresh still renders
// the tail of a just-finished worker.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (frame: { runId?: string; type?: string; [key: string]: unknown }) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(JSON.stringify(frame) + "\n"));
        } catch {
          // client gone — cleanup happens via the abort listener
          cleanup();
        }
      };

      // Catch-up: replay every recorded run's buffer, then subscribe live.
      for (const runId of listRunIds()) {
        for (const ev of getRunBuffer(runId)) send({ runId, ev });
      }
      const unsub = subscribeRuns((runId: string, ev: RunEvent) => send({ runId, ev }));
      // 用户层数据变更（ADR-0101）：一条成功的 tracker 写入 → 所有打开页面的标签页
      // 各自 router.refresh()。与 keepalive 同级——**不带 runId**，所以不认识它的旧
      // 客户端会按「无 runId 的帧」忽略，既有线协议不变。
      const unsubData = subscribeDataChanges((change) => send(dataChangeFrame(change.scope)));
      // Channel-level keepalive: the frame stream is quiet whenever no worker
      // is emitting, and a proxy/browser must not drop the (single) channel.
      const heartbeat = setInterval(() => send({ type: "keepalive" }), 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsub();
        unsubData();
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

import { NextRequest } from "next/server";
import fs from "node:fs";
import { runDiscovery } from "@/lib/core/scan";
import { rootScript } from "@/lib/career-ops";
import { parseExplorePatch, DEFAULT_FILTERS, type DiscoveredOffer, type ScanEvent } from "@/lib/explore";
import { scannerMissingBody, browserCollectorMissingBody, SCANNER_MISSING_STATUS } from "@/lib/explore-error.mjs";

// Discovery is HTTP-bound across many ATS boards; give it room. It is FREE —
// zero LLM tokens (the scanner only does HTTP + JSON, and --dry-run writes nothing).
// The browser mode can take longer still (a real browser walk per platform).
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty body → defaults */
  }

  const mode = String(body.mode ?? "scan").toLowerCase() === "browser" ? "browser" : "scan";
  const filters = parseExplorePatch(body, DEFAULT_FILTERS);

  // Capability gates — each mode needs its OWN machinery, and each fails with its
  // OWN structured code on the shared 400 channel (never the bare status, never
  // the other mode's message — see explore-error.mjs):
  //   • scan    → scan-ats-full.mjs (data-only / pre-onboarding checkout)
  //   • browser → zh-collect.mjs + local Playwright + system Edge (the independent
  //               job-seeking profile the collector drives)
  // The browser gate is deliberately independent of the scanner gate: a checkout
  // that has no scan-ats-full can still run a browser hunt.
  if (mode === "browser") {
    const { browserCollectorReady } = await import("@/lib/core/browser-scan");
    if (!browserCollectorReady()) {
      return Response.json(browserCollectorMissingBody(), { status: SCANNER_MISSING_STATUS });
    }
  } else if (!fs.existsSync(rootScript("scan-ats-full"))) {
    return Response.json(scannerMissingBody(), { status: SCANNER_MISSING_STATUS });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          /* stream closed */
        }
      };
      const atsList = mode === "browser" ? (filters.browserSources as string[]) : filters.ats;
      send({ kind: "start", ats: atsList, sinceDays: filters.sinceDays, limit: filters.limitPerAts, free: true } satisfies ScanEvent);
      let offers: DiscoveredOffer[] = [];
      try {
        if (mode === "browser") {
          const { runBrowserDiscovery } = await import("@/lib/core/browser-scan");
          offers = await runBrowserDiscovery(filters, (e: ScanEvent) => send(e));
        } else {
          offers = await runDiscovery(filters, (e: ScanEvent) => send(e));
        }
      } catch (err) {
        send({ kind: "error", message: err instanceof Error ? err.message : "discovery failed" } satisfies ScanEvent);
      }
      send({ kind: "done", count: offers.length, offers, cost: { tokens: 0, usd: 0 } } satisfies ScanEvent);
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

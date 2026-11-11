// POST /api/pipeline/remove — Batch-delete URLs from pipeline.md Pending section.
//
// Executes remove-from-pipeline.mjs (the lock-aware root script) via execFile,
// one URL per --url flag. The script returns JSON to stdout:
//   { "removed": N, "notFound": M }
//
// Runtime: Node.js — needs execFile + filesystem access.
// Concurrency: remove-from-pipeline.mjs acquires pipeline-lock itself, so two
// concurrent deletes are serialized safely alongside scan / reconcile.

import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { careerOpsRoot } from "@/lib/career-ops";
import { logOperation } from "@/lib/op-log-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read/write fresh pipeline.md

const execFileAsync = promisify(execFile);
const MAX_URLS = 100; // one pipeline.md Pending section is never bigger than this

export async function POST(req: Request) {
  let body: { urls?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((u): u is string => typeof u === "string" && /^https?:\/\//i.test(u.trim())).map((u) => u.trim())
    : [];
  if (urls.length === 0) {
    return Response.json({ error: "at least one http(s) URL required" }, { status: 400 });
  }
  if (urls.length > MAX_URLS) {
    return Response.json({ error: `too many URLs (max ${MAX_URLS})` }, { status: 400 });
  }

  const root = careerOpsRoot();
  const script = path.join(root, "remove-from-pipeline.mjs");
  const args = urls.flatMap((u) => ["--url", u]);

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      cwd: root,
      timeout: 15_000,
      maxBuffer: 256 * 1024,
    });
    if (stderr) {
      // Script already reported result to stdout; stderr warnings don't change
      // the outcome, but we should bubble them so the caller sees non-fatal issues.
      console.warn("[pipeline/remove] stderr:", stderr.trim());
    }
    const parsed = JSON.parse(stdout.trim() || "{\"removed\":0,\"notFound\":0}");
    const removed = Number(parsed.removed) || 0;
    const notFound = Number(parsed.notFound) || 0;
    // 操作日志：移出管道只是把行删掉，没有别的痕迹——不记就真的查不到。
    if (removed > 0) {
      logOperation({
        trigger: "manual",
        type: "pipeline-remove",
        meta: [
          { k: "removed", v: String(removed) },
          ...(notFound > 0 ? [{ k: "not-found", v: String(notFound) }] : []),
        ],
        status: "done",
      });
    }
    return Response.json({ removed, notFound });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}

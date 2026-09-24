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
    return Response.json({ removed: Number(parsed.removed) || 0, notFound: Number(parsed.notFound) || 0 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}

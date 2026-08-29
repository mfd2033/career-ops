import { NextRequest } from "next/server";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveLatestCvPdf } from "@/lib/cv-pdf-resolve.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reveal the tailored CV PDF in the OS file manager, selecting the file:
// `explorer /select,"path"` on Windows, `open -R` on macOS, and a plain
// xdg-open of the directory on Linux (no native "select this file" exists).
// POST-only: spawning a process is a side effect, and GET would let browsers
// prefetch/cache it. Path resolution is shared with /api/cv-pdf via
// resolveLatestCvPdf so both stay in sync.
export async function POST(req: NextRequest) {
  let body: { company?: unknown } | null = null;
  try {
    body = await req.json().catch(() => null);
  } catch {
    body = null;
  }
  const company =
    (typeof body?.company === "string" ? body.company : req.nextUrl.searchParams.get("company") ?? "").trim();
  if (!company) return Response.json({ ok: false, error: "company required" }, { status: 400 });

  const result = resolveLatestCvPdf(company, careerOpsRoot());
  if (!result.ok) return Response.json({ ok: false, error: result.error }, { status: 404 });
  // The file may have vanished between readdir and the spawn — fail closed
  // rather than letting explorer silently open the parent directory.
  if (!fs.existsSync(result.path)) {
    return Response.json({ ok: false, error: "no tailored CV found for this offer" }, { status: 404 });
  }

  // Fire-and-forget: explorer/open hand off to the running shell and the exit
  // code is meaningless (explorer famously returns non-zero even on success),
  // so we spawn detached and never await it. The HTTP response is about the
  // spawn itself, not the shell's eventual state.
  try {
    if (process.platform === "win32") {
      spawn("explorer", ["/select," + result.path], { detached: true, stdio: "ignore" })
        .on("error", () => {})
        .unref();
    } else if (process.platform === "darwin") {
      spawn("open", ["-R", result.path], { detached: true, stdio: "ignore" })
        .on("error", () => {})
        .unref();
    } else {
      spawn("xdg-open", [path.dirname(result.path)], { detached: true, stdio: "ignore" })
        .on("error", () => {})
        .unref();
    }
    return Response.json({ ok: true, path: result.path });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: `failed to open file manager: ${msg}` }, { status: 500 });
  }
}
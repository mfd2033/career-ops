// GET /api/checkup-report?n=<tracker#> — serves the company-checkup HTML
// report for one tracker row (ADR-0026 决议 3: the detail page shows the HTML
// link; the file lives in the gitignored user layer, so it needs a local
// route rather than a static path). The ledger's html path is validated at
// WRITE time by lib/log-checkup.mjs; this route re-checks the
// `reports/checkups/` prefix + root containment before reading anyway — the
// reader must not trust the ledger blindly.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readCheckupFor } from "@/lib/career-ops";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const n = new URL(req.url).searchParams.get("n") ?? "";
  if (!/^\d+$/.test(n)) {
    return Response.json({ error: "a numeric application number is required" }, { status: 400 });
  }
  const checkup = readCheckupFor(n);
  if (!checkup || !checkup.html || checkup.html === "-") {
    return Response.json({ error: "no checkup report for this row" }, { status: 404 });
  }
  if (!checkup.html.startsWith("reports/checkups/")) {
    return Response.json({ error: "bad report path" }, { status: 400 });
  }
  const root = careerOpsRoot();
  const file = path.join(root, ...checkup.html.split("/"));
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return Response.json({ error: "bad report path" }, { status: 400 });
  }
  try {
    const html = fs.readFileSync(file, "utf8");
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "checkup report file is missing" }, { status: 404 });
  }
}

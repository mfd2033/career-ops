// GET /api/checkup-report?n=<tracker#> — serves the company-checkup HTML
// report for one tracker row (ADR-0026 决议 3: the detail page shows the HTML
// link; the file lives in the gitignored user layer, so it needs a local
// route rather than a static path). The ledger's html path is validated at
// WRITE time by lib/log-checkup.mjs; this route re-checks the
// `reports/checkups/` prefix + root containment before reading anyway — the
// reader must not trust the ledger blindly.
//
// HEAD answers the SAME question without a body: the worker card's entry only
// renders when the report really exists (web/DESIGN「不渲染无法生效的按钮」),
// and the card cannot read the gitignored ledger on the client. One route, one
// set of validation rules — HEAD never invents a second existence check.
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readCheckupFor } from "@/lib/career-ops";

export const runtime = "nodejs";

type Resolved = { status: number; error?: string; file?: string };

function resolveCheckupFile(n: string): Resolved {
  if (!/^\d+$/.test(n)) {
    return { status: 400, error: "a numeric application number is required" };
  }
  const checkup = readCheckupFor(n);
  if (!checkup || !checkup.html || checkup.html === "-") {
    return { status: 404, error: "no checkup report for this row" };
  }
  if (!checkup.html.startsWith("reports/checkups/")) {
    return { status: 400, error: "bad report path" };
  }
  const root = careerOpsRoot();
  const file = path.join(root, ...checkup.html.split("/"));
  const rel = path.relative(root, file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { status: 400, error: "bad report path" };
  }
  return { status: 200, file };
}

const trackerNumParam = (req: Request) => new URL(req.url).searchParams.get("n") ?? "";

export async function GET(req: Request) {
  const resolved = resolveCheckupFile(trackerNumParam(req));
  if (resolved.status !== 200) {
    return Response.json({ error: resolved.error }, { status: resolved.status });
  }
  try {
    const html = fs.readFileSync(resolved.file!, "utf8");
    return new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "checkup report file is missing" }, { status: 404 });
  }
}

export async function HEAD(req: Request) {
  const resolved = resolveCheckupFile(trackerNumParam(req));
  if (resolved.status !== 200) {
    return new Response(null, { status: resolved.status, headers: { "cache-control": "no-store" } });
  }
  try {
    await fs.promises.access(resolved.file!, fs.constants.R_OK);
  } catch {
    return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}
import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveCvPdf } from "@/lib/cv-pdf-resolve.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serve the tailored CV PDF for an offer. Prefer `?report={n}` — the exact
// report-number link recorded in data/pdf-index.tsv, which resolves correctly
// for Chinese company names and re-evaluated rows. `?company={name}` is the
// legacy newest-match fallback. Inline so it opens in the browser. Local-first:
// reads the user's own output/ dir. Resolution is shared with /api/cv-pdf/open
// via resolveCvPdf so both stay in sync.
export async function GET(req: NextRequest) {
  const report = (req.nextUrl.searchParams.get("report") ?? "").trim();
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  if (!report && !company) return new Response("report or company required", { status: 400 });

  const result = resolveCvPdf({ report, company }, careerOpsRoot());
  if (!result.ok) return new Response(result.error, { status: 404 });

  try {
    const buf = fs.readFileSync(result.path);
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${path.basename(result.path)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return new Response("could not read the PDF", { status: 500 });
  }
}
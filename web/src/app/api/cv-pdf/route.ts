import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { resolveLatestCvPdf } from "@/lib/cv-pdf-resolve.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Serve the tailored CV PDF the pdf mode wrote to output/cv-…-{company}-…pdf for
// a given offer (matched by company slug, newest first). Inline so it opens in
// the browser. Local-first: reads the user's own output/ dir. Path resolution is
// shared with /api/cv-pdf/open via resolveLatestCvPdf so both stay in sync.
export async function GET(req: NextRequest) {
  const company = (req.nextUrl.searchParams.get("company") ?? "").trim();
  if (!company) return new Response("company required", { status: 400 });

  const result = resolveLatestCvPdf(company, careerOpsRoot());
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
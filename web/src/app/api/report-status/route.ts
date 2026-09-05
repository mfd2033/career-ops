import { readApplications, readApplicationUrl } from "@/lib/career-ops";
import { normalizeUrl } from "@/lib/core/url-key.mjs";

// Evaluated-position status for the BOSS直聘 extension. On load the extension
// fetches this once and builds its local Set of "already evaluated" badges.
//
// Returns the durable evaluated map over every tracker application that
// resolves to a real posting URL: key = normalizeUrl(URL) — the SAME canonical
// key the explore/inbox pages use, so a posting the extension sees is never
// mislabelled "unevaluated" (and one evaluated elsewhere is never missed).
//   { normalizedUrl: { score: string, reportNum: string } }
// `reportNum` is the tracker application number `n`, also the /report/{n} route.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const out: Record<string, { score: string; reportNum: string }> = {};
  // First application wins per URL — the tracker lists each posting once; a
  // duplicate row should not overwrite the earlier evaluation.
  for (const app of readApplications()) {
    const url = readApplicationUrl(app);
    if (!url) continue;
    const key = normalizeUrl(url);
    if (!key || key in out) continue;
    out[key] = { score: app.score, reportNum: app.n };
  }
  return Response.json(out);
}
import { readApplications, readApplicationUrl, withCheckupStars } from "@/lib/career-ops";
import { buildReportStatusMap } from "@/lib/report-status-map.mjs";
import { normalizeUrl } from "@/lib/core/url-key.mjs";

// Evaluated-position status for the BOSS直聘 extension. On load the extension
// fetches this once and builds its local Set of "already evaluated" badges.
//
// Returns the durable evaluated map over every tracker application that
// resolves to a real posting URL: key = normalizeUrl(URL) — the SAME canonical
// key the explore/inbox pages use, so a posting the extension sees is never
// mislabelled "unevaluated" (and one evaluated elsewhere is never missed).
//   { normalizedUrl: { score: string, reportNum: string, status?: string, checkupStar: number|null } }
// `reportNum` is the tracker application number `n`, also the /report/{n} route.
// `status` (ADR-0074) is the tracker row's RAW canonical state code (`Applied`,
// `SKIP`, … — templates/states.yml): the API carries no display language, the
// extension maps it to a Chinese label + lifecycle colour in its own dictionary.
// `checkupStar` (ADR-0074) is that row's latest company-checkup star, joined with
// the SAME `withCheckupStars` the pipeline list uses (one “latest” definition, no
// drift): display-only, never a scoring/filter/gate input (ADR-0064). null = 未体检.
// Assembly rules (first-app-wins, key normalisation) live in the pure
// report-status-map.mjs so they can be tested without a route.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    buildReportStatusMap(withCheckupStars(readApplications()), { urlOf: readApplicationUrl, normalizeUrl })
  );
}
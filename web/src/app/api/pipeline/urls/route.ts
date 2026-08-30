import { readApplications, readApplicationUrls } from "@/lib/career-ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always read fresh report headers

// Batch re-evaluate support: returns the posting URL for every tracker row
// whose report has a re-evaluatable `**URL:**` (absolute http(s)) header. The
// pipeline view fetches this ONCE when the user engages batch selection, then
// fires one `kind:"evaluate"` job per entry client-side — no tokens spent
// here, this is a plain FS read of report headers (the same header
// parseReport already extracts for the single-row ReevaluateButton).
//
// Returns { [n]: url } covering ONLY re-evaluatable rows; a row without a
// report URL is absent so the client can surface "N of M re-evaluatable".
export async function GET() {
  const apps = readApplications();
  return Response.json(readApplicationUrls(apps));
}

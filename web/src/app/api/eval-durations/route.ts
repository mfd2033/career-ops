import { readEvalTimings } from "@/lib/career-ops";

// 评估用时 map for the worker surfaces (worker cards, /jobs list, /jobs/[id]
// timeline) — keyed by report number. Server-side the pipeline page reads the
// same map directly via readEvalTimings(); this route exists because the jobs
// pages are client components and their job records carry no report number
// until /api/report-status resolves the posting URL (ADR-0016).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(readEvalTimings());
}

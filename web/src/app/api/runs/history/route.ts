import path from "node:path";
import { readRunHistory } from "@/lib/run-ledger.mjs";
import { careerOpsRoot, reportsIndexOf } from "@/lib/career-ops";
import { createLabelForNum, enrichEvaluateTitles } from "@/lib/run-titles.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs/history — server-side ledger of TERMINATED runs (newest first).
// The /jobs history page merges this with the browser's localStorage cards so
// runs dispatched outside the UI (API, script) are visible too. Tolerant: a
// missing/corrupt ledger yields an empty list, never an error page.
//
// 「公司 · 岗位」补齐（run-titles.mjs）：扩展/CLI 发起的单次评估，台账标题只有
// `evaluate <url>`，而报告 Machine Summary 里有公司与岗位。读取端据此改写标题，
// 台账本身不动。索引每个请求重建一次（新报告立刻可见），标签解析结果进程内缓存。
export async function GET() {
  const root = careerOpsRoot();
  const labelForNum = createLabelForNum({ index: reportsIndexOf(), reportsDir: path.join(root, "reports") });
  return Response.json({ runs: enrichEvaluateTitles(readRunHistory(root, 200), labelForNum) });
}

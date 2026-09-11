import { Suspense } from "react";
import { pipelineSummary, readEvalTimings } from "@/lib/career-ops";
import { PipelineView } from "@/components/pipeline-view";

export const dynamic = "force-dynamic"; // always read fresh local files

export default function PipelinePage() {
  const { inbox, applications, scoredUrls } = pipelineSummary();
  // Join 评估用时 (ADR-0016) onto each row so the 用时 column renders and the
  // shared orderApplications sorts on it — the detail page reconstructs rows
  // from readApplications() (unjoined), but prev/next never display duration.
  const timings = readEvalTimings();
  const joined = applications.map((a) => ({ ...a, evalDuration: timings[a.n]?.duration ?? null }));
  return (
    <Suspense>
      <PipelineView applications={joined} inbox={inbox} scoredUrls={scoredUrls} />
    </Suspense>
  );
}

import { Suspense } from "react";
import { pipelineSummary } from "@/lib/career-ops";
import { PipelineView } from "@/components/pipeline-view";

export const dynamic = "force-dynamic"; // always read fresh local files

export default function PipelinePage() {
  const { inbox, applications, scoredUrls } = pipelineSummary();
  return (
    <Suspense>
      <PipelineView applications={applications} inbox={inbox} scoredUrls={scoredUrls} />
    </Suspense>
  );
}

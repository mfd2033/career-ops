import { notFound } from "next/navigation";
import { readReport, findApplication, trackerCanDelete } from "@/lib/career-ops";
import { ReportView } from "@/components/report-view";

// Deep-link report page for the BOSS直聘 extension: a clicked "已评估" badge
// opens http://localhost:{port}/report/{n}. This is the same ReportView the
// pipeline report route renders, minus the list prev/next context — a direct
// single-report view with no surrounding navigation.

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = findApplication(id);
  const report = readReport(id);
  if (!app && !report) notFound();

  return (
    <ReportView
      id={id}
      app={app}
      report={report?.content ?? null}
      file={report?.file ?? null}
      canDelete={trackerCanDelete()}
      prev={null}
      next={null}
      position={null}
      total={null}
      contextQuery=""
    />
  );
}
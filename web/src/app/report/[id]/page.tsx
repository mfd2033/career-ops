import { notFound } from "next/navigation";
import { readReport, findApplication, trackerCanDelete, findCheckupTarget, readCheckupFor } from "@/lib/career-ops";
import { ReportView } from "@/components/report-view";

// Deep-link report page for the BOSS直聘 extension: a clicked "已评估" badge
// opens http://localhost:{port}/report/{n}. This is the same ReportView the
// pipeline report route renders, minus the list prev/next context — a direct
// single-report view with no surrounding navigation.
//
// 体检按钮（ADR-0032）：本页与 /pipeline/{n} 是同一枚 #[N] 的落点（工作器的
// 报告跳转一律走 /report/{n}，ADR-0018），操作区也已完整——只差体检 props 就
// 会让按钮静默消失。两条路由的 parity 由 web/tests/lib/report-route-parity.test.mjs
// 守住：任何渲染 ReportView 的路由都必须把体检数据传下去。
// 仍刻意不传：评估用时面板（ADR-0032 决议 5，深链页保持极简）。

export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const app = findApplication(id);
  const report = readReport(id);
  if (!app && !report) notFound();

  // 公司体检（ADR-0026/0027）：本行最近一次体检 + 体检对象判定，与
  // /pipeline/{n} 同源调用（判定逻辑不复制到本路由）。
  const checkup = readCheckupFor(id);
  const checkupTarget = findCheckupTarget(id);

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
      checkup={checkup}
      checkupTarget={checkupTarget}
    />
  );
}
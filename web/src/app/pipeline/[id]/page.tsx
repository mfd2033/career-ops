import { notFound } from "next/navigation";
import { readReport, findApplication, readApplications, withReportSalaries, trackerCanDelete, readEvalTimings, findCheckupTarget, readCheckupFor } from "@/lib/career-ops";
import { evalTimingKey } from "@/lib/eval-timing-key.mjs";
import { navNeighbors, buildContextQuery } from "@/lib/pipeline-order.mjs";
import { ReportView } from "@/components/report-view";
import { EvalTimingPanel } from "@/components/eval-timing-panel";

export const dynamic = "force-dynamic";

// URL param → context, mirroring how pipeline-view.tsx parses the SAME params
// (tab/min/sort/dir are the URL's single source of truth; q is the search
// needle the list page serializes into the link). Invalid/absent values fall
// back to the list page's defaults, so prev/next always reproduce that view.
type NavCtx = {
  tab: string;
  min: number | null;
  sortKey: string;
  dir: 1 | -1;
  q: string;
};

function parseContext(searchParams: URLSearchParams): NavCtx {
  const pTab = (searchParams.get("tab") ?? "").toUpperCase();
  const pMin = parseFloat(searchParams.get("min") ?? "");
  const pSort = searchParams.get("sort") ?? "";
  const q = searchParams.get("q") ?? "";
  return {
    tab: pTab || "ALL",
    min: Number.isFinite(pMin) ? pMin : null,
    sortKey: pSort || "score",
    dir: searchParams.get("dir") === "1" ? 1 : -1,
    q,
  };
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    if (typeof v === "string") sp.set(k, v);
  }
  const ctx = parseContext(sp);

  const app = findApplication(id);
  const report = readReport(id);
  if (!app && !report) notFound();

  // Rebuild the list page's ordered view from the carried context and locate
  // this report in it (ADR-0036). navNeighbors owns that: it keeps the context
  // the user is walking when their own status write moved the row out of the
  // tab, counts a duplicated tracker number once, and only stops navigating
  // when the context genuinely has no slot for this row (INBOX / row gone).
  // `context` is the context that took effect — the links below must carry it,
  // not the raw query params, or 下一个 would leave the walked view.
  // 薪资排序下，prev/next 的顺序还取决于每行的「报告薪资」（ADR-0037）：只有这一种
  // 排序键需要这次全量 join，否则详情页每行薪资都是 null，「下一个」会退化成与列表页
  // 完全不同的顺序。其余排序键下薪资不参与顺序，也就不付这份读盘成本。
  const rows = ctx.sortKey === "salary" ? withReportSalaries(readApplications()) : readApplications();
  const { prev, next, position, total, context } = navNeighbors(rows, ctx, id);
  const contextQuery = buildContextQuery(context);
  // 评估用时 breakdown (ADR-0016/0017): latest eval session, straight from
  // data/eval-timings.tsv — no report body required. The join key follows the
  // row's CURRENT report link (a re-evaluation reserves a new number while the
  // row keeps its id), falling back to the id for legacy/unlinked rows — and
  // to the id outright when the row itself is gone (deleted tracker row, live
  // report file), preserving the pre-ADR-0017 behaviour there.
  const timing = readEvalTimings()[app ? evalTimingKey(app) : id] ?? null;
  // 公司体检（ADR-0026）：本行最近一次体检（无记录 → null）+ 体检对象判定
  // （`?` 行 → 招聘主体 Via；不可判定 → 禁用原因码），供操作区按钮渲染。
  const checkup = readCheckupFor(id);
  const checkupTarget = findCheckupTarget(id);

  return (
    <>
      <ReportView
        id={id}
        app={app}
        report={report?.content ?? null}
        file={report?.file ?? null}
        canDelete={trackerCanDelete()}
        prev={prev}
        next={next}
        position={position}
        total={total}
        contextQuery={contextQuery}
        checkup={checkup}
        checkupTarget={checkupTarget}
      />
      <div className="mx-auto max-w-3xl px-6 pb-10">
        <EvalTimingPanel entry={timing} />
      </div>
    </>
  );
}

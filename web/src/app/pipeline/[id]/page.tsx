import { notFound } from "next/navigation";
import { readReport, findApplication, readApplications, trackerCanDelete, readEvalTimings, findCheckupTarget, readCheckupFor } from "@/lib/career-ops";
import { evalTimingKey } from "@/lib/eval-timing-key.mjs";
import { orderApplications, buildContextQuery, DEFAULT_ORDER } from "@/lib/pipeline-order.mjs";
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
  // this report in it. When the id is missing from the ordered list (direct
  // navigation, an expired q, a tab the row no longer matches, or INBOX) we
  // fall back to the default order — ALL rows, score descending — so the
  // prev/next navigation is still meaningful instead of silently vanishing.
  // The `.mjs` shared fn's JSDoc types widen `dir` to number, so narrow it
  // back here before handing the context to the typed consumers.
  const navCtx = { ...ctx, dir: ctx.dir as 1 | -1 };
  let ordered = orderApplications(readApplications(), navCtx);
  let index = ordered.findIndex((a) => a.n === id);
  let effectiveCtx: NavCtx = navCtx;
  if (index === -1) {
    const fallbackCtx: NavCtx = { ...DEFAULT_ORDER, dir: DEFAULT_ORDER.dir as 1 | -1 };
    ordered = orderApplications(readApplications(), fallbackCtx);
    index = ordered.findIndex((a) => a.n === id);
    effectiveCtx = fallbackCtx;
  }

  const prev = index > 0 ? ordered[index - 1] : null;
  const next = index >= 0 && index < ordered.length - 1 ? ordered[index + 1] : null;
  const position = index >= 0 ? index + 1 : null;
  const total = ordered.length;
  const contextQuery = buildContextQuery(effectiveCtx);
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

import { notFound } from "next/navigation";
import { readReport, findApplication, readApplications, trackerCanDelete } from "@/lib/career-ops";
import { orderApplications, buildContextQuery, DEFAULT_ORDER } from "@/lib/pipeline-order.mjs";
import { ReportView } from "@/components/report-view";

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

  return (
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
    />
  );
}

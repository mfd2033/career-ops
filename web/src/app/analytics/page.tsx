import { pipelineSummary } from "@/lib/career-ops";
import { canonStatus, scoreNum } from "@/lib/format";
import { cumulativeTiles } from "@/lib/funnel-tiles.mjs";
import { buildContextQuery } from "@/lib/pipeline-order.mjs";
import { AnalyticsView } from "@/components/analytics/analytics-view";

export const dynamic = "force-dynamic";

const STAGES = ["EVALUATED", "APPLIED", "RESPONDED", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "DISCARDED"];

export default function Analytics() {
  const { applications } = pipelineSummary();
  const total = applications.length;

  // 下钻 href 一律经共享上下文序列化器生成（ADR-0067 决议 6）：分析页与管道页
  // 对同一个 URL 上下文只允许存在一种写法，计数口径（同一 includes 式）与
  // 过滤口径天然同源，行数必等于条形数字。
  const stageCounts = STAGES.map((key) => ({
    key,
    n: applications.filter((a) => canonStatus(a.status).includes(key)).length,
    href: `/pipeline${buildContextQuery({ tab: key })}`,
  }));

  const scores = applications.map((a) => scoreNum(a.score)).filter((n) => !Number.isNaN(n));
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  // 分数桶 = 半开区间 [min, max)（ADR-0067 决议 2）：计数表达式与管道的
  // min/max 过滤式同一边界（含下不含上、无效分数排除），下钻行数必等于桶数字。
  const buckets = [
    { label: "4.5 – 5.0", min: 4.5, max: null },
    { label: "4.0 – 4.4", min: 4, max: 4.5 },
    { label: "3.0 – 3.9", min: 3, max: 4 },
    { label: "< 3.0", min: null, max: 3 },
  ].map((b) => ({
    label: b.label,
    n: scores.filter((s) => (b.min == null || s >= b.min) && (b.max == null || s < b.max)).length,
    href: `/pipeline${buildContextQuery({ tab: "ALL", min: b.min, max: b.max })}`,
  }));

  const companyCounts = new Map<string, number>();
  for (const a of applications) if (a.company) companyCounts.set(a.company, (companyCounts.get(a.company) ?? 0) + 1);
  const topCompanies = [...companyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, n]) => ({ name, n }));

  // CUMULATIVE, unlike the stage bars above: these two tiles are achievement
  // counters whose zero-state shows a coaching nudge, so a candidate who has
  // already advanced past a stage must not read 0 for it (an offer-holder was
  // told "Interviews follow replies — keep follow-ups warm"). Mirrors
  // everInterview/everOffer in stats.mjs's computeFunnel().
  const { interviews, offers } = cumulativeTiles(applications.map((a) => canonStatus(a.status)));

  return (
    <AnalyticsView
      total={total}
      stageCounts={stageCounts}
      avg={avg}
      buckets={buckets}
      topCompanies={topCompanies}
      interviews={interviews}
      offers={offers}
    />
  );
}

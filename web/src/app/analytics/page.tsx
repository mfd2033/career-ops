import { pipelineSummary } from "@/lib/career-ops";
import { canonStatus, scoreNum } from "@/lib/format";
import { cumulativeTiles } from "@/lib/funnel-tiles.mjs";
import { AnalyticsView } from "@/components/analytics/analytics-view";

export const dynamic = "force-dynamic";

const STAGES = ["EVALUATED", "APPLIED", "RESPONDED", "INTERVIEW", "OFFER", "HIRED", "REJECTED", "DISCARDED"];

export default function Analytics() {
  const { applications } = pipelineSummary();
  const total = applications.length;

  const stageCounts = STAGES.map((key) => ({
    key,
    n: applications.filter((a) => canonStatus(a.status).includes(key)).length,
  }));

  const scores = applications.map((a) => scoreNum(a.score)).filter((n) => !Number.isNaN(n));
  const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
  const buckets = [
    { label: "4.5 – 5.0", test: (n: number) => n >= 4.5 },
    { label: "4.0 – 4.4", test: (n: number) => n >= 4 && n < 4.5 },
    { label: "3.0 – 3.9", test: (n: number) => n >= 3 && n < 4 },
    { label: "< 3.0", test: (n: number) => n < 3 },
  ].map((b) => ({ label: b.label, n: scores.filter(b.test).length }));

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

"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { UNKNOWN_EMPLOYER_SENTINEL } from "@/lib/unknown-employer.mjs";

// Presentational client component for the Analytics page. The page itself stays
// a server component (it reads the career-ops core via @/lib/career-ops); it
// computes the numbers and hands them here so all user-visible text can be
// localized through the i18n hook without pulling server-only APIs into a
// client bundle.

type StageCount = { key: string; n: number; href?: string };
type Bucket = { label: string; n: number; href?: string };
type Company = { name: string; n: number; href?: string };
type PaceWeek = { week: string; count: number };
type Pace = {
  target: number;
  thisWeek: string | null;
  thisWeekCount: number;
  belowTarget: boolean;
  weeks: PaceWeek[];
};

export function AnalyticsView({
  total,
  stageCounts,
  avg,
  buckets,
  topCompanies,
  interviews,
  offers,
  pace,
}: {
  total: number;
  stageCounts: StageCount[];
  avg: number | null;
  buckets: Bucket[];
  topCompanies: Company[];
  interviews: number;
  offers: number;
  pace: Pace;
}) {
  const { t } = useI18n();

  // 匿名雇主 `?` 哨兵行在榜单上显示成可读标签，不再裸显问号（用户误读为渲染错误）。
  // 只改显示层：下钻 href 由 page.tsx 仍携原始 `?`（ADR-0067 全等口径），落地
  // 行数必等于条形数字不变。key 保留 c.name（`?` 在分组里唯一，不撞 key）。
  const companyDisplayLabel = (name: string) =>
    name === UNKNOWN_EMPLOYER_SENTINEL ? t("analytics.company.unknownEmployer") : name;

  const maxStage = Math.max(1, ...stageCounts.map((s) => s.n));
  const maxBucket = Math.max(1, ...buckets.map((b) => b.n));
  const maxCompany = Math.max(1, ...topCompanies.map((c) => c.n));
  const scoreTotal = buckets.reduce((a, b) => a + b.n, 0);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">{t("analytics.title")}</h1>
      <p className="mt-1 text-sm text-muted">{t("analytics.trackedEvaluations", { total })}</p>

      {/* headline stats */}
      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat value={total} label={t("analytics.stat.evaluated")} />
        <Stat value={avg != null ? avg.toFixed(2) : "—"} label={t("analytics.stat.avgScore")} />
        <Stat
          value={interviews}
          label={t("analytics.stat.interviews")}
          hint={interviews === 0 ? t("analytics.stat.interviewsHint") : undefined}
        />
        <Stat
          value={offers}
          label={t("analytics.stat.offers")}
          hint={offers === 0 ? t("analytics.stat.offersHint") : undefined}
        />
      </div>

      {/* 周投递节奏卡 (CO-52)：本周投递 X/目标 进度条 + 近几周趋势，低于目标提示
          补扫。节奏信号，不是一组可跳转的行，故整卡不接 href（不违反 ADR-0067
          对统计卡的决议）。 */}
      <PaceCard pace={pace} />

      <Section title={t("analytics.section.pipelineByStage")}>
        {stageCounts.map((s) => (
          <Bar
            key={s.key}
            label={t(`analytics.stage.${s.key.toLowerCase()}`)}
            value={s.n}
            pct={(s.n / maxStage) * 100}
            total={total}
            tone={s.key === "OFFER" ? "positive" : "neutral"}
            href={s.href}
            drillTitle={t("analytics.drill.viewInPipeline", { n: s.n })}
          />
        ))}
      </Section>

      <Section title={t("analytics.section.scoreDistribution")}>
        {buckets.map((b) => (
          <Bar
            key={b.label}
            label={b.label}
            value={b.n}
            pct={(b.n / maxBucket) * 100}
            total={scoreTotal}
            href={b.href}
            drillTitle={t("analytics.drill.viewInPipeline", { n: b.n })}
          />
        ))}
      </Section>

      <Section title={t("analytics.section.topCompanies")} id="companies">
        {topCompanies.map((c) => (
          <Bar
            key={c.name}
            label={companyDisplayLabel(c.name)}
            value={c.n}
            pct={(c.n / maxCompany) * 100}
            href={c.href}
            drillTitle={t("analytics.drill.viewInPipeline", { n: c.n })}
          />
        ))}
      </Section>
    </div>
  );
}

function Stat({ value, label, hint }: { value: number | string; label: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-4">
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-faint">{label}</div>
      {hint && (
        <Link href="/" className="mt-2 block text-xs text-muted transition-colors hover:text-brand">
          {hint}
        </Link>
      )}
    </div>
  );
}

// 周投递节奏卡 (CO-52)。节奏信号面板，非可下钻的一组行——整卡不接链接，
// 遵守 analytics-drilldown 对统计区的守卫（不引入 href）。
function PaceCard({ pace }: { pace: Pace }) {
  const { t } = useI18n();
  const pct = pace.target > 0 ? Math.min(100, (pace.thisWeekCount / pace.target) * 100) : 0;
  const maxCount = Math.max(1, pace.target, ...pace.weeks.map((w) => w.count));
  return (
    <div className="mt-6 rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{t("analytics.pace.title")}</h2>
        {pace.belowTarget && <span className="text-xs text-amber-500">{t("analytics.pace.rescanHint")}</span>}
      </div>

      <div className="mt-3 flex items-end justify-between gap-4">
        <div>
          <div className="text-3xl font-semibold tabular-nums">
            {pace.thisWeekCount}
            <span className="text-lg text-faint">/{pace.target}</span>
          </div>
          <div className="mt-1 text-xs text-faint">{t("analytics.pace.thisWeek")}</div>
        </div>

        {/* 近几周趋势小柱，当前周在最右。加一行标签说明这组柱子的含义，
            否则裸露的 0/4/4/0 读不出是什么。 */}
        <div className="flex flex-col items-end gap-1">
          <span className="text-[10px] text-faint">{t("analytics.pace.trend")}</span>
          <div className="flex items-end gap-1.5">
            {pace.weeks.map((w) => (
              <div key={w.week} className="flex flex-col items-center gap-1">
                <div className="flex h-12 w-4 items-end overflow-hidden rounded-sm bg-foreground/10">
                  <div
                    className="w-full rounded-sm bg-foreground/25"
                    style={{ height: `${(w.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="text-[10px] tabular-nums text-faint">{w.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-foreground/10">
        <div
          className={`h-full rounded-full ${
            pace.belowTarget
              ? "bg-gradient-to-r from-amber-500/60 to-amber-500/30"
              : "bg-gradient-to-r from-emerald-500/60 to-emerald-500/30"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Section({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id} className="mt-10 scroll-mt-8">
      <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">{title}</h2>
      <div className="mt-4 space-y-2.5">{children}</div>
    </section>
  );
}

function Bar({
  label,
  value,
  pct,
  total,
  tone = "neutral",
  href,
  drillTitle,
}: {
  label: string;
  value: number;
  pct: number;
  total?: number;
  tone?: "neutral" | "positive";
  href?: string;
  drillTitle?: string;
}) {
  const share = total && total > 0 ? Math.round((value / total) * 100) : null;
  const fill =
    tone === "positive"
      ? "bg-gradient-to-r from-emerald-500/60 to-emerald-500/30"
      : "bg-gradient-to-r from-foreground/25 to-foreground/10";
  // 下钻门（ADR-0067 决议 1）：有 href 且计数非零才成链接——0 计数的行点了只会
  // 得到空列表，是死交互，不为可点付出代价。整行包链接，键盘可聚焦。
  const clickable = href != null && value > 0;
  const cells = (
    <>
      <div className="w-32 shrink-0 truncate text-sm text-muted transition-colors group-hover:text-brand">{label}</div>
      <div className="relative h-7 flex-1 overflow-hidden rounded-md bg-surface">
        <div
          className={`h-full rounded-md ${fill}`}
          style={{ width: `${Math.max(pct, value > 0 ? 4 : 0)}%` }}
        />
      </div>
      <div className="w-20 shrink-0 text-right text-sm tabular-nums">
        {value}
        {share !== null && <span className="ml-1 text-xs text-faint">{share}%</span>}
      </div>
    </>
  );
  if (!clickable) {
    return <div className="flex items-center gap-3">{cells}</div>;
  }
  return (
    <Link
      href={href!}
      title={drillTitle}
      className="group -mx-2 flex items-center gap-3 rounded-md px-2 outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      {cells}
    </Link>
  );
}

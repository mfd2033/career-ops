"use client";

import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";

// Presentational client component for the Analytics page. The page itself stays
// a server component (it reads the career-ops core via @/lib/career-ops); it
// computes the numbers and hands them here so all user-visible text can be
// localized through the i18n hook without pulling server-only APIs into a
// client bundle.

type StageCount = { key: string; n: number };
type Bucket = { label: string; n: number };
type Company = { name: string; n: number };

export function AnalyticsView({
  total,
  stageCounts,
  avg,
  buckets,
  topCompanies,
  interviews,
  offers,
}: {
  total: number;
  stageCounts: StageCount[];
  avg: number | null;
  buckets: Bucket[];
  topCompanies: Company[];
  interviews: number;
  offers: number;
}) {
  const { t } = useI18n();

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

      <Section title={t("analytics.section.pipelineByStage")}>
        {stageCounts.map((s) => (
          <Bar
            key={s.key}
            label={t(`analytics.stage.${s.key.toLowerCase()}`)}
            value={s.n}
            pct={(s.n / maxStage) * 100}
            total={total}
            tone={s.key === "OFFER" ? "positive" : "neutral"}
          />
        ))}
      </Section>

      <Section title={t("analytics.section.scoreDistribution")}>
        {buckets.map((b) => (
          <Bar key={b.label} label={b.label} value={b.n} pct={(b.n / maxBucket) * 100} total={scoreTotal} />
        ))}
      </Section>

      <Section title={t("analytics.section.topCompanies")} id="companies">
        {topCompanies.map((c) => (
          <Bar key={c.name} label={c.name} value={c.n} pct={(c.n / maxCompany) * 100} />
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
}: {
  label: string;
  value: number;
  pct: number;
  total?: number;
  tone?: "neutral" | "positive";
}) {
  const share = total && total > 0 ? Math.round((value / total) * 100) : null;
  const fill =
    tone === "positive"
      ? "bg-gradient-to-r from-emerald-500/60 to-emerald-500/30"
      : "bg-gradient-to-r from-foreground/25 to-foreground/10";
  return (
    <div className="flex items-center gap-3">
      <div className="w-32 shrink-0 truncate text-sm text-muted">{label}</div>
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
    </div>
  );
}

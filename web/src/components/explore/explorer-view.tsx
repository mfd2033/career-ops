"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Compass, ChevronDown, RotateCcw, AlertTriangle, Sparkles, Settings, Globe } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/cn";
import { instrumentSerif } from "@/lib/fonts";
import type { Application, InboxJob } from "@/lib/career-ops";
import { normalizeTextKey } from "@/lib/core/normalize-text-key.mjs";
import { paramsToFilters, paramsToAi, paramsToBrowser, type ExploreFilters } from "@/lib/explore";
import { FilterBuilder } from "./filter-builder";
import { DiscoveringState } from "./discovering-state";
import { AiHuntView } from "./ai-hunt-view";
import { ExploreModeToggle } from "./explore-mode-toggle";
import { AiSearchBox } from "./ai-search-box";
import { ResultsList, type EnrichedOffer } from "./results-list";
import { useExplore } from "./explore-provider";
import { useI18n } from "@/lib/i18n/context";

// Same shape as core normalizeTextKey(s, " ") — never [^a-z0-9] (#2666).
const norm = (s: string) => normalizeTextKey(s, " ");
const CLI_NAMES: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  copilot: "Copilot CLI",
  qwen: "Qwen CLI",
  antigravity: "Antigravity CLI",
};

export function ExplorerView({
  seed,
  inboxSnapshot,
  appsSnapshot,
  rootExists,
}: {
  seed: { filters: ExploreFilters; seededFrom: string[] };
  inboxSnapshot: InboxJob[];
  appsSnapshot: Application[];
  rootExists: boolean;
}) {
  const { filters, setFilters, initFilters, phase, running, offers, discover, discoverBrowser, loadFresh, status, error, scannerMissing, mode, setMode, aiIntent, setAiIntent, discoverAI, companiesScanned, companiesAvailable, capHit, droppedNoDate, partial } = useExplore();
  const { t } = useI18n();
  const avail = companiesAvailable > companiesScanned ? t("explore.degraded.ofAvailable", { n: companiesAvailable.toLocaleString() }) : "";
  const partialTxt = partial ? t("explore.scanNotePartial") : "";
  const scanNote =
    companiesScanned > 0
      ? t(companiesScanned === 1 ? "explore.scanNoteOne" : "explore.scanNoteMany", {
          n: companiesScanned.toLocaleString(),
          avail,
          partial: partialTxt,
        })
      : undefined;
  const inited = useRef(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [cli, setCli] = useState<{ id: string | null; name?: string }>({ id: null });
  const [firstRun, setFirstRun] = useState(false);

  useEffect(() => {
    try {
      const id = JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId || null;
      setCli({ id, name: id ? CLI_NAMES[id] || id : undefined });
    } catch {
      setCli({ id: null });
    }
  }, []);

  // Initialize once from the URL (shareable search) or the server seed — without
  // clobbering anything the assistant set before this mount.
  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    const sp = new URLSearchParams(window.location.search);
    const ai = paramsToAi(sp);
    if (ai !== null) {
      setMode("ai");
      setAiIntent(ai);
    } else {
      const browser = paramsToBrowser(sp);
      if (browser !== null) {
        // A restored browser hunt (?mode=browser&zh=…&sources=…) lands straight
        // back in the browser surface with its filters and URL intact.
        setMode("browser");
        initFilters(browser);
      } else if (sp.get("view") === "fresh") {
        // Today's "See all N" (#84) hands off here instead of a bare config form —
        // load the SAME /api/whats-new offers it already showed, through the normal
        // results-phase UI. The config form (Refine search / Re-cast) stays reachable.
        // Force scan mode: a session restored in "ai" mode (sessionStorage rehydrate)
        // must not show the AI-search UI for this scan-only hand-off.
        setMode("scan");
        initFilters(seed.filters);
        void loadFresh();
      } else {
        initFilters(sp.toString() ? paramsToFilters(sp) : seed.filters);
        // Onboarding hand-off: ?run=1 auto-fires the free scan + flags the first-run
        // banner (the "matches found from your CV, free" reveal).
        if (sp.get("run") === "1") {
          setFirstRun(true);
          void discover();
        }
      }
    }
  }, [seed.filters, initFilters, setMode, setAiIntent, discover, loadFresh]);

  const inboxUrls = useMemo(() => new Set(inboxSnapshot.map((j) => j.url)), [inboxSnapshot]);
  const enriched: EnrichedOffer[] = useMemo(
    () =>
      offers.map((o) => {
        const inPipeline = inboxUrls.has(o.url);
        const c = norm(o.company);
        const t = norm(o.title);
        const ev = appsSnapshot.find((a) => {
          if (norm(a.company) !== c) return false;
          const ar = norm(a.role);
          return ar.length > 3 && (t.includes(ar) || ar.includes(t.split(" ").slice(0, 3).join(" ")));
        });
        return { ...o, inPipeline, evaluatedN: ev?.n };
      }),
    [offers, inboxUrls, appsSnapshot],
  );

  const isAi = mode === "ai";
  const isBrowser = mode === "browser";
  if (running) return isAi ? <AiHuntView cliName={cli.name} /> : <DiscoveringState />;

  const canDiscover = isBrowser ? true : filters.ats.length > 0;
  const isResults = phase === "results";

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 md:px-8">
      <header className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2.5">
            <Compass className="size-6 text-brand" />
            <h1 className={`${instrumentSerif.className} text-3xl text-foreground`}>{t("explore.title")}</h1>
            <span className="rounded-full border border-brand/30 bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-text">{t("explore.badgeNew")}</span>
          </div>
          <div className="w-full sm:ml-auto sm:w-auto">
            <ExploreModeToggle mode={mode} onChange={setMode} cliConfigured={!!cli.id} />
          </div>
        </div>
        {!isResults && (
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
            {isAi ? t("explore.aiDesc") : isBrowser ? t("explore.browserDesc") : t("explore.scanDesc")}
          </p>
        )}
      </header>

      {!rootExists && (
        <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          {t("explore.rootNotSetup")}
        </div>
      )}

      {isAi ? (
        phase === "blocked" ? (
          <BlockedCard />
        ) : (
          <div className="space-y-6">
            <AiSearchBox
              intent={aiIntent}
              onIntent={setAiIntent}
              onSubmit={() => void discoverAI()}
              cliConfigured={!!cli.id}
              cliName={cli.name}
              onRunScan={() => setMode("scan")}
            />
            {phase === "results" && <ResultsList offers={enriched} />}
            {phase === "empty-loose" && (
              <EmptyState
                tone="loose"
                title={t("explore.empty.aiLooseTitle")}
                body={t("explore.empty.aiLooseBody")}
                onRerun={() => setMode("scan")}
                rerunLabel={t("explore.empty.aiLooseRerun")}
              />
            )}
            {phase === "failed" && <FailedCard msg={error || status} scannerMissing={scannerMissing} onRetry={() => void discoverAI()} />}
          </div>
        )
      ) : isBrowser ? (
        phase === "blocked" ? (
          <BrowserBlockedCard />
        ) : (
          <div className="space-y-6">
            {isResults ? (
              <div className="mb-6 rounded-xl border border-border bg-surface/30">
                <button type="button" onClick={() => setRefineOpen((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-foreground">
                  <Globe className="size-4 text-brand" /> {t("explore.refineSearch")}
                  <ChevronDown className={cn("ml-auto size-4 text-muted transition-transform", refineOpen && "rotate-180")} />
                </button>
                {refineOpen && (
                  <div className="space-y-4 border-t border-border p-4">
                    <FilterBuilder filters={filters} onChange={setFilters} seededFrom={seed.seededFrom} mode="browser" />
                    <DiscoverBar canDiscover={canDiscover} onDiscover={discoverBrowser} label={t("explore.recastBrowser")} />
                  </div>
                )}
              </div>
            ) : (
              <div className="mb-6 rounded-2xl border border-border bg-surface/30 p-5">
                <FilterBuilder filters={filters} onChange={setFilters} seededFrom={seed.seededFrom} mode="browser" />
                <div className="mt-5">
                  <DiscoverBar canDiscover={canDiscover} onDiscover={discoverBrowser} label={t("explore.discoverBrowser")} />
                </div>
              </div>
            )}

            {isResults && <ResultsList offers={enriched} />}
            {phase === "empty-loose" && (
              <EmptyState
                tone="loose"
                title={t("explore.empty.browserLooseTitle")}
                body={t("explore.empty.browserLooseBody")}
                onRerun={() => void discoverBrowser()}
                rerunLabel={t("explore.empty.browserLooseRerun")}
              />
            )}
            {phase === "degraded" && (
              <DegradedCard
                onRetry={() => void discoverBrowser()}
                companiesScanned={companiesScanned}
                companiesAvailable={companiesAvailable}
                capHit={capHit}
                droppedNoDate={droppedNoDate}
                partial={partial}
              />
            )}
            {phase === "failed" && <FailedCard msg={error || status} scannerMissing={scannerMissing} onRetry={() => void discoverBrowser()} />}
          </div>
        )
      ) : (
        <>
          {isResults ? (
            <div className="mb-6 rounded-xl border border-border bg-surface/30">
                <button type="button" onClick={() => setRefineOpen((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-foreground">
                  <Compass className="size-4 text-brand" /> {t("explore.refineSearch")}
                  <ChevronDown className={cn("ml-auto size-4 text-muted transition-transform", refineOpen && "rotate-180")} />
                </button>
              {refineOpen && (
                <div className="space-y-4 border-t border-border p-4">
                   <FilterBuilder filters={filters} onChange={setFilters} seededFrom={seed.seededFrom} />
                   <DiscoverBar canDiscover={canDiscover} onDiscover={discover} label={t("explore.recastFree")} />
                </div>
              )}
            </div>
          ) : (
            <div className="mb-6 rounded-2xl border border-border bg-surface/30 p-5">
              <FilterBuilder filters={filters} onChange={setFilters} seededFrom={seed.seededFrom} />
              <div className="mt-5">
                <DiscoverBar canDiscover={canDiscover} onDiscover={discover} label={t("explore.discoverFree")} />
              </div>
            </div>
          )}

          {isResults && firstRun && (
            <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-emerald-500" />
              <p className="text-[13px] leading-relaxed text-foreground">
                {t("explore.firstRun.lead")}
                <span className="text-emerald-600 dark:text-emerald-400">{t("explore.firstRun.emph")}</span>
                {t("explore.firstRun.tail")}
              </p>
            </div>
          )}

          {isResults && capHit && (
            <CappedBanner companiesScanned={companiesScanned} companiesAvailable={companiesAvailable} onRefine={() => setRefineOpen(true)} />
          )}
          {isResults && <ResultsList offers={enriched} />}

          {phase === "empty-current" && (
            <EmptyState
              tone="good"
              title={t("explore.empty.caughtUpTitle")}
              body={t("explore.empty.caughtUpBody")}
              note={scanNote}
              onRerun={() => {
                setFilters({ ...filters, sinceDays: Math.max(filters.sinceDays, 30) });
                void discover();
              }}
              rerunLabel={t("explore.empty.lookBack30")}
            />
          )}
          {phase === "empty-loose" && (
            <EmptyState
              tone="loose"
              title={t("explore.empty.scanLooseTitle")}
              body={t("explore.empty.scanLooseBody")}
              note={scanNote}
              onRerun={() => {
                setFilters({ ...filters, sinceDays: 30, block: [], allow: [] });
                void discover();
              }}
              rerunLabel={t("explore.empty.scanLooseRerun")}
            />
          )}
          {phase === "degraded" && (
            <DegradedCard
              onRetry={() => void discover()}
              companiesScanned={companiesScanned}
              companiesAvailable={companiesAvailable}
              capHit={capHit}
              droppedNoDate={droppedNoDate}
              partial={partial}
            />
          )}
          {phase === "failed" && <FailedCard msg={error || status} scannerMissing={scannerMissing} onRetry={() => void discover()} />}
        </>
      )}
    </div>
  );
}

function DiscoverBar({ canDiscover, onDiscover, label }: { canDiscover: boolean; onDiscover: () => void; label: string }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={!canDiscover}
        onClick={onDiscover}
        className="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground shadow-sm transition-all hover:brightness-110 disabled:opacity-50 max-sm:min-h-[44px]"
      >
        <Compass className="size-4" /> {label}
      </button>
      <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
        <span className="size-1.5 rounded-full bg-emerald-500" />
        {t("explore.discoverNote")}
      </span>
    </div>
  );
}

function EmptyState({ tone, title, body, note, onRerun, rerunLabel }: { tone: "good" | "loose"; title: string; body: string; note?: string; onRerun: () => void; rerunLabel: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/30 px-6 py-12 text-center">
      <div className={cn("mx-auto grid size-12 place-items-center rounded-full", tone === "good" ? "bg-emerald-500/12 text-emerald-500" : "bg-brand-soft text-brand")}>
        <Sparkles className="size-6" />
      </div>
      <h2 className={`${instrumentSerif.className} mt-4 text-2xl text-foreground`}>{title}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">{body}</p>
      {note && <p className="mx-auto mt-1 max-w-md text-[12px] text-faint">{note}</p>}
      <button onClick={onRerun} className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/50 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:border-brand/40 hover:text-brand">
        <RotateCcw className="size-4" /> {rerunLabel}
      </button>
    </div>
  );
}

function DegradedCard({
  onRetry,
  companiesScanned,
  companiesAvailable,
  capHit,
  droppedNoDate,
  partial,
}: {
  onRetry: () => void;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  partial: boolean;
}) {
  const { t } = useI18n();
  // 0 results, but the scan was NOT a clean full search → never "all caught up".
  // Pick the most informative reason (authoritative when the scanner's --json mode
  // is available; otherwise the 0-companies fallback).
  let title = t("explore.degraded.titleDefault");
  let body = t("explore.degraded.bodyDefault");
  if (companiesScanned > 0 && capHit) {
    title = t("explore.degraded.titleCapped");
    const avail = companiesAvailable > companiesScanned ? t("explore.degraded.ofAvailable", { n: companiesAvailable.toLocaleString() }) : "";
    body = t("explore.degraded.bodyCapped", { scanned: companiesScanned.toLocaleString(), avail });
  } else if (companiesScanned > 0 && droppedNoDate > 0) {
    title = t("explore.degraded.titleDropped");
    body = t(droppedNoDate === 1 ? "explore.degraded.bodyDroppedOne" : "explore.degraded.bodyDroppedMany", { n: droppedNoDate.toLocaleString() });
  } else if (companiesScanned > 0 && partial) {
    title = t("explore.degraded.titlePartial");
    body = t("explore.degraded.bodyPartial", { n: companiesScanned.toLocaleString() });
  }
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 text-center">
      <AlertTriangle className="mx-auto size-6 text-amber-500" />
      <p className="mt-2 text-sm font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-[13px] text-muted">{body}</p>
      <button onClick={onRetry} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-brand-soft px-3 py-1.5 text-sm font-medium text-brand">
        <RotateCcw className="size-4" /> {t("explore.degraded.retry")}
      </button>
    </div>
  );
}

function CappedBanner({ companiesScanned, companiesAvailable, onRefine }: { companiesScanned: number; companiesAvailable: number; onRefine: () => void }) {
  const { t } = useI18n();
  // Results ARE present, but the scan was capped — tell the user there's more, so a
  // partial list never reads as "everything there is".
  const avail = companiesAvailable > companiesScanned ? t("explore.degraded.ofAvailable", { n: companiesAvailable.toLocaleString() }) : "";
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-2.5 text-[13px]">
      <span className="text-foreground">
        {t("explore.capped.banner", { n: companiesScanned.toLocaleString(), avail })}
      </span>
      <button onClick={onRefine} className="font-medium text-brand hover:underline">
        {t("explore.capped.raiseDepth")}
      </button>
    </div>
  );
}

function FailedCard({ msg, scannerMissing, onRetry }: { msg: string; scannerMissing: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  // The scanner-missing case (data-only / pre-scan-ats-full checkout) must NOT
  // offer a "Try again" that re-fails forever — give a real next step instead.
  // The caller decides this from the response body's SCANNER_MISSING code, never
  // from the error text and never from the bare 400: a runtime scan error ("The
  // scanner returned no readable output.") mentions the scanner too, and 400 is
  // a shared channel that also carries malformed-request and MODE_MISSING
  // failures. Neither may be misreported as a broken checkout.
  if (scannerMissing) {
    return (
      <div className="rounded-2xl border border-border bg-surface/30 px-6 py-10 text-center">
        <div className="mx-auto grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
          <Compass className="size-6" />
        </div>
        <h2 className={`${instrumentSerif.className} mt-4 text-2xl text-foreground`}>{t("explore.failed.fullToolkitTitle")}</h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
          {t("explore.failed.fullToolkitBody")}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Link href="/pipeline" className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-brand-foreground transition hover:brightness-110">
            {t("explore.failed.openPipeline")}
          </Link>
          <Link href="/config" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand">
            {t("explore.failed.openConfig")}
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 text-center">
      <AlertTriangle className="mx-auto size-6 text-amber-500" />
      <p className="mt-2 text-sm font-medium text-foreground">{t("explore.failed.title")}</p>
      <p className="mt-1 text-[13px] text-muted">{msg}</p>
      <button onClick={onRetry} className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-brand-soft px-3 py-1.5 text-sm font-medium text-brand">
        <RotateCcw className="size-4" /> {t("explore.failed.tryAgain")}
      </button>
    </div>
  );
}

function BlockedCard() {
  const { t } = useI18n();
  return (
    <div className="rounded-2xl border border-border bg-surface/30 px-6 py-12 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
        <Sparkles className="size-6" />
      </div>
      <h2 className={`${instrumentSerif.className} mt-4 text-2xl text-foreground`}>{t("explore.blocked.title")}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
        {t("explore.blocked.body")}
      </p>
      <Link href="/config" className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-brand-foreground transition hover:brightness-110">
        <Settings className="size-4" /> {t("explore.failed.openConfig")}
      </Link>
    </div>
  );
}

function BrowserBlockedCard() {
  const { t } = useI18n();
  // The browser mode can't run without browser-skill — this is an INSTALL guide,
  // not a retry: the missing bsk returned a structured BSK_MISSING 400, so a
  // "Try again" would re-fail forever until the CLI is present.
  return (
    <div className="rounded-2xl border border-border bg-surface/30 px-6 py-12 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
        <Globe className="size-6" />
      </div>
      <h2 className={`${instrumentSerif.className} mt-4 text-2xl text-foreground`}>{t("explore.blockedBrowser.title")}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted">
        {t("explore.blockedBrowser.body")}
      </p>
      <pre className="mx-auto mt-4 inline-block rounded-lg border border-border bg-surface px-4 py-2 text-left text-[12.5px] text-foreground">
        npm i -g browser-skill{`\n`}bsk status
      </pre>
    </div>
  );
}

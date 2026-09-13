"use client";

import { useEffect, useState } from "react";
import { resolveJobReportNum, showsEvalDuration } from "@/lib/report-num.mjs";
import type { EvalTimingEntry } from "@/lib/eval-timing";

// Client-side access to the 评估用时 map + report-number resolution for job
// records. Module-level promise cache: N cards, ONE fetch each per page load.
// The number itself comes from report-num.mjs (captured field → posting URL →
// pool "#N" subtitle → pdf fallback, ADR-0018); this module only wires it to
// the two server indexes and keeps 评估用时 scoped to evaluation workers — a
// number resolved for navigation is not a duration claim.
//
// The cache is dropped whenever a worker settles (the `co-job-done` event): both
// indexes summarise files the finished run just wrote (data/eval-timings.tsv, the
// tracker), and the mount-time fetch necessarily predates them — a card's first
// render happens while the CLI is still running. Without the revalidation a worker
// that settles in this session keeps showing the local fallback until a reload.

type ReportIndex = Record<string, { score: string; reportNum: string }>;
type DurationIndex = Record<string, EvalTimingEntry>;

const cache = new Map<string, Promise<unknown>>();

function fetchCached<T>(url: string): Promise<T> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : ({} as unknown)))
      .catch(() => ({}));
    cache.set(url, p);
  }
  return p as Promise<T>;
}

function useCachedJson<T>(url: string): T | null {
  const [data, setData] = useState<T | null>(null);
  // Bumped to force a re-read; the cache entry is dropped first so the re-run lands
  // on a fresh fetch instead of the settled worker's stale snapshot.
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    fetchCached<T>(url).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [url, revision]);
  // A finished worker rewrote the indexes' source files (see the header): re-read
  // them so its card / history row stops showing the local fallback. Every mounted
  // card reacts, but they share ONE refetch per url via the promise cache.
  useEffect(() => {
    const onSettled = () => {
      cache.delete(url);
      setRevision((r) => r + 1);
    };
    window.addEventListener("co-job-done", onSettled);
    return () => window.removeEventListener("co-job-done", onSettled);
  }, [url]);
  return data;
}

export function useReportIndex(): ReportIndex | null {
  return useCachedJson<ReportIndex>("/api/report-status");
}

export function useEvalDurations(): DurationIndex | null {
  return useCachedJson<DurationIndex>("/api/eval-durations");
}

/** Resolve a job's report number (captured `reportNum` → posting URL → the "#N"
 *  pool subtitle → the pdf fallback; see report-num.mjs) and its 评估用时 entry.
 *  Both indexes arrive async → nulls until loaded; callers must degrade to the
 *  local elapsed. 评估用时 stays scoped to evaluation workers: a number resolved
 *  for navigation must not put an evaluation's duration on a CV-generation card
 *  (ADR-0018). */
export function useJobTiming(job: {
  input?: string;
  subtitle?: string;
  kind?: string;
  reportNum?: string;
}): {
  reportNum: string | null;
  entry: EvalTimingEntry | null;
} {
  const reports = useReportIndex();
  const durations = useEvalDurations();
  const reportNum = resolveJobReportNum(job, reports);
  const entry = reportNum && durations && showsEvalDuration(job) ? durations[reportNum] ?? null : null;
  return { reportNum, entry };
}

/** The seconds a DONE worker displays: 评估用时 when the report is resolvable,
 *  else the local startedAt→endedAt wall time (ADR-0016 fallback, Q3a). */
export function doneDurationSeconds(
  entry: EvalTimingEntry | null,
  job: { startedAt: number; endedAt?: number },
): number | null {
  if (entry?.duration != null) return entry.duration;
  if (job.endedAt != null) return Math.max(0, (job.endedAt - job.startedAt) / 1000);
  return null;
}

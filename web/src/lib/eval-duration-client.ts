"use client";

import { useEffect, useState } from "react";
import { normalizeUrl } from "@/lib/core/url-key.mjs";
import type { EvalTimingEntry } from "@/lib/eval-timing";

// Client-side access to the 评估用时 map + report-number resolution for job
// records. A persisted job (localStorage) carries no report number, so a DONE
// worker resolves its report via /api/report-status (normalized posting URL →
// reportNum — the same durable map the extension badges use); the "#N"
// subtitle of server-sourced pool cards is the fallback. Module-level promise
// cache: N cards, ONE fetch each per page load.

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
  useEffect(() => {
    let live = true;
    fetchCached<T>(url).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [url]);
  return data;
}

export function useReportIndex(): ReportIndex | null {
  return useCachedJson<ReportIndex>("/api/report-status");
}

export function useEvalDurations(): DurationIndex | null {
  return useCachedJson<DurationIndex>("/api/eval-durations");
}

/** Resolve a job's report number (URL → /api/report-status, then the "#N"
 *  subtitle the pool cards carry) and its 评估用时 entry. Both indexes arrive
 *  async → nulls until loaded; callers must degrade to the local elapsed. */
export function useJobTiming(job: { input?: string; subtitle?: string }): {
  reportNum: string | null;
  entry: EvalTimingEntry | null;
} {
  const reports = useReportIndex();
  const durations = useEvalDurations();
  let reportNum: string | null = null;
  const input = job.input;
  if (input && /^https?:\/\//i.test(input) && reports) {
    const key = normalizeUrl(input);
    reportNum = (key && reports[key]?.reportNum) || null;
  }
  if (!reportNum && job.subtitle) {
    const m = job.subtitle.match(/^#(\d+)$/);
    if (m) reportNum = m[1];
  }
  const entry = reportNum && durations ? durations[reportNum] ?? null : null;
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

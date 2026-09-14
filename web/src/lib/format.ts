// Pure, node-free helpers shared by server and client components (no fs/path
// imports here — career-ops.ts holds the filesystem reads). Aligned with the
// core: normalize-statuses.mjs (aliases) + the Go TUI dashboard (score/status
// colours = the current state-of-the-art).

// Alias → canonical stage. Lives in status-alias.mjs so a `node --test` unit
// test can load it and assert it still covers templates/states.yml (#2917);
// a hand-maintained copy is what drifted in #2249 and again after #2705.
import { canonStatus } from "@/lib/status-alias.mjs";
// Score parsing lives in score-num.mjs (plain .mjs) so pipeline-order.mjs and
// the node --test suites can share it; format.ts re-exports for the TS callers
// that have always imported { scoreNum } from here — no import churn.
import { scoreNum } from "@/lib/score-num.mjs";
// Header-field extraction lives in parse-report.mjs (plain .mjs, mirrors the
// report-sections.mjs precedent #2324) so the regex — incl. the `>` blockquote
// stem some writers emit (#131/#132) — is under tests/lib/parse-report.test.mjs.
import { parseReport as parseReportHeader } from "./parse-report.mjs";

export { canonStatus, scoreNum };

export const CANONICAL_STATES = [
  "Evaluated",
  "Applied",
  "Responded",
  "Interview",
  "Offer",
  "Hired",
  "Rejected",
  "Discarded",
  "SKIP",
] as const;

/** Status dot colour, mirroring the Go TUI: green hired/interview/offer, sky
 *  applied/responded, red skip/rejected, gray discarded, neutral evaluated. */
export function statusDot(status: string): string {
  const c = canonStatus(status);
  // Hired is the terminal win — the best outcome, never a neutral gray dot.
  if (c.includes("HIRED") || c.includes("INTERVIEW") || c.includes("OFFER")) return "bg-emerald-400";
  if (c.includes("APPLIED") || c.includes("RESPONDED")) return "bg-sky-400";
  if (c.includes("REJECTED") || c.includes("SKIP")) return "bg-red-400";
  if (c.includes("DISCARDED")) return "bg-zinc-600";
  return "bg-zinc-500"; // Evaluated / unknown
}

/** Score → tone, mirroring the Go TUI thresholds (>=4.2 green, >=3.8 yellow,
 *  >=3.0 normal, <3.0 red). */
export function scoreTone(score: string): "good" | "warn" | "bad" | "muted" {
  const num = scoreNum(score);
  if (!Number.isNaN(num)) {
    if (num >= 4.2) return "good";
    if (num >= 3.8) return "warn";
    if (num >= 3.0) return "muted";
    return "bad";
  }
  const g = score.trim().toUpperCase()[0];
  if (g === "A") return "good";
  if (g === "B") return "warn";
  if (g === "C") return "muted";
  if (g === "D" || g === "E" || g === "F") return "bad";
  return "muted";
}

/** Block-G legitimacy tier → tone. */
export function legitimacyTone(l: string): "good" | "warn" | "bad" | "muted" {
  const s = l.toLowerCase();
  if (s.includes("high") || s.includes("confian") || s.includes("legit")) return "good";
  if (s.includes("caution") || s.includes("precau") || s.includes("caut")) return "warn";
  if (s.includes("suspic") || s.includes("sospech") || s.includes("scam") || s.includes("fake")) return "bad";
  return "muted";
}

/** 公司体检（company checkup, ADR-0025）星级 → tone. Employer-reliability
 *  scale, deliberately NOT the offer scoreTone thresholds: ≥4 trustworthy,
 *  3–4 unremarkable, 2–3 risky, <2 high-risk. Display-only — never a scoring
 *  or sorting input (ADR-0025 决议 9 零分影响). */
export function checkupTone(star: number): "good" | "warn" | "bad" | "muted" {
  if (!Number.isFinite(star)) return "muted";
  if (star >= 4) return "good";
  if (star >= 3) return "muted";
  if (star >= 2) return "warn";
  return "bad";
}

/** Shape of one company's aggregated checkup entry (producer:
 *  web/src/lib/company-checkups.mjs checkupIndex; the ledger writer/validator
 *  is repo-root lib/log-checkup.mjs). */
export type CheckupEntry = {
  slug: string;
  company: string;
  star: number;
  date: string;
  risks: string[];
  note: string;
  html: string;
  count: number;
  minStar: number;
  maxStar: number;
  history: { date: string; star: number }[];
};

/** Humanize seconds → "45.8s" / "4m03s" / "1h12m"; null/invalid → "—" (the
 *  no-record placeholder the 用时 column and worker cards share). */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const s = Math.round(seconds);
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export type ReportMeta = {
  title: string | null;
  fields: { label: string; value: string }[];
  legitimacy: string | null;
  body: string;
};

/**
 * Tolerant report parser (per maintainer: adapt the render, don't migrate the
 * old data). Extracts the bold key/value header fields (Date/URL/Archetype/
 * Score/Legitimacy/PDF) when present and returns the body without the header
 * block. Degrades gracefully on legacy reports that lack some fields, and
 * tolerates a `>` blockquote stem writers sometimes put before `**Label:**`.
 */
export function parseReport(md: string): ReportMeta {
  return parseReportHeader(md);
}

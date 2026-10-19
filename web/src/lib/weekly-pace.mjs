// Weekly application pace (CO-52) — "how many did I actually send this week,
// against my target?" Small pure helper so the Analytics page can render the
// progress card and a `node --test` suite can lock it, matching the shape of
// funnel-tiles.mjs.
//
// The math MIRRORS computePaceStats() in the repo-root stats.mjs — the canonical
// definition — on purpose: stats.mjs reads applications.md directly (Node fs),
// while the web already has the parsed rows in memory from pipelineSummary().
// Same rule, two call sites; kept honest by tests/lib/weekly-pace.test.mjs,
// which asserts this file's isoWeek agrees with stats.mjs's on the year
// boundaries. Change the definition in stats.mjs and change it here too.
//
// A row counts as a submission when its canonical status proves a real send
// (APPLIED / RESPONDED / INTERVIEW / OFFER / HIRED / REJECTED) — the SAME set
// the funnel calls everApplied. Evaluated/SKIP/DISCARDED never left the drafts
// folder, so counting them would inflate "本周投递" with work that was not sent.

import { canonStatus } from "./status-alias.mjs";

// Same set as everApplied in stats.mjs computeFunnel(). includes-match tolerates
// any localized canonical token canonStatus may return.
const SUBMITTED_TOKENS = ["APPLIED", "RESPONDED", "INTERVIEW", "OFFER", "HIRED", "REJECTED"];

/**
 * ISO week key ("2026-W27") for a YYYY-MM-DD string; null for bad input.
 * Verbatim copy of stats.mjs's exported isoWeek — kept identical so a date
 * buckets into the same week in the CLI report and the web card.
 *
 * @param {string} dateStr - YYYY-MM-DD.
 * @returns {string|null}
 */
export function isoWeek(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - day + 3); // nearest Thursday decides the ISO year
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Whether a raw tracker status string proves an application was submitted. */
function isSubmitted(status) {
  const c = canonStatus(status);
  return SUBMITTED_TOKENS.some((k) => c.includes(k));
}

/**
 * Compute the trailing-weeks submission pace for the Analytics card.
 *
 * @param {Array<{date: string, status: string}>} applications - Tracker rows
 *   (needs the initial log `date` and raw `status`; canonStatus is applied here).
 * @param {{target?: number, weeks?: number, now?: Date}} [opts] - target from
 *   config/profile.yml (pace.weekly_applications_target, default 8); how many
 *   trailing calendar weeks to emit (default 4); the "now" reference (default
 *   today) — injectable so tests are deterministic.
 * @returns {{target:number, thisWeek:string|null, thisWeekCount:number, belowTarget:boolean, weeks:{week:string,count:number}[]}}
 */
export function computeWeeklyPace(applications, { target = 8, weeks = 4, now = new Date() } = {}) {
  const weekCounts = new Map();
  for (const a of Array.isArray(applications) ? applications : []) {
    if (!isSubmitted(a.status)) continue;
    const date = String(a.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const wk = isoWeek(date);
    if (wk) weekCounts.set(wk, (weekCounts.get(wk) || 0) + 1);
  }
  // Walk back `weeks - 1` weeks from "now" so the current calendar week is
  // always the last bucket, 0-filled whether or not it has logged anything yet.
  const buckets = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(now.getTime());
    d.setUTCDate(d.getUTCDate() - i * 7);
    const wk = isoWeek(d.toISOString().slice(0, 10));
    if (wk) buckets.push({ week: wk, count: weekCounts.get(wk) || 0 });
  }
  const last = buckets.length ? buckets[buckets.length - 1] : null;
  const thisWeekCount = last ? last.count : 0;
  return {
    target,
    thisWeek: last ? last.week : null,
    thisWeekCount,
    belowTarget: thisWeekCount < target,
    weeks: buckets,
  };
}

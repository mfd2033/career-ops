// Pure parser for data/company-checkups.tsv (公司体检台账, ADR-0025, user-layer).
//
// The ledger's WRITER + validator lives in the repo-root `lib/log-checkup.mjs`
// (single write path, closed risk vocabulary, append-only). web/ cannot import
// across the app boundary (same reason lib/core/url-key.mjs is a mirrored
// copy), so this file mirrors only the tolerant READER half:
//   - skip blanks / `#` header-comment lines / short (truncated) rows;
//   - `risks` is a comma-joined closed set or `-`; readers keep file order.
//
// Match key is the TRACKER NUMBER (the ledger's join key, ADR-0025): checkups
// launched from an evaluated row carry the tracker#; `?` rows (company-name
// mode, invite-match found nothing) only join after a manual backfill — until
// then they are intentionally invisible here. Company-slug matching would need
// a shared slug algorithm the two sides don't have; don't guess (ADR-0025 决议 8).
//
// Plain .mjs like eval-timings.mjs so a node --test suite can lock the
// contract (web/tests/lib/company-checkups.test.mjs).

/** zh labels for the closed risk vocabulary (writer: lib/log-checkup.mjs). */
export const CHECKUP_RISK_LABELS = {
  "social-zero": "参保0人/不缴",
  "social-mismatch": "参保远低于规模",
  "scale-mismatch": "规模虚报",
  "entity-confusion": "主体混淆/壳公司",
  "arbitration": "劳动仲裁/大量投诉",
  "review-negative": "网络口碑负面",
  "tactics": "招聘套路",
  "media-negative": "抖音/高德集中负面",
};

/** Parse the TSV body into rows. Tolerant: skips blanks/#comments, short rows,
 *  and non-numeric stars. `risks: []` for the `-` no-risk sentinel. */
export function parseCheckupLedger(text) {
  const rows = [];
  if (!text) return rows;
  for (const line of String(text).split("\n")) {
    const t = line.replace(/\r$/, "").trim();
    if (!t || t.startsWith("#")) continue;
    const cols = t.split("\t");
    if (cols.length < 8) continue;
    const star = Number.parseFloat(cols[4]);
    if (!Number.isFinite(star)) continue;
    rows.push({
      tracker: cols[0].trim(),
      date: cols[1].trim(),
      slug: cols[2].trim(),
      company: cols[3].trim(),
      star,
      risks: cols[5].trim() === "-" ? [] : cols[5].split(",").map((r) => r.trim()).filter(Boolean),
      html: cols[6].trim(),
      note: (cols[7] ?? "").trim(),
    });
  }
  return rows;
}

/** Latest checkup per tracker#: Record<tracker#, entry>. "Latest" = max date
 *  (ties: file order, last wins). Entry carries the latest row plus history
 *  (chronological {date, star}) and min/max for the tooltip / detail view. */
export function checkupIndex(text) {
  const byTracker = new Map();
  for (const r of parseCheckupLedger(text)) {
    if (!byTracker.has(r.tracker)) byTracker.set(r.tracker, []);
    byTracker.get(r.tracker).push(r);
  }
  const out = {};
  for (const [tracker, rows] of byTracker) {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const latest = sorted[sorted.length - 1];
    const stars = sorted.map((r) => r.star);
    out[tracker] = {
      slug: latest.slug,
      company: latest.company,
      star: latest.star,
      date: latest.date,
      risks: latest.risks,
      note: latest.note,
      html: latest.html,
      count: sorted.length,
      minStar: Math.min(...stars),
      maxStar: Math.max(...stars),
      history: sorted.map((r) => ({ date: r.date, star: r.star })),
    };
  }
  return out;
}

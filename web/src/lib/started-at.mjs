// Worker 「始于」 absolute-clock formatter — a pure, node-free, dependency-free
// helper shared by all three worker display surfaces (tray card, /jobs row,
// /jobs/{id} detail). Lives as a plain .mjs (mirrors score-num.mjs /
// parse-report.mjs) so a `node --test` suite can lock its day-boundary rules
// without the @/ alias. ADR-0044.
//
// Rule (ADR-0044 决议 2): same local calendar day → "HH:MM"; any other day →
// "MM-DD HH:MM". The comparison is against the *browser-local* "today" (this
// runs client-side). Missing/invalid input returns null so callers take the
// ADR-0043 「缺失不占位」 path rather than printing a bogus time.

const pad2 = (n) => String(n).padStart(2, "0");

/** True when both epoch-ms instants fall on the same local calendar day. */
export function isSameLocalDay(aMs, bMs) {
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return false;
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * Format an epoch-ms timestamp as a worker clock label.
 * @param {number|null|undefined} epochMs  the timestamp to render
 * @param {number} [nowMs]                "today" reference (injectable for tests)
 * @returns {string|null} "HH:MM" today, "MM-DD HH:MM" otherwise, null if invalid
 */
export function fmtStartedAt(epochMs, nowMs = Date.now()) {
  if (epochMs == null || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return null;
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (isSameLocalDay(epochMs, nowMs)) return hm;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hm}`;
}

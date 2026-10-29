// Reader half of the blacklist-gate ledger contract (ADR-0084).
//
// The run route records a gate stop as a structured fact — `blockedByBlacklist`
// plus `blockedCompany` — because the ledger is read by machines: the route's
// explanation lands in `msg` in Chinese, and a `done` row carries no `msg` at
// all. Matching on prose is exactly how the blacklist page's per-company counts
// sat at 0 while the gate itself worked fine.
//
// Kept in its own module (plain ESM, no fs) so a test can feed it a ledger and
// compare it against the writer's `blacklistGateLedgerFields` in
// run-cli-support.mjs. Reader and writer drifting apart is the whole defect.

/**
 * Fold run-ledger JSONL text into blacklist-gate stops.
 *
 * @param {string} raw - Contents of `.career-ops-web/runs/index.jsonl`.
 * @param {(value: string) => string} normalizeCompany - Company key normalizer
 *   (the core's `normalizeCompanySafe`, injected so this module stays dependency-free).
 * @returns {{blockedKeys: string[], totalBlocked: number}} Per-run company keys
 *   (one entry per stopped run, empty company dropped) and the total stop count.
 */
export function foldBlacklistGates(raw, normalizeCompany) {
  const blockedKeys = [];
  let totalBlocked = 0;
  for (const line of String(raw ?? "").split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // malformed line — skip, never fatal
    }
    if (rec?.blockedByBlacklist !== true) continue;
    totalBlocked++;
    const key = rec.blockedCompany ? String(normalizeCompany(String(rec.blockedCompany)) ?? "") : "";
    if (key) blockedKeys.push(key);
  }
  return { blockedKeys, totalBlocked };
}

// First number in a score string ("4.1/5", "B+", "3.0") → numeric, or NaN.
//
// Plain .mjs (same pattern as clean-chips.mjs / status-alias.mjs) so BOTH the
// TypeScript format.ts (re-exports it) and a `node --test` unit test can import
// it — a copy inside format.ts is what pipeline-order.mjs could not import
// under Node, and a hand-maintained duplicate would drift again (#2249-family).

/**
 * @param {string} s
 * @returns {number}
 */
export function scoreNum(s) {
  const m = String(s ?? "").match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : NaN;
}

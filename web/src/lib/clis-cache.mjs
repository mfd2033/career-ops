// Browser-side runtime-detection cache (ADR-0015).
//
// The config page auto-detects installed CLIs ONCE per browser: the presence of
// this key IS the "already checked" flag — it is written only after a
// successful detection and makes every later page open render from cache
// without hitting /api/clis. The sole refresh path is the manual re-check
// button, which overwrites this entry with fresh results. A missing key,
// corrupt JSON, or wrong shape all read as "never checked" so the next open
// auto-detects again (a failed first check must not permanently disable it).
//
// Deliberately separate from the `career-ops:config` key: that one holds user
// preferences, this one holds a machine fact — clearing config must not lose
// the detection record, and 8 CLIs' full model lists would bloat it.

const STORAGE_KEY = "career-ops:clis";

/** @type {"career-ops:clis"} */
export const CLIS_CACHE_KEY = STORAGE_KEY;

/**
 * The cached detection, or null when there is no usable one.
 *
 * @returns {{ checkedAt: number, clis: Array<Record<string, unknown>> } | null}
 */
export function readClisCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    // Shape, not contents: the clis entries are whatever /api/clis returned
    // last time — validating them field-by-field here would just duplicate the
    // form's own fallbacks (missing optional fields render as absent).
    if (typeof v?.checkedAt !== "number" || !Array.isArray(v?.clis)) return null;
    return v;
  } catch {
    return null;
  }
}

/**
 * Persist a detection result; checkedAt is taken now, in this browser.
 *
 * @param {Array<Record<string, unknown>>} clis
 */
export function writeClisCache(clis) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ checkedAt: Date.now(), clis }));
  } catch {
    /* quota/private mode — the page still works, it just re-checks next open */
  }
}

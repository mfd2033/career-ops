import path from "node:path";

// Where a runtime's binary may live, per engine (ADR-0052).
//
// `searchDirs()` (clis.ts) is the SHARED list — PATH plus a handful of
// well-known install roots. Some vendors install neither on PATH nor under
// npm's global prefix: Qoder CN unpacks to `%USERPROFILE%\.qodersec\bin`, so
// both of findBin's existing channels miss it and the engine shows up as "not
// installed" with nothing for the user to act on. Such an engine now declares
// its own `binDirs` on its CliSpec, searched only for that engine.
//
// Two rules live here rather than at the call site, because both are easy to
// get subtly wrong and neither throws when broken:
//
//   1. PATH keeps precedence. Vendor dirs are appended, never prepended — a
//      user who deliberately put a binary on PATH must get THAT one.
//   2. Nothing else widens. `binDirs` is per-engine, so a vendor dir can never
//      make another engine's `bin` resolve to something it should not.

/**
 * Resolve a leading `~` against the user's home directory. `home` is injected
 * (rather than read from `os.homedir()` here) so the rule is testable without
 * touching the real environment.
 *
 * @param {string} dir - a CliSpec `binDirs` entry
 * @param {string} home
 * @returns {string} the expanded dir, or `dir` unchanged when it holds no
 *   leading `~`
 */
export function expandHome(dir, home) {
  if (dir === "~") return home;
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return path.join(home, dir.slice(2));
  // Only a leading `~` is a home reference; `~` elsewhere (e.g. `/tmp/~x`) is
  // an ordinary character in a file name and must survive untouched.
  return dir;
}

/**
 * The ordered directory list one engine's binary is looked up in: the shared
 * search dirs first (PATH-derived, so a PATH install always wins), then this
 * engine's own vendor dirs, expanded, deduped, order preserved.
 *
 * @param {string[]} sharedDirs - the shared list (clis.ts's searchDirs())
 * @param {string[]} [vendorDirs] - the engine's `binDirs` (may be absent)
 * @param {string} home - the user's home directory, for `~` expansion
 * @returns {string[]}
 */
export function cliSearchDirs(sharedDirs, vendorDirs, home) {
  const out = [];
  const seen = new Set();
  const extra = (vendorDirs ?? []).map((d) => expandHome(d, home));
  for (const dir of [...(sharedDirs ?? []), ...extra]) {
    // An empty entry would reach findBin as a bare `path.join("", bin)` — i.e.
    // the process cwd — which is never what a search dir means.
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

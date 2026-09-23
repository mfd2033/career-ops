import { execFileSync } from "node:child_process";
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

// ---------------------------------------------------------------------------
// Vendor products that BUNDLE a runtime's CLI inside their own install tree.
//
// WorkBuddy (Tencent's desktop agent) ships the complete CodeBuddy Code CLI at
// `<install dir>\resources\app.asar.unpacked\cli\` — `bin\codebuddy` plus the
// 22 MB bundle and its own node_modules. That copy is dispatched through the
// interpreter (spawn-cli.mjs's spawnTargetFor), which makes it usable with no
// install step at all (ADR-0053).
//
// The directory cannot be declared as a `binDirs` entry: it is wherever the
// user installed that product (`D:\workbuddy` here), which is one machine's
// layout and must never be frozen into shipped code. So it is located at
// runtime from the Windows uninstall registry — the standard, drive-independent
// way to ask "where is this product installed". `InstallLocation` is empty for
// WorkBuddy, but `DisplayIcon`/`UninstallString` carry the real path.
// ---------------------------------------------------------------------------

/** Where the bundled CLI sits inside the product's install dir. */
const WORKBUDDY_CLI_SUBPATH = ["resources", "app.asar.unpacked", "cli", "bin"];

/** The registry keys a per-user vs per-machine install can land in. */
const UNINSTALL_ROOTS = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/**
 * Expand `%VAR%` references against an injected environment. Unknown variables
 * make the value unusable, and the caller drops it — a path we cannot resolve
 * is worse than no path, because it would be handed to findBin as a directory
 * that silently does not exist.
 *
 * @param {string} value
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function expandVars(value, env) {
  if (!value.includes("%")) return value;
  let unresolved = false;
  const out = value.replace(/%([^%]+)%/g, (_, name) => {
    const found = env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()];
    if (!found) {
      unresolved = true;
      return "";
    }
    return found;
  });
  return unresolved ? null : out;
}

/**
 * The install directory a registry key block points at, taken from the paths it
 * records. Both value shapes that appear in the wild are handled:
 * `D:\dir\App.exe,0` (DisplayIcon, comma-indexed) and
 * `"D:\dir\Uninstall App.exe" /currentuser` (quoted, with switches).
 *
 * @param {Record<string, string>} values - lowercased value names → raw data
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function installDirFrom(values, env) {
  for (const raw of [values.displayicon, values.uninstallstring]) {
    if (!raw) continue;
    const expanded = expandVars(raw.trim(), env);
    if (!expanded) continue;
    const quoted = /^"([^"]+)"/.exec(expanded);
    const candidate = (quoted ? quoted[1] : expanded.replace(/,\d+\s*$/, "").split(/\s+\//)[0]).trim();
    if (!candidate || !/\.exe$/i.test(candidate)) continue;
    const dir = path.dirname(candidate);
    if (dir && dir !== ".") return dir;
  }
  return null;
}

/**
 * The bundled-CLI directories a `reg query` dump names, in the order the keys
 * appear. Pure: the registry text and the environment are both injected, so the
 * rule is testable without touching this machine's registry.
 *
 * @param {string} regOutput - stdout of a `reg query … /s /f WorkBuddy /d`
 * @param {Record<string, string|undefined>} [env]
 * @returns {string[]}
 */
export function parseWorkbuddyCliDirs(regOutput, env = {}) {
  const blocks = [];
  let current = null;
  for (const line of String(regOutput ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^HKEY_/i.test(trimmed)) {
      current = { key: trimmed, values: {} };
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    const m = /^\s+(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line);
    if (m) current.values[m[1].toLowerCase()] = m[2];
  }

  const out = [];
  for (const block of blocks) {
    const haystack = [block.values.displayname, block.values.displayicon, block.values.uninstallstring]
      .filter(Boolean)
      .join(" ");
    if (!/workbuddy/i.test(haystack)) continue;
    const dir = installDirFrom(block.values, env);
    if (dir) out.push(path.join(dir, ...WORKBUDDY_CLI_SUBPATH));
  }
  return [...new Set(out)];
}

/**
 * Locate the CodeBuddy CLI bundled inside WorkBuddy, if this machine has it.
 *
 * Synchronous (like every other lookup in detection) and never throws: the
 * product may be absent, `reg` may be unavailable, or the key may hold nothing
 * usable — all of which simply mean "no fallback directory".
 *
 * @returns {string[]}
 */
export function workbuddyBundledCliDirs() {
  if (process.platform !== "win32") return [];
  const found = [];
  for (const root of UNINSTALL_ROOTS) {
    try {
      const out = execFileSync("reg", ["query", root, "/s", "/f", "WorkBuddy", "/d"], {
        encoding: "utf8",
        timeout: 15_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      found.push(...parseWorkbuddyCliDirs(out, process.env));
    } catch {
      /* key absent, no match, or reg unavailable — nothing to add */
    }
  }
  return [...new Set(found)];
}

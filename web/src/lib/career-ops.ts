import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "@/lib/core/safe-write";
import { parseApplications } from "@/lib/tracker-table.mjs";
// One definition of the `{n}-RESERVED.md` convention, shared with
// run-cli-support.mjs — see report-files.mjs for why it lives there.
import { isReservedReportFile } from "@/lib/report-files.mjs";
// Reuse the canonical tolerant report parser (format.ts is explicitly shared
// by server + client, no fs). One definition of `**URL:**` extraction.
import { parseReport } from "@/lib/format";

/**
 * Resolve the career-ops "home" — the directory holding the user's sibling
 * files (cv.md, data/, reports/). In production the web/ app lives inside the
 * career-ops checkout, so the home is its parent (..). Dev overrides via
 * CAREER_OPS_ROOT to read the user's real (gitignored) data from a separate
 * checkout — see web/.env.local.
 *
 * The cwd-based default must not assume where the server was started from:
 * `next dev` runs with cwd = web/ (so ".." is home), but the standalone
 * production server (web/.next/standalone/server.js) calls process.chdir() on
 * itself, making the cwd's parent web/.next — not home. So when the fast path
 * does not look like a career-ops root, probe upward until a directory that
 * actually holds the user's files (cv.md or data/applications.md) is found.
 */
export function careerOpsRoot(): string {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return env;
  // Fast path: dev layout (cwd = web/), where the parent already is home.
  const devHome = path.resolve(process.cwd(), "..");
  if (looksLikeHome(devHome)) return devHome;
  // Standalone layout: probe upward from the cwd, capped so a stray marker
  // far up the tree cannot hijack the root.
  let dir = path.resolve(process.cwd());
  for (let depth = 0; depth < 8; depth++) {
    if (looksLikeHome(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return devHome;
}

/** True when `dir` holds the user's files — the career-ops home marker. */
function looksLikeHome(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, "cv.md")) ||
      fs.existsSync(path.join(dir, "data", "applications.md"))
    );
  } catch {
    return false;
  }
}

/**
 * Absolute path to a core root script (e.g. doctor, verify-portals). The `.mjs`
 * is assembled here from the bare name so the literal never appears as a direct
 * `execFile`/`spawn` argument — Next's bundler statically traces such literals
 * as module imports and fails the production build otherwise.
 */
export function rootScript(nameNoExt: string): string {
  return path.join(careerOpsRoot(), `${nameNoExt}.mjs`);
}

// Feature-detect the core's `tracker.mjs delete --num` row-delete (#1200) by probing
// the local script source — older checkouts lack it, so the delete UI hides itself.
export function trackerCanDelete(): boolean {
  try {
    const src = fs.readFileSync(rootScript("tracker"), "utf8");
    return src.includes("delete") && src.includes("--num");
  } catch {
    return false;
  }
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

export type InboxJob = { url: string; company: string; role: string; location?: string; compensation?: string; done: boolean; postedAt?: string };

/** A pipeline-row segment like `posted: 2026-07-14`, `trust: 62 stale` or
 *  `note: …` — the core appends these LABELED segments after whatever
 *  positional shape a row has (3/4/5 columns), so a naive positional reader
 *  would misread them as location/compensation on short rows. Any
 *  `word:`-prefixed segment is treated as labeled (forward-compatible with
 *  labels the core hasn't invented yet). */
const LABELED_SEGMENT = /^([a-z][a-z_-]*):\s*(.*)$/i;

/** Parse data/pipeline.md — `- [ ] URL | Company | Role [| Location [| Compensation]] [| label: …]*`.
 *  Positional split for the first columns (the optional 4th `location` #1015
 *  and 5th `compensation` #1017 must NOT bleed into `role`); labeled segments
 *  (posted:/trust:/note:/…) are filtered out of positional assignment wherever
 *  they appear and surfaced when useful (posted: → postedAt). Unknown labels
 *  and further trailing columns are ignored gracefully. */
export function readInbox(): InboxJob[] {
  const md = read("data/pipeline.md");
  if (!md) return [];
  const jobs: InboxJob[] = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const all = m[2].split("|").map((s) => s.trim());
    const labels = new Map<string, string>();
    const parts: string[] = [];
    for (const [i, seg] of all.entries()) {
      // the URL cell can contain a colon-y value but is always position 0
      const lm = i >= 3 ? seg.match(LABELED_SEGMENT) : null;
      if (lm) labels.set(lm[1].toLowerCase(), lm[2].trim());
      else parts.push(seg);
    }
    if (parts.length < 3 || !parts[0]) continue; // need at least url | company | role
    const posted = labels.get("posted");
    jobs.push({
      done: m[1].toLowerCase() === "x",
      url: parts[0],
      company: parts[1],
      role: parts[2],
      location: parts[3] || undefined, // optional 4th column (#1015)
      compensation: parts[4] || undefined, // optional 5th column (#1017); 6th+ ignored
      // the row's own posting date (scan.mjs `posted:` label) — a more direct
      // freshness signal than the scan-history join, which stays as fallback
      postedAt: posted && /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : undefined,
    });
  }
  return jobs;
}

/**
 * Read data/scan-history.tsv → Map<url, first_seen(YYYY-MM-DD)>. The scanner
 * already stamps every discovered posting with the date it was first seen
 * (col 2), so we derive the inbox's freshness signal here WITHOUT touching the
 * core (see the inbox-triage build: freshness = option A, no scanner change).
 * Tolerant by construction: no file → empty map (freshness facet just hides);
 * a malformed row is skipped, never thrown (missing ≠ corrupt).
 */
export function readScanDates(): Map<string, string> {
  const tsv = read("data/scan-history.tsv");
  const dates = new Map<string, string>();
  if (!tsv) return dates;
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue; // skip header
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const url = line.slice(0, tab);
    const firstSeen = line.slice(tab + 1).split("\t")[0]?.trim();
    // keep the EARLIEST first_seen if a url recurs (it's "first" seen, after all)
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(url)) dates.set(url, firstSeen);
  }
  return dates;
}

export type Application = {
  n: string;
  date: string;
  /** Most recent re-evaluation date ("" when never re-evaluated). The Date
   *  column keeps the INITIAL evaluation date (#2808, 方向 A); this field
   *  carries the freshest `Re-eval YYYY-MM-DD` marker lifted from the notes. */
  revalDate: string;
  company: string;
  /** Intermediary channel (#1596): agency/recruiter firm, "—" for direct, "" when the tracker has no Via column. */
  via: string;
  role: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
};

/**
 * Parse data/applications.md — the tracker table (source of truth).
 * The header-aware parsing lives in tracker-table.mjs, which resolves headers
 * through the SAME alias table the Node tooling uses (tracker-aliases.json,
 * exported by tracker-parse.mjs as HEADER_ALIASES) — one shared source, no
 * web-side mirror to drift (#954, PR #1598 review).
 */
export function readApplications(): Application[] {
  const md = read("data/applications.md");
  if (!md) return [];
  return parseApplications(md, careerOpsRoot());
}

/**
 * Server-side lifecycle of the user's setup — mirrors the prerequisite list that
 * doctor.mjs uses (cv.md, config/profile.yml, modes/_profile.md, portals.yml), by
 * plain file-stat (no subprocess). Drives the home branch: first-run (no CV) →
 * the CV takeover; in-between (CV but no profile) → gentle nudges; established.
 */
export type LifecyclePhase = "first-run" | "in-between" | "established";
/**
 * Server-side lifecycle, mirroring the core doctor.mjs prerequisite list with the
 * SAME existsSync semantics (the SSOT the OnboardingBanner already reads via
 * /api/doctor). The 4 user-layer prereqs: cv.md, config/profile.yml,
 * modes/_profile.md, portals.yml.
 *   - first-run  → a TRULY empty install (no cv AND no data): the CV takeover.
 *     CRITICAL back-compat (maintainer): NEVER force onboarding on a user who
 *     already has data (a full pipeline/tracker with no cv.md is valid).
 *   - in-between → has cv/data but setup incomplete: dashboard + the nudge banner.
 *   - established → all 4 prereqs present.
 * onboardingNeeded mirrors doctor.mjs: true if ANY prereq is missing → show banner.
 */
export function doctorState(): {
  phase: LifecyclePhase;
  onboardingNeeded: boolean;
  missing: string[];
  hasCv: boolean;
  hasData: boolean;
} {
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(careerOpsRoot(), rel));
    } catch {
      return false;
    }
  };
  const prereqs: [string, string][] = [
    ["cv.md", "cv.md"],
    ["config/profile.yml", "config/profile.yml"],
    ["modes/_profile.md", "modes/_profile.md"],
    ["portals.yml", "portals.yml"],
  ];
  const missing = prereqs.filter(([rel]) => !has(rel)).map(([, label]) => label);
  const hasCv = has("cv.md");
  const hasData = readApplications().length > 0 || readInbox().some((j) => !j.done);
  const onboardingNeeded = missing.length > 0;
  const phase: LifecyclePhase = !hasCv && !hasData ? "first-run" : onboardingNeeded ? "in-between" : "established";
  return { phase, onboardingNeeded, missing, hasCv, hasData };
}

export type PipelineSummary = {
  root: string;
  rootExists: boolean;
  inbox: InboxJob[];
  applications: Application[];
};

export function pipelineSummary(): PipelineSummary {
  const root = careerOpsRoot();
  const scanDates = readScanDates();
  return {
    root,
    rootExists: fs.existsSync(root),
    // join the freshness date (first_seen) onto each raw posting — the inbox's
    // triage view orders/faceted-filters on it entirely client-side.
    inbox: readInbox().map((j) => ({ ...j, postedAt: j.postedAt ?? scanDates.get(j.url) })),
    applications: readApplications(),
  };
}

export type ReportData = { content: string; file: string };

/** Locate the evaluation report for an application number.
 *  The tracker row's own report link is authoritative: report FILE numbers can
 *  differ from application numbers (e.g. app #309 → reports/308-…), so
 *  resolving only by leading filename number misses those. Links are
 *  normalized relative to the tracker file's directory (see #760). Falls back
 *  to the filename scan (reports/{n}-{slug}-{date}.md, possibly zero-padded)
 *  for rows without a parseable link.
 *
 *  Both the linked lookup and the fallback scan skip `{n}-RESERVED.md`
 *  placeholder files.
 *  `reserve-report-num.mjs` writes an empty `NNN-RESERVED.md` sentinel to
 *  claim a report number before a worker has actually written the report;
 *  it's normally deleted once the real report lands (or GC'd after 4h if
 *  abandoned). But "RESERVED" sorts alphabetically before nearly every real
 *  slug (company names start with lowercase/uppercase letters after the
 *  number-dash, "R" often lands mid-alphabet or earlier), so if a sentinel
 *  outlives its report — e.g. a worker was driven directly instead of
 *  through the orchestrator that owns cleanup — `.find()` could return the
 *  empty sentinel instead of the real report, making the report body and the
 *  Apply/PDF-ready checks disappear. */
export function findReportFile(n: string): string | null {
  const target = parseInt(n, 10);
  if (Number.isNaN(target)) return null;
  const root = careerOpsRoot();
  const app = readApplications().find((a) => parseInt(a.n, 10) === target);
  const linked = app?.report.match(/\]\(([^)]+)\)/)?.[1];
  if (linked) {
    const p = path.resolve(root, "data", linked);
    // Containment: a hand-edited link must not resolve outside the project.
    if (p.endsWith(".md") && !isReservedReportFile(p) && containedRealpath(p, root)) return p;
  }
  let files: string[];
  try {
    files = fs.readdirSync(path.join(root, "reports"));
  } catch {
    return null;
  }
  const match = files.find(
    (f) => f.endsWith(".md") && !isReservedReportFile(f) && parseInt(f, 10) === target,
  );
  if (!match) return null;
  const p = path.join(root, "reports", match);
  return containedRealpath(p, root) ? p : null;
}

/** True containment check: resolves symlinks before comparing, so a link
 *  planted under data/ or reports/ can't leak files outside the project. */
function containedRealpath(p: string, root: string): boolean {
  try {
    return fs.realpathSync(p).startsWith(fs.realpathSync(root) + path.sep);
  } catch {
    return false; // missing file or unresolvable link — treat as not found
  }
}

export function readReport(n: string): ReportData | null {
  const file = findReportFile(n);
  if (!file) return null;
  try {
    return { content: fs.readFileSync(file, "utf8"), file: path.basename(file) };
  } catch {
    return null;
  }
}

export function findApplication(n: string): Application | null {
  return readApplications().find((a) => a.n === n) ?? null;
}

/**
 * Resolve the report file path for an ALREADY-parsed Application, without the
 * `readApplications()` re-read that `findReportFile(n)` does. Same containment +
 * RESERVED-sentinel rules as `findReportFile`. Used by batch read paths that
 * loop over many applications — re-reading the tracker file per app would be
 * O(n²) FS reads (#749-class regression). Returns null if the link is missing
 * or the file can't be resolved safely.
 */
function resolveReportPathFor(app: Application): string | null {
  const root = careerOpsRoot();
  const linked = app.report.match(/\]\(([^)]+)\)/)?.[1];
  if (linked) {
    const p = path.resolve(root, "data", linked);
    if (p.endsWith(".md") && !isReservedReportFile(p) && containedRealpath(p, root)) return p;
  }
  // Fallback: scan reports/ for a file whose leading number matches app.n.
  // Mirrors findReportFile's fallback so a hand-edited or missing link still
  // resolves the right report.
  let files: string[];
  try {
    files = fs.readdirSync(path.join(root, "reports"));
  } catch {
    return null;
  }
  const target = parseInt(app.n, 10);
  if (Number.isNaN(target)) return null;
  const match = files.find(
    (f) => f.endsWith(".md") && !isReservedReportFile(f) && parseInt(f, 10) === target,
  );
  if (!match) return null;
  const p = path.join(root, "reports", match);
  return containedRealpath(p, root) ? p : null;
}

/** Read a single application's posting URL from its report's `**URL:**` header
 *  field. Returns undefined when the report is missing, has no URL field, or
 *  the URL isn't an http(s) link (the re-evaluate worker requires an absolute
 *  URL — see ReevaluateButton's `url.startsWith("http")` guard). */
export function readApplicationUrl(app: Application): string | undefined {
  const file = resolveReportPathFor(app);
  if (!file) return undefined;
  try {
    const md = fs.readFileSync(file, "utf8");
    const url = parseReport(md).fields.find((f) => f.label === "URL")?.value;
    return url && /^https?:\/\//i.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Batch read posting URLs for a set of applications → Record<n, url> covering
 * ONLY the apps whose report resolves to a real http(s) URL. Drives the batch
 * re-evaluate flow: the client fires one `kind:"evaluate"` job per entry here.
 * Tolerant by construction — a missing report or non-http URL simply drops
 * that entry from the map; the caller surfaces "N of M re-evaluatable".
 */
export function readApplicationUrls(apps: Application[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const app of apps) {
    const url = readApplicationUrl(app);
    if (url) out[app.n] = url;
  }
  return out;
}

/** The CANONICAL user-customization file the CLI/TUI reads. Durable facts the
 *  web assistant learns go HERE (single source of truth) inside a managed marker
 *  block — so the CLI sees them too. No web-only memory store (that would drift). */
export function profilePath(): string {
  return path.join(careerOpsRoot(), "modes", "_profile.md");
}

const NOTES_START = "<!-- co-web-notes:start -->";
const NOTES_END = "<!-- co-web-notes:end -->";

/** Read back ONLY the web-assistant managed notes from modes/_profile.md (small,
 *  focused — the agent reads the rest of the canonical files itself). Falls back
 *  to the legacy web-only memory file for back-compat. */
export function readMemory(): string {
  try {
    const md = fs.readFileSync(profilePath(), "utf8");
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) return md.slice(i + NOTES_START.length, j).trim();
  } catch {
    /* no _profile.md yet */
  }
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), ".career-ops-web", "memory.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Append a durable fact to the canonical modes/_profile.md (creating the file +
 *  managed block if needed), PRESERVING existing user content. */
export function rememberFact(fact: string): "ok" | "deduped" | "error" {
  const f = fact.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!f) return "deduped";
  const p = profilePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let md = "";
    try {
      md = fs.readFileSync(p, "utf8");
    } catch {
      md = "";
    }
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) {
      if (md.slice(i, j).includes(f)) return "deduped";
      atomicWrite(p, md.slice(0, j) + `- ${f}\n` + md.slice(j));
      return "ok";
    }
    if (md.includes(f)) return "deduped";
    const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
    const base = md.trim() ? md.replace(/\n*$/, "\n") : "# Profile customization\n";
    atomicWrite(p, base + section);
    return "ok";
  } catch {
    return "error";
  }
}

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { careerOpsRoot, readApplications } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { foldBlacklistGates } from "@/lib/blacklist-gate.mjs";

// Server-only store for the user's do-not-apply list (data/blacklist.md,
// ADR-0084). The table parse/serialize/exemption logic is NOT mirrored here —
// it is dynamically imported from the repo-root lib/blacklist.mjs so scan.mjs
// and this route share ONE implementation (#954 drift lesson). fs, the clock
// and the shadow-backup subprocess live only on this server side.

export type BlacklistRow = {
  company: string;
  since: string;
  scope: string;
  exemptUntil: string;
  reason: string;
};

export type BlacklistEntry = BlacklistRow & {
  /** Whether the exemption window is open as of `today` (exemptUntil >= today). */
  exemptActive: boolean;
  /** Tracker rows (evaluations) whose company matches → their report numbers. */
  reportRefs: string[];
  /** Count of matching tracker evaluations. */
  reports: number;
  /** Count of scan-history postings from this company. */
  postings: number;
  /** Count of evaluate runs that stopped on this company's blacklist gate. */
  blocked: number;
};

/** The root lib is pure ESM; load it from the checkout at runtime so scan.mjs
 *  and this route share ONE parser (ADR-0084). The `webpackIgnore` magic
 *  comment is required: without it Turbopack tries to statically trace the
 *  computed path and the packaged server throws "Cannot find module as
 *  expression is too dynamic" (same technique as core/text-key.ts loading the
 *  core's tracker-parse.mjs). The file ships in SYSTEM_PATHS, so it is present
 *  at careerOpsRoot()/lib/blacklist.mjs at runtime. */
async function loadBlacklistLib(): Promise<any> {
  const p = path.join(careerOpsRoot(), "lib", "blacklist.mjs");
  return import(/* webpackIgnore: true */ pathToFileURL(p).href);
}

/** Today's calendar day where the user actually is — NOT the UTC day.
 *
 *  `new Date().toISOString().slice(0, 10)` answers with tomorrow west of
 *  Greenwich and a future date east of it, which is the defect class
 *  lib/local-today.mjs was created to kill (#2765, #2932). This value decides
 *  whether an `Exempt until` window is open, so getting it wrong shifts the gate
 *  by a whole day. Loaded from the checkout at runtime for the same reason as
 *  loadBlacklistLib: one implementation, shared with the CLI side. */
export async function localTodayStr(): Promise<string> {
  const p = path.join(careerOpsRoot(), "lib", "local-today.mjs");
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(p).href);
  return mod.localToday();
}

function blacklistPath(): string {
  return path.join(careerOpsRoot(), "data", "blacklist.md");
}

function readRaw(): string {
  try {
    return fs.readFileSync(blacklistPath(), "utf8");
  } catch {
    return "";
  }
}

/** Join the tracker, scan history and the run ledger onto each blacklist row.
 *  Every source degrades to empty when absent — a missing file is not an error.
 *  Company keys match by CONTAINMENT (either direction), not exact equality: a
 *  blacklist row often holds the short name ("中犇科技") while the tracker /
 *  scan history / run marker carry the full legal name ("中犇科技有限公司"),
 *  and normalizeCompany does not strip the "有限公司" suffix. */
export async function readBlacklist(today: string): Promise<{ entries: BlacklistEntry[]; totalBlocked: number }> {
  const lib = await loadBlacklistLib();
  const { rows } = lib.readBlacklistTable(readRaw());
  const keyMatch = (a: string, b: string) => !!a && !!b && (a.includes(b) || b.includes(a));

  const reportPairs: { key: string; num: string }[] = [];
  for (const a of readApplications()) {
    const k = lib.normalizeCompanySafe(a.company) as string;
    if (k) reportPairs.push({ key: k, num: a.n });
  }
  const scanKeys = scanHistoryCompanyKeys(lib);
  const { blockedKeys, totalBlocked } = blacklistRunCompanies(lib);

  const entries: BlacklistEntry[] = rows.map((r: BlacklistRow) => {
    const k = lib.normalizeCompanySafe(r.company) as string;
    const refs = reportPairs.filter((p) => keyMatch(k, p.key)).map((p) => p.num);
    return {
      ...r,
      exemptActive: lib.isExemptActive(r.exemptUntil, today),
      reportRefs: refs,
      reports: refs.length,
      postings: scanKeys.filter((s) => keyMatch(k, s)).length,
      blocked: blockedKeys.filter((s) => keyMatch(k, s)).length,
    };
  });
  return { entries, totalBlocked };
}

function scanHistoryCompanyKeys(lib: any): string[] {
  const out: string[] = [];
  let tsv = "";
  try {
    tsv = fs.readFileSync(path.join(careerOpsRoot(), "data", "scan-history.tsv"), "utf8");
  } catch {
    return out;
  }
  const lines = tsv.replace(/\r/g, "").split("\n").filter(Boolean);
  if (!lines.length) return out;
  const header = lines[0].split("\t").map((h) => h.trim());
  const ncIdx = header.indexOf("normalized_company");
  const coIdx = header.indexOf("company");
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const raw = (ncIdx >= 0 ? cols[ncIdx] : cols[coIdx]) || "";
    const k = lib.normalizeCompanySafe(raw) as string;
    if (k) out.push(k);
  }
  return out;
}

/** Read the ledger and fold it (see blacklist-gate.mjs for the field contract).
 *  A missing/unreadable ledger is zeros, not an error — the blacklist page must
 *  still render on a fresh checkout. */
function blacklistRunCompanies(lib: any): { blockedKeys: string[]; totalBlocked: number } {
  let raw = "";
  try {
    raw = fs.readFileSync(path.join(careerOpsRoot(), ".career-ops-web", "runs", "index.jsonl"), "utf8");
  } catch {
    return { blockedKeys: [], totalBlocked: 0 };
  }
  return foldBlacklistGates(raw, (value) => (lib.normalizeCompanySafe(value) as string) || "");
}

/** Snapshot the data layer to the shadow ledger before a write (AGENTS.md
 *  mandate). Non-zero exit aborts the write — never rewrite user data without
 *  the safety net. A missing script (fresh checkout) is skipped, not fatal. */
function runShadowBackup(): { ok: boolean; note?: string } {
  const root = careerOpsRoot();
  const cmd = path.join(root, "local", "backup-data.cmd");
  if (!fs.existsSync(cmd)) return { ok: true, note: "no backup-data.cmd; skipped" };
  try {
    execFileSync("cmd.exe", ["/c", cmd], { cwd: root, stdio: "pipe", timeout: 60_000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

/** Persist rows (shadow-ledger snapshot + per-file .bak, then atomic write).
 *  Throws if the shadow backup fails, aborting the write. */
export async function writeBlacklist(preamble: string, rows: BlacklistRow[]): Promise<void> {
  const lib = await loadBlacklistLib();
  const bk = runShadowBackup();
  if (!bk.ok) throw new Error(`shadow backup failed: ${bk.note}`);
  const text = lib.renderBlacklistTable(preamble, rows);
  atomicWriteWithBackup(blacklistPath(), text);
}

/** Read the current preamble + rows so a mutation can preserve the user's prose. */
export async function readPreambleAndRows(): Promise<{ preamble: string; rows: BlacklistRow[] }> {
  const lib = await loadBlacklistLib();
  const { preamble, rows } = lib.readBlacklistTable(readRaw());
  return { preamble, rows };
}

/** Pure row mutators, sourced from the shared lib so keying matches the parser. */
export async function mutators() {
  const lib = await loadBlacklistLib();
  return { addRow: lib.addRow as Function, removeRow: lib.removeRow as Function, setExempt: lib.setExempt as Function };
}

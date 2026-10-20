#!/usr/bin/env node

/**
 * tracker-add.mjs — canonical CLI to append ONE row to data/applications.md.
 *
 * Every other tracker writer already exists (set-status for a status cell,
 * mark-pdf-ready for the PDF cell, merge-tracker for batch TSVs), but there was
 * no way to CREATE a single row from a machine caller: the HTTP layer and
 * external tools had to edit the markdown directly, which bypasses the shared
 * lock and the canonical-state validation. This is that missing single-row
 * writer, and the entry point POST /api/tracker (and PUT /api/tracker/upsert)
 * delegates to.
 *
 * Usage:
 *   node tracker-add.mjs --company "Acme" --role "Engineer" [--date YYYY-MM-DD]
 *                        [--via "Agency"] [--url https://…] [--score 4.2/5]
 *                        [--status Applied] [--notes "..."]
 *                        [--update-on-match] [--dry-run] [--json]
 *
 * Contract (mirrors set-status.mjs so the two can never disagree):
 *   - The read-modify-write runs under the shared tracker lock and the file is
 *     replaced atomically; every byte outside the inserted row round-trips.
 *   - --status goes through templates/states.yml (labels, ids and aliases), and
 *     anything else is rejected BEFORE the tracker is touched.
 *   - Dedup key: the normalized posting URL (url-key.mjs) when there is one.
 *     Without a usable URL the row falls back to the company key + fuzzy role
 *     match (the same predicate merge-tracker uses), because a duplicate row
 *     costs a real application: it splits the history and re-applies work.
 *   - A duplicate is NOT an error: the CLI reports the existing row's number and
 *     exits 0, so a retried POST is idempotent instead of creating a second row.
 *     --update-on-match turns that into an in-place update of the fields supplied
 *     on the command line (PUT /api/tracker/upsert); --note APPENDS to the Notes
 *     cell there rather than replacing it, the way set-status.mjs --note does.
 *
 * Exit codes: 0 success (including the duplicate verdict) · 1 usage error,
 * non-canonical state, unreadable states.yml, or non-retryable lock/write
 * failure · 2 tracker file missing / unreadable · 4 tracker lock timeout
 * (busy — retry later).
 *
 * With --json a single JSON document is printed on stdout LAST (errors
 * included), so a caller can read the result from the end of the stream even
 * when a diagnostic preceded it.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isHeaderRow, parseTrackerRow, resolveColumns, SEPARATOR_ROW_RE,
} from './tracker-parse.mjs';
import { roleFuzzyMatch } from './role-matcher.mjs';
import { normalizeUrl } from './url-key.mjs';
import { localToday } from './lib/local-today.mjs';
import {
  buildTrackerRow, cell, normalizeCompany, resolveTrackerPath, writeFileAtomic,
  loadCanonicalStates, resolveCanonicalState, CLI_EXIT, makeCliFailWith,
  acquireTrackerLockForCli,
} from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const STATES_FILE = join(CAREER_OPS, 'templates/states.yml');

const { OK: EXIT_OK, USAGE: EXIT_USAGE, NOT_FOUND: EXIT_NOT_FOUND } = CLI_EXIT;

const USAGE = `Usage: node tracker-add.mjs --company "Acme" --role "Engineer" [options]

  --company TEXT     Employer name (required)
  --role TEXT        Role title (required)
  --date YYYY-MM-DD  Row date (defaults to today, local calendar day)
  --via TEXT         Intermediary channel (agency/recruiter firm; '—' for direct)
  --url URL          Posting URL — the stable dedup key
  --score N/5        Evaluation score as "4.2/5", or a sentinel (—, N/A)
  --status STATE     Canonical state from templates/states.yml (default: Applied)
  --note TEXT        Notes cell contents
  --update-on-match  On a duplicate, update the supplied fields on the existing
                     row instead of creating nothing (upsert semantics)
  --dry-run          Resolve and de-duplicate, but write nothing
  --json             Machine-readable output on stdout (errors included)

  A duplicate (same normalized URL, or same company + fuzzy-matching role) is
  reported as verdict "duplicate" with the existing row number and exit code 0.
  Nothing is written in that case.`;

// ── argument parsing ─────────────────────────────────────────────

const rawArgs = process.argv.slice(2);
const flags = {
  company: null, role: null, date: null, via: null, url: null, score: null,
  status: null, note: null, updateOnMatch: false, dryRun: false, json: false,
};
const VALUE_FLAGS = {
  '--company': 'company', '--role': 'role', '--date': 'date', '--via': 'via',
  '--url': 'url', '--score': 'score', '--status': 'status', '--note': 'note',
};

/**
 * Print usage (plus an optional specific complaint) and exit 1.
 *
 * JSON mode is detected from the raw argv: failUsage can fire mid-parse, before
 * flags.json is settled, and a machine caller must still get one parsable
 * document instead of usage prose.
 *
 * @param {string|null} message
 * @returns {never}
 */
function failUsage(message) {
  const msg = message ?? 'Usage: node tracker-add.mjs --company "Acme" --role "Engineer"';
  if (rawArgs.includes('--json')) {
    console.log(JSON.stringify({ error: msg, code: 'usage' }));
    console.error(`❌ ${msg}`);
  } else {
    if (message) console.error(`❌ ${message}\n`);
    console.error(USAGE);
  }
  process.exit(EXIT_USAGE);
}

for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg in VALUE_FLAGS) {
    const value = rawArgs[i + 1];
    // Never consume a following flag as the value: "--note --dry-run" would
    // silently turn a preview into a real write.
    if (value === undefined || value.startsWith('--')) failUsage(`Missing value for ${arg}`);
    flags[VALUE_FLAGS[arg]] = value;
    i++;
  } else if (arg === '--update-on-match') { flags.updateOnMatch = true; }
  else if (arg === '--dry-run') { flags.dryRun = true; }
  else if (arg === '--json') { flags.json = true; }
  else if (arg.startsWith('--')) { failUsage(`Unknown flag: ${arg}`); }
  else { failUsage(`Unexpected argument: ${arg}`); }
}

// Built AFTER the argv parse: makeCliFailWith captures the flag, and a failWith
// constructed before --json is read would never emit the JSON document that
// machine callers rely on (errors included).
const failWith = makeCliFailWith(flags.json);

const company = cell(flags.company);
const role = cell(flags.role);
if (!company) failUsage('--company is required');
if (!role) failUsage('--role is required');

const date = flags.date ?? localToday();
{
  const shaped = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const parsed = shaped ? new Date(`${date}T00:00:00Z`) : null;
  const real = parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  // Round-trip check stays on UTC on purpose: this is date PARSING, not "what
  // day is it here" (that is localToday's job).
  if (!real) failUsage(`--date expects a real calendar date as YYYY-MM-DD, got "${date}"`);
}

// ── field validation (before anything touches the tracker) ──────

const SCORE_CELL = /^\d+(?:\.\d+)?\/5$/;
const score = flags.score === null ? '—' : cell(flags.score) || '—';
if (!SCORE_CELL.test(score) && score !== '—' && score !== 'N/A' && score !== 'DUP' && score !== '-') {
  failWith(EXIT_USAGE, 'invalid-field', `--score expects "N/5" (e.g. 4.2/5) or a sentinel (—, N/A, DUP), got "${flags.score}"`);
}

let states;
try {
  states = loadCanonicalStates(STATES_FILE);
} catch (err) {
  failWith(EXIT_USAGE, 'states-error', `Cannot load canonical states from ${STATES_FILE}: ${err.message}`);
}
const statusInput = flags.status ?? 'Applied';
const status = resolveCanonicalState(statusInput, states);
if (!status) {
  const valid = states.map(s => s.label).join(' · ');
  failWith(EXIT_USAGE, 'invalid-state', `"${statusInput}" is not a canonical state. Valid states: ${valid}`);
}

const via = flags.via === null ? '—' : (cell(flags.via) || '—');
const url = flags.url === null ? '' : cell(flags.url);
const note = flags.note === null ? '' : cell(flags.note);

// ── tracker access ──────────────────────────────────────────────

const APPS_FILE = resolveTrackerPath(CAREER_OPS);
if (!existsSync(APPS_FILE)) {
  failWith(EXIT_NOT_FOUND, 'no-tracker', `No tracker found at ${APPS_FILE}`);
}

const lock = await acquireTrackerLockForCli(APPS_FILE, { dryRun: flags.dryRun, failWith });

let content;
try {
  content = readFileSync(APPS_FILE, 'utf-8');
} catch (err) {
  failWith(EXIT_NOT_FOUND, 'read-failure', `Cannot read tracker at ${APPS_FILE}: ${err.message}`);
}

const lines = content.split('\n');
const colmap = resolveColumns(lines);

const rows = [];
for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i], colmap);
  if (row) rows.push({ ...row, lineIdx: i });
}

// ── duplicate detection ─────────────────────────────────────────

// A conflicting URL is PROOF the two rows are different postings, so a row that
// carries one must never be claimed by the heuristic below — the same
// asymmetry merge-tracker's Pass 0 encodes (unknown is not evidence, but two
// present-and-different keys are).
const addUrlKey = normalizeUrl(url);
const urlBlocksHeuristic = (row) => {
  const rowKey = normalizeUrl(row.url);
  return Boolean(rowKey) && rowKey !== addUrlKey;
};

let duplicate = null;
let matchedBy = null;
if (addUrlKey) {
  duplicate = rows.find(row => normalizeUrl(row.url) === addUrlKey) ?? null;
  if (duplicate) matchedBy = 'url';
}
if (!duplicate) {
  const companyKey = normalizeCompany(company);
  if (companyKey) {
    duplicate = rows.find(row =>
      normalizeCompany(row.company) === companyKey
      && !urlBlocksHeuristic(row)
      && roleFuzzyMatch(role, row.role)) ?? null;
    if (duplicate) matchedBy = 'company+role';
  }
}

// Fields the caller actually supplied — the only ones an upsert may overwrite,
// and the only ones worth reporting as "changed".
const suppliedFields = [];
if (flags.date !== null) suppliedFields.push('date');
if (flags.company !== null) suppliedFields.push('company');
if (flags.role !== null) suppliedFields.push('role');
if (flags.via !== null) suppliedFields.push('via');
if (flags.url !== null) suppliedFields.push('url');
if (flags.score !== null) suppliedFields.push('score');
if (flags.status !== null) suppliedFields.push('status');
if (flags.note !== null) suppliedFields.push('notes');

// A value for a column this tracker does not have would be silently dropped by
// the row builder. Say so once, on stderr — the row is still written (the
// application is real); only the URL key is lost, exactly as merge-tracker
// already treats a tracker without a URL column.
if (url && colmap.url == null) {
  console.error(`⚠ ${APPS_FILE} has no URL column — the posting URL on this row is not stored (dedup by URL is unavailable).`);
}

if (duplicate) {
  if (!flags.updateOnMatch) {
    lock?.release();
    const result = {
      verdict: 'duplicate',
      num: duplicate.num,
      matchedBy,
      company: duplicate.company,
      role: duplicate.role,
      status: duplicate.status,
      ...(flags.dryRun ? { dryRun: true } : {}),
      tracker: APPS_FILE,
    };
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`↩️  Not added — #${duplicate.num} ${duplicate.company} — ${duplicate.role} already matches (${matchedBy})`);
    process.exit(EXIT_OK);
  }

  // Upsert: overwrite ONLY the supplied fields. buildTrackerRow with `raw`
  // starts from the row's current cells, so columns career-ops has no field for
  // (a hand-entered Apply Link, a Follow-up date) survive.
  const fieldValue = {
    date, company, role, via, url, score, status, notes: note,
  };
  // A field whose column the header does not declare cannot be written; drop it
  // from the update rather than reporting a change the file never received.
  const applicableFields = suppliedFields.filter(field => colmap[field] != null);
  const merged = { ...duplicate };
  const changedFields = [];
  for (const field of applicableFields) {
    if (field === 'notes') {
      // Notes APPEND rather than replace, matching set-status.mjs: the cell is
      // where every human note about the application accumulates, and a machine
      // upsert knowing one more fact about the posting must not delete the rest
      // of them. Delimiter-aware idempotency keeps a retried PUT from stacking
      // the same note twice.
      const existing = String(duplicate.notes ?? '');
      const alreadyPresent = existing === note
        || existing.startsWith(`${note}; `)
        || existing.endsWith(`; ${note}`)
        || existing.includes(`; ${note}; `);
      const nextNotes = alreadyPresent
        ? existing
        : existing && existing !== '—' && existing !== '-' ? `${existing}; ${note}` : note;
      if (merged.notes !== nextNotes) changedFields.push('notes');
      merged.notes = nextNotes;
      continue;
    }
    if (merged[field] !== fieldValue[field]) changedFields.push(field);
    merged[field] = fieldValue[field];
  }
  const updatedLine = buildTrackerRow(
    { ...merged, raw: lines[duplicate.lineIdx] },
    { colmap, width: headerWidth(lines) },
  );
  if (changedFields.length > 0 && !flags.dryRun) {
    lines[duplicate.lineIdx] = updatedLine;
    try {
      writeFileAtomic(APPS_FILE, lines.join('\n'));
    } catch (err) {
      failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${APPS_FILE}: ${err.message}`);
    }
  }
  lock?.release();
  const result = {
    verdict: 'updated',
    num: duplicate.num,
    matchedBy,
    changedFields,
    company: merged.company,
    role: merged.role,
    status: merged.status,
    ...(flags.dryRun ? { dryRun: true } : {}),
    tracker: APPS_FILE,
  };
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`✅ #${duplicate.num} ${merged.company} — ${merged.role}: updated ${changedFields.join(', ') || 'nothing (already current)'}`);
  process.exit(EXIT_OK);
}

// ── insert one row ──────────────────────────────────────────────

// Insert point: right below the separator row, matching merge-tracker (a new
// application is the newest one) and the tracker's descending-# order.
let insertIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (SEPARATOR_ROW_RE.test(lines[i])) {
    insertIdx = i + 1;
    break;
  }
}
if (insertIdx < 0) {
  // Without a separator there is no table to append to. Abort before writing
  // rather than inventing a header: the caller can repair the file and retry,
  // and nothing has been lost in the meantime.
  failWith(
    EXIT_USAGE,
    'no-insert-point',
    `${APPS_FILE} has no table separator row ("|---|------|...") — there is no place to insert a new row. Rewrite the header and retry.`,
  );
}

const maxNum = rows.reduce((max, row) => (row.num > max ? row.num : max), 0);
const num = maxNum + 1;

const newLine = buildTrackerRow({
  num,
  date,
  company,
  role,
  via,
  url,
  score,
  status,
  pdf: '❌',
  report: '—',
  notes: note,
}, { colmap, width: headerWidth(lines) });

if (!flags.dryRun) {
  lines.splice(insertIdx, 0, newLine);
  try {
    writeFileAtomic(APPS_FILE, lines.join('\n'));
  } catch (err) {
    failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${APPS_FILE}: ${err.message}`);
  }
}
lock?.release();

const result = {
  verdict: 'created',
  num,
  company,
  role,
  status,
  date,
  ...(url ? { url } : {}),
  ...(flags.dryRun ? { dryRun: true } : {}),
  tracker: APPS_FILE,
};
if (flags.json) console.log(JSON.stringify(result, null, 2));
else console.log(`➕ #${num} ${company} — ${role} [${status}]${flags.dryRun ? ' (dry-run, nothing written)' : ''}`);
process.exit(EXIT_OK);

/**
 * Cell count of the tracker's actual header row, so a new row matches the table
 * shape (including columns career-ops has no field for). Falls back to the
 * width implied by the detected column map.
 *
 * @param {string[]} fileLines - All lines of the tracker file.
 * @returns {number} `split('|').length` of the header row.
 */
function headerWidth(fileLines) {
  for (const line of fileLines) {
    if (line.startsWith('|') && isHeaderRow(line)) return line.split('|').length;
  }
  return Math.max(...Object.values(colmap)) + 2;
}

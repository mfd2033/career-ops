#!/usr/bin/env node

/**
 * tracker-edit.mjs — canonical CLI to edit the fields of ONE existing tracker
 * row (data/applications.md), other than the status-only path set-status.mjs
 * already owns.
 *
 * Why a dedicated writer: the fields around Status (date, company, role, via,
 * url, score, notes) could only be changed by hand-editing the markdown, which
 * takes no lock — the classic lost-update shape (#2900): two writers read the
 * same snapshot, each edits its own row, each renames its full copy back, and
 * the second silently discards the first's change. Routing every field edit
 * through one locked CLI removes that race for the whole row, not just the
 * Status cell.
 *
 * Usage:
 *   node tracker-edit.mjs --row N [--date YYYY-MM-DD] [--company TEXT]
 *                         [--role TEXT] [--via TEXT] [--url URL]
 *                         [--score N/5] [--note TEXT] [--status STATE]
 *                         [--planned YYYY-MM-DD]
 *                         [--on YYYY-MM-DD] [--source web]
 *                         [--dry-run] [--json]
 *
 * Contract:
 *   - Only the named cells change; every other byte of the tracker round-trips.
 *   - A field whose column the header does not declare is rejected (no-column):
 *     claiming an edit the file cannot receive is worse than refusing it.
 *   - `--status` goes through templates/states.yml AND appends the transition
 *     ledger line set-status.mjs writes (same format, same closed-set source
 *     column), so funnel-velocity.mjs sees this writer's transitions too.
 *   - The content hash is taken at read time and re-checked immediately before
 *     the write. The lock already serializes every cooperating writer, so a
 *     change here means something wrote the tracker WITHOUT the lock — the
 *     write is refused (exit 3) instead of silently overwriting it.
 *
 * Exit codes: 0 success (including a no-op re-run) · 1 usage error,
 * non-canonical state, unreadable states.yml, or non-retryable lock/write
 * failure · 2 row or tracker not found · 3 duplicate row number or concurrent
 * modification outside the lock · 4 tracker lock timeout (busy — retry later).
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { localToday } from './lib/local-today.mjs';
import {
  rebuildRow, cell, resolveTrackerPath, writeFileAtomic, loadCanonicalStates,
  resolveCanonicalState, CLI_EXIT, makeCliFailWith, acquireTrackerLockForCli,
} from './tracker-utils.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const STATES_FILE = join(CAREER_OPS, 'templates/states.yml');

const {
  OK: EXIT_OK, USAGE: EXIT_USAGE, NOT_FOUND: EXIT_NOT_FOUND, AMBIGUOUS: EXIT_AMBIGUOUS,
} = CLI_EXIT;

const USAGE = `Usage: node tracker-edit.mjs --row N [field options]

  --row N            Tracker row number to edit (required; the # column)
  --date YYYY-MM-DD  Replace the Date cell
  --company TEXT     Replace the Company cell
  --role TEXT        Replace the Role cell
  --via TEXT         Replace the Via cell (agency/recruiter firm)
  --url URL          Replace the URL cell (the dedup key)
  --score N/5        Replace the Score cell ("4.2/5", or a sentinel: —, N/A, DUP)
  --note TEXT        Replace the Notes cell (replace, not append — use
                     set-status.mjs --note to APPEND a note)
  --status STATE     Canonical state from templates/states.yml
  --planned DATE     Planned application date (YYYY-MM-DD); "" or — clears it
  --on YYYY-MM-DD    Real event date for the status-log entry (defaults to today)
  --source NAME      Attribution for the transition ledger: set-status (default),
                     web, or correction
  --dry-run          Resolve and validate, but write nothing
  --json             Machine-readable output on stdout (errors included)

  At least one field option is required. A field the tracker has no column for
  is refused (code "no-column") rather than dropped silently.`;

// Sources the transition ledger accepts from THIS writer. Deliberately the
// closed set funnel-velocity.mjs documents (VALID_SOURCES) intersected with
// what an edit can honestly claim: this script never reconstructs history.
const WRITER_SOURCES = new Set(['set-status', 'web', 'correction']);

const rawArgs = process.argv.slice(2);
const fields = {
  date: null, company: null, role: null, via: null, url: null, score: null, note: null, status: null,
  planned: null,
};
const flags = { row: null, on: null, source: null, dryRun: false, json: false };
const FIELD_FLAGS = {
  '--date': 'date', '--company': 'company', '--role': 'role', '--via': 'via',
  '--url': 'url', '--score': 'score', '--note': 'note', '--status': 'status',
  '--planned': 'planned',
};
const VALUE_FLAGS = { ...FIELD_FLAGS, '--row': 'row', '--on': 'on', '--source': 'source' };

/**
 * Print usage (plus an optional specific complaint) and exit 1. JSON mode is
 * read from the raw argv because parsing may not have settled yet.
 *
 * @param {string|null} message
 * @returns {never}
 */
function failUsage(message) {
  const msg = message ?? 'Usage: node tracker-edit.mjs --row N [field options]';
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
    if (value === undefined || value.startsWith('--')) failUsage(`Missing value for ${arg}`);
    if (arg === '--row' && !/^\d+$/.test(value)) failUsage(`--row expects a positive integer, got "${value}"`);
    if (arg === '--source' && !WRITER_SOURCES.has(value)) {
      failUsage(`--source expects one of ${[...WRITER_SOURCES].join(', ')}, got "${value}"`);
    }
    const target = FIELD_FLAGS[arg] ? fields : flags;
    target[VALUE_FLAGS[arg]] = value;
    i++;
  } else if (arg === '--dry-run') { flags.dryRun = true; }
  else if (arg === '--json') { flags.json = true; }
  else if (arg.startsWith('--')) { failUsage(`Unknown flag: ${arg}`); }
  else { failUsage(`Unexpected argument: ${arg}`); }
}

// Built AFTER the argv parse: makeCliFailWith captures the flag, and a failWith
// constructed before --json is read would never emit the JSON document that
// machine callers rely on (errors included).
const failWith = makeCliFailWith(flags.json);

if (flags.row === null) failUsage('--row N is required — this writer edits an existing row');
const suppliedFields = Object.keys(fields).filter(key => fields[key] !== null);
if (suppliedFields.length === 0) failUsage(`Nothing to edit — pass at least one field option (${Object.keys(FIELD_FLAGS).join(', ')})`);

// ── field validation (before anything touches the tracker) ──────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SCORE_RE = /^\d+(?:\.\d+)?\/5$/;
const SCORE_SENTINELS = new Set(['—', 'N/A', 'DUP', '-']);

/**
 * Whether a string is a real calendar date written as YYYY-MM-DD.
 *
 * @param {string} value
 * @returns {boolean}
 */
function isCalendarDate(value) {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Round-trip on UTC on purpose: this is date PARSING, not "what day is it
  // here" (that is localToday's job).
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

if (fields.date !== null && !isCalendarDate(fields.date)) {
  failWith(EXIT_USAGE, 'invalid-field', `--date expects a real calendar date as YYYY-MM-DD, got "${fields.date}"`);
}
// planned is a date cell, not a status. The clear token is the empty string,
// but the tracker's own empty-cell sentinel (—, and bare -) clears too: a
// Windows PowerShell caller cannot pass "" through to a native command at all,
// and — is what earlier writers left in an unplanned row.
const PLANNED_CLEAR = new Set(['', '—', '-']);
const plannedCell = fields.planned === null ? null : cell(fields.planned);
if (plannedCell !== null && !PLANNED_CLEAR.has(plannedCell) && !isCalendarDate(plannedCell)) {
  failWith(EXIT_USAGE, 'invalid-field', `--planned expects a real calendar date as YYYY-MM-DD (or ""/— to clear), got "${fields.planned}"`);
}
if (fields.score !== null) {
  const score = cell(fields.score);
  if (!SCORE_RE.test(score) && !SCORE_SENTINELS.has(score)) {
    failWith(EXIT_USAGE, 'invalid-field', `--score expects "N/5" (e.g. 4.2/5) or a sentinel (—, N/A, DUP), got "${fields.score}"`);
  }
}
if (flags.on !== null && !isCalendarDate(flags.on)) {
  failWith(EXIT_USAGE, 'invalid-field', `--on expects a real date as YYYY-MM-DD, got "${flags.on}"`);
}
if (flags.on !== null && flags.on > localToday()) {
  failWith(EXIT_USAGE, 'invalid-field', `--on date is in the future: "${flags.on}"`);
}

let states = [];
if (fields.status !== null) {
  try {
    states = loadCanonicalStates(STATES_FILE);
  } catch (err) {
    failWith(EXIT_USAGE, 'states-error', `Cannot load canonical states from ${STATES_FILE}: ${err.message}`);
  }
}
const newStatus = fields.status === null ? null : resolveCanonicalState(fields.status, states);
if (fields.status !== null && !newStatus) {
  const valid = states.map(s => s.label).join(' · ');
  failWith(EXIT_USAGE, 'invalid-state', `"${fields.status}" is not a canonical state. Valid states: ${valid}`);
}

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
const contentHash = createHash('sha256').update(content).digest('hex');
const lines = content.split('\n');
const colmap = resolveColumns(lines);

const targetNum = parseInt(flags.row, 10);
const matches = [];
for (let i = 0; i < lines.length; i++) {
  const row = parseTrackerRow(lines[i], colmap);
  if (row && row.num === targetNum) matches.push({ ...row, lineIdx: i });
}
if (matches.length === 0) {
  failWith(EXIT_NOT_FOUND, 'not-found', `No tracker row with #${targetNum}`);
}
if (matches.length > 1) {
  // #1704: a stale tracker # reused across two rows makes "the first match" a
  // coin flip on which application gets edited. Refuse rather than guess.
  const listing = matches.map(row => `#${row.num}\t${row.company}\t${row.role}`).join('\n');
  failWith(
    EXIT_AMBIGUOUS,
    'ambiguous',
    `#${targetNum} is a duplicate tracker number shared by ${matches.length} rows — edit the company cell to disambiguate first:\n${listing}`,
    { candidates: matches.map(row => ({ num: row.num, company: row.company, role: row.role })) },
  );
}
const target = matches[0];

// Every requested field must have a column to land in. Silently skipping one
// would report an edit the tracker never received.
const toColumn = (field) => (field === 'note' ? 'notes' : field);
const missingColumns = suppliedFields.filter(field => colmap[toColumn(field)] == null);
if (missingColumns.length > 0) {
  const wanted = missingColumns.map(field => `--${field}`).join(', ');
  failWith(
    EXIT_USAGE,
    'no-column',
    `${APPS_FILE} has no column for ${wanted} — the header declares ${Object.keys(colmap).join(', ')}`,
    { missingColumns },
  );
}

// ── apply the edits ─────────────────────────────────────────────

const parts = lines[target.lineIdx].split('|').map(part => part.trim());
while (parts.length <= Math.max(...Object.values(colmap))) parts.push('');

// Field → the cell value to write. `note` is the only renamed one (the column is
// Notes; the flag is --note for symmetry with set-status.mjs).
const nextValue = {
  date: fields.date,
  company: fields.company === null ? null : cell(fields.company),
  role: fields.role === null ? null : cell(fields.role),
  via: fields.via === null ? null : (cell(fields.via) || '—'),
  url: fields.url === null ? null : cell(fields.url),
  score: fields.score === null ? null : cell(fields.score),
  note: fields.note === null ? null : cell(fields.note),
  status: newStatus,
  planned: plannedCell === null ? null : (PLANNED_CLEAR.has(plannedCell) ? '' : plannedCell),
};

const changedFields = [];
for (const field of suppliedFields) {
  const value = nextValue[field];
  if (value === null) continue;
  const colIndex = colmap[toColumn(field)];
  if ((parts[colIndex] ?? '') === value) continue;
  parts[colIndex] = value;
  changedFields.push(field === 'note' ? 'notes' : field);
}

const statusChanged = changedFields.includes('status');
const oldStatus = target.status;
const changed = changedFields.length > 0;

if (changed && !flags.dryRun) {
  // Re-read immediately before the write: everything cooperating holds the
  // lock, so a different hash here means an un-cooperating writer touched the
  // file inside our critical section. Refusing loses this edit (the caller can
  // retry); writing would lose THEIR change with no trace.
  let currentHash;
  try {
    currentHash = createHash('sha256').update(readFileSync(APPS_FILE)).digest('hex');
  } catch (err) {
    failWith(EXIT_USAGE, 'write-failure', `Cannot re-read tracker at ${APPS_FILE}: ${err.message}`);
  }
  if (currentHash !== contentHash) {
    failWith(
      EXIT_AMBIGUOUS,
      'concurrent-modification',
      `${APPS_FILE} changed while this edit was being prepared — nothing was written. Re-read the row and retry.`,
    );
  }
  lines[target.lineIdx] = rebuildRow(parts);
  try {
    writeFileAtomic(APPS_FILE, lines.join('\n'));
  } catch (err) {
    failWith(EXIT_USAGE, 'write-failure', `Cannot write tracker at ${APPS_FILE}: ${err.message}`);
  }
}

// ── status-log append (transition ledger, read by funnel-velocity.mjs) ──
// Same line format and closed-set source column as set-status.mjs, appended in
// the same lock window. Observation-only: a failed append warns, never fails —
// the tracker write above already succeeded and stays the source of truth.
let statusLogged = false;
if (statusChanged && !flags.dryRun) {
  const logPath = join(dirname(APPS_FILE), 'status-log.tsv');
  const eventDate = flags.on ?? localToday();
  try {
    appendFileSync(logPath, `${target.num}\t${eventDate}\t${oldStatus}\t${newStatus}\t${flags.source ?? 'set-status'}\t\n`);
    statusLogged = true;
  } catch (err) {
    console.error(`⚠ status-log append failed (status change itself succeeded): ${err.message}`);
  }
}
lock?.release();

const result = {
  changed,
  num: target.num,
  company: fields.company === null ? target.company : cell(fields.company),
  role: fields.role === null ? target.role : cell(fields.role),
  changedFields,
  ...(statusChanged ? { oldStatus, newStatus } : {}),
  ...(flags.dryRun ? { dryRun: true } : {}),
  ...(statusChanged && !flags.dryRun ? { statusLogged } : {}),
  tracker: APPS_FILE,
};

if (flags.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const verb = flags.dryRun ? 'would update' : changed ? 'updated' : 'already current';
  console.log(`✅ #${target.num} ${result.company} — ${result.role}: ${verb} ${changedFields.join(', ') || '(no change)'}`);
}
process.exit(EXIT_OK);

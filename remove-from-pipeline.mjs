#!/usr/bin/env node
/**
 * remove-from-pipeline.mjs — Delete specific URLs from pipeline.md Pending section.
 *
 * THE PROBLEM
 * The web inbox's "batch skip" only hides rows in localStorage — the `- [ ] URL`
 * line stays in data/pipeline.md forever, bloating the Pending section and
 * forcing every future scan and reconcile pass to re-reason about dead rows.
 * Users who have decided they will NEVER evaluate a posting need a one-shot way
 * to remove it from the pipeline's source of truth.
 *
 * WHAT THIS DOES
 * Parses pipeline.md's Pending section, matches every `- [ ] URL` row by
 * normalizeUrl identity (same as reconcile-pipeline / merge-tracker), filters
 * matched lines out, and writes the file back — preserving all comments, blank
 * lines, Processed section, and user scratch chapters verbatim.
 *
 * Locked with withPipelineLock so a concurrent scan or reconcile cannot race
 * the write. Single-file read-modify-write; safe under the same contention
 * patterns the lock was designed for.
 *
 * Run:
 *   node remove-from-pipeline.mjs --url "<url>" --url "<url>" ...
 *   node remove-from-pipeline.mjs < urls.txt
 *   echo "https://a.com\nhttps://b.com" | node remove-from-pipeline.mjs
 *
 * Output (stdout, always JSON):
 *   { "removed": 7, "notFound": 3 }
 *
 * Exit 0 on success (even if notFound > 0). Exit 1 on file/parse errors.
 */

import { readFileSync, writeFileSync, existsSync, realpathSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { withPipelineLock } from './pipeline-lock.mjs';
import { normalizeUrl } from './url-key.mjs';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));

// ---- args -----------------------------------------------------------------

function argValues(flag) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && i + 1 < process.argv.length) out.push(process.argv[++i]);
  }
  return out;
}

const showHelp = () => {
  console.log('Usage: node remove-from-pipeline.mjs [--url <url>]... [--pipeline <path>]');
  console.log('  Deletes matching - [ ] URL rows from pipeline.md Pending section.');
  console.log('  With --url (repeatable), deletes those URLs. Without, reads newline-separated URLs from stdin.');
  process.exit(0);
};

if (process.argv.includes('-h') || process.argv.includes('--help')) showHelp();

function resolveInsideRepo(inputPath, fallbackPath, flag) {
  const abs = resolve(inputPath || fallbackPath);
  let repoReal, targetReal;
  try {
    repoReal = realpathSync(CAREER_OPS);
    targetReal = existsSync(abs) ? realpathSync(abs) : realpathSync(dirname(abs));
  } catch {
    console.error(`Invalid ${flag}: cannot resolve path (${abs})`);
    process.exit(1);
  }
  const rel = relative(repoReal, targetReal);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`Invalid ${flag}: path must stay inside the repository (${abs})`);
    process.exit(1);
  }
  return abs;
}

const defaultPipeline = existsSync(join(CAREER_OPS, 'data/pipeline.md'))
  ? join(CAREER_OPS, 'data/pipeline.md')
  : join(CAREER_OPS, 'pipeline.md');
const PIPELINE_FILE = resolveInsideRepo(argValues('--pipeline')[0], defaultPipeline, '--pipeline');

// Collect target URLs: --url repeatable > stdin.
let rawUrls = argValues('--url');
if (rawUrls.length === 0) {
  const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf-8');
  if (stdin && stdin.trim()) rawUrls = stdin.split(/\r?\n/);
}
rawUrls = rawUrls
  .map((u) => u.trim())
  .filter((u) => u && /^https?:\/\//i.test(u));

if (rawUrls.length === 0) {
  console.error('No URLs provided — pass --url <url> or pipe newline-separated URLs on stdin.');
  process.exit(1);
}

const TARGET_KEYS = new Set(rawUrls.map((u) => normalizeUrl(u)).filter(Boolean));
// Also keep the raw URLs as fallback for rows written with unusual spelling the
// normalizer might collapse differently (very rare, but the cost is a small Set).
const TARGET_RAW = new Set(rawUrls.map((u) => {
  const bare = u.startsWith('<') && u.endsWith('>') ? u.slice(1, -1) : u;
  return bare.trim();
}));

// ---- Pending section boundary ----------------------------------------------

// pipeline-sections.mjs PENDING_SECTION_RE — mirrored in this script so we
// don't have to import it from outside the Node context.
const PENDING_SECTION_RE = /^##\s+(pending|pendientes)\s*$/i;
const ANY_SECTION_RE = /^##\s+/;

/**
 * Line index range [start, end) of the Pending section in the full file.
 * Falls back to the ENTIRE file when no Pending header exists (legacy flat
 * layout) — that's exactly the case where every checkbox row IS a pending
 * offer, so deleting by URL on the whole file is the correct default.
 */
function pendingSectionRange(lines) {
  const start = lines.findIndex((l) => PENDING_SECTION_RE.test(l));
  if (start < 0) return { lo: 0, hi: lines.length };
  let hi = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_SECTION_RE.test(lines[i])) { hi = i; break; }
  }
  return { lo: start + 1, hi };
}

// ---- row parser ------------------------------------------------------------

// Matches a pipeline checkbox row. Captures the URL cell (first pipe-delimited
// segment) — strips angle brackets so normalizeUrl sees the same bare URL the
// inbox reader already normalizes.
const CHECKBOX_RE = /^\s*-\s*\[([ xX])\]\s*(.+)$/;

function urlCell(line) {
  const m = line.match(CHECKBOX_RE);
  if (!m) return null;
  const cells = m[2].split('|').map((s) => s.trim());
  if (!cells[0]) return null;
  let raw = cells[0];
  if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1);
  return raw.trim();
}

// ---- main ------------------------------------------------------------------

const result = await withPipelineLock(PIPELINE_FILE, () => {
  if (!existsSync(PIPELINE_FILE)) {
    return { removed: 0, notFound: TARGET_KEYS.size };
  }
  const md = readFileSync(PIPELINE_FILE, 'utf-8');
  const lines = md.split(/\r?\n/);
  const { lo, hi } = pendingSectionRange(lines);

  const removedKeys = new Set();
  const out = lines.slice(0, lo);
  for (let i = lo; i < hi; i++) {
    const u = urlCell(lines[i]);
    if (u) {
      const key = normalizeUrl(u);
      // normalizeUrl miss → fall back to raw (very permissive, but pipeline rows
      // are always absolute http(s), so the fallback is almost never hit).
      const hit = (key && TARGET_KEYS.has(key)) || TARGET_RAW.has(u);
      if (hit && !removedKeys.has(key ?? u)) {
        removedKeys.add(key ?? u);
        continue; // drop this line entirely
      }
    }
    out.push(lines[i]);
  }
  // Preserve everything AFTER the Pending section (Processed, user chapters,
  // etc.) — they sit at lines[hi]...end, untouched.
  for (let i = hi; i < lines.length; i++) out.push(lines[i]);

  writeFileSync(PIPELINE_FILE, out.join('\n'), 'utf-8');

  return { removed: removedKeys.size, notFound: TARGET_KEYS.size - removedKeys.size };
});

process.stdout.write(JSON.stringify(result) + '\n');

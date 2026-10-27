// The decisions every /api/tracker route makes around its core child process,
// kept out of the route files so they can be tested without spawning anything.
//
// The tracker's WRITE path lives in the core CLIs (tracker-add.mjs,
// tracker-edit.mjs, set-status.mjs, tracker.mjs). These routes only translate
// HTTP into argv and a CLI result back into an HTTP status, exactly as
// /api/status already does — the invariant is that no route ever reads or
// writes data/applications.md itself.

import { execFile } from "node:child_process";
import { parseCliJson, parseCliJsonArray } from "./status-cli.mjs";

export { parseCliJson, parseCliJsonArray };

/** Field names a caller may send, matching tracker-aliases.json's canonical names. */
// `planned` joins the whitelist for the PATCH edit path (tracker-edit.mjs owns
// the --planned flag and its date validation). POST/PUT forward it to
// tracker-add.mjs, which rejects the unknown flag with a usage error (400) —
// honest refusal, no silent drop.
export const TRACKER_FIELDS = ["date", "company", "role", "via", "url", "score", "status", "notes", "planned"];

/**
 * CLI error code → HTTP status.
 *
 * A map rather than status-cli.mjs's client-error allow-list, because this
 * surface's codes are declared per CLI (tracker-add/-edit fail with `no-column`,
 * `concurrent-modification`, …) and every one of them has exactly one honest
 * status. An UNKNOWN code still falls through to 500: a failure this file has
 * never seen is far more likely to be ours than the caller's.
 */
const CODE_TO_HTTP = {
  "not-found": 404,
  "no-tracker": 404,
  usage: 400,
  "invalid-field": 400,
  "invalid-state": 400,
  "no-column": 400,
  "no-insert-point": 400,
  ambiguous: 409,
  "invalid-transition": 409,
  "concurrent-modification": 409,
  "lock-timeout": 503,
  "lock-error": 500,
  "states-error": 500,
  "write-failure": 500,
  "read-failure": 500,
  internal: 500,
};

/** Core exit codes that mean something HTTP-specific (CLI_EXIT in tracker-utils.mjs). */
const EXIT_TO_HTTP = { 2: 404, 3: 409, 4: 503 };

/**
 * The HTTP status a finished CLI run maps to.
 *
 * Order matters: a spawn failure and a timeout carry no meaningful exit code
 * (both surface as a missing numeric `code`), so they are decided first.
 *
 * @param {{exitCode?: number|null, cliCode?: string|null, spawnFailed?: boolean, timedOut?: boolean}} run
 * @returns {number} HTTP status.
 */
export function httpStatusFor({ exitCode = null, cliCode = null, spawnFailed = false, timedOut = false } = {}) {
  if (spawnFailed) return 500;
  // Killed by our own timeout: whether the change landed is genuinely unknown,
  // so this is not a caller error and not a success either.
  if (timedOut) return 504;
  if (cliCode && typeof exitCode === "number" && exitCode !== 0) {
    const mapped = CODE_TO_HTTP[cliCode];
    if (mapped != null) return mapped;
  }
  if (typeof exitCode === "number" && EXIT_TO_HTTP[exitCode] != null) return EXIT_TO_HTTP[exitCode];
  return 500;
}

/** True for statuses whose whole meaning is "try again shortly". */
export function isRetryable(status) {
  return status === 503 || status === 504;
}

/**
 * The response body for a failed run, in this surface's envelope.
 *
 * Child stderr is never echoed: on the crash path it is a Node stack trace
 * carrying absolute server paths. Only the CLI's own `error` string is passed
 * through, and a run that printed no document gets a generic message.
 *
 * @param {object} run
 * @param {Record<string, unknown>|null} [run.parsed] - The CLI's JSON document, if it printed one.
 * @param {string|null} [run.cliCode] - The document's `code`, when present.
 * @param {number|null} [run.exitCode]
 * @param {boolean} [run.spawnFailed]
 * @param {boolean} [run.timedOut]
 * @returns {{ok: false, error: {code: string, message: string}, retryable: boolean}}
 */
export function failureBody({ parsed = null, cliCode = null, exitCode = null, spawnFailed = false, timedOut = false } = {}) {
  const status = httpStatusFor({ exitCode, cliCode, spawnFailed, timedOut });
  const message = typeof parsed?.error === "string"
    ? parsed.error
    : `tracker command failed (exit ${exitCode ?? "unknown"})`;
  return {
    ok: false,
    error: { code: cliCode ?? (status === 500 ? "internal" : "tracker-error"), message },
    retryable: isRetryable(status),
  };
}

/**
 * Validate one field value arriving from untrusted JSON.
 *
 * Only strings and finite numbers are accepted. An array or object would reach
 * the CLI as "[object Object]" and cost a process spawn plus a lock acquisition
 * to produce a usage error — the same reasoning as status-cli.mjs's
 * trackerRowArg. Control characters are refused here because they would either
 * break the markdown row or need re-single-lining by the CLI anyway.
 *
 * @param {unknown} value
 * @returns {string|null} The value as a string, or null when unusable.
 */
function fieldValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return null;
  return value;
}

/**
 * Turn a JSON body into argv for tracker-add.mjs / tracker-edit.mjs.
 *
 * @param {unknown} body - Parsed request body.
 * @param {object} options
 * @param {string[]} options.required - Fields that must be present and non-empty.
 * @param {boolean} options.allowUpsertFlag - Accept `updateOnMatch` (PUT /upsert).
 * @returns {{argv: string[]}|{error: {code: string, message: string}}}
 */
function fieldArgv(body, { required = [], allowUpsertFlag = false } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: { code: "usage", message: "a JSON object body is required" } };
  }
  const allowed = new Set(TRACKER_FIELDS);
  if (allowUpsertFlag) allowed.add("updateOnMatch");
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return {
      error: {
        code: "usage",
        message: `unknown field(s): ${unknown.join(", ")} — allowed: ${[...allowed].join(", ")}`,
      },
    };
  }
  for (const field of required) {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      return { error: { code: "usage", message: `${field} is required` } };
    }
  }

  const argv = [];
  for (const field of TRACKER_FIELDS) {
    if (body[field] === undefined || body[field] === null) continue;
    const value = fieldValue(body[field]);
    if (value === null) {
      return { error: { code: "usage", message: `${field} must be a string or a number` } };
    }
    // The Notes cell is `--note` on the CLIs: the column is Notes, the flag is
    // named for the single value it carries (set-status.mjs precedent).
    argv.push(field === "notes" ? "--note" : `--${field}`, value);
  }

  if (allowUpsertFlag && body.updateOnMatch !== undefined) {
    if (typeof body.updateOnMatch !== "boolean") {
      return { error: { code: "usage", message: "updateOnMatch must be a boolean" } };
    }
    if (body.updateOnMatch) argv.push("--update-on-match");
  }

  if (required.length === 0 && argv.length === 0) {
    return { error: { code: "usage", message: `nothing to update — send at least one of: ${TRACKER_FIELDS.join(", ")}` } };
  }
  return { argv };
}

/**
 * argv for `POST /api/tracker` (create one row).
 *
 * @param {unknown} body
 * @returns {{argv: string[]}|{error: {code: string, message: string}}}
 */
export function addArgv(body) {
  return fieldArgv(body, { required: ["company", "role"] });
}

/**
 * argv for `PUT /api/tracker/upsert` (create, or update the row a URL matches).
 *
 * Shares fieldArgv with addArgv on purpose: the two endpoints differ only in
 * what the core does on a duplicate, and duplicating the body handling here
 * would let the accepted field set drift between them.
 *
 * @param {unknown} body
 * @returns {{argv: string[]}|{error: {code: string, message: string}}}
 */
export function upsertArgv(body) {
  return fieldArgv(body, { required: ["company", "role"], allowUpsertFlag: true });
}

/**
 * argv for `PATCH /api/tracker/[id]` (edit named fields of an existing row).
 *
 * @param {unknown} body
 * @param {string|number} id - Tracker row number from the URL.
 * @returns {{argv: string[]}|{error: {code: string, message: string}}}
 */
export function editArgv(body, id) {
  const row = trackerRowArg(id);
  if (!row) return { error: { code: "usage", message: "id must be a tracker row number" } };
  const built = fieldArgv(body);
  if (built.error) return built;
  return { argv: ["--row", row, ...built.argv] };
}

/**
 * A tracker row number as a CLI-ready string, or null when `id` is not one.
 *
 * Shared shape with status-cli.mjs's trackerRowArg: the value arrives from a URL
 * segment or JSON, so it can be anything at all.
 *
 * @param {unknown} id
 * @returns {string|null}
 */
export function trackerRowArg(id) {
  if (typeof id !== "string" && typeof id !== "number") return null;
  const row = String(id).trim();
  return /^\d+$/.test(row) ? row : null;
}

/** Default page size for GET /api/tracker, and the ceiling a caller may ask for. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * argv for `GET /api/tracker` (list + filter) from the request's search params.
 *
 * `status` is NOT validated here: the route canonicalizes it first
 * (canonicalizeStatus), because tracker.mjs's own rejection exits without a JSON
 * document and the caller deserves a message about the field rather than a 500.
 *
 * @param {URLSearchParams} params
 * @returns {{argv: string[], limit: number}|{error: {code: string, message: string}}}
 */
export function queryArgv(params) {
  const argv = ["query", "--json"];
  for (const key of ["status", "company", "role"]) {
    const value = params.get(key);
    if (value === null || value === "") continue;
    argv.push(`--${key}`, value);
  }
  const since = params.get("since");
  if (since !== null && since !== "") {
    if (!DATE_RE.test(since)) {
      return { error: { code: "usage", message: "since must be YYYY-MM-DD" } };
    }
    argv.push("--since", since);
  }
  const rawLimit = params.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1) {
      return { error: { code: "usage", message: "limit must be a positive integer" } };
    }
    limit = Math.min(Number(rawLimit), MAX_LIMIT);
  }
  argv.push("--limit", String(limit));
  return { argv, limit };
}

/**
 * Run one core CLI script and report everything the caller needs to map it.
 *
 * `execFile` reports three different outcomes through one error object: a
 * non-zero exit, a kill (our timeout), and a failure to spawn at all. They map to
 * different HTTP statuses, and a killed child carries no numeric exit code —
 * indistinguishable from a spawn failure unless `killed` is checked first.
 *
 * @param {object} options
 * @param {string} options.scriptPath - Absolute path to the core .mjs script.
 * @param {string[]} options.args - Arguments after the script path.
 * @param {string} options.cwd - The career-ops root the script must run in.
 * @param {number} options.timeoutMs - Hard kill for the child.
 * @param {Record<string, string>} [options.env] - Extra environment for the child.
 * @returns {Promise<{code: number, stdout: string, stderr: string, spawnFailed: boolean, timedOut: boolean}>}
 */
export function runCoreCli({ scriptPath, args, cwd, timeoutMs, env = {} }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      { cwd, timeout: timeoutMs, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const error = err;
        const timedOut = error?.killed === true;
        const code = typeof error?.code === "number" ? error.code : error ? -1 : 0;
        resolve({
          code,
          stdout: stdout || "",
          stderr: stderr || "",
          spawnFailed: !timedOut && code === -1,
          timedOut,
        });
      },
    );
  });
}

/**
 * Wait budget for the tracker lock, bounded below the child's own kill timeout.
 *
 * The CLI waits a full minute by default, which is right for a batch run and
 * wrong for an HTTP request: the browser would hang and then get killed by the
 * timeout — reported as a crash — instead of the 503 the contended case should
 * produce. Bounding the child's wait below our kill timeout lets its exit-4 path
 * actually fire.
 *
 * An operator's own value is honored only while it stays under the ceiling.
 * Above it the two settings contradict each other and the result is not a longer
 * wait but the loss of the lock-timeout signal entirely.
 *
 * @param {number} timeoutMs - The child's hard timeout.
 * @param {Record<string, string>} [source] - Environment to read the override from.
 * @returns {Record<string, string>} Extra child environment.
 */
export function boundedLockWait(timeoutMs, source = process.env) {
  const LOCK_WAIT_DEFAULT_MS = 10_000;
  const ceiling = Math.max(1_000, timeoutMs - 5_000);
  const raw = Number(source.CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS);
  const requested = Number.isFinite(raw) && raw > 0 ? raw : LOCK_WAIT_DEFAULT_MS;
  return { CAREER_OPS_TRACKER_LOCK_TIMEOUT_MS: String(Math.min(requested, ceiling)) };
}

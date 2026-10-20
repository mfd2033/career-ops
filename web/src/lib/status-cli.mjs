// The decisions /api/status makes around its set-status.mjs child, kept here so
// they are testable without spawning anything.

// What the caller is told when the CLI supplied no usable message of its own.
const GENERIC_FAILURE = "status update failed";

/**
 * The LAST JSON document on stdout, whatever its shape, or null when there is
 * none.
 *
 * `--json` prints one document, but diagnostics can precede it — a ledger
 * append warning, say — and those can contain braces of their own. Scanning
 * forward to the first `{` finds a brace inside that diagnostic just as readily
 * as the document, and the resulting slice does not parse. So the scan runs from
 * the END: the CLI prints its result last.
 *
 * Objects and arrays are both accepted here; the exported readers below narrow
 * to one shape so a caller never has to re-check what it got.
 *
 * @param {string} stdout
 * @returns {unknown} The parsed document, or null.
 */
function lastJsonDocument(stdout) {
  const text = String(stdout ?? "");
  const lines = text.split("\n");
  // The document may be pretty-printed (JSON.stringify(x, null, 2)), so it is
  // every line from the found start to the END of stdout, not just the one line
  // that starts with a bracket.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    const candidate = lines.slice(i).join("\n");
    try {
      return JSON.parse(candidate);
    } catch {
      // Not the document start (e.g. a `{...}` inside a diagnostic on its own
      // line). Keep scanning earlier lines.
    }
  }
  return null;
}

/**
 * The CLI's JSON OBJECT document, or null when stdout carries none.
 *
 * @param {string} stdout
 * @returns {Record<string, unknown> | null}
 */
export function parseCliJson(stdout) {
  const parsed = lastJsonDocument(stdout);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return /** @type {Record<string, unknown>} */ (parsed);
}

/**
 * The CLI's JSON ARRAY document, or null when stdout carries none.
 *
 * tracker.mjs prints its query result as a bare array (`JSON.stringify(rows)`),
 * so a reader that only accepts objects would report "no result" for a perfectly
 * successful read. Same end-anchored scan, array-only narrowing.
 *
 * @param {string} stdout
 * @returns {unknown[] | null}
 */
export function parseCliJsonArray(stdout) {
  const parsed = lastJsonDocument(stdout);
  return Array.isArray(parsed) ? parsed : null;
}

/**
 * The message that goes in the response body for a failed run.
 *
 * Only the CLI's own `error` string is passed through. Child stderr never is:
 * on the exit-1 crash path it is a Node stack trace carrying absolute server
 * paths, which is exactly the content the spawn-failure path already refuses to
 * echo. Guarding one of the two and not the other left the disclosure open on
 * the path most likely to produce a stack trace in the first place.
 *
 * stderr still belongs in the server log — the caller just never sees it, which
 * is why this takes it and ignores it rather than letting a caller forget it
 * exists.
 *
 * @param {Record<string, unknown> | null} parsed
 * @param {string} [_stderr] Deliberately unused; log it at the call site.
 * @returns {string}
 */
export function clientErrorMessage(parsed, _stderr) {
  return typeof parsed?.error === "string" ? parsed.error : GENERIC_FAILURE;
}

/**
 * The `--row` argument for a request's row selector, or null when it names none.
 *
 * `n` arrives from untrusted JSON and is only typed as a string, so it can be an
 * array, an object, or a non-numeric string. `String(n)` turns those into
 * `"[object Object]"` and similar, which costs a process spawn and a tracker
 * lock acquisition to learn what a check here answers for free — and returns the
 * CLI's usage text rather than a message about the field.
 *
 * Not an injection concern: execFile takes an argv array and `--row` consumes
 * the next token as its value, so a flag-shaped value cannot introduce an
 * option. This is about cost and about answering the caller specifically.
 *
 * @param {unknown} n
 * @returns {string | null}
 */
export function trackerRowArg(n) {
  if (typeof n !== "string" && typeof n !== "number") return null;
  const row = String(n).trim();
  return /^\d+$/.test(row) ? row : null;
}

/**
 * pdf-paths.mjs — deterministic scratch + final paths for a web "pdf" run (#2172),
 * including the flat tailored-CV short name (cvShortStem, ADR-0076).
 *
 * Plain .mjs (same pattern as clean-chips.mjs / tracker-table.mjs) so this can
 * be unit-tested with `node --test`, no TypeScript build step. `careerOpsRoot`
 * and `findReportFile` are passed in rather than imported from career-ops.ts,
 * keeping this module free of TypeScript dependencies.
 */
import fs from "node:fs";
import path from "node:path";

// ── Flat tailored-CV short name (ADR-0076) ──────────────────────────
// The flat output name is cv-{report number}-{role}; the WHOLE filename
// (stem + ".pdf") must stay within 20 Unicode code points, so a Chinese
// character counts 1. modes/pdf.md documents the same algorithm for the CLI
// path — keep the two in sync (drift guard: the unit suite plus the test-all
// doc assertion).

/** Hard cap on the whole flat filename, extension INCLUDED (ADR-0076). */
const CV_FILENAME_MAX = 20;
/** ".pdf" is the extension the short name is written with. */
const CV_PDF_EXT = ".pdf";

/** Code-point length: an emoji is 2 UTF-16 units but 1 code point —
 * Array.from keeps the count honest for non-BMP text. */
function cpLength(s) {
  return Array.from(s).length;
}

/**
 * Normalize a role for the short filename: NFKC (full-width -> ASCII), drop
 * parenthetical notes whole, lowercase, non-letter/digit runs -> single "-",
 * trim the ends. Letters from any script survive, so a Chinese role stays
 * readable instead of being transliterated or dropped.
 * @param {string} role
 * @returns {string}
 */
function normalizeRoleForFilename(role) {
  return String(role ?? "")
    .normalize("NFKC")
    .replace(/[（(][^（）()]*[）)]/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Flat tailored-CV basename `cv-{report number}-{role}` (no extension),
 * guaranteed to keep `${stem}.pdf` within 20 code points for report numbers
 * up to 6 digits. Shrinking order (ADR-0076): drop whole hyphenated words
 * from the tail, then hard-truncate the last remaining word. A role that is
 * empty or normalizes away yields the bare `cv-{report number}`; the report
 * number itself is never truncated — it is the unique key data/pdf-index.tsv
 * resolves by.
 * @param {string} reportNum
 * @param {string} role
 * @returns {string}
 */
export function cvShortStem(reportNum, role) {
  const prefix = `cv-${String(reportNum ?? "").trim()}`;
  const budget = CV_FILENAME_MAX - CV_PDF_EXT.length;
  const normalized = normalizeRoleForFilename(role);
  if (!normalized) return prefix;

  const words = normalized.split("-");
  while (words.length > 1 && cpLength(`${prefix}-${words.join("-")}`) > budget) {
    words.pop();
  }
  const available = budget - cpLength(prefix) - 1;
  if (available <= 0) return prefix; // pathological number; the key wins
  const last = Array.from(words.join("-")).slice(0, available).join("");
  return last ? `${prefix}-${last}` : prefix;
}

/**
 * @typedef {Object} PdfPaths
 * @property {string} reportNum - The report number the row's Report cell actually links (== the tracker `#` for a never-re-evaluated row, the re-eval's number otherwise). Handed to mark-pdf-ready.mjs / the pdf-index manifest, which resolve by report number.
 * @property {string} reportFile - Absolute path of the linked evaluation report. Threaded into the pdf prompt so the worker reads the exact file instead of globbing `reports/{num}-*.md` (a weak model turns that glob into minutes of aimless re-globbing and gives up with no CV envelope — 2026-10-09, six failed pdf runs on codebuddy/hy3).
 * @property {string} html - Where the backend writes the tailored HTML it parsed out of the agent's envelope (#2185).
 * @property {string} finalPdf - Where the backend renders the final PDF — the flat ADR-0076 short name (output/cv-{report number}-{role}.pdf, ≤20 chars, cvShortStem below).
 */

/**
 * Precompute the scratch HTML and final PDF paths for a
 * "pdf" run, so the agent never chooses its own filenames — the backend owns
 * naming, writing (#2185) and rendering. The final PDF carries the flat
 * ADR-0076 short name (cv-{report number}-{role}, ≤20 chars) built from the
 * number the report file actually carries plus the caller-supplied tracker
 * Role; the scratch HTML stays keyed by the report number so renderAndMarkPdf's
 * cleanup prefix (cv-web-${reportNum}.) still finds it. modes/pdf.md documents
 * the same short-name algorithm for the CLI path, so web and CLI output stay
 * byte-identical.
 *
 * Framework-agnostic: returns a result instead of constructing a Response, so
 * the caller (a Next.js route today) decides how to surface `ok: false`.
 *
 * Side effect: creates `.career-ops-web/pdf-tmp/` under `root` if it doesn't
 * exist yet (the backend writes the parsed envelope there, #2185) — this is
 * NOT a pure path computation, despite the name.
 *
 * @param {string} input - The report number (e.g. "018").
 * @param {string} root - careerOpsRoot().
 * @param {(input: string) => string | null} findReportFile - career-ops.ts's findReportFile.
 * @param {string} [role] - The tracker row's Role column; feeds cvShortStem (ADR-0076). Empty/missing → cv-{report number}.pdf.
 * @returns {{ok: true, paths: PdfPaths} | {ok: false, error: string}}
 */
export function resolvePdfPaths(input, root, findReportFile, role = "") {
  // Reject anything but a bare report number before it ever reaches a path.
  // findReportFile()'s parseInt-based matching can still resolve a crafted
  // selector like "123/../../etc/passwd" to a legitimate report file, but the
  // raw string is also mirrored below into cv-web-${input}.html when the
  // report filename carries no leading number — path.join would then honor
  // those ".." segments and escape scratchDir.
  if (!/^\d+$/.test(input)) {
    return { ok: false, error: `Invalid report selector: "${input}"` };
  }
  const reportFile = findReportFile(input);
  if (!reportFile) {
    return { ok: false, error: `No report #${input} found — evaluate this posting first.` };
  }
  const reportBase = path.basename(reportFile);
  // The tracker `#` (input) diverges from the report number the row links after a
  // re-evaluation (row #1079 repointed to report 1086). mark-pdf-ready.mjs and the
  // pdf-index manifest resolve BY REPORT NUMBER, so thread the number the report
  // file actually carries — passing the tracker `#` matches no row and leaves the
  // PDF column ❌ (the 「打开定制简历所在位置」 button never appears). Falls back to
  // the raw selector when the filename carries no leading number.
  const reportNum = reportBase.match(/^(\d+)-/)?.[1] ?? String(input);
  const scratchDir = path.join(root, ".career-ops-web", "pdf-tmp");
  fs.mkdirSync(scratchDir, { recursive: true });
  return {
    ok: true,
    paths: {
      reportNum,
      reportFile,
      html: path.join(scratchDir, `cv-web-${reportNum}.html`),
      // ADR-0076 flat short name: cv-{report number}-{role}, ≤20 chars with the
      // extension. The tracker row's Role is handed in by the caller; an empty
      // role degrades to cv-{report number}.pdf.
      finalPdf: path.join(root, "output", `${cvShortStem(reportNum, role)}.pdf`),
    },
  };
}

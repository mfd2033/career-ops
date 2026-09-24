import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the tailored CV PDF for an offer. Two lookup strategies, tried in
 * order, sharing one entrypoint so /api/cv-pdf (view) and /api/cv-pdf/open
 * (reveal in the OS file manager) can never drift:
 *
 *  1. BY REPORT NUMBER (authoritative): the pdf mode records every rendered CV
 *     in data/pdf-index.tsv keyed by its report number. This is an exact link,
 *     so it resolves correctly for non-ASCII (Chinese) company names, for
 *     re-evaluated rows, and for companies with several tailored CVs — none of
 *     which the fuzzy name match below can do.
 *  2. BY COMPANY SLUG (legacy fallback): newest output/*.pdf whose company slug
 *     matches. Kept for CVs generated outside the report-keyed path (a CLI run
 *     that omitted --report, or an artifact predating pdf-index.tsv).
 *
 * Plain .mjs (same pattern as pdf-paths.mjs) so it can be unit-tested with
 * `node --test`. `root` (careerOpsRoot()) is passed in rather than imported
 * from career-ops.ts, keeping this module free of TypeScript dependencies.
 */

// "008" and "8" are the same report — zero-padded link form vs bare number
// (same normalization as find.mjs and generate-pdf.mjs's manifest writer).
function normNum(s) {
  return String(s ?? "").trim().replace(/^0+(?=\d)/, "");
}

/**
 * Resolve a report number to its exact PDF via data/pdf-index.tsv
 * (columns: report \t pdf \t html \t format \t date; pdf path relative to root,
 * forward slashes). Returns the newest row when a report somehow appears twice.
 * @param {string} reportNum
 * @param {string} root
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function resolveCvPdfByReport(reportNum, root) {
  const target = normNum(reportNum);
  if (!target) return { ok: false, error: "no report number given" };
  let text;
  try {
    text = fs.readFileSync(path.join(root, "data", "pdf-index.tsv"), "utf8");
  } catch {
    return { ok: false, error: "no tailored CV index found for this offer" };
  }
  let found = null;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (!fields[1]) continue;
    if (normNum(fields[0]) === target) found = fields[1].trim();
  }
  if (!found) return { ok: false, error: "no tailored CV found for this offer" };
  // Manifest paths are stored relative to the workspace with forward slashes.
  const abs = path.resolve(root, found.replace(/\//g, path.sep));
  return { ok: true, path: abs };
}

/**
 * Legacy company-slug fallback: the newest output/*.pdf whose company slug sits
 * at a token boundary, so "Meta" never resolves "Metabase"'s CV.
 *
 * FAILS CLOSED on a company name with no [a-z0-9] characters at all (e.g. a
 * Chinese name like "超聚变"): an empty slug would make the boundary regex match
 * EVERY pdf in output/ and return some unrelated company's CV — the bug behind
 * 「出现两个简历，第一个打不开」. Those names are resolved by report number instead.
 *
 * @param {string} company
 * @param {string} root
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function resolveLatestCvPdf(company, root) {
  // Token-extract instead of replace-then-trim: same slug, and no `-+$`-style
  // pattern that backtracks polynomially on adversarial input (CodeQL).
  const slug = (company.toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-");
  if (!slug) return { ok: false, error: "no tailored CV found for this offer" };
  const dir = path.join(root, "output");
  const re = new RegExp(`(^|[^a-z0-9])${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");

  let files;
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .filter((f) => re.test(f.toLowerCase()));
  } catch {
    return { ok: false, error: "no output directory" };
  }
  if (!files.length) return { ok: false, error: "no tailored CV found for this offer" };

  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  return { ok: true, path: path.join(dir, files[0]) };
}

/**
 * One entrypoint both CV routes call: try the authoritative report-number link,
 * then fall back to the (hardened) company-slug match.
 *
 * @param {{report?: string, company?: string}} q
 * @param {string} root
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function resolveCvPdf({ report, company }, root) {
  if (report && normNum(report)) {
    const byReport = resolveCvPdfByReport(report, root);
    if (byReport.ok) return byReport;
    // A report number that was never indexed is a real miss, not a reason to
    // guess by company (which could open an unrelated CV): surface it directly.
    return byReport;
  }
  if (company) return resolveLatestCvPdf(company, root);
  return { ok: false, error: "report or company required" };
}

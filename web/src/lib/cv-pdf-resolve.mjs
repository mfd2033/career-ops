import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the newest tailored CV PDF in the career-ops output/ dir that matches
 * a company. Shared by /api/cv-pdf (view in browser) and /api/cv-pdf/open
 * (reveal in the OS file manager), so the matching rules can never drift.
 *
 * Plain .mjs (same pattern as pdf-paths.mjs) so it can be unit-tested with
 * `node --test`. `root` (careerOpsRoot()) is passed in rather than imported
 * from career-ops.ts, keeping this module free of TypeScript dependencies.
 *
 * Matching mirrors the pdf mode's file naming (cv-…-{companySlug}-…pdf): the
 * company slug must appear at a token boundary (delimited by non-alphanumerics),
 * so "Meta" never resolves "Metabase"'s tailored CV.
 *
 * @param {string} company - The company name (matched by slug, newest first).
 * @param {string} root - careerOpsRoot().
 * @returns {{ok: true, path: string} | {ok: false, error: string}}
 */
export function resolveLatestCvPdf(company, root) {
  // Token-extract instead of replace-then-trim: same slug, and no `-+$`-style
  // pattern that backtracks polynomially on adversarial input (CodeQL).
  const slug = (company.toLowerCase().match(/[a-z0-9]+/g) ?? []).join("-");
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
// Tests for resolveLatestCvPdf() using Node's built-in test runner.
// Imports directly from cv-pdf-resolve.mjs (the single source of truth) so the
// test and production code can never drift out of sync. The resolver is shared
// by /api/cv-pdf (view) and /api/cv-pdf/open (reveal in file manager).
//
// Run:  node --test tests/lib/cv-pdf-resolve.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLatestCvPdf, resolveCvPdfByReport, resolveCvPdf } from "../../src/lib/cv-pdf-resolve.mjs";

function makeRoot() {
  return mkdtempSync(join(tmpdir(), "co-cvresolve-"));
}

test("resolveLatestCvPdf: no output dir -> ok:false with a clear error", () => {
  // Given a career-ops root with no output/ directory at all
  const root = makeRoot();
  try {
    // When resolving the latest tailored CV for a company
    const result = resolveLatestCvPdf("Acme", root);

    // Then it fails closed with a user-facing error
    assert.equal(result.ok, false);
    assert.match(result.error, /output/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLatestCvPdf: no matching pdf -> ok:false with a clear error", () => {
  // Given an output/ dir that holds only a different company's tailored CV
  const root = makeRoot();
  try {
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(join(root, "output", "cv-jane-globex-2026-07-26.pdf"), "x");
    // When resolving for a company with no CV on disk
    const result = resolveLatestCvPdf("Acme", root);

    // Then it fails with the tailored-CV-not-found error
    assert.equal(result.ok, false);
    assert.match(result.error, /tailored CV/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLatestCvPdf: picks the newest matching pdf by mtime", () => {
  // Given two tailored CVs for the same company on different dates
  const root = makeRoot();
  try {
    mkdirSync(join(root, "output"), { recursive: true });
    const now = Date.now() / 1000;
    const newer = join(root, "output", "cv-jane-acme-2026-07-26.pdf");
    const older = join(root, "output", "cv-jane-acme-2026-07-01.pdf");
    writeFileSync(newer, "new");
    utimesSync(newer, now, now);
    writeFileSync(older, "old");
    utimesSync(older, now - 60, now - 60);

    // When resolving the latest CV
    const result = resolveLatestCvPdf("Acme", root);

    // Then it returns the newest file
    assert.equal(result.ok, true);
    assert.equal(result.path, newer);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLatestCvPdf: token-boundary match so Meta never resolves Metabase's CV", () => {
  // Given an output/ dir holding only a longer slug that contains "meta"
  const root = makeRoot();
  try {
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(join(root, "output", "cv-jane-metabase-2026-07-26.pdf"), "x");

    // When resolving for "Meta" (a strict prefix of the file's company slug)
    const result = resolveLatestCvPdf("Meta", root);

    // Then it does NOT match the prefix file — the slug must sit at a token boundary
    assert.equal(result.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLatestCvPdf: non-ASCII (Chinese) company fails closed, never matches every PDF", () => {
  // Given an output/ dir holding one unrelated ASCII-slug CV
  const root = makeRoot();
  try {
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(join(root, "output", "cv--yikongzhijia-2026-09-24.pdf"), "x");
    // When resolving by a Chinese company name (empty slug after token-extract)
    const result = resolveLatestCvPdf("超聚变", root);
    // Then it must NOT return the unrelated CV — the empty-slug regex would
    // otherwise match every filename (the 「两个简历，第一个打不开」 bug).
    assert.equal(result.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCvPdfByReport: exact report number -> its indexed PDF", () => {
  // Given a pdf-index.tsv keying two reports to distinct PDFs (relative paths)
  const root = makeRoot();
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    writeFileSync(
      join(root, "data", "pdf-index.tsv"),
      "# report\tpdf\thtml\tformat\tdate\n1079\toutput/cv--wrong-2026-09-24.pdf\t-\ta4\t2026-09-24\n1086\toutput/cv--xchujibian-software-pm-reval-2026-09-24.pdf\t-\ta4\t2026-09-24\n",
    );
    // When resolving the linked report number (zero-padding tolerated)
    const hit = resolveCvPdfByReport("01086", root);
    assert.equal(hit.ok, true);
    assert.equal(hit.path, join(root, "output", "cv--xchujibian-software-pm-reval-2026-09-24.pdf"));
    // An unindexed report is a real miss, not a fuzzy fallback
    assert.equal(resolveCvPdfByReport("9999", root).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCvPdf: prefers the report link over the company name", () => {
  // Given a Chinese offer: its CV is indexed by report, and an unrelated ASCII
  // CV is the newest file in output/ (what the company fallback would wrongly pick)
  const root = makeRoot();
  try {
    mkdirSync(join(root, "data"), { recursive: true });
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(join(root, "output", "cv--yikongzhijia-2026-09-24.pdf"), "x");
    writeFileSync(
      join(root, "data", "pdf-index.tsv"),
      "1086\toutput/cv--xchujibian-software-pm-reval-2026-09-24.pdf\t-\ta4\t2026-09-24\n",
    );
    // When resolving with BOTH report and the (unmatched) Chinese company name
    const r = resolveCvPdf({ report: "1086", company: "超聚变" }, root);
    // Then the exact report link wins
    assert.equal(r.ok, true);
    assert.match(r.path, /xchujibian-software-pm-reval/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveCvPdf: no report falls back to the (hardened) company match", () => {
  // Given only a legacy ASCII company CV on disk and no index for the query
  const root = makeRoot();
  try {
    mkdirSync(join(root, "output"), { recursive: true });
    writeFileSync(join(root, "output", "cv-jane-acme-2026-07-26.pdf"), "x");
    assert.equal(resolveCvPdf({ company: "Acme" }, root).ok, true);
    // A Chinese name with no report key fails closed rather than matching all
    assert.equal(resolveCvPdf({ company: "超聚变" }, root).ok, false);
    assert.equal(resolveCvPdf({}, root).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveLatestCvPdf: returns the absolute path under root/output", () => {
  // Given a single matching tailored CV on disk
  const root = makeRoot();
  try {
    mkdirSync(join(root, "output"), { recursive: true });
    const pdf = join(root, "output", "cv-jane-acme-2026-07-26.pdf");
    writeFileSync(pdf, "x");

    // When resolving
    const result = resolveLatestCvPdf("Acme", root);

    // Then the returned path is absolute and points into root/output
    assert.equal(result.ok, true);
    assert.equal(result.path, pdf);
    assert.equal(result.path.startsWith(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
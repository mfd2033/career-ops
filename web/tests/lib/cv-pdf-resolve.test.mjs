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
import { resolveLatestCvPdf } from "../../src/lib/cv-pdf-resolve.mjs";

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
// Tests for resolvePdfPaths()/cvShortStem() using Node's built-in test runner.
// Imports directly from pdf-paths.mjs (the single source of truth) so the
// test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/pdf-paths.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cvShortStem, resolvePdfPaths } from "../../src/lib/pdf-paths.mjs";

// Given a career-ops root for the resolvePdfPaths path computations
function makeRoot() {
  return mkdtempSync(join(tmpdir(), "co-pdfpaths-"));
}

test("resolvePdfPaths: happy path builds the scratch html + the ADR-0076 short finalPdf", () => {
  // Given a root with a resolvable report and the row's role
  const root = makeRoot();
  const findReportFile = (input) => (input === "018" ? join(root, "reports", "018-acme-2026-07-01.md") : null);
  try {
    // When resolving paths for report #018
    const result = resolvePdfPaths("018", root, findReportFile, "PM");

    // Then the scratch html stays keyed by the report number and the final PDF
    // carries the short name cv-{report number}-{role}
    assert.equal(result.ok, true);
    assert.equal(result.paths.html, join(root, ".career-ops-web", "pdf-tmp", "cv-web-018.html"));
    assert.equal(result.paths.finalPdf, join(root, "output", "cv-018-pm.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: an over-budget role reaches the finalPdf already shrunk", () => {
  // Given a long role that cannot fit the short-name budget
  const root = makeRoot();
  const findReportFile = (input) => (input === "018" ? join(root, "reports", "018-acme-2026-07-01.md") : null);
  try {
    // When resolving paths for report #018
    const result = resolvePdfPaths("018", root, findReportFile, "Senior Backend Engineer");

    // Then the tail words were dropped before the name reached the disk path
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "cv-018-senior.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: an empty role degrades to cv-{report number}.pdf", () => {
  // Given a resolvable report but no role (row without one / unknown row)
  const root = makeRoot();
  const findReportFile = (input) => (input === "018" ? join(root, "reports", "018-acme-2026-07-01.md") : null);
  try {
    // When resolving without a role
    const result = resolvePdfPaths("018", root, findReportFile);

    // Then the file is just cv-018.pdf — the report number still keys the manifest
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "cv-018.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: path-traversal selector is rejected before any path is built", () => {
  // Given a findReportFile that would (via parseInt-based matching) resolve a
  // traversal-shaped selector to a real report, and a directory sentinel to
  // prove no scratch dir gets created for this input
  const root = makeRoot();
  const scratchDir = join(root, ".career-ops-web", "pdf-tmp");
  const findReportFile = () => join(root, "reports", "123-acme-2026-07-01.md");
  try {
    // When resolving paths for a crafted, non-canonical selector
    const result = resolvePdfPaths("123/../../etc/passwd", root, findReportFile);

    // Then it fails closed with a clear error, never calling findReportFile or touching disk
    assert.equal(result.ok, false);
    assert.match(result.error, /Invalid report selector/);
    assert.equal(existsSync(scratchDir), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: no matching report -> ok:false, no directories created", () => {
  // Given a root where findReportFile never resolves
  const root = makeRoot();
  const findReportFile = () => null;
  try {
    // When resolving paths for a report that doesn't exist
    const result = resolvePdfPaths("999", root, findReportFile);

    // Then it fails with a user-facing error and never touches the filesystem
    assert.equal(result.ok, false);
    assert.match(result.error, /No report #999 found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: a re-evaluated row threads the LINKED report number, not the tracker #", () => {
  // Given findReportFile resolves the tracker `#` (1079) to its re-eval report
  // file (1086-…) — the row's Report cell was repointed on re-evaluation, so the
  // two numbers diverge by design.
  const root = makeRoot();
  const findReportFile = (input) =>
    input === "1079" ? join(root, "reports", "1086-xchujibian-software-pm-reval-2026-09-23.md") : null;
  try {
    // When resolving paths for the tracker `#` 1079
    const result = resolvePdfPaths("1079", root, findReportFile, "软件项目经理");

    // Then the report number handed to mark-pdf-ready / the manifest is the ACTUAL
    // report (1086): mark-pdf-ready resolves by report number, so the tracker `#`
    // would match no row and leave the PDF column ❌ (the 「打开定制简历」 bug).
    assert.equal(result.ok, true);
    assert.equal(result.paths.reportNum, "1086");
    // The exact report path is threaded too, so the pdf prompt can name the file
    // instead of asking the agent to glob reports/1086-*.md (2026-10-09: a weak
    // model turned that glob into six envelope-less failures).
    assert.equal(result.paths.reportFile, join(root, "reports", "1086-xchujibian-software-pm-reval-2026-09-23.md"));
    // Scratch HTML is named by the same resolved number so renderAndMarkPdf's
    // cleanup prefix (cv-web-${reportNum}.) still finds and removes it.
    assert.equal(result.paths.html, join(root, ".career-ops-web", "pdf-tmp", "cv-web-1086.html"));
    // The short name is keyed to the RESOLVED report number (1086), not the tracker #
    assert.equal(result.paths.finalPdf, join(root, "output", "cv-1086-软件项目经理.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: a normal row (tracker # == report number) is unchanged", () => {
  // Given findReportFile resolves 018 to its own report file (no re-eval)
  const root = makeRoot();
  const findReportFile = (input) => (input === "018" ? join(root, "reports", "018-acme-2026-07-01.md") : null);
  try {
    const result = resolvePdfPaths("018", root, findReportFile, "PM");
    // Then reportNum echoes the tracker # (they match), keeping the common path intact.
    assert.equal(result.ok, true);
    assert.equal(result.paths.reportNum, "018");
    assert.equal(result.paths.html, join(root, ".career-ops-web", "pdf-tmp", "cv-web-018.html"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolvePdfPaths: a report filename without a leading number keys the name by the raw selector", () => {
  // Given findReportFile resolves to a filename that doesn't match ^\d+-…
  const root = makeRoot();
  const findReportFile = (input) => (input === "7" ? join(root, "reports", "not-the-expected-shape.md") : null);
  try {
    // When resolving paths for report #7
    const result = resolvePdfPaths("7", root, findReportFile, "PM");

    // Then it still succeeds, keying the short name by the raw selector
    assert.equal(result.ok, true);
    assert.equal(result.paths.finalPdf, join(root, "output", "cv-7-pm.pdf"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cvShortStem (ADR-0076) ─────────────────────────────────────────
// The flat tailored-CV basename: cv-{report number}-{role}, with the WHOLE
// filename (stem + ".pdf") ≤ 20 Unicode code points. These cases pin the
// normalization and shrinking in one place so the web backend and the
// modes/pdf.md CLI algorithm cannot drift apart.

test("cvShortStem: a Chinese role keeps its characters and fits", () => {
  // Given a CJK role and a 3-digit report number
  // When building the short stem
  const stem = cvShortStem("042", "售前经理");
  // Then the number and the role both survive, and stem+".pdf" is under budget
  assert.equal(stem, "cv-042-售前经理");
  assert.equal([...`${stem}.pdf`].length, 15);
});

test("cvShortStem: parenthetical notes are dropped whole (full- and half-width)", () => {
  assert.equal(cvShortStem("1080", "售前经理（北京base-zz）"), "cv-1080-售前经理");
  assert.equal(cvShortStem("042", "PM 2 (Phase 2)"), "cv-042-pm-2");
});

test("cvShortStem: long ASCII roles drop whole words from the tail", () => {
  // "senior-backend-engineer" cannot fit the 9-char role budget — "engineer"
  // is dropped, then "backend" — whole words go before any mid-word cut.
  assert.equal(cvShortStem("042", "Senior Backend Engineer"), "cv-042-senior");
});

test("cvShortStem: a single overlong word is hard-truncated at the budget", () => {
  // 16-char stem budget - "cv-042-" (7) = 9 role chars for a one-word role.
  assert.equal(cvShortStem("042", "Verylongsinglewordtitle"), "cv-042-verylongs");
});

test("cvShortStem: an exactly-20 filename is allowed (boundary)", () => {
  // cv-042-pre-sales.pdf == 20 code points: fits, and must NOT be shortened.
  const stem = cvShortStem("042", "Pre-Sales");
  assert.equal(stem, "cv-042-pre-sales");
  assert.equal([...`${stem}.pdf`].length, 20);
});

test("cvShortStem: empty or note-only roles degrade to the bare report number", () => {
  assert.equal(cvShortStem("042", ""), "cv-042");
  assert.equal(cvShortStem("042", "   "), "cv-042");
  assert.equal(cvShortStem("042", "（注记）"), "cv-042");
});

test("cvShortStem: full-width characters normalize via NFKC", () => {
  // ＳＥＮＩＯＲ　ＥＮＧＩＮＥＥＲ -> senior-engineer -> "engineer" dropped
  assert.equal(cvShortStem("042", "ＳＥＮＩＯＲ　ＥＮＧＩＮＥＥＲ"), "cv-042-senior");
});

test("cvShortStem: the report number is never truncated", () => {
  assert.equal(cvShortStem("1080", "x"), "cv-1080-x");
  // Longer numbers shrink the role budget, never the number itself
  assert.equal(cvShortStem("100000", "abcdefg"), "cv-100000-abcdef");
  assert.equal([..."cv-100000-abcdef.pdf"].length, 20);
});

test("cvShortStem: stem+.pdf stays within 20 code points for adversarial roles", () => {
  const roles = [
    "软件项目经理（AI方向）",
    "Senior Backend Engineer",
    "Verylongsinglewordtitle",
    "产品经理/Product Manager",
    "Ｃ＋＋开发工程师",
    "!!!",
    "数据工程师（数据平台/中台）",
    "a".repeat(200),
    "面试官看到的职位名称很长很长",
    "AI 产品经理（ToB）",
    "售前经理（北京base-zz）",
  ];
  for (const role of roles) {
    const stem = cvShortStem("042", role);
    assert.ok([...`${stem}.pdf`].length <= 20, `${role} -> ${stem}.pdf exceeds 20`);
    assert.ok(!/--/.test(stem) && !/-$/.test(stem), `${role} -> ${stem} has a bad separator`);
    assert.ok(stem.startsWith("cv-042"), `${role} -> ${stem} lost its report number`);
  }
});

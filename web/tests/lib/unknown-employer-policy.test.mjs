// The unknown-employer policy (ADR-0004) — its two-store precedence rule, the
// prompt injection that carries it to a worker, and the config page's write path.
//
// Why this file exists: ADR-0004 lists these as unit tests ("AppConfig 读写 /
// prompt 组装在两种策略下指令有无 / report-view 回退逻辑"), none of them were
// ever written, and the feature has a silent failure mode that only that missing
// coverage would have caught. Report #836 is the live case:
//
//   • the config page showed 显示代招方, because it paints from localStorage;
//   • `~/.career-ops-web/config.json` — the store /api/run and /api/batch-evaluate
//     actually read — still held "placeholder", because the mirror POST is
//     best-effort and its failure was swallowed;
//   • so the prompt carried NO agency directive, the worker followed
//     modes/oferta.md's default, and the tracker row's Company became `?`
//     while the UI claimed the opposite policy was in force.
//
// The two halves below are the two places that can break that chain: the
// precedence rule (which value the page — and therefore the user's mental model
// — treats as true) and the prompt injection (whether the value reaches a worker
// at all).
//
// Run:  node --test tests/lib/unknown-employer-policy.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNKNOWN_EMPLOYER_OPTIONS,
  UNKNOWN_EMPLOYER_DEFAULT,
  UNKNOWN_EMPLOYER_SENTINEL,
  agencyDisplayLabel,
  isUnknownEmployerPolicy,
  normalizeAgencyName,
  resolveCompanyLabel,
  resolveUnknownEmployer,
} from "../../src/lib/unknown-employer.mjs";
import { buildPrompt, buildBatchPrompt } from "../../src/lib/run-prompts.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORM = readFileSync(join(WEB, "src", "components", "config-form.tsx"), "utf8");
const DICT = readFileSync(join(WEB, "src", "lib", "i18n", "clusters", "config.ts"), "utf8");

const ARGS = { input: "https://www.zhipin.com/job_detail/1a689d20bca73c7f0nd83d-5FVFS.html", memory: "", today: "2026-09-13" };

// ── 1. precedence: the server store is what a run obeys ──────────────────────

test("resolveUnknownEmployer: the server value wins over the local mirror", () => {
  // Given the exact #836 divergence — the page's mirror says agency, the store
  // every evaluation reads says placeholder
  // Then the server one is what the page must show, because it is the one in force
  assert.equal(resolveUnknownEmployer({ server: "placeholder", local: "agency" }), "placeholder");
  assert.equal(resolveUnknownEmployer({ server: "agency", local: "placeholder" }), "agency");
});

test("resolveUnknownEmployer: the local mirror is only a fallback", () => {
  // Fresh install / /api/config unreachable: nothing has ever been written to the
  // server, so the pick the user already made locally is still the best answer
  assert.equal(resolveUnknownEmployer({ server: undefined, local: "agency" }), "agency");
  assert.equal(resolveUnknownEmployer({ local: "agency" }), "agency");
  // …and with nothing anywhere, the documented default (`?`) applies
  assert.equal(resolveUnknownEmployer({}), UNKNOWN_EMPLOYER_DEFAULT);
  assert.equal(resolveUnknownEmployer(), UNKNOWN_EMPLOYER_DEFAULT);
});

test("resolveUnknownEmployer: a junk value is NOT a value", () => {
  // The old inline check was `OPTIONS.includes(v) ? v : "placeholder"` in one
  // place and a bare cast in another; a junk string must never be displayed as a
  // policy nor forwarded as one. Both stores are validated.
  for (const junk of ["", " ", "AGENCY", "Placeholder", "confidential", 0, 1, true, [], {}, null, undefined]) {
    assert.equal(isUnknownEmployerPolicy(junk), false, `${JSON.stringify(junk)} must not be a policy`);
    assert.equal(resolveUnknownEmployer({ server: junk, local: junk }), UNKNOWN_EMPLOYER_DEFAULT);
  }
  for (const ok of UNKNOWN_EMPLOYER_OPTIONS) assert.equal(isUnknownEmployerPolicy(ok), true, ok);
});

// ── 2. injection: the value has to reach the worker prompt ───────────────────

test("buildPrompt(evaluate): agency injects the directive, placeholder injects nothing", () => {
  const agency = buildPrompt({ kind: "evaluate", ...ARGS, unknownEmployer: "agency" });
  // The worker is a headless CLI: this prose is the ONLY signal it gets, so it has
  // to say where to use the agency (prompt header ≙ report header, TSV field,
  // filename slug) or `?` still lands in the tracker.
  assert.match(agency, /UNKNOWN EMPLOYER POLICY/);
  assert.match(agency, /use the POSTING AGENCY as the company/i);
  assert.match(agency, /\"\?\" sentinel/);

  const placeholder = buildPrompt({ kind: "evaluate", ...ARGS, unknownEmployer: "placeholder" });
  const absent = buildPrompt({ kind: "evaluate", ...ARGS });
  // Default档 must stay byte-identical to the pre-feature prompt: the ABSENCE of
  // the directive is the documented behaviour, not a missing case.
  assert.ok(!placeholder.includes("UNKNOWN EMPLOYER POLICY"));
  assert.equal(placeholder, absent, "an explicit placeholder must not change the prompt");
});

test("buildBatchPrompt: the agency directive survives the batch rewrite", () => {
  // The batch path rewrites parts of the prompt by string replace (number pinning,
  // inline-JD swap, timing block). The directive is appended by buildPrompt, so a
  // rewrite that drops the tail would silently disable the policy for every
  // web-batch / browser-extension evaluation — the exact path #836 came from.
  const p = buildBatchPrompt("836", { ...ARGS, unknownEmployer: "agency" });
  assert.match(p, /UNKNOWN EMPLOYER POLICY/);
  assert.match(p, /use the POSTING AGENCY as the company/i);
  // …and the rewrite still did its own job
  assert.match(p, /reports\/836-{company-slug}-2026-09-13\.md/);
  // The default档 batch prompt carries no trace of the directive either
  assert.ok(!buildBatchPrompt("836", { ...ARGS, unknownEmployer: "placeholder" }).includes("UNKNOWN EMPLOYER POLICY"));
  assert.equal(
    buildBatchPrompt("836", { ...ARGS }),
    buildBatchPrompt("836", { ...ARGS, unknownEmployer: "placeholder" }),
    "placeholder must be a no-op for batch prompts too",
  );
});

// ── 3. the poster label: 「{代招方}（代招）」 ───────────────────────────────────
//
// The left column is the REAL `**Via:**` text of every `?` row in this user's
// tracker (25 rows), not invented shapes. The point of the table: the Via field is
// free text — the same agency writes itself as 「云憬人力·猎头顾问（猎头中介）」,
// 「锐仕方达 (猎头顾问 王女士，哈尔滨分公司)」 or, pasted by the board, as
// 「猎头（河南万仕企业管理咨询有限公司）」. Rendering it raw next to 「（代招）」
// buries the firm name in the agency's own self-description.

const VIA_LABELS = [
  // 公司名 · 联系人/角色 —— 取公司名那一半
  ["云憬人力·猎头顾问（猎头中介）", "云憬人力（代招）"],
  ["承方人力·猎头顾问", "承方人力（代招）"],
  ["天津辉锐人力资源管理·猎头顾问", "天津辉锐人力资源管理（代招）"],
  ["安励猎头·李欣琪", "安励猎头（代招）"],
  // 角色词 — 公司名（分隔符前只是角色词时反过来取后半）
  ["猎头 — 郑州睿资达人力资源管理服务有限公司（高女士）", "郑州睿资达人力资源管理服务有限公司（代招）"],
  // 括号里是角色/联系人 → 去掉
  ["锐仕方达（猎头中介）", "锐仕方达（代招）"],
  ["锐仕方达江宁分公司（猎头）", "锐仕方达江宁分公司（代招）"],
  ["锐仕方达 (猎头)", "锐仕方达（代招）"],
  ["锐仕方达 (猎头顾问 王女士，哈尔滨分公司)", "锐仕方达（代招）"],
  ["上海爱博斯企业管理咨询有限公司 (猎头夏女士)", "上海爱博斯企业管理咨询有限公司（代招）"],
  ["河南百硕数字科技有限公司 (outsourcing)", "河南百硕数字科技有限公司（代招）"],
  ["上海骁聘人力资源有限公司（猎头中介，非直招）", "上海骁聘人力资源有限公司（代招）"],
  ["江苏高凡企业管理（猎头顾问：张旭）", "江苏高凡企业管理（代招）"],
  ["永城市汇智人才服务有限公司（猎头）", "永城市汇智人才服务有限公司（代招）"],
  ["北京蓝海汇诚人力资源有限公司 (猎头招聘)", "北京蓝海汇诚人力资源有限公司（代招）"],
  ["河南蓝辉人力资源管理有限公司（猎头）", "河南蓝辉人力资源管理有限公司（代招）"],
  // 括号里才是公司名 → 取括号里的
  ["猎头（河南万仕企业管理咨询有限公司）", "河南万仕企业管理咨询有限公司（代招）"],
  // 本来就干净
  ["猎磐人力资源服务（郑州）有限公司", "猎磐人力资源服务（郑州）有限公司（代招）"],
  ["北京正丛科技有限公司", "北京正丛科技有限公司（代招）"],
];

test("agencyDisplayLabel: every real Via shape reduces to the firm name + 代招", () => {
  for (const [via, expected] of VIA_LABELS) {
    assert.equal(normalizeAgencyName(via) + "（代招）", expected, `via=${via}`);
  }
});

test("agencyDisplayLabel: 直招 `—` and empty Via produce no label", () => {
  // `Via: —` is the documented "direct posting, no agency" sentinel (modes/oferta.md
  // §2). Treating it as a name would print an em dash where the company belongs —
  // and would defeat the caller's fallback to the `?` sentinel.
  for (const nothing of ["—", "", "   ", null, undefined]) {
    assert.equal(normalizeAgencyName(nothing), "", JSON.stringify(nothing));
    assert.equal(agencyDisplayLabel(nothing), "", JSON.stringify(nothing));
  }
});

test("agencyDisplayLabel: never double-marks, and no label leaks into the tracker", () => {
  assert.equal(agencyDisplayLabel("云憬人力（代招）"), "云憬人力（代招）");
  // The suffix is a DISPLAY concern. resolveCompanyLabel must not hand a marked
  // string back to anything that writes (it is only ever fed to renderers), and a
  // known employer must pass through untouched.
  assert.equal(resolveCompanyLabel({ company: "河南领驰", agency: "云憬人力·猎头顾问", policy: "agency" }), "河南领驰");
});

test("resolveCompanyLabel: `?` rows follow the policy, everything else is untouched", () => {
  const row = { company: UNKNOWN_EMPLOYER_SENTINEL, agency: "云憬人力·猎头顾问（猎头中介）" };
  assert.equal(resolveCompanyLabel({ ...row, policy: "agency" }), "云憬人力（代招）");
  // placeholder (`?`) is the documented default — the tracker value stands
  assert.equal(resolveCompanyLabel({ ...row, policy: "placeholder" }), "?");
  assert.equal(resolveCompanyLabel({ ...row, policy: undefined }), "?");
  // no usable agency (direct posting, missing report, unreadable Via) → keep `?`
  assert.equal(resolveCompanyLabel({ company: "?", agency: "—", policy: "agency" }), "?");
  assert.equal(resolveCompanyLabel({ company: "?", agency: "", policy: "agency" }), "?");
  assert.equal(resolveCompanyLabel({ company: "?", agency: undefined, policy: "agency" }), "?");
  // the report title fallback (a real name is known) is not a `?` row
  assert.equal(resolveCompanyLabel({ company: "河南某中型生活服务(O2O)公司", agency: "云憬人力", policy: "agency" }), "河南某中型生活服务(O2O)公司");
});

// ── 4. the config page's write path ──────────────────────────────────────────
//
// config-form.tsx is TSX and cannot be imported by `node --test`; the invariants
// are asserted over the source, the same tradeoff clis-coverage.test.mjs and
// config-ai-tool-picker.test.mjs document. The regression they pin is "the page
// let a policy change sit in the client store only".

test("config-form: picking a policy persists it, and the failure is shown", () => {
  const block = FORM.slice(
    FORM.indexOf('t("config.unknownEmployerTitle")'),
    FORM.indexOf("<JobTargetSettings />"),
  );
  assert.ok(block.length > 0, "config-form.tsx shape changed — the unknown-employer block was not found");
  // 选中即落库: relying on the Save button is how the two stores diverged (#836)
  assert.match(block, /void persistUnknownEmployer\(policy\)\.then\(\(ok\) => setPolicySyncFailed\(!ok\)\)/);
  // …and a lost server write must be VISIBLE, not swallowed (the old helper was
  // `pushServerConfig(...).catch(() => {})`)
  assert.match(block, /policySyncFailed && \(/);
  assert.match(block, /t\("config\.unknownEmployerSyncFailed"\)/);
});

test("config-form: the page reconciles with the server value on load", () => {
  // The mirror can be stale in either direction; the page must display the value
  // the evaluation will actually use, and copy it back so the report page's
  // historical-row fallback agrees with it.
  assert.match(FORM, /readServerUnknownEmployer\(\)\.then\(\(server\) => \{/);
  assert.match(FORM, /mirrorUnknownEmployer\(server\)/);
});

test("the list and the detail page share ONE label rule", () => {
  // They drifted once already: the report page grew an agency fallback the list
  // never had, so #836 read 「?」 in the list and 「云憬人力」 on its own page. The
  // rule now lives in unknown-employer.mjs and both call it — these asserts pin the
  // wiring (TSX is not importable here; same tradeoff as the guard above).
  const LIST = readFileSync(join(WEB, "src", "components", "pipeline-view.tsx"), "utf8");
  const REPORT = readFileSync(join(WEB, "src", "components", "report-view.tsx"), "utf8");
  const CORE = readFileSync(join(WEB, "src", "lib", "career-ops.ts"), "utf8");

  assert.match(LIST, /resolveCompanyLabel\(\{ company: r\.company, agency: r\.reportVia, policy: employerPolicy \}\)/,
    "the pipeline list must render the resolved label, fed by the row's report Via");
  assert.match(REPORT, /resolveCompanyLabel\(\{ company: raw, agency: field\("Via"\), policy: employerPolicy \}\)/,
    "the report page must use the shared rule, not a private copy of it");
  // The list is server-rendered from a zero-IO parse: the Via has to be attached
  // server-side, and ONLY for `?` rows (a known employer needs no report read).
  // ADR-0037 把「URL 头 / 报告薪资 / Via」并进同一次读盘，形状随之改变（不再有
  // per-row 的 `readReportVia(a)` 内联调用）——这两条钉的是新的接线，不变的仍是
  // 那条不变量：`?` 判定只有一处，Via 只属于 `?` 行。
  assert.match(CORE, /const isUnknownEmployer = app\.company\.trim\(\) === "\?";/,
    "readReportFacts must decide the Via by the same `?` test");
  assert.match(CORE, /\.\.\.\(f && f\.via !== undefined \? \{ reportVia: f\.via \} : null\)/,
    "pipelineSummary must attach the report Via to `?` rows");
});

test("the new copy exists in both dictionaries", () => {
  const [enBlock, zhBlock] = DICT.split("export const zh");
  assert.ok(enBlock.includes('"config.unknownEmployerTitle"'), "config.ts shape changed — key parsing is stale");
  for (const block of [enBlock, zhBlock]) {
    assert.ok(block.includes('"config.unknownEmployerSyncFailed":'), "missing config.unknownEmployerSyncFailed");
  }
});

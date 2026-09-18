import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "@/lib/core/safe-write";
import { parseApplications } from "@/lib/tracker-table.mjs";
// One definition of the `{n}-RESERVED.md` convention, shared with
// run-cli-support.mjs — see report-files.mjs for why it lives there.
import { isReservedReportFile } from "@/lib/report-files.mjs";
// Reuse the canonical tolerant report parser (format.ts is explicitly shared
// by server + client, no fs). One definition of `**URL:**` extraction.
import { parseReport } from "@/lib/format";
// Durable inbox score map (URL → tracker score) — pure + client-importable, so
// the triage view can show already-evaluated postings after a refresh.
import { buildScoreByUrl } from "@/lib/inbox-score.mjs";
// Pending-chapter reader for pipeline.md — pure parser in .mjs (node --test
// locked), keeps the inbox from reading user scratch chapters as offers.
import { pendingSectionLines } from "@/lib/pipeline-sections.mjs";
// 收件箱薪资（ADR-0023）：note 尾段 → salaryText / salaryUnknown。纯 .mjs
// （node --test locked），解析口径复用探索页 parseSalaryText。
import { inboxSalaryFromNote } from "@/lib/inbox-salary.mjs";
// 报告薪资（ADR-0037）：tracker 行的薪资 = 该行报告 Machine Summary 的
// `advertised_comp` → 归一化月薪 K 区间。纯 .mjs（node --test locked），口径与
// 上面收件箱的采集卡片薪资**刻意分开**（ADR-0023 决议 5 的口径边界）。
import { extractAdvertisedComp, parseReportSalary } from "@/lib/report-salary.mjs";
// Eval timing summary (评估用时) — pure parser in .mjs (node --test locked),
// file read here like every other user-layer data file.
import { evalTimingSummary } from "@/lib/eval-timings.mjs";
import type { EvalTimingEntry } from "@/lib/eval-timing";
// 公司体检台账 (ADR-0025) — tolerant reader mirror of lib/log-checkup.mjs,
// keyed by tracker#; display-only, never a scoring input.
import { checkupIndex, suggestsCheckup } from "@/lib/company-checkups.mjs";
import type { CheckupEntry } from "@/lib/format";

/**
 * Resolve the career-ops "home" — the directory holding the user's sibling
 * files (cv.md, data/, reports/). In production the web/ app lives inside the
 * career-ops checkout, so the home is its parent (..). Dev overrides via
 * CAREER_OPS_ROOT to read the user's real (gitignored) data from a separate
 * checkout — see web/.env.local.
 *
 * The cwd-based default must not assume where the server was started from:
 * `next dev` runs with cwd = web/ (so ".." is home), but the standalone
 * production server (web/.next/standalone/server.js) calls process.chdir() on
 * itself, making the cwd's parent web/.next — not home. So when the fast path
 * does not look like a career-ops root, probe upward until a directory that
 * actually holds the user's files (cv.md or data/applications.md) is found.
 */
export function careerOpsRoot(): string {
  const env = process.env.CAREER_OPS_ROOT?.trim();
  if (env) return env;
  // Fast path: dev layout (cwd = web/), where the parent already is home.
  const devHome = path.resolve(process.cwd(), "..");
  if (looksLikeHome(devHome)) return devHome;
  // Standalone layout: probe upward from the cwd, capped so a stray marker
  // far up the tree cannot hijack the root.
  let dir = path.resolve(process.cwd());
  for (let depth = 0; depth < 8; depth++) {
    if (looksLikeHome(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return devHome;
}

/** True when `dir` holds the user's files — the career-ops home marker. */
function looksLikeHome(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, "cv.md")) ||
      fs.existsSync(path.join(dir, "data", "applications.md"))
    );
  } catch {
    return false;
  }
}

/**
 * Absolute path to a core root script (e.g. doctor, verify-portals). The `.mjs`
 * is assembled here from the bare name so the literal never appears as a direct
 * `execFile`/`spawn` argument — Next's bundler statically traces such literals
 * as module imports and fails the production build otherwise.
 */
export function rootScript(nameNoExt: string): string {
  return path.join(careerOpsRoot(), `${nameNoExt}.mjs`);
}

// Feature-detect the core's `tracker.mjs delete --num` row-delete (#1200) by probing
// the local script source — older checkouts lack it, so the delete UI hides itself.
export function trackerCanDelete(): boolean {
  try {
    const src = fs.readFileSync(rootScript("tracker"), "utf8");
    return src.includes("delete") && src.includes("--num");
  } catch {
    return false;
  }
}

function read(rel: string): string | null {
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), rel), "utf8");
  } catch {
    return null;
  }
}

export type InboxJob = { url: string; company: string; role: string; location?: string; compensation?: string; done: boolean; postedAt?: string; salaryText?: string; salaryUnknown?: boolean };

/** A pipeline-row segment like `posted: 2026-07-14`, `trust: 62 stale` or
 *  `note: …` — the core appends these LABELED segments after whatever
 *  positional shape a row has (3/4/5 columns), so a naive positional reader
 *  would misread them as location/compensation on short rows. Any
 *  `word:`-prefixed segment is treated as labeled (forward-compatible with
 *  labels the core hasn't invented yet). */
const LABELED_SEGMENT = /^([a-z][a-z_-]*):\s*(.*)$/i;

/** Parse data/pipeline.md — `- [ ] URL | Company | Role [| Location [| Compensation]] [| label: …]*`.
 *  Positional split for the first columns (the optional 4th `location` #1015
 *  and 5th `compensation` #1017 must NOT bleed into `role`); labeled segments
 *  (posted:/trust:/note:/…) are filtered out of positional assignment wherever
 *  they appear and surfaced when useful (posted: → postedAt). Unknown labels
 *  and further trailing columns are ignored gracefully. */
export function readInbox(): InboxJob[] {
  const md = read("data/pipeline.md");
  if (!md) return [];
  const jobs: InboxJob[] = [];
  // Section-scoped (pipeline-sections.mjs): the inbox is the Pending chapter
  // only. A whole-file checkbox scan dragged user scratch chapters (`## 非郑州`,
  // `## 暂存`) into the triage view — 49 rows on 2026-09-14, 25 already scored.
  for (const line of pendingSectionLines(md)) {
    const m = line.match(/^\s*-\s*\[([ xX])\]\s*(.+)$/);
    if (!m) continue;
    const all = m[2].split("|").map((s) => s.trim());
    const labels = new Map<string, string>();
    const parts: string[] = [];
    for (const [i, seg] of all.entries()) {
      // the URL cell can contain a colon-y value but is always position 0
      const lm = i >= 3 ? seg.match(LABELED_SEGMENT) : null;
      if (lm) labels.set(lm[1].toLowerCase(), lm[2].trim());
      else parts.push(seg);
    }
    if (parts.length < 3 || !parts[0]) continue; // need at least url | company | role
    const posted = labels.get("posted");
    // the URL cell is commonly written with Markdown auto-link angle brackets
    // (`<https://…>`); strip them so downstream URL keys match their clean
    // `**URL:**` counterparts in reports / scan rows (normalizeUrl & the exact
    // inbox-url lookup both see the raw cell). Harmless no-op on plain URLs.
    const rawUrl = parts[0].trim();
    const url = rawUrl.startsWith("<") && rawUrl.endsWith(">") ? rawUrl.slice(1, -1) : rawUrl;
    // 收件箱薪资（ADR-0023）：只认 note 尾段里确认入管写入的薪资形态；无尾段/
    // 手写 note 的行一律 salaryUnknown（放行、打标、排序沉底——「不误删」取向）。
    const salary = inboxSalaryFromNote(labels.get("note"), url);
    jobs.push({
      done: m[1].toLowerCase() === "x",
      url,
      company: parts[1],
      role: parts[2],
      location: parts[3] || undefined, // optional 4th column (#1015)
      compensation: parts[4] || undefined, // optional 5th column (#1017); 6th+ ignored
      // the row's own posting date (scan.mjs `posted:` label) — a more direct
      // freshness signal than the scan-history join, which stays as fallback
      postedAt: posted && /^\d{4}-\d{2}-\d{2}$/.test(posted) ? posted : undefined,
      salaryText: salary.salaryText,
      salaryUnknown: salary.salaryUnknown,
    });
  }
  return jobs;
}

/**
 * Read data/scan-history.tsv → Map<url, first_seen(YYYY-MM-DD)>. The scanner
 * already stamps every discovered posting with the date it was first seen
 * (col 2), so we derive the inbox's freshness signal here WITHOUT touching the
 * core (see the inbox-triage build: freshness = option A, no scanner change).
 * Tolerant by construction: no file → empty map (freshness facet just hides);
 * a malformed row is skipped, never thrown (missing ≠ corrupt).
 */
export function readScanDates(): Map<string, string> {
  const tsv = read("data/scan-history.tsv");
  const dates = new Map<string, string>();
  if (!tsv) return dates;
  const lines = tsv.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || (i === 0 && line.startsWith("url\t"))) continue; // skip header
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const url = line.slice(0, tab);
    const firstSeen = line.slice(tab + 1).split("\t")[0]?.trim();
    // keep the EARLIEST first_seen if a url recurs (it's "first" seen, after all)
    if (/^\d{4}-\d{2}-\d{2}$/.test(firstSeen) && !dates.has(url)) dates.set(url, firstSeen);
  }
  return dates;
}

/** 报告薪资的月薪 K 区间（ADR-0037）：minK/maxK 是展示用的区间，medianK 是排序值
 *  （中位值，与收件箱 ADR-0024 同口径）。 */
export type ReportSalaryRange = { minK: number; maxK: number; medianK: number };
/** 报告薪资（ADR-0037）。`range` 为 null = 字段有原文但解析不出月薪（列表显示
 *  「—」，原文仍在悬停提示里）；整个对象为 null = 连原文都没有（无报告，或字段是
 *  `null`/`~`/空）。 */
export type ReportSalary = { text: string; range: ReportSalaryRange | null };

export type Application = {
  n: string;
  date: string;
  /** Most recent re-evaluation date ("" when never re-evaluated). The Date
   *  column keeps the INITIAL evaluation date (#2808, 方向 A); this field
   *  carries the freshest `Re-eval YYYY-MM-DD` marker lifted from the notes. */
  revalDate: string;
  company: string;
  /** Intermediary channel (#1596): agency/recruiter firm, "—" for direct, "" when the tracker has no Via column. */
  via: string;
  role: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
  /** Posting URL from the tracker's URL column, "" when the tracker has none. */
  url: string;
  /** 评估用时 (ADR-0016): seconds of the latest eval session up to report
   *  delivery, joined from data/eval-timings.tsv by the pipeline page; null
   *  when no timing was recorded. Attached at page level, not by the parser. */
  evalDuration?: number | null;
  /** 报告头 `**Via:**` 的发帖/代招方名。仅对 Company 为 `?`（未知终端雇主）的行读取 ——
   * 那是代招方名字唯一的落点（tracker 没有 Via 列），列表页按未知雇主策略回退显示
   * （ADR-0004 D1）。同 evalDuration，页面级附加，解析器不管。 */
  reportVia?: string;
  /** 报告薪资（ADR-0037）：本行报告的 Machine Summary `advertised_comp`。同
   *  evalDuration/reportVia，页面级附加字段——解析器（tracker-table.mjs）不读报告。
   *  null/缺省 = 无可用原文，列表显示「—」。 */
  reportSalary?: ReportSalary | null;
};

/**
 * Parse data/applications.md — the tracker table (source of truth).
 * The header-aware parsing lives in tracker-table.mjs, which resolves headers
 * through the SAME alias table the Node tooling uses (tracker-aliases.json,
 * exported by tracker-parse.mjs as HEADER_ALIASES) — one shared source, no
 * web-side mirror to drift (#954, PR #1598 review).
 */
export function readApplications(): Application[] {
  const md = read("data/applications.md");
  if (!md) return [];
  return parseApplications(md, careerOpsRoot());
}

/**
 * 评估用时 map (report number → latest eval session summary), from the user's
 * data/eval-timings.tsv — see CONTEXT.md「评估用时」and ADR-0016 for the
 * report-delivery-only scope. Missing file / empty data → {} (the UI shows "—").
 */
export function readEvalTimings(): Record<string, EvalTimingEntry> {
  return evalTimingSummary(read("data/eval-timings.tsv") ?? "");
}

/**
 * Server-side lifecycle of the user's setup — mirrors the prerequisite list that
 * doctor.mjs uses (cv.md, config/profile.yml, modes/_profile.md, portals.yml), by
 * plain file-stat (no subprocess). Drives the home branch: first-run (no CV) →
 * the CV takeover; in-between (CV but no profile) → gentle nudges; established.
 */
export type LifecyclePhase = "first-run" | "in-between" | "established";
/**
 * Server-side lifecycle, mirroring the core doctor.mjs prerequisite list with the
 * SAME existsSync semantics (the SSOT the OnboardingBanner already reads via
 * /api/doctor). The 4 user-layer prereqs: cv.md, config/profile.yml,
 * modes/_profile.md, portals.yml.
 *   - first-run  → a TRULY empty install (no cv AND no data): the CV takeover.
 *     CRITICAL back-compat (maintainer): NEVER force onboarding on a user who
 *     already has data (a full pipeline/tracker with no cv.md is valid).
 *   - in-between → has cv/data but setup incomplete: dashboard + the nudge banner.
 *   - established → all 4 prereqs present.
 * onboardingNeeded mirrors doctor.mjs: true if ANY prereq is missing → show banner.
 */
export function doctorState(): {
  phase: LifecyclePhase;
  onboardingNeeded: boolean;
  missing: string[];
  hasCv: boolean;
  hasData: boolean;
} {
  const has = (rel: string) => {
    try {
      return fs.existsSync(path.join(careerOpsRoot(), rel));
    } catch {
      return false;
    }
  };
  const prereqs: [string, string][] = [
    ["cv.md", "cv.md"],
    ["config/profile.yml", "config/profile.yml"],
    ["modes/_profile.md", "modes/_profile.md"],
    ["portals.yml", "portals.yml"],
  ];
  const missing = prereqs.filter(([rel]) => !has(rel)).map(([, label]) => label);
  const hasCv = has("cv.md");
  const hasData = readApplications().length > 0 || readInbox().some((j) => !j.done);
  const onboardingNeeded = missing.length > 0;
  const phase: LifecyclePhase = !hasCv && !hasData ? "first-run" : onboardingNeeded ? "in-between" : "established";
  return { phase, onboardingNeeded, missing, hasCv, hasData };
}

export type PipelineSummary = {
  root: string;
  rootExists: boolean;
  inbox: InboxJob[];
  applications: Application[];
  /** Durable evaluation map: normalized posting URL → tracker score string,
   *  built from reports' `**URL:**` headers. Lets the inbox triage show real
   *  scores for postings evaluated outside this browser (CLI, batch, prior
   *  sessions) instead of a false "not scored". */
  scoredUrls: Record<string, { score: string }>;
  /** 公司体检 (ADR-0025): tracker# → latest company-checkup entry. Empty
   *  ledger / missing file → {} (graceful degradation, badge simply absent).
   *  Display-only — never feeds score, status, or any gate. */
  checkups: Record<string, CheckupEntry>;
};

export function pipelineSummary(): PipelineSummary {
  const root = careerOpsRoot();
  const scanDates = readScanDates();
  const applications = readApplications();
  // 一次读盘拿齐每行的报告事实（URL 头 / 报告薪资 / `?` 行的 Via，ADR-0037 决议 9）
  // —— 三者此前分别读一趟，合并后页面加载仍是「一行一读」。
  const facts = readReportFacts(applications);
  return {
    root,
    rootExists: fs.existsSync(root),
    // join the freshness date (first_seen) onto each raw posting — the inbox's
    // triage view orders/faceted-filters on it entirely client-side.
    inbox: readInbox().map((j) => ({ ...j, postedAt: j.postedAt ?? scanDates.get(j.url) })),
    // 每行带上报告薪资（列展示 + salary 排序）；`?`（未知雇主）行另带上报告的
    // `**Via:**` 头，让列表在 agency 策略下显示「{代招方}（代招）」而无需客户端读文件。
    applications: applications.map((a) => {
      const f = facts.get(a.n);
      return {
        ...a,
        reportSalary: f?.salary ?? null,
        ...(f && f.via !== undefined ? { reportVia: f.via } : null),
      };
    }),
    // score map 用同一次读盘取到的 `**URL:**` 头（每个 URL 首个 app 胜出）。
    scoredUrls: buildScoreByUrl(applications, (a) => facts.get(a.n)?.url),
    // 公司体检台账 (ADR-0025) — missing/empty file degrades to {} (badge absent).
    checkups: checkupIndex(read("data/company-checkups.tsv")),
  };
}

/** 一行的报告事实：一次读盘能拿到的三样（ADR-0037 决议 9）。 */
export type ReportFacts = {
  /** 报告 `**URL:**` 头（仅当是 http(s) 绝对链接时存在）。 */
  url?: string;
  /** 报告薪资；无报告 / 无原文 → null。 */
  salary: ReportSalary | null;
  /** 报告 `**Via:**` 头（发帖/代招方）——**仅** `?`（未知雇主）行才取值；其它行
   *  undefined 表示「不需要」。读不到时是 ""（调用方保持 `?`）。 */
  via?: string;
};

/**
 * 逐行读报告并把三样事实取齐（ADR-0037 决议 9）：`**URL:**` 头（喂 score map）、
 * Machine Summary 的 `advertised_comp`（报告薪资）、`?` 行的 `**Via:**`。
 *
 * 合并 NOT 是为了省事：URL 头原本单独读一趟、Via 再读一趟，薪资列若各自读一趟就是
 * 三趟全量报告读盘。这里按行只读一次，调用方各自 join。
 * 报告缺失/读失败不是错误——返回空事实（无 url、薪资 null），`?` 行的 via 退化为 ""，
 * 与合并前 `readReportVia` 的行为一致。
 */
export function readReportFacts(apps: Application[]): Map<string, ReportFacts> {
  const out = new Map<string, ReportFacts>();
  for (const app of apps) {
    const isUnknownEmployer = app.company.trim() === "?";
    const facts: ReportFacts = { salary: null, ...(isUnknownEmployer ? { via: "" } : null) };
    const file = resolveReportPathFor(app);
    if (file) {
      try {
        const md = fs.readFileSync(file, "utf8");
        const fields = parseReport(md).fields;
        const url = fields.find((f) => f.label === "URL")?.value;
        if (url && /^https?:\/\//i.test(url)) facts.url = url;
        facts.salary = parseReportSalary(extractAdvertisedComp(md)) as ReportSalary | null;
        if (isUnknownEmployer) facts.via = fields.find((f) => f.label === "Via")?.value ?? "";
      } catch {
        // 报告不可读：保持空事实（pipelineSummary 的旧行为）
      }
    }
    out.set(app.n, facts);
  }
  return out;
}

/** 把报告薪资（+ `?` 行的 reportVia）join 到行上。报告详情页在 `sortKey=salary`
 *  下用它复现列表页的顺序 —— 不 join 的话每行的薪资都是 null，「下一个」会退化成
 *  与列表页完全不同的顺序（ADR-0036 的不漂移约束，ADR-0037 决议 9）。 */
export function withReportSalaries(apps: Application[]): Application[] {
  const facts = readReportFacts(apps);
  return apps.map((a) => {
    const f = facts.get(a.n);
    return {
      ...a,
      reportSalary: f?.salary ?? null,
      ...(f && f.via !== undefined ? { reportVia: f.via } : null),
    };
  });
}

/** 报告头 `**Via:**`（发帖/代招方），按需读**单行**报告（`?` 行的体检对象判定，
 *  ADR-0026 决议 6）。走 readReportFacts 而不另写一份解析，via 的语义只有一个实现；
 *  只传一行，故仍是一次读盘。读不到报告 → ""，调用方保持 `?`。 */
function readReportVia(app: Application): string {
  return readReportFacts([app]).get(app.n)?.via ?? "";
}

export type ReportData = { content: string; file: string };

/** Locate the evaluation report for an application number.
 *  The tracker row's own report link is authoritative: report FILE numbers can
 *  differ from application numbers (e.g. app #309 → reports/308-…), so
 *  resolving only by leading filename number misses those. Links are
 *  normalized relative to the tracker file's directory (see #760). Falls back
 *  to the filename scan (reports/{n}-{slug}-{date}.md, possibly zero-padded)
 *  for rows without a parseable link.
 *
 *  Both the linked lookup and the fallback scan skip `{n}-RESERVED.md`
 *  placeholder files.
 *  `reserve-report-num.mjs` writes an empty `NNN-RESERVED.md` sentinel to
 *  claim a report number before a worker has actually written the report;
 *  it's normally deleted once the real report lands (or GC'd after 4h if
 *  abandoned). But "RESERVED" sorts alphabetically before nearly every real
 *  slug (company names start with lowercase/uppercase letters after the
 *  number-dash, "R" often lands mid-alphabet or earlier), so if a sentinel
 *  outlives its report — e.g. a worker was driven directly instead of
 *  through the orchestrator that owns cleanup — `.find()` could return the
 *  empty sentinel instead of the real report, making the report body and the
 *  Apply/PDF-ready checks disappear. */
export function findReportFile(n: string): string | null {
  const target = parseInt(n, 10);
  if (Number.isNaN(target)) return null;
  const root = careerOpsRoot();
  const app = readApplications().find((a) => parseInt(a.n, 10) === target);
  const linked = app?.report.match(/\]\(([^)]+)\)/)?.[1];
  if (linked) {
    const p = path.resolve(root, "data", linked);
    // Containment: a hand-edited link must not resolve outside the project.
    if (p.endsWith(".md") && !isReservedReportFile(p) && containedRealpath(p, root)) return p;
  }
  let files: string[];
  try {
    files = fs.readdirSync(path.join(root, "reports"));
  } catch {
    return null;
  }
  const match = files.find(
    (f) => f.endsWith(".md") && !isReservedReportFile(f) && parseInt(f, 10) === target,
  );
  if (!match) return null;
  const p = path.join(root, "reports", match);
  return containedRealpath(p, root) ? p : null;
}

/** True containment check: resolves symlinks before comparing, so a link
 *  planted under data/ or reports/ can't leak files outside the project. */
function containedRealpath(p: string, root: string): boolean {
  try {
    return fs.realpathSync(p).startsWith(fs.realpathSync(root) + path.sep);
  } catch {
    return false; // missing file or unresolvable link — treat as not found
  }
}

export function readReport(n: string): ReportData | null {
  const file = findReportFile(n);
  if (!file) return null;
  try {
    return { content: fs.readFileSync(file, "utf8"), file: path.basename(file) };
  } catch {
    return null;
  }
}

export function findApplication(n: string): Application | null {
  return readApplications().find((a) => a.n === n) ?? null;
}

/** 体检对象判定（ADR-0026 决议 6）：company 非 `?` → company 本身；
 *  `?` 行（未知雇主）→ 报告 Via（招聘主体——尽调价值最高的对象）；
 *  Via 缺失 → ok:false + 稳定 reason 码（报告页按钮据此禁用并给文案，宿主范围见 ADR-0032）。 */
export function findCheckupTarget(
  n: string,
): { ok: true; company: string; source: "company" | "via" } | { ok: false; reason: "row-not-found" | "no-via" } {
  const app = findApplication(n);
  if (!app) return { ok: false, reason: "row-not-found" };
  const company = app.company.trim();
  if (company !== "?") return { ok: true, company, source: "company" };
  const via = readReportVia(app).trim();
  if (!via || via === "—") return { ok: false, reason: "no-via" };
  return { ok: true, company: via, source: "via" };
}

/** 单一类型来源：按钮组件与报告视图从这里 import，不再各自手写形状。 */
export type CheckupTargetResult = ReturnType<typeof findCheckupTarget>;

/** 本行的最近一次公司体检（checkupIndex 按 tracker# 索引）；无台账/无记录 → null。 */
export function readCheckupFor(n: string): CheckupEntry | null {
  const idx = checkupIndex(read("data/company-checkups.tsv")) as Record<string, CheckupEntry>;
  return idx[n] ?? null;
}

/**
 * 「建议体检」候选（ADR-0041 决议 2）：逐行解析报告头的 Legitimacy + tracker 分数，
 * 用 suggestsCheckup 纯函数判定，返回 { [n]: true }。镜像 readApplicationUrls 的
 * 懒加载供给方式 —— pipeline 普通浏览不做报告头读取，这个读取只发生在已评估 tab
 * 的客户端拉取（/api/pipeline/checkup-suggest）时。台账整份读一次建索引，不逐行查。
 */
export function readCheckupSuggestions(apps: Application[]): Record<string, true> {
  const ledgerIdx = checkupIndex(read("data/company-checkups.tsv") ?? "") as Record<string, CheckupEntry>;
  const out: Record<string, true> = {};
  for (const app of apps) {
    const file = resolveReportPathFor(app);
    if (!file) continue;
    let legitimacy: string | null = null;
    try {
      legitimacy = parseReport(fs.readFileSync(file, "utf8")).legitimacy;
    } catch {
      continue; // 读不出的报告不产生建议 —— 宁缺毋假
    }
    const scoreNum = parseFloat(app.score);
    if (!suggestsCheckup({ score: Number.isFinite(scoreNum) ? scoreNum : null, legitimacy, hasCheckup: ledgerIdx[app.n] != null })) continue;
    out[app.n] = true;
  }
  return out;
}

/**
 * Resolve the report file path for an ALREADY-parsed Application, without the
 * `readApplications()` re-read that `findReportFile(n)` does. Same containment +
 * RESERVED-sentinel rules as `findReportFile`. Used by batch read paths that
 * loop over many applications — re-reading the tracker file per app would be
 * O(n²) FS reads (#749-class regression). Returns null if the link is missing
 * or the file can't be resolved safely.
 */
function resolveReportPathFor(app: Application): string | null {
  const root = careerOpsRoot();
  const linked = app.report.match(/\]\(([^)]+)\)/)?.[1];
  if (linked) {
    const p = path.resolve(root, "data", linked);
    if (p.endsWith(".md") && !isReservedReportFile(p) && containedRealpath(p, root)) return p;
  }
  // Fallback: scan reports/ for a file whose leading number matches app.n.
  // Mirrors findReportFile's fallback so a hand-edited or missing link still
  // resolves the right report.
  let files: string[];
  try {
    files = fs.readdirSync(path.join(root, "reports"));
  } catch {
    return null;
  }
  const target = parseInt(app.n, 10);
  if (Number.isNaN(target)) return null;
  const match = files.find(
    (f) => f.endsWith(".md") && !isReservedReportFile(f) && parseInt(f, 10) === target,
  );
  if (!match) return null;
  const p = path.join(root, "reports", match);
  return containedRealpath(p, root) ? p : null;
}

/** Read a single application's posting URL from its report's `**URL:**` header
 *  field. Returns undefined when the report is missing, has no URL field, or
 *  the URL isn't an http(s) link (the re-evaluate worker requires an absolute
 *  URL — see ReevaluateButton's `url.startsWith("http")` guard). */
export function readApplicationUrl(app: Application): string | undefined {
  const file = resolveReportPathFor(app);
  if (!file) return undefined;
  try {
    const md = fs.readFileSync(file, "utf8");
    const url = parseReport(md).fields.find((f) => f.label === "URL")?.value;
    return url && /^https?:\/\//i.test(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Batch read posting URLs for a set of applications → Record<n, url> covering
 * ONLY the apps whose report resolves to a real http(s) URL. Drives the batch
 * re-evaluate flow: the client fires one `kind:"evaluate"` job per entry here.
 * Tolerant by construction — a missing report or non-http URL simply drops
 * that entry from the map; the caller surfaces "N of M re-evaluatable".
 */
export function readApplicationUrls(apps: Application[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const app of apps) {
    const url = readApplicationUrl(app);
    if (url) out[app.n] = url;
  }
  return out;
}

/** The CANONICAL user-customization file the CLI/TUI reads. Durable facts the
 *  web assistant learns go HERE (single source of truth) inside a managed marker
 *  block — so the CLI sees them too. No web-only memory store (that would drift). */
export function profilePath(): string {
  return path.join(careerOpsRoot(), "modes", "_profile.md");
}

const NOTES_START = "<!-- co-web-notes:start -->";
const NOTES_END = "<!-- co-web-notes:end -->";

/** Read back ONLY the web-assistant managed notes from modes/_profile.md (small,
 *  focused — the agent reads the rest of the canonical files itself). Falls back
 *  to the legacy web-only memory file for back-compat. */
export function readMemory(): string {
  try {
    const md = fs.readFileSync(profilePath(), "utf8");
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) return md.slice(i + NOTES_START.length, j).trim();
  } catch {
    /* no _profile.md yet */
  }
  try {
    return fs.readFileSync(path.join(careerOpsRoot(), ".career-ops-web", "memory.md"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Append a durable fact to the canonical modes/_profile.md (creating the file +
 *  managed block if needed), PRESERVING existing user content. */
export function rememberFact(fact: string): "ok" | "deduped" | "error" {
  const f = fact.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!f) return "deduped";
  const p = profilePath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let md = "";
    try {
      md = fs.readFileSync(p, "utf8");
    } catch {
      md = "";
    }
    const i = md.indexOf(NOTES_START);
    const j = md.indexOf(NOTES_END);
    if (i !== -1 && j !== -1 && j > i) {
      if (md.slice(i, j).includes(f)) return "deduped";
      atomicWrite(p, md.slice(0, j) + `- ${f}\n` + md.slice(j));
      return "ok";
    }
    if (md.includes(f)) return "deduped";
    const section = `\n\n## Notes from the web assistant\n${NOTES_START}\n- ${f}\n${NOTES_END}\n`;
    const base = md.trim() ? md.replace(/\n*$/, "\n") : "# Profile customization\n";
    atomicWrite(p, base + section);
    return "ok";
  } catch {
    return "error";
  }
}

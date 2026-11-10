// Both spawners are needed here, and the distinction matters: the agent CLI goes
// through spawnHeadlessCli (which closes stdin so `codex exec` can't hang waiting
// on it, #2085), while the PDF render is a plain Node child process with no CLI
// sandbox in the way (#2172) and so passes `spawn` itself to renderAndMarkPdf.
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after } from "next/server";
import { resolveCli, dropCrossEngineModel } from "@/lib/clis";
import { cliDisplayName } from "@/lib/cli-labels.mjs";
import { resolveWorkerInvocation } from "@/lib/worker-invocation.mjs";
import { accumulateTokens, authExpiredHint, blacklistGateLedgerFields, checkupArtifactRowCount, checkupArtifactTodayForTracker, classifyFatalStderr, fatalStopMessage, makeCheckupHtmlProbe, detectBlacklistGate, failureEvidence, failureLedgerMsg, hasNewCompletedReport, isFatalGenericStderr, persistRunOutcome, PERSISTENCE_GATED_KINDS, RUN_SILENCE_MS, silenceStopMessage, withModelFlag } from "@/lib/run-cli-support.mjs";
import { spawnHeadlessCli, terminateCli } from "@/lib/spawn-cli.mjs";
import { careerOpsRoot, readMemory, findReportFile, readInbox, readScanDates, findCheckupTarget, readApplications, rootScript, readMarketModesDir, listMarketModes, type InboxJob } from "@/lib/career-ops";
import { checkupDispatchText } from "@/lib/checkup-request.mjs";
import { registerCheckup, markCheckupRunning, clearCheckup, attachCheckupExit } from "@/lib/checkup-live.mjs";
import { OFFER_CHECKUP_SKILL_NAME, resolveSkillCopy, scanSkillRegistry } from "@/lib/skill-registry.mjs";
import { readAppConfig } from "@/lib/app-config";
import { normalizeUrl } from "@/lib/core/url-key.mjs";
import { resolvePdfPaths, type PdfPaths } from "@/lib/pdf-paths.mjs";
import { renderAndMarkPdf, writeCvHtml, pdfRunOutcome } from "@/lib/pdf-render.mjs";
import { createCvEnvelopeFilter, type CvEnvelope } from "@/lib/cv-envelope.mjs";
import { buildPrompt, isShellSafeCompanyName, clampInlineJd, clampInlineEmployer } from "@/lib/run-prompts.mjs";
// 任务卡可读标题（「公司 · 岗位」）：派发时从 pipeline 行/扩展雇主名带，完成后从
// 报告 Machine Summary 回填（与 /api/batch-evaluate 同一份函数）。
import { jobLabel, reportJobLabel, evaluateDisplayTitle, trackerUrlLabels } from "@/lib/job-label.mjs";
// 评估模式（CO-65）：profile.yml 的 language.modes_dir → 实际评估模式文件。
import { resolveMarketMode } from "@/lib/market-modes.mjs";
import { deriveRunReportNum, buildReconcileArgs } from "@/lib/run-reconcile.mjs";
import { acquireTrackerWrite, releaseTrackerWrite } from "@/lib/core/run-registry";
import { acquire, release, __setSizeSource, DEFAULT_POOL_SIZE } from "@/lib/core/concurrency-pool";
import { registerRun, setCancelHandler, publish, completeRun, getRunBuffer } from "@/lib/core/run-events";
import { appendRunRecord, updateRunRecord } from "@/lib/run-ledger.mjs";
import { buildRunLedgerSteps } from "@/lib/run-steps.mjs";
// 「查看 CLI 会话」（工作器卡片）：init 帧 session_id 提取（claude/qoder-cn）与
// opencode 的 --title 反查。
import { extractClaudeSessionId, findOpencodeSessionByTitle, opencodeRunTitle, canResumeSession } from "@/lib/cli-session.mjs";

// Feed the global concurrency pool the live configured size (app-config), re-read
// on every dispatch so a config-page edit takes effect without restart.
__setSizeSource(() => readAppConfig().concurrencyPool ?? DEFAULT_POOL_SIZE);

// 评估耗时埋点 (ADR-0016/0017): the pdf kind is READ-ONLY on the Claude path —
// #2172 denied it Bash and it must never regain that — so the agent cannot time
// itself. The backend owns the pdf step's boundaries instead (spawn → confirmed
// render) and logs through log-eval-timing.mjs so the TSV keeps a single
// writer. Fire-and-forget: a failed timing call never fails the run.
function logEvalTiming(reportNum: string, phase: "start" | "end") {
  execFile(
    process.execPath,
    [path.join(careerOpsRoot(), "log-eval-timing.mjs"), reportNum, "pdf", phase],
    { cwd: careerOpsRoot() },
    () => {},
  );
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800; // a real oferta evaluation / pdf-mode CV tailoring + render is heavy and multi-step

// ADR-0020 transport: POST /api/run does NOT stream the worker's output back on
// its own response anymore. It validates, registers a runId on the event bus
// (lib/core/run-events.ts), returns {runId} IMMEDIATELY, and the pipeline runs
// in the background publishing every event to the bus. GET /api/events
// multiplexes ALL runs onto ONE held connection per tab.
//
// Why: each task used to hold its own streaming response — including while
// QUEUED (the old route returned its stream before the pool granted a slot) —
// and HTTP/1.1 browsers cap same-origin sockets at 6. ~6 concurrent tasks then
// starved every NEW request (clicks on other features did nothing) until the
// tasks finished. One multiplexed channel makes the per-task connection cost 0.
//
// Behavior change: with no held response there is no client disconnect to
// cancel a run — closing the tab no longer kills the CLI (it finishes
// headless, like extension-sourced batches always have). Cancellation goes
// through POST /api/run/cancel (the worker card's X button).

export async function POST(req: Request) {
  let body: { kind?: string; input?: string; cliId?: string; model?: string; jdText?: string; company?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }
  const { kind = "evaluate", input, cliId, model } = body;
  // ADR-0051: the browser extension hands over the posting text it read out of
  // the logged-in page's DOM (the Chinese boards wall off server-side fetching).
  // Clamped HERE at the edge — the extension already trims to this budget, but it
  // is not the only caller, and an unclamped body buys a megabyte of prompt with
  // the user's tokens. Kinds that do not score an offer ignore both fields.
  const jdText = clampInlineJd(body.jdText);
  const employer = clampInlineEmployer(body.company);
  // 扩展详情页随 JD 一并传来的职位标题（DOM 提取）：只用于任务卡标题——被黑名单
  // 门禁拦下的评估没有报告可回填，职位名只有派发时带上这一条路。同一规范化函数
  // （单行、120 上限），绝不进 prompt（JD 全文本就含标题，评估员自己落定）。
  const role = clampInlineEmployer(body.role);
  if (!input || !cliId) {
    return new Response(JSON.stringify({ error: "input and cliId required" }), { status: 400 });
  }
  const resolved = await resolveCli(cliId);
  if (!resolved) {
    return new Response(JSON.stringify({ error: `CLI '${cliId}' not found` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { spec, binPath } = resolved;

  // These run the REAL core (modes/scripts), not just data — fail clearly if the
  // root is incomplete instead of faking it.
  const needsScript: Record<string, string> = { evaluate: "modes/oferta.md", "fix-portal": "verify-portals.mjs", pdf: "generate-pdf.mjs", checkup: "modes/_custom.md" };
  const required = needsScript[kind];
  if (required && !fs.existsSync(path.join(careerOpsRoot(), required))) {
    return new Response(
      JSON.stringify({
        error: `This needs a complete career-ops checkout (${required}). CAREER_OPS_ROOT has data only — point it at a full checkout.`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // fix-portal's prompt puts this straight into a shell command the agent runs, and
  // a company name can arrive from a public ATS listing rather than the user's own
  // typing. Refuse rather than sanitize: a silently rewritten name would repair the
  // wrong portal.
  if (kind === "fix-portal" && !isShellSafeCompanyName(input)) {
    return new Response(
      JSON.stringify({ error: "That company name has characters I can't safely pass to the portal checker — rename it in portals.yml first." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // An A–F score is meaningless without a CV to score against — the CLI would
  // hallucinate a fit narrative and still emit a VERDICT. Require cv.md first.
  if ((kind === "evaluate" || kind === "pdf") && !fs.existsSync(path.join(careerOpsRoot(), "cv.md"))) {
    return new Response(
      JSON.stringify({ error: "Add your CV first so I can score this against you — drop it on the home page." }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // Register the run BEFORE returning the runId so the bus already has the
  // record when the first events flow.
  const runId = randomUUID();
  const startedAt = Date.now();
  registerRun(runId);
  // ADR-0042 决议 1：粗阶段 —— 登记即排队（并发池槽位发放前）。阶段事件走
  // 既有 status 通道、label 用 `phase:` 前缀约定，前端据此渲染徽章而不入
  // 步骤流；终态不发阶段（阶段只描述进行中）。
  publish(runId, { type: "status", label: "phase:queued" });
  // ADR-0073 决议 4：跨引擎脏模型守卫。2026-10-08 那次 `claude + hy3` 的评估就是从这里
  // 漏过去的 —— 配置页那一层洗不干净（旧 localStorage、别的浏览器、清过站点数据、
  // 扩展直接读服务端镜像），派发点就得自己兜住。
  // 清洗后的值才是本次真正请求的东西：argv、并发池快照、运行账本三处同用（ADR-0043
  // 记的是请求值，那现在就是清洗后的请求值；被丢时记 undefined，不谎报一个从未生效的模型）。
  const knownModel = dropCrossEngineModel(cliId, model);
  if (model && !knownModel) {
    // 不静默降级：用户在运行卡上看得见模型被丢这件事（与 ADR-0028 决议 3 同一个原则）。
    publish(runId, {
      type: "status",
      label: `已忽略不属于 ${cliDisplayName(cliId)} 的模型 ${model}，改用该引擎默认`,
    });
  }
  // 体检在跑登记（ADR-0033 决议 2）：登记必须在进入并发池**之前**（此时是 queued），
  // 也必须早于 runId 回到客户端——它既是「这一行此刻有没有体检在跑」的唯一权威（前哨
  // 据此拦下按钮），也是「停止」需要的 runId 来源（跨标签页/跨浏览器也成立）。
  if (kind === "checkup") registerCheckup(String(input), runId);

  // Server-side run ledger (B4-class observability): a terminated run must be
  // visible even when no UI card exists (API-dispatched runs, another tab).
  // Recorded once per run at the terminal send/cancel/crash — see recordEnd.
  const checkupTarget = kind === "checkup" ? findCheckupTarget(String(input)) : null;
  // 任务卡可读标题（「公司 · 岗位」，与批量评估同口径）：招聘站扩展发起的单次评估
  // 没有本地卡，台账标题就是 /jobs 列表上那行字，以前一律是 `evaluate <url>`。
  // 派发时能带的就带（pipeline 行写着 `URL | 公司 | 岗位`，扩展另带详情页雇主名），
  // 完成后再由报告 Machine Summary 覆盖（recordEnd）；都拼不出就保留原兜底形状。
  const inbox = kind === "evaluate" ? readInbox() : [];
  // 本 run 的 inbox 行（同源同 URL）：派发标题、发布日期、卡片薪资共用它，避免
  // 一次派发把 pipeline.md 反复读上几遍。
  const inboxRow = kind === "evaluate" ? inbox.find((j) => j.url === input) : undefined;
  const inboxLabel = jobLabel(inboxRow?.company, inboxRow?.role);
  // pipeline 行未命中时的第二事实源：tracker 行（applications.md 的 URL 列）。
  // 键走 normalizeUrl——浏览器粘贴/扩展带来的 URL 常带 tracking 参数，裸串比对会漏。
  const trackerLabel = kind === "evaluate" ? trackerUrlLabels(readApplications()).get(normalizeUrl(String(input))) ?? "" : "";
  const dispatchLabel = kind === "evaluate" ? evaluateDisplayTitle({ inboxLabel: inboxLabel || trackerLabel, company: employer, role }) : "";
  const ledgerTitle = checkupTarget?.ok
    ? `公司体检：${checkupTarget.company}`
    : dispatchLabel || `${kind} ${input}`;
  let endRecorded = false;
  // 「查看 CLI 会话」：本次 run 的 CLI 会话 id。claude 系（claude/qoder-cn）在
  // runPipeline 的 init 帧解析时写入；opencode 在终态后凭 --title 异步反查写入。
  // holder 跨函数边界：runPipeline 是独立函数（写），recordEnd 读它落台账。
  // 缺失 = 引擎没给，卡片按钮不渲染。
  const sessionRef: { current?: string } = {};
  // 报告号 → 「公司 · 岗位」：报告 Machine Summary 里的 company/role 是评估员落定
  // 的事实，完成态卡片标题以它为准（与批量评估 labelForNum 同口径）。读不到就退回
  // 派发时的标签，绝不猜。
  const reportLabelFor = (num?: string): string => {
    if (!num) return "";
    const file = findReportFile(String(num));
    if (!file) return "";
    try {
      return reportJobLabel(fs.readFileSync(file, "utf8"));
    } catch {
      return "";
    }
  };
  // 完成态的「公司 · 岗位」（evaluate）：报告 Machine Summary 是唯一能给出岗位的诚实
  // 来源——扩展发起的单次评估没有本地卡，池快照里只有 URL 或雇主名。done 事件把它
  // 带给卡片、台账写同一份，两处同一个口径。报告读不到（门禁拦截/失败）时退回派发
  // 时的 company+role；都拼不出返回 ""，调用方保留原兜底形状。
  const finishedLabel = (reportNum?: string): string =>
    kind === "evaluate"
      ? evaluateDisplayTitle({ reportLabel: reportLabelFor(reportNum), inboxLabel, company: employer, role })
      : "";
  // ADR-0089：报告号由 runPipeline 捕获或推得后作为第三参传入——pdf / checkup
  // 的 input 就是号本身；evaluate 的号只有收尾 reconcile 推得出（见
  // finishAfterReconcile），推不出就留空。台账行显式携带它，读取端（ledger-only
  // 卡）不必再靠 URL join / kind 猜。
  // 第五参 doneLabel：终态标题已在 send() 里算过一次（随 done 事件发出去），传进来
  // 复用，免得为同一份报告再读一遍磁盘。
  const recordEnd = (status: "done" | "error", msg?: string, reconciledNum?: string, blacklistGate?: { company: string }, doneLabel?: string) => {
    if (endRecorded) return;
    endRecorded = true;
    try {
      // ADR-0047 决议 1/2：把该 run 缓冲区里的逐工具步骤折叠进台账（与批量 items
      // 同层落盘），让页签不在线时事后回看也能重建时间线。空步骤不占位（沿
      // ADR-0043 缺失惯例）。缓冲区此刻仍在（completeRun 之后也保留）。
      const steps = buildRunLedgerSteps(getRunBuffer(runId));
      // ADR-0089：pdf / checkup 的 input 就是报告号（各自 kind 的启动契约）；
      // evaluate 的号由收尾 reconcile 推得。两者都过数字校验，凑不出就留空。
      const bareInput = String(input).trim();
      const capturedNum = (kind === "pdf" || kind === "checkup") && /^\d+$/.test(bareInput) ? bareInput : undefined;
      const reportNum = capturedNum ?? reconciledNum;
      // 完成态标题：报告给出的「公司 · 岗位」最权威（扩展发起的任务唯有它能拼出岗位），
      // 拼不出就沿用派发时的标题——那是「公司名」或原兜底形状，不编造。
      const label = doneLabel ?? finishedLabel(reportNum);
      appendRunRecord(careerOpsRoot(), {
        id: runId,
        kind,
        input,
        title: label || ledgerTitle,
        page: kind === "checkup" ? `/pipeline/${input}` : undefined,
        status,
        startedAt,
        finishedAt: Date.now(),
        // ADR-0043 运行引擎：派发时请求的运行时 + 模型（不是实际加载的那个）。老记录
        // 没这两个字段，读取端按「未记录」处理，不回填、不猜测。
        cliId,
        model: knownModel || undefined,
        // 「查看 CLI 会话」：本次 run 的 CLI 会话 id。老记录无此字段，读取端按
        // 「无会话」处理——按钮不渲染，与「无数据不占位」同口径。
        sessionId: sessionRef.current,
        // ADR-0089：报告号（捕获值优先，否则收尾推得）；凑不出即不占位。
        reportNum,
        // 800（原 300）：门禁那一句 checkup 文案就 175 字，300 会把 ADR-0034 的证据
        // 段整段截掉——上限不抬，补丁等于没打。
        msg: msg ? String(msg).slice(0, 800) : undefined,
        // ADR-0084：门禁命中是「按设计停下」，不是失败。台账必须带可判定的结构化
        // 字段——靠 msg 里的中文散文（「命中黑名单…」）判不出来：黑名单页的每公司
        // 拦截数就是因为读端找英文 blacklist、写端只写中文而恒为 0。
        ...blacklistGateLedgerFields(blacklistGate),
        steps: steps.length ? steps : undefined,
      });
      // opencode：stdout 无会话 id，终态后凭派发时埋的 --title 反查，原地补进
      // 台账行（绝不追加第二行同 id 记录——读取端按首行权威处理，重复行会让
      // ledger-only 卡重复出现）并补发一次 session 事件。失败（未登录/无该子
      // 命令/超时）按无会话处理：台账行没有 sessionId，按钮不显示，不重试。
      if (cliId === "opencode") {
        void findOpencodeSessionByTitle({ binPath, title: opencodeRunTitle(runId) })
          .then((found) => {
            if (!found) return;
            publish(runId, { type: "session", sessionId: found });
            updateRunRecord(careerOpsRoot(), runId, { sessionId: found });
          })
          .catch(() => {});
      }
    } catch (e) {
      console.error("[run-ledger] append failed:", e instanceof Error ? e.message : e);
    }
  };

  // 公司体检审计行（ADR-0027 决议 3）：同步写一条已标记的 agent-inbox 行
  // （含本 runId），关闭双击去重窗口；drain 规则会跳过已标记的体检请求。
  if (checkupTarget?.ok) {
    const auditLine = checkupDispatchText({ n: String(input), company: checkupTarget.company, runId });
    execFile(
      process.execPath,
      [rootScript("agent-inbox"), "add-done", auditLine, "--result", `dispatched worker ${runId}`],
      { cwd: careerOpsRoot(), timeout: 15_000, env: process.env },
      (err) => {
        if (err) console.error("[checkup] audit line failed:", err.message);
      },
    );
  }

  after(async () => {
    try {
      await runPipeline({
        runId,
        kind,
        input,
        cliId,
        model: knownModel,
        spec,
        binPath,
        recordEnd,
        sessionRef,
        // ADR-0051：内联 JD/雇主名（扩展从已登录页 DOM 提取）随任务进 prompt。
        jdText,
        employer,
        // ADR-0035：体检的目标公司在派发时已解析（同一份就是审计行用的那个），
        // 直接带进 prompt，省掉 worker 自解析 tracker 的那一步易错查表。
        checkupCompany: checkupTarget?.ok ? checkupTarget.company : undefined,
        // 已解析的 pipeline 收件箱：发布日期与卡片薪资都从它取，不在 runPipeline
        // 里把同一份 pipeline.md 再读两遍。
        inbox,
        // 卡片标题（「公司 · 岗位」）：派发时那一份给池快照，完成时那一份给 done 事件
        // 与台账——两处同源，列表上那行字不会因为卡片来源不同而两副面孔。
        poolTitle: dispatchLabel || input,
        finishedLabel,
      });
    } catch (e) {
      // Nothing else catches this promise — a crash here must still terminate
      // the run on the bus instead of leaving it open until process shutdown.
      const msg = `Worker crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      publish(runId, { type: "error", msg });
      recordEnd("error", msg);
      // 体检登记兜底：正常路径由 runPipeline 的 close()/取消处理器清除，这里只覆盖
      // close() 自身抛错的情形（那时进程可能还活着，所以不声称 processGone —
      // ADR-0033 决议 6）。
      if (kind === "checkup") clearCheckup(String(input), runId);
      completeRun(runId);
    }
  });

  // 本地派发卡（quick-evaluate/重新评估等）在响应里拿到派发标签，就地升级
  // 「评估 · 粘贴的链接」这类通用标题为「公司 · 岗位」——拼不出时 undefined，
  // 客户端保留原兜底形状（不编造）。
  return Response.json({ runId, title: dispatchLabel || undefined });
}

/** ADR-0076: the flat tailored-CV short name carries the tracker row's Role
 *  column. The selector is the tracker `#` (what GeneratePdfButton sends) or a
 *  report number (a worker landing on /report/{n}) — resolve the row directly
 *  by number first, then through the linked report file the selector resolves
 *  to. A missing row/role is fine: the name degrades to cv-{report number}.pdf. */
function roleForPdfShortName(selector: string): string {
  const apps = readApplications();
  const target = parseInt(selector, 10);
  if (!Number.isNaN(target)) {
    const direct = apps.find((a) => parseInt(a.n, 10) === target);
    if (direct?.role) return direct.role;
  }
  const file = findReportFile(selector);
  if (file) {
    const base = path.basename(file);
    const linked = apps.find((a) => (a.report ?? "").includes(base));
    if (linked?.role) return linked.role;
  }
  return "";
}

/** The old streaming pipeline, unchanged in substance — only the transport
 * moved from "this response's ReadableStream" to the run-events bus. */
async function runPipeline({
  runId,
  kind,
  input,
  cliId,
  model,
  spec,
  binPath,
  recordEnd,
  sessionRef,
  checkupCompany,
  jdText,
  employer,
  inbox,
  poolTitle,
  finishedLabel,
}: {
  runId: string;
  kind: string;
  input: string;
  cliId: string;
  model?: string;
  spec: import("@/lib/clis").CliSpec;
  binPath: string;
  /** 「查看 CLI 会话」的会话 id holder：init 帧解析时写入（claude/qoder-cn），
   *  recordEnd（POST 作用域）读它落台账。opencode 的写入在 recordEnd 自身的
   *  异步反查里，不经过这里。 */
  sessionRef: { current?: string };
  /** ADR-0035: the checkup's resolved target company (absent when the dispatch
   *  bypassed the report-page pre-flight — the prompt then self-resolves). */
  checkupCompany?: string;
  /** ADR-0051: DOM-extracted posting text, already clamped at the edge. */
  jdText?: string;
  /** ADR-0051: DOM-extracted employer name, already clamped at the edge. */
  employer?: string;
  /** 已解析的 pipeline 收件箱（非 evaluate 为空数组）：派发作用域读一次，供
   *  发布日期 / 卡片薪资与任务卡标题共用。 */
  inbox: InboxJob[];
  /** 并发池快照上的标题（「公司 · 岗位」，拼不出时就是 URL）：扩展/CLI 发起的
   *  单次评估没有本地卡，/jobs 上那行字只能来自这里。 */
  poolTitle: string;
  /** 完成态的「公司 · 岗位」（evaluate）：报告 Machine Summary 给出，拼不出返回 ""。 */
  finishedLabel: (reportNum?: string) => string;
  /** Server run-ledger recorder (once per run; passed in from POST scope).
   *  ADR-0089: the third arg is the report number the run resolved to (evaluate's
   *  is known only after the closing reconcile), recorded on the ledger row.
   *  ADR-0084: the fourth is the blacklist gate that stopped the run — written as
   *  structured fields so the blacklist page can count stops without reading prose.
   *  The fifth is the finished title already resolved for the done event, reused so
   *  the same report isn't read twice. */
  recordEnd: (status: "done" | "error", msg?: string, reportNum?: string, blacklistGate?: { company: string }, doneLabel?: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);

  // Precompute deterministic scratch + final paths so the agent never chooses
  // its own filenames — the backend owns naming, writing (#2185) and rendering
  // (#2172). Nothing is cleared first: writeCvHtml rewrites the HTML
  // from this run's freshly parsed envelope before any render, and the agent is
  // no longer told these paths, so a stale file cannot survive into a render.
  let pdfPaths: PdfPaths | undefined;
  if (kind === "pdf") {
    const pathsResult = resolvePdfPaths(input, careerOpsRoot(), findReportFile, roleForPdfShortName(input));
    if (!pathsResult.ok) {
      publish(runId, { type: "error", msg: pathsResult.error });
      completeRun(runId);
      return;
    }
    pdfPaths = pathsResult.paths;
  }

  // Resolve the posting date HERE rather than asking the agent for it. The
  // scanner already wrote it from the provider's own `offer.postedAt`, so this
  // copies a recorded value instead of inviting a guess — and modes/oferta.md is
  // explicit that a guessed date is worse than an absent one (the POSTED column
  // renders absent as `—`, a wrong date as a fresh req). Unknown URL → undefined
  // → the prompt writes no segment at all.
  const inboxRow = kind === "evaluate" ? inbox.find((j) => j.url === input) : undefined;
  const postedAt =
    kind === "evaluate" ? inboxRow?.postedAt ?? readScanDates().get(input) : undefined;
  // 采集卡片薪资（2026-11-04 #1217）：与 postedAt 同源（pipeline.md note 尾段，ADR-0023），
  // 但以前只传了日期。两个提取链路都不保证能拿到本岗薪资（猎聘把标题+薪资区块放在
  // <main> 之外，实证 #1217 被写成了「未披露」），卡片原文是第三个、早已落盘的事实源。
  const cardSalary = kind === "evaluate" ? inboxRow?.salaryText : undefined;
  // ADR-0056 决议 5：体检 prompt 的技能指针——与 /api/skills 同一个 skill-registry
  // 解析 offer体检 的最高版本副本（绝对路径 + 版本）；找不到 → undefined，prompt 与
  // 旧版逐字节一致（workflow 第 8 条：技能缺失不硬失败）。决议 8：每派发实时扫。
  // 用户手动指定的技能目录也要参与，否则面板里看得见、派发时却读不到。
  const checkupSkill =
    kind === "checkup"
      ? (resolveSkillCopy(scanSkillRegistry({ extraDirs: readAppConfig().skillDirs ?? [] }), OFFER_CHECKUP_SKILL_NAME) ??
        undefined)
      : undefined;
  const prompt = buildPrompt({ kind, input, memory: readMemory(), today, postedAt, unknownEmployer: readAppConfig().unknownEmployer, checkupCompany, checkupSkill, jdText, company: employer, cardSalary, reportNum: pdfPaths?.reportNum, reportFile: pdfPaths?.reportFile, marketMode: resolveMarketMode({ raw: readMarketModesDir(), available: listMarketModes() }) });

  // Which tools each kind gets, and the whole argv for every runtime that HAS an
  // audited scope, live with those runtimes: claude-invocation.mjs (declared on
  // claude's CliSpec row) and qoder-invocation.mjs (on qoder-cn's). See their
  // headers for the policy and for why it is asserted on built values rather
  // than on this file's source. NEVER auto-submits; that remains a prompt-level
  // guarantee.
  // CLIs with no scope of their own get no tool flags from spec.args() at all, so
  // their agents stay unrestricted here. That gap is route-wide (it applies to
  // 'evaluate' too), not specific to pdf, and each CLI needs its own mechanism
  // researched — tracked as #2507 rather than half-fixed here. On those CLIs the
  // backend is the only INTENDED writer — the agent is not asked to write — but
  // that is mitigation, not enforcement: the capability is still there for an
  // injected posting to reach.
  // A CLI with its own structured stream gets the argv that turns it on, so its
  // stdout matches spec.parseEvent below; spec.args stays the plain-text argv the
  // envelope-parsing routes rely on.
  // ADR-0054: the selection itself lives in the shared worker-invocation helper —
  // batch-evaluate must pick worker argv the same way this route does.
  const { args: baseArgs } = resolveWorkerInvocation(spec, { kind, prompt });
  // The config page's model picker applies to EVERY CLI uniformly. Absent a saved
  // model (or a CLI with no model flag), withModelFlag returns the args untouched
  // and the CLI keeps its own default.
  const args = withModelFlag(baseArgs, spec.model, model);
  // 会话持久化（「查看 CLI 会话」的前置）：headless `-p` 运行的会话默认不落盘
  // （实测 2026-11-09：无 --session-id 的 run 在 ~/.claude/projects 无 jsonl，
  // --resume 报 No conversation found）。显式指定服务端生成的 uuid 后会话落盘、
  // 终态后的 init 帧 session_id 与之一致，交互终端凭它 --resume / -r 恢复。
  // opencode 走另一条路：stdout 纯文本（无 init 帧），埋 `--title career-ops-<runId>`
  // 供终态后 `session list` 反查——只改 argv，不碰 stdout 契约；标题也落在
  // opencode 自己的会话列表里，用户在 TUI 里同样可辨认。
  let dispatchArgs = args;
  if (cliId === "opencode") {
    dispatchArgs = [...args, "--title", opencodeRunTitle(runId)];
  } else if (canResumeSession(cliId)) {
    dispatchArgs = [...args, "--session-id", randomUUID()];
  }

  // For write-needing kinds, snapshot reports/ so we can verify the worker
  // actually persisted (non-Claude CLIs lack Write auth and silently no-op).
  // Names, not a count: reserving a number writes reports/NNN-RESERVED.md and the
  // final report REPLACES it, so the `.md` count is unchanged and a count-delta
  // gate reported "didn't save a report" for an evaluation that saved fine (#2085).
  const reportsDir = path.join(careerOpsRoot(), "reports");
  const reportEntries = () => {
    try {
      return fs.readdirSync(reportsDir);
    } catch {
      return [];
    }
  };
  const reportsBefore = kind === "evaluate" ? reportEntries() : [];
  // checkup 的产物通道是台账（data/company-checkups.tsv，ADR-0025 的唯一机器
  // 通道；HTML 只是可选附件，--html - 合法），所以快照台账行而非 reports/ 增量
  // —— ADR-0030 决议 1。读失败按 0 行：一个读不出的台账不能反过来豁免门禁。
  // 2026-09-17 收紧（ADR-0030 跟进决议）：数的是**可核验产物**行——声明了 HTML 的行
  // 必须有文件。`#1022` 就是「行在、报告不在」却记了落盘的活证据。
  const checkupLedgerPath = path.join(careerOpsRoot(), "data", "company-checkups.tsv");
  const readCheckupLedger = (): string | undefined => {
    try {
      return fs.readFileSync(checkupLedgerPath, "utf8");
    } catch {
      return undefined;
    }
  };
  const checkupHtmlExists = makeCheckupHtmlProbe(careerOpsRoot());
  const countArtifactRows = () => checkupArtifactRowCount(readCheckupLedger(), checkupHtmlExists);
  const ledgerRowsBefore = kind === "checkup" ? countArtifactRows() : 0;

  // Global concurrency: queue for a slot in the global CLI-concurrency pool
  // BEFORE touching the write token or spawning. A full pool keeps the task
  // queued (visible as 排队中) instead of spawning another heavyweight agent
  // CLI — ADR-0014 Q1/Q4. Queued tasks no longer hold an HTTP response: their
  // status reaches the client through the /api/events channel (ADR-0020).
  // ADR-0043：cliId/model 随任务入池，扩展派发的卡片凭 /api/active-runs 也能显示引擎。
  // 影子卡片接通：runId 同步入池——别的页签/刷新后的前端凭快照里的这个 UUID
  // 把 /api/events 的帧接到接管卡片上，否则单任务永远只显示「处理中」占位。
  // 池卡片的标题就是要显示在列表上的那行字：能带出「公司 · 岗位」就带（扩展发起的
  // 单次评估没有本地卡，快照之外没有别的标题来源），拼不出仍回退 URL（poolTitle）。
  const poolHandle = acquire({ url: input, title: poolTitle, source: "run", cliId, model: model || undefined, runId, kind });

  // Spawned/guarded only AFTER the pool grants a slot. `child`/`writeToken` are
  // outer lets so cancel() can reach them whether the run is queued
  // (null → cancel just dequeues and closes the run) or running (→ terminate
  // the child + release both the token and the pool slot).
  let child: ReturnType<typeof spawnHeadlessCli> | null = null;
  // 子进程的 'close' / 'error' 已到（stdio 全关，不可能再写文件）。体检登记的等死
  // 信号与 close() 的终态记账都依据它区分「run 终态」与「进程真的不在」（ADR-0033 决议 6）。
  let childClosed = false;
  let writeToken: number | null = null;
  let poolReleased = false;
  const releasePoolOnce = () => {
    if (poolReleased) return;
    poolReleased = true;
    release(poolHandle.id);
  };

  // `terminal` marks the run as over: no more events published, resources
  // released. Cancellation now arrives via setCancelHandler (POST /api/run/cancel)
  // instead of a stream-disconnect — there is no held response to disconnect.
  let terminal = false;
  // Resolved when the run reaches its terminal state (close() or a cancel), so
  // the try body below can AWAIT it. Without that await the body falls straight
  // through to `finally`, which closes the run the instant the child handlers
  // are registered — `terminal` flips true while the CLI is still running and
  // every later event (the honesty gate's done/error, pdf's render) is silently
  // swallowed. Found 2026-09-14 via web/qa-run-close.mjs (regression of 3bb566b).
  let runSettled: (() => void) | null = null;
  const settle = () => { runSettled?.(); runSettled = null; };
  let killer: ReturnType<typeof setTimeout> | undefined;
  // 静默看门狗（ADR-0094 的第二道阀）：总阀只管「最久能跑多久」，管不了「一个字节都不出」。
  // 2026-11-09：opencode 额度耗尽后子进程 26 分钟零输出、零 token，卡片一直「执行中」，
  // 直到 30 分钟总阀才落成一条误导性的 timeout。任何 stdout/stderr 字节都会重臂它。
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  // 本地 kill 定时器是否已经开火（超时终态的判据，ADR-0030 跟进决议 2026-09-17）。
  // 没有它，被定时器杀掉的 run 会以「无 stdout + 非 0 退出」落进安装/登录误诊分支。
  let timedOut = false;
  // pdf-kind's render+mark work (renderPdf, below) keeps running detached even
  // after the agent child closes — and even after a cancel. Track its promise so
  // cancel() can defer releasing writeToken until that work actually settles,
  // instead of releasing the tracker-delete guard while mark-pdf-ready.mjs is
  // still actively writing applications.md.
  let pdfRenderPromise: Promise<void> | null = null;
  // ADR-0051 决议 9：evaluate 的 pipeline.md 归档同样在本作用域之外收尾（见
  // finishAfterReconcile），它未落定前 finally 不能替 run 叫停。
  let reconcilePromise: Promise<void> | null = null;
  let writeTokenReleased = false;
  const releaseWriteTokenOnce = () => {
    if (writeToken !== null && !writeTokenReleased) {
      writeTokenReleased = true;
      releaseTrackerWrite(writeToken);
    }
  };
  // 体检在跑登记的终态清除（ADR-0033 决议 2/6）——幂等，close() 与取消路径共用。
  // processGone 只在「子进程的 'close' 已到」或「从未 spawn」时为真：taskkill 是
  // fire-and-forget，取消一个正在跑的 run 时进程还在喘气，此刻不能假装它已经死了，
  // 登记表会把条目留在墓碑里继续等退出信号——替换路径才不会在旧 worker 还能写文件的
  // 窗口里放行新的。
  const clearCheckupLiveOnce = () => {
    if (kind === "checkup") clearCheckup(input, runId, { processGone: child === null || childClosed });
  };
  // ADR-0027 账本观测：最后 ~1200 字符原始 stderr（去 ANSI），随 error 终态
  // 入账本——通用门文案之下的真实根因线索。由 stderr data handler 更新。
  let stderrTail = "";
  // ADR-0034：stdout 侧的同类线索。本机实测失败信号（代理层的 `API Error: …`、拒绝语）
  // 走的是 agent 可见正文，而 stderrTail 至今 0 条命中——两条通道都要有原料。
  let stdoutTail = "";
  // ADR-0089：evaluate 的报告号到收尾 reconcile 才知道（finishAfterReconcile 赋值），
  // 终态发出时随 recordEnd 一起落台账；推不出（并发歧义 / 无报告）保持 undefined。
  let reconciledReportNum: string | undefined;
  // ADR-0084：命中公司黑名单门禁而停止的公司名。done 那一刻由 recordEnd 读它写成
  // 结构化台账字段——读取端（黑名单页的每公司拦截数）不靠 msg 里的散文判定。
  let blacklistGateHit: { company: string } | undefined;
  const send = (obj: { type: string; [key: string]: unknown }) => {
    if (terminal) return;
    if (obj.type === "error") {
      // 认证失效是唯一「用户一步操作即可自愈」的常见终态，而 CLI 把死因只写在
      // stdout 正文里（result 行字段皆空），裸 subtype 对读者不可读。命中就把
      // /login 指引拼进一句话原因——publish 在前，实时卡片与账本同源同文案。
      const hint = authExpiredHint(`${stderrTail}\n${stdoutTail}`);
      if (hint) {
        const base = String(obj.msg ?? "").trim();
        if (base && !base.includes(hint)) obj = { ...obj, msg: `${base}｜${hint}` };
        else if (!base) obj = { ...obj, msg: hint };
      }
    }
    if (obj.type === "done") {
      // 终态标题随 done 一起发：接管卡（扩展发起的任务）运行期间只有 URL 或雇主名，
      // 报告落盘后这里补上「公司 · 岗位」，列表不必等刷新才变得可读。
      const label = finishedLabel(reconciledReportNum);
      if (label) obj = { ...obj, title: label };
      publish(runId, obj);
      recordEnd("done", undefined, reconciledReportNum, blacklistGateHit, label);
      return;
    }
    publish(runId, obj);
    if (obj.type === "error")
      // 证据组装抽成纯函数（ADR-0034 决议 3）：一句话原因 ｜ stderr ｜ 输出尾部。
      recordEnd("error", failureLedgerMsg(String(obj.msg ?? ""), { stderrTail, stdoutTail: failureEvidence(stdoutTail) }));
  };
  const keepalive = setInterval(() => send({ type: "keepalive" }), 10_000);
  const close = () => {
    settle(); // idempotent — also fires when a cancel already terminal'd the run
    if (terminal) return;
    terminal = true;
    clearInterval(keepalive);
    if (killer) clearTimeout(killer);
    if (silenceTimer) clearTimeout(silenceTimer);
    releaseWriteTokenOnce();
    releasePoolOnce();
    clearCheckupLiveOnce();
    completeRun(runId);
  };

  // Cancel path (worker card X button → /api/run/cancel). Mirrors the old
  // stream-cancel(): kill the child tree / dequeue from the pool, release the
  // guards, and terminate the run on the bus.
  setCancelHandler(runId, () => {
    settle(); // a cancel is terminal too — the awaited body must not hang
    if (terminal) return;
    terminal = true;
    recordEnd("error", "cancelled by user");
    clearInterval(keepalive);
    if (killer) clearTimeout(killer);
    if (silenceTimer) clearTimeout(silenceTimer);
    if (child) {
      // 必须按进程树终止：单杀 CLI 主进程会让它派生的子进程（如 Git find.exe）
      // 残留成孤儿，持续空转占 CPU。
      terminateCli(child);
      if (pdfRenderPromise) {
        // Render/mark keeps running after the cancel — wait for it to settle
        // before releasing the guard, so a concurrent tracker delete can't race
        // mark-pdf-ready.mjs's still-in-flight write.
        pdfRenderPromise.finally(() => {
          releaseWriteTokenOnce();
          releasePoolOnce();
        });
      } else {
        releaseWriteTokenOnce();
        releasePoolOnce();
      }
    } else {
      // Still queued (no child spawned) — dequeue from the pool so IT never
      // grants the slot after we've terminated; the awaiting pipeline below sees
      // `ready` resolve false and exits without spawning.
      poolHandle.cancel();
      releasePoolOnce();
    }
    clearCheckupLiveOnce();
    publish(runId, { type: "error", msg: "Cancelled" });
    completeRun(runId);
  });

  {
    let buf = "";
    let emittedText = false; // any assistant text delta → the CLI actually ran
    let sawError = false;
    let stderrBuf = "";
    // Fallback for a CLI with no CliSpec.stderrIsFatal of its own. Moved into
    // run-cli-support.mjs beside the per-CLI classifiers so it has a reachable
    // test: as an inline regex in this closure nothing could assert it, which
    // is how a bare `auth` came to match "Authentication successful" and mark a
    // successful run as failed on six of the eight runtimes (#1974).
    const isFatalStderr = spec.stderrIsFatal ?? isFatalGenericStderr;
    // ADR-0094：命中跨引擎致命类别（额度/认证/模型/传输）就主动终止本 run，而不是只
    // 标记一下继续等——OpenCode 在额度耗尽后正是永不退出（2026-11-03 挂了 61 分钟）。
    // 这里不发 error 事件：终态由 close 统一发出并带上 stoppedReason，台账只写一次。
    let stoppedReason: string | null = null;
    const flagStderrLine = (line: string) => {
      if (!line.trim()) return;
      const fatal = classifyFatalStderr(line);
      if (fatal) {
        if (!stoppedReason) {
          stoppedReason = fatalStopMessage(fatal);
          sawError = true;
          if (child) terminateCli(child);
        }
        return;
      }
      // 旧的 per-CLI 宽判定保留：仍然报错给实时卡片，但不再主动终止进程。
      if (!isFatalStderr(line)) return;
      sawError = true;
      send({ type: "error", msg: line.trim().slice(0, 200) });
    };
    // 静默看门狗的复位与触发（ADR-0094 第二道阀）：任何一字节输出都重臂，
    // 所以只有「进程还在、但真的停在原地」才会走到这里。停机原因走 stoppedReason，
    // 与致命行同一条出口——不先发 error，终态文案才不会被通用门文案挤掉。
    const armSilence = () => {
      if (silenceTimer) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (terminal || stoppedReason) return;
        stoppedReason = silenceStopMessage(RUN_SILENCE_MS);
        sawError = true;
        if (child) terminateCli(child);
      }, RUN_SILENCE_MS);
    };
    let lastTokens = 0; // per-run token cost from the CLI's structured usage event (#6) — local only
    let lastCostUsd: number | null = null;
    // ADR-0052 决议 6: a runtime that reports NO usage (Qoder CN sends every
    // counter as 0) must not have a `tokens: 0` put in its mouth — "0 tokens ·
    // $0.00" asserts the run was free. The done event carries the figure only
    // when a usage event actually arrived. The client already renders a cost
    // only above zero (`doneTokens > 0`), so an absent figure changes nothing
    // it shows; it only stops the wire from stating a number nobody reported.
    let sawUsage = false;
    const doneEvent = () => ({ type: "done" as const, ...(sawUsage ? { tokens: lastTokens } : {}), costUsd: lastCostUsd });
    // pdf-mode's agent only tailors content now (rendering moved to the
    // backend, #2172) — but its killMs still has to leave real headroom
    // inside the route's overall maxDuration (800s): the render+mark phase
    // (renderPdf, below) starts only after this timer's window and has no
    // timeout of its own, so an agent that runs close to its full budget
    // would otherwise leave the platform's hard maxDuration cutoff to kill
    // generate-pdf.mjs mid-render. 720s agent / ~80s render is still ample —
    // a Chromium PDF render normally takes low tens of seconds even with a
    // cold Playwright launch.
    //
    // An oferta evaluation is heavier than it looks on a CLI that auto-loads
    // a full MCP surface (Playwright, codegraph, doctor, company-history,
    // Block-G research) before it even writes the report + TSV + merge. On
    // OpenCode that chain routinely exceeded the old 285s and the worker was
    // killed mid-report — the reserve sentinel got written but no report, so
    // the honesty gate reported "didn't save a report". Evaluate has no
    // render phase to reserve headroom for, so it shares checkup's allowance.
    // checkup（公司体检，ADR-0027）是重调研：opencode 实测约 10 分钟起步，
    // 600s 的通用 kill 定时器会在它写完 HTML/台账、正要写附录时 SIGTERM
    // （2026-09-15 实测——131/119/124/916 四次「零产物失败」的真根因）。
    // 30 分钟给足余量。pdf 提到 720s（2026-10-14）：曾以为「600s 的失败都是弱模型
    // 打转、加时间救不了」，但 1129/1130 的轨迹暴露了另一类失败——大 CV 正文已开始内联
    // 输出、却在 600s 边缘被截（信封 never closed）。run-prompts 的 pdf 提示词已禁止 agent
    // 去读渲染内部文件、把预算留给输出，尾部再留 120s 让长简历吐完闭合；720s 仍在
    // maxDuration(800) 之内，给渲染留 ~80s 余量。「纯打转、始终没吐信封」那类靠提示词修，不靠加时间。
    // evaluate 同样提到 1800s：2026-10-09 三条猎聘 evaluate 全部精确死在 600s，
    // 轨迹显示慢速 CLI（codebuddy/hy3，工具调用间隔可达 1-4 分钟）刚启动报告
    // Write 就被杀——完整 oferta 链路（browser-extract + WebSearch + reserve +
    // company-history + 报告/TSV/merge）在 600s 内走不完。
    const killMs = kind === "checkup" || kind === "evaluate" ? 1_800_000 : kind === "pdf" ? 720_000 : 600_000;
    // `killer` is armed AFTER spawn below (the CLI child is null while queued,
    // so there is nothing to kill and terminateCli(null) would throw).

    // pdf's CV arrives inline in a <<cv-html>> envelope instead of being written
    // by the agent (#2185). The filter keeps every byte for the backend while
    // holding the 15-25 KB body out of the run log, which is the agent's
    // narration — see cv-envelope.mjs.
    const cvFilter = kind === "pdf" ? createCvEnvelopeFilter() : null;
    // While the agent emits the 15-25 KB <<cv-html>> envelope, cvFilter swallows
    // every byte, so the worker log goes completely silent for as long as the
    // model takes to write the CV — a minute or more. The bus-level keepalive
    // (armed next to send/close above) covers that phase; consumers ignore
    // unknown event types, so this is safe for older clients too.

    /** Surface non-fatal issues in the run log rather than only a server log. */
    const sendWarnings = (warnings: string[]) => {
      for (const w of warnings) send({ type: "text", text: `⚠️ ${w}\n` });
    };
    /** Persist the emitted CV; streams the reason and returns false on failure. */
    const saveCv = (paths: PdfPaths, envelope: CvEnvelope) => {
      const written = writeCvHtml({ pdfPaths: paths, html: envelope.html });
      if (!written.ok) send({ type: "error", msg: written.error.slice(0, 200) });
      return written.ok;
    };

    // One dispatch for every structured CLI: the per-CLI knowledge (which event
    // means text/tool/status/usage) lives in run-cli-support.mjs behind
    // spec.parseEvent, so adding the next such CLI needs no change here.
    // Shared with the close-time flush below, so a final JSONL line the CLI never
    // newline-terminates before exiting isn't dropped along with the usage event
    // it carries.
    const processParsedLine = (line: string) => {
      if (!spec.parseEvent) return;
      // 会话 id 先于事件解析：init 帧每 run 只有一帧，提取到就定值并即时广播，
      // 让本页签的卡片在终态前就带上 sessionId（终态才显示按钮，此处只是备好）。
      const sid = extractClaudeSessionId(line);
      if (sid && sessionRef.current !== sid) {
        sessionRef.current = sid;
        publish(runId, { type: "session", sessionId: sid });
      }
      const ev = spec.parseEvent(line);
      if (ev?.text) {
        emittedText = true;
        // sendAgentText, NEVER send: pdf's CV arrives inside the agent's text as a
        // <<cv-html>> envelope, so parsed text has to reach cvFilter too or the
        // backend has nothing to save and the 25 KB body floods the run log (#2185).
        sendAgentText(ev.text);
      }
      // ADR-0042 决议 2：detail 是工具主参数的原始透传（仅 claude 的 assistant
      // 完整块携带），不是业务推断——前端把它并进已有的同名步骤行。
      if (ev?.tool) send({ type: "tool", name: ev.tool, ...(ev.detail ? { detail: ev.detail } : {}) });
      if (ev?.status) send({ type: "status", label: ev.status });
      // Accumulated, not assigned: usage events are per-turn, so overwriting made a
      // multi-turn run report only its last turn. The authoritative "done" is sent
      // on close, so the honesty gate decides done-vs-error first.
      if (typeof ev?.tokens === "number") sawUsage = true;
      lastTokens = accumulateTokens(lastTokens, ev);
      if (typeof ev?.costUsd === "number") lastCostUsd = ev.costUsd;
      if (ev?.error) {
        sawError = true;
        // ADR-0094：结构化事件里的致命类别同样立即停机。命中时不发 error：终态留给
        // close 统一发——recordEnd 只认第一条，先发的通用消息会把真实死因挤出台账。
        const fatal = classifyFatalStderr(ev.error);
        if (fatal) {
          if (!stoppedReason) {
            stoppedReason = fatalStopMessage(fatal);
            if (child) terminateCli(child);
          }
          return;
        }
        send({ type: "error", msg: ev.error.slice(0, 200) });
      }
    };
    const sendAgentText = (text: string) => {
      const visible = cvFilter ? cvFilter.push(text) : text;
      if (!visible) return;
      // 失败证据的原料（ADR-0034）：尾部留 4k 字符供筛选。pdf 的 <<cv-html>> 信封已被
      // cvFilter 挡在上面，不会进这里（否则尾巴会变成一段 CV 正文）。
      stdoutTail = (stdoutTail + visible).slice(-4000);
      send({ type: "text", text: visible });
    };

    try {
      // Wait for a global-pool slot before spawning. While queued the run shows
      // as 排队中 in the worker list (via the active-runs snapshot — no held
      // HTTP response anymore, ADR-0020). If the user cancels it mid-queue,
      // ready resolves false and we terminate with an explicit cancelled
      // signal — the CLI never spawned and the pool slot is never claimed.
      const started = await poolHandle.ready;
      if (!started) {
        // Cancel while queued: the cancel handler already published the error
        // and completed the run — nothing to do here.
        return;
      }
      // 拿到槽位 → 登记表从 queued 翻成 running（ADR-0033 决议 2：排队中同样算「在
      // 体检」，它也有权拦下按钮、也同样能被取消）。
      if (kind === "checkup") markCheckupRunning(input, runId);
      // ADR-0042 决议 1：占槽运行段开始（worker 2~30 分钟的黑盒段由此显式标定）。
      send({ type: "status", label: "phase:running" });
      // Only NOW, with a slot in hand, hold the tracker-write token (ADR-0014
      // Q4 — a long queue must not keep n write tokens held) and spawn the CLI.
      // Tracker-mutating runs guard the row-delete race (tracker.mjs delete
      // doesn't share merge-tracker's lock — see run-registry).
      writeToken = kind === "evaluate" || kind === "pdf" ? acquireTrackerWrite() : null;
      // stdin must reach EOF or the CLI waits on piped input that never comes:
      // Codex's `exec` blocks reading stdin, hangs until the kill timer, then
      // reports a generic auth-flavoured error (#1973 fixed it via an inline
      // stdio:["ignore",…], generalized into spawnHeadlessCli).
      child = spawnHeadlessCli(binPath, dispatchArgs, { cwd: careerOpsRoot(), env: process.env });
      // 子进程真的不在了的信号：'close'（stdio 全关，不可能再写文件——替换路径等的
      // 就是它）与 'error'（spawn 失败，进程从未存在）。体检把它交给在跑登记表当等死
      // 信号（ADR-0033 决议 6）；childClosed 同时供 clearCheckupLiveOnce 区分
      // 「run 终态」与「进程真的不在」。
      const proc = child;
      const exited = new Promise<void>((resolve) => {
        const markExited = () => {
          childClosed = true;
          resolve();
        };
        proc.once("close", markExited);
        proc.once("error", markExited);
      });
      if (kind === "checkup") attachCheckupExit(input, runId, exited);
      if (kind === "pdf") logEvalTiming(String(input), "start");
      // Decode once on the stream, not per chunk: Buffer#toString() decodes each
      // chunk independently, so a boundary inside a multi-byte UTF-8 sequence
      // yields a replacement character and mis-decodes the bytes after it — the
      // CV now flows through here (#2185).
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      killer = setTimeout(() => {
        timedOut = true;
        if (child) terminateCli(child);
      }, killMs);
      // 与总阀同时上膛：两个计时器量的是两件不同的事（最久多久 / 多久没动静）。
      armSilence();

      child.stdout.on("data", (chunk: string) => {
        if (terminal) return;
        armSilence();
        if (!spec.parseEvent) {
          emittedText = true;
          sendAgentText(chunk);
          return;
        }
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) processParsedLine(line);
        }
      });
      child.stderr.on("data", (chunk: string) => {
        armSilence();
        // Match on COMPLETE lines. A chunk boundary can fall mid-word, so testing a
        // raw chunk both misses an error split across two of them and can match a
        // fragment that is not the word it looks like. sawError feeds pdfRunOutcome,
        // where a false positive fails a run whose PDF rendered fine, so the
        // boundary has to be settled before the regex sees it.
        stderrBuf += chunk;
        // ADR-0027 账本观测：终端态只有通用门文案时，stderr 尾巴是唯一的根因
        // 线索（strip ANSI，保最后 ~1200 字符）。
        stderrTail = (stderrTail + chunk).slice(-1200).replace(/\x1b\[[0-9;]*m/g, "");
        let nl;
        while ((nl = stderrBuf.indexOf("\n")) !== -1) {
          const line = stderrBuf.slice(0, nl);
          stderrBuf = stderrBuf.slice(nl + 1);
          flagStderrLine(line);
        }
      });
      // Render + mark-tracker-ready live in pdf-render.mjs (plain, dependency-
      // injected, unit-tested) so the render-then-mark orchestration isn't
      // buried untested inside this transport-layer closure. Runs generate-
      // pdf.mjs and mark-pdf-ready.mjs as plain Node child processes — no agent
      // CLI or its sandbox involved — so a browser launch never depends on an
      // interactive approval nobody is present to grant in a headless/web-
      // triggered run (#2172). The tracker is marked ✅ only after a CONFIRMED
      // successful render, not optimistically — same honesty-gate discipline as
      // the evaluate path below.
      const renderPdf = async (paths: PdfPaths, format: "letter" | "a4") => {
        // ADR-0042 决议 1：渲染并入收尾段（"Rendering PDF…" 文案由阶段徽章取代）；
        // kind-tail 后缀区分收尾动作（渲染 vs 产物校验）。
        send({ type: "status", label: "phase:finalizing:render" });
        // renderAndMarkPdf is designed to resolve, never throw — but this is
        // the one place nothing else awaits or catches this promise, so an
        // unexpected exception here must still close the run instead of
        // leaving it open until process shutdown.
        try {
          const result = await renderAndMarkPdf({
            spawnFn: spawn,
            execPath: process.execPath,
            root: careerOpsRoot(),
            pdfPaths: paths,
            format,
            // The report number the row actually links (re-evals repoint the Report
            // cell to a new file), not the tracker `#` the run was keyed by —
            // mark-pdf-ready.mjs / the pdf-index manifest resolve by report number.
            reportNum: paths.reportNum,
          });
          if (result.kind === "render-failed") {
            send({ type: "error", msg: result.error.slice(0, 200) });
            return;
          }
          // Non-fatal issues (a defaulted page format, a tracker row not marked) still
          // surface here rather than only in a server log nobody sees.
          sendWarnings(result.warnings);
          // Confirmed successful render → close the pdf step's timing (评估耗时埋点).
          logEvalTiming(String(input), "end");
          send(doneEvent());
        } catch (e) {
          send({ type: "error", msg: `PDF rendering crashed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) });
        } finally {
          close();
        }
      };

      /**
       * ADR-0051 决议 9/10 — move this run's posting out of data/pipeline.md's
       * pending chapter, the step the batch orchestrator has always done and a
       * single run never did. Best-effort by design: the report and the tracker row
       * are already on disk, so a failing archive may only be narrated, never turn
       * a persisted evaluation red. Same phrasing as the batch route's status line.
       *
       * The run's own `done` is sent AFTER this, so the ledger's `finishedAt` means
       * "persisted and archived", not "the CLI stopped talking".
       */
      const finishAfterReconcile = async () => {
        try {
          const num = deriveRunReportNum({ beforeEntries: reportsBefore, afterEntries: reportEntries() });
          // ADR-0089：把本 run 推得的号交给 recordEnd 一起落台账（done 还没送出，
          // recordEnd 尚未触发）。推不出（并发歧义 / 无报告）就留空，不猜。
          if (num != null) reconciledReportNum = String(num);
          const args = buildReconcileArgs({ kind, input, num });
          if (args) {
            send({ type: "status", label: "Reconciling pipeline.md..." });
            await new Promise<void>((resolve) => {
              execFile(
                process.execPath,
                [path.join(careerOpsRoot(), "reconcile-pipeline.mjs"), ...args],
                { cwd: careerOpsRoot(), timeout: 30_000 },
                (err, stdout) => {
                  if (err) send({ type: "text", text: `\u26A0\uFE0F reconcile-pipeline: ${err.message}\n` });
                  else if (String(stdout ?? "").trim()) send({ type: "text", text: `${String(stdout).trim()}\n` });
                  resolve();
                },
              );
            });
          } else if (num == null && /^https?:\/\//i.test(String(input))) {
            // Ambiguous (another evaluate landed its report in this window) or no
            // report at all. Say so instead of silently skipping: the script's own
            // `--from-tracker` sweep is the documented catch-all for these rows.
            send({ type: "text", text: "\u26A0\uFE0F could not attribute one report number to this run — its inbox row (if any) stays pending; `node reconcile-pipeline.mjs --from-tracker` sweeps it up.\n" });
          }
        } catch (e) {
          send({ type: "text", text: `\u26A0\uFE0F reconcile-pipeline: ${e instanceof Error ? e.message : String(e)}\n` });
        } finally {
          send(doneEvent());
          close();
        }
      };

      child.on("error", (e) => { send({ type: "error", msg: e.message }); close(); });
      child.on("close", (code) => {
        // A cancel can fire (killing `child`) before this event finally arrives —
        // killing a process doesn't make its 'close' event disappear, just delays
        // it. Without this guard a pdf run could still start a brand-new render
        // (and re-touch the tracker) after the run is already terminated and its
        // writeToken guard released.
        if (terminal) return;
        // A trailing line with no newline would otherwise never be tested.
        if (stderrBuf) { flagStderrLine(stderrBuf); stderrBuf = ""; }
        // A final JSONL line with no trailing newline stays in `buf` forever
        // otherwise — flush it through the same parser so the usage/result event it
        // usually carries (the last one of a run) isn't lost. Ahead of the pdf branch,
        // not just the evaluate gate: the pdf path reports lastTokens too.
        const trailing = buf.trim();
        if (trailing) {
          buf = "";
          processParsedLine(trailing);
        }
        const cleanExit = code === 0; // non-zero OR null (killed/signal) = NOT clean
        // Shared by both honesty gates below — the pdf gate receives it as
        // pdfRunOutcome's noOutputMessage — because a CLI that produced no output at
        // all is the same failure mode whether it was evaluating or tailoring
        // a PDF — one place for the condition/message pair instead of two.
        const noOutputError = (): string | null => {
          // 超时（本地定时器杀的）是 pdf 路径唯一的出口：它不是 CLI 的问题，先说清楚。
          if (timedOut && !emittedText && !sawError) {
            return "This run hit the harness's time limit and was stopped — not an install or auth problem.";
          }
          if (!emittedText && !sawError && !cleanExit) return "The CLI exited with an error — is it installed and authenticated?";
          if (!emittedText && !sawError) return "The CLI produced no output — is it installed and authenticated? (career-ops is best on Claude Code.)";
          return null;
        };

        if (kind === "pdf") {
          // Release any text the filter was still holding, so the log keeps the
          // agent's closing narration and its VERDICT line.
          const tail = cvFilter?.flush();
          if (tail) send({ type: "text", text: tail });
          // The artifact check moved from the filesystem to the stream (#2185):
          // whether pdfPaths.html exists says nothing now that the backend is its
          // only writer. pdfRunOutcome owns the decision and the message.
          const envelope = cvFilter?.result();
          const outcome = pdfRunOutcome({
            envelope,
            noOutputMessage: noOutputError(),
            sawError,
            cleanExit,
            hasPaths: pdfPaths !== undefined,
          });
          if (!outcome.ok) {
            // pdf 分支的成败文案来自 pdfRunOutcome，不经过 persistRunOutcome 的
            // withFatal——在这里补上具体死因，否则用户只会看到「信封缺失」。
            send({ type: "error", msg: stoppedReason ? `${stoppedReason} — ${outcome.message}` : outcome.message });
          } else if (!pdfPaths || envelope?.ok !== true) {
            // Unreachable: pdfRunOutcome validated both via hasPaths/envelope.ok.
            // Kept for narrowing, but it must REPORT rather than fall through to a
            // bare close() — a run that ends with neither error nor done is the
            // one outcome this handler exists to prevent.
            send({ type: "error", msg: "Internal error: the pdf run passed its gate with no CV to save — please report this." });
          } else {
            sendWarnings(envelope.warnings);
            if (saveCv(pdfPaths, envelope)) {
              // Tracked so cancel() can defer releasing writeToken until this
              // settles; close() happens once rendering finishes, not here.
              pdfRenderPromise = renderPdf(pdfPaths, envelope.format);
              return;
            }
            // saveCv already published the specific reason.
          }
          return close();
        }

        // ADR-0042 决议 1：worker 已结束，进入 route 自己的产物校验/落盘判定段。
        send({ type: "status", label: "phase:finalizing:persist" });
        const persisted = kind === "evaluate"
          ? hasNewCompletedReport(reportsBefore, reportEntries())
          : kind === "checkup"
            ? countArtifactRows() > ledgerRowsBefore
            : false;
        // approach B（2026-09-23）：一个没写新东西的体检，很可能只是发现本行当天
        // 已有报告（对已体检行的重复复检），这不是失败。只在门禁本来会报 error 时才
        // 去查台账——已落盘的 run 无需重新判。
        const checkupAlreadyCurrentStar =
          kind === "checkup" && !persisted
            ? checkupArtifactTodayForTracker(readCheckupLedger(), String(input), today, checkupHtmlExists)
            : null;
        // Honesty gate (#9, ADR-0030): a green "done" requires a CLEAN exit, real
        // output, AND — for the artifact-persisting kinds — the channel actually
        // written (evaluate: a completed report; checkup: a ledger row). The
        // decision lives in persistRunOutcome so it is assertable: an inline copy
        // here is exactly how checkup drifted out from under this gate and two
        // zero-artifact runs got banked as done (2026-09-16, #73/#131).
        // 门禁标记只算一次：既喂诚实门（!!gate），也留给台账写 blockedCompany。
        const gate = detectBlacklistGate(stdoutTail);
        const outcome = persistRunOutcome({ kind, cleanExit, sawError, emittedText, persisted, timedOut, checkupAlreadyCurrentStar, blacklistGate: !!gate, fatalReason: stoppedReason });
        if (outcome.ok && outcome.blockedByBlacklist && gate) blacklistGateHit = gate;
        if (outcome.ok && kind === "evaluate" && !outcome.blockedByBlacklist) {
          // Archiving the inbox row is route work after the CLI is gone, and it
          // outlives this handler — the `finally` below must not close the run out
          // from under it (same shape as the pdf render path above).
          reconcilePromise = finishAfterReconcile();
          return;
        }
        if (outcome.ok) {
          if (outcome.alreadyCurrent || outcome.blockedByBlacklist) {
            // 说明这个 done 为何没产出新产物：体检是「当天已体检」，评估是「命中黑名单
            // 门禁按规则停止」。让卡片显示可读原因，而不是看起来像静默空跑或失败。
            send({ type: "text", text: `\n\u2139\uFE0F ${outcome.message}\n` });
          }
          send(doneEvent());
        } else {
          send({ type: "error", msg: outcome.message });
        }
        close();
      });

      // Hold the try body open until a terminal handler runs (close() via the
      // child's error/close events, pdf's own finally, or a cancel). Reaching
      // `finally` earlier closes the run before the CLI has said anything.
      await new Promise<void>((resolve) => { runSettled = resolve; });
    } finally {
      // The run must ALWAYS terminate on the bus, whatever path it takes —
      // a thrown parse/spawn error must not leave a zombie "running" entry or
      // a held pool slot / write token (the old stream transport relied on the
      // response dying with the request; the background pipeline has no such
      // safety net and needs this explicitly). EXCEPT the pdf render path and the
      // evaluate archive: both deliberately outlive this scope and call close()
      // themselves.
      if (!pdfRenderPromise && !reconcilePromise) close();
    }
  }
}

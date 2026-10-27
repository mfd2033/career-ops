// POST /api/cv-tailor — 定制简历生成的 agent 可调用 HTTP 触发器（工单 generate-tailored-cv/03）。
//
// 这是纯后端触发器，**不带任何 UI 按钮或前端产物**：把「生成定制简历」从零离线 CLI 升级为
// agent / 脚本能直接调用的 HTTP 能力。路由形态与 POST /api/checkup-request 对称——先做前哨
// （解析目标 + 同编号在途守卫），校验通过后立即经全局并发池派发 worker，**不在请求内同步等
// 待完成**，请求秒回 {runId}；进度经 GET /api/events 总线广播（形状与 checkup worker 一致）。
//
// 传输走 ADR-0020 事件总线：registerRun → 立即回 runId → after() 里进池跑 worker → publish
// 每个阶段事件 → 终态 done/error 唯一。取消走 setCancelHandler（排队中出队 / 运行中杀子进程）。
//
// 状态码语义与 findCheckupTarget 对齐：
//   - 解析失败 → 404 row-not-found / 400 missing-jd；
//   - 同编号在跑、未带 replace → 409 {running:[{runId,state,startedAt}]}（含 runId 供轮询或
//     调 /api/run/cancel 取消）；
//   - 带 replace:true → 停掉同 tracker# 全部在跑、等它们真不在后放行，200 {ok, replaced[,unconfirmed]}；
//   - 正常放行 → 200 {ok, runId, company, role}。
//
// 纯判定住 @/lib/tailor-request.mjs、@/lib/tailor-live.mjs、@/lib/tailor-worker.mjs（都
// node --test 锁定）；本路由是传输层，按仓库惯例不测（同 /api/checkup-request、/api/run），
// 但由 tests/lib/tailor-route.test.mjs 锁「导出接线齐全、路由可被 import」。
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { after } from "next/server";
import { careerOpsRoot, findTailorTarget } from "@/lib/career-ops";
import { decideTailorPreflight, tailorReplaceBody } from "@/lib/tailor-request.mjs";
import { listLiveTailors, registerTailor, markTailorRunning, clearTailor, awaitTailorGone } from "@/lib/tailor-live.mjs";
import { runTailorWorker } from "@/lib/tailor-worker.mjs";
import { readVault, activeKey } from "@/lib/quick-vault.mjs";
import { cancelRun, registerRun, setCancelHandler, publish, completeRun } from "@/lib/core/run-events";
import { acquire, release, __setSizeSource, DEFAULT_POOL_SIZE } from "@/lib/core/concurrency-pool";
import { readAppConfig } from "@/lib/app-config";
import { appendRunRecord } from "@/lib/run-ledger.mjs";

// 并发池大小取实时配置（与 /api/run、batch 同一具全局池、同一个 app-config）。
__setSizeSource(() => readAppConfig().concurrencyPool ?? DEFAULT_POOL_SIZE);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

/** 替换路径等旧进程退出的上限（与 checkup ADR-0033 决议 6 同口径）：超时不阻断，但如实标 unconfirmed。 */
const REPLACE_WAIT_MS = 5000;

/** worker 阶段名 → 事件总线 status label（`phase:` 前缀是粗阶段徽章约定，前端据此渲染不入步骤流）。 */
const STAGE_LABEL: Record<string, string> = {
  artifacts: "phase:running",
  tailor: "phase:tailoring",
  pdf: "phase:finalizing:render",
};

export async function POST(req: Request) {
  let body: { n?: string | number; replace?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const n = String(body.n ?? "").trim();
  if (!/^\d+$/.test(n)) {
    return Response.json({ error: "a numeric application number is required" }, { status: 400 });
  }

  // 前哨 1：目标解析（复用 findTailorTarget，与 checkup 的 reason 语义对齐）。
  const target = findTailorTarget(n);
  if (!target.ok) {
    return Response.json({ error: target.reason }, { status: target.reason === "row-not-found" ? 404 : 400 });
  }
  const meta = { company: target.company, role: target.role, reportNum: reportNumOf(target.reportPath, n) };

  // 前哨 1.5：定制引擎凭据。worker 是无 agent 的离线链路，LLM 调用靠密钥库（ADR-0083，
  // data/quick-eval.json）里使用中那把密钥束；库里没有可用密钥时当场 400，不派一个必死
  // 的 worker（它的死因只会活在事件流/台账里，调用方要轮询才知道）。reason 稳定、消息不含密钥。
  if (!activeKey(readVault(careerOpsRoot()))) {
    return Response.json({ error: "no-tailor-credential", hint: "在配置页「AI 引擎」密钥库中添加并启用一把 OpenAI 兼容密钥" }, { status: 400 });
  }

  // 前哨 2：同编号在途守卫（复用通用的 decideTailorPreflight，与 checkup 对称）。
  const decision = decideTailorPreflight({ live: listLiveTailors(n), replace: body.replace });

  if (decision.action === "blocked") {
    // 在跑：把 runId 一并给出，供 agent 轮询 /api/events 或调 /api/run/cancel 取消。
    return Response.json({ running: decision.running, ...meta }, { status: 409 });
  }

  if (decision.action === "replace") {
    // 先起等死，再取消，最后收等待结果——只把真的发出取消的列进 replaced（自行结束的算已停）。
    const runIds = decision.running.map((r) => r.runId);
    const waits = runIds.map((id) => awaitTailorGone(n, id, REPLACE_WAIT_MS));
    const cancelled = runIds.map((id) => cancelRun(id));
    const outcomes = await Promise.all(waits);
    const replaced = runIds.filter((_, i) => cancelled[i]);
    const started = dispatchTailorWorker(n, target);
    return Response.json({ ...tailorReplaceBody({ replaced, outcomes }), runId: started.runId, ...meta });
  }

  // dispatch：无在跑，直接经全局并发池起 worker，秒回 runId。
  const started = dispatchTailorWorker(n, target);
  return Response.json({ ok: true, runId: started.runId, ...meta });
}

/**
 * 行号 ≠ 报告号（re-eval 会把行改指向新报告，如 tracker 行 1148 → 报告 1153）。
 * pdf-index 登记、/api/cv-pdf 查询、报告页链接全部用真实报告号（与 worker 的
 * deriveReportNum 同一规则：报告文件名数字前缀，取不到回退行号）。
 */
function reportNumOf(reportPath: string, fallback: string): string {
  const m = /^(\d+)-/.exec(path.basename(String(reportPath ?? "")));
  return m ? m[1] : fallback;
}

/**
 * 登记 run + 在跑表 + 并发池，转入 after() 后台跑 worker。请求不等待完成（ADR-0020）。
 * 返回 runId 供响应体携带；后续事件经 /api/events 广播。
 */
function dispatchTailorWorker(n: string, target: NonNullable<ReturnType<typeof findTailorTarget>> & { ok: true }) {
  const runId = randomUUID();
  const startedAt = Date.now();
  const root = careerOpsRoot();
  const reportNum = reportNumOf(target.reportPath, n);
  // 密钥束在派发时读一次（与前哨同一把）：只进子进程 env，绝不进 argv / 事件流 / 台账。
  // openai-tailor.mjs 自带 dotenv 且不覆盖既有 env，所以这里注入的 OPENAI_* 就是生效值。
  const bundle = activeKey(readVault(root));
  const tailorEnv: Record<string, string> = {};
  if (bundle?.key) tailorEnv.OPENAI_API_KEY = bundle.key;
  if (bundle?.baseUrl) tailorEnv.OPENAI_BASE_URL = bundle.baseUrl;
  if (bundle?.model) tailorEnv.OPENAI_MODEL = bundle.model;
  // 离线 worker 的生成量是一整页 HTML（远大于快评单次调用）；openai-tailor 默认 300s
  // 在慢网关（实测 u2-flash 含 cache_control 重试在内超 5 分钟）上会撞墙。给足 10 分钟，
  // 调用方显式设过环境变量则尊重其值。
  tailorEnv.OPENAI_TIMEOUT_MS = process.env.OPENAI_TIMEOUT_MS || "600000";
  registerRun(runId);
  publish(runId, { type: "status", label: "phase:queued" });
  // 在跑登记发生在进入并发池之前（此时 queued），且早于 runId 回到调用方——它是「这一行此刻
  // 有没有定制在跑」的唯一权威，前哨据此拦下重复派发（跨标签页/跨浏览器也成立）。
  registerTailor(n, runId);

  const poolHandle = acquire({
    url: `#${n}`,
    title: `定制简历：${target.company}`,
    reportNum: Number(reportNum),
    source: "run",
    runId,
    kind: "cv-tailor",
  });

  // 取消 = 排队中出队 / 运行中杀掉当前子进程。子进程句柄由 runScript 登记在这里供杀。
  let terminal = false;
  let currentChild: ReturnType<typeof execFile> | null = null;
  const terminate = () => {
    if (terminal) return;
    terminal = true;
    if (currentChild) {
      try {
        currentChild.kill("SIGTERM");
      } catch {
        /* 已退出 */
      }
    }
    release(poolHandle.id);
    clearTailor(n, runId, { processGone: currentChild === null });
    publish(runId, { type: "error", msg: "Cancelled" });
    recordEnd("error", "cancelled by user");
    completeRun(runId);
  };
  setCancelHandler(runId, () => {
    if (!currentChild) poolHandle.cancel(); // 排队中：出队即可，没有进程要杀
    terminate();
  });

  let endRecorded = false;
  const recordEnd = (status: "done" | "error", msg?: string) => {
    if (endRecorded) return;
    endRecorded = true;
    try {
      appendRunRecord(root, {
        id: runId,
        kind: "cv-tailor",
        input: n,
        title: `定制简历：${target.company}`,
        page: `/report/${reportNum}`,
        status,
        startedAt,
        finishedAt: Date.now(),
        reportNum,
        msg: msg ? String(msg).slice(0, 800) : undefined,
      });
    } catch (e) {
      console.error("[run-ledger] cv-tailor append failed:", e instanceof Error ? e.message : e);
    }
  };

  after(async () => {
    try {
      const granted = await poolHandle.ready;
      if (!granted) return; // 排队中被取消，terminate() 已收尾
      if (terminal) return;
      markTailorRunning(n, runId);

      const result = await runTailorWorker(target, {
        root,
        reportNum: n,
        publish: (stage) => {
          if (terminal) return;
          const label = STAGE_LABEL[stage];
          if (label) publish(runId, { type: "status", label });
        },
        runScript: (file, args) =>
          new Promise((resolve) => {
            const scriptPath = path.join(root, file);
            const child = execFile(
              process.execPath,
              [scriptPath, ...args],
              // env 只附加在 process.env 之上（application-artifacts / generate-pdf 不消费这些键）。
              { cwd: root, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...tailorEnv } },
              (err, stdout, stderr) => {
                currentChild = null;
                if (terminal) return; // 取消已收尾，不再改写终态
                resolve({
                  code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
                  stdout: stdout ?? "",
                  stderr: stderr ?? "",
                });
              },
            );
            currentChild = child;
          }),
        writeTempJd: async (text) => {
          const dir = path.join(root, ".career-ops-web", "tailor-tmp");
          fs.mkdirSync(dir, { recursive: true });
          const p = path.join(dir, `jd-${runId}.md`);
          fs.writeFileSync(p, text, "utf8");
          return p;
        },
        copyFile: (src, dst) => fs.promises.copyFile(src, dst),
      });

      if (terminal) return;
      if (result.ok) {
        publish(runId, { type: "done" });
        recordEnd("done");
      } else {
        publish(runId, { type: "error", msg: `${result.stage}: ${result.error}`.slice(0, 200) });
        recordEnd("error", `${result.stage}: ${result.error}`);
      }
    } catch (e) {
      if (!terminal) {
        const msg = `Tailor worker crashed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
        publish(runId, { type: "error", msg });
        recordEnd("error", msg);
      }
    } finally {
      release(poolHandle.id);
      clearTailor(n, runId, { processGone: true });
      completeRun(runId);
    }
  });

  return { runId };
}

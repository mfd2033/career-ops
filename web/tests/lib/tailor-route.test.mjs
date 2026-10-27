// /api/cv-tailor 路由接线锁 + worker→pdf-index→cv-pdf 解析 e2e 冒烟
// （工单 generate-tailored-cv/05）。
//
// 路由本身是传输层，按仓库惯例不跑起来测（同 /api/checkup-request）；这里锁两件事：
//   1. 接线锁（同 win-reveal.test.mjs 对 /api/cv-pdf/open 的锁法）：route 源文件必须
//      导出 POST、走 findTailorTarget 前哨 + decideTailorPreflight 守卫 + 全局并发池
//      acquire + 事件总线 publish/registerTailor——少接任一根线，闸门或广播就默默失效。
//   2. e2e 冒烟：mock worker 的 runScript 复刻三个根脚本的文件效应 → 真往临时 root 的
//      data/pdf-index.tsv 登记一行 → resolveCvPdf({report}) 精确命中该 PDF（含中文公司
//      名——报告号键路是它唯一可靠的打开方式，见 cv-pdf-resolve.mjs 头注）。
//
// Run:  node --test web/tests/lib/tailor-route.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTailorWorker } from "../../src/lib/tailor-worker.mjs";
import { resolveCvPdf } from "../../src/lib/cv-pdf-resolve.mjs";
import { applicationArtifactPaths, ensureApplicationArtifactDirs } from "../../../application-artifacts.mjs";

const ROUTE_SRC = readFileSync(path.join(import.meta.dirname, "../../src/app/api/cv-tailor/route.ts"), "utf8");

test("route 文件可被读取且导出 POST（agent 可调用的唯一起点）", () => {
  assert.match(ROUTE_SRC, /export async function POST/);
});

test("route 接线锁：前哨解析与在途守卫缺一不可（404/400/409 的线）", () => {
  assert.ok(ROUTE_SRC.includes("findTailorTarget"), "必须经 findTailorTarget 解析目标");
  assert.ok(ROUTE_SRC.includes("decideTailorPreflight"), "必须复用纯决策做在途守卫");
  assert.ok(ROUTE_SRC.includes("listLiveTailors"), "守卫判据来自 tailor 在跑登记表");
  assert.ok(/row-not-found.*404/s.test(ROUTE_SRC), "row-not-found 必须映射 404");
  assert.ok(/status: 409/.test(ROUTE_SRC), "blocked 必须映射 409");
  assert.ok(ROUTE_SRC.includes("awaitTailorGone"), "replace 必须先等旧进程真不在");
});

test("route 接线锁：派发到全局并发池 + 事件总线，不在请求内同步等待", () => {
  assert.ok(ROUTE_SRC.includes('from "@/lib/core/concurrency-pool"'), "必须挂全局并发池");
  assert.ok(/acquire\(/.test(ROUTE_SRC) && /release\(/.test(ROUTE_SRC), "acquire/release 成对");
  assert.ok(ROUTE_SRC.includes('from "@/lib/core/run-events"'), "事件走 ADR-0020 总线");
  assert.ok(/after\(async \(\)/.test(ROUTE_SRC), "worker 经 after() 转入后台，请求秒回");
  assert.ok(ROUTE_SRC.includes("registerTailor"), "登记早于 runId 回到调用方（跨页签权威）");
  assert.ok(ROUTE_SRC.includes("setCancelHandler"), "取消走显式 API（/api/run/cancel 可达）");
});

test("route 接线锁：worker 编排与落盘登记不被绕过", () => {
  assert.ok(ROUTE_SRC.includes("runTailorWorker"), "派发体复用 tailor-worker 编排壳");
  assert.ok(ROUTE_SRC.includes("appendRunRecord"), "终态落运行账本（无 UI 也要可回看）");
  // 凭据接线（2026-10-27 实弹报障）：密钥必须来自 ADR-0083 密钥库而不是进程 env，
  // 且只走 env 注入不开 argv（命令行参数会漏进进程列表）；缺密钥当场 400。
  assert.ok(ROUTE_SRC.includes("quick-vault.mjs"), "凭据复用密钥库（readVault/activeKey）");
  assert.ok(ROUTE_SRC.includes("no-tailor-credential"), "缺凭据在派发前就 400，不派必死的 worker");
  assert.match(ROUTE_SRC, /OPENAI_API_KEY/, "密钥经 env 递给 openai-tailor");
  assert.doesNotMatch(ROUTE_SRC, /"--key"/, "密钥绝不拼进 argv（进程列表可见）");
  // 台账链接契约锁（2026-10-27 自埋回归）：/report/{id} 的 id 是全系统统一的 **tracker
  // 行号**；写成报告号会让 re-eval 行的页面无 tracker 行、「查看定制简历」按钮消失。
  assert.ok(ROUTE_SRC.includes("page: `/report/${n}`"), "台账 page 必须用行号 n");
  assert.doesNotMatch(ROUTE_SRC, /\/report\/\$\{reportNum\}/, "绝不把 reportNum 拼进 /report/ 链接");
  // 纯后端触发器：路由里不许 import 任何前端组件（无 UI 是本 feature 的边界）。
  assert.doesNotMatch(ROUTE_SRC, /@\/components/, "不带任何 UI——仅供 agent/脚本调用");
});

// ── e2e 冒烟：mock worker → pdf-index.tsv 登记 → resolveCvPdf({report}) 命中 ──

test("mock worker 跑完链路后，GET /api/cv-pdf 的解析器按报告号精确命中中文公司名的 PDF", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cops-tailor-e2e-"));
  try {
    const company = "郑州如阳科技有限公司"; // 中文名：company-slug 兜底注定失败，只有报告号键路可靠
    const bundle = applicationArtifactPaths({ reportNum: "1162", company, role: "项目经理", root: path.join(root, "output") });
    ensureApplicationArtifactDirs(bundle); // 真实 CLI 的 --init 就是干这个的

    const markedWith = [];
    const runScript = async (file, args) => {
      if (file === "application-artifacts.mjs") {
        return { code: 0, stdout: JSON.stringify(bundle), stderr: "" };
      }
      if (file === "openai-tailor.mjs") {
        fs.writeFileSync(bundle.cv.source.html, "<!DOCTYPE html><html>tailored</html>");
        return { code: 0, stdout: `✅  Tailored HTML saved: ${bundle.cv.source.html}`, stderr: "" };
      }
      if (file === "generate-pdf.mjs") {
        const [, pdf] = args;
        const reportNum = args[2].split("=")[1];
        fs.writeFileSync(pdf, "%PDF-1.4 fake");
        // 复刻真实登记契约（generate-pdf.mjs 的 updatePDFManifest）：相对路径、正斜杠。
        const rel = path.relative(root, pdf).replace(/\\/g, "/");
        const idx = path.join(root, "data", "pdf-index.tsv");
        fs.mkdirSync(path.dirname(idx), { recursive: true });
        fs.appendFileSync(idx, `${reportNum}\t${rel}\t-\ta4\t2026-10-27\n`);
        return { code: 0, stdout: "Manifest updated", stderr: "" };
      }
      if (file === "mark-pdf-ready.mjs") {
        // 复刻 #2172 契约的调起形状：第一参数是真实报告号（tracker 行由它解析）。
        markedWith.push(args[0]);
        return { code: 0, stdout: JSON.stringify({ ok: true, changed: true }), stderr: "" };
      }
      throw new Error(`unexpected: ${file}`);
    };

    const res = await runTailorWorker(
      {
        company,
        role: "项目经理",
        jdText: "岗位职责：负责项目整体交付管理，协调跨部门资源，把控范围与进度风险，推动落地。".repeat(2),
        reportPath: path.join(root, "reports", "1162-ruzhi-2026-10-26.md"),
      },
      {
        root,
        runScript,
        writeTempJd: async (t) => {
          const p = path.join(root, "jd-tmp.md");
          fs.writeFileSync(p, t);
          return p;
        },
        copyFile: (s, d) => fs.promises.copyFile(s, d),
      },
    );
    assert.equal(res.ok, true, `worker failed: ${res.error}`);
    // 用户症状锁（2026-10-27）：渲染完必须回写 tracker 完成态，否则报告页永远显示未生成。
    assert.deepEqual(markedWith, ["1162"], "链路收尾必须按报告号调 mark-pdf-ready");

    // /api/cv-pdf?report=1162 的解析路径（同一份 resolveCvPdf，view 与 open 共用）。
    const hit = resolveCvPdf({ report: "1162" }, root);
    assert.equal(hit.ok, true, "pdf-index 登记后按报告号必须精确命中");
    assert.equal(hit.path, res.pdf);

    // 对照：裸公司名走 legacy slug 兜底对中文名 fail-closed（这正是 --report 登记是硬要求的原因）。
    const miss = resolveCvPdf({ company }, root);
    assert.equal(miss.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

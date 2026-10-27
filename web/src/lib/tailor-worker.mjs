// 定制简历生成 worker（工单 generate-tailored-cv/02）——离线编排壳。
//
// 它不重造任何现有 CLI，只把已经跑通的定制简历离线链路按顺序串起来：
//   1. application-artifacts.mjs —— 按 report+company+role 建 output/<key>/cv/tailored/vNNN/
//      目录并回吐稳定路径 JSON；
//   2. openai-tailor.mjs —— headless 的 OpenAI 兼容定制引擎（modes/pdf.md 之外的离线路
//      径，适合无交互 agent 的 worker），吃 --jd + --report 产出定制 HTML；
//   3. generate-pdf.mjs --report=N —— 渲染 PDF 并把 report→pdf 登记进 data/pdf-index.tsv，
//      于是 GET /api/cv-pdf?report=N 能精确命中（含中文公司名）。
//
// WHY 编排而非直接 import：三个脚本都是命令行入口（openai-tailor 一 import 就跑 arg
// parse + fetch，见 test-all #44f 注释），且 generate-pdf 依赖 Playwright；web 端一律
// 以子进程调起根脚本（career-ops.ts 的 rootScript/execFile 惯例），绝不跨目录 import
// 根 .mjs（turbopack.root 钉死在 web/，跨边界 import 会牵动 standalone 打包）。
//
// 因此本模块把所有外部效应收进注入的 deps：runScript（spawn 一个根脚本）、writeTempJd
// （把 jdText 落成临时文件）、copyFile（把定制 HTML 归位到 bundle）。单元测试用 fake
// runner 复刻各脚本的可观测文件效应（fake generate-pdf 真往临时 root 的 pdf-index.tsv
// 追加一行），从而证明「worker 把 --report 与产物路径接对了」，而不是重测脚本本身。
//
// 每个阶段经 publish 广播 stage 事件（调用方把它映射到 /api/events 的 status/stage 通道，
// 形状与 checkup worker 对齐）；任一步失败以 { ok:false, stage, error } 返回，绝不静默。

import path from "node:path";

/** 从报告文件名前缀推真实报告号（re-eval 会把行改指向新号）。取不到回退调用方给的兜底。 */
function deriveReportNum(reportPath, fallback) {
  const m = /^(\d+)-/.exec(path.basename(String(reportPath ?? "")));
  return m ? m[1] : String(fallback ?? "").trim();
}

/** 从 openai-tailor 的 stdout 里抠出它写下的定制 HTML 绝对路径。 */
function parseSavedHtml(stdout) {
  const m = /Tailored HTML saved:\s*(\S[^\r\n]*\.html)/i.exec(String(stdout ?? ""));
  return m ? m[1].trim() : null;
}

/** 失败原因优先给 stderr 尾部，退到 stdout / 固定句；截断防台账爆炸。 */
function failReason(res, fallback) {
  const raw = String(res?.stderr || res?.stdout || "").trim().replace(/\s+/g, " ");
  return (raw ? `${fallback}: ${raw}` : fallback).slice(0, 400);
}

/**
 * 跑一次定制简历生成。调用方在进入全局并发池、拿到槽位后调用它，并注入真实读盘/子进程。
 *
 * @param {{ company: string, role: string, jdText: string, reportPath: string }} target
 *   findTailorTarget 的解析结果——worker 不再自解析编号。
 * @param {{
 *   root: string,
 *   reportNum?: string,
 *   runScript: (file: string, args: string[]) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   writeTempJd: (text: string) => Promise<string>,
 *   copyFile: (src: string, dst: string) => Promise<void>,
 *   publish?: (stage: string, detail?: object) => void,
 * }} deps
 * @returns {Promise<{ ok: true, reportNum: string, html: string, pdf: string }
 *               | { ok: false, stage: string, error: string }>}
 */
export async function runTailorWorker(target, deps) {
  const { runScript, writeTempJd, copyFile } = deps;
  const reportNum = deriveReportNum(target.reportPath, deps.reportNum);
  const stage = (name, detail) => {
    if (deps.publish) deps.publish(name, detail);
  };

  if (!target.reportPath || !reportNum) {
    return { ok: false, stage: "artifacts", error: "missing report path / number to tailor against" };
  }

  // 1) 建 bundle 目录、拿稳定产物路径。application-artifacts 以 --root 指到本仓 output/，
  //    --init 建目录并把路径 JSON 打到 stdout。
  stage("artifacts", { reportNum });
  const artRes = await runScript("application-artifacts.mjs", [
    "--report", reportNum,
    "--company", target.company,
    "--role", target.role,
    "--root", path.join(deps.root, "output"),
    "--init",
  ]);
  if (artRes.code !== 0) return { ok: false, stage: "artifacts", error: failReason(artRes, "application-artifacts failed") };
  let paths;
  try {
    paths = JSON.parse(artRes.stdout);
  } catch {
    return { ok: false, stage: "artifacts", error: "application-artifacts returned unparseable path JSON" };
  }
  const bundleHtml = paths?.cv?.tailored?.html;
  const bundlePdf = paths?.cv?.tailored?.pdf;
  if (!bundleHtml || !bundlePdf) {
    return { ok: false, stage: "artifacts", error: "application-artifacts path JSON missing tailored html/pdf" };
  }

  // 2) headless 定制：jdText 落成临时文件，喂给 openai-tailor --jd --report，产出定制 HTML。
  stage("tailor", { reportNum });
  const jdPath = await writeTempJd(target.jdText);
  const tailorRes = await runScript("openai-tailor.mjs", ["--jd", jdPath, "--report", target.reportPath]);
  if (tailorRes.code !== 0) {
    return { ok: false, stage: "tailor", error: failReason(tailorRes, "openai-tailor failed (check OPENAI_API_KEY / endpoint)") };
  }
  const savedHtml = parseSavedHtml(tailorRes.stdout);
  if (!savedHtml) {
    return { ok: false, stage: "tailor", error: "openai-tailor exited 0 but reported no saved HTML path" };
  }
  // 把 flat 定制 HTML 归位到 bundle 的 tailored/vNNN/cv.html（工单要求产物落这一路径）。
  await copyFile(savedHtml, bundleHtml);

  // 3) 渲染 PDF 并登记：bundleHtml → bundlePdf，--report=N 让 generate-pdf 写 data/pdf-index.tsv，
  //    GET /api/cv-pdf?report=N 由此精确命中。缺 --report 登记 = 产物无法被回读，视为失败。
  stage("pdf", { reportNum });
  const pdfRes = await runScript("generate-pdf.mjs", [bundleHtml, bundlePdf, "--report=" + reportNum]);
  if (pdfRes.code !== 0) {
    return { ok: false, stage: "pdf", error: failReason(pdfRes, "generate-pdf failed") };
  }

  stage("done", { reportNum, html: bundleHtml, pdf: bundlePdf });
  return { ok: true, reportNum, html: bundleHtml, pdf: bundlePdf };
}

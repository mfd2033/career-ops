// 定制简历 worker（tailor-worker.mjs）的编排测试（工单 generate-tailored-cv/02）。
//
// worker 只是把三个根脚本按序串起来的编排壳，本测试用 fake runScript 复刻每个脚本
// 的「可观测文件效应」，从而锁住编排本身接对了参数与路径，而不是重测脚本内部：
//   - application-artifacts：用真实纯函数 applicationArtifactPaths 算出 bundle 路径并建目录，
//     回吐与 CLI 同形状的 JSON（worker 靠它拿到产物落点）；
//   - openai-tailor：往某 flat 路径写定制 HTML，并打印 `Tailored HTML saved: <path>`；
//   - generate-pdf --report=N：往 bundle 的 pdf 路径落文件，并真往 <root>/data/pdf-index.tsv
//     追加一行 report→pdf（复刻 generate-pdf 的登记契约），供 /api/cv-pdf?report=N 精确回读。
//
// 断言：定制 HTML/PDF 落到 output/<key>/cv/tailored/vNNN/，且 pdf-index.tsv 首列即报告号。
// 另测失败传播：LLM 调用失败 / PDF 渲染失败 / tailor 退 0 却没报路径，各自以 {ok:false} 返回。
//
// Run:  node --test web/tests/lib/tailor-worker.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTailorWorker } from "../../src/lib/tailor-worker.mjs";
import { applicationArtifactPaths } from "../../../application-artifacts.mjs";

const LONG_JD = "岗位职责：负责数据治理项目交付与跨职能团队协作，推动方案落地。要求 5 年以上经验。".repeat(3);

// 造一个临时 root，并返回 fake runScript / writeTempJd / copyFile + 记录调用。
function makeDeps({ tailorExit = 0, pdfExit = 0, tailorSavesHtml = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cops-tailor-"));
  const calls = [];
  const stages = [];
  let bundleRef = null;

  const runScript = async (file, args) => {
    calls.push({ file, args });
    if (file === "application-artifacts.mjs") {
      const reportIdx = args.indexOf("--report");
      const companyIdx = args.indexOf("--company");
      const roleIdx = args.indexOf("--role");
      const rootIdx = args.indexOf("--root");
      const paths = applicationArtifactPaths({
        reportNum: args[reportIdx + 1],
        company: args[companyIdx + 1],
        role: args[roleIdx + 1],
        root: args[rootIdx + 1],
      });
      fs.mkdirSync(path.dirname(paths.cv.tailored.html), { recursive: true });
      bundleRef = paths;
      return { code: 0, stdout: JSON.stringify(paths), stderr: "" };
    }
    if (file === "openai-tailor.mjs") {
      if (tailorExit !== 0) return { code: tailorExit, stdout: "", stderr: "API error: HTTP 401 invalid key" };
      if (!tailorSavesHtml) return { code: 0, stdout: "no path line here", stderr: "" };
      const flat = path.join(root, "output", "cv-candidate-acme.html");
      fs.mkdirSync(path.dirname(flat), { recursive: true });
      fs.writeFileSync(flat, "<!DOCTYPE html><html>tailored</html>", "utf8");
      return { code: 0, stdout: `\n✅  Tailored HTML saved: ${flat}\n`, stderr: "" };
    }
    if (file === "generate-pdf.mjs") {
      const [html, pdf] = args;
      if (pdfExit !== 0) return { code: pdfExit, stdout: "", stderr: "browser launch failed" };
      fs.mkdirSync(path.dirname(pdf), { recursive: true });
      fs.writeFileSync(pdf, "%PDF-1.4 fake", "utf8");
      // 复刻 generate-pdf 的 --report 登记：report \t pdf \t html \t format \t date，路径相对 root。
      const relPdf = path.relative(root, pdf).replace(/\\/g, "/");
      const idxPath = path.join(root, "data", "pdf-index.tsv");
      fs.mkdirSync(path.dirname(idxPath), { recursive: true });
      const reportNum = (args.find((a) => a.startsWith("--report=")) || "").split("=")[1];
      fs.appendFileSync(idxPath, `${reportNum}\t${relPdf}\t-\ta4\t2026-10-27\n`, "utf8");
      return { code: 0, stdout: "Manifest updated", stderr: "" };
    }
    throw new Error(`unexpected script: ${file}`);
  };

  const writeTempJd = async (text) => {
    const p = path.join(root, ".tmp-jd.md");
    fs.writeFileSync(p, text, "utf8");
    return p;
  };
  const copyFile = async (src, dst) => fs.promises.copyFile(src, dst);
  const publish = (stage, detail) => stages.push({ stage, detail });

  return {
    deps: { root, runScript, writeTempJd, copyFile, publish },
    calls,
    stages,
    bundle: () => bundleRef,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("正常链路：定制 HTML/PDF 落 output/<key>/cv/tailored/vNNN/，pdf-index 登记该报告号", async () => {
  const h = makeDeps();
  try {
    const target = { company: "Acme AI", role: "Senior Engineer", jdText: LONG_JD, reportPath: path.join(h.deps.root, "reports", "042-acme-2026-10-26.md") };
    const res = await runTailorWorker(target, h.deps);

    assert.equal(res.ok, true, `worker failed: ${res.error}`);
    assert.equal(res.reportNum, "042");

    // 产物落点：bundle 的 tailored/vNNN 下，且文件真实存在。
    const bundle = h.bundle();
    assert.match(bundle.cv.tailored.html, /cv[\\/]tailored[\\/]v001[\\/]cv\.html$/);
    assert.ok(fs.existsSync(res.html), "tailored html not written to bundle");
    assert.ok(fs.existsSync(res.pdf), "tailored pdf not written to bundle");

    // generate-pdf 被以 --report=042 调起（这是 /api/cv-pdf?report=N 能命中的前提）。
    const pdfCall = h.calls.find((c) => c.file === "generate-pdf.mjs");
    assert.ok(pdfCall.args.includes("--report=042"), "generate-pdf missing --report registration");

    // pdf-index.tsv 首列即报告号，路径指向 bundle pdf。
    const idx = fs.readFileSync(path.join(h.deps.root, "data", "pdf-index.tsv"), "utf8").trim();
    const [col0, col1] = idx.split("\t");
    assert.equal(col0, "042");
    assert.equal(path.resolve(h.deps.root, col1.replace(/\//g, path.sep)), res.pdf);

    // 阶段事件按序广播（artifacts → tailor → pdf → done）。
    assert.deepEqual(h.stages.map((s) => s.stage), ["artifacts", "tailor", "pdf", "done"]);
  } finally {
    h.cleanup();
  }
});

test("LLM 调用失败 → stage:tailor 的 ERROR，不静默", async () => {
  const h = makeDeps({ tailorExit: 1 });
  try {
    const res = await runTailorWorker(
      { company: "Acme", role: "Eng", jdText: LONG_JD, reportPath: path.join(h.deps.root, "reports", "042-a.md") },
      h.deps,
    );
    assert.equal(res.ok, false);
    assert.equal(res.stage, "tailor");
    assert.match(res.error, /openai-tailor failed/);
    assert.match(res.error, /HTTP 401/, "stderr 尾应拼进错误原因");
  } finally {
    h.cleanup();
  }
});

test("PDF 渲染失败 → stage:pdf 的 ERROR", async () => {
  const h = makeDeps({ pdfExit: 1 });
  try {
    const res = await runTailorWorker(
      { company: "Acme", role: "Eng", jdText: LONG_JD, reportPath: path.join(h.deps.root, "reports", "042-a.md") },
      h.deps,
    );
    assert.equal(res.ok, false);
    assert.equal(res.stage, "pdf");
    assert.match(res.error, /generate-pdf failed/);
  } finally {
    h.cleanup();
  }
});

test("tailor 退 0 但没报保存路径 → stage:tailor ERROR（不能凭空往下走）", async () => {
  const h = makeDeps({ tailorSavesHtml: false });
  try {
    const res = await runTailorWorker(
      { company: "Acme", role: "Eng", jdText: LONG_JD, reportPath: path.join(h.deps.root, "reports", "042-a.md") },
      h.deps,
    );
    assert.equal(res.ok, false);
    assert.equal(res.stage, "tailor");
    assert.match(res.error, /no saved HTML path/);
  } finally {
    h.cleanup();
  }
});

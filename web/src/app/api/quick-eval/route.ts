// quick-eval — 浏览器插件「快评」评估入口（服务端）。
//
// 输入: POST { url, title, text } — text 为 content.js 从 DOM 提取的 JD，不再
// 服务端 webFetch（省一次网络 + 规避 BOSS 风控空页）。
//
// 快评结合简历：服务端读 cv.md + profile 记忆，构造紧凑摘要内联进 prompt，
// 单轮 completion 完成适配度打分 → 秒级（实测 LLM 单轮 ~677ms，加简历仍远 <1 分钟）。
//
// 只读打分：不写 tracker、不入管道、不生成报告/CV。未配置密钥 → 403，插件据此
// 提示「快评不可用」，不越权改跑完整评估。
import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, readMemory } from "@/lib/career-ops";
import { readQuickConfig, quickEvaluate, buildCvSummary } from "@/lib/quick-eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function POST(req: NextRequest) {
  let body: { url?: unknown; title?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const url = str(body.url);
  const title = str(body.title);
  const text = str(body.text);
  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "missing JD text" }, { status: 400 });
  }

  const cfg = readQuickConfig();
  if (!cfg.apiKey) {
    return NextResponse.json({ error: "quickEvalNotConfigured" }, { status: 403 });
  }

  // 结合简历：读 cv.md + profile 记忆 → 紧凑摘要。
  let cvText = "";
  try {
    cvText = fs.readFileSync(path.join(careerOpsRoot(), "cv.md"), "utf8");
  } catch {
    /* 无 cv.md 时摘要只含 profile */
  }
  const cvSummary = buildCvSummary(cvText, readMemory());

  // 时间预算内单轮完成；失败/超时返回 502，插件降级为 toast「快评不可用」。
  // 超时时 quickEvaluate 抛 AbortError，这里统一转成可读错误。
  try {
    const result = await quickEvaluate(cfg, { title, jdText: text, cvSummary });
    return NextResponse.json({
      url,
      title,
      grade: result.grade,
      score: result.score,
      reason: result.reason,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "quick-eval failed";
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
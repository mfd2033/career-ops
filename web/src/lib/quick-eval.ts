// quick-eval.ts — 浏览器插件「快评」的直连 LLM 核心。
//
// 与完整评估（/api/run、/api/batch-evaluate，走 CLI agent 生成报告+写 tracker）
// 完全独立：快评只用【单轮 OpenAI 兼容 chat/completions】对 JD 打分，不写
// tracker、不入管道、不生成报告/CV。目标亚秒~秒级出分。
//
// 分数与完整评不等价——快评浅扫（JD + 简历要点），完整评深评（读 cv/profile/
// 全套模板）。两者 `/5` 不同属预期，互不覆盖。
//
// 配置持有：密钥唯一落盘点是 gitignore 的 data/quick-eval.json（服务端本地
// 文件），读取后仅内存使用，不打印不写日志。绝不进 localStorage / chrome 存储。

import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";

const CONFIG_REL = path.join("data", "quick-eval.json");

// Quick-eval 支持的 provider 预设（OpenAI 兼容 chat/completions 端点）。
// baseUrl 留空时使用对应 provider 的默认端点。仅快评用，不触及 CLI 引擎。
const PROVIDER_DEFAULTS: Record<string, string> = {
  agnes: "https://api.agnes-ai.cn/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export type QuickConfig = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
};

/** 读快评配置。文件不存在/损坏 → 返回空对象（configured=false）。 */
export function readQuickConfig(): QuickConfig {
  try {
    const raw = fs.readFileSync(path.join(careerOpsRoot(), CONFIG_REL), "utf8");
    const v = JSON.parse(raw);
    return {
      provider: typeof v.provider === "string" ? v.provider : "",
      model: typeof v.model === "string" ? v.model : "",
      baseUrl: typeof v.baseUrl === "string" ? v.baseUrl : "",
      apiKey: typeof v.apiKey === "string" ? v.apiKey : "",
    };
  } catch {
    return {};
  }
}

/** 写快评配置到 gitignore 的 data/quick-eval.json（原子写）。返回写入值（不含回显污染）。 */
export function writeQuickConfig(cfg: QuickConfig): void {
  const root = careerOpsRoot();
  const file = path.join(root, CONFIG_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8");
}

/** 解决实际请求端点：显式 baseUrl 优先，否则按 provider 默认。 */
function resolveBaseUrl(cfg: QuickConfig): string {
  const b = (cfg.baseUrl || "").trim().replace(/\/+$/, "");
  if (b) return b;
  const d = PROVIDER_DEFAULTS[cfg.provider || ""] || PROVIDER_DEFAULTS.agnes;
  return d;
}

/**
 * 从 cv.md + profile 记忆构建紧凑的简历摘要，用于内联进快评 prompt。
 * 取头部 + 技能/经验要点，截断到 ~4000 字符，保证单轮 completion 仍亚秒级。
 */
export function buildCvSummary(cvText: string, memory: string, maxLen = 4000): string {
  const parts: string[] = [];
  if (cvText.trim()) parts.push(cvText.trim());
  if (memory.trim()) parts.push(`[profile]\n${memory.trim()}`);
  let s = parts.join("\n\n----\n\n");
  // 去掉 markdown 语法噪音，压缩空白，避免无谓 token 损耗。
  s = s.replace(/[#*`>_~|-]/g, " ").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

/**
 * 构建快评 prompt：JD 内联 + 简历要点，限定短输出、严格格式。
 * 输出约束：grade / score / reason，便于机器人侧解析成徽章。
 */
export function buildQuickPrompt(title: string, jdText: string, cvSummary: string): string {
  return [
    "You are a fast job-fit scorer. Judge whether THIS candidate (resume below) is a strong fit for THIS job.",
    "Score honestly on a 5-point scale using HALF steps (0.5, 1.5, 2.5 ...). Ground the score in the resume, not just the job.",
    "Assess: core-fit of candidate's skills/experience to the role, seniority match, and AI/tech relevance where the JD mentions it.",
    `Resume:\n${cvSummary}`,
    "",
    `Job title: ${title}`,
    `Job description:\n${jdText}`,
    "",
    "Output ONE line exactly, nothing else:",
    'grade: <High|Medium|Low> / score: <N.N>/5 / reason: <≤15 words, why>',
  ].join("\n");
}

export type QuickResult = { grade: string; score: number; reason: string; raw: string };

/**
 * 单轮直连 LLM 快评。OpenAI 兼容 /chat/completions，非流式，max_tokens 下限保证
 * 解析；~3s 超时，失败抛错（供 route 降级为「快评不可用」）。
 */
export async function quickEvaluate(
  cfg: QuickConfig,
  opts: { title: string; jdText: string; cvSummary: string },
): Promise<QuickResult> {
  const baseUrl = resolveBaseUrl(cfg);
  const endpoint = `${baseUrl}/chat/completions`;
  const prompt = buildQuickPrompt(opts.title, opts.jdText, opts.cvSummary);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey || ""}`,
      },
      body: JSON.stringify({
        model: cfg.model || "agnes-2.5-flash",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`quick-eval LLM HTTP ${res.status}`);
  }
  const data = await res.json();
  const content: string =
    data?.choices?.[0]?.message?.content ?? data?.content ?? "";
  return parseQuickResult(content);
}

/** 解析 LLM 输出的单行，宽容处理：提取 grade/score/reason，失败回退空值。 */
export function parseQuickResult(raw: string): QuickResult {
  const line = String(raw ?? "").trim().split("\n").find((l) => /score\s*[:：]\s*\d/.test(l)) || "";
  const gradeMatch = line.match(/grade\s*[:：]\s*(\w+)/i);
  const scoreMatch = line.match(/score\s*[:：]\s*(\d+(?:\.\d+)?)\s*\/\s*5/i);
  const reasonMatch = line.match(/reason\s*[:：]\s*(.+)$/i);
  const score = scoreMatch ? clampScore(parseFloat(scoreMatch[1])) : 0;
  return {
    grade: gradeMatch ? gradeMatch[1] : "",
    score,
    reason: reasonMatch ? reasonMatch[1].trim() : "",
    raw: line,
  };
}

/** 归一化到 0~5。 */
function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(5, Math.max(0, n));
}
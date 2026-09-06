// quick-config — 浏览器插件「快评」的配置读写（仅服务端）。
//
// 隔离原则：快评配置与 CLI 评估配置（career-ops:config / /api/clis）完全分离，
// 修改这里不影响 web 端评估使用的 engine/model/provider。
//
// 密钥安全：apiKey 只写进 gitignore 的 data/quick-eval.json（服务端本地文件），
// 读接口永不返回 apiKey。不入 localStorage、不进 chrome 存储、不打印。
import { NextRequest, NextResponse } from "next/server";
import { readQuickConfig, writeQuickConfig } from "@/lib/quick-eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PutBody = {
  provider?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
};

// 只保留字符串字段的一致 shape；provider 不在预设内也放行（兼容用户自定义端点）。
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function GET() {
  const cfg = readQuickConfig();
  return NextResponse.json({
    configured: Boolean(cfg.apiKey),
    provider: cfg.provider || "",
    model: cfg.model || "",
    baseUrl: cfg.baseUrl || "",
  });
}

export async function PUT(req: NextRequest) {
  let body: PutBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const apiKey = str(body.apiKey);
  if (!apiKey) {
    return NextResponse.json({ error: "apiKey 必填" }, { status: 400 });
  }
  const cfg = { provider: str(body.provider), model: str(body.model), baseUrl: str(body.baseUrl), apiKey };
  writeQuickConfig(cfg);
  // 写盘后不把密钥回显给前端。
  return NextResponse.json({ ok: true, configured: true });
}
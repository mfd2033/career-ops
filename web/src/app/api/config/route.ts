import { readAppConfig, writeAppConfig, UNKNOWN_EMPLOYER_OPTIONS, type AppConfig, type UnknownEmployerPolicy } from "@/lib/app-config";

// Config page cliId/model → server-side store. The BOSS直聘 extension reads this
// to reuse the CLI + model already picked on the config page without asking
// again. Value-only: unlike the client store this has no mode field; the
// extension (and anyone calling here) only ever drives the CLI kind of eval.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_KEYS = ["cliId", "model", "unknownEmployer"] as const;

export async function GET() {
  return Response.json(readAppConfig());
}

export async function POST(req: Request) {
  let body: Partial<AppConfig>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const next: AppConfig = { ...readAppConfig() };
  const rec = body as Record<string, unknown>;
  for (const key of SAFE_KEYS) {
    // 只在请求携带该字段时才动它——partial 更新不该误清其他字段
    // （persistCliId/persistUnknownEmployer 各只 POST 自己那个键）。
    if (!(key in rec)) continue;
    if (key === "unknownEmployer") {
      // 枚举白名单校验：只落两个已知档位，脏值删除而非落库。
      if (UNKNOWN_EMPLOYER_OPTIONS.includes(rec.unknownEmployer as UnknownEmployerPolicy)) {
        next.unknownEmployer = rec.unknownEmployer as UnknownEmployerPolicy;
      } else {
        delete next.unknownEmployer;
      }
      continue;
    }
    const v = rec[key];
    if (typeof v === "string" && v) next[key] = v;
    else delete next[key];
  }
  writeAppConfig(next);
  return Response.json(next);
}
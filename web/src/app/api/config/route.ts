import os from "node:os";
import { readAppConfig, writeAppConfig, UNKNOWN_EMPLOYER_OPTIONS, type AppConfig, type UnknownEmployerPolicy } from "@/lib/app-config";
import { sanitizeCliDirs } from "@/lib/cli-dirs.mjs";
import { logOperation } from "@/lib/op-log-server";

// Config page cliId/model → server-side store. The BOSS直聘 extension reads this
// to reuse the CLI + model already picked on the config page without asking
// again. Value-only: unlike the client store this has no mode field; the
// extension (and anyone calling here) only ever drives the CLI kind of eval.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_KEYS = ["cliId", "model", "unknownEmployer", "concurrencyPool", "cliDirs"] as const;

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
    if (key === "concurrencyPool") {
      // 并发上限必须是 >=1 的整数；脏值删除（池回落到默认 4）。
      const v = rec.concurrencyPool;
      if (typeof v === "number" && Number.isInteger(v) && v >= 1) next.concurrencyPool = v;
      else delete next.concurrencyPool;
      continue;
    }
    if (key === "cliDirs") {
      // ADR-0097：指定安装目录表。整表覆盖（前端每次提交完整草稿），非法键与
      // 不可解析的目录在这里就被丢干净——否则一个错的目录会一路带到派发。
      const dirs = sanitizeCliDirs(rec.cliDirs, os.homedir());
      if (Object.keys(dirs).length > 0) next.cliDirs = dirs;
      else delete next.cliDirs;
      continue;
    }
    const v = rec[key];
    if (typeof v === "string" && v) next[key] = v;
    else delete next[key];
  }
  writeAppConfig(next);
  // 操作日志：设置改动（引擎/模型/并发/安装目录…）以前不留痕。只记键名不记值——
  // 值里可能有本机绝对路径，日志不是装它的地方。
  const changedKeys = SAFE_KEYS.filter((key) => key in rec);
  if (changedKeys.length > 0) {
    logOperation({
      trigger: "manual",
      type: "config",
      meta: [{ k: "fields", v: changedKeys.join(", ") }],
      status: "done",
    });
  }
  return Response.json(next);
}
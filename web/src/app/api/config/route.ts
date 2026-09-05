import { readAppConfig, writeAppConfig, type AppConfig } from "@/lib/app-config";

// Config page cliId/model → server-side store. The BOSS直聘 extension reads this
// to reuse the CLI + model already picked on the config page without asking
// again. Value-only: unlike the client store this has no mode field; the
// extension (and anyone calling here) only ever drives the CLI kind of eval.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_KEYS = ["cliId", "model"] as const;

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
  for (const key of SAFE_KEYS) {
    const v = (body as Record<string, unknown>)[key];
    if (typeof v === "string" && v) next[key] = v;
    else delete next[key];
  }
  writeAppConfig(next);
  return Response.json(next);
}
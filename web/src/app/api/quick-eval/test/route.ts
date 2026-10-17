// quick-eval/test — 密钥束连接测试（ADR-0083 工单 04）。
//
// 两种输入，一条纪律：
//   { keyId }                      → 测库里已存的那把；结果写回 lastTest 并落盘。
//   { provider, model, baseUrl, key } → 测表单里的草稿密钥；【绝不落盘、绝不写库】，
//                                     密钥串只存在于本次进程内。
//
// 响应只回 {ok, reason|latencyMs}：不回显任何密钥（连打码都不回——前端已有视图）。
// reason 是封闭集（auth/notFound/timeout/http/network），供界面分派可操作文案。
import { NextRequest, NextResponse } from "next/server";
import { careerOpsRoot } from "@/lib/career-ops";
import { probeQuickKey } from "@/lib/quick-eval";
import { readVault, writeVault, vaultSetTest, vaultView } from "@/lib/quick-vault.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const keyId = str(body.keyId);
  const draftKey = str(body.key);
  if (!keyId && !draftKey) {
    return NextResponse.json({ error: "keyId or key required" }, { status: 400 });
  }

  if (keyId) {
    // 已存密钥：从库里取整束，测完把结果写回该把的 lastTest（徽标的数据源）。
    const root = careerOpsRoot();
    const vault = readVault(root);
    const found = vault.keys.find((k: { id: string }) => k.id === keyId);
    if (!found) {
      return NextResponse.json({ error: "keyNotFound" }, { status: 404 });
    }
    const result = await probeQuickKey({ provider: found.provider, model: found.model, baseUrl: found.baseUrl, apiKey: found.key });
    const nextVault = vaultSetTest(vault, keyId, result.ok);
    writeVault(root, nextVault);
    return NextResponse.json({
      ok: result.ok,
      ...(result.ok ? { latencyMs: result.latencyMs } : { reason: result.reason }),
      // 顺带回新库视图：前端一次往返同时刷新徽标，不再多打一次 GET。
      ...vaultView(nextVault),
    });
  }

  // 草稿密钥：只测不落盘（决议 5 的前端表单侧）。
  const result = await probeQuickKey({
    provider: str(body.provider),
    model: str(body.model),
    baseUrl: str(body.baseUrl),
    apiKey: draftKey,
  });
  return NextResponse.json({ ok: result.ok, ...(result.ok ? { latencyMs: result.latencyMs } : { reason: result.reason }) });
}

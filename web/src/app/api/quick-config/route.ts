// quick-config — 快评密钥库的读写（仅服务端，ADR-0083）。
//
// 隔离原则不变：快评配置与 CLI 评估配置（career-ops:config / /api/clis）完全分离。
//
// 密钥安全（决议 3 延伸）：明文密钥只写进 gitignore 的 data/quick-eval.json，
// GET 只回库视图（打码串，不可还原），任何响应不含 apiKey。
// 写路径唯一：带 action 的 PUT（add/update/remove/activate）；旧的「单密钥
// 整体覆盖」兼容分支已随密钥库 UI 接线收口删除（ADR-0083 工单 03）。
import { NextRequest, NextResponse } from "next/server";
import { careerOpsRoot } from "@/lib/career-ops";
import {
  readVault,
  writeVault,
  vaultView,
  applyVaultAction,
  VaultError,
} from "@/lib/quick-vault.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// action → HTTP 状态映射：库语义错误不能都糊成 400。
const ERROR_STATUS: Record<string, number> = {
  keyNotFound: 404,
  keyRequired: 400,
  idRequired: 400,
  unknownAction: 400,
};

export async function GET() {
  return NextResponse.json(vaultView(readVault(careerOpsRoot())));
}

export async function PUT(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const root = careerOpsRoot();
  const vault = readVault(root);
  try {
    // 写路径唯一：action 协议。无 action 的旧单密钥 PUT 已收口，不再受理。
    const result = applyVaultAction(vault, body);
    writeVault(root, result.vault);
    // 写盘后只回库视图：不回显任何密钥（连刚写入的那把也只回打码串）。
    return NextResponse.json({ ok: true, ...vaultView(result.vault) });
  } catch (e) {
    if (e instanceof VaultError) {
      return NextResponse.json({ error: e.code }, { status: ERROR_STATUS[e.code] || 400 });
    }
    throw e;
  }
}

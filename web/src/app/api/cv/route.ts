import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { pruneCvSnapshots } from "@/lib/cv-history.mjs";
import { MAX_CV_BYTES } from "@/lib/cv/import";
import { logConfigWrite } from "@/lib/op-log-server";

function cvPath() {
  return path.join(careerOpsRoot(), "cv.md");
}

// 历史快照保留上限（ADR-0048 决议 5）：仅 cv.md 的保存路径清理，
// 通用 backup() 与其他消费路由不受影响。
const CV_SNAPSHOT_CAP = 20;

export async function GET() {
  try {
    return NextResponse.json({ content: fs.readFileSync(cvPath(), "utf8"), exists: true });
  } catch {
    return NextResponse.json({ content: "", exists: false });
  }
}

export async function POST(req: Request) {
  let body: { content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.content, "utf8") > MAX_CV_BYTES) {
    return NextResponse.json({ error: "CV is too large (over 200KB)" }, { status: 413 });
  }
  // DATA_CONTRACT: cv.md is user-layer and gitignored (no git recovery). Never
  // blind-overwrite — snapshot the prior CV to a .bak first, write atomically.
  try {
    const bak = atomicWriteWithBackup(cvPath(), body.content);
    // 保存成功后清理超限快照（ADR-0048 决议 5）。best-effort：pruneCvSnapshots
    // 内部已逐个吞错，这里再包一层——清理永远不影响保存结果的返回。
    try {
      pruneCvSnapshots(careerOpsRoot(), CV_SNAPSHOT_CAP);
    } catch {}
    // 操作日志：cv.md 是用户层文件，覆盖保存不可逆（只留 .bak 快照）。
    // 只记文件名，不记内容长度或任何片段。
    logConfigWrite("cv-save", { title: "cv.md" });
    return NextResponse.json({ ok: true, backedUp: !!bak });
  } catch {
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
}

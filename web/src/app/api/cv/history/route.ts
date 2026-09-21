import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { listCvSnapshots, snapshotFileName } from "@/lib/cv-history.mjs";

// 简历历史版本 API（ADR-0048 决议 1/2）。历史 = 根目录 cv.md.bak-{时间戳}
// 快照，零迁移直接扫描。GET 无参 → 列表（倒序 + 字节数）；GET ?ts=… → 单份
// 内容（预览/还原用）。ts 经 snapshotFileName 白名单重组文件名，任何非法
// 形态（含路径遍历）一律 400——本路由从不接受调用方拼的原始文件名。

export async function GET(req: Request) {
  const root = careerOpsRoot();
  const ts = new URL(req.url).searchParams.get("ts");
  if (ts !== null) {
    const name = snapshotFileName(ts);
    if (!name) return NextResponse.json({ error: "bad ts" }, { status: 400 });
    try {
      const content = fs.readFileSync(path.join(root, name), "utf8");
      return NextResponse.json({ ts, content });
    } catch {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }
  return NextResponse.json({ snapshots: listCvSnapshots(root) });
}

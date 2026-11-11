import { NextResponse } from "next/server";
import { readMemory, rememberFact } from "@/lib/career-ops";
import { logConfigWrite } from "@/lib/op-log-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ memory: readMemory() });
}

// Append a durable fact the assistant learned about the user. Written to the
// CANONICAL modes/_profile.md (single source of truth) so the CLI/TUI see it too
// — never a web-only memory store.
export async function POST(req: Request) {
  let b: { fact?: string };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  const fact = (b.fact ?? "").toString();
  if (!fact.trim()) return NextResponse.json({ error: "fact required" }, { status: 400 });

  const result = rememberFact(fact);
  if (result === "error") return NextResponse.json({ error: "write failed" }, { status: 500 });
  // 操作日志：只记「写了/已存在」，事实原文留在 modes/_profile.md。去重也是结果，
  // 回看时能解释为什么这条记忆没有第二次出现。
  logConfigWrite("memory-write", {
    title: "modes/_profile.md",
    meta: [{ k: "verdict", v: result === "deduped" ? "deduped" : "added" }],
  });
  return NextResponse.json({ ok: true, deduped: result === "deduped" });
}

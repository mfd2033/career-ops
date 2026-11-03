import os from "node:os";
import { NextResponse } from "next/server";
import { groupSkills, sanitizeSkillDirs, scanSkillRegistry } from "@/lib/skill-registry.mjs";
import { readAppConfig, writeAppConfig } from "@/lib/app-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 本机 agent 技能注册表的展示通道（ADR-0056 决议 2/8）。
//
// 每次请求实时扫（决议 8：目录小、毫秒级，v1 无缓存无重检按钮）；单目录缺失/不可读
// 在扫描器内部静默跳过，这里永远 200——「装没装」本身就是面板要如实展示的信息，
// 不是服务端错误。返回全部技能（扫描器通用），聚焦白名单过滤由展示层做（决议 2）。
//
// skillDirs 是用户在面板里手动指定的额外安装目录：服务端持真值（与 cliDirs 同理，
// 派发是 headless 子进程读不到浏览器存储），展示与体检派发共用同一份扫描器输入。
// POST 整表覆盖并立即回扫，面板拿到的新结果与保存后的实际扫描范围一致。

function scan(extraDirs: string[]) {
  return { skills: groupSkills(scanSkillRegistry({ extraDirs })), skillDirs: extraDirs };
}

export async function GET() {
  return NextResponse.json(scan(readAppConfig().skillDirs ?? []));
}

export async function POST(req: Request) {
  let body: { skillDirs?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("skillDirs" in body)) {
    return NextResponse.json({ error: "skillDirs required" }, { status: 400 });
  }
  const dirs = sanitizeSkillDirs(body.skillDirs, os.homedir());
  const next = { ...readAppConfig() };
  if (dirs.length > 0) next.skillDirs = dirs;
  else delete next.skillDirs;
  writeAppConfig(next);
  return NextResponse.json(scan(dirs));
}

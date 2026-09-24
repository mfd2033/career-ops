import { NextResponse } from "next/server";
import { groupSkills, scanSkillRegistry } from "@/lib/skill-registry.mjs";

export const dynamic = "force-dynamic";

// 本机 agent 技能注册表的展示通道（ADR-0056 决议 2/8）。
//
// 每次请求实时扫（决议 8：目录小、毫秒级，v1 无缓存无重检按钮）；单目录缺失/不可读
// 在扫描器内部静默跳过，这里永远 200——「装没装」本身就是面板要如实展示的信息，
// 不是服务端错误。返回全部技能（扫描器通用），聚焦白名单过滤由展示层做（决议 2）。
export async function GET() {
  const skills = groupSkills(scanSkillRegistry());
  return NextResponse.json({ skills });
}

import type { Dict } from "../types";

// Cluster: portals
// English (source) strings. Each key is dotted and namespaced by cluster, e.g.
// "portals.something". Add keys here and their Chinese counterpart in zh below.
export const en: Dict = {
  "portals.title": "Portals",
  "portals.intro":
    "The companies career-ops watches for new roles. Run a health check to catch company boards that have quietly broken — a broken link means that company silently disappears from every future scan.",
  "portals.backed": "edit it directly or ask the assistant.",
  "portals.checkHealth": "Check portal health",
  "portals.probing": "Probing each company's ATS… (~30–60s)",
  "portals.verifyNotFound":
    "not found — this needs a complete career-ops checkout (the web orchestrates the core's validator).",
  "portals.noPortalsYml": "yet — ask the assistant to set up the companies to scan.",
  "portals.statLive": "live",
  "portals.statBroken": "broken",
  "portals.statTracked": "tracked",
  "portals.silentlyDropsSingular": "company silently drops from every scan",
  "portals.silentlyDropsPlural": "companies silently drop from every scan",
  "portals.brokenPrefix": "— their careers link is broken. Fix the",
  "portals.brokenMid": "in",
  "portals.brokenSuffix": "(or ask the assistant to repair them).",
  "portals.statusLive": "live",
  "portals.statusLiveEmpty": "live · empty",
  "portals.statusBroken": "broken",
  "portals.statusNoAts": "no ATS",
  "portals.fixing": "Fixing…",
  "portals.repairedRecheck": "repaired · re-check",
  "portals.fixTitle": "Have the agent repair {company}'s portal slug",
  "portals.fix": "Fix",
};

// Simplified Chinese strings. Every key in en must have a matching key here.
export const zh: Dict = {
  "portals.title": "门户",
  "portals.intro":
    "career-ops 关注的、可能出现新职位的公司。运行一次健康检查，可以捕获那些已悄悄失效的公司招聘页 —— 链接失效意味着该公司会从今后的每次扫描中悄然消失。",
  "portals.backed": "可直接编辑，或让助手设置。",
  "portals.checkHealth": "检查门户健康状态",
  "portals.probing": "正在探测各家公司的 ATS…（约 30–60 秒）",
  "portals.verifyNotFound":
    "未找到 —— 这需要一份完整的 career-ops 检出（网页端会调度核心的校验器）。",
  "portals.noPortalsYml": "尚未配置 —— 请让助手设置要扫描的公司。",
  "portals.statLive": "在线",
  "portals.statBroken": "失效",
  "portals.statTracked": "已跟踪",
  "portals.silentlyDropsSingular": "家公司悄然从每次扫描中消失",
  "portals.silentlyDropsPlural": "家公司悄然从每次扫描中消失",
  "portals.brokenPrefix": "—— 它们的招聘链接已失效。请修复",
  "portals.brokenMid": "（位于",
  "portals.brokenSuffix": "中）（或让助手修复它们）。",
  "portals.statusLive": "在线",
  "portals.statusLiveEmpty": "在线 · 空",
  "portals.statusBroken": "已失效",
  "portals.statusNoAts": "无 ATS",
  "portals.fixing": "修复中…",
  "portals.repairedRecheck": "已修复 · 重新检查",
  "portals.fixTitle": "让助手修复 {company} 的门户 slug",
  "portals.fix": "修复",
};

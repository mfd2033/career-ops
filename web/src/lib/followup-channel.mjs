// 跟进渠道的唯一事实来源：合法值白名单（数据层规范值，落 data/follow-ups.md
// 的 channel 列）、后端归一化、显示层 i18n 键查表。
//
// 拆成纯 .mjs 是为了让 node --test 能直接门住白名单逻辑（web/tests/lib/
// followup-channel.test.mjs）——路由 .ts 无法被裸 node 导入。
//
// 用户决策（2026-09-28）：数据值永远保持英文规范值；中文只出现在显示层；
// 后端不接受中文别名（无中文输入路径，保持校验简单）。

/** 下拉框选项顺序即此数组顺序；Other 沉底。 */
export const CHANNELS = ["Email", "LinkedIn", "Platform", "Phone", "Other"];

/**
 * 把任意输入归一化为合法渠道值，非法输入返回 null（调用方负责拒绝）。
 * 大小写不敏感 + 容忍首尾空白，与既有路由行为一致；非字符串安全返回 null。
 */
export function normalizeChannel(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  for (const c of CHANNELS) {
    if (c.toLowerCase() === lower) return c;
  }
  return null;
}

/**
 * 渠道值 → 显示用 i18n 键（如 followups.channel.Platform）；未知值返回
 * null，调用方原样显示——旧 bullet 数据没有 channel、CLI 侧可能落过任意
 * 文本，不能显示成键名。已知值做大小写不敏感匹配，兼容历史脏值。
 */
export function channelLabelKey(raw) {
  const canonical = normalizeChannel(raw);
  return canonical ? `followups.channel.${canonical}` : null;
}

/**
 * 渲染层共用助手：把渠道值翻译成显示文本。未知值原样返回（不显示键名），
 * 旧 bullet 数据与 CLI 直写的任意文本走的正是这条兜底。
 */
export function channelLabel(raw, t) {
  const key = channelLabelKey(raw);
  return key ? t(key) : raw;
}

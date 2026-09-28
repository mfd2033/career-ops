// followup-channel.mjs 的类型声明：CHANNELS 需要 as const 级别的字面量元组，
// 否则 allowJs 推导会把数组读成 string[]，下游 Channel 类型塌缩成 string、
// 失去编译期渠道值校验（实测 2026-09-28）。改动 CHANNELS 时两处同步。
export const CHANNELS: readonly ["Email", "LinkedIn", "Platform", "Phone", "Other"];

export type Channel = (typeof CHANNELS)[number];

/** 表单预选渠道；单测锁定其为 CHANNELS 成员。 */
export const DEFAULT_CHANNEL: (typeof CHANNELS)[number];

/** 归一化为合法渠道值；非法/非字符串输入返回 null（语义见 .mjs 实现）。 */
export function normalizeChannel(raw: unknown): Channel | null;

/** 渠道值 → 显示 i18n 键；未知值返回 null，调用方原样显示。 */
export function channelLabelKey(raw: unknown): string | null;

/** 渲染层共用助手：翻译渠道值为显示文本，未知值原样返回。 */
export function channelLabel(raw: string, t: (key: string) => string): string;

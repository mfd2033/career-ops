/**
 * 输入框焦点样式统一令牌（UI 一致性审计 2026-10-31 · 统一建议 #1）。
 *
 * 全站输入框只允许两种焦点口径：
 * - 直接输入框 / 文本域：`fieldCls` —— focus:border-brand/50 +
 *   focus-visible:ring-2 ring-brand/40（文本输入聚焦时 focus-visible 恒真，
 *   键盘与鼠标表现一致）。
 * - 容器型搜索框（图标 + 内嵌 input + 内嵌 ×）：外层容器挂 `fieldWrapCls`
 *   （focus-within），内嵌 input 只保留 outline-none。
 *
 * 禁止再引入新的离群色（如 sky-400）或只写 focus: 的 ring（鼠标点击也会闪）。
 */
export const fieldCls =
  "outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40";

export const fieldWrapCls =
  "transition-colors focus-within:border-brand/50 focus-within:ring-2 focus-within:ring-brand/40";

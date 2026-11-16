// 投递时机的语义色口径（ADR-0085）：等级与全局结论 → 徽章 tone 只有这一处映射。
// 单独成文件是为了避免「常驻条 ↔ 矩阵弹窗」互相 import 成环。
// 颜色仍复用既有语义色：good = 该投，warn = 别投，muted = 可以但非最佳；
// 品牌橙留给「选中/激活」，不参与等级编码。

import type { DeliveryAction, DeliveryLevel } from "@/lib/delivery-window.mjs";

export const LEVEL_TONE: Record<DeliveryLevel, "good" | "muted" | "warn"> = {
  best: "good",
  ok: "muted",
  avoid: "warn",
};

export const ACTION_TONE: Record<DeliveryAction, "good" | "muted" | "warn"> = {
  send: "good",
  ok: "muted",
  wait: "warn",
};

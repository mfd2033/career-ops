"use client";

import { useEffect, useState } from "react";
import { readSavedUnknownEmployer, type UnknownEmployerPolicy } from "@/lib/saved-cli";

/**
 * 客户端读取未知雇主策略。
 *
 * 为什么不直接在渲染期调 `readSavedUnknownEmployer()`：组件会先在服务端渲染一次，
 * 那里没有 localStorage —— 服务端出 `?`、浏览器 hydrate 出「云憬人力（代招）」，两侧
 * 标记不一致就是 hydration 报错（报告页此前正是渲染期直读）。所以首帧统一按默认档
 * 渲染，挂载后再切到用户档位。
 *
 * 列表页与详情页共用它，保证两处显示口径不会再次分叉（它们曾经分叉：详情页有代招方
 * 回退，列表页没有）。
 */
export function useUnknownEmployerPolicy(): UnknownEmployerPolicy {
  const [policy, setPolicy] = useState<UnknownEmployerPolicy>("placeholder");
  useEffect(() => setPolicy(readSavedUnknownEmployer()), []);
  return policy;
}

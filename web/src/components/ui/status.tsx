"use client";

import type { ComponentType, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * 列表四件套（UI 一致性审计 2026-10-31 · 统一建议 #5）：
 * 加载（Loading）/ 骨架（Skeleton）/ 空态（EmptyState）/ 错误横幅（ErrorBanner）。
 * 列表页的三态一律复用这里的组件，不再各写一套 spinner / 虚线框 / 红条。
 * label / title / hint 等文案由调用方经 i18n 传入，组件本身不产内容。
 */

/** 加载态：居中转圈，label 可选（建议传，纯图标对读屏不友好）。 */
export function Loading({ label, className }: { label?: string; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={cn("flex items-center justify-center gap-2 py-10 text-sm text-faint", className)}>
      <Loader2 className="size-5 animate-spin" aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

/** 骨架块：纯占位形状，尺寸由调用方给定（如 className="h-4 w-32"）。 */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-lg bg-surface-hover", className)} />;
}

/** 空态：虚线框 + 标题 + 可选提示行（沿用黑名单页的空态版式）。 */
export function EmptyState({
  title,
  hint,
  icon: Icon,
  className,
}: {
  title: string;
  hint?: string;
  icon?: ComponentType<{ className?: string }>;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-dashed border-border px-6 py-14 text-center", className)}>
      {Icon ? <Icon className="mx-auto size-5 text-faint" aria-hidden="true" /> : null}
      <div className="font-display text-xl text-foreground">{title}</div>
      {hint ? <div className="mx-auto mt-1.5 max-w-md text-sm text-muted">{hint}</div> : null}
    </div>
  );
}

/** 错误横幅：红底警示条，children 为已映射好的界面文案（禁止直接塞接口错误码）。 */
export function ErrorBanner({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={cn("rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400", className)}>
      {children}
    </div>
  );
}

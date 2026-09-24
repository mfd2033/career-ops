"use client";

import type { MouseEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// ADR-0059: 筛选输入框内嵌一键清空。绝对定位的 × 按钮本体，由父级包在
// `relative` 容器里、自己的 input 旁边；`show` 为 false 时不渲染（非空才显示）。
// 焦点规则（冒烟发现的缺口）：onMouseDown preventDefault 只能「不抢」焦点——
// 此前焦点在别处（如 body）时清空后焦点不会落到输入框。所以 onClick 清空后
// 显式 focus 同容器的 input 兜底，保证「清掉重搜」总是同一个连续手势。
// 6 处使用点见 ADR-0059 决议 2。
export function InputClearButton({
  show,
  onClear,
  label,
  className,
}: {
  show: boolean;
  onClear: () => void;
  label: string;
  className?: string;
}) {
  if (!show) return null;
  const keepFocus = (e: MouseEvent<HTMLButtonElement>) => e.preventDefault();
  const clearAndFocusInput = (e: MouseEvent<HTMLButtonElement>) => {
    onClear();
    e.currentTarget.parentElement?.querySelector("input")?.focus();
  };
  return (
    <button
      type="button"
      onMouseDown={keepFocus}
      onClick={clearAndFocusInput}
      aria-label={label}
      title={label}
      className={cn(
        "absolute right-2 top-1/2 z-10 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-faint transition-colors hover:bg-surface-hover hover:text-foreground max-sm:size-6",
        className,
      )}
    >
      <X className="size-3.5" />
    </button>
  );
}

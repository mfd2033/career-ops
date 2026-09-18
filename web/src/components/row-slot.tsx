import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * 列表之上的常驻槽位（ADR-0039）。
 *
 * 定高布局（`/pipeline`，ADR-0011）里顶区元素一律 `md:shrink-0`、列表容器 `md:flex-1
 * md:min-h-0`——所以**任何条件行挂载/卸载都是一次净高度变化**，会把列表顶开。批量条
 * （管道追踪器 + 收件箱）正是这种行。这个容器把「常驻」这件事固定下来：槽位在 `md:`
 * 及以上恒占一行、高度写死，只切内容。
 *
 * - **高度必须 ≥ 条的自然高度**：`md:h-10` 对应管道那条（`px-3 py-1.5 text-xs` + 26px
 *   按钮 + 边框），收件箱那条更高，由调用方传 `className` 覆盖（`md:h-11`）。日后改条的
 *   内边距要同步改槽位高度，否则条的底部会被 `md:overflow-hidden` 裁掉。
 * - **空态是回退提示语，不是空白**：`children` 为假值时渲染一句淡提示，说清「勾选后能
 *   做什么」，避免用户对着一段没有信息的空白发呆。
 * - **`md:` 以下不占位**：窄屏没有定高布局，页面上没有「被顶开的列表」这回事，而常驻
 *   一行（选中态最长要两行按钮 ≈ 108px）会白吃手机九分之一屏。窄屏只在有内容时才占位，
 *   即保持改动前的行为——已知残差，见 ADR-0039 决议 2。
 */
export function RowSlot({
  hint,
  children,
  className,
}: {
  /** 空态那一句淡提示语（`md:` 以下不显示）。 */
  hint: ReactNode;
  children?: ReactNode;
  /** 覆盖默认高度/间距（经 `cn` 合并，后写者胜）。 */
  className?: string;
}) {
  return (
    <div className={cn("md:mt-3 md:flex md:h-10 md:shrink-0 md:items-center md:overflow-hidden", className)}>
      {children ? children : <span className="hidden min-w-0 truncate text-xs text-faint md:inline">{hint}</span>}
    </div>
  );
}

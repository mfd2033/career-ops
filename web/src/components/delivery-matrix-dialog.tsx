"use client";

import { useEffect } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LEVEL_TONE } from "@/components/delivery-tone";
import {
  DAY_TYPES,
  PLATFORMS,
  dayTypeOf,
  formatMinutes,
  matrixRows,
  minutesOfDay,
} from "@/lib/delivery-window.mjs";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

/**
 * 投递黄金时间矩阵弹窗（ADR-0085 增量）：把 BOSS直聘 / 猎聘 / 智联招聘 三个平台
 * 收进同一张表——行 = 三平台时段边界的并集，列 = 四个日型 × 三个平台子列。
 *
 * 为什么合成一张表：三个平台的规律要在同一时刻横向比较（周二 10:00 是 Boss 黄金
 * 而猎聘只是「可以」），分成两张表就得来回对时间。行数据全部来自
 * `delivery-window.mjs` 的 `matrixRows()`，弹窗只负责摆放，不含第二套口径与文案。
 *
 * 只读：不写盘、不改状态，与常驻条的纪律一致。
 */
export function DeliveryMatrixDialog({ now, onClose }: { now: Date; onClose: () => void }) {
  const { t } = useI18n();

  // Esc 关闭：与状态记录弹窗同一套交互（打开期间挂监听，卸载即摘）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const today = dayTypeOf(now);
  const nowMinute = minutesOfDay(now);
  const rows = matrixRows();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("delivery.matrix.aria")}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="font-display text-lg">{t("delivery.matrix.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("delivery.matrix.close")}
            className="rounded p-1 text-faint transition hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* 窄屏整体横滑：时段列与今天那一组仍要能同屏对齐比较，所以不拆表。 */}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-[11px]">
            <thead>
              <tr>
                <th
                  rowSpan={2}
                  scope="col"
                  className="border-b border-border px-2 pb-1 text-left text-xs font-semibold text-muted"
                >
                  {t("delivery.matrix.colTime")}
                </th>
                {DAY_TYPES.map((dayType) => {
                  const isToday = dayType === today;
                  return (
                    <th
                      key={dayType}
                      colSpan={PLATFORMS.length}
                      scope="colgroup"
                      className={cn(
                        "border-b border-border px-1 pb-1 text-center text-xs font-semibold",
                        isToday ? "bg-brand-soft text-brand-text" : "text-foreground",
                      )}
                    >
                      {t(`delivery.matrix.dayType.${dayType}`)}
                      {isToday && (
                        <span className="ml-1 text-[11px] font-semibold">{t("delivery.matrix.today")}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
              <tr>
                {DAY_TYPES.map((dayType) => {
                  const isToday = dayType === today;
                  return PLATFORMS.map((platform, index) => (
                    <th
                      key={`${dayType}-${platform}`}
                      scope="col"
                      className={cn(
                        "border-b border-border px-1 pt-0.5 text-center text-xs font-medium text-faint",
                        index === 0 && "border-l border-border",
                        isToday && "bg-brand-soft",
                      )}
                    >
                      {t(`delivery.matrix.platform.${platform}`)}
                    </th>
                  ));
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const isNowRow = nowMinute >= row.start && nowMinute < row.end;
                return (
                  <tr key={row.start} className={cn(isNowRow && "bg-surface-hover")}>
                    <th
                      scope="row"
                      className={cn(
                        "whitespace-nowrap px-2 py-1 text-left text-xs font-medium tabular-nums",
                        isNowRow
                          ? "text-foreground shadow-[inset_2px_0_0_var(--color-brand)]"
                          : "text-muted",
                      )}
                    >
                      {formatMinutes(row.start)}–{formatMinutes(row.end)}
                      {isNowRow && (
                        <span className="ml-1 text-[11px] font-semibold text-brand-text">
                          {t("delivery.matrix.now")}
                        </span>
                      )}
                    </th>
                    {DAY_TYPES.map((dayType, dayIndex) => {
                      const isToday = dayType === today;
                      return PLATFORMS.map((platform, index) => {
                        const level = row.levels[platform][dayIndex];
                        return (
                          <td
                            key={`${row.start}-${dayType}-${platform}`}
                            className={cn(
                              "px-0.5 py-1 text-center",
                              index === 0 && "border-l border-border",
                              isToday && "bg-brand-soft",
                            )}
                          >
                            <Badge
                              tone={LEVEL_TONE[level]}
                              className="min-w-[34px] px-1 py-0.5 text-[11px]"
                            >
                              {t(`delivery.level.${level}`)}
                            </Badge>
                          </td>
                        );
                      });
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

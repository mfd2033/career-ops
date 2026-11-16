"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { LEVEL_TONE } from "@/components/delivery-tone";
import { formatMinutes, nextWindow, windowAt } from "@/lib/delivery-window.mjs";
import type { DeliveryLevel } from "@/lib/delivery-window.mjs";
import { sourcePlatform } from "@/lib/source-label.mjs";
import { useI18n } from "@/lib/i18n/context";

// 星期索引 → i18n 键后缀，与 Date.getDay() 对齐（0 = 周日）；delivery.when.other 用。
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// 矩阵粒度是半小时，30 秒足够「到点即换结论」——与 DeliveryTimeHint 同一时钟纪律。
const TICK_MS = 30_000;

/**
 * 行级/卡片级「跟进时机」徽章（ADR-0102）：按职位来源平台判定当前时刻发跟进
 * 消息的黄金时段结论。与投递时机共用同一引擎（delivery-window.mjs）、同一套
 * 等级配色（LEVEL_TONE）与同一批文案键（delivery.*），不建第二份口径。
 *
 * postingUrl 缺失或来源不在三平台（ATS/公司官网/拉勾…）→ muted「—」加悬停
 * 说明，不静默消失（ADR-0085 的诚实降级原则）。SSR 首帧 now=null 走同一个
 * 「—」占位，行高不跳动。
 */
export function FollowupTimingBadge({ postingUrl }: { postingUrl?: string | null }) {
  const { t } = useI18n();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const platform = useMemo(() => (postingUrl ? sourcePlatform(postingUrl) : null), [postingUrl]);

  if (!platform || !now) {
    return (
      <span className="text-faint" title={platform ? undefined : t("delivery.noSource")}>
        —
      </span>
    );
  }

  const window = windowAt(platform, now);
  const level = window.level as DeliveryLevel;

  // 悬停依据与报告详情页单平台条同口径：正在黄金给「当前窗口几点到几点」，
  // 否则给下一段黄金；未来 7 天没有窗口就如实说，不编时间。
  let title = t("delivery.nextNone");
  if (level === "best") {
    title = t("delivery.windowNow", {
      start: formatMinutes(window.start),
      end: formatMinutes(window.end),
    });
  } else {
    const next = nextWindow(platform, now, { levels: ["best"] });
    if (next) {
      const time = formatMinutes(next.startMin);
      const when =
        next.dayOffset === 0
          ? t("delivery.when.today", { time })
          : next.dayOffset === 1
            ? t("delivery.when.tomorrow", { time })
            : t("delivery.when.other", {
                weekday: t(`delivery.weekday.${WEEKDAY_KEYS[next.start.getDay()]}`),
                time,
              });
      title = t("delivery.next", { when });
    }
  }

  return (
    <Badge tone={LEVEL_TONE[level]} title={title}>
      {t("delivery.chip", {
        platform: t(`delivery.platform.${platform}`),
        level: t(`delivery.level.${level}`),
      })}
    </Badge>
  );
}

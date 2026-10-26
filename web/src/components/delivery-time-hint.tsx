"use client";

import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatMinutes, summarize } from "@/lib/delivery-window.mjs";
import type { DeliveryAction, DeliveryLevel, DeliverySummary } from "@/lib/delivery-window.mjs";
import { useI18n } from "@/lib/i18n/context";

// 星期索引 → i18n 键后缀，与 Date.getDay() 对齐（0 = 周日）。
const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

// 等级与全局结论都复用既有语义色：good = 该投，warn = 别投，muted = 可以但非最佳。
// 品牌橙留给「选中/激活」，不参与等级编码。
// 导出给管道页的「投递时机」行级列复用（ADR-0085 修订）：等级 → 语义色只有这一处口径。
export const LEVEL_TONE: Record<DeliveryLevel, "good" | "muted" | "warn"> = {
  best: "good",
  ok: "muted",
  avoid: "warn",
};
const ACTION_TONE: Record<DeliveryAction, "good" | "muted" | "warn"> = {
  send: "good",
  ok: "muted",
  wait: "warn",
};

// 矩阵粒度是半小时，30 秒足够「到点即换结论」，也不至于空转。
const TICK_MS = 30_000;

/**
 * 管道页/报告详情页常驻的「投递时机」条（Kaneo CO-44 / ADR-0085）。
 *
 * `platforms` 传了值就只看这几个平台——报告详情页据此传该报告来源平台（
 * BOSS直聘 → ["boss"]），不再拿三平台的平均口径去套一份猎聘的职位；
 * 传空数组（来源不在三平台）时只说「没有已知规律」，不编。不传 = 全平台，
 * 即列表页的「今天该投哪些」视角。
 *
 * 时钟只在浏览器里算：服务端首帧渲染同高占位，避免 hydration 文案不一致，
 * 也避免这一行「算出来了才出现」把下面的表格顶开（ADR-0039 槽位原则）。
 */
export function DeliveryTimeHint({ platforms }: { platforms?: string[] }) {
  const { t } = useI18n();
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // 显式传了平台列表就只看它（包括空数组 → 没有可判平台）
  const summary: DeliverySummary | null = now
    ? platforms
      ? summarize(now, { platformIds: platforms })
      : summarize(now)
    : null;
  const weekdayKey = now ? WEEKDAY_KEYS[now.getDay()] : null;
  const singlePlatform = summary?.platforms.length === 1;

  return (
    <div
      className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface/50 px-3 py-2 text-xs md:shrink-0"
      title={t("delivery.tooltip")}
      aria-label={t("delivery.aria")}
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-muted">
        <Clock className="size-3.5" />
        {t("delivery.title")}
      </span>

      {summary && weekdayKey ? (
        <>
          <span className="tabular-nums text-faint">
            {t("delivery.clock", {
              weekday: t(`delivery.weekday.${weekdayKey}`),
              time: summary.clock,
            })}
          </span>

          {summary.platforms.length === 0 ? (
            // 来源不在三平台（ATS/公司官网/拉勾…）：如实说没有规律，
            // 不拿别家的时段套上去。
            <span className="text-faint">{t("delivery.noSource")}</span>
          ) : singlePlatform ? (
            // 单平台（报告详情页）：这一页只有这一个来源平台，再挂一枚
            // 「猎聘 · 可以」只是把已知信息重说一遍——只留结论与窗口。
            <>
              {/* 窗口文案紧跟时刻：先读「现在几点、窗口到几点」，再读该不该投。 */}
              <span className="text-faint">{rightText(summary, t)}</span>
              <Badge tone={ACTION_TONE[summary.action]}>{t(`delivery.verdict.${summary.action}`)}</Badge>
            </>
          ) : (
            // 多平台（列表页）：「今天该投哪些」的批量视角，三平台并列 + 右对齐下一段黄金。
            <>
              <Badge tone={ACTION_TONE[summary.action]}>{t(`delivery.verdict.${summary.action}`)}</Badge>

              <span className="flex flex-wrap items-center gap-1.5">
                {summary.platforms.map((entry) => (
                  <Badge key={entry.platform} tone={LEVEL_TONE[entry.level]}>
                    {t("delivery.chip", {
                      platform: t(`delivery.platform.${entry.platform}`),
                      level: t(`delivery.level.${entry.level}`),
                    })}
                  </Badge>
                ))}
              </span>

              <span className="ml-auto text-faint">{rightText(summary, t)}</span>
            </>
          )}
        </>
      ) : (
        // 未挂载（SSR 首帧）时的同高占位：高度与结论态一致，列表不会跳动。
        <span className="text-faint">—</span>
      )}
    </div>
  );
}

/**
 * 右侧辅助文案。分两种视角：
 *
 * - 单平台（报告详情页）：正处于黄金窗口时给「当前窗口 09:30–11:00」——
 *   用户真正想知道的是「还能投到几点」；否则给下一段黄金。
 * - 多平台（管道页）：给最早出现的那段黄金；已在窗口中则不重复，结论
 *   徽章已经说了「黄金时段」。
 *
 * 两条路都不编时间：找不到窗口时如实说「未来 7 天没有」。
 */
function rightText(
  summary: DeliverySummary,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const single = summary.platforms.length === 1 ? summary.platforms[0] : null;
  if (single && single.level === "best") {
    return t("delivery.windowNow", {
      start: formatMinutes(single.window.start),
      end: formatMinutes(single.window.end),
    });
  }

  const next = summary.nextGold;
  if (!next) return t("delivery.nextNone");
  if (next.current) return "";
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
  return t("delivery.next", { when });
}

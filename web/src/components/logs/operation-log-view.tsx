"use client";

import { useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// /logs 的呈现层。数据由 server page 从四处台账聚合好（lib/op-log.mjs），这里
// 只做筛选、分组和渲染 —— 与 pipeline / followups 同一套约定：URL 是筛选的
// 唯一真相源（可分享、可后退、刷新不丢），组件不另存一份筛选状态。
//
// 三层筛选互相联动：触发方式（全部/手动/自动）→ 类型（当前触发方式下出现的
// 类型）→ 日期（当前类型下的每日条数）。计数永远按上一层的过滤结果算，所以
// 页签上的数字和点进去看到的行数对得上。

export type OpLogMeta = { k: string; v: string };

export type OpLogEntry = {
  id: string;
  at: number;
  date: string;
  hasTime: boolean;
  trigger: "manual" | "auto";
  type: string;
  title: string;
  meta: OpLogMeta[];
  status: "done" | "failed" | null;
  durationSec: number | null;
  href: string | null;
};

type Trigger = "all" | "manual" | "auto";

const TRIGGERS: Trigger[] = ["all", "manual", "auto"];

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** meta 里的枚举值走字典，字典没有的值原样显示（不猜、不吞）。 */
const META_VALUE_KEYS: Record<string, Record<string, string>> = {
  source: {
    web: "logs.source.web",
    "set-status": "logs.source.cli",
    cli: "logs.source.cli",
    correction: "logs.source.correction",
    backfill: "logs.source.backfill",
    manual: "logs.source.manual",
    extension: "logs.source.extension",
  },
  action: {
    add: "logs.action.add",
    remove: "logs.action.remove",
    exempt: "logs.action.exempt",
    update: "logs.action.update",
    clear: "logs.action.clear",
  },
};

function parseDay(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

function clockText(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 时长：38s / 2m12s / 1h04m。与 jobs 卡片同一读法，只是这里是日志而不是卡片。 */
function durationText(sec: number | null): string | null {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return null;
  if (sec < 60) return `${Math.round(sec)}s`;
  const minutes = Math.floor(sec / 60);
  const seconds = Math.round(sec % 60);
  if (minutes < 60) return seconds ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function OperationLogView({
  entries,
  dates,
  today,
}: {
  entries: OpLogEntry[];
  /** 窗口内的日期，最新在前（含今天） */
  dates: string[];
  today: string;
}) {
  const { t, lang } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") sp.delete(k);
        else sp.set(k, v);
      }
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [params, router, pathname],
  );

  const counts = useMemo(() => {
    let manual = 0;
    let failed = 0;
    for (const e of entries) {
      if (e.trigger === "manual") manual += 1;
      if (e.status === "failed") failed += 1;
    }
    return { total: entries.length, manual, auto: entries.length - manual, failed };
  }, [entries]);

  const pTrigger = params.get("trigger");
  const trigger: Trigger = pTrigger === "manual" || pTrigger === "auto" ? pTrigger : "all";
  const underTrigger = useMemo(
    () => (trigger === "all" ? entries : entries.filter((e) => e.trigger === trigger)),
    [entries, trigger],
  );

  // 类型选项按当前触发方式动态生成：不列一条都没有的类型，切回去也不会留空。
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of underTrigger) m.set(e.type, (m.get(e.type) ?? 0) + 1);
    return m;
  }, [underTrigger]);
  const pType = params.get("type") ?? "";
  const type = typeCounts.has(pType) ? pType : "all";
  const scoped = useMemo(
    () => (type === "all" ? underTrigger : underTrigger.filter((e) => e.type === type)),
    [underTrigger, type],
  );

  const dayCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of scoped) m.set(e.date, (m.get(e.date) ?? 0) + 1);
    return m;
  }, [scoped]);

  const pDate = params.get("date") ?? "";
  const date = dates.includes(pDate) ? pDate : "all";
  const visible = useMemo(
    () => (date === "all" ? scoped : scoped.filter((e) => e.date === date)),
    [scoped, date],
  );

  const groups = useMemo(
    () =>
      dates
        .map((d) => ({ date: d, rows: visible.filter((e) => e.date === d) }))
        .filter((g) => g.rows.length > 0),
    [dates, visible],
  );

  const dayLabel = (d: string): string => {
    if (d === today || d === dates[0]) return t("logs.today");
    if (dates[1] && d === dates[1]) return t("logs.yesterday");
    const { m, d: dom } = parseDay(d);
    return lang === "zh" ? `${m}月${dom}日` : `${MONTHS_EN[m - 1]} ${dom}`;
  };

  const weekday = (d: string): string => {
    const { y, m, d: dom } = parseDay(d);
    const w = new Date(y, m - 1, dom).getDay();
    return lang === "zh" ? WEEKDAYS_ZH[w] : WEEKDAYS_EN[w];
  };

  const metaLabel = (k: string): string => {
    const key = `logs.meta.${k}`;
    const label = t(key);
    return label === key ? k : label;
  };
  const metaValue = (k: string, v: string): string => {
    const key = META_VALUE_KEYS[k]?.[v];
    return key ? t(key) : v;
  };

  const triggerLabel = (trig: Trigger): string => t(`logs.trigger.${trig}`);

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">{t("logs.title")}</h1>
      <p className="mt-1 text-sm text-muted tabular-nums">
        {t("logs.summary", { total: counts.total, manual: counts.manual, auto: counts.auto, failed: counts.failed })}
      </p>

      <div className="mt-6 flex flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5">
            {TRIGGERS.map((trig) => {
              const n = trig === "all" ? counts.total : trig === "manual" ? counts.manual : counts.auto;
              const on = trig === trigger;
              return (
                <button
                  key={trig}
                  type="button"
                  onClick={() => setParams({ trigger: trig === "all" ? null : trig, type: null })}
                  aria-pressed={on}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs transition-colors",
                    on ? "bg-surface-hover font-medium text-foreground" : "text-muted hover:text-foreground",
                  )}
                >
                  {triggerLabel(trig)}
                  <span className={cn("font-mono text-[11px] tabular-nums", on ? "text-brand-text" : "text-faint")}>{n}</span>
                </button>
              );
            })}
          </div>
          <span className="flex-1" />
          <select
            aria-label={t("logs.typeAll")}
            value={type}
            onChange={(e) => setParams({ type: e.target.value === "all" ? null : e.target.value })}
            className="cursor-pointer rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground"
          >
            <option value="all">{t("logs.typeAll")}</option>
            {[...typeCounts.entries()]
              .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
              .map(([key, n]) => (
                <option key={key} value={key}>
                  {t(`logs.type.${key}`)} · {n}
                </option>
              ))}
          </select>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => setParams({ date: null })}
            aria-pressed={date === "all"}
            className={cn(
              "inline-flex cursor-pointer items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              date === "all"
                ? "border-brand bg-brand-soft font-medium text-foreground"
                : "border-border bg-surface text-muted hover:bg-surface-hover",
            )}
          >
            {t("logs.windowAll")}
            <span className={cn("font-mono text-[11px] tabular-nums", date === "all" ? "text-brand-text" : "text-faint")}>
              {scoped.length}
            </span>
          </button>
          {dates.map((d) => {
            const on = d === date;
            return (
              <button
                key={d}
                type="button"
                onClick={() => setParams({ date: d })}
                aria-pressed={on}
                className={cn(
                  "inline-flex cursor-pointer items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
                  on
                    ? "border-brand bg-brand-soft font-medium text-foreground"
                    : "border-border bg-surface text-muted hover:bg-surface-hover",
                )}
              >
                <span className={cn(d === dates[0] && "font-medium")}>{dayLabel(d)}</span>
                <span className={cn("font-mono text-[11px] tabular-nums", on ? "text-brand-text" : "text-faint")}>
                  {dayCounts.get(d) ?? 0}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="mt-6 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
          <p className="text-sm font-medium text-foreground">
            {date === "all" ? t("logs.emptyWindow") : t("logs.emptyDay", { date: dayLabel(date) })}
          </p>
          <p className="mt-1.5 text-xs text-muted">{t("logs.emptyHint")}</p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-6">
          {groups.map((g) => (
            <section key={g.date}>
              <div className="flex items-baseline gap-2">
                <span className="text-[13px] font-semibold text-foreground">{dayLabel(g.date)}</span>
                <span className="text-xs text-faint">{weekday(g.date)}</span>
                <span className="ml-auto font-mono text-[11.5px] text-faint tabular-nums">
                  {t("logs.groupCount", { n: g.rows.length })}
                </span>
              </div>
              <ul className="mt-2 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
                {g.rows.map((e) => {
                  const meta = e.meta
                    .map((m) => `${metaLabel(m.k)} ${metaValue(m.k, m.v)}`)
                    .join(" · ");
                  const dur = durationText(e.durationSec);
                  const body = (
                    <>
                      <span className="hidden w-11 shrink-0 font-mono text-xs text-faint tabular-nums md:block">
                        {e.hasTime ? clockText(e.at) : "—"}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 rounded-md px-2 py-0.5 text-[11.5px]",
                          e.trigger === "manual"
                            ? "bg-sky-500/15 text-sky-700 dark:text-sky-400"
                            : "bg-brand-soft text-brand-text",
                        )}
                      >
                        {t(`logs.type.${e.type}`)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] text-foreground">{e.title || t(`logs.type.${e.type}`)}</span>
                        {meta && <span className="mt-0.5 block truncate text-xs text-muted">{meta}</span>}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        {e.status && (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 text-[11.5px]",
                              e.status === "done"
                                ? "text-emerald-700 dark:text-emerald-400"
                                : "text-red-700 dark:text-red-400",
                            )}
                          >
                            <span className="size-1.5 rounded-full bg-current" />
                            {t(e.status === "done" ? "logs.state.done" : "logs.state.failed")}
                          </span>
                        )}
                        {dur && <span className="font-mono text-[11.5px] text-faint tabular-nums">{dur}</span>}
                        {e.href && <ChevronRight className="size-3.5 text-faint" />}
                      </span>
                    </>
                  );
                  const rowCls = "flex items-center gap-3 px-4 py-2.5";
                  return (
                    <li key={e.id}>
                      {e.href ? (
                        <Link href={e.href} className={cn(rowCls, "transition-colors hover:bg-surface")}>
                          {body}
                        </Link>
                      ) : (
                        <div className={rowCls}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      <p className="mt-5 text-[11.5px] leading-relaxed text-faint">{t("logs.note")}</p>
    </div>
  );
}

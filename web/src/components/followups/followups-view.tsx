"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, CalendarClock, ChevronDown, ChevronRight, Loader2, Mail, NotebookPen, Pin, Search, Snowflake, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CompanyLogo } from "@/components/company-logo";
import { LogDialog } from "@/components/followups/log-dialog";
import { NextDateDialog } from "@/components/followups/next-date-dialog";
import { StatusPill } from "@/components/followups/status-pill";
import { scoreTone } from "@/lib/format";
import { channelLabel } from "@/lib/followup-channel.mjs";
import { statusI18nKey } from "@/lib/followups";
import { describeStatusWriteError, offlineStatusWriteError } from "@/lib/status-write-error.mjs";
import {
  type CadenceEntry,
  type CadenceMetadata,
  type Urgency,
  daysHeatClass,
  oxfordJoin,
  urgencyRank,
  urgencyTone,
} from "@/lib/followups";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// The /followups tracker: WHO needs a nudge today, HOW urgent, WHEN the next
// touch is due, and the permanent history of every follow-up sent. The verdict
// is the core's followup-cadence.mjs (via /api/followups?full=1) — this view
// only filters, sorts, and records.

const URGENCY_TABS = ["ALL", "OVERDUE", "URGENT", "WAITING", "COLD"] as const;

const COLUMNS = [
  { key: "company" },
  { key: "role" },
  { key: "score" },
  { key: "status" },
  { key: "urgency" },
  { key: "days" },
  { key: "next" },
  { key: "count" },
  { key: "since" },
  { key: "silence" },
] as const;
type SortKey = (typeof COLUMNS)[number]["key"];
const SORT_KEYS = COLUMNS.map((c) => c.key);

/** Sortable value per column; null means "always last, either direction". */
function sortVal(e: CadenceEntry, key: SortKey): string | number | null {
  switch (key) {
    case "company":
      return e.company.toLowerCase();
    case "role":
      return e.role.toLowerCase();
    case "score": {
      const m = e.score?.match(/(\d+(?:\.\d+)?)/);
      return m ? parseFloat(m[1]) : null;
    }
    case "status":
      return e.status;
    case "urgency":
      // Severity, not alphabetical: negate rank so DESCENDING (▼, the first
      // click) puts the most pressing first — matching how the ▼ glyph reads.
      return -urgencyRank(e.urgency);
    case "days":
      return e.daysSinceApplication;
    case "next":
      return e.daysUntilNext;
    case "count":
      return e.followupCount;
    case "since":
      return e.daysSinceLastFollowup;
    case "silence":
      return e.silenceDays ?? null;
  }
}

type CadenceResponse = {
  available: boolean;
  metadata: CadenceMetadata | null;
  entries: CadenceEntry[];
  /** 引擎生效的 cadence 配置（含 freeze_threshold_days）；旧引擎可能缺省。 */
  cadenceConfig?: { freeze_threshold_days?: number } | null;
};

/** 撤销窗口兜底：API 返回 cadenceConfig 前的默认值（与引擎 DEFAULT_CADENCE 一致）。 */
const FREEZE_THRESHOLD_FALLBACK = 14;

export function FollowupsView() {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [data, setData] = useState<CadenceResponse | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [dialogFor, setDialogFor] = useState<CadenceEntry | null>(null);
  const [pinFor, setPinFor] = useState<CadenceEntry | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Inline status edit (ADR-0077): the undo toast. The write itself is always
  // real (POST /api/status), undo included — status-log records both legs.
  const [statusToast, setStatusToast] = useState<{
    n: number;
    company: string;
    from: string;
    to: string;
    seq: number;
  } | null>(null);

  useEffect(() => {
    if (!statusToast) return;
    const timer = setTimeout(() => setStatusToast(null), 5000);
    return () => clearTimeout(timer);
  }, [statusToast]);

  const refetch = useCallback(() => {
    fetch("/api/followups?full=1")
      .then((r) => r.json())
      .then((d: CadenceResponse) => setData(d))
      .catch(() => setData({ available: false, metadata: null, entries: [] }));
  }, []);
  useEffect(refetch, [refetch]);

  // URL is the source of truth for tab/sort/dir (Pipeline convention); search
  // stays local for snappy typing, seeded from the URL. No sort param → the
  // engine's own order (most pressing first) and all headers show ⇅.
  const pTab = (params.get("urgency") ?? "").toUpperCase();
  const tab: string =
    pTab === "FREEZE" || (URGENCY_TABS as readonly string[]).includes(pTab) ? pTab : "ALL";
  const pSort = params.get("sort") ?? "";
  const sortKey: SortKey | null = (SORT_KEYS as readonly string[]).includes(pSort) ? (pSort as SortKey) : null;
  const dir = (params.get("dir") === "-1" ? -1 : 1) as 1 | -1;

  const [q, setQ] = useState(params.get("q") ?? "");
  const lastUrlQ = useRef(params.get("q") ?? "");
  useEffect(() => {
    const urlQ = params.get("q") ?? "";
    if (urlQ !== lastUrlQ.current) {
      lastUrlQ.current = urlQ;
      setQ(urlQ);
    }
  }, [params]);

  const setParams = useCallback(
    (updates: Record<string, string | number | null>) => {
      const sp = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v == null || v === "") sp.delete(k);
        else sp.set(k, String(v));
      }
      const qs = sp.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
    },
    [params, router, pathname],
  );

  // 冻结判定字段由引擎单点输出（ADR-0079 决策 1），前端只消费不复算。
  const entries = data?.available ? data.entries : [];
  const meta = data?.available ? data.metadata : null;
  const freezeThreshold = data?.cadenceConfig?.freeze_threshold_days ?? FREEZE_THRESHOLD_FALLBACK;

  const [freezeFor, setFreezeFor] = useState<CadenceEntry | null>(null);
  // 冻结成功 toast：撤销窗口 10s（比 ADR-0077 改状态 5s 加重——冻结是更重的决策）。
  const [freezeToast, setFreezeToast] = useState<{
    n: number;
    company: string;
    from: string; // 原状态（引擎规范小写值），撤销时真实写回
    reason: string;
    seq: number;
  } | null>(null);
  useEffect(() => {
    if (!freezeToast) return;
    const timer = setTimeout(() => setFreezeToast(null), 10000);
    return () => clearTimeout(timer);
  }, [freezeToast]);

  const filtering = tab !== "ALL" || q.trim().length > 0;
  const filtered = useMemo(() => {
    let rows = entries;
    if (tab === "FREEZE") rows = rows.filter((e) => e.freezeSuggested);
    else if (tab !== "ALL") rows = rows.filter((e) => e.urgency.toUpperCase() === tab);
    if (q.trim()) {
      const needle = q.toLowerCase();
      rows = rows.filter((e) => `${e.company} ${e.role}`.toLowerCase().includes(needle));
    }
    if (!sortKey) return rows; // engine order: most pressing first
    return [...rows].sort((a, b) => {
      const av = sortVal(a, sortKey);
      const bv = sortVal(b, sortKey);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last, either direction
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return ((av as number) - (bv as number)) * dir;
    });
  }, [entries, tab, q, sortKey, dir]);

  // 冻结确认 = 真实写 Discarded（唯一写门：POST /api/status → set-status.mjs，
  // status-log 留痕）；成功后 refetch 让行自然离开列表，10s 内可撤销。
  const handleFreezeConfirm = async (entry: CadenceEntry, reason: string) => {
    setFreezeFor(null);
    setActionError(null);
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: String(entry.num), status: "Discarded", note: reason }),
      });
      if (!res.ok) {
        const err = describeStatusWriteError(res.status, await res.json().catch(() => null));
        setActionError(t(err.key, err.detail ? { detail: err.detail } : undefined));
        return;
      }
      setFreezeToast((prev) => ({
        n: entry.num,
        company: entry.company,
        from: entry.status,
        reason,
        seq: (prev?.seq ?? 0) + 1,
      }));
      refetch();
    } catch {
      const err = offlineStatusWriteError();
      setActionError(t(err.key));
    }
  };

  // ADR-0077: inline status edit callbacks handed down to each row's StatusPill.
  const statusText = (s: string) => {
    const key = statusI18nKey(s);
    return key ? t(key) : s;
  };
  const handleStatusChange = (entry: CadenceEntry, to: string, from: string) => {
    setStatusToast((prev) => ({
      n: entry.num,
      company: entry.company,
      from: statusText(from),
      to: statusText(to),
      seq: (prev?.seq ?? 0) + 1,
    }));
    refetch(); // cadence re-folds: the row may leave the tracker (non-actionable state)
  };

  const handleStatusError = (err: { key: string; detail?: string }) => {
    setActionError(t(err.key, err.detail ? { detail: err.detail } : undefined));
  };

  // Undo = a second real write back to the previous state (never a memory-only
  // revert — the list refetches and must agree with the data layer).
  // clearNote（ADR-0079）：撤销冻结时一并移除当初追加的原因段，恢复冻结前原状。
  const undoStatus = async (n: number, from: string, clearNote?: string) => {
    setStatusToast(null);
    setActionError(null);
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: String(n), status: from, ...(clearNote ? { clearNote } : {}) }),
      });
      if (!res.ok) {
        const err = describeStatusWriteError(res.status, await res.json().catch(() => null));
        setActionError(t(err.key, err.detail ? { detail: err.detail } : undefined));
      }
    } catch {
      const err = offlineStatusWriteError();
      setActionError(t(err.key));
    }
    refetch();
  };

  const removeLogged = async (num: number) => {
    setActionError(null);
    try {
      const res = await fetch("/api/followups/log", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ num }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setActionError(typeof j.error === "string" ? `Couldn't remove the follow-up: ${j.error}` : t("followups.removeError"));
      }
    } catch {
      setActionError(t("followups.removeError"));
    }
    refetch();
  };

  const toggleExpand = (num: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });

  const subtitle = !data ? (
    <span className="inline-flex items-center gap-1.5">
      <Loader2 className="size-3.5 animate-spin" /> {t("followups.computing")}
    </span>
  ) : !data.available || !meta ? (
    t("followups.unavailable")
  ) : (
    <>
      <span className="tabular-nums">{meta.actionable}</span>
      {t("followups.subtitleActive")}
      <span className="tabular-nums">{meta.urgent}</span>
      {t("followups.subtitleUrgent")}
      <span className="tabular-nums">{meta.overdue}</span>
      {t("followups.subtitleOverdue")}
    </>
  );

  return (
    <div className="mx-auto max-w-none px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">{t("followups.title")}</h1>
          <p className="mt-1 text-sm text-muted">{subtitle}</p>
        </div>
        <div className="relative w-56 max-w-[35vw]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("followups.searchPlaceholder")}
            className="w-full rounded-md border border-border bg-surface/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
          />
        </div>
      </div>

      {meta && !filtering && <NarrativeCard meta={meta} entries={entries} />}

      {/* urgency filter（「建议冻结」tab 常驻，计数随引擎判定走） */}
      <div className="mt-6 flex flex-wrap gap-1 border-b border-border">
        {[...URGENCY_TABS, "FREEZE"].map((tabKey) => {
          const count =
            tabKey === "ALL"
              ? entries.length
              : tabKey === "FREEZE"
                ? entries.filter((e) => e.freezeSuggested).length
                : entries.filter((e) => e.urgency.toUpperCase() === tabKey).length;
          return (
            <button
              key={tabKey}
              onClick={() => setParams({ urgency: tabKey === "ALL" ? null : tabKey })}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors",
                tab === tabKey ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
              )}
            >
              {tabKey === "FREEZE" ? (
                <>❄ {t("followups.freezeTab")}</>
              ) : (
                t(`followups.tab.${tabKey.toLowerCase()}`)
              )}{" "}
              <span className="text-faint tabular-nums">{count}</span>
            </button>
          );
        })}
      </div>

      {actionError && <p className="mt-3 text-xs text-red-500">{actionError}</p>}

      {!data ? null : !data.available ? (
        <EmptyPanel title={t("followups.unavailable")} body={t("followups.emptyCadenceBody")} />
      ) : filtered.length === 0 ? (
        filtering ? (
          <EmptyPanel title={t("followups.emptyNoMatches")} body={t("followups.emptyNoMatchesBody")} />
        ) : (
          <EmptyPanel title={t("followups.emptyNothing")} body={t("followups.emptyNothingBody")} />
        )
      ) : (
        <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[1020px] text-sm">
            <thead className="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
              <tr>
                 <th className="w-8 px-2 py-2.5" aria-label={t("followups.expandColAria")} />
                 {/* 报告号列：纯展示，不参与排序（tracker# 即报告文件名前缀），置于公司列前。 */}
                 <th className="whitespace-nowrap px-2.5 py-2.5 font-medium">{t("followups.col.reportNo")}</th>
                 {COLUMNS.map((c) => {
                   const active = sortKey === c.key;
                   return (
                     <th key={c.key} aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"} className="px-2.5 py-2.5 font-medium">
                       <button
                         type="button"
                         title={t(`followups.colHint.${c.key}`)}
                         className="inline-flex cursor-pointer select-none items-center gap-1 uppercase tracking-wide hover:text-foreground"
                         onClick={() =>
                           // First click on Urgency descends (most pressing first —
                           // how ▼ reads); other columns start ascending.
                           setParams({ sort: c.key, dir: active ? dir * -1 : c.key === "urgency" ? -1 : 1 })
                         }
                       >
                         {t(`followups.col.${c.key}`)}
                        <span aria-hidden="true" className={cn(!active && "text-faint")}>
                          {active ? (dir === 1 ? "▲" : "▼") : "⇅"}
                        </span>
                      </button>
                    </th>
                  );
                })}
                <th className="px-2.5 py-2.5 font-medium">{t("followups.col.action")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((e) => (
                <FollowupRow
                  key={e.num}
                  entry={e}
                  expanded={expanded.has(e.num)}
                  onToggle={() => toggleExpand(e.num)}
                  onLog={() => setDialogFor(e)}
                  onPin={() => setPinFor(e)}
                  onRemove={removeLogged}
                  onStatusChange={(to, from) => handleStatusChange(e, to, from)}
                  onStatusError={handleStatusError}
                  onFreeze={() => setFreezeFor(e)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialogFor && <LogDialog entry={dialogFor} onClose={() => setDialogFor(null)} onLogged={refetch} />}
      {pinFor && <NextDateDialog entry={pinFor} onClose={() => setPinFor(null)} onChanged={refetch} />}
      {freezeFor && (
        <FreezeDialog
          entry={freezeFor}
          threshold={freezeThreshold}
          onClose={() => setFreezeFor(null)}
          onConfirm={handleFreezeConfirm}
        />
      )}

      {statusToast && (
        <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
          <div
            role="status"
            className="inline-flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 text-sm shadow-lg"
          >
            <span className="text-muted">
              {t("followups.statusChanged", {
                company: statusToast.company,
                from: statusToast.from,
                to: statusToast.to,
              })}
            </span>
            <button
              type="button"
              onClick={() => undoStatus(statusToast.n, statusToast.from)}
              className="text-xs font-medium text-brand transition-colors hover:underline"
            >
              {t("followups.statusUndo")}
            </button>
          </div>
        </div>
      )}

      {/* 冻结成功 toast（10s 撤销窗口；与 ADR-0077 状态 toast 错开高度） */}
      {freezeToast && (
        <div className="fixed inset-x-0 bottom-20 z-40 flex justify-center px-4">
          <div
            role="status"
            className="inline-flex items-center gap-3 rounded-full border border-sky-400/40 bg-surface px-4 py-2 text-sm shadow-lg"
          >
            <span className="text-muted">
              {t("followups.freezeToast", {
                company: freezeToast.company,
                num: freezeToast.n,
                reason: freezeToast.reason,
              })}
            </span>
            <button
              type="button"
              onClick={() => {
                const { n, from, reason } = freezeToast;
                setFreezeToast(null);
                undoStatus(n, from, reason);
              }}
              className="text-xs font-medium text-sky-600 transition-colors hover:underline dark:text-sky-400"
            >
              {t("followups.statusUndo")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The one-sentence "what to do first" card — only when something is due and no
 *  filter narrows the view (spec: hidden while any filter/search is active). */
function NarrativeCard({ meta, entries }: { meta: CadenceMetadata; entries: CadenceEntry[] }) {
  const { t } = useI18n();
  const due = meta.overdue + meta.urgent;
  if (due <= 0) return null;

  const pressing = [...entries]
    .filter((e) => e.urgency === "overdue" || e.urgency === "urgent")
    .sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency) || b.daysSinceApplication - a.daysSinceApplication)
    .slice(0, 4);

  const parts: string[] = [];
  if (meta.overdue > 0) parts.push(t("followups.narrativeOverdue", { n: meta.overdue }));
  if (meta.urgent > 0) parts.push(t("followups.narrativeUrgent", { n: meta.urgent }));
  if (pressing.length > 0) {
    const list = oxfordJoin(pressing.map((e) => t("followups.narrativeCompany", { company: e.company, num: e.num })));
    parts.push(t("followups.narrativePressing", { list }));
    const days = pressing.map((e) => e.daysSinceApplication);
    const max = Math.max(...days);
    parts.push(
      days.every((d) => d === max)
        ? t("followups.narrativeAllDays", { n: max })
        : t("followups.narrativeUpToDays", { n: max }),
    );
  }

  return (
    <div
      className={cn(
        "mt-5 rounded-xl border border-border border-l-4 bg-surface/40 px-4 py-3 text-sm text-muted",
        meta.overdue > 0 ? "border-l-red-500" : "border-l-amber-500",
      )}
    >
      {parts.join(" — ")}
    </div>
  );
}

function FollowupRow({
  entry: e,
  expanded,
  onToggle,
  onLog,
  onPin,
  onRemove,
  onStatusChange,
  onStatusError,
  onFreeze,
}: {
  entry: CadenceEntry;
  expanded: boolean;
  onToggle: () => void;
  onLog: () => void;
  onPin: () => void;
  onRemove: (num: number) => void;
  onStatusChange: (to: string, from: string) => void;
  onStatusError: (err: { key: string; detail?: string }) => void;
  onFreeze: () => void;
}) {
  const { t } = useI18n();
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <tr className="group transition-colors hover:bg-surface/40">
        <td className="px-2 py-3">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={t("followups.rowHistoryAria", {
              action: t(expanded ? "followups.hide" : "followups.show"),
              company: e.company,
            })}
            className="rounded p-1 text-faint transition hover:text-foreground"
          >
            <Chevron className="size-4" />
          </button>
        </td>
        {/* 报告号：tracker# = 报告文件名前缀，与 /pipeline/{num} 详情页同号。 */}
        <td className="whitespace-nowrap px-2.5 py-3 text-faint tabular-nums">#{e.num}</td>
        <td className="px-2.5 py-3 font-medium">
          {e.reportPath ? (
            <Link href={`/pipeline/${e.num}`} className="flex items-center gap-2.5 transition-colors group-hover:text-brand">
              <CompanyLogo name={e.company} size={20} />
              {e.company}
            </Link>
          ) : (
            <span className="flex items-center gap-2.5">
              <CompanyLogo name={e.company} size={20} />
              {e.company}
            </span>
          )}
        </td>
        <td className="max-w-56 truncate px-2.5 py-3 text-muted">{e.role}</td>
        <td className="px-2.5 py-3">
          <Badge tone={scoreTone(e.score)}>{e.score || "—"}</Badge>
        </td>
        <td className="min-w-24 whitespace-nowrap px-2.5 py-3">
          {/* ADR-0077: the status badge IS the write control — click to change
              state inline (same gate as the report page's StatusSelect). */}
          <StatusPill n={String(e.num)} status={e.status} onStatusChange={onStatusChange} onError={onStatusError} />
        </td>
        <td className="px-2.5 py-3">
          <Badge tone={urgencyTone(e.urgency)}>{t(`followups.urgency.${e.urgency}`)}</Badge>
        </td>
        <td className={cn("px-2.5 py-3 tabular-nums", daysHeatClass(e.daysSinceApplication))}>{e.daysSinceApplication}</td>
        <td className="whitespace-nowrap px-2.5 py-3">
          {e.daysUntilNext == null ? (
            <span className="text-faint">—</span>
          ) : (
            /* 纯数字紧凑样式：负数=已过期（红 + 细箭头指向过去），正数=未来天数；
               绝对日期悬停可见（title）。 */
            <span
              className={cn(
                "inline-flex items-center gap-0.5 tabular-nums",
                e.daysUntilNext < 0 ? "font-medium text-red-600 dark:text-red-400" : "text-muted",
              )}
              title={e.nextFollowupDate ?? undefined}
            >
              {e.daysUntilNext < 0 && <ArrowLeft className="size-3" aria-hidden />}
              {Math.abs(e.daysUntilNext)}
            </span>
          )}
          {e.nextOverride && (
              <span
               className="ml-1.5 inline-flex align-[-1px]"
               title={t("followups.pinnedTitle", { date: e.nextOverride ?? "" })}
               aria-label={t("followups.pinnedAria")}
             >
              <Pin className="size-3 text-brand" />
            </span>
          )}
        </td>
        <td className="px-2.5 py-3 tabular-nums">{e.followupCount}</td>
        <td className={cn("px-2.5 py-3 tabular-nums", daysHeatClass(e.daysSinceLastFollowup))}>
          {e.daysSinceLastFollowup == null ? <span className="text-faint">—</span> : e.daysSinceLastFollowup}
        </td>
        {/* career-ops-49：沉默天数 + 冻结判定（❄ 仅「已读不回且达阈值」时出现，悬停看全称） */}
        <td className="px-2.5 py-3">
          {e.silenceDays == null ? (
            <span className="text-faint">—</span>
          ) : e.freezeSuggested ? (
            <span
              className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-300"
              title={t("followups.freezeBadge")}
            >
              <Snowflake className="size-3.5" aria-label={t("followups.freezeBadge")} />
              <span className="tabular-nums">{e.silenceDays}</span>
            </span>
          ) : e.readState === "unread" ? (
            <span className="inline-flex items-center gap-1 text-faint" title={t("followups.unreadHint")}>
              <Mail className="size-3.5" aria-label={t("followups.unreadHint")} />
              <span className="tabular-nums">{e.silenceDays}</span>
            </span>
          ) : (
            <span className="tabular-nums">{e.silenceDays}</span>
          )}
        </td>
        <td className="whitespace-nowrap px-2.5 py-3">
          <span className="inline-flex items-center gap-0.5">
              <button
              type="button"
              onClick={onLog}
              title={t("followups.logTitle")}
              aria-label={t("followups.logTitle")}
              className="rounded-md p-1 text-faint transition-colors hover:bg-brand-soft hover:text-brand"
            >
              <NotebookPen className="size-3.5" />
            </button>
             <button
               type="button"
               onClick={onPin}
               title={e.nextOverride ? t("followups.pinnedChangeTitle", { date: e.nextOverride }) : t("followups.pinTitle")}
              className={cn(
                "rounded-md p-1 transition-colors hover:bg-brand-soft hover:text-brand",
                e.nextOverride ? "text-brand" : "text-faint",
              )}
            >
              <CalendarClock className="size-3.5" />
            </button>
            {e.freezeSuggested && (
              <button
                type="button"
                onClick={onFreeze}
                title={t("followups.freezeAction")}
                aria-label={t("followups.freezeAction")}
                className="rounded-md p-1.5 text-sky-700 transition-colors hover:bg-sky-400/10 hover:text-sky-500 dark:text-sky-300"
              >
                <Snowflake className="size-3.5" />
              </button>
            )}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-surface/30">
          <td colSpan={COLUMNS.length + 3} className="px-4 py-3">
            <HistoryPanel entry={e} onRemove={onRemove} />
          </td>
        </tr>
      )}
    </>
  );
}

function HistoryPanel({ entry: e, onRemove }: { entry: CadenceEntry; onRemove: (num: number) => void }) {
  const { t } = useI18n();
  // Tolerate an older core engine (CAREER_OPS_ROOT can point at a separate
  // checkout whose followup-cadence.mjs predates the per-entry followups[]).
  const history = e.followups ?? [];
  return (
    <div className="space-y-2 pl-7 text-sm">
      {history.length === 0 ? (
        <p className="text-faint">{t("followups.noHistory")}</p>
      ) : (
        <ul className="space-y-1.5">
          {history.map((f, i) => (
            <li key={`${f.num ?? "b"}-${f.date}-${i}`} className="group/item flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {/* Fixed-width leading slot keeps every entry's text aligned,
                  whether or not it is deletable (legacy bullets carry no num). */}
              <span className="inline-flex w-5 shrink-0 justify-center self-center">
                {f.num != null && (
                  <button
                    type="button"
                    onClick={() => onRemove(f.num!)}
                     title={t("followups.removeTitle")}
                     aria-label={t("followups.removeAria", { date: f.date })}
                    className="rounded p-0.5 text-faint opacity-0 transition group-hover/item:opacity-100 hover:text-red-500 focus-visible:opacity-100"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </span>
              <span className="tabular-nums text-muted">{f.date}</span>
              {/* 渠道 Badge 与下拉框同一套翻译；未知值原样显示（兼容旧数据） */}
              <Badge tone="muted">{channelLabel(f.channel, t)}</Badge>
              {f.contact && <span className="text-muted">{f.contact}</span>}
              {f.notes && <span className="text-faint">{f.notes}</span>}
            </li>
          ))}
        </ul>
      )}
      {e.contacts.length > 0 && (
         <p className="text-xs text-faint">
           {t("followups.suggestedContacts")}{" "}
          {e.contacts.map((c, i) => (
            <span key={c.email}>
              {i > 0 && ", "}
              <a href={`mailto:${c.email}`} className="text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-brand">
                {c.name ? `${c.name} <${c.email}>` : c.email}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
      <p className="font-display text-lg">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted">{body}</p>
    </div>
  );
}

/* ── ADR-0079：冻结确认对话框 ─────────────────────────────────────
   签名元素：冰蓝顶边 + 证据行（最近跟进 · 已读状态 · 沉默天数 vs 阈值）
   + 原因预填（可编辑，只进确认请求）。确认 = POST /api/status 写
   Discarded（set-status 写路径，status-log 留痕），10s 内可撤销。 */
function FreezeDialog({
  entry: e,
  threshold,
  onClose,
  onConfirm,
}: {
  entry: CadenceEntry;
  threshold: number;
  onClose: () => void;
  onConfirm: (entry: CadenceEntry, reason: string) => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState(t("followups.freezeReasonPrefill", { n: e.silenceDays ?? threshold }));
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-5"
      role="dialog"
      aria-modal="true"
      aria-label={t("followups.freezeDialogAria", { company: e.company })}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div className="w-[460px] max-w-full rounded-2xl border border-border border-t-[3px] border-t-sky-400 bg-surface p-5 shadow-xl">
        <h2 className="text-lg font-medium">{t("followups.freezeDialogTitle")}</h2>
        <p className="mt-0.5 text-xs text-faint">
          {t("followups.dialogSubtitle", { company: e.company, role: e.role, num: e.num })}
        </p>
        <div className="mt-3 space-y-1 rounded-xl border border-sky-400/30 bg-sky-400/10 px-3 py-2.5 text-xs">
          <div className="flex justify-between gap-3">
            <span className="text-faint">{t("followups.freezeEvidenceLast")}</span>
            <span>{e.followups?.[0]?.date ?? "—"}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-faint">{t("followups.freezeEvidenceRead")}</span>
            <span>{t("followups.freezeEvidenceReadRead")}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-faint">{t("followups.freezeEvidenceSilence")}</span>
            <span className="tabular-nums">
              {t("followups.freezeEvidenceSilenceVal", { n: e.silenceDays ?? 0, m: threshold })}
            </span>
          </div>
        </div>
        <label htmlFor="freeze-reason" className="mt-3.5 block text-xs text-faint">
          {t("followups.freezeReasonLabel")}
        </label>
        <textarea
          id="freeze-reason"
          value={reason}
          onChange={(ev) => setReason(ev.target.value)}
          className="mt-1.5 min-h-16 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-sky-400/50"
        />
        <p className="mt-2 text-[11px] text-faint">{t("followups.freezeFineprint")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground"
          >
            {t("followups.cancel")}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(e, reason.trim())}
            className="rounded-lg bg-sky-400 px-4 py-2 text-sm font-semibold text-sky-950 transition-[filter] hover:brightness-110"
          >
            {t("followups.freezeConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

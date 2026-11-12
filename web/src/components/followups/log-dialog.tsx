"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CHANNELS, DEFAULT_CHANNEL, channelLabel } from "@/lib/followup-channel.mjs";
import { historyContacts, splitHistoryContacts } from "@/lib/followup-contacts.mjs";
import { GenerateScriptPanel } from "@/components/followups/generate-script-panel";
import { localISODate, type CadenceEntry, type Channel } from "@/lib/followups";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// "Log" — the full-fidelity FollowUp entry (date, channel enum, contact,
// notes). Appends one table row via /api/followups/log.
export function LogDialog({
  entry,
  onClose,
  onLogged,
}: {
  entry: CadenceEntry;
  onClose: () => void;
  onLogged: () => void;
}) {
  const { t } = useI18n();
  // Local day, not UTC — east of UTC toISOString() defaults to "yesterday"
  // and its max would block picking the user's actual today.
  const [date, setDate] = useState(() => localISODate());
  // 预选渠道来自纯模块的 DEFAULT_CHANNEL（当前 Platform），避免默认值散落在组件里。
  const [channel, setChannel] = useState<Channel>(DEFAULT_CHANNEL);
  const [contact, setContact] = useState(entry.contacts[0]?.email ?? "");
  const [notes, setNotes] = useState("");
  // ADR-0079 决策 5：已读/未读唯一可靠来源是人工标注；勾选 → log 行尾 [unread]。
  const [unread, setUnread] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 历史联系人：来源只有本报告已记录的跟进（entry.followups，引擎已按日期
  // 倒序），不跨报告、不新增接口。前三个常驻成 chips，其余收进下拉。
  const history = useMemo(() => historyContacts(entry.followups ?? []), [entry.followups]);
  const { visible: historyVisible, overflow: historyOverflow } = useMemo(
    () => splitHistoryContacts(history, 3),
    [history],
  );
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // datalist 同时容纳报告建议联系人与历史联系人（去重，报告里的优先带姓名），
  // 这样打字时两条来源都能命中，不必记住点过谁。
  const datalistOptions = useMemo(() => {
    const options = entry.contacts.map((c) => ({ value: c.email, label: c.name }));
    const seen = new Set(entry.contacts.map((c) => c.email.toLowerCase()));
    for (const h of history) {
      const key = h.contact.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ value: h.contact, label: null });
    }
    return options;
  }, [entry.contacts, history]);

  useEffect(() => {
    if (!showMore) return;
    const onDown = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setShowMore(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showMore]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Keep free text single-line and pipe-free BEFORE it leaves the client
  // (the API's cell() normalizes again server-side — defense in depth): the
  // log is a pipe-delimited markdown table, so `|` and newlines would break
  // the row format.
  const tableSafe = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "/").trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/followups/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appNum: entry.num,
          company: entry.company,
          role: entry.role,
          date,
          channel,
          contact: tableSafe(contact),
          notes: tableSafe(notes),
          unread,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof j.error === "string" ? j.error : t("followups.logError"));
        setSaving(false);
        return;
      }
      onLogged();
      onClose();
    } catch {
      setError(t("followups.logError"));
      setSaving(false);
    }
  };

  // chip 悬停说明：最近一次使用日期 · 渠道 · 用过几次（缺字段的旧记录自动省略）
  const contactTitle = (c: { date: string; channel: string; count: number }) =>
    [c.date, channelLabel(c.channel, t), c.count > 1 ? t("followups.historyUsedTimes", { n: c.count }) : ""]
      .filter(Boolean)
      .join(" · ");

  const inputCls =
    "w-full rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* ADR-0082：话术区默认展开后弹窗变高，矮屏需能滚动，否则底部「记录」按钮不可达。 */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("followups.logDialogAria", { company: entry.company })}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg">{t("followups.logDialogTitle")}</h2>
            <p className="mt-0.5 text-sm text-muted">
              {t("followups.dialogSubtitle", { company: entry.company, role: entry.role, num: entry.num })}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("followups.close")} className="rounded p-1 text-faint transition hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={submit} className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs font-medium text-muted">
              {t("followups.fieldDate")}
              <input type="date" required value={date} max={localISODate()} onChange={(e) => setDate(e.target.value)} className={cn(inputCls, "mt-1")} />
            </label>
            <label className="block text-xs font-medium text-muted">
              {t("followups.fieldChannel")}
              <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={cn(inputCls, "mt-1")}>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {/* 显示层翻译：数据值永远是英文规范值 */}
                    {channelLabel(c, t)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {/* 联系人不再是 <label> 包裹：内部有 chip/下拉按钮等可点控件，
              label 会把点击转给输入框。改用 htmlFor 显式关联。 */}
          <div>
            <label htmlFor={`co-contact-${entry.num}`} className="block text-xs font-medium text-muted">
              {t("followups.fieldContact")} <span className="font-normal text-faint">({t("followups.optional")})</span>
            </label>
            <input
              id={`co-contact-${entry.num}`}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              placeholder={t("followups.contactPlaceholder")}
              list={datalistOptions.length ? `co-contacts-${entry.num}` : undefined}
              className={cn(inputCls, "mt-1")}
            />
            {datalistOptions.length > 0 && (
              <datalist id={`co-contacts-${entry.num}`}>
                {datalistOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label ?? undefined}
                  </option>
                ))}
              </datalist>
            )}
            {historyVisible.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-faint">{t("followups.historyContacts")}</span>
                {historyVisible.map((c) => (
                  <button
                    key={c.contact}
                    type="button"
                    onClick={() => setContact(c.contact)}
                    title={contactTitle(c)}
                    className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-brand/40 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    <span className="truncate">{c.contact}</span>
                    {c.count > 1 && <span className="shrink-0 tabular-nums text-faint">{c.count}</span>}
                  </button>
                ))}
                {historyOverflow.length > 0 && (
                  <div className="relative" ref={moreRef}>
                    <button
                      type="button"
                      onClick={() => setShowMore((v) => !v)}
                      aria-expanded={showMore}
                      aria-controls={`co-history-more-${entry.num}`}
                      className="inline-flex cursor-pointer items-center gap-0.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted transition-colors hover:border-brand/40 hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                    >
                      {t("followups.historyMore", { n: historyOverflow.length })}
                      <ChevronDown
                        className={cn("size-3 transition-transform", showMore && "rotate-180")}
                        aria-hidden="true"
                      />
                    </button>
                    {showMore && (
                      <div
                        id={`co-history-more-${entry.num}`}
                        aria-label={t("followups.historyPickAria")}
                        className="absolute left-0 top-full z-10 mt-1 w-64 max-w-[min(16rem,calc(100vw-4rem))] rounded-lg border border-border bg-surface p-1 shadow-lg"
                      >
                        {historyOverflow.map((c) => (
                          <button
                            key={c.contact}
                            type="button"
                            onClick={() => {
                              setContact(c.contact);
                              setShowMore(false);
                            }}
                            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                          >
                            <span className="w-16 shrink-0 text-[11px] tabular-nums text-faint">{c.date || "—"}</span>
                            {c.channel && (
                              <Badge tone="muted" className="shrink-0 text-[10px] font-medium">
                                {channelLabel(c.channel, t)}
                              </Badge>
                            )}
                            <span className="truncate text-xs text-foreground">{c.contact}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <label className="block text-xs font-medium text-muted">
            {t("followups.fieldNotes")} <span className="font-normal text-faint">({t("followups.optional")})</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder={t("followups.notesPlaceholder")}
              className={cn(inputCls, "mt-1 resize-none")}
            />
          </label>
          {error && <p className="text-xs text-red-500">{error}</p>}
          <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted">
            <input
              type="checkbox"
              checked={unread}
              onChange={(e) => setUnread(e.target.checked)}
              className="size-3.5 accent-[hsl(203_52%_68%)]"
            />
            {t("followups.unreadCheckbox")}
          </label>
          {/* ADR-0080 + ADR-0082：话术区默认展开，只读模板文件 + 本行 entry；复制走剪贴板，
              不写备注、不写 follow-ups.md（用户决策「不联动」）。 */}
          <GenerateScriptPanel entry={entry} />
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted transition hover:text-foreground">
              {t("followups.cancel")}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:pointer-events-none disabled:opacity-60"
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />} {t("followups.logDialogTitle")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

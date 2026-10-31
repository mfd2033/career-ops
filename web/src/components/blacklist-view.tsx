"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Plus, Search, ShieldAlert, ShieldOff, X } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { format } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { fieldCls, fieldWrapCls } from "@/components/ui/field-styles";
import { EmptyState, ErrorBanner, Loading } from "@/components/ui/status";

type Entry = {
  company: string;
  since: string;
  scope: string;
  exemptUntil: string;
  reason: string;
  exemptActive: boolean;
  reportRefs: string[];
  reports: number;
  postings: number;
  blocked: number;
};
type Payload = { today: string; totalBlocked: number; entries: Entry[] };

export function BlacklistView() {
  const { t } = useI18n();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/blacklist")
      .then((r) => r.json())
      .then((p: Payload) => setData(p))
      .catch(() => setData({ today: "", totalBlocked: 0, entries: [] }))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const entries = data?.entries ?? [];
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) => `${e.company} ${e.reason} ${e.scope}`.toLowerCase().includes(needle));
  }, [entries, q]);
  const exempted = entries.filter((e) => e.exemptActive);
  const evidence = entries.reduce((s, e) => s + e.reports + e.postings, 0);
  const earliest = entries.length ? entries.map((e) => e.since).filter(Boolean).sort()[0] : "—";
  // 接口错误码不直接上屏：短码映射为界面文案，真正的可读消息（如后端校验提示）原样保留。
  const errText =
    err === "error" ? t("blacklist.errorGeneric") : err === "network" ? t("blacklist.errorNetwork") : err;

  async function post(method: string, body: unknown, key: string) {
    setBusy(key);
    setErr(null);
    try {
      const r = await fetch("/api/blacklist", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error || "error"); return false; }
      load();
      return true;
    } catch {
      setErr("network");
      return false;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      {/* gate stats */}
      <div className="mt-6 border-t border-dashed border-border pt-5">
        <div className="flex flex-wrap gap-x-7 gap-y-2">
          <Stat n={String(entries.length)} l={t("blacklist.statCompanies")} />
          <Stat n={String(data?.totalBlocked ?? 0)} l={t("blacklist.statBlocked")} accent />
          <Stat n={String(evidence)} l={t("blacklist.statEvidence")} />
          <Stat n={earliest} l={t("blacklist.statSince")} />
        </div>
      </div>

      {/* toolbar */}
      <div className="mt-6 flex items-center gap-3">
        <div className={cn("flex flex-1 items-center gap-2 rounded-full border border-border bg-surface px-4 py-2", fieldWrapCls)}>
          <Search className="size-4 text-faint" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("blacklist.search")}
            aria-label={t("blacklist.search")}
            className="w-full bg-transparent text-sm outline-none placeholder:text-faint"
          />
        </div>
        <button
          onClick={() => setFormOpen((v) => !v)}
          className="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
        >
          {formOpen ? <X className="size-4" /> : <Plus className="size-4" />}
          {formOpen ? t("blacklist.collapse") : t("blacklist.add")}
        </button>
      </div>

      {formOpen && <AddForm busy={busy === "add"} onAdd={(b) => post("POST", b, "add")} onCancel={() => setFormOpen(false)} />}

      {errText && <ErrorBanner className="mt-4">{errText}</ErrorBanner>}

      {exempted.length > 0 && (
        <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm">
          <span className="size-2 shrink-0 rounded-full bg-brand" />
          <span className="text-muted">{format(t("blacklist.banner"), { list: exempted.map((e) => e.company).join("、") })}</span>
        </div>
      )}

      {loading ? (
        <Loading className="mt-10" label={t("blacklist.loading")} />
      ) : entries.length === 0 ? (
        <EmptyState className="mt-6" title={t("blacklist.empty")} hint={t("blacklist.emptyHint")} />
      ) : shown.length === 0 ? (
        <EmptyState className="mt-6" title={t("blacklist.noMatch")} hint={t("blacklist.noMatchHint")} />
      ) : (
        <div className="mt-5 space-y-4">
          {shown.map((e) => (
            <Card
              key={e.company}
              entry={e}
              busy={busy === e.company}
              onExempt={(d) => {
                post("PATCH", { company: e.company, exemptUntil: d.trim() }, e.company);
              }}
              onReinstate={() => post("PATCH", { company: e.company, exemptUntil: "" }, e.company)}
              onRemove={() => post("DELETE", { company: e.company }, e.company)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ n, l, accent }: { n: string; l: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className={cn("font-display text-2xl leading-none", accent ? "text-brand-text" : "text-foreground")}>{n}</span>
      <span className="text-[11.5px] tracking-wide text-faint">{l}</span>
    </div>
  );
}

function defaultExemptDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  return d.toISOString().slice(0, 10);
}

function AddForm({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (b: unknown) => Promise<boolean>; onCancel: () => void }) {
  const { t } = useI18n();
  const [company, setCompany] = useState("");
  const [scope, setScope] = useState("company");
  const [reason, setReason] = useState("");
  const [exemptUntil, setExemptUntil] = useState("");

  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        onAdd({ company, scope, reason, exemptUntil }).then((ok) => {
          if (ok) { setCompany(""); setReason(""); setExemptUntil(""); setScope("company"); onCancel(); }
        });
      }}
      className="mt-4 rounded-xl border border-border bg-surface p-5"
    >
      <h2 className="font-display text-lg text-landing">{t("blacklist.formTitle")}</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label={t("blacklist.fieldCompany")} hint={t("blacklist.companyHint")}>
          <input required value={company} onChange={(e) => setCompany(e.target.value)} className={inputCls} />
        </Field>
        <Field label={t("blacklist.fieldScope")}>
          <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="company" className={inputCls} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label={t("blacklist.fieldReason")} hint={t("blacklist.reasonHint")}>
          <textarea required value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className={inputCls} />
        </Field>
      </div>
      <div className="mt-4">
        <Field label={t("blacklist.fieldExempt")} hint={t("blacklist.exemptHint")}>
          <input type="date" value={exemptUntil} onChange={(e) => setExemptUntil(e.target.value)} className={inputCls} />
        </Field>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button type="submit" disabled={busy} className="rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground hover:bg-brand-200 disabled:opacity-50">
          {t("blacklist.submit")}
        </button>
        <button type="button" onClick={onCancel} className="rounded-full border border-border px-4 py-2 text-sm text-muted hover:bg-surface-hover">
          {t("blacklist.cancel")}
        </button>
        <span className="text-xs text-faint">{t("blacklist.backupNote")}</span>
      </div>
    </form>
  );
}

const inputCls = `w-full rounded-lg border border-border bg-background px-3 py-2 text-sm ${fieldCls}`;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-semibold tracking-wide text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

function Card({ entry, busy, onExempt, onReinstate, onRemove }: {
  entry: Entry; busy: boolean; onExempt: (date: string) => void; onReinstate: () => void; onRemove: () => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  // 内嵌豁免编辑器：替代 window.prompt（UI 审计 2026-10-31 FAIL #12）——与全站
  // 自研弹窗/内嵌确认同一套观感，不再跳出浏览器原生对话框。
  const [exemptOpen, setExemptOpen] = useState(false);
  const [exemptDate, setExemptDate] = useState(entry.exemptUntil || defaultExemptDate());
  const expired = !entry.exemptActive && /^\d{4}-\d{2}-\d{2}$/.test(entry.exemptUntil);
  return (
    <article className={cn("rounded-xl border border-border bg-surface p-5 shadow-sm", entry.exemptActive && "border-dashed")}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-xl leading-snug">{entry.company}</h3>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[11px] font-semibold text-brand-text">{entry.scope}</span>
            <span className="rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] text-muted">{t("blacklist.sinceLabel")} {entry.since}</span>
          </div>
        </div>
        <div
          className={cn(
            "grid size-14 shrink-0 -rotate-[9deg] place-items-center rounded-full border-2 text-center",
            entry.exemptActive ? "border-dashed border-brand/50 text-brand/60" : "border-[hsl(24_78%_40%)] text-[hsl(24_78%_40%)] dark:border-brand dark:text-brand",
          )}
          aria-hidden
        >
          <div>
            <div className="font-display text-lg font-bold leading-none">{entry.exemptActive ? t("blacklist.stampExempt") : t("blacklist.stamp")}</div>
            <div className="mt-0.5 text-[7px] font-bold tracking-widest">{entry.exemptActive ? "" : "BLACKLIST"}</div>
          </div>
        </div>
      </div>

      {entry.reason && (
        <blockquote className="mt-3 border-l-[3px] border-brand pl-3.5 font-display text-[17px] italic leading-relaxed text-foreground">
          {entry.reason}
        </blockquote>
      )}

      {entry.exemptActive && (
        <p className="mt-3 rounded-lg bg-brand-soft px-3 py-1.5 text-[12.5px] text-brand-text">
          {format(t("blacklist.exemptActive"), { date: entry.exemptUntil })}
        </p>
      )}
      {expired && (
        <p className="mt-3 rounded-lg bg-surface-hover px-3 py-1.5 text-[12.5px] text-faint">
          {format(t("blacklist.exemptExpired"), { date: entry.exemptUntil })}
        </p>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-faint">
        <span>{entry.reports} {t("blacklist.reports")}</span><Sep />
        <span>{entry.blocked} {t("blacklist.blocked")}</span><Sep />
        <span>{entry.postings} {t("blacklist.postings")}</span>
        {entry.reportRefs.length > 0 && (<><Sep /><span>{t("blacklist.basis")} {entry.reportRefs.map((r) => `#${r}`).join(" ")}</span></>)}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-border pt-4">
        {entry.exemptActive ? (
          <button onClick={onReinstate} disabled={busy} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12.5px] font-semibold text-muted hover:bg-surface-hover disabled:opacity-50">
            <ShieldAlert className="size-3.5" />{t("blacklist.reinstateBtn")}
          </button>
        ) : exemptOpen ? (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              setExemptOpen(false);
              onExempt(exemptDate);
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <label htmlFor={`exempt-${entry.company}`} className="text-[12.5px] text-muted">
              {t("blacklist.exemptPrompt")}
            </label>
            <input
              id={`exempt-${entry.company}`}
              type="date"
              autoFocus
              value={exemptDate}
              onChange={(e) => setExemptDate(e.target.value)}
              className={`rounded-lg border border-border bg-background px-2 py-1 text-[12.5px] ${fieldCls}`}
            />
            <button type="submit" disabled={busy} className="rounded-full border border-border px-3.5 py-1.5 text-[12.5px] font-semibold text-muted hover:bg-surface-hover disabled:opacity-50">
              {t("blacklist.exemptSave")}
            </button>
            <button type="button" onClick={() => setExemptOpen(false)} className="rounded-full border border-border px-3.5 py-1.5 text-[12.5px] text-muted hover:bg-surface-hover">
              {t("blacklist.cancel")}
            </button>
          </form>
        ) : (
          <button onClick={() => setExemptOpen(true)} disabled={busy} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12.5px] font-semibold text-muted hover:bg-surface-hover disabled:opacity-50">
            <ShieldOff className="size-3.5" />{t("blacklist.exemptBtn")}
          </button>
        )}
        <span className="flex-1" />
        {confirming ? (
          <>
            <span className="text-[12.5px] text-muted">{t("blacklist.removeConfirm")}</span>
            <button onClick={onRemove} disabled={busy} className="rounded-full border border-red-500/45 px-3.5 py-1.5 text-[12.5px] font-semibold text-red-700 hover:bg-red-500/10 dark:text-red-400">{t("blacklist.removeConfirmBtn")}</button>
            <button onClick={() => setConfirming(false)} className="rounded-full border border-border px-3.5 py-1.5 text-[12.5px] text-muted hover:bg-surface-hover">{t("blacklist.cancel")}</button>
          </>
        ) : (
          <button onClick={() => setConfirming(true)} className="rounded-full border border-border px-3.5 py-1.5 text-[12.5px] font-semibold text-muted hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-400">{t("blacklist.removeBtn")}</button>
        )}
      </div>
    </article>
  );
}

function Sep() { return <span className="h-2.5 w-px bg-border" />; }

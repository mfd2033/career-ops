"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, Loader2, Send, TriangleAlert, X } from "lucide-react";
import { CHANNELS, DEFAULT_CHANNEL, channelLabel } from "@/lib/followup-channel.mjs";
import { AUTO_SEND_SITES, autoSiteForUrl, placeholderTokens, toSingleLine } from "@/lib/followup-auto.mjs";
import { suggestScriptIndex } from "@/lib/followup-scripts.mjs";
import { extRequest } from "@/lib/ext-bridge";
import { fieldCls } from "@/components/ui/field-styles";
import { localISODate, type CadenceEntry, type Channel } from "@/lib/followups";
import type { FollowupScriptsPayload } from "@/lib/followups-server";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

// 「自动跟进」（跟进页行操作区 ⚡）：一个弹窗两个阶段，把原先五步的
// 复制 → 打开 → 粘贴 → 发送 → 记录 收成两步——先看并改话术，确认后由扩展送进
// 招聘站聊天框发出；发完把渠道/联系人/备注/未读自动回填成一条记录。
//
// 边界（原型的「回退」小节，全部要真实实现，不许假装成功）：
//   • 只覆盖 BOSS直聘 / 猎聘 / 智联招聘；其余站点只复制 + 打开；
//   • 扩展未装/未重载 → 复制 + 打开，记录只预填渠道；
//   • 找不到对话框 / 回读校验不过 → 不报成功、不自动勾「对方未读」；
//   • 一次确认只发一条，不重试、不批量、不代投。

/** 等扩展开 tab + 注入内容脚本 + 回读校验，30s 是这串动作的合理上限。 */
const SEND_TIMEOUT_MS = 30_000;

/** 失败原因码 → i18n 键；未知码落到 unknown，不把机器码直接摆给用户看。 */
const REASON_CODES = [
  "no-url",
  "no-tab",
  "no-input",
  "no-send",
  "unknown-target",
  "input-not-registered",
  "unverified",
  "input-not-cleared",
  "no-echo",
  "input-rejected",
  "no-content-script",
  "empty-text",
  "exception",
  "ext-bridge-timeout",
];

type SendOutcome = {
  kind: "sent" | "uncertain" | "failed" | "fallback";
  reason?: string;
  /** 桥/扩展回的非原因码错误原文；原因码认不出时原样透出，不闷成「未知原因」。 */
  detail?: string;
  contact?: string;
  at?: string;
  siteLabel?: string;
};

export function AutoFollowupDialog({
  entry,
  onClose,
  onLogged,
}: {
  entry: CadenceEntry;
  onClose: () => void;
  onLogged: () => void;
}) {
  const { t } = useI18n();
  const [payload, setPayload] = useState<FollowupScriptsPayload | null>(null);
  const [text, setText] = useState("");
  const [defaultText, setDefaultText] = useState("");
  const [stage, setStage] = useState("");

  const [phase, setPhase] = useState<"confirm" | "logging">("confirm");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);

  // 记录阶段四个字段（全部可改；能自动填的都已填好）。
  const [date, setDate] = useState(() => localISODate());
  const [channel, setChannel] = useState<Channel>(DEFAULT_CHANNEL);
  const [contact, setContact] = useState(entry.contacts[0]?.email ?? "");
  const [notes, setNotes] = useState("");
  const [unread, setUnread] = useState(false);
  const [saving, setSaving] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  const postingUrl = payload?.postingUrl ?? null;
  const site = useMemo(() => (postingUrl ? autoSiteForUrl(postingUrl) : null), [postingUrl]);
  const message = toSingleLine(text);
  const missing = placeholderTokens(text);
  const siteLabel = site?.label ?? "";

  // 话术只读一次：阶段由 suggestScriptIndex 推导（与「生成话术」面板同一口径），
  // 正文逐行拼成可自由编辑的文本。读不到就留空——用户仍可自己写、可以发。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/followups/scripts?num=${entry.num}`);
        const json = (await res.json().catch(() => null)) as FollowupScriptsPayload | null;
        if (cancelled) return;
        if (!json?.available) {
          setPayload({ available: false, groups: [], scripts: [], postingUrl: json?.postingUrl ?? null });
          return;
        }
        setPayload(json);
        const idx = suggestScriptIndex(json.scripts, entry);
        const script = idx >= 0 ? json.scripts[idx] : null;
        if (!script) return;
        const joined = script.lines.map((line) => line.text).join("\n");
        setDefaultText(joined);
        setText(joined);
        setStage([script.name, script.scenario].filter(Boolean).join(" — "));
      } catch {
        if (!cancelled) setPayload({ available: false, groups: [], scripts: [], postingUrl: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !sending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  /** 剪贴板兜底：无论发送成败，话术都进剪贴板（失败时用户直接 Ctrl+V）。 */
  const copyToClipboard = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      /* 非安全上下文 / 权限被拒：不阻塞主流程，页面上还能手动复制 */
    }
  };

  /** 降级路径：扩展不在、或这行根本不是三站职位。 */
  const fallback = async () => {
    await copyToClipboard(message || text);
    if (postingUrl) window.open(postingUrl, "_blank", "noopener");
    setOutcome({ kind: "fallback" });
    setPhase("logging");
  };

  const startSend = async () => {
    if (!postingUrl || !message) return;
    setSending(true);
    setOutcome(null);
    await copyToClipboard(message);
    try {
      const res = await extRequest({ type: "followup-send", url: postingUrl, text: message }, SEND_TIMEOUT_MS);
      const status = typeof res.status === "string" ? res.status : "";
      const sent = res.ok === true && status === "sent";
      const readContact = typeof res.contact === "string" ? res.contact : "";
      const kind: SendOutcome["kind"] = sent ? "sent" : status === "uncertain" ? "uncertain" : "failed";
      // 桥自身的失败（超时、SW 没接住）只带 error，不带 reason；两个字段都读，
      // 否则那几类失败一律退化成「未知原因」，用户无从下手。认不出的错误串
      // 连同原文一起带出去（见横幅里的 detail），别再吞掉。
      const reasonCode = typeof res.reason === "string" ? res.reason : typeof res.error === "string" ? res.error : "";
      // detail 优先用扩展给的现场快照（发送失败时附的候选清单），没有就退到桥的错误串。
      const detailText =
        typeof res.detail === "string" && res.detail
          ? res.detail
          : typeof res.error === "string"
            ? res.error
            : "";
      setOutcome({
        kind,
        reason: reasonCode || undefined,
        detail: detailText || undefined,
        contact: readContact,
        at: typeof res.sentAt === "string" ? res.sentAt : undefined,
        siteLabel,
      });
      if (readContact) setContact(readContact);
      if (sent) setUnread(true); // 刚发出 → 对方必然还没读
      // 备注写实际发出去的那句（与历史跟进记录口径一致）。uncertain 也写：
      // 文字确实已经交给了页面，用户要到页面上核对的就是这一句。
      if (sent || kind === "uncertain") setNotes(message);
    } catch {
      setOutcome({ kind: "fallback" });
      window.open(postingUrl, "_blank", "noopener");
    } finally {
      setSending(false);
      setPhase("logging");
    }
  };

  const submitLog = async () => {
    setSaving(true);
    setLogError(null);
    const tableSafe = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "/").trim();
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
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLogError(typeof json.error === "string" ? json.error : t("followups.logError"));
        setSaving(false);
        return;
      }
      onLogged();
      onClose();
    } catch {
      setLogError(t("followups.logError"));
      setSaving(false);
    }
  };

  const reasonText = (code?: string) =>
    t(code && REASON_CODES.includes(code) ? `followups.autoReason.${code}` : "followups.autoReason.unknown");

  const inputCls =
    "w-full rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40";

  const canSend = Boolean(site && postingUrl && message);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !sending) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("followups.autoTitle")}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-display text-lg">{phase === "logging" ? t("followups.autoLogTitle") : t("followups.autoTitle")}</h2>
            <p className="mt-0.5 text-sm text-muted">
              {t("followups.dialogSubtitle", { company: entry.company, role: entry.role, num: entry.num })}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label={t("followups.close")}
            className="rounded p-1 text-faint transition hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>

        <Steps phase={phase} sending={sending} />

        {phase === "confirm" ? (
          <>
            <p className="rounded-md border-l-2 border-faint bg-surface-hover px-2 py-1.5 text-[11px] leading-relaxed text-muted">
              {t("followups.scriptDiscipline")}
            </p>

            {stage && <p className="mt-2 text-[11px] text-faint">{t("followups.autoStage", { stage })}</p>}

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={t("followups.autoNoScript")}
              aria-label={t("followups.autoMessageAria")}
              className={cn("mt-2 w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm leading-5", fieldCls)}
            />

            <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-faint">
              <span>{t("followups.autoPrefilled", { num: entry.num })}</span>
              <button
                type="button"
                onClick={() => setText(defaultText)}
                disabled={!defaultText || text === defaultText}
                className="cursor-pointer text-brand-text underline decoration-dotted underline-offset-2 transition-colors hover:text-brand disabled:cursor-not-allowed disabled:text-faint disabled:no-underline"
              >
                {t("followups.autoRestore")}
              </button>
            </div>

            {missing.length > 0 && (
              <p className="mt-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-1 text-[11px] leading-relaxed text-amber-700 dark:text-amber-300">
                {t("followups.autoMissingHint", { list: missing.join(" ") })}
              </p>
            )}

            <div className="mt-2 flex gap-2 rounded-lg border border-border bg-surface px-2.5 py-2 text-xs leading-relaxed text-muted">
              <Send className="mt-0.5 size-3.5 shrink-0 text-faint" aria-hidden />
              <span>
                {site ? (
                  t("followups.autoTarget", { site: site.label, host: site.host })
                ) : postingUrl ? (
                  t("followups.autoTargetOther", { sites: AUTO_SEND_SITES.map((s) => s.label).join(" / ") })
                ) : (
                  t("followups.autoNoUrl")
                )}
              </span>
            </div>

            <p className="mt-2 text-[11px] leading-relaxed text-faint">{t("followups.autoLinejoin")}</p>
            <p className="mt-1 text-[11px] leading-relaxed text-faint">{t("followups.autoFineprint")}</p>

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted transition hover:text-foreground">
                {t("followups.cancel")}
              </button>
              {canSend ? (
                <button
                  type="button"
                  onClick={startSend}
                  disabled={sending}
                  className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:pointer-events-none disabled:opacity-60"
                >
                  {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  {sending ? t("followups.autoSending") : t("followups.autoSend")}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void fallback()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
                >
                  <Copy className="size-3.5" />
                  {t("followups.autoCopyOpen")}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <OutcomeBanner outcome={outcome} reasonText={reasonText} postingUrl={postingUrl} />

            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="block text-xs font-medium text-muted">
                {t("followups.fieldChannel")}
                <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} className={cn(inputCls, "mt-1")}>
                  {CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {channelLabel(c, t)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs font-medium text-muted">
                {t("followups.fieldDate")}
                <input type="date" value={date} max={localISODate()} onChange={(e) => setDate(e.target.value)} className={cn(inputCls, "mt-1")} />
              </label>
            </div>

            <label className="mt-3 block text-xs font-medium text-muted">
              {t("followups.fieldContact")} <span className="font-normal text-faint">({t("followups.optional")})</span>
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder={t("followups.contactPlaceholder")}
                className={cn(inputCls, "mt-1")}
              />
            </label>

            <label className="mt-3 block text-xs font-medium text-muted">
              {t("followups.fieldNotes")} <span className="font-normal text-faint">({t("followups.optional")})</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder={t("followups.notesPlaceholder")}
                className={cn(inputCls, "mt-1 resize-none")}
              />
            </label>

            <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs font-medium text-muted">
              <input
                type="checkbox"
                checked={unread}
                onChange={(e) => setUnread(e.target.checked)}
                className="size-3.5 accent-[hsl(203_52%_68%)]"
              />
              {t("followups.unreadCheckbox")}
            </label>

            {logError && <p className="mt-2 text-xs text-red-500">{logError}</p>}

            <div className="mt-4 flex items-center justify-between gap-3">
              <span className="text-[11px] leading-relaxed text-faint">{t("followups.autoLogHint")}</span>
              <div className="flex shrink-0 gap-2">
                <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm text-muted transition hover:text-foreground">
                  {t("followups.autoSkip")}
                </button>
                <button
                  type="button"
                  onClick={submitLog}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:pointer-events-none disabled:opacity-60"
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
                  {t("followups.autoLogAndDone")}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 三步指示：确认话术 → 自动发送 → 记录跟进。 */
function Steps({ phase, sending }: { phase: "confirm" | "logging"; sending: boolean }) {
  const { t } = useI18n();
  const labels = [t("followups.autoStep1"), t("followups.autoStep2"), t("followups.autoStep3")];
  const stateOf = (index: number): "on" | "done" | "idle" => {
    if (phase === "logging") return index < 2 ? "done" : "on";
    if (sending) return index === 0 ? "done" : index === 1 ? "on" : "idle";
    return index === 0 ? "on" : "idle";
  };
  return (
    <div className="mt-3 flex items-center gap-2 text-[11px] text-faint">
      {labels.map((label, index) => {
        const state = stateOf(index);
        return (
          <span key={label} className="inline-flex items-center gap-2">
            {index > 0 && <span aria-hidden className="h-px w-3 bg-border" />}
            <span className={cn("inline-flex items-center gap-1", state === "on" && "font-medium text-brand-text", state === "done" && "text-muted")}>
              <span
                className={cn(
                  "inline-flex size-4 items-center justify-center rounded-full border border-border text-[10px] tabular-nums",
                  state === "on" && "border-brand bg-brand text-brand-foreground",
                  state === "done" && "border-brand bg-brand-soft text-brand-text",
                )}
              >
                {index + 1}
              </span>
              {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** 发送结果横幅：成功绿、不确定琥珀、失败红、降级中性——四种语气各不相同。 */
function OutcomeBanner({
  outcome,
  reasonText,
  postingUrl,
}: {
  outcome: SendOutcome | null;
  reasonText: (code?: string) => string;
  postingUrl: string | null;
}) {
  const { t } = useI18n();
  if (!outcome) return null;
  const time = outcome.at
    ? new Date(outcome.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const tone =
    outcome.kind === "sent"
      ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-700 dark:text-emerald-300"
      : outcome.kind === "uncertain"
        ? "border-amber-400/40 bg-amber-400/10 text-amber-700 dark:text-amber-300"
        : outcome.kind === "failed"
          ? "border-red-400/40 bg-red-400/10 text-red-600 dark:text-red-400"
          : "border-border bg-surface-hover text-muted";

  return (
    <div className={cn("mt-3 flex gap-2 rounded-lg border px-2.5 py-2 text-xs leading-relaxed", tone)}>
      {outcome.kind === "sent" ? (
        <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 space-y-0.5">
        {outcome.kind === "sent" && <p>{t("followups.autoSent", { site: outcome.siteLabel ?? "", time })}</p>}
        {outcome.kind === "uncertain" && (
          <>
            <p>{t("followups.autoUncertain")}</p>
            <p className="opacity-80">{reasonText(outcome.reason)}</p>
            <p className="opacity-80">{t("followups.autoUncertainHint")}</p>
          </>
        )}
        {outcome.kind === "failed" && <p>{t("followups.autoFailed", { reason: reasonText(outcome.reason) })}</p>}
        {outcome.detail && outcome.detail !== outcome.reason && (
          <p className="break-words font-mono text-xs opacity-70">{outcome.detail}</p>
        )}
        {outcome.kind === "fallback" && <p>{t("followups.autoFallback")}</p>}
        {postingUrl && (
          <a
            href={postingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline decoration-dotted underline-offset-2"
          >
            <ExternalLink className="size-3" aria-hidden />
            {t("followups.autoSentOpen")}
          </a>
        )}
      </div>
    </div>
  );
}

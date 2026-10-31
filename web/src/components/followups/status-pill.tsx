"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { CANONICAL_STATES } from "@/lib/format";
import { followupStatusTone, statusI18nKey } from "@/lib/followups";
import { describeStatusWriteError, offlineStatusWriteError } from "@/lib/status-write-error.mjs";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

// Inline status writeback for the /followups tracker's status cell (ADR-0077).
// Same write gate and error contract as the report page's StatusSelect
// (/api/status → set-status.mjs, ADR-0036 revert-and-say-why) but in a compact
// pill + listbox form that fits the tracker table: the shared truth is the
// dictionary (CANONICAL_STATES) and the error mapping, never the control.
// Optimistic update: the pill flips immediately, reverts on failure. Success is
// reported to the view via onStatusChange so the parent can refetch the cadence
// and show the undo toast — the write itself is always real, including undo.

type StatusWriteError = { key: string; detail?: string };

// e.status arrives lowercase ("applied") while CANONICAL_STATES are capitalized;
// canonicalize once so display, i18n and the popover's current-item check all
// agree. Unknown legacy states fall through raw.
function canonicalize(s: string): string {
  return (CANONICAL_STATES as readonly string[]).find((c) => c.toLowerCase() === s.toLowerCase()) ?? s;
}

export function StatusPill({
  n,
  status,
  onStatusChange,
  onError,
}: {
  n: string;
  status: string;
  onStatusChange: (to: string, from: string) => void;
  onError: (err: StatusWriteError) => void;
}) {
  const [status_, setStatus] = useState(() => canonicalize(status));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [popPos, setPopPos] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const [active, setActive] = useState(-1);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const { t } = useI18n();

  // The view refetches after every (un)do; when the row's status changes out
  // there — undo toast, another tab — this pill must follow the prop, not keep
  // its last optimistic value.
  useEffect(() => setStatus(canonicalize(status)), [status]);

  // Outside pointer press closes; keydown lives on the root so Esc and the
  // arrow keys work wherever focus is inside the pill + popover pair.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const options: readonly string[] = (CANONICAL_STATES as readonly string[]).includes(status_)
    ? CANONICAL_STATES
    : [status_, ...CANONICAL_STATES]; // unknown legacy state: offer it back alongside the canon

  // Roving focus: the highlighted option receives real focus so screen readers
  // follow the ↑↓ highlight (keydown bubbles to the root handler either way).
  useEffect(() => {
    if (open && active >= 0) optionRefs.current[active]?.focus({ preventScroll: true });
  }, [active, open]);

  function openMenu() {
    // Fixed positioning computed from the button's viewport rect: the table
    // wrapper is overflow-x-auto, whose clipping would cut off an absolutely
    // positioned popover — fixed escapes it. Flip upward when there isn't room
    // below (last rows).
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const roomBelow = window.innerHeight - rect.bottom;
      const up = roomBelow < 310;
      setPopPos({
        left: rect.left + rect.width / 2,
        top: up ? rect.top - 6 : rect.bottom + 6,
        up,
      });
    }
    setActive(options.indexOf(status_));
    setOpen(true);
  }

  // Any scroll (the table wrapper's included — hence capture) or resize moves
  // the anchor out from under a fixed popover; close rather than drift.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function commit(next: string) {
    setOpen(false);
    const from = status_;
    if (next === from) return;
    setStatus(next);
    setBusy(true);
    (async () => {
      try {
        const res = await fetch("/api/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ n, status: next }),
        });
        if (!res.ok) {
          setStatus(from); // revert, never silently (ADR-0036)
          onError(describeStatusWriteError(res.status, await res.json().catch(() => null)));
          return;
        }
        onStatusChange(next, from);
      } catch {
        setStatus(from);
        onError(offlineStatusWriteError());
      } finally {
        setBusy(false);
      }
    })();
  }

  function onRootKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => {
        const dir = e.key === "ArrowDown" ? 1 : -1;
        return (i + dir + options.length) % options.length;
      });
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      commit(options[active]);
    }
  }

  // Same tone classes as <Badge> — the pill IS the status badge until clicked.
  const tones = {
    good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    info: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    muted: "bg-surface-hover text-muted",
  } as const;
  const tone = tones[followupStatusTone(status_)];

  return (
    <span ref={rootRef} className="relative inline-block" onKeyDown={onRootKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        disabled={busy}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums transition-colors",
          "hover:ring-2 hover:ring-brand/30 focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:outline-none",
          "disabled:cursor-wait disabled:opacity-60",
          tone,
        )}
      >
        {t(statusI18nKey(status_) ?? "") || status_}
        <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
      </button>
      {open && popPos && (
        <span
          role="listbox"
          aria-label={t("followups.statusMenuAria")}
          style={{ left: popPos.left, top: popPos.top }}
          className={cn(
            "fixed z-50 w-40 -translate-x-1/2 rounded-xl border border-border bg-surface p-1 shadow-lg",
            popPos.up && "-translate-y-full",
          )}
        >
          {options.map((s, i) => (
            <button
              key={s}
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              type="button"
              role="option"
              aria-selected={s === status_}
              onClick={() => commit(s)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs",
                i === active ? "bg-surface-hover" : "",
                s === status_ ? "font-semibold" : "",
              )}
            >
              {t(statusI18nKey(s) ?? "") || s}
              {s === status_ && <Check className="ml-auto size-3 text-brand" aria-hidden="true" />}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

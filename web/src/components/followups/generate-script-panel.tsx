"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";
import type { CadenceEntry } from "@/lib/followups";
import { groupLabel, scriptsInGroup, shortName } from "@/lib/followup-scripts.mjs";
import type { FollowupScript, FollowupScriptsPayload } from "@/lib/followups-server";

// 「生成话术」（ADR-0080）：LogDialog 底部默认收起的可折叠区。一级 chips 选轮次
// （四个场景桶），二级 chips 选变体（该桶 ≥2 条时才出现），正文按「事实／意向／
// 下一步」三行标注——纪律就长在界面上，不用另写说明。
//
// 边界：复制只进剪贴板，系统只生成不代发。不写备注、不写 data/follow-ups.md、
// 不调任何写接口——用户必须自己粘、自己发。
export function GenerateScriptPanel({ entry }: { entry: CadenceEntry }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState<FollowupScriptsPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [groupIdx, setGroupIdx] = useState(0);
  const [variantIdx, setVariantIdx] = useState(0);
  const [copied, setCopied] = useState<"idle" | "copied" | "selected">("idle");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const groups = payload?.groups ?? [];
  const activeGroup = groups[groupIdx] ?? null;
  const inGroup: FollowupScript[] = useMemo(
    () => (activeGroup ? scriptsInGroup(payload?.scripts ?? [], activeGroup) : []),
    [payload, activeGroup],
  );
  const script = inGroup[Math.min(variantIdx, Math.max(inGroup.length - 1, 0))] ?? null;

  // 读接口是只读的（没有写面、不需要锁），所以无需乐观锁/重建——失败一律
  // fail-closed，UI 安静说一句「暂不可用」，不摆一个填不了的空话术。
  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/followups/scripts?num=${entry.num}`);
      const json = (await res.json().catch(() => null)) as FollowupScriptsPayload | null;
      setPayload(json?.available ? json : { available: false, groups: [], scripts: [] });
    } catch {
      setPayload({ available: false, groups: [], scripts: [] });
    } finally {
      setLoading(false);
    }
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && !payload && !loading) void load();
  };

  const pickGroup = (index: number) => {
    setGroupIdx(index);
    setVariantIdx(0); // 换桶就回到该桶第一条，避免指向不存在的变体
    setCopied("idle");
  };

  const copy = async () => {
    if (!script) return;
    const text = script.lines.map((line) => line.text).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      // 剪贴板 API 被拒（非安全上下文 / 权限）时的兜底：把正文选中，用户按 Ctrl+C。
      const el = bodyRef.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCopied("selected");
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied("idle"), 2400);
  };

  const chipCls =
    "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40";
  const chipOff = "border-border bg-surface-hover text-muted hover:text-foreground";
  const chipOn = "border-brand bg-surface text-brand-text";

  return (
    <div className="border-t border-border pt-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-xs font-medium text-muted transition-colors hover:text-foreground"
      >
        {t("followups.scriptTitle")}
        <ChevronDown className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="mt-3">
          {loading && (
            <p className="flex items-center gap-1.5 text-xs text-faint">
              <Loader2 className="size-3.5 animate-spin" />
              {t("followups.scriptLoading")}
            </p>
          )}

          {!loading && payload && !payload.available && <p className="text-xs text-faint">{t("followups.scriptUnavailable")}</p>}

          {!loading && payload?.available && script && (
            <>
              <p className="rounded-md border-l-2 border-faint bg-surface-hover px-2 py-1.5 text-[11px] leading-relaxed text-muted">
                {t("followups.scriptDiscipline")}
              </p>

              <div role="radiogroup" aria-label={t("followups.scriptPickGroup")} className="mt-3 flex flex-wrap gap-1.5">
                {groups.map((group, index) => (
                  <button
                    key={group}
                    type="button"
                    role="radio"
                    aria-checked={index === groupIdx}
                    onClick={() => pickGroup(index)}
                    className={cn(chipCls, index === groupIdx ? chipOn : chipOff)}
                  >
                    {groupLabel(group, t)}
                  </button>
                ))}
              </div>

              {/* 二级只在该桶有多条时才出现——用户往文件里加第二条变体，UI 自己长出来。 */}
              {inGroup.length > 1 && (
                <div role="radiogroup" aria-label={t("followups.scriptPickVariant")} className="mt-2 flex flex-wrap gap-1.5">
                  {inGroup.map((item, index) => (
                    <button
                      key={item.name}
                      type="button"
                      role="radio"
                      aria-checked={index === variantIdx}
                      onClick={() => {
                        setVariantIdx(index);
                        setCopied("idle");
                      }}
                      title={item.scenario}
                      className={cn(
                        "rounded-full border px-2.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40",
                        index === variantIdx ? chipOn : chipOff,
                      )}
                    >
                      {shortName(item.name)}
                    </button>
                  ))}
                </div>
              )}

              <p className="mt-2 text-[11px] text-faint">{t("followups.scriptSource", { num: entry.num })}</p>

              <div ref={bodyRef} className="mt-2 rounded-lg border border-border bg-surface-hover px-3 py-2.5">
                <p className="text-[11px] text-faint">
                  {script.name}
                  {script.scenario ? ` · ${script.scenario}` : ""}
                </p>
                <div className="mt-2 space-y-1.5">
                  {script.lines.map((line) => (
                    <div key={line.label} className="grid grid-cols-[3.5rem_1fr] gap-2">
                      <span className="font-mono text-[11px] leading-5 text-faint">{t(`followups.scriptLine.${line.label}`)}</span>
                      <span className="text-sm leading-5 text-foreground">
                        {line.text.split(/(\{[^{}]+\})/g).map((part, index) =>
                          script.missing.includes(part) ? (
                            <span key={index} className="rounded border border-dashed border-faint px-1 font-mono text-[11px] text-muted">
                              {part}
                            </span>
                          ) : (
                            <span key={index}>{part}</span>
                          ),
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-[11px] leading-relaxed text-faint">{t("followups.scriptNoSend")}</span>
                <button
                  type="button"
                  onClick={copy}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-brand px-3 py-1.5 text-sm font-medium text-brand-text transition-colors hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  {copied === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied === "copied"
                    ? t("followups.scriptCopied")
                    : copied === "selected"
                      ? t("followups.scriptManualCopy")
                      : t("followups.scriptCopy")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

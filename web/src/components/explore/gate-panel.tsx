"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Plus, RotateCcw, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/cn";
import { buildTitleFilterExplained } from "@/lib/core/title-keywords.mjs";
import type { DiscoveredOffer } from "@/lib/explore";
import { useI18n } from "@/lib/i18n/context";

// 采集门的「规则牌」（gate-visibility 工单 01）现在也是**改词表的地方**（工单 03）。
//
// 两块内容各自成立的道理：牌面回答「这批结果是被什么规则筛出来的」（一次「解决方案
// 架构师」扫描放行 161 条，其中 34 条标题里连检索词都没有——那是预期行为，但界面上
// 没有任何地方说过），而试算回答「把某个词加进去/删掉，会变成什么样」。后者是这一票
// 的核心：门控上线后词表准不准就是全部，而在此之前，看到误杀的唯一动作是关掉页面去
// 手改 portals.yml 再重扫——于是没人改，词表一年不动。
//
// 三条不可动的约束：
//   1. 试算与门控**共用同一份编译结果**（buildTitleFilterExplained）：复制一份匹配
//      规则来「预演」是这一票最容易犯的错，而且错了看不出来——面板会自信地报出一个
//      与真实门控相反的结论。
//   2. 写回**不丢注释**：portals.yml 的注释是词表的理由（哪类词刻意不加、为什么），
//      丢了就再也回不来。所以走文本级拼接（lib/core/portals-merge.mjs），不走 yaml 往返。
//   3. 保存**不重扫**：词表在下一次扫描生效，本次结果不动——否则用户会以为删个词就把
//      已经看到的岗位撤回了。所以折叠面板也不丢编辑（草稿留在状态里，牌面挂「未保存」）。

type Words = { positive: string[]; negative: string[] };

/** 试算预览最多列几条标题——再多就不是「看一眼」而是另一份结果列表了。 */
const PREVIEW = 4;

const seedKey = (p: string[], n: string[]) => `${p.join("\u0000")}\n\u0001\n${n.join("\u0000")}`;

/** 草稿与原表的差异，按内容比（顺序有意义：条目顺序就是文件里的顺序）。 */
const isDirty = (draft: Words, saved: Words) => seedKey(draft.positive, draft.negative) !== seedKey(saved.positive, saved.negative);

/** 一组可编辑词条：chip + 删除、行内加词输入框。 */
function WordGroup({
  label,
  words,
  onAdd,
  onRemove,
}: {
  label: string;
  words: string[];
  onAdd: (w: string) => void;
  onRemove: (w: string) => void;
}) {
  const { t } = useI18n();
  const [typed, setTyped] = useState("");
  const submit = () => {
    const w = typed.trim();
    if (!w) return;
    onAdd(w);
    setTyped("");
  };
  return (
    <div>
      <p className="text-[11px] font-medium text-muted">
        {label} <span className="tabular-nums text-faint">{words.length}</span>
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        {words.map((w, i) => (
          // key 带序号：词表里真有重复词（portals.yml 的 negative 里「销售」出现两次）。
          <span key={`${i}-${w}`} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface/50 px-1.5 py-0.5 text-[11px] text-foreground">
            {w}
            <button
              type="button"
              onClick={() => onRemove(w)}
              aria-label={t("explore.results.gateRemove", { w })}
              className="text-faint transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {words.length === 0 && <span className="text-[11px] text-faint">{t("explore.results.gateNone")}</span>}
        <span className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-1.5 py-0.5">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={t("explore.results.gateAddPlaceholder")}
            className="w-24 bg-transparent text-[11px] outline-none placeholder:text-faint"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!typed.trim()}
            aria-label={t("explore.results.gateAdd")}
            className="text-faint transition-colors hover:text-foreground disabled:opacity-40"
          >
            <Plus className="size-3" />
          </button>
        </span>
      </div>
    </div>
  );
}

/**
 * The collection gate's rule card + word-list editor.
 *
 * @param positive/negative the word list AS SAVED (from the seeded filters) — the draft's baseline
 * @param kept the survivors on screen; `folded` the rejects (each carrying its `gateReason`)
 * @param onSaved lifts the new list back into the provider's filters, so the card and a shared link keep describing the file that now exists
 */
export function GatePanel({
  positive,
  negative,
  kept,
  folded,
  onSaved,
}: {
  positive: string[];
  negative: string[];
  kept: DiscoveredOffer[];
  folded: DiscoveredOffer[];
  onSaved: (positive: string[], negative: string[]) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Words>(() => ({ positive: [...positive], negative: [...negative] }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const seeded = useRef(seedKey(positive, negative));

  // 词表本身变了（保存成功、或播种/分享链接带来了新表）→ 重新播种草稿。
  // 内容比对而不是引用比对：`filters` 每次 setFilters 都是新对象，按引用重播会在用户
  // 只是改了城市条件时把未保存的编辑静默冲掉。
  useEffect(() => {
    const next = seedKey(positive, negative);
    if (next === seeded.current) return;
    seeded.current = next;
    setDraft({ positive: [...positive], negative: [...negative] });
  }, [positive, negative]);

  // 试算：与门控同一个编译结果（不是同一「规则的重写」，是同一份实现），判的是屏上
  // 这批结果——kept 里会被新表毙掉的，与被毙里会被新表放行的。
  const trial = useMemo(() => {
    const gate = buildTitleFilterExplained({ positive: draft.positive, negative: draft.negative });
    return {
      rescue: folded.filter((o) => gate.pass(String(o.title ?? ""))),
      drop: kept.filter((o) => !gate.pass(String(o.title ?? ""))),
    };
  }, [draft, kept, folded]);

  const dirty = isDirty(draft, { positive, negative });
  const configured = draft.positive.length > 0 || draft.negative.length > 0;

  const edit = (side: keyof Words, w: string, remove = false) => {
    setSaved(false);
    setError("");
    setDraft((d) => ({ ...d, [side]: remove ? removeOne(d[side], w) : addOne(d[side], w) }));
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const r = await fetch("/api/portals/title-filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setSaved(true);
      onSaved(draft.positive, draft.negative);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-surface/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted transition-colors hover:text-foreground"
      >
        <ShieldCheck className="size-3.5 shrink-0" />
        <span>
          {configured
            ? t("explore.results.gateSummary", { p: draft.positive.length, n: draft.negative.length, f: folded.length })
            : t("explore.results.gateUnset")}
        </span>
        {/* 折叠起来也不丢编辑：草稿留在状态里，这里只是把「有未保存改动」说出来。 */}
        {dirty && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">{t("explore.results.gateUnsaved")}</span>}
        <ChevronRight className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-border px-3 py-2">
          <WordGroup label={t("explore.results.gatePositiveGroup")} words={draft.positive} onAdd={(w) => edit("positive", w)} onRemove={(w) => edit("positive", w, true)} />
          <WordGroup label={t("explore.results.gateNegativeGroup")} words={draft.negative} onAdd={(w) => edit("negative", w)} onRemove={(w) => edit("negative", w, true)} />

          <div className="rounded-lg border border-border bg-surface/40 px-2 py-1.5 text-[11px]">
            <p className="text-foreground">{t("explore.results.gateTrial", { rescue: trial.rescue.length, drop: trial.drop.length })}</p>
            {trial.rescue.length > 0 && (
              <p className="mt-0.5 text-faint">
                {t("explore.results.gateTrialRescue")}：{preview(trial.rescue, (n) => t("explore.results.filteredMore", { n }))}
              </p>
            )}
            {trial.drop.length > 0 && (
              <p className="mt-0.5 text-faint">
                {t("explore.results.gateTrialDrop")}：{preview(trial.drop, (n) => t("explore.results.filteredMore", { n }))}
              </p>
            )}
            <p className="mt-1 text-[10px] leading-relaxed text-faint">{t("explore.results.gateTrialNote")}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground shadow-sm transition-all hover:brightness-110 disabled:opacity-50"
            >
              <ShieldCheck className="size-3.5" /> {saving ? t("explore.results.gateSaving") : t("explore.results.gateSave")}
            </button>
            <button
              type="button"
              onClick={() => {
                setSaved(false);
                setError("");
                setDraft({ positive: [...positive], negative: [...negative] });
              }}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" /> {t("explore.results.gateDiscard")}
            </button>
            {saved && <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{t("explore.results.gateSaved")}</span>}
            {error && <span className="text-[11px] text-amber-600 dark:text-amber-400">{t("explore.results.gateSaveFailed", { msg: error })}</span>}
          </div>
        </div>
      )}

      {/* 这行常驻（不在折叠里）：误解发生在看卡片的时候，答案不该藏在展开之后。 */}
      <p className="px-3 pb-2 text-[11px] leading-relaxed text-faint">{t("explore.results.gateQueryNote")}</p>
    </div>
  );
}

function addOne(list: string[], w: string): string[] {
  return list.some((k) => k.trim().toLowerCase() === w.trim().toLowerCase()) ? list : [...list, w];
}

/** 删一条：同名词表里可能有两条（portals.yml 真出现过），只删第一条。 */
function removeOne(list: string[], w: string): string[] {
  const i = list.indexOf(w);
  return i < 0 ? list : [...list.slice(0, i), ...list.slice(i + 1)];
}

function preview(offers: DiscoveredOffer[], moreLabel: (n: number) => string): string {
  const head = offers.slice(0, PREVIEW).map((o) => o.title || o.url);
  const rest = offers.length - head.length;
  return rest > 0 ? `${head.join("、")}（${moreLabel(rest)}）` : head.join("、");
}

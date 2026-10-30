"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, RotateCcw, ShieldCheck, X } from "lucide-react";

import { buildTitleFilterExplained } from "@/lib/core/title-keywords.mjs";
import { mergeDenyWords } from "@/lib/deny-words.mjs";
import type { DiscoveredOffer } from "@/lib/explore";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

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
//      已经看到的岗位撤回了。所以弹窗关了也不丢编辑（草稿留在状态里，牌面挂「未保存」）。

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
  highlight,
  onAdd,
  onRemove,
}: {
  label: string;
  words: string[];
  /** 要高亮的词（小写规范化）：「拉黑所选」刚落进草稿的新词，让用户一眼看到多出来的是哪几个。 */
  highlight?: Set<string>;
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
        {words.map((w, i) => {
          // key 带序号：词表里真有重复词（portals.yml 的 negative 里「销售」出现两次）。
          // 高亮色与顶部带入提示同一家族（amber）：新词从提示一路亮到 chip，来源一眼可循。
          const hot = highlight?.has(w.trim().toLowerCase()) ?? false;
          return (
            <span
              key={`${i}-${w}`}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
                hot ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400" : "border-border bg-surface/50 text-foreground",
              )}
            >
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
          );
        })}
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
 * The collection gate's word-list editor, rendered as a modal.
 *
 * 常驻摘要牌已撤（用户决定 2026-10-30）：牌面信息并入弹窗，入口只剩工具栏
 * 「加入管道」右侧的「配置」按钮。组件本身始终挂载（isBsk 时）——草稿活在
 * 状态里，弹窗关了编辑不丢；「未保存」徽标改由 onDirtyChange 上报给工具栏，
 * 挂在「配置」按钮上（入口在哪，徽标在哪）。
 *
 * @param positive/negative the word list AS SAVED (from the seeded filters) — the draft's baseline
 * @param kept the survivors on screen; `folded` the rejects (each carrying its `gateReason`)
 * @param onSaved lifts the new list back into the provider's filters, so the trial and a shared link keep describing the file that now exists
 * @param open/onOpenChange 弹窗开关由 ResultsList 持有——触发按钮在工具栏，与弹窗分居两处
 * @param onDirtyChange 把「有未保存改动」上报给父组件，挂在「配置」按钮上
 */
export function GatePanel({
  positive,
  negative,
  kept,
  folded,
  onSaved,
  open,
  onOpenChange,
  onDirtyChange,
  preaddNegative,
}: {
  positive: string[];
  negative: string[];
  kept: DiscoveredOffer[];
  folded: DiscoveredOffer[];
  onSaved: (positive: string[], negative: string[]) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** 「拉黑所选」带入的黑名单候选词（results-list 推导）：数组引用一变就并入草稿
   *  的黑名单一侧——每点一次按钮都是新数组，重复词由 mergeDenyWords 去重兑底。 */
  preaddNegative?: string[] | null;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Words>(() => ({ positive: [...positive], negative: [...negative] }));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  // 「拉黑所选」带入的黑名单新词（小写规范化，多次点击累计）——这些 chip 在下方高亮、
  // 顶部提示按同一口径计数；随保存/放弃/手动编辑清空，不跨动作残留。
  const [preaddedWords, setPreaddedWords] = useState<string[]>([]);
  const seeded = useRef(seedKey(positive, negative));
  // preadd 并入时要知道「草稿里原本有什么」，但 effect 不能依赖 draft（否则 setDraft
  // 换了新数组引用会再触发本 effect，mergeDenyWords 每次都返回新数组就成了死循环）——
  // 用 ref 读最近一次渲染的草稿即可。
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // 词表本身变了（保存成功、或播种/分享链接带来了新表）→ 重新播种草稿。
  // 内容比对而不是引用比对：`filters` 每次 setFilters 都是新对象，按引用重播会在用户
  // 只是改了城市条件时把未保存的编辑静默冲掉。
  useEffect(() => {
    const next = seedKey(positive, negative);
    if (next === seeded.current) return;
    seeded.current = next;
    setDraft({ positive: [...positive], negative: [...negative] });
  }, [positive, negative]);

  // Esc 关闭弹窗——与点遮罩同级的低承诺退出；草稿留在状态里，关了再开编辑还在。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  // 「拉黑所选」把候选词并进草稿黑名单（引用一变即并入；null/空数组不动）。并进
  // 的是 draft 而不是已存表——保存仍然只发生在弹窗里（与词表编辑同一条回路），
  // 试算随之更新，用户保存前就能看到「会多毙几条」。
  // 真正新落的词（草稿里原本没有的）进高亮集合：重复点击带同一批词、或词已在
  // 草稿里时不再点亮。新词以琥珀色高亮，与顶部带入提示一一对应。
  useEffect(() => {
    if (!preaddNegative || preaddNegative.length === 0) return;
    const before = draftRef.current.negative;
    setDraft((d) => ({ ...d, negative: mergeDenyWords(d.negative, preaddNegative) }));
    const fresh = preaddNegative
      .map((w) => String(w).trim())
      .filter((w) => w && !before.some((k) => k.trim().toLowerCase() === w.toLowerCase()));
    if (fresh.length > 0) setPreaddedWords((prev) => [...new Set([...prev, ...fresh.map((w) => w.toLowerCase())])]);
  }, [preaddNegative]);

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

  // 「未保存」徽标改挂在工具栏「配置」按钮上：牌面撤掉后，弹窗关着时唯一的
  // 「编辑还挂著」信号在入口处，用户不会忘记回来保存或放弃。
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const edit = (side: keyof Words, w: string, remove = false) => {
    setSaved(false);
    setError("");
    setPreaddedWords([]);
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
      setPreaddedWords([]);
      onSaved(draft.positive, draft.negative);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onOpenChange(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("explore.results.gateModalTitle")}
            className="max-h-[calc(100dvh-2rem)] w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-surface p-5 shadow-xl"
          >
            <div className="flex items-start justify-between gap-4">
              <h2 className="flex items-center gap-2 font-display text-lg">
                <ShieldCheck className="size-4 text-muted" /> {t("explore.results.gateModalTitle")}
              </h2>
              <button type="button" onClick={() => onOpenChange(false)} aria-label={t("explore.results.gateClose")} className="rounded p-1 text-faint transition hover:text-foreground">
                <X className="size-4" />
              </button>
            </div>

            <div className="mt-3 space-y-3">
              {/* 检索词与词表的分工（原牌面常驻注）：进弹窗后它仍是读懂试算的前提。 */}
              <p className="text-[11px] leading-relaxed text-faint">{t("explore.results.gateQueryNote")}</p>
              {preaddedWords.length > 0 && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                  {t("explore.results.gatePreadded", { n: preaddedWords.length })}
                </p>
              )}
              <WordGroup label={t("explore.results.gatePositiveGroup")} words={draft.positive} onAdd={(w) => edit("positive", w)} onRemove={(w) => edit("positive", w, true)} />
              <WordGroup
                label={t("explore.results.gateNegativeGroup")}
                words={draft.negative}
                highlight={new Set(preaddedWords)}
                onAdd={(w) => edit("negative", w)}
                onRemove={(w) => edit("negative", w, true)}
              />

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
                    setPreaddedWords([]);
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
          </div>
        </div>
      )}
    </>
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

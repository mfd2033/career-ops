"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus } from "lucide-react";
import { cn } from "@/lib/cn";
import type { DiscoveredOffer } from "@/lib/explore";
import { CostBadge } from "@/components/cost/cost-badge";
import { DiscoveryCard } from "./discovery-card";
import { useExplore } from "./explore-provider";
import { useI18n } from "@/lib/i18n/context";

export type EnrichedOffer = DiscoveredOffer & { inPipeline: boolean; evaluatedN?: string };

// 结果分组 tab（管道页同款）。四组互斥且完整覆盖：evaluated ⊆ inPipeline，
// 因此 新增/管道/已评估 正好平分全部结果，「全部」为兜底。
type ResultTab = "all" | "new" | "pipeline" | "evaluated";
const TABS: ResultTab[] = ["all", "new", "pipeline", "evaluated"];
const TAB_LABEL_KEY: Record<ResultTab, string> = {
  all: "explore.results.tabAll",
  new: "explore.results.tabNew",
  pipeline: "explore.results.tabPipeline",
  evaluated: "explore.results.tabEvaluated",
};
// 默认落在「新增」——即过滤掉已管道/已评估的可操作 JD；要看旧的切到其他 tab。
const DEFAULT_TAB: ResultTab = "new";
// tab 选中持久化到 localStorage，刷新后保留上次选择。
const TAB_STORAGE_KEY = "explore.results.tab";
const isResultTab = (v: unknown): v is ResultTab => typeof v === "string" && (TABS as string[]).includes(v);
// 每个 offer 属于哪一组（供分组计数与过滤共用，保证两处数字一致）。
const tabOf = (o: EnrichedOffer): ResultTab => (o.evaluatedN ? "evaluated" : o.inPipeline ? "pipeline" : "new");
const inTab = (t: ResultTab, o: EnrichedOffer): boolean => t === "all" || tabOf(o) === t;

export function ResultsList({ offers }: { offers: EnrichedOffer[] }) {
  const { companiesScanned, partial, addToPipeline, added, mode } = useExplore();
  const isAi = mode === "ai";
  const [sort, setSort] = useState<"fresh" | "company">("fresh");
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<ResultTab>(DEFAULT_TAB);
  const { t } = useI18n();
  // 标记是否首帧，阻止 persist effect 在挂载时用初始值覆盖 localStorage 里已存的 tab。
  const skipPersistFirstRender = useRef(true);

  // 首次挂载读取上次选择的 tab。不改 SSR 初始渲染（避免 hydration 不一致），挂载后应用；
  // 声明在 persist 之前，确保先读到真实持久值。
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_STORAGE_KEY);
      if (saved && isResultTab(saved)) setTab(saved);
    } catch {
      /* localStorage 不可用时静默退回默认 tab */
    }
  }, []);
  // 选中变化时持久化，刷新后保留当前 tab。首帧跳过，避免把初始默认值覆盖回写。
  useEffect(() => {
    if (skipPersistFirstRender.current) {
      skipPersistFirstRender.current = false;
      return;
    }
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      /* 静默忽略写入失败 */
    }
  }, [tab]);

  // 各 tab 计数基于完整结果集（与管道页一致：tab 计数看全集，搜索只过滤行）。
  const counts = useMemo(() => {
    const c: Record<ResultTab, number> = { all: offers.length, new: 0, pipeline: 0, evaluated: 0 };
    for (const o of offers) c[tabOf(o)] += 1;
    return c;
  }, [offers]);

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = offers.filter((o) => inTab(tab, o));
    if (needle) list = list.filter((o) => o.title.toLowerCase().includes(needle) || o.company.toLowerCase().includes(needle));
    const sorted = [...list].sort((a, b) =>
      sort === "fresh" ? (b.postedAt || "").localeCompare(a.postedAt || "") : a.company.localeCompare(b.company),
    );
    return sorted;
  }, [offers, q, sort, tab]);

  const addable = offers.filter((o) => !o.inPipeline && !o.evaluatedN && !added.has(o.url));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-sm text-foreground">
            <span className="font-semibold">{counts[tab]}</span> {isAi ? t(offers.length === 1 ? "explore.results.candidateOne" : "explore.results.candidateMany", { n: counts[tab] }) : t(offers.length === 1 ? "explore.results.freshRoleOne" : "explore.results.freshRoleMany", { n: counts[tab] })}
            <CostBadge kind={isAi ? "spend" : "free-network"} size="xs" className="ml-2 align-middle" />
          </p>
          <p className="text-[12px] text-faint">
            {isAi
              ? t("explore.results.aiSubtext")
              : `${companiesScanned > 0 ? t("explore.results.companiesScanned", { n: companiesScanned }) : ""}${t("explore.results.zeroTokens")}${partial ? t("explore.results.partialNote") : ""}`}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5">
            <Search className="size-3.5 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("explore.results.filterPlaceholder")}
              className="w-32 bg-transparent text-[13px] outline-none placeholder:text-faint"
            />
          </div>
          <div className="inline-flex rounded-lg border border-border bg-surface/40 p-0.5 text-xs">
            {(["fresh", "company"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                className={cn("rounded-md px-2.5 py-1 font-medium capitalize transition-colors", sort === s ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground")}
              >
                {s === "fresh" ? t("explore.results.sortFresh") : t("explore.results.sortCompany")}
              </button>
            ))}
          </div>
          {addable.length > 1 && (
            <button
              type="button"
              onClick={() => addToPipeline(addable)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
            >
              <Plus className="size-3.5" /> {t("explore.results.addAll", { n: addable.length })}
            </button>
          )}
        </div>
      </div>

      {/* 结果分组 tab —— 与管道页同款：下边框 + 每 tab 计数 */}
      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tabKey) => (
          <button
            key={tabKey}
            type="button"
            onClick={() => setTab(tabKey)}
            className={cn(
              "-mb-px inline-flex items-center justify-center border-b-2 px-3 py-2 text-xs font-medium transition-colors",
              tab === tabKey ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
            )}
          >
            {t(TAB_LABEL_KEY[tabKey])} <span className="text-faint tabular-nums">{counts[tabKey]}</span>
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {view.map((o) => (
          <DiscoveryCard key={o.url} offer={o} inPipeline={o.inPipeline} evaluatedN={o.evaluatedN} />
        ))}
      </div>

      {view.length === 0 && (
        <p className="py-10 text-center text-sm text-faint">{q.trim() ? t("explore.results.noMatch", { q }) : t("explore.results.tabEmpty")}</p>
      )}
    </div>
  );
}

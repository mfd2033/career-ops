"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { BROWSER_LABEL, type BrowserSource, type DiscoveredOffer } from "@/lib/explore";
import { CostBadge } from "@/components/cost/cost-badge";
import { DiscoveryCard } from "./discovery-card";
import { GatePanel } from "./gate-panel";
import { useExplore } from "./explore-provider";
import { isSelectable, resultTabOf, visibleOffers } from "@/lib/results-view.mjs";
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

/** 被采集门毙掉的岗位（ADR-0029 决议 4）：只读、默认折叠。
 *
 *  刻意不给勾选框、不给「加入管道」：要放行必须先改 title_filter 再重扫，这样台账里
 *  那行 skipped_title 与收件箱事实永远一致（决议 5）。就地救回会在台账留下「记着被毙、
 *  行却进了收件箱」的矛盾记录，日后无法用它复盘。放行这条路的入口在结果区上方的规则牌
 *  （改词表 → 重扫），不在这里逐条勾选（工单 03）。 */
function FilteredFold({ offers }: { offers: DiscoveredOffer[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (offers.length === 0) return null;
  return (
    <div className="rounded-xl border border-border bg-surface/30">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted transition-colors hover:text-foreground"
      >
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        {t("explore.results.filteredFold", { n: offers.length })}
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <ul className="space-y-1">
            {offers.map((o) => (
              <li key={o.url} className="flex flex-wrap items-baseline gap-x-2 text-[12px]">
                {/^https?:\/\//i.test(o.url) ? (
                  // 原始职位 URL 原样打开（CONTEXT.md「原始职位 URL」词条：归一 URL 只
                  // 服务身份比较，其变换不外溢到浏览器行为）。
                  <a href={o.url} target="_blank" rel="noreferrer" className="text-foreground hover:text-brand hover:underline">
                    {o.title || o.url}
                  </a>
                ) : (
                  // URL 不可解析时降级为纯文本，不渲染死链。
                  <span className="text-foreground">{o.title || o.url}</span>
                )}
                <span className="text-faint">
                  {BROWSER_LABEL[(o.source ?? "").replace(/^browser-/, "") as BrowserSource] ?? o.source}
                </span>
                {/* 被毙原因（工单 03）：命中的黑名单条目，或「没命中任何白名单词」。
                    读的是门自己附带的原因（gateReason），这里不重判——重判会在词表改动
                    之后与事实不一致，而这条正是用户要用来判断「是不是误杀」的信息。 */}
                {o.gateReason && (
                  <span className="text-faint">
                    {o.gateReason.type === "negative"
                      ? t("explore.results.filteredReasonNegative", { words: o.gateReason.words.join("／") })
                      : t("explore.results.filteredReasonNoPositive")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-faint">{t("explore.results.filteredFoldHint")}</p>
        </div>
      )}
    </div>
  );
}

export function ResultsList({ offers }: { offers: EnrichedOffer[] }) {
  const { companiesScanned, partial, addToPipeline, added, mode, restoreSeen, restoring, folded, filters, setFilters, scanSource } = useExplore();
  const isAi = mode === "ai";
  // 采集门跑在 browser 路径上（bsk 服务端 / 扩展页侧两条 driver），与 explorer-view 的
  // isBsk 同构。ATS 扫描也被标题门筛，但页面拿不到它的被毙条数——见 GateCard 注释。
  const isBsk = mode === "browser" || (!isAi && scanSource === "bsk");
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
    for (const o of offers) c[resultTabOf(o)] += 1;
    return c;
  }, [offers]);

  const view = useMemo(() => {
    const list = visibleOffers(offers, tab, q);
    return [...list].sort((a, b) =>
      sort === "fresh" ? (b.postedAt || "").localeCompare(a.postedAt || "") : a.company.localeCompare(b.company),
    );
  }, [offers, q, sort, tab]);

  // ADR-0021 确认入管：勾选集 + 「加入管道 (N)」。默认全选「本次新采」的可加入项
  // （offers 引用变化视为一次新结果集）；恢复出来的旧发现（source=explore-restore）
  // 不进默认勾选，要入管得显式勾上。
  const addable = useMemo(() => offers.filter((o) => isSelectable(o, added)), [offers, added]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastOffersRef = useRef<typeof offers | null>(null);
  useEffect(() => {
    if (lastOffersRef.current === offers) return; // 只在结果集变化时重置默认勾选
    lastOffersRef.current = offers;
    setSelected(new Set(addable.filter((o) => o.source !== "explore-restore").map((o) => o.url)));
  }, [offers, added, addable]);
  const toggleSelect = (url: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });
  // 批量条只描述屏幕上能确认入管的那批行：计数、全选、确认全部限定在 view 上，而不是
  // 整个结果集。此前计数取 addable（全集）而行取 view，输入关键词后按钮上的数字会比
  // 屏幕上的行多——点下去确认的还包括屏幕外的行（用户报的正是这一条）。筛选时按钮的
  // 作用域就应当是筛选后的列表；不筛时 view 覆盖当前 tab 的全部行，行为与从前一致。
  const visibleAddable = useMemo(() => view.filter((o) => isSelectable(o, added)), [view, added]);
  const selectedAddable = visibleAddable.filter((o) => selected.has(o.url));
  const allAddableSelected = visibleAddable.length > 0 && selectedAddable.length === visibleAddable.length;
  // 全选/清除都只动可见的那批：清除只清屏幕上的勾，屏幕外的勾选留到它重新可见时再处置，
  // 而不是在这里被无声抹掉。
  const toggleAll = () =>
    setSelected((s) => {
      const next = new Set(s);
      for (const o of visibleAddable) {
        if (allAddableSelected) next.delete(o.url);
        else next.add(o.url);
      }
      return next;
    });
  const addSelected = async () => {
    const n = await addToPipeline(selectedAddable);
    if (n > 0) {
      setSelected((s) => {
        const next = new Set(s);
        for (const o of selectedAddable) next.delete(o.url);
        return next;
      });
    }
  };

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
          {!isAi && addable.length > 0 && (
            <button
              type="button"
              onClick={() => void restoreSeen()}
              disabled={restoring}
              title={t("explore.results.restoreSeenTitle")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand disabled:opacity-50"
            >
              {restoring ? t("explore.results.restoring") : t("explore.results.restoreSeen")}
            </button>
          )}
          {visibleAddable.length > 0 && (
            <>
              <button
                type="button"
                onClick={toggleAll}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
              >
                {allAddableSelected ? t("explore.results.clearSelection") : t("explore.results.selectAll", { n: visibleAddable.length })}
              </button>
              <button
                type="button"
                disabled={selectedAddable.length === 0}
                onClick={() => void addSelected()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground shadow-sm transition-all hover:brightness-110 disabled:opacity-50"
              >
                <Plus className="size-3.5" /> {t("explore.results.addSelected", { n: selectedAddable.length })}
              </button>
            </>
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

      {/* 规则牌排在卡片之前：那个「为什么这条在这儿」的疑惑就是在看卡片时产生的。
          它同时是改词表的地方（工单 03）——误杀当场就能改、当场看到试算，而不是关掉页面
          去手改 portals.yml 再重扫；后者正是这一轮之前没人动词表的原因。
          只在 browser 路径显示：ATS CLI 扫描同样过标题门，但被毙条数只活在它自己的
          scan-runs.tsv 里，页面侧拿不到——显示 0 是假话，比不显示更糟。 */}
      {isBsk && (
        <GatePanel
          positive={filters.positive}
          negative={filters.negative}
          kept={offers}
          folded={folded}
          onSaved={(p, n) => setFilters({ ...filters, positive: p, negative: n })}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {view.map((o) => (
          <DiscoveryCard
            key={o.url}
            offer={o}
            inPipeline={o.inPipeline}
            evaluatedN={o.evaluatedN}
            selectable={isSelectable(o, added)}
            selected={selected.has(o.url)}
            onToggleSelect={() => toggleSelect(o.url)}
          />
        ))}
      </div>

      {view.length === 0 && (
        <p className="py-10 text-center text-sm text-faint">{q.trim() ? t("explore.results.noMatch", { q }) : t("explore.results.tabEmpty")}</p>
      )}

      {/* 被采集门毙掉的岗位（ADR-0029 决议 4）：只读折叠区，回答「是不是误杀了我要的岗」。
          收件箱变干净不等于发现记录丢失——台账里那一行仍在。 */}
      <FilteredFold offers={folded} />
    </div>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Plus, ChevronRight, Coins, Ban } from "lucide-react";
import { cn } from "@/lib/cn";
import { BROWSER_LABEL, type BrowserSource, type DiscoveredOffer } from "@/lib/explore";
import { CostBadge } from "@/components/cost/cost-badge";
import { DiscoveryCard } from "./discovery-card";
import { GatePanel } from "./gate-panel";
import { InputClearButton } from "@/components/input-clear-button";
import { useExplore } from "./explore-provider";
import { isSelectable, omitRemoved, resultTabOf, visibleOffers, filterBySalaryMin } from "@/lib/results-view.mjs";
import { suggestDenyWords } from "@/lib/deny-words.mjs";
import { countOfferTags, filterByTags, withSelectedCounts, withTags } from "@/lib/result-tags.mjs";
import { TagBar } from "./tag-bar";
import { useI18n } from "@/lib/i18n/context";

export type EnrichedOffer = DiscoveredOffer & { inPipeline: boolean; evaluatedN?: string };

/** 标签词表（服务端装配、客户端匹配）：收件箱关键词条同一三源词表 + 用户增量/抑制。 */
export type TagVocab = { vocab: string[]; exclude: string[] };

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

export function ResultsList({ offers, tagVocab }: { offers: EnrichedOffer[]; tagVocab?: TagVocab }) {
  const { companiesScanned, partial, addToPipeline, added, removed, removeOffers, restoreRemoved, mode, restoreSeen, restoring, folded, filters, setFilters, scanSource } = useExplore();
  const isAi = mode === "ai";
  // 采集门跑在 browser 路径上（bsk 服务端 / 扩展页侧两条 driver），与 explorer-view 的
  // isBsk 同构。ATS 扫描也被标题门筛，但页面拿不到它的被毙条数——见 GateCard 注释。
  const isBsk = mode === "browser" || (!isAi && scanSource === "bsk");
  // 标题门配置弹窗的开关（工单 03 交互改弹窗）：触发按钮在工具栏，GatePanel 只渲染弹窗；
  // 组件本身始终挂载，草稿留在它的状态里，关了再开编辑不丢。gateDirty 是 GatePanel
  // 上报的「有未保存改动」，徽标挂在「配置」按钮上（入口在哪，徽标在哪）。
  const [gateOpen, setGateOpen] = useState(false);
  const [gateDirty, setGateDirty] = useState(false);
  // 「拉黑所选」带入 GatePanel 的黑名单候选词（deny-words.mjs 从勾选行标题推导）。
  // null = 无；每次点击都换新数组引用——GatePanel 按引用消费，重复点击由
  // mergeDenyWords 去重兑底，不会落进两条同名 chip。
  const [preadd, setPreadd] = useState<string[] | null>(null);
  const [sort, setSort] = useState<"fresh" | "company">("fresh");
  const [q, setQ] = useState("");
  // 薪资下限（月薪 K）：展示层过滤，纯视图状态，与 q/sort 同类，不进 URL、不跨搜索保留。
  const [salaryMin, setSalaryMin] = useState<number | null>(null);
  const [tab, setTab] = useState<ResultTab>(DEFAULT_TAB);
  // 选中的标签（ADR-0068 决议 3 的探索页版本）：chip 之间 OR，与 tab / 搜索框 AND。
  // 纯视图状态，与 q/sort 同类，不进 URL、不跨搜索保留（见下方结果集重置）。
  const [tags, setTags] = useState<Set<string>>(() => new Set());
  // 被用户显式移除的结果 URL（点「移除所选」）。只影响显示、不写任何数据；集合由
  // provider 持有并持久化到 localStorage，刷新与下一次搜索都保持隐藏，直到点「恢复已移除」。
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

  // 结果集去掉用户已移除的行。计数、视图、可加入项都建在 remaining 上：被移除的行
  // 既不在屏幕上、也不该再被徽标算进数字（否则又回到「数字比行多」的老毛病；对照本
  // 文件顶部注释里记录的那条回归）。
  // 同时逐行挂上标签（零 token 词典匹配：词表 × 职位名/公司/地点）：标签是行的一个只读
  // 属性，跟行一起窄化，所以建在这一步——不另开一条结果集副本。词表为空（裸 checkout）
  // 时每行 tags 为空，标签条整条隐藏、过滤恒放行。
  const remaining = useMemo(
    () => withTags(omitRemoved(offers, removed), tagVocab?.vocab, tagVocab?.exclude),
    [offers, removed, tagVocab?.vocab, tagVocab?.exclude],
  );

  // 「其余条件放行」的行集：标签的计数基底就是它（ADR-0068 决议 4 修订）——chip 上的
  // 数字必须等于点它之后的匹配条数，否则会出现「计数 1、点击 0 结果」的死 chip。
  const tagScope = useMemo(() => visibleOffers(remaining, tab, q), [remaining, tab, q]);

  // 薪资下限过滤（收件箱 facet 同款）：挂在 tagScope 之后，标签 chip 的计数基底随
  // 之收窄——chip 数字必须等于点它之后的匹配条数（ADR-0068 决议 4 的死 chip 禁令
  // 同样约束这道过滤）。语义与采集门不同：门管「别误删」（区间重叠、未知放行），
  // 这里管「确实给得到」（严格下限、未知隐藏），见 filterBySalaryMin 注释。
  const salaryScope = useMemo(() => filterBySalaryMin(tagScope, salaryMin), [tagScope, salaryMin]);

  // 各 tab 计数基于完整结果集（与管道页一致：tab 计数看全集，搜索只过滤行）。全集指
  // 去掉已移除行之后的集合——移除是用户显式处置，不是搜索词收窄。
  const counts = useMemo(() => {
    const c: Record<ResultTab, number> = { all: remaining.length, new: 0, pipeline: 0, evaluated: 0 };
    for (const o of remaining) c[resultTabOf(o)] += 1;
    return c;
  }, [remaining]);

  // 选中项补进计数集：切 tab / 改搜索词后 chip 仍可见、可取消，不会留下看不见的选中态。
  const tagCounts = useMemo(() => withSelectedCounts(countOfferTags(salaryScope), tags), [salaryScope, tags]);

  const view = useMemo(() => {
    const list = filterByTags(salaryScope, tags);
    return [...list].sort((a, b) =>
      sort === "fresh" ? (b.postedAt || "").localeCompare(a.postedAt || "") : a.company.localeCompare(b.company),
    );
  }, [salaryScope, tags, sort]);

  // ADR-0021 确认入管：勾选集 + 「加入管道 (N)」。默认全选「本次新采」的可加入项
  // （offers 引用变化视为一次新结果集）；恢复出来的旧发现（source=explore-restore）
  // 不进默认勾选，要入管得显式勾上。
  const addable = useMemo(() => remaining.filter((o) => isSelectable(o, added)), [remaining, added]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastOffersRef = useRef<typeof offers | null>(null);
  useEffect(() => {
    if (lastOffersRef.current === offers) return; // 只在结果集变化时重置默认勾选
    lastOffersRef.current = offers;
    setSelected(new Set(addable.filter((o) => o.source !== "explore-restore").map((o) => o.url)));
    // 新一次发现＝新结果集：上一轮的标签在本轮多半是死词，留着只会把页面锁在
    // 「0 结果」。与收件箱的死词自动剪枝同一动机，这里直接清空（结果集没有
    // 可撤销的 hidden 语义）。
    setTags(new Set());
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
  // 移除所选：把勾选的行从结果区隐去（纯展示，不写 pipeline.md），随即清空勾选——
  // 勾选集的意义已经用掉，留着会让下一次批量动作（加入管道）指向看不见的行，正是本
  // 文件要避免的那种「数字与屏幕不符」。
  const removeSelected = () => {
    removeOffers([...selected]);
    setSelected(new Set());
  };

  // 勾选中的行（不限 addable——「不适合」与「能不能入管」无关）。
  const selectedOffers = useMemo(() => remaining.filter((o) => selected.has(o.url)), [remaining, selected]);
  // 拉黑所选：把勾选行标题里的特征词作为黑名单候选带进标题门弹窗。并入的是
  // GatePanel 的草稿而非已存表——保存仍只发生在弹窗里，试算让用户先看到「会多毙
  // 几条」再决定；词表在下一次扫描生效（与手动改词表同一套语义，保存不重扫）。
  // 仅 browser 路径：标题门（及其配置弹窗）只挂载在这里，见下方 GatePanel 注释。
  const blacklistSelected = () => {
    setPreadd(suggestDenyWords(selectedOffers));
    setGateOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <p className="text-sm text-foreground">
            <span className="font-semibold">{counts[tab]}</span> {isAi ? t(remaining.length === 1 ? "explore.results.candidateOne" : "explore.results.candidateMany", { n: counts[tab] }) : t(remaining.length === 1 ? "explore.results.freshRoleOne" : "explore.results.freshRoleMany", { n: counts[tab] })}
            <CostBadge kind={isAi ? "spend" : "free-network"} size="xs" className="ml-2 align-middle" />
          </p>
          <p className="text-[12px] text-faint">
            {isAi
              ? t("explore.results.aiSubtext")
              : `${companiesScanned > 0 ? t("explore.results.companiesScanned", { n: companiesScanned }) : ""}${t("explore.results.zeroTokens")}${partial ? t("explore.results.partialNote") : ""}`}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* relative + pr 留白：容纳内嵌 ×（ADR-0059 决议 1/8） */}
          <div className="relative flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5">
            <Search className="size-3.5 text-faint" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("explore.results.filterPlaceholder")}
              className="w-32 bg-transparent pr-6 text-[13px] outline-none placeholder:text-faint"
            />
            <InputClearButton show={q.length > 0} onClear={() => setQ("")} label={t("explore.results.clearFilter")} className="right-1" />
          </div>
          {/* 薪资下限（月薪 K）——搜索框右侧的展示层过滤：解析口径复用 parseSalaryText
              （分板折算），判定端取严格下限、无薪资行隐藏（与采集门的区间重叠/未知放行
              口径不同）。空 = 不过滤。 */}
          <div className="relative flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5">
            <Coins className="size-3.5 text-faint" />
            <input
              type="number"
              min={1}
              step={0.5}
              value={salaryMin ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                setSalaryMin(Number.isFinite(n) && n > 0 ? n : null);
              }}
              placeholder={t("explore.results.salaryMinPlaceholder")}
              title={t("explore.results.salaryMinTitle")}
              aria-label={t("explore.results.salaryMinTitle")}
              className="no-number-spin w-16 bg-transparent pr-5 text-[13px] outline-none placeholder:text-faint"
            />
            <InputClearButton show={salaryMin != null} onClear={() => setSalaryMin(null)} label={t("explore.filter.clearSalaryMin")} className="right-1" />
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
          {removed.size > 0 && (
            <button
              type="button"
              onClick={restoreRemoved}
              title={t("explore.results.restoreRemovedTitle")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-brand-soft hover:text-brand"
            >
              {t("explore.results.restoreRemoved", { n: removed.size })}
            </button>
          )}
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
            <button
              type="button"
              onClick={toggleAll}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
            >
              {allAddableSelected ? t("explore.results.clearSelection") : t("explore.results.selectAll", { n: visibleAddable.length })}
            </button>
          )}
          {/* 移除所选：把勾选的行从结果区隐去（纯展示，刷新后仍保持；重新搜索即恢复）。
              排在「清除选择」右侧、主按钮「加入管道」左侧——次级动作不抢主 CTA 的位置。 */}
          {selected.size > 0 && (
            <button
              type="button"
              onClick={removeSelected}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
            >
              {t("explore.results.removeSelected", { n: selected.size })}
            </button>
          )}
          {/* 拉黑所选：勾选行标题里的特征词 → 标题门黑名单草稿（打开弹窗，试算先行）。
              与「移除所选」互为补充：那只隐藏本次显示，这个让下一次扫描起不再搜到
              类似岗位。仅 browser 路径（与标题门同在）。 */}
          {selected.size > 0 && isBsk && (
            <button
              type="button"
              onClick={blacklistSelected}
              title={t("explore.results.blacklistTitle")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
            >
              <Ban className="size-3.5" /> {t("explore.results.blacklistSelected", { n: selected.size })}
            </button>
          )}
          {visibleAddable.length > 0 && (
            <button
              type="button"
              disabled={selectedAddable.length === 0}
              onClick={() => void addSelected()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground shadow-sm transition-all hover:brightness-110 disabled:opacity-50"
            >
              <Plus className="size-3.5" /> {t("explore.results.addSelected", { n: selectedAddable.length })}
            </button>
          )}
          {/* 标题门配置：主 CTA「加入管道」右侧的次级入口，点击打开配置弹窗。
              仅 browser 路径有标题门（与下方 GatePanel 的挂载条件同构）；加不加管道不影响
              它的可用性——改词表正是为了下一次扫描不再误杀，跟本批勾选无关。
              弹窗关着但有未保存编辑时，徽标提醒回来保存或放弃。 */}
          {isBsk && (
            <button
              type="button"
              onClick={() => setGateOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
            >
              {t("explore.results.gateConfigure")}
              {gateDirty && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">{t("explore.results.gateUnsaved")}</span>}
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

      {/* 标签条 —— 收件箱关键词条的同款交互（ADR-0068 决议 3/4）：点 chip 即过滤，
          chip 之间 OR，与上面的 tab / 搜索框 AND。无可用标签（词表为空或零命中）时
          组件自返 null，不占一行空白。 */}
      <TagBar
        counts={tagCounts}
        selected={tags}
        onToggle={(tag) =>
          setTags((s) => {
            const next = new Set(s);
            if (next.has(tag)) next.delete(tag);
            else next.add(tag);
            return next;
          })
        }
        onClear={() => setTags(new Set())}
      />

      {/* GatePanel 只渲染配置弹窗（原常驻规则牌已撤，牌面信息并入弹窗；用户决定
          2026-10-30）。改词表（工单 03）走工具栏「加入管道」右侧的「配置」按钮——误杀
          当场就能改、当场看到试算，而不是关掉页面去手改 portals.yml 再重扫；后者正是
          这一轮之前没人动词表的原因。
          只在 browser 路径挂载：ATS CLI 扫描同样过标题门，但被毙条数只活在它自己的
          scan-runs.tsv 里，页面侧拿不到——显示 0 是假话，比不显示更糟。 */}
      {isBsk && (
        <GatePanel
          positive={filters.positive}
          negative={filters.negative}
          kept={offers}
          folded={folded}
          onSaved={(p, n) => setFilters({ ...filters, positive: p, negative: n })}
          open={gateOpen}
          onOpenChange={setGateOpen}
          onDirtyChange={setGateDirty}
          preaddNegative={preadd}
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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
        <p className="py-10 text-center text-sm text-faint">
          {tags.size > 0
            ? t("explore.results.noTagMatch", { tags: [...tags].join("、") })
            : salaryMin
              ? t("explore.results.noSalaryMatch", { n: salaryMin })
              : q.trim()
                ? t("explore.results.noMatch", { q })
                : t("explore.results.tabEmpty")}
        </p>
      )}

      {/* 被采集门毙掉的岗位（ADR-0029 决议 4）：只读折叠区，回答「是不是误杀了我要的岗」。
          收件箱变干净不等于发现记录丢失——台账里那一行仍在。 */}
      <FilteredFold offers={folded} />
    </div>
  );
}

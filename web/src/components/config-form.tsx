"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Save,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { CadenceSettings } from "@/components/followups/cadence-settings";
import { JdRulesSettings } from "@/components/jd-rules-settings";
import { SkillsPanel } from "@/components/skills-panel";
import { AboutPanel } from "@/components/about-panel";
import { JobTargetSettings } from "@/components/job-target-settings";
import { persistCliId, persistModel, pushServerConfig, readSavedCliId, readSavedModel, readSavedUnknownEmployer, persistUnknownEmployer, readServerUnknownEmployer, mirrorUnknownEmployer, pickDefaultInstalled, type UnknownEmployerPolicy } from "@/lib/saved-cli";
import { readSavedConcurrencyPool, persistConcurrencyPool, CONCURRENCY_POOL_DEFAULT } from "@/lib/saved-cli";
import { resolveModelPicker } from "@/lib/model-picker.mjs";
import {
  readApplyBehavior,
  persistApplyBehavior,
  APPLY_BEHAVIOR_DEFAULT,
  type ApplyBehavior,
} from "@/lib/apply-behavior";
import {
  readScanSources,
  persistScanSources,
  cleanScanSources,
  SCAN_SOURCES,
  SCAN_SOURCE_DEFAULT,
  type ScanSource,
} from "@/lib/scan-mode";
import { readScanMax, persistScanMax, SCAN_MAX_DEFAULT } from "@/lib/scan-max.mjs";
import { readClisCache, writeClisCache } from "@/lib/clis-cache.mjs";
import { useI18n } from "@/lib/i18n/context";

type ModelOption = { id: string; label: string };
type ModelMeta = { flag: string; default: string; options: ModelOption[] };

/** 浏览器扫描三站采集上限的站点 key（与 scan-max.mjs 白名单一致）。 */
type BrowserSourceId = "zhipin" | "liepin" | "zhaopin";

type Cli = {
  id: string;
  name: string;
  run: string;
  url: string;
  installed: boolean;
  path: string | null;
  /** ADR-0028: installed ≠ usable（headless `--version` 探针），见 clis.ts。 */
  usable?: boolean;
  /** ADR-0053 决议 10：探测到的二进制自报的版本。 */
  version?: string;
  model: ModelMeta;
};

type Mode = "cli" | "key" | "manual";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)" },
  { id: "openai", label: "OpenAI" },
  { id: "google", label: "Google (Gemini)" },
  { id: "openrouter", label: "OpenRouter" },
  // agnes 仅用于快评（OpenAI 兼容端点），默认 baseUrl 见 quick-eval.ts。
  { id: "agnes", label: "Agnes AI" },
] as const;

// 全局并发上限的可选项（原型：纯数值选择 → <select> 下拉，1–8）。
const CONCURRENCY_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

const STORAGE_KEY = "career-ops:config";
// 快评配置独立存储对象：与 career-ops:config 完全隔离，改快评不影响 CLI 评估引擎。
// 只存 provider/model/baseUrl，密钥绝不进 localStorage（仅服务端 gitignore 文件持有）。
const QUICK_STORAGE_KEY = "career-ops:quickeval";

// 页内目录导航的六个区段：id 用于 IntersectionObserver 锚点与高亮。分组顺序即保存档位
// 顺序（统一保存 → 卡片内保存 → 只读），档位仅靠顺序表达——与已验收原型一致，侧栏不加标记。
const SECTIONS = [
  { id: "engine", labelKey: "config.navEngine" },
  { id: "scan", labelKey: "config.navScan" },
  { id: "ui", labelKey: "config.navUi" },
  { id: "target", labelKey: "config.navTarget" },
  { id: "followup", labelKey: "config.navFollowup" },
  { id: "skills", labelKey: "config.navSkills" },
  { id: "about", labelKey: "config.navAbout" },
] as const;

// 只有这三区（●）的草稿改动会进入底部悬浮保存条的 pending 计数；▣ 卡片内保存项各自落库，
// — 只读区无改动。默认显示语言虽排在界面区，但 setDefaultLang 即时生效、不经 save()，故不计入。
const UNIFIED_IDS = ["engine", "scan", "ui"];

export function ConfigForm() {
  const { t, lang, setLang, defaultLang, setDefaultLang } = useI18n();
  const [mode, setMode] = useState<Mode>("cli");
  const [clis, setClis] = useState<Cli[] | null>(null);
  const [cliId, setCliId] = useState<string>("");
  // The model currently being edited in the dropdown (may be unsaved).
  const [model, setModel] = useState<string>("");
  // The model that is actually persisted and in effect — the "current model"
  // readout reads THIS, not the in-flight dropdown value, so it stays on the
  // last-saved model until the user clicks Save.
  const [savedModel, setSavedModel] = useState<string>("");
  // The CLI the current model pick was saved under. Distinct from cliId so the
  // saved model is only dropped when the user explicitly switches CLI — never
  // when the freshly-fetched options just don't list it. "" (legacy configs)
  // means "unknown → belongs to the current CLI".
  const [modelCliId, setModelCliId] = useState<string>("");
  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  // 快评专用字段（model/baseUrl），与 CLI 模型的 model 状态隔离。
  const [quickModel, setQuickModel] = useState("agnes-2.5-flash");
  const [quickBaseUrl, setQuickBaseUrl] = useState("https://api.agnes-ai.cn/v1");
  const [logos, setLogos] = useState(true);
  const [applyBehavior, setApplyBehavior] = useState<ApplyBehavior>(APPLY_BEHAVIOR_DEFAULT);
  const [scanSource, setScanSource] = useState<ScanSource[]>([...SCAN_SOURCE_DEFAULT]);
  const [scanMax, setScanMax] = useState<Record<BrowserSourceId, number>>({ ...SCAN_MAX_DEFAULT });
  const [unknownEmployer, setUnknownEmployer] = useState<UnknownEmployerPolicy>("placeholder");
  // 服务端没收到策略写入时为 true：必须显示出来——丢写是静默的，而评估读的正是服务端。
  const [policySyncFailed, setPolicySyncFailed] = useState(false);
  const [concurrencyPool, setConcurrencyPool] = useState(CONCURRENCY_POOL_DEFAULT);
  const [saved, setSaved] = useState(false);
  const [mirrorFailed, setMirrorFailed] = useState(false);
  // 未安装工具的安装链接默认收起：默认视觉只留下拉，需要时再展开 6 个外链。
  const [showInstallLinks, setShowInstallLinks] = useState(false);
  // 「当前使用」回执读取的是已保存的工具，与 savedModel 同一原则 —— 保存前不跳。
  const [savedCliId, setSavedCliId] = useState("");
  // ADR-0015：检测结果的时间戳（null = 本浏览器还没成功检测过）与手动重检进行态。
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [rechecking, setRechecking] = useState(false);

  // 保存条的待保存计数：只登记「统一保存」三区里、经 save() 落库的草稿字段改动。
  // 用 Set 而非自增计数，保证「保存 N 项」反映的是改动字段数（同一字段反复改只算一项）。
  // 卡片内保存（求职意向/JD 规则/跟进节奏）在各自子组件里即时落库，天然不进这里。
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const touch = useCallback((key: string) => {
    setDirty((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  // 页内目录：当前高亮区 + 是否有「统一保存」区进入视口（决定悬浮保存条显隐）。
  const [activeId, setActiveId] = useState<string>("engine");
  const [unifiedVisible, setUnifiedVisible] = useState(false);
  const visibleUnified = useRef<Set<string>>(new Set());

  // Load saved prefs
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const v = JSON.parse(raw);
        // key/manual are not wired yet (nothing reads them) → never restore into
        // those dead panels; only the Installed-CLI path is functional.
        if (v.mode === "cli") setMode("cli");
        if (v.cliId) setCliId(v.cliId);
        if (v.model) setModel(v.model);
        // "Current model" reflects the last-saved (persisted) pick, not the
        // in-flight dropdown value.
        setSavedModel(v.model ?? "");
        // 「当前使用」回执同样是「最后一次保存的值」，不是下拉里的在途选择。
        setSavedCliId(v.cliId ?? "");
        // Legacy configs predate modelCliId — infer that the saved model
        // belongs to the CLI saved alongside it, so it is never dropped.
        if (v.modelCliId) setModelCliId(v.modelCliId);
        else if (v.model && v.cliId) setModelCliId(v.cliId);
        if (v.provider) setProvider(v.provider);
        if (typeof v.logos === "boolean") setLogos(v.logos);
      }
      // 快评配置回显：只读非密钥字段；provider 以快评存储为准（若存在）。
      const qraw = localStorage.getItem(QUICK_STORAGE_KEY);
      if (qraw) {
        const q = JSON.parse(qraw);
        if (q.provider) setProvider(q.provider);
        if (q.model) setQuickModel(q.model);
        if (q.baseUrl) setQuickBaseUrl(q.baseUrl);
        if (q.mode) setMode(q.mode as Mode);
      }
    } catch {
      /* ignore */
    }
    setApplyBehavior(readApplyBehavior());
    setScanSource(readScanSources());
    setScanMax(readScanMax() as Record<BrowserSourceId, number>);
    setUnknownEmployer(readSavedUnknownEmployer());
    // 未知雇主策略同样「服务端持真值」：完整评估读的是 /api/config（worker 是 headless
    // CLI，读不到 localStorage —— ADR-0004 D3），本地镜像只负责首屏绘制与报告页回退显示。
    // 两侧不一致时必须显示服务端那一档，否则配置页会显示一个评估根本不会用的策略
    // （报告 #836 就是这么来的：本地 agency、服务端 placeholder，评估按 placeholder 写了 `?`）。
    readServerUnknownEmployer().then((server) => {
      if (!server) return; // 服务端没值/不可达：保留本地镜像，不清空
      setUnknownEmployer(server);
      mirrorUnknownEmployer(server); // 让报告页回退显示与评估口径一致
    });
    // 全局并发上限是服务端持真值，异步读回回显。
    readSavedConcurrencyPool().then(setConcurrencyPool);
  }, []);

  // 缓存渲染与真查渲染共用同一条落地路径（ADR-0015）：下拉选中/自动保存逻辑
  // 幂等，两条路径的下拉行为必须完全一致。
  function applyClis(list: Cli[]) {
    setClis(list);
    // 未保存过选择时，默认选中本机安装的第一个可用 CLI 并持久化——
    // 只高亮不落盘时，派发端（resolveCliId / 服务端镜像）读到的仍是空配置。
    setCliId((prev) => {
      if (prev) return prev;
      const pick = pickDefaultInstalled(list);
      if (pick && !readSavedCliId()) persistCliId(pick);
      return pick || "";
    });
  }

  // ADR-0015: the runtime list is detected ONCE per browser. A usable
  // localStorage cache renders directly — no request, so reopening the page is
  // instant and never auto-rechecks. Only the first open (no cache yet — and a
  // failed check never writes one) hits /api/clis. The sole refresh path is
  // recheck().
  useEffect(() => {
    const cached = readClisCache();
    if (cached) {
      applyClis(cached.clis as Cli[]);
      setCheckedAt(cached.checkedAt);
      return;
    }
    fetch("/api/clis")
      .then((r) => r.json())
      .then((d) => {
        const list: Cli[] = d.clis ?? [];
        applyClis(list);
        writeClisCache(list);
        setCheckedAt(Date.now());
      })
      .catch(() => setClis([])); // 失败不落「已检查」标记：下次打开仍自动检测。
  }, []);

  // 手动重检：检测缓存的唯一失效途径（ADR-0015）。服务端 ?refresh=1 真查并
  // 回填进程内缓存（含 opencode 模型列表），成功后回写浏览器侧缓存；失败时
  // 保留旧结果，不打断用户。
  function recheck() {
    if (rechecking) return;
    setRechecking(true);
    fetch("/api/clis?refresh=1")
      .then((r) => r.json())
      .then((d) => {
        const list: Cli[] = d.clis ?? [];
        applyClis(list);
        writeClisCache(list);
        setCheckedAt(Date.now());
      })
      .catch(() => {
        /* 保留旧缓存与旧下拉 */
      })
      .finally(() => setRechecking(false));
  }

  function save() {
    // 未知雇主策略独立于评估引擎，任何模式保存都生效（快评跟随走 /api/config）。
    void persistUnknownEmployer(unknownEmployer).then((ok) => setPolicySyncFailed(!ok));
    // 浏览器扫描每站采集上限同样独立于评估引擎，任何模式保存都生效。
    persistScanMax(scanMax);
    // 全局并发上限也是服务端配置，任何模式保存都生效（引擎每次 dispatch 时读取）。
    void persistConcurrencyPool(concurrencyPool);
    // 用户点了保存 → 草稿成为已保存态，清空待计数。
    setDirty(new Set());
    // 快评（key 模式）：密钥 PUT 到服务端 gitignore 文件，只在前端存非密钥字段。
    if (mode === "key") {
      const savedProvider = provider;
      localStorage.setItem(
        QUICK_STORAGE_KEY,
        JSON.stringify({ mode, provider: savedProvider, model: quickModel, baseUrl: quickBaseUrl }),
      );
      // 快评模式下界面/扫描草稿（Logo/申请行为/扫描方式）与引擎无关，也要落库——
      // 合并写入保留已存的 CLI 引擎字段（cliId/model），避免保存条谎报「已保存 N 项」却丢写。
      try {
        const rawUi = localStorage.getItem(STORAGE_KEY);
        const prevUi = rawUi ? JSON.parse(rawUi) : {};
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            ...prevUi,
            logos,
            applyBehavior,
            scanSource: cleanScanSources(scanSource),
            unknownEmployer,
          }),
        );
      } catch {
        /* ignore */
      }
      persistApplyBehavior(applyBehavior);
      persistScanSources(scanSource);
      fetch("/api/quick-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: savedProvider,
          model: quickModel,
          baseUrl: quickBaseUrl,
          apiKey,
        }),
      })
        .then((r) => {
          if (!r.ok) throw new Error(`quick-config ${r.status}`);
        })
        .then(() => setSaved(true))
        .catch(() => setSaved(false));
      setTimeout(() => setSaved(false), 2000);
      return; // 快评密钥走服务端，不写入 career-ops:config。
    }
    // The API key is deliberately NOT persisted: nothing reads it yet (the
    // key/manual panel is unwired) and a secret must never sit in clear-text
    // localStorage. Keys belong in the user's own CLI/provider config.
    // model/modelCliId come from the picker: after a CLI switch the picker has
    // already dropped a stale model, so a Save can never resurrect it.
    const nextModel = picker?.model ?? model;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        mode,
        cliId,
        model: nextModel,
        modelCliId: nextModel ? modelCliId : "",
        provider,
        logos,
        applyBehavior,
        scanSource: cleanScanSources(scanSource),
        unknownEmployer,
      }),
    );
    // 申请行为 / 扫描方式各自独立读回（persistApplyBehavior/persistScanSources 保持
    // 与整包 STORAGE_KEY 写入同值，兼容只读单字段的消费方）。
    persistApplyBehavior(applyBehavior);
    persistScanSources(scanSource);
    // The persisted value is now the "current model" — only after Save.
    setSavedModel(nextModel);
    // 同理：保存后下拉选中的工具才成为「当前使用」。
    setSavedCliId(cliId);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    // ADR-0028 决议 3：服务端镜像写入结果必须可见——静默丢写正是
    // 「以为存了 claude、实际派发了 opencode」的根因（#836 同教训）。
    pushServerConfig({ cliId, model: nextModel }).then((ok) => setMirrorFailed(!ok));
  }

  const installed = clis?.filter((c) => c.installed) ?? [];
  // 未安装的工具只作为「还能用什么」的知情信息出现在禁用分组里，不进可选集合。
  const missing = clis?.filter((c) => !c.installed) ?? [];
  const selectedCli = clis?.find((c) => c.id === cliId) ?? null;
  // The tool the app is actually running on: the last-saved pick, falling back
  // to the current detection before anything was ever saved (mirrors
  // `currentModel` falling back to the CLI's own default).
  const currentCli = clis?.find((c) => c.id === (savedCliId || cliId)) ?? null;
  // The model the CLI runs with: the last-saved pick (always preserved — even
  // when the dynamic option list doesn't list it, it's injected back into the
  // dropdown so it renders as the selected value), else the CLI's own default.
  const picker = selectedCli
    ? resolveModelPicker({ model, modelCliId, cliId, options: selectedCli.model.options })
    : null;
  // The "current model" readout follows the PERSISTED pick — it must not jump
  // to whatever the user is previewing in the dropdown before clicking Save.
  const currentModel = savedModel || selectedCli?.model.default || "";
  // 检测时间戳的本地化显示（引擎头部与空态重检行共用）。
  const fmtChecked = (ms: number) =>
    new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { dateStyle: "short", timeStyle: "short" }).format(ms);

  // The model picker follows the selected CLI — but only when the user actually
  // switched CLI: the saved model stays untouched on page load even if the
  // freshly-fetched options don't list it (it must always display the saved
  // config). Dropping happens inside resolveModelPicker; here we just reconcile
  // state so a later Save doesn't persist a model the new CLI doesn't know.
  useEffect(() => {
    if (!picker || picker.model === model) return;
    setModel(picker.model);
    if (picker.model === "" && modelCliId) setModelCliId("");
  }, [picker, model, modelCliId]);

  // 页内目录导航：高亮当前区 + 追踪「统一保存」区是否进入视口（供悬浮保存条显隐）。
  // 两个观察器分工：navIo 决定侧栏/芯片哪个条目 active；uniIo 决定保存条是否因区可见而显示。
  // rootMargin 复刻原型（active 取视口上中段、unified 取上下留白）。
  useEffect(() => {
    const byId = (id: string) => document.getElementById(id);
    const navIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActiveId(e.target.id);
      },
      { rootMargin: "-25% 0px -65% 0px", threshold: 0 },
    );
    const uniIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visibleUnified.current.add(e.target.id);
          else visibleUnified.current.delete(e.target.id);
        }
        setUnifiedVisible(UNIFIED_IDS.some((id) => visibleUnified.current.has(id)));
      },
      { rootMargin: "-12% 0px -12% 0px", threshold: 0 },
    );
    for (const s of SECTIONS) {
      const el = byId(s.id);
      if (el) {
        navIo.observe(el);
        if (UNIFIED_IDS.includes(s.id)) uniIo.observe(el);
      }
    }
    // 页底兜底：最后一个区（关于）内容短、下方留白有限，滚到底时其顶部往往进不了
    // navIo 的观察带（视口上中段），高亮会卡在倒数第二个区。滚到页底时强制点亮最后一个区；
    // 离开页底向上滚时，navIo 会随各区重新进入观察带而纠正高亮。
    const lastId = SECTIONS[SECTIONS.length - 1].id;
    const onScroll = () => {
      const el = document.scrollingElement || document.documentElement;
      if (el.scrollTop + window.innerHeight >= el.scrollHeight - 4) setActiveId(lastId);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      navIo.disconnect();
      uniIo.disconnect();
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const pending = dirty.size;
  const showSaveBar = unifiedVisible || pending > 0 || saved;

  return (
    <div className="mx-auto grid max-w-[1320px] gap-10 px-7 pt-9 pb-[140px] max-[1100px]:block max-[1100px]:px-4 min-[1101px]:grid-cols-[150px_minmax(0,1fr)] min-[1101px]:items-start">
      {/* 窄屏：折叠为顶部横向滚动芯片导航 */}
      <nav className="sticky top-0 z-20 -mx-4 mb-4 flex gap-2 overflow-x-auto border-b border-border bg-background/85 px-4 py-2 backdrop-blur max-[1100px]:flex min-[1101px]:hidden">
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className={cn(
              "flex-none rounded-full border px-3 py-1.5 text-xs whitespace-nowrap transition-colors",
              activeId === s.id
                ? "border-brand bg-brand-soft font-semibold text-foreground"
                : "border-border bg-surface text-muted",
            )}
          >
            {t(s.labelKey)}
          </a>
        ))}
      </nav>

      {/* 宽屏：左侧 220px sticky 目录栏（档位只靠分组顺序表达，不加标记） */}
      <aside className="sticky top-9 hidden self-start max-[1100px]:hidden min-[1101px]:block">
        <nav className="flex flex-col gap-0.5">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className={cn(
                "flex items-center gap-2 rounded-[10px] border-l-[3px] px-2.5 py-2 text-[13.5px] transition-colors",
                activeId === s.id
                  ? "border-brand bg-brand-soft font-semibold text-foreground"
                  : "border-transparent text-muted hover:bg-surface-hover hover:text-foreground",
              )}
            >
              {t(s.labelKey)}
            </a>
          ))}
        </nav>
      </aside>

      <div className="min-w-0">
        {/* ① AI 引擎（● 统一保存） */}
        <Section id="engine" title={t("config.navEngine")} desc={t("config.secEngineDesc")}>
          <div className="mb-4 grid gap-2.5 sm:grid-cols-3">
            <RadioChoice
              selected={mode === "cli"}
              onSelect={() => {
                setMode("cli");
                touch("mode");
              }}
              title={t("config.modeCli")}
              desc={t("config.recommended")}
            />
            <RadioChoice
              selected={mode === "key"}
              onSelect={() => {
                setMode("key");
                touch("mode");
              }}
              title={t("config.modeKey")}
              desc={t("config.modeKeyHint")}
            />
            <RadioChoice
              selected={mode === "manual"}
              onSelect={() => {
                setMode("manual");
                touch("mode");
              }}
              title={t("config.modeManual")}
              desc={t("config.comingSoon")}
              disabled
            />
          </div>

          {mode === "cli" && (
            <div>
              {clis === null ? (
                <div className="flex items-center gap-2 text-sm text-muted">
                  <Loader2 className="size-4 animate-spin" /> {t("config.checking")}
                </div>
              ) : installed.length === 0 ? (
                <>
                  <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
                    {t("config.noCli1")} <span className="text-foreground">OpenCode</span> {t("config.noCli2")}{" "}
                    <a
                      href="https://career-ops.org/docs/free-ai-engine"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-0.5 text-brand hover:underline"
                    >
                      {t("config.getOneFree")} <ExternalLink className="size-3" />
                    </a>
                  </div>
                  {/* 空态（一个都没装）恰恰最需要手动重检入口：刚装好工具时从这里刷新。 */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-faint">
                    {checkedAt !== null && <span>{t("config.lastChecked", { time: fmtChecked(checkedAt) })}</span>}
                    <button
                      type="button"
                      onClick={recheck}
                      disabled={rechecking}
                      className="flex items-center gap-1 transition-colors hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]"
                    >
                      {rechecking && <Loader2 className="size-3.5 animate-spin" />}
                      {rechecking ? t("config.rechecking") : t("config.recheck")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {/* CLI 引擎卡（复刻原型 engine-card）：顶部「当前使用」渐变回执头（工具名 +
                      版本 + 上次检测 + 重新检测），下方 AI 工具 / 模型 双列选择器。 */}
                  <div className="overflow-hidden rounded-[14px] border border-border bg-surface">
                    {currentCli && (
                      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-gradient-to-b from-brand-soft to-transparent px-5 py-3.5">
                        <div className="flex min-w-0 flex-wrap items-baseline gap-2.5">
                          <span className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-brand">
                            {t("config.currentTool")}
                          </span>
                          <span className="font-display text-[25px] leading-none text-landing">{currentCli.name}</span>
                          {currentCli.version && (
                            <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 font-mono text-[11px] text-muted">
                              v{currentCli.version}
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-faint">
                          {checkedAt !== null && <span>{t("config.lastChecked", { time: fmtChecked(checkedAt) })}</span>}
                          <button
                            type="button"
                            onClick={recheck}
                            disabled={rechecking}
                            className="rounded-lg border border-border bg-surface px-3 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
                          >
                            {rechecking && <Loader2 className="mr-1 inline size-3 animate-spin" />}
                            {rechecking ? t("config.rechecking") : t("config.recheck")}
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="grid gap-[22px] p-5 [grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr))]">
                      {/* 左列：AI 工具（含探测来源、usable 警告、未安装工具的展开安装链接） */}
                      <div>
                        <SelectField
                          label={t("config.aiTool")}
                          desc={t("config.aiToolDesc")}
                          size="md"
                          value={cliId}
                          onChange={(v) => {
                            setCliId(v);
                            touch("cliId");
                          }}
                        >
                          <optgroup label={t("config.aiToolGroupInstalled")}>
                            {installed.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                                {c.usable === false ? ` — ${t("config.cliUnusable")}` : ""}
                              </option>
                            ))}
                          </optgroup>
                          {missing.length > 0 && (
                            // 未安装的工具整组禁用：保留「还能用什么」的知情权，但不可选中。
                            <optgroup label={t("config.aiToolGroupMissing")} disabled>
                              {missing.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.name}
                                </option>
                              ))}
                            </optgroup>
                          )}
                        </SelectField>
                        {/* ADR-0053 决议 10：探测来源可见。同一个引擎的二进制可能来自
                            不止一处（CodeBuddy：厂商安装器，或另一个产品捆绑的副本），
                            而它们会各自升级——路径 + `--version` 让「这次用的是哪一个」
                            在界面上可回答，而不是只能靠进程表反推。 */}
                        {currentCli?.path && (
                          <p className="mt-1.5 truncate font-mono text-[11px] text-faint" title={currentCli.path}>
                            {currentCli.path}
                            {currentCli.version ? ` · ${currentCli.version}` : ""}
                          </p>
                        )}
                        {/* ADR-0028：installed ≠ usable——headless 无输出的工具派发必败，就地警告。 */}
                        {selectedCli?.usable === false && (
                          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                            <span>{t("config.cliUnusableWarn", { name: currentCli?.name ?? selectedCli.name })}</span>
                          </div>
                        )}
                        {missing.length > 0 && (
                          <div className="mt-2">
                            <button
                              type="button"
                              onClick={() => setShowInstallLinks((v) => !v)}
                              aria-expanded={showInstallLinks}
                              className="flex items-center gap-1.5 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
                            >
                              <ChevronRight
                                className={cn("size-3.5 transition-transform", showInstallLinks && "rotate-90")}
                              />
                              {t("config.aiToolMissingCount", { count: missing.length })}
                              {" · "}
                              {showInstallLinks ? t("config.aiToolHideInstall") : t("config.aiToolShowInstall")}
                            </button>
                            {showInstallLinks && (
                              <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                                {missing.map((c) => (
                                  <li key={c.id}>
                                    <a
                                      href={c.url}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-surface/30 px-3 py-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                                    >
                                      <span className="truncate">{c.name}</span>
                                      <ExternalLink className="size-3 shrink-0 text-brand" />
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                      {/* 右列：模型（沿用 CLI 自带模型目录；无目录时如实说明而非留空） */}
                      <div>
                        {selectedCli && selectedCli.model?.options.length > 0 && (
                          <>
                            <SelectField
                              label={t("config.model")}
                              desc={t("config.modelDesc")}
                              size="md"
                              value={picker?.model ?? model}
                              onChange={(v) => {
                                setModel(v);
                                setModelCliId(cliId);
                                touch("model");
                              }}
                            >
                              <option value="">
                                {t("config.modelDefault", { model: selectedCli.model.default || t("config.modelAuto") })}
                              </option>
                              {(picker?.options ?? selectedCli.model.options).map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.label}
                                </option>
                              ))}
                            </SelectField>
                            {selectedCli.model.flag && (
                              <p className="mt-2 inline-flex items-center gap-1 text-[11px] text-faint">
                                <Sparkles className="size-3" />
                                <span className="font-mono">{t("config.modelFlag")} {selectedCli.model.flag}</span>
                              </p>
                            )}
                            {currentModel && (
                              <div className="mt-3 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft/40 px-3 py-2 text-sm">
                                <Sparkles className="size-4 shrink-0 text-brand" />
                                <span className="text-muted">{t("config.currentModel")}</span>
                                <span className="min-w-0 truncate font-mono text-foreground">{currentModel}</span>
                              </div>
                            )}
                          </>
                        )}
                        {/* ADR-0052: a runtime whose catalogue is read from the CLI can
                            legitimately have none to show (not signed in / offline). Say
                            so instead of rendering nothing at all — a missing picker
                            with no explanation reads as a broken page. */}
                        {selectedCli && selectedCli.model?.options.length === 0 && (
                          <p className="rounded-xl border border-border bg-surface/50 p-4 text-[11px] leading-relaxed text-faint">
                            {t("config.modelUnavailable")}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-faint">
                    {t("config.cliWorksWith")} {t("config.bestOn1")}{" "}
                    <span className="text-muted">Claude Code</span> {t("config.bestOn2")}
                  </p>
                </>
              )}
            </div>
          )}

          {mode === "key" && (
            <div className="space-y-4">
              <div className="rounded-xl border border-border bg-surface/50 p-4">
                <p className="mb-3 text-xs leading-relaxed text-faint">{t("config.quickEvalDesc")}</p>
                <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                  {t("config.provider")}
                </span>
                <div className="grid gap-2 sm:grid-cols-2">
                  {PROVIDERS.map((p) => (
                    <RadioChoice
                      key={p.id}
                      selected={provider === p.id}
                      onSelect={() => {
                        setProvider(p.id);
                        // 切换 provider 时同步默认端点到 baseUrl 输入框（用户仍可改）。
                        if (p.id === "agnes") setQuickBaseUrl("https://api.agnes-ai.cn/v1");
                        if (p.id === "openai") setQuickBaseUrl("https://api.openai.com/v1");
                        if (p.id === "openrouter") setQuickBaseUrl("https://openrouter.ai/api/v1");
                        touch("provider");
                      }}
                      title={p.label}
                    />
                  ))}
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-surface/50 p-4">
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    {t("config.pasteKey")}
                  </label>
                  <p className="mb-2 text-xs text-faint">{t("config.bringKey")}</p>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      touch("apiKey");
                    }}
                    placeholder="sk-…"
                    autoComplete="off"
                    className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
                  />
                  <p className="mt-2 text-xs text-faint">{t("config.keyStored")}</p>
                </div>
                <div className="rounded-xl border border-border bg-surface/50 p-4">
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    {t("config.quickModel")}
                  </label>
                  <input
                    type="text"
                    value={quickModel}
                    onChange={(e) => {
                      setQuickModel(e.target.value);
                      touch("quickModel");
                    }}
                    placeholder="agnes-2.5-flash"
                    autoComplete="off"
                    className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
                  />
                  <label className="mt-3 mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    {t("config.quickBaseUrl")}
                  </label>
                  <input
                    type="text"
                    value={quickBaseUrl}
                    onChange={(e) => {
                      setQuickBaseUrl(e.target.value);
                      touch("quickBaseUrl");
                    }}
                    placeholder="https://api.agnes-ai.cn/v1"
                    autoComplete="off"
                    className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
                  />
                  <p className="mt-2 text-xs text-faint">{t("config.quickBaseUrlHint")}</p>
                </div>
              </div>
            </div>
          )}

          {mode === "manual" && (
            <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
              {t("config.manualDesc")}
            </div>
          )}

          {/* 全局并发上限：web 端(web 单卡/批量/浏览器扩展)同时运行的评估 CLI 子进程总数上限。
              原型规则「纯数值选择 → <select> 下拉」，与 AI 工具/模型共用同一 SelectField。 */}
          <div className="mt-4">
            <SelectField
              layout="row"
              label={t("config.concurrencyTitle")}
              desc={t("config.concurrencyDesc")}
              value={String(concurrencyPool)}
              onChange={(v) => {
                const n = parseInt(v, 10);
                setConcurrencyPool(Number.isFinite(n) && n >= 1 ? n : CONCURRENCY_POOL_DEFAULT);
                touch("concurrencyPool");
              }}
            >
              {[
                ...(CONCURRENCY_OPTIONS.includes(concurrencyPool)
                  ? CONCURRENCY_OPTIONS
                  : [...CONCURRENCY_OPTIONS, concurrencyPool].sort((a, b) => a - b)),
              ].map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </SelectField>
            <p className="mt-2 text-xs text-faint">{t("config.concurrencyNote")}</p>
          </div>
        </Section>

        {/* ② 扫描采集（● 统一保存） */}
        <Section id="scan" title={t("config.navScan")} desc={t("config.secScanDesc")}>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))]">
            <div className="rounded-xl border border-border bg-surface p-4">
              <span className="block text-[13px] font-semibold text-foreground">{t("config.scanSourceTitle")}</span>
              <p className="mb-3 mt-0.5 text-xs leading-relaxed text-faint">{t("config.scanSourceDesc")}</p>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {SCAN_SOURCES.map((s) => {
                  const on = scanSource.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => {
                        // 至少保留一个启用引擎，避免扫描 tab 无子 tab 可用。
                        const next = on ? scanSource.filter((x) => x !== s) : [...scanSource, s];
                        setScanSource(cleanScanSources(next));
                        touch("scanSource");
                      }}
                      aria-pressed={on}
                      className={cn(
                        "rounded-xl border px-3.5 py-3 text-left transition-colors",
                        on ? "border-brand/50 bg-brand-soft" : "border-border bg-surface/50 hover:bg-surface-hover",
                      )}
                    >
                      <span className="block text-sm font-medium text-foreground">
                        {s === "ats" ? t("config.scanSourceAts") : t("config.scanSourceBsk")}
                      </span>
                      <span className="mt-1 block text-xs text-faint">
                        {s === "ats" ? t("config.scanSourceAtsDesc") : t("config.scanSourceBskDesc")}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-surface p-4">
              <span className="block text-[13px] font-semibold text-foreground">{t("config.scanMaxTitle")}</span>
              <p className="mb-2 mt-0.5 text-xs leading-relaxed text-faint">{t("config.scanMaxDesc")}</p>
              <div className="flex flex-col">
                {/* 展示顺序对齐原型：猎聘(1200) 置顶（其默认值是该区要点）→ BOSS直聘 → 智联招聘。
                    数据 key 与 scan-max.mjs 白名单不变，仅固定渲染顺序，不再跟随 Object.keys 的插入序。 */}
                {(["liepin", "zhipin", "zhaopin"] as BrowserSourceId[]).map((src, i) => {
                  const label = src === "zhipin" ? "BOSS直聘" : src === "liepin" ? "猎聘" : "智联招聘";
                  return (
                    <div
                      key={src}
                      className={cn(
                        "flex items-center justify-between gap-4 py-2.5",
                        i > 0 && "border-t border-border",
                      )}
                    >
                      <span className="min-w-0 text-sm text-foreground">{label}</span>
                      <input
                        type="number"
                        min={1}
                        step={100}
                        value={scanMax[src]}
                        aria-label={`${label} · ${t("config.scanMaxTitle")}`}
                        onChange={(e) => {
                          const n = parseInt(e.target.value, 10);
                          const next = { ...scanMax };
                          next[src] = Number.isFinite(n) && n > 0 ? n : SCAN_MAX_DEFAULT[src];
                          setScanMax(next);
                          touch("scanMax");
                        }}
                        className="no-number-spin w-24 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-right text-sm tabular-nums text-foreground outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
                      />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </Section>

        {/* ③ 界面与交互（● 统一保存）——含从旧「申请与跟进」区迁入的未知雇主、申请按钮行为 */}
        <Section id="ui" title={t("config.navUi")} desc={t("config.secUiDesc")}>
          <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-border bg-surface px-4 py-3">
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{t("config.companyLogos")}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-faint">{t("config.logosDesc")}</span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={logos}
              aria-label={t("config.companyLogos")}
              onClick={() => {
                setLogos((v) => !v);
                touch("logos");
              }}
              className={cn(
                "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors",
                logos ? "border-brand bg-brand" : "border-border bg-surface-hover",
              )}
            >
              <span
                className={cn(
                  "absolute size-5 rounded-full bg-white shadow transition-transform",
                  logos ? "translate-x-[1.375rem]" : "translate-x-0.5",
                )}
              />
            </button>
          </div>

          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
            <div className="rounded-xl border border-border bg-surface p-4">
              <h3 className="font-display text-[17px] font-medium leading-tight text-landing">{t("config.defaultLangTitle")}</h3>
              <p className="mb-3 mt-1 text-xs leading-relaxed text-faint">{t("config.defaultLangDesc")}</p>
              <div className="grid gap-2.5">
                <RadioChoice
                  selected={defaultLang === "en"}
                  onSelect={() => setDefaultLang("en")}
                  title={t("config.langEnglish")}
                />
                <RadioChoice
                  selected={defaultLang === "zh"}
                  onSelect={() => setDefaultLang("zh")}
                  title={t("config.langChinese")}
                />
              </div>
              <p className="mt-3 text-[11px] text-faint">{t("config.immediateNote")}</p>
              <p className="mt-3 flex flex-wrap items-center gap-1 text-xs text-faint">
                {t("config.currentLang", {
                  lang: lang === "en" ? t("config.langEnglish") : t("config.langChinese"),
                })}
                {lang !== defaultLang && (
                  <button type="button" onClick={() => setLang(defaultLang)} className="text-brand hover:underline">
                    {t("config.switchNow")}
                  </button>
                )}
              </p>
            </div>

            <div className="rounded-xl border border-border bg-surface p-4">
              <h3 className="font-display text-[17px] font-medium leading-tight text-landing">{t("config.unknownEmployerTitle")}</h3>
              <p className="mb-3 mt-1 text-xs leading-relaxed text-faint">{t("config.unknownEmployerDesc")}</p>
              {/* 未知雇主策略：并入「界面与交互」区的统一保存档位——选中只改草稿并计入
                  pending，点「保存设置」时由 save() 落库（本地镜像 + 服务端 /api/config 同步，
                  与 logos/applyBehavior 同路）。 */}
              <div className="grid gap-2.5">
                <RadioChoice
                  selected={unknownEmployer === "placeholder"}
                  onSelect={() => {
                    setUnknownEmployer("placeholder");
                    touch("unknownEmployer");
                  }}
                  title={t("config.unknownEmployerPlaceholder")}
                  desc={t("config.unknownEmployerPlaceholderDesc")}
                />
                <RadioChoice
                  selected={unknownEmployer === "agency"}
                  onSelect={() => {
                    setUnknownEmployer("agency");
                    touch("unknownEmployer");
                  }}
                  title={t("config.unknownEmployerAgency")}
                  desc={t("config.unknownEmployerAgencyDesc")}
                />
              </div>
              {policySyncFailed && (
                <p className="mt-2 text-xs text-amber-600 dark:text-amber-400" role="alert">
                  {t("config.unknownEmployerSyncFailed")}
                </p>
              )}
            </div>

            <div className="rounded-xl border border-border bg-surface p-4">
              <h3 className="font-display text-[17px] font-medium leading-tight text-landing">{t("config.applyBehaviorTitle")}</h3>
              <p className="mb-3 mt-1 text-xs leading-relaxed text-faint">{t("config.applyBehaviorDesc")}</p>
              <div className="grid gap-2.5">
                <RadioChoice
                  selected={applyBehavior === "link"}
                  onSelect={() => {
                    setApplyBehavior("link");
                    touch("applyBehavior");
                  }}
                  title={t("config.applyBehaviorLink")}
                  desc={t("config.applyBehaviorLinkDesc")}
                />
                <RadioChoice
                  selected={applyBehavior === "form"}
                  onSelect={() => {
                    setApplyBehavior("form");
                    touch("applyBehavior");
                  }}
                  title={t("config.applyBehaviorForm")}
                  desc={t("config.applyBehaviorFormDesc")}
                />
              </div>
            </div>
          </div>
        </Section>

        {/* ④ 定向规则（▣ 卡片内保存）：求职意向 + JD 评估规则两张并排卡 */}
        <Section id="target" title={t("config.navTarget")} desc={t("config.secTargetDesc")}>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr))]">
            <JobTargetSettings />
            <JdRulesSettings />
          </div>
        </Section>

        {/* ⑤ 跟进节奏（▣ 卡片内保存）：6 天数字段两组并排 */}
        <Section id="followup" title={t("config.navFollowup")} desc={t("config.secFollowupDesc")}>
          <CadenceSettings />
        </Section>

        {/* ⑥ Agent 技能（— 只读）：知情展示，不拦截任何功能 */}
        <Section id="skills" title={t("config.navSkills")} desc={t("config.skillsDesc")}>
          <SkillsPanel />
        </Section>

        {/* ⑦ 关于（— 只读）：版本信息 + 报告问题入口，从旧的左下角悬浮胶囊迁入 */}
        <Section id="about" title={t("config.navAbout")} desc={t("config.secAboutDesc")}>
          <AboutPanel />
        </Section>
      </div>

      {/* 底部悬浮保存条：仅收「● 统一保存」三区。仅当视口内有统一保存区、或有待保存改动、
          或刚保存成功时显示；待保存数写进按钮文案；点保存后短暂「已保存」再归零。 */}
      <div
        className={cn(
          "fixed bottom-6 left-1/2 z-30 -translate-x-1/2 transition-all duration-200 max-[640px]:w-[calc(100%-28px)]",
          showSaveBar ? "opacity-100" : "invisible translate-y-4 opacity-0",
        )}
      >
        <div className="flex items-center gap-2 rounded-[14px] bg-[#241b12] px-2 py-2 shadow-[0_14px_40px_rgb(30_20_5/0.30),0_2px_8px_rgb(30_20_5/0.20)] max-[640px]:w-full max-[640px]:justify-center">
          <button
            type="button"
            onClick={save}
            className="inline-flex items-center gap-2 rounded-[10px] bg-brand px-[18px] py-2.5 text-[13.5px] font-semibold text-brand-foreground transition-colors hover:bg-brand-200"
          >
            {saved ? <Check className="size-4" /> : <Save className="size-4" />}
            {saved
              ? t("config.saved")
              : pending > 0
                ? t("config.saveBarCount", { count: pending })
                : t("config.saveConfig")}
          </button>
          {mirrorFailed && (
            // ADR-0028 决议 3：服务端镜像丢写必须可见（#836 同教训）。
            <span className="pr-2 text-xs font-medium text-amber-300">{t("config.mirrorFailed")}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** 区段容器：id 供目录导航锚点 + IntersectionObserver 观察；serif 标题 + 简介。
 *  scroll-mt 让锚点跳转避开顶部（窄屏芯片栏 sticky）。 */
function Section({
  id,
  title,
  desc,
  children,
}: {
  id: string;
  title: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 pt-11 first:pt-0">
      <h2 className="font-display text-[22px] font-medium tracking-tight text-landing">{title}</h2>
      {desc ? <p className="mb-3.5 mt-1 text-xs leading-relaxed text-faint">{desc}</p> : null}
      {children}
    </section>
  );
}

/** 统一「单选卡」控件：圆点 + 标题 + 可选说明。所有带标签的单选项（引擎模式、快评
 *  provider、默认语言、未知雇主、申请按钮行为）都走这里，视觉一致；多选（扫描方式）
 *  保留独立切换卡以区分。纯原生 <button> + aria-pressed，键盘/读屏交给原生按钮语义。 */
function RadioChoice({
  selected,
  onSelect,
  title,
  desc,
  disabled,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  desc?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={disabled ? undefined : onSelect}
      className={cn(
        "flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-border bg-surface/30 opacity-55"
          : selected
            ? "border-brand/50 bg-brand-soft"
            : "border-border bg-surface/50 hover:bg-surface-hover",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full border-2 transition-colors",
          selected && !disabled ? "border-brand" : "border-border",
        )}
      >
        <span className={cn("size-2 rounded-full bg-brand transition-transform", selected ? "scale-100" : "scale-0")} />
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold text-foreground">{title}</span>
        {desc ? <span className="mt-0.5 block text-xs leading-relaxed text-faint">{desc}</span> : null}
      </span>
    </button>
  );
}

/** 本页所有下拉的统一实现：原生 <select> + 自绘箭头。用原生控件（而非自绘
 *  combobox）是因为它自带键盘/读屏支持与移动端原生选择器，本项目不需要原生
 *  控件给不了的能力。`size` 只区分页内两种既有的视觉档位，不引入第三套。
 *  `layout="row"` 把文案放左、下拉放右（原型 row-card），仍共用同一个
 *  relative 包装——保证全页只有一个自绘下拉实现。现用于：AI 工具、模型、并发上限。 */
function SelectField({
  label,
  desc,
  size = "md",
  layout = "stack",
  value,
  onChange,
  className,
  children,
}: {
  label: string;
  desc?: string;
  size?: "sm" | "md";
  layout?: "stack" | "row";
  value: string;
  onChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const selectBlock = (
    <div className="relative">
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full appearance-none border border-border bg-surface/60 pr-9 text-sm text-foreground outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40",
          size === "sm" ? "rounded-lg px-3 py-2" : "rounded-xl px-4 py-3",
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
    </div>
  );
  if (layout === "row") {
    return (
      <div
        className={cn(
          "flex items-center justify-between gap-5 rounded-xl border border-border bg-surface px-4 py-3",
          className,
        )}
      >
        <div className="min-w-0">
          <label htmlFor={id} className="block text-[13px] font-semibold text-foreground">
            {label}
          </label>
          {desc ? <p className="mt-0.5 text-xs leading-relaxed text-faint">{desc}</p> : null}
        </div>
        <div className="w-28 shrink-0">{selectBlock}</div>
      </div>
    );
  }
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted"
      >
        {label}
      </label>
      {desc ? <p className="mb-2 text-xs leading-relaxed text-faint">{desc}</p> : null}
      {selectBlock}
    </div>
  );
}

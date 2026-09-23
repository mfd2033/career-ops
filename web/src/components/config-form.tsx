"use client";

import { useEffect, useId, useState } from "react";
import {
  AlertTriangle,
  Check,
  KeyRound,
  TerminalSquare,
  Terminal,
  Loader2,
  ExternalLink,
  ChevronDown,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { CadenceSettings } from "@/components/followups/cadence-settings";
import { JdRulesSettings } from "@/components/jd-rules-settings";
import { JobTargetSettings } from "@/components/job-target-settings";
import { persistCliId, persistModel, pushServerConfig, readSavedCliId, readSavedModel, readSavedUnknownEmployer, persistUnknownEmployer, readServerUnknownEmployer, mirrorUnknownEmployer, type UnknownEmployerPolicy } from "@/lib/saved-cli";
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
import { readScanWrapUp, persistScanWrapUp, SCAN_WRAPUP_DEFAULT } from "@/lib/scan-wrapup.mjs";
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

const STORAGE_KEY = "career-ops:config";
// 快评配置独立存储对象：与 career-ops:config 完全隔离，改快评不影响 CLI 评估引擎。
// 只存 provider/model/baseUrl，密钥绝不进 localStorage（仅服务端 gitignore 文件持有）。
const QUICK_STORAGE_KEY = "career-ops:quickeval";

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
  const [scanWrapUp, setScanWrapUp] = useState<boolean>(SCAN_WRAPUP_DEFAULT);
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
    setScanWrapUp(readScanWrapUp());
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
    // Highlight + persist the only installed CLI when Config was never saved.
    // Highlight-only used to look configured while jobs still read empty localStorage.
    setCliId((prev) => {
      if (prev) return prev;
      const only = list.filter((c) => c.installed && c.usable !== false);
      if (only.length !== 1) return list.find((c) => c.installed)?.id || "";
      if (!readSavedCliId()) persistCliId(only[0].id);
      return only[0].id;
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
    // 扫描收尾开关同样独立于评估引擎，任何模式保存都生效。
    persistScanWrapUp(scanWrapUp);
    // 全局并发上限也是服务端配置，任何模式保存都生效（引擎每次 dispatch 时读取）。
    void persistConcurrencyPool(concurrencyPool);
    // 快评（key 模式）：密钥 PUT 到服务端 gitignore 文件，只在前端存非密钥字段。
    if (mode === "key") {
      const savedProvider = provider;
      localStorage.setItem(
        QUICK_STORAGE_KEY,
        JSON.stringify({ mode, provider: savedProvider, model: quickModel, baseUrl: quickBaseUrl }),
      );
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

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-landing">{t("config.title")}</h1>
      <p className="mt-1 text-sm text-muted">
        {t("config.intro")}
      </p>

      {/* Engine mode */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.aiEngine")}
      </label>
      <div className="grid gap-2 sm:grid-cols-3">
        <ModeCard
          active={mode === "cli"}
          onClick={() => setMode("cli")}
          icon={Terminal}
          title={t("config.modeCli")}
          hint={t("config.recommended")}
        />
        <ModeCard
          active={mode === "key"}
          onClick={() => setMode("key")}
          icon={KeyRound}
          title={t("config.modeKey")}
          hint={t("config.modeKeyHint")}
        />
        <ModeCard
          active={mode === "manual"}
          onClick={() => setMode("manual")}
          icon={TerminalSquare}
          title={t("config.modeManual")}
          hint={t("config.comingSoon")}
          disabled
        />
      </div>

      <div className="mt-6">
        {mode === "cli" && (
          <div>
            <p className="mb-1 text-sm text-muted">
              {t("config.cliDesc")}
            </p>
            <p className="mb-3 text-xs text-faint">{t("config.cliWorksWith")}</p>
            {clis === null ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="size-4 animate-spin" /> {t("config.checking")}
              </div>
            ) : installed.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
                {t("config.noCli1")} <span className="text-foreground">OpenCode</span> {t("config.noCli2")}{" "}
                <a href="https://career-ops.org/docs/free-ai-engine" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline">
                  {t("config.getOneFree")} <ExternalLink className="size-3" />
                </a>
              </div>
            ) : (
              <div className="space-y-2">
                <SelectField
                  label={t("config.aiTool")}
                  desc={t("config.aiToolDesc")}
                  size="md"
                  value={cliId}
                  onChange={setCliId}
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

                {currentCli && (
                  <div className="mt-3 flex items-center gap-2 rounded-lg border border-brand/30 bg-brand-soft/40 px-3 py-2 text-sm">
                    <Sparkles className="size-4 shrink-0 text-brand" />
                    <span className="text-muted">{t("config.currentTool")}</span>
                    <span className="min-w-0 truncate font-medium text-foreground">{currentCli.name}</span>
                  </div>
                )}

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
                <p className="mt-2 text-[11px] leading-relaxed text-faint">
                  {t("config.bestOn1")} <span className="text-muted">Claude Code</span> {t("config.bestOn2")}
                </p>

                {selectedCli && selectedCli.model?.options.length > 0 && (
                  <div className="mt-4 rounded-xl border border-border bg-surface/50 p-4">
                    <SelectField
                      label={t("config.model")}
                      desc={t("config.modelDesc")}
                      size="sm"
                      value={picker?.model ?? model}
                      onChange={(v) => {
                        setModel(v);
                        setModelCliId(cliId);
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
                  </div>
                )}
                {/* ADR-0052: a runtime whose catalogue is read from the CLI can
                    legitimately have none to show (not signed in / offline). Say
                    so instead of rendering nothing at all — a missing picker
                    with no explanation reads as a broken page. */}
                {selectedCli && selectedCli.model?.options.length === 0 && (
                  <p className="mt-4 rounded-xl border border-border bg-surface/50 p-4 text-[11px] leading-relaxed text-faint">
                    {t("config.modelUnavailable")}
                  </p>
                )}
              </div>
            )}
            {/* 检测状态行：cli 模式三态（检测中/空/列表）都渲染——空态（一个都没
                装）恰恰是最需要手动重检入口的场景，刚装好工具后从这里刷新。 */}
            {clis !== null && (
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-faint">
                {checkedAt !== null && (
                  <span>
                    {t("config.lastChecked", {
                      time: new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", {
                        dateStyle: "short",
                        timeStyle: "short",
                      }).format(checkedAt),
                    })}
                  </span>
                )}
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
            )}
          </div>
        )}

        {mode === "key" && (
          <div className="space-y-5">
            <p className="text-xs text-faint">{t("config.quickEvalDesc")}</p>
            <div>
              <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                {t("config.provider")}
              </label>
              <div className="grid gap-2 sm:grid-cols-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      setProvider(p.id);
                      // 切换 provider 时同步默认端点到 baseUrl 输入框（用户仍可改）。
                      if (p.id === "agnes") setQuickBaseUrl("https://api.agnes-ai.cn/v1");
                      if (p.id === "openai") setQuickBaseUrl("https://api.openai.com/v1");
                      if (p.id === "openrouter") setQuickBaseUrl("https://openrouter.ai/api/v1");
                    }}
                    className={cn(
                      "rounded-xl border px-4 py-2.5 text-left text-sm transition-colors",
                      provider === p.id
                        ? "border-brand/50 bg-brand-soft text-foreground"
                        : "border-border bg-surface/50 text-muted hover:bg-surface-hover hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                {t("config.pasteKey")}
              </label>
              <p className="mb-2 text-xs text-faint">{t("config.bringKey")}</p>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-…"
                autoComplete="off"
                className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
              />
              <p className="mt-2 text-xs text-faint">
                {t("config.keyStored")}
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                {t("config.quickModel")}
              </label>
              <input
                type="text"
                value={quickModel}
                onChange={(e) => setQuickModel(e.target.value)}
                placeholder="agnes-2.5-flash"
                autoComplete="off"
                className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                {t("config.quickBaseUrl")}
              </label>
              <input
                type="text"
                value={quickBaseUrl}
                onChange={(e) => setQuickBaseUrl(e.target.value)}
                placeholder="https://api.agnes-ai.cn/v1"
                autoComplete="off"
                className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 font-mono text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50"
              />
              <p className="mt-2 text-xs text-faint">{t("config.quickBaseUrlHint")}</p>
            </div>
          </div>
        )}

        {mode === "manual" && (
          <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
            {t("config.manualDesc")}
          </div>
        )}
      </div>

      {/* Appearance / privacy */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.appearance")}
      </label>
      <button
        type="button"
        onClick={() => setLogos((v) => !v)}
        className="flex w-full items-center justify-between gap-4 rounded-xl border border-border bg-surface/50 px-4 py-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{t("config.companyLogos")}</span>
          <span className="mt-0.5 block text-xs text-faint">
            {t("config.logosDesc")}
          </span>
        </span>
        <span
          className={cn(
            "relative h-6 w-11 shrink-0 rounded-full transition-colors",
            logos ? "bg-brand" : "bg-surface-hover",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform",
              logos ? "translate-x-[1.375rem]" : "translate-x-0.5",
            )}
          />
        </span>
      </button>

      {/* Default display language */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.defaultLangTitle")}
      </label>
      <div className="rounded-xl border border-border bg-surface/50 px-4 py-3">
        <p className="mb-3 text-xs text-faint">{t("config.defaultLangDesc")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setDefaultLang("en")}
            aria-pressed={defaultLang === "en"}
            className={cn(
              "rounded-lg border px-4 py-2 text-sm transition-colors max-sm:min-h-[44px]",
              defaultLang === "en"
                ? "border-brand/50 bg-brand-soft text-foreground"
                : "border-border bg-surface/50 text-muted hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {t("config.langEnglish")}
          </button>
          <button
            type="button"
            onClick={() => setDefaultLang("zh")}
            aria-pressed={defaultLang === "zh"}
            className={cn(
              "rounded-lg border px-4 py-2 text-sm transition-colors max-sm:min-h-[44px]",
              defaultLang === "zh"
                ? "border-brand/50 bg-brand-soft text-foreground"
                : "border-border bg-surface/50 text-muted hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {t("config.langChinese")}
          </button>
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-faint">
            {t("config.currentLang", {
              lang: lang === "en" ? t("config.langEnglish") : t("config.langChinese"),
            })}
            {lang !== defaultLang && (
              <button
                type="button"
                onClick={() => setLang(defaultLang)}
                className="text-brand hover:underline"
              >
                {t("config.switchNow")}
              </button>
            )}
          </span>
        </div>
      </div>

      {/* 申请按钮行为：管道页 Apply 按钮点击后做什么 */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.applyBehaviorTitle")}
      </label>
      <p className="mb-3 text-xs text-faint">{t("config.applyBehaviorDesc")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setApplyBehavior("link")}
          className={cn(
            "rounded-xl border px-4 py-3 text-left transition-colors",
            applyBehavior === "link"
              ? "border-brand/50 bg-brand-soft"
              : "border-border bg-surface/50 hover:bg-surface-hover",
          )}
        >
          <span className="block text-sm font-medium text-foreground">{t("config.applyBehaviorLink")}</span>
          <span className="mt-1 block text-xs text-faint">{t("config.applyBehaviorLinkDesc")}</span>
        </button>
        <button
          type="button"
          onClick={() => setApplyBehavior("form")}
          className={cn(
            "rounded-xl border px-4 py-3 text-left transition-colors",
            applyBehavior === "form"
              ? "border-brand/50 bg-brand-soft"
              : "border-border bg-surface/50 hover:bg-surface-hover",
          )}
        >
          <span className="block text-sm font-medium text-foreground">{t("config.applyBehaviorForm")}</span>
          <span className="mt-1 block text-xs text-faint">{t("config.applyBehaviorFormDesc")}</span>
        </button>
      </div>

      {/* 扫描方式：探索页「扫描」tab 内启用哪些引擎（多选，勾选才显示对应子 tab） */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.scanSourceTitle")}
      </label>
      <p className="mb-3 text-xs text-faint">{t("config.scanSourceDesc")}</p>
      <div className="grid gap-2 sm:grid-cols-2">
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
              }}
              aria-pressed={on}
              className={cn(
                "rounded-xl border px-4 py-3 text-left transition-colors",
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

      {/* 浏览器扫描每站采集上限：分页型平台(猎聘)大关键词会撞 400 默认上限截掉末页,
          此处按站点覆盖。猎聘默认 1200, BOSS/智联懒加载保持 400。*/}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.scanMaxTitle")}
      </label>
      <p className="mb-3 text-xs text-faint">{t("config.scanMaxDesc")}</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(SCAN_MAX_DEFAULT) as BrowserSourceId[]).map((src) => {
          const label = src === "zhipin" ? "BOSS直聘" : src === "liepin" ? "猎聘" : "智联招聘";
          return (
            <label key={src} className="block rounded-xl border border-border bg-surface/50 px-4 py-3">
              <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
              <input
                type="number"
                min={1}
                step={100}
                value={scanMax[src]}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  const next = { ...scanMax };
                  next[src] = Number.isFinite(n) && n > 0 ? n : SCAN_MAX_DEFAULT[src];
                  setScanMax(next);
                }}
                className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
              />
            </label>
          );
        })}
      </div>

      {/* 扫描收尾开关（ADR-0007 E9）：扫描跑完把浏览器切回探索页 tab。只切 tab、
          不抢窗口、不关闭招聘站 tab；关掉后停在原页面，「探索页被关则停采集」不受影响。*/}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.scanWrapUpTitle")}
      </label>
      <p className="mb-3 text-xs text-faint">{t("config.scanWrapUpDesc")}</p>
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-surface/50 px-4 py-3">
        <input
          type="checkbox"
          checked={scanWrapUp}
          onChange={(e) => setScanWrapUp(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-brand"
        />
        <span className="text-sm text-foreground">{t("config.scanWrapUpLabel")}</span>
      </label>

      {/* 全局并发上限：web 端(web 单卡/批量/浏览器扩展)同时运行的评估 CLI 子进程总数上限 */}
      <label className="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">
        {t("config.concurrencyTitle")}
      </label>
      <p className="mb-3 text-xs text-faint">{t("config.concurrencyDesc")}</p>
      <input
        type="number"
        min={1}
        step={1}
        value={concurrencyPool}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          setConcurrencyPool(Number.isFinite(n) && n >= 1 ? n : CONCURRENCY_POOL_DEFAULT);
        }}
        className="w-full rounded-xl border border-border bg-surface/60 px-4 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
      />
      <p className="mt-2 text-xs text-faint">{t("config.concurrencyNote")}</p>

      {/* 未知雇主处理策略：offer 隐藏终端雇主时代招方如何显示 */}
      <SelectField
        className="mt-8"
        label={t("config.unknownEmployerTitle")}
        desc={t("config.unknownEmployerDesc")}
        size="md"
        value={unknownEmployer}
        onChange={(v) => {
          const policy = v as UnknownEmployerPolicy;
          setUnknownEmployer(policy);
          // 选中即落库，不等「保存」按钮：只改下拉的话本地镜像与服务端会分叉，
          // 而分叉是静默的——配置页显示新档位，每次评估却仍按服务端旧值走（#836）。
          void persistUnknownEmployer(policy).then((ok) => setPolicySyncFailed(!ok));
        }}
      >
        <option value="placeholder">{t("config.unknownEmployerPlaceholder")}</option>
        <option value="agency">{t("config.unknownEmployerAgency")}</option>
      </SelectField>
      <p className="mt-2 text-xs text-faint">
        {unknownEmployer === "placeholder"
          ? t("config.unknownEmployerPlaceholderDesc")
          : t("config.unknownEmployerAgencyDesc")}
      </p>
      {policySyncFailed && (
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400" role="alert">
          {t("config.unknownEmployerSyncFailed")}
        </p>
      )}

      <JobTargetSettings />

      <CadenceSettings />

      <JdRulesSettings />

      <div className="mt-8 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-brand px-5 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
        >
          {saved ? <Check className="size-4" /> : null}
          {saved ? t("config.saved") : t("config.saveConfig")}
        </button>
        <span className="text-xs text-faint">{t("config.localFirstRoadmap")}</span>
        {mirrorFailed && (
          // ADR-0028 决议 3：服务端镜像丢写必须可见（#836 同教训）。
          <span className="text-xs font-medium text-amber-700 dark:text-amber-400">{t("config.mirrorFailed")}</span>
        )}
      </div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  icon: Icon,
  title,
  hint,
  disabled,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border px-4 py-3 text-left transition-colors",
        disabled
          ? "cursor-not-allowed border-border bg-surface/30 opacity-55"
          : active
            ? "border-brand/50 bg-brand-soft"
            : "border-border bg-surface/50 hover:bg-surface-hover",
      )}
    >
      <Icon className={cn("size-4", active && !disabled ? "text-brand" : "text-muted")} />
      <span className="text-sm font-medium text-foreground">{title}</span>
      <span className="text-xs text-faint">{hint}</span>
    </button>
  );
}

/** 本页所有下拉的统一实现：原生 <select> + 自绘箭头。用原生控件（而非自绘
 *  combobox）是因为它自带键盘/读屏支持与移动端原生选择器，本项目不需要原生
 *  控件给不了的能力。`size` 只区分页内两种既有的视觉档位，不引入第三套。 */
function SelectField({
  label,
  desc,
  size = "md",
  value,
  onChange,
  className,
  children,
}: {
  label: string;
  desc?: string;
  size?: "sm" | "md";
  value: string;
  onChange: (value: string) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-semibold uppercase tracking-[0.18em] text-muted"
      >
        {label}
      </label>
      {desc ? <p className="mb-2 text-xs text-faint">{desc}</p> : null}
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
    </div>
  );
}

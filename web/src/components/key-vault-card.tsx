"use client";

// key-vault-card.tsx — 配置页「AI 引擎 · 粘贴密钥」档的密钥库卡（ADR-0083）。
//
// 一把密钥 = 一份完整密钥束（名称+provider+模型+端点+密钥），点行即切换使用中并
// 立即落盘生效（绕开底部保存条——「使用中」徽标显示的永远已是事实）。
// 明文密钥不经过本组件：GET/PUT 只回库视图（打码串）；编辑时密钥字段留空 =
// 保持原密钥不变，填入非空值才整体替换（决议 3）。删除是行内确认，删使用中
// 那把自动切剩余第一把（决议 4）。交互形态以已确认原型为准
// （.scratch/api-key-vault-proto）。

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n/context";

/** 服务端 vaultView() 的镜像形状（无明文密钥，也不会有）。 */
type VaultKeyView = {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  masked: string;
  addedAt: string;
  lastTest: string;
};
type VaultView = { configured: boolean; activeId: string | null; keys: VaultKeyView[] };

// provider 预设与旧面板一致；base/model 只在新建/编辑表单里做默认值联动，
// 未列默认值的 provider（anthropic/google）留空由用户自填 OpenAI 兼容端点。
const PROVIDERS = [
  { id: "anthropic", label: "Anthropic (Claude)", base: "", model: "claude-haiku-4-5" },
  { id: "openai", label: "OpenAI", base: "https://api.openai.com/v1", model: "gpt-5.1-mini" },
  { id: "google", label: "Google (Gemini)", base: "", model: "gemini-2.5-flash" },
  { id: "openrouter", label: "OpenRouter", base: "https://openrouter.ai/api/v1", model: "" },
  { id: "agnes", label: "Agnes AI", base: "https://api.agnes-ai.cn/v1", model: "agnes-2.5-flash" },
];
const provOf = (id: string) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[1];

export function KeyVaultCard() {
  const { t } = useI18n();
  const [view, setView] = useState<VaultView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // 正在等待服务端确认的密钥 id（activate/remove）：行保持可点但转圈，防双击乱序。
  const [pendingId, setPendingId] = useState<string | null>(null);
  // 展开删除确认条的密钥 id：同一时刻最多一条，点行/取消即收起。
  const [confirmDelId, setConfirmDelId] = useState<string | null>(null);
  // 最近一次连接测试的结果条（按密钥 id 挂在行下）与进行中态（ADR-0083 工单 04）。
  const [testNote, setTestNote] = useState<{ id: string; ok: boolean; reason?: string; latencyMs?: number; failed?: boolean } | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; seq: number } | null>(null);
  const toastSeq = useRef(0);

  const say = useCallback((text: string) => {
    toastSeq.current += 1;
    setToast({ text, seq: toastSeq.current });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    fetch("/api/quick-config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((v: VaultView) => setView(v))
      .catch(() => setLoadFailed(true));
  }, []);

  // PUT 的响应体就是新库视图（服务端写盘后只回打码串）——直接采用，省一次 GET，
  // 也让「界面显示的」与「盘上落的」在同一次往返里对齐。
  const put = useCallback(
    async (body: Record<string, unknown>): Promise<VaultView | null> => {
      try {
        const r = await fetch("/api/quick-config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) return null;
        const v = await r.json();
        setView(v);
        return v as VaultView;
      } catch {
        return null;
      }
    },
    [],
  );

  async function activate(id: string) {
    if (!view || id === view.activeId || pendingId) return;
    setConfirmDelId(null);
    setTestNote(null);
    setPendingId(id);
    const before = view;
    const next = await put({ action: "activate", id });
    setPendingId(null);
    if (!next) {
      // 失败回滚到切换前：徽标绝不能显示一个没生效的「使用中」（ADR-0073 同教训）。
      setView(before);
      say(t("config.vaultSwitchFailed"));
      return;
    }
    const name = next.keys.find((k) => k.id === id)?.name || id;
    say(t("config.vaultSwitched", { name }));
  }

  async function remove(id: string) {
    if (!view || pendingId) return;
    setPendingId(id);
    const wasActive = view.activeId === id;
    const name = view.keys.find((k) => k.id === id)?.name || id;
    const next = await put({ action: "remove", id });
    setPendingId(null);
    setConfirmDelId(null);
    if (!next) {
      say(t("config.vaultDeleteFailed"));
      return;
    }
    // 删除回执分三种：删空 / 删掉使用中那把（服务端已自动切）/ 删备用那把。
    if (next.keys.length === 0) say(t("config.vaultDeletedEmpty"));
    else if (wasActive) say(t("config.vaultDeletedActive", { name: next.keys.find((k) => k.id === next.activeId)?.name || "" }));
    else say(t("config.vaultDeleted", { name }));
  }

  // 行内连接测试：服务端用库里已存的整束探测，响应顺带新库视图（刷徽标）。
  // 外层 12s 必须大于服务端探测内层 8s（quick-eval-timeout 同族预算层级）。
  async function testKey(id: string) {
    if (testingId) return;
    setTestingId(id);
    setTestNote(null);
    setConfirmDelId(null);
    try {
      const r = await fetch("/api/quick-eval/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keyId: id }),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(String(r.status));
      const v = await r.json();
      if (v.keys) setView(v);
      setTestNote({ id, ok: Boolean(v.ok), reason: v.reason, latencyMs: v.latencyMs });
    } catch {
      setTestNote({ id, ok: false, failed: true });
    } finally {
      setTestingId(null);
    }
  }

  /** 失败分类 → 可操作文案（错误处理需包含解决步骤的仓库规范）。 */
  function testFailText(reason?: string, failed?: boolean) {
    if (failed) return t("config.vaultTestError");
    switch (reason) {
      case "auth":
        return t("config.vaultTestFailAuth");
      case "notFound":
        return t("config.vaultTestFailNotFound");
      case "timeout":
        return t("config.vaultTestFailTimeout");
      case "network":
        return t("config.vaultTestFailNetwork");
      default:
        return t("config.vaultTestFailHttp");
    }
  }

  // ── 添加 / 编辑表单（同一张内联表单，editingId 区分两态） ─────────────
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [fName, setFName] = useState("");
  const [fProv, setFProv] = useState("agnes");
  const [fKey, setFKey] = useState("");
  const [fModel, setFModel] = useState("agnes-2.5-flash");
  const [fBase, setFBase] = useState("https://api.agnes-ai.cn/v1");
  const [fSaving, setFSaving] = useState(false);
  const [reveal, setReveal] = useState(false);
  // 表单内的草稿测试态：测试失败不阻断存入，只是把原因摆在按钮旁边。
  const [fTesting, setFTesting] = useState(false);
  const [fTestNote, setFTestNote] = useState<{ ok: boolean; reason?: string; latencyMs?: number; failed?: boolean } | null>(null);
  // 端点/模型是否仍跟随 provider 默认（用户改过一次就不再联动）。
  const autoBase = useRef(true);
  const autoModel = useRef(true);
  const nameRef = useRef<HTMLInputElement>(null);

  function openForm(prefill?: VaultKeyView) {
    setEditingId(prefill?.id ?? null);
    setFKey("");
    setReveal(false);
    setConfirmDelId(null);
    setFTestNote(null);
    if (prefill) {
      // 编辑态只预填非密钥字段——密钥明文本来就不回前端（决议 3）。
      setFName(prefill.name);
      setFProv(prefill.provider || "agnes");
      setFModel(prefill.model);
      setFBase(prefill.baseUrl);
      autoBase.current = false;
      autoModel.current = false;
    } else {
      setFName("");
      autoBase.current = true;
      autoModel.current = true;
      const p = provOf(fProv);
      setFModel(p.model);
      setFBase(p.base);
    }
    setFormOpen(true);
    // 展开即聚焦名称：表单的全部字段都在视口内，光标就是说明书。
    setTimeout(() => nameRef.current?.focus(), 50);
  }

  function pickProvider(id: string) {
    setFProv(id);
    setFTestNote(null);
    const p = provOf(id);
    if (autoBase.current) setFBase(p.base);
    if (autoModel.current) setFModel(p.model);
  }

  // 表单内测试：粘了密钥就测草稿（不落盘）；编辑态留空则测库里已存的那把。
  async function testForm() {
    if (fTesting) return;
    const key = fKey.trim();
    if (!key && !editingId) {
      say(t("config.vaultNeedKey"));
      return;
    }
    setFTesting(true);
    setFTestNote(null);
    try {
      const body = key || !editingId
        ? { provider: fProv, model: fModel.trim(), baseUrl: fBase.trim(), key }
        : { keyId: editingId };
      const r = await fetch("/api/quick-eval/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error(String(r.status));
      const v = await r.json();
      if (v.keys) setView(v);
      setFTestNote({ ok: Boolean(v.ok), reason: v.reason, latencyMs: v.latencyMs });
    } catch {
      setFTestNote({ ok: false, failed: true });
    } finally {
      setFTesting(false);
    }
  }

  async function submitForm() {
    if (!view || fSaving) return;
    const key = fKey.trim();
    // 新建必须带密钥；编辑留空 = 保持原密钥不变（决议 3 的前端侧）。
    if (!editingId && !key) {
      say(t("config.vaultNeedKey"));
      return;
    }
    setFSaving(true);
    const p = provOf(fProv);
    const name = fName.trim() || `${p.label} · ${new Date().getFullYear()}`;
    const fields = { name, provider: fProv, model: fModel.trim(), baseUrl: fBase.trim() };
    let next: VaultView | null;
    if (editingId) {
      next = await put({ action: "update", id: editingId, ...fields, ...(key ? { key } : {}) });
      if (next) say(t("config.vaultUpdated", { name }));
      else say(t("config.vaultUpdateFailed"));
    } else {
      next = await put({ action: "add", ...fields, key });
      if (next) {
        // 决议 4：存入 ≠ 启用。库里原本没密钥时第一把自动启用（与迁移语义一致）。
        say(next.keys.length === 1 ? t("config.vaultAddedFirst") : t("config.vaultSaveReceipt"));
      } else {
        say(t("config.vaultAddFailed"));
      }
    }
    setFSaving(false);
    if (next) setFormOpen(false);
  }

  // ── 渲染 ──────────────────────────────────────────────────────────────

  if (loadFailed) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
        {t("config.vaultLoadFailed")}
      </div>
    );
  }
  if (view === null) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/50 p-4 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" /> {t("config.checking")}
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-[14px] border border-border bg-surface" aria-label={t("config.vaultTitle")}>
      <header className="flex items-baseline justify-between gap-3 px-[18px] pb-3 pt-3.5">
        <span className="text-[13px] font-bold tracking-wide text-foreground">{t("config.vaultTitle")}</span>
        {view.keys.length > 0 && (
          <span className="text-[11.5px] text-faint">{t("config.vaultCount", { count: view.keys.length })}</span>
        )}
      </header>

      {view.keys.length === 0 && (
        <p className="border-t border-border px-[18px] py-6 text-center text-[13px] text-faint">
          {t("config.vaultEmpty")}
        </p>
      )}

      <div role="radiogroup" aria-label={t("config.vaultTitle")}>
        {view.keys.map((k) => {
          const active = k.id === view.activeId;
          return (
            <div key={k.id}>
              <div
                role="radio"
                aria-checked={active}
                tabIndex={0}
                onClick={() => activate(k.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    activate(k.id);
                  }
                }}
                className={cn(
                  "group relative block w-full cursor-pointer border-t border-border px-[18px] py-3.5 text-left transition-colors",
                  active ? "bg-brand-soft" : "hover:bg-brand/[0.04]",
                  pendingId === k.id && "opacity-60",
                )}
              >
                {active && <span aria-hidden="true" className="absolute bottom-0 left-0 top-0 w-[3px] bg-brand" />}
                <span className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      "mt-[3px] grid size-4 shrink-0 place-items-center rounded-full border-[1.5px]",
                      active ? "border-brand" : "border-border",
                    )}
                  >
                    {active && <span className="size-2 rounded-full bg-brand" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-foreground">{k.name}</span>
                      {active && (
                        <span className="rounded-full border-[1.5px] border-brand bg-surface px-2 py-px text-[10.5px] font-bold tracking-wider text-brand-text">
                          {t("config.vaultInUse")}
                        </span>
                      )}
                      <span className="rounded-full border border-border bg-surface px-2 py-px text-[10.5px] font-semibold uppercase tracking-wider text-muted">
                        {provOf(k.provider).label.replace(/ \(.*\)/, "")}
                      </span>
                    </span>
                    <span className="mt-1 block font-mono text-xs text-muted">
                      {k.masked}
                      {k.model && <span className="font-sans"> · {k.model}</span>}
                      {/* 上次测试结果徽标：数据源是服务端 lastTest（真探测，不是装饰）。 */}
                      {k.lastTest === "ok" && (
                        <span className="font-sans font-semibold text-emerald-700 dark:text-emerald-400"> · {t("config.vaultTestBadgeOk")}</span>
                      )}
                      {k.lastTest === "fail" && (
                        <span className="font-sans font-semibold text-red-700/90 dark:text-red-400"> · {t("config.vaultTestBadgeFail")}</span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-faint">{t("config.vaultAdded", { date: k.addedAt })}</span>
                  </span>
                  {/* 行内操作：hover/聚焦浮现（触屏常显）。点击不冒泡——它们是动词，不是「选中」。 */}
                  <span
                    className={cn(
                      "flex shrink-0 gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-md:opacity-100",
                      active && "opacity-100",
                    )}
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        testKey(k.id);
                      }}
                      className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                    >
                      {testingId === k.id && <Loader2 className="size-3 animate-spin" />}
                      {testingId === k.id ? t("config.vaultTesting") : t("config.vaultTest")}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openForm(k);
                      }}
                      className="rounded-lg px-2.5 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                    >
                      {t("config.vaultEdit")}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelId(confirmDelId === k.id ? null : k.id);
                      }}
                      className="rounded-lg px-2.5 py-1 text-xs text-muted transition-colors hover:bg-red-500/10 hover:text-red-600"
                    >
                      {t("config.vaultDelete")}
                    </button>
                    {pendingId === k.id && <Loader2 className="mt-1 size-4 animate-spin text-brand" />}
                  </span>
                </span>
              </div>
              {testNote && testNote.id === k.id && (
                // 测试结果条：成功给延迟回执，失败按分类给可操作排查步骤。
                <div
                  className={cn(
                    "mx-4 mb-2 flex items-start gap-2 rounded-[10px] border px-3 py-2 text-[12.5px] leading-relaxed",
                    testNote.ok
                      ? "border-emerald-500/40 bg-emerald-500/[0.08] text-emerald-800 dark:text-emerald-300"
                      : "border-amber-500/45 bg-amber-500/10 text-amber-800 dark:text-amber-300",
                  )}
                >
                  <span className="font-bold">{testNote.ok ? "✓" : "✗"}</span>
                  <span>
                    {testNote.ok ? t("config.vaultTestOk", { ms: String(testNote.latencyMs ?? "") }) : testFailText(testNote.reason, testNote.failed)}
                  </span>
                </div>
              )}
              {confirmDelId === k.id && (
                // 删除确认是行内的，不弹全局对话框；确认即物理删除并落盘（决议 4）。
                <div className="mx-4 mb-2 flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-red-500/35 bg-red-500/[0.06] px-3 py-2 text-[12.5px]">
                  <span className="text-red-800/90 dark:text-red-300">{t("config.vaultDeleteQ", { name: k.name, masked: k.masked })}</span>
                  <span className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => setConfirmDelId(null)}
                      className="rounded-lg border border-border bg-surface px-3 py-1 text-xs font-semibold text-muted hover:text-foreground"
                    >
                      {t("config.vaultCancel")}
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(k.id)}
                      className="rounded-lg border border-red-600 bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:brightness-95"
                    >
                      {t("config.vaultDelete")}
                    </button>
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!formOpen ? (
        <button
          type="button"
          onClick={() => openForm()}
          className="mx-[18px] my-4 flex w-[calc(100%-36px)] items-center justify-center gap-2 rounded-[11px] border-[1.5px] border-dashed border-border py-2.5 text-[13px] font-semibold text-brand-text transition-colors hover:border-brand/50 hover:bg-brand-soft"
        >
          <span aria-hidden="true" className="text-base leading-none">＋</span> {t("config.vaultAddNew")}
        </button>
      ) : (
        <div className="border-t border-border bg-surface-hover/40 p-[18px]">
          <div className="grid gap-4 sm:grid-cols-2">
            <VaultField label={t("config.vaultFieldName")} hint={t("config.vaultFieldNameHint")}>
              <input
                ref={nameRef}
                type="text"
                value={fName}
                maxLength={40}
                onChange={(e) => setFName(e.target.value)}
                placeholder={t("config.vaultFieldNamePh")}
                className={vaultInput}
              />
            </VaultField>
            <VaultField label={t("config.provider")}>
              <div role="radiogroup" aria-label={t("config.provider")} className="flex flex-wrap gap-1.5 pt-1">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={p.id === fProv}
                    onClick={() => pickProvider(p.id)}
                    className={cn(
                      "rounded-full border px-3 py-1 text-[12.5px] transition-colors",
                      p.id === fProv
                        ? "border-brand bg-brand-soft font-semibold text-brand-text"
                        : "border-border bg-surface text-muted hover:text-foreground",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </VaultField>
            <VaultField
              label={t("config.vaultKeyLabel")}
              hint={editingId ? t("config.vaultKeyKeepHint") : t("config.vaultKeyStored")}
              full
            >
              <span className="relative block">
                <input
                  type={reveal ? "text" : "password"}
                  value={fKey}
                  onChange={(e) => setFKey(e.target.value)}
                  placeholder={editingId ? t("config.vaultKeyKeepPh") : "sk-…"}
                  autoComplete="off"
                  // 表单里的密钥永远先当密码框对待：默认打点、明示可临时摊开。
                  className={cn(vaultInput, "pr-[74px] font-mono text-[12.5px]")}
                />
                <button
                  type="button"
                  onClick={() => setReveal((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-border bg-surface px-2 py-0.5 text-[11.5px] font-semibold text-muted hover:text-foreground"
                >
                  {reveal ? t("config.vaultHide") : t("config.vaultReveal")}
                </button>
              </span>
            </VaultField>
            <VaultField label={t("config.quickModel")}>
              <input
                type="text"
                value={fModel}
                onChange={(e) => {
                  autoModel.current = e.target.value.trim() !== provOf(fProv).model;
                  setFModel(e.target.value);
                }}
                placeholder="agnes-2.5-flash"
                autoComplete="off"
                className={cn(vaultInput, "font-mono text-[12.5px]")}
              />
            </VaultField>
            <VaultField label={t("config.quickBaseUrl")} hint={t("config.quickBaseUrlHint")}>
              <input
                type="text"
                value={fBase}
                onChange={(e) => {
                  autoBase.current = e.target.value.trim() !== provOf(fProv).base;
                  setFBase(e.target.value);
                }}
                placeholder="https://api.agnes-ai.cn/v1"
                autoComplete="off"
                className={cn(vaultInput, "font-mono text-[12.5px]")}
              />
            </VaultField>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <button
                type="button"
                disabled={fTesting}
                onClick={testForm}
                className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-4 py-2 text-[13px] font-semibold text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-50"
              >
                {fTesting && <Loader2 className="size-3.5 animate-spin" />}
                {fTesting ? t("config.vaultTesting") : t("config.vaultTestConn")}
              </button>
              {fTestNote && (
                <span className={cn("text-xs leading-relaxed", fTestNote.ok ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400")}>
                  {fTestNote.ok ? t("config.vaultTestOk", { ms: String(fTestNote.latencyMs ?? "") }) : testFailText(fTestNote.reason, fTestNote.failed)}
                </span>
              )}
            </span>
            <span className="flex gap-2">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="rounded-[10px] border border-transparent px-4 py-2 text-[13px] font-semibold text-muted hover:bg-surface-hover hover:text-foreground"
            >
              {t("config.vaultCancel")}
            </button>
            <button
              type="button"
              disabled={fSaving}
              onClick={submitForm}
              className="rounded-[10px] border border-brand bg-brand px-4 py-2 text-[13px] font-semibold text-brand-foreground transition-colors hover:bg-brand-200 hover:border-brand-200 disabled:opacity-50"
            >
              {editingId ? t("config.vaultUpdate") : t("config.vaultSave")}
            </button>
            </span>
          </div>
        </div>
      )}

      {toast && (
        // 页内轻提示：位于保存条上方，密钥操作的回执（切换/存入/失败）都从这里出。
        <div
          key={toast.seq}
          role="status"
          className="fixed bottom-[92px] left-1/2 z-40 max-w-[min(520px,90vw)] -translate-x-1/2 rounded-[10px] bg-[#241b12] px-4 py-2 text-[13px] text-[#f7f6f3] shadow-[0_8px_28px_rgb(30_20_5/0.30)]"
        >
          {toast.text}
        </div>
      )}
    </section>
  );
}

const vaultInput =
  "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40";

function VaultField({
  label,
  hint,
  full,
  children,
}: {
  label: string;
  hint?: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", full && "sm:col-span-2")}>
      <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-relaxed text-faint">{hint}</span>}
    </label>
  );
}

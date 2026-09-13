"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  DEFAULT_FILTERS,
  ATS_LABEL,
  BROWSER_LABEL,
  BROWSER_SOURCES,
  filtersToParams,
  aiToParams,
  isBroadSearch,
  parseExplorePatch,
  browserToParams,
  applyBrowserSalaryGate,
  type AtsSource,
  type BrowserSource,
  type DiscoveredOffer,
  type ExploreFilters,
  type ExploreMode,
  type ScanEvent,
} from "@/lib/explore";
import { makeAiStreamParser, type AiTraceChunk } from "@/lib/explore-ai";
import { MAX_OFFER_LIMIT } from "@/lib/whats-new.mjs";
import { isScannerMissing, isBrowserCollectorMissing } from "@/lib/explore-error.mjs";
import { expandSearchTargets } from "@/lib/browser-search.mjs";
import { readScanMax } from "@/lib/scan-max.mjs";
import { useI18n } from "@/lib/i18n/context";
import {
  readScanSources,
  SCAN_SOURCE_DEFAULT,
  type ScanSource,
} from "@/lib/scan-mode";

export type Phase =
  | "idle"
  | "casting"
  | "scanning"
  | "revealing"
  | "results"
  | "empty-current"
  | "empty-loose"
  | "failed"
  | "degraded" // scan completed but searched nothing (transient fetch/rate-limit) — not "all caught up"
  | "hunting" // AI search streaming
  | "blocked"; // AI search needs a CLI
export type AiCost = { searches: number; candidates: number; fetches: number };
export type SourceState = {
  state: "queued" | "active" | "swept" | "noisy";
  companies?: number;
  done?: number;
  total?: number;
  matches?: number;
  unreachable?: number;
};
/** Per-source progress. Keys are AtsSource ids in scan mode and BrowserSource
 *  ids in browser mode — a string key keeps both surfaces on one shape. */
export type SourceMap = Partial<Record<string, SourceState>>;

type ExploreCtx = {
  filters: ExploreFilters;
  setFilters: (f: ExploreFilters) => void;
  /** Set filters from a seed/URL only if the user/assistant hasn't touched them
   *  yet — so a fresh page mount can't clobber assistant-set filters. */
  initFilters: (f: ExploreFilters) => void;
  phase: Phase;
  running: boolean;
  offers: DiscoveredOffer[];
  sources: SourceMap;
  matchCount: number;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  status: string;
  partial: boolean;
  error: string;
  /** The failure was the structured "scanner absent from this checkout" 400,
   *  not a runtime scan error, so it drives the "full toolkit" panel over a retry. */
  scannerMissing: boolean;
  added: Set<string>;
  adding: Set<string>;
  discover: () => Promise<void>;
  /** Browser mode over the Chinese boards (BOSS直聘/猎聘/智联) via the user's
   *  own logged-in browser — free, needs the bsk CLI + a connected browser. */
  discoverBrowser: () => Promise<void>;
  /** Load the SUPPLY-loop offers Today's "Fresh matches this week" already
   *  fetched from /api/whats-new, straight into the results phase — no scan. */
  loadFresh: () => Promise<void>;
  addToPipeline: (offers: DiscoveredOffer[]) => Promise<number>;
  applyPatch: (raw: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => void;
  reset: () => void;
  // ── AI search (modes/discover.md) ──
  mode: ExploreMode;
  setMode: (m: ExploreMode) => void;
  /** 扫描 tab 内当前选中的扫描引擎（ATS 或 BSK）。 */
  scanSource: ScanSource;
  setScanSource: (s: ScanSource) => void;
  /** 配置勾选的「扫描方式」集合 —— 决定扫描 tab 内可见的子 tab。 */
  enabledSources: ScanSource[];
  aiIntent: string;
  setAiIntent: (s: string) => void;
  discoverAI: () => Promise<void>;
  aiTrace: AiTraceChunk[];
  aiCost: AiCost;
};

const Ctx = createContext<ExploreCtx | null>(null);
export function useExplore(): ExploreCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useExplore must be used within <ExploreProvider>");
  return c;
}

// Explore results are expensive (a scan walks the ATS network; an AI search spends
// tokens). Persist the SETTLED result set per-tab so a reload or a mode toggle never
// throws the work away (disc#5 — "came back to explore, work is lost").
const RESULTS_KEY = "career-ops:explore-results";
type ResultSnapshot = {
  v: number;
  mode: ExploreMode;
  scanSource?: ScanSource;
  phase: Phase;
  offers: DiscoveredOffer[];
  matchCount: number;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  sources: SourceMap;
  partial: boolean;
  status: string;
  error: string;
  scannerMissing: boolean;
  added: string[];
  aiTrace: AiTraceChunk[];
  aiCost: AiCost;
  aiIntent: string;
};

// ── 扩展桥(localhost 页面 → 扩展 background,ADR-0007 E5)──────────────────────
const EXT_BRIDGE_TAG = "__careerExt";
let extMsgSeq = 0;

/** 探索页 → 扩展 SW(req/res 经 web-bridge.js content script 转发)。桥缺失/超时 → {ok:false}。
 *  timeoutMs 可配:普通探测默认 4s;drive-scan 要等开 tab + content 注入,给 45s。 */
function extRequest(msg: unknown, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve({ ok: false, error: "no-window" });
      return;
    }
    const id = ++extMsgSeq;
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ ok: false, error: "ext-bridge-timeout" });
    }, timeoutMs);
    function onMsg(e: MessageEvent) {
      const d = e.data;
      if (!d || d.tag !== `${EXT_BRIDGE_TAG}:res` || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve((d.res || { ok: false }) as Record<string, unknown>);
    }
    window.addEventListener("message", onMsg);
    window.postMessage({ tag: `${EXT_BRIDGE_TAG}:req`, id, msg }, "*");
  });
}

export function ExploreProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { t } = useI18n();
  const [filters, setFiltersState] = useState<ExploreFilters>({ ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats] });
  const touched = useRef(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [offers, setOffers] = useState<DiscoveredOffer[]>([]);
  const [sources, setSources] = useState<SourceMap>({});
  const [matchCount, setMatchCount] = useState(0);
  const [companiesScanned, setCompaniesScanned] = useState(0);
  // Authoritative scan-health signals (scanner --json mode, #1199): tell a capped /
  // degraded scan from a genuinely empty one, and power a "scanned X of Y" banner.
  const [companiesAvailable, setCompaniesAvailable] = useState(0);
  const [capHit, setCapHit] = useState(false);
  const [droppedNoDate, setDroppedNoDate] = useState(0);
  const [status, setStatus] = useState("");
  const [partial, setPartial] = useState(false);
  const [error, setError] = useState("");
  const [scannerMissing, setScannerMissing] = useState(false);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [mode, setModeState] = useState<ExploreMode>("scan");
  const [scanSource, setScanSource] = useState<ScanSource>(SCAN_SOURCE_DEFAULT[0]);
  const [enabledSources, setEnabledSources] = useState<ScanSource[]>([...SCAN_SOURCE_DEFAULT]);
  const [aiIntent, setAiIntent] = useState("");
  const [aiTrace, setAiTrace] = useState<AiTraceChunk[]>([]);
  const [aiCost, setAiCost] = useState<AiCost>({ searches: 0, candidates: 0, fetches: 0 });
  const runningRef = useRef(false);
  const aiIntentRef = useRef(aiIntent);
  aiIntentRef.current = aiIntent;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const setFilters = useCallback((f: ExploreFilters) => {
    touched.current = true;
    filtersRef.current = f;
    setFiltersState(f);
  }, []);
  const initFilters = useCallback((f: ExploreFilters) => {
    if (touched.current) return;
    filtersRef.current = f;
    setFiltersState(f);
  }, []);

  const discover = useCallback(async () => {
    if (runningRef.current) return;
    const f = filtersRef.current;
    runningRef.current = true;
    setPhase("casting");
    setOffers([]);
    setMatchCount(0);
    setCompaniesScanned(0);
    setCompaniesAvailable(0);
    setCapHit(false);
    setDroppedNoDate(0);
    setPartial(false);
    setError("");
    setScannerMissing(false);
    setStatus(t("explore.disc.castingNet"));
    const init: Partial<Record<AtsSource, SourceState>> = {};
    for (const a of f.ats) init[a] = { state: "queued" };
    setSources(init);
    if (typeof window !== "undefined") {
      const qs = filtersToParams(f);
      window.history.replaceState(null, "", `/explore${qs ? `?${qs}` : ""}`);
    }

    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let sawScannerMissing = false; // the structured 400 (data-only checkout), not a runtime scan error
    let companiesScannedAcc = 0; // 0 at the end = the directories never downloaded → degraded, not empty
    let capHitAcc = false; // scan was capped (only a slice of the universe searched)
    let datasetIssueAcc = false; // some ATS dataset was stale/empty/unreachable
    let droppedNoDateAcc = 0; // postings dropped for lacking a publish date
    try {
      const r = await fetch("/api/explore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      });
      // Every non-OK response is decided from the parsed body, not the status.
      // A failed response never carries a scan stream, so reading one would
      // parse a JSON error object as scan events and report "no readable
      // output" instead of the server's actual message.
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        sawScannerMissing = isScannerMissing(d);
        sawError = d.error || (sawScannerMissing ? t("explore.err.scannerUnavailable") : t("explore.err.discoveryFailed", { status: r.status }));
      } else if (!r.body) {
        sawError = t("explore.err.noStream");
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: ScanEvent;
            try {
              ev = JSON.parse(line) as ScanEvent;
            } catch {
              continue;
            }
            switch (ev.kind) {
              case "atsStart":
                setPhase("scanning");
                setStatus(t("explore.disc.walking", { ats: ATS_LABEL[ev.ats as AtsSource] ?? ev.ats, n: ev.companies.toLocaleString() }));
                setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: "active", companies: ev.companies } }));
                break;
              case "progress":
                // `matches` is the GLOBAL running total (the engine batches the
                // offer list to the very end), so it drives the live hero counter.
                setMatchCount((m) => Math.max(m, ev.matches));
                setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: "active", done: ev.scanned, total: ev.total } }));
                break;
              case "atsDone":
                setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats as AtsSource], state: ev.unreachable > 0 ? "noisy" : "swept", unreachable: ev.unreachable } }));
                break;
              case "offer":
                acc.push(ev.offer);
                setOffers((o) => [...o, ev.offer]);
                break;
              case "summary": {
                companiesScannedAcc = ev.companiesScanned;
                setCompaniesScanned(ev.companiesScanned);
                if (typeof ev.companiesAvailable === "number") setCompaniesAvailable(ev.companiesAvailable);
                if (ev.capHit) {
                  capHitAcc = true;
                  setCapHit(true);
                }
                const datasetIssue = ev.datasetStatus ? Object.values(ev.datasetStatus).some((s) => s !== "ok") : false;
                if (datasetIssue) datasetIssueAcc = true;
                if (typeof ev.postingsDroppedNoDate === "number" && ev.postingsDroppedNoDate > 0) {
                  droppedNoDateAcc = ev.postingsDroppedNoDate;
                  setDroppedNoDate(ev.postingsDroppedNoDate);
                }
                if (ev.unreachable > 0 || datasetIssue) setPartial(true);
                break;
              }
              case "error":
                sawError = ev.message;
                break;
              default:
                break;
            }
          }
        }
      }
    } catch (e) {
      sawError = e instanceof Error ? e.message : t("explore.err.streamError");
    }

    // Mark any still-active sources as swept (stream ended).
    setSources((s) => {
      const next = { ...s };
      for (const k of Object.keys(next) as AtsSource[]) if (next[k]?.state === "active" || next[k]?.state === "queued") next[k] = { ...next[k]!, state: "swept" };
      return next;
    });

    runningRef.current = false;
    if (acc.length > 0) {
      setMatchCount(acc.length);
      setPhase("revealing");
      setStatus(t(acc.length === 1 ? "explore.disc.foundFreeOne" : "explore.disc.foundFreeMany", { n: acc.length }));
      window.setTimeout(() => setPhase("results"), 850);
    } else if (sawError) {
      setError(sawError);
      setScannerMissing(sawScannerMissing);
      setPhase("failed");
    } else if (capHitAcc || datasetIssueAcc || droppedNoDateAcc > 0 || companiesScannedAcc === 0) {
      // Maintainer's RULE (#1199): it is NOT "all caught up" if the scan was capped,
      // a dataset was stale/unreachable, postings were dropped for missing a date, OR
      // nothing was searched at all (legacy 0-companies fallback when --json is absent).
      // Truly-empty is only when live datasets were fully searched and found nothing.
      setPhase("degraded");
    } else {
      setPhase(isBroadSearch(f) ? "empty-current" : "empty-loose");
    }
  }, [t]);

  // Browser mode — walk the Chinese boards (BOSS直聘/猎聘/智联) through an
  // independent job-seeking Edge profile via zh-collect.mjs (Playwright). Shares
  // the ScanEvent stream grammar with discover(), so the surface state machine is
  // nearly identical; the differences are the URL codec, the source chips
  // (platforms, not ATS), and the collector gate (a structured
  // BROWSER_COLLECTOR_MISSING 400 → "blocked", not "failed").
  const discoverBrowser = useCallback(async () => {
    if (runningRef.current) return;
    const f = filtersRef.current;
    const platforms = f.browserSources?.length ? f.browserSources : BROWSER_SOURCES;
    const query = f.zhQuery?.trim() ?? "";
    runningRef.current = true;
    setPhase("casting");
    setOffers([]);
    setMatchCount(0);
    setCompaniesScanned(0);
    setCompaniesAvailable(0);
    setCapHit(false);
    setDroppedNoDate(0);
    setPartial(false);
    setError("");
    setScannerMissing(false);
    const init: SourceMap = {};
    for (const p of platforms) init[p] = { state: "queued" };
    setSources(init);
    setStatus(t("explore.disc.castingBrowser"));
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", `/explore?${browserToParams(query, platforms as unknown as string[], f.zhCity, f.zhSalaryMin)}`);
    }

    // 扩展驱动的探索页采集(ADR-0007 E2/E5/E6 seam):逐平台查/开 tab 驱动 content
    // script 采集,前端 2s 轮询 scan-progress;扩展未连通则走下方 Playwright 兜底流。
    // 端口/搜索 URL 与 runBrowserDiscovery 同源(buildSearchUrls + " OR " 展开)。
    const driveViaExtension = async (): Promise<void> => {
      const queryForUrl = query.replace(/\s+/g, " OR ");
      const city = f.zhCity?.trim() ?? "";
      // 目标成对展开：猎聘拆词逐词一 URL，其余平台整串一条（见 expandSearchTargets）。
      const targets = expandSearchTargets(platforms as unknown as string[], queryForUrl, city);
      // 每站采集上限走用户配置（配置页可改，默认猎聘 1200 / BOSS/智联 400），随消息
      // 传给扩展 content script 的累积器，防分页型大关键词被 400 硬上限截掉末页。
      const scanMax = readScanMax();
      const scanId =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `ext-scan-${Date.now()}`;
      setPhase("scanning");
      setStatus(t("explore.disc.castingExtension"));

      const drive = await extRequest(
        {
          type: "drive-scan",
          scanId,
          sources: targets.map((t) => ({
            source: t.source,
            url: t.url,
            maxCount: scanMax[t.source as keyof typeof scanMax] ?? 400,
          })),
        },
        45_000, // 开 tab + content 注入可能比默认 4s 久,放宽等全部平台驱动完成
      );
      const tasks = Array.isArray(drive.tasks) ? (drive.tasks as Array<{ source: string; status: string }>) : [];
      const failed = tasks.filter((x) => x && x.status === "failed");
      const failedSet = new Set(failed.map((x) => x.source));
      if (failed.length) {
        setSources((s) => {
          const next = { ...s };
          for (const tsk of failed) next[tsk.source] = { state: "noisy", unreachable: 1 };
          return next;
        });
      }

      // 温和轮询(2s):条数走 scan-progress,收尾走桥 scan-status 的 active 列表为空。
      // 超时 180s 兜底(防 SW/tab 意外丢失卡死)。drive 全败 → 直接跳过等待。
      const collectedCount = async () => {
        try {
          const j = (await fetch(`/api/explore/scan-progress?scanId=${encodeURIComponent(scanId)}`).then((r) => r.json()).catch(() => ({}))) as { collected?: number };
          return Number(j.collected) || 0;
        } catch {
          return 0;
        }
      };
      let tick = 0;
      const maxTicks = 90;
      while (tick < maxTicks) {
        tick += 1;
        await new Promise((r) => setTimeout(r, 2000));
        const collected = await collectedCount();
        let active: string[] = [];
        try {
          const st = await extRequest({ type: "scan-status", scanId });
          active = Array.isArray(st.active) ? (st.active as string[]).filter((x) => !failedSet.has(x)) : [];
        } catch {
          /* transient — keep polling */
        }
        setStatus(t("explore.disc.collected", { n: collected }));
        if (active.length === 0) break;
      }

      // 收尾:标记仍 active/queued 的平台为 swept,取回本 scanId 采集到的最前端显示。
      setSources((s) => {
        const next = { ...s };
        for (const k of Object.keys(next))
          if (next[k]?.state === "queued" || next[k]?.state === "active") next[k] = { ...next[k]!, state: "swept" };
        return next;
      });
      const offersRes = await extRequest({ type: "scan-offers", scanId });
      const found = Array.isArray(offersRes.offers) ? (offersRes.offers as DiscoveredOffer[]) : [];
      // 薪酬门控（工单 04，页面侧）：扩展路径的 offer 不经过 browser-scan 服务端
      // 门，在取回处套用同一 applyBrowserSalaryGate（区间重叠、薪资未知放行并打
      // 标），保证扩展驱动与 bsk 兜底两条路径行为一致。
      const gated = applyBrowserSalaryGate(found, f.zhSalaryMin);
      setOffers(gated);
      if (gated.length > 0) {
        setMatchCount(gated.length);
        setCompaniesScanned(gated.length);
        setPhase("revealing");
        setStatus(t(gated.length === 1 ? "explore.disc.browserFoundOne" : "explore.disc.browserFoundMany", { n: gated.length }));
        window.setTimeout(() => setPhase("results"), 850);
      } else if (failed.length) {
        setPhase("degraded");
      } else {
        setPhase("empty-loose");
      }
      runningRef.current = false;
    };

    const extPing = await extRequest({ type: "ext-ping" });
    if (extPing && extPing.ok) {
      await driveViaExtension();
      return;
    }

    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let sawCollectorMissing = false; // Playwright collector absent — structured 400 → blocked
    let reachedAcc = 0; // platforms that completed a real sweep
    let unreachableAcc = 0;
    try {
      const r = await fetch("/api/explore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...f, mode: "browser" }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        sawCollectorMissing = isBrowserCollectorMissing(d);
        sawError = d.error || (sawCollectorMissing ? t("explore.err.collectorMissing") : t("explore.err.discoveryFailed", { status: r.status }));
      } else if (!r.body) {
        sawError = t("explore.err.noStream");
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: ScanEvent;
            try {
              ev = JSON.parse(line) as ScanEvent;
            } catch {
              continue;
            }
            switch (ev.kind) {
              case "atsStart":
                setPhase("scanning");
                setStatus(t("explore.disc.browsing", { platform: BROWSER_LABEL[ev.ats as BrowserSource] ?? ev.ats }));
                setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats], state: "active" } }));
                break;
              case "atsDone":
                unreachableAcc += ev.unreachable;
                setSources((s) => ({ ...s, [ev.ats]: { ...s[ev.ats], state: ev.unreachable > 0 ? "noisy" : "swept", unreachable: ev.unreachable } }));
                break;
              case "offer":
                acc.push(ev.offer);
                setOffers((o) => [...o, ev.offer]);
                break;
              case "summary":
                reachedAcc = ev.companiesScanned;
                setCompaniesScanned(ev.companiesScanned);
                if (ev.unreachable > 0) setPartial(true);
                break;
              case "error":
                if (!sawError) sawError = ev.message;
                break;
              default:
                break;
            }
          }
        }
      }
    } catch (e) {
      sawError = e instanceof Error ? e.message : t("explore.err.streamError");
    }

    // Mark any still-active sources as swept (stream ended).
    setSources((s) => {
      const next = { ...s };
      for (const k of Object.keys(next)) if (next[k]?.state === "active" || next[k]?.state === "queued") next[k] = { ...next[k]!, state: "swept" };
      return next;
    });

    runningRef.current = false;
    if (acc.length > 0) {
      setMatchCount(acc.length);
      setPhase("revealing");
      setStatus(t(acc.length === 1 ? "explore.disc.browserFoundOne" : "explore.disc.browserFoundMany", { n: acc.length }));
      window.setTimeout(() => setPhase("results"), 850);
    } else if (sawCollectorMissing) {
      setError(sawError);
      setPhase("blocked");
    } else if (sawError) {
      setError(sawError);
      setPhase("failed");
    } else if (reachedAcc === 0 && unreachableAcc > 0) {
      setPhase("degraded");
    } else {
      setPhase("empty-loose");
    }
  }, [t]);

  // Today's "See all N" link (#84) routes here with ?view=fresh instead of leaving
  // the user on a bare config form. Re-fetch the same free, zero-token /api/whats-new
  // history the dashboard already reads and drop it straight into the results phase
  // — no scan, so it never touches sources/companiesScanned like discover() does.
  const loadFresh = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("casting");
    setStatus(t("explore.disc.loadingFresh"));
    setOffers([]);
    setMatchCount(0);
    setCompaniesScanned(0);
    setCompaniesAvailable(0);
    setCapHit(false);
    setDroppedNoDate(0);
    setPartial(false);
    setSources({});
    setError("");
    try {
      // A finite ceiling, not `all`: explorer-view renders every offer it gets,
      // so an unbounded list would be an unbounded DOM. `count` below stays the
      // complete total, which is what the header actually reports.
      const r = await fetch(`/api/whats-new?limit=${MAX_OFFER_LIMIT}`);
      if (!r.ok) {
        setError(t("explore.err.loadFreshFailed", { status: r.status }));
        setPhase("failed");
        return;
      }
      const d = await r.json().catch(() => null);
      if (!d || !Array.isArray(d.offers)) {
        setError(t("explore.err.loadFreshUnexpected"));
        setPhase("failed");
        return;
      }
      const list: DiscoveredOffer[] = d.offers;
      setOffers(list);
      const count = Number(d.count);
      setMatchCount(Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : list.length);
      setPhase(list.length > 0 ? "results" : "empty-current");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("explore.err.loadFresh"));
      setPhase("failed");
    } finally {
      runningRef.current = false;
    }
  }, [t]);

  const addToPipeline = useCallback(async (list: DiscoveredOffer[]) => {
    const fresh = list.filter((o) => !added.has(o.url));
    if (fresh.length === 0) return 0;
    setAdding((s) => new Set([...s, ...fresh.map((o) => o.url)]));
    try {
      const r = await fetch("/api/explore/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offers: fresh }),
      });
      const d = (await r.json()) as { added?: number };
      if (d.added && d.added > 0) {
        setAdded((s) => new Set([...s, ...fresh.map((o) => o.url)]));
        // The new inbox rows were written server-side. Invalidate the Next router
        // cache so the (server-rendered) Pipeline view shows them instead of a stale
        // snapshot, and ping live listeners (today's dashboard, pipeline provider) —
        // otherwise the user adds a job, opens Pipeline, and sees it empty (disc#5).
        router.refresh();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: "explore-add" } }));
        }
      }
      return d.added ?? 0;
    } catch {
      return 0;
    } finally {
      setAdding((s) => {
        const next = new Set(s);
        for (const o of fresh) next.delete(o.url);
        return next;
      });
    }
  }, [added, router]);

  const applyPatch = useCallback((raw: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }) => {
    const next = parseExplorePatch(raw, filtersRef.current, opts?.merge ?? false);
    setFilters(next);
    filtersRef.current = next;
    if (opts?.run) void discover();
  }, [discover]);

  const reset = useCallback(() => {
    runningRef.current = false;
    setPhase("idle");
    setOffers([]);
    setSources({});
    setMatchCount(0);
    setCompaniesScanned(0);
    setStatus("");
    setPartial(false);
    setError("");
    setScannerMissing(false);
    setAiTrace([]);
    setAiCost({ searches: 0, candidates: 0, fetches: 0 });
    try {
      sessionStorage.removeItem(RESULTS_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // AI search — orchestrate modes/discover.md via the user's CLI, streamed.
  const discoverAI = useCallback(async () => {
    if (runningRef.current) return;
    const intent = aiIntentRef.current.trim();
    if (!intent) return;
    let cliId: string | null = null;
    let model: string | null = null;
    try {
      const cfg = JSON.parse(localStorage.getItem("career-ops:config") || "{}");
      cliId = cfg.cliId || null;
      model = cfg.model || null;
    } catch {
      cliId = null;
      model = null;
    }
    if (!cliId) {
      setPhase("blocked");
      return;
    }
    runningRef.current = true;
    setPhase("casting");
    setOffers([]);
    setMatchCount(0);
    setAiTrace([]);
    setAiCost({ searches: 0, candidates: 0, fetches: 0 });
    setError("");
    setScannerMissing(false);
    setStatus(t("explore.disc.castingWeb"));
    if (typeof window !== "undefined") window.history.replaceState(null, "", `/explore?${aiToParams(intent)}`);

    let knownUrls = new Set<string>();
    try {
      const k = await fetch("/api/explore/ai/known").then((r) => r.json());
      knownUrls = new Set<string>(Array.isArray(k.urls) ? k.urls : []);
    } catch {
      /* best-effort dedup */
    }
    const parser = makeAiStreamParser({ knownUrls });

    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let sawScannerMissing = false; // the structured 400 (capability absent from this checkout), not a runtime error
    const handle = (chunks: AiTraceChunk[]) => {
      for (const ch of chunks) {
        if (ch.kind === "offer") {
          acc.push(ch.offer);
          setOffers((o) => [...o, ch.offer]);
          setMatchCount(acc.length);
          setAiCost((c) => ({ ...c, candidates: acc.length }));
          setPhase("hunting");
        } else {
          setAiTrace((t) => [...t, ch]);
          if (ch.kind === "narration") {
            const s = (ch.text.match(/\bsearch(ing|ed)?\b/gi) || []).length;
            const f = (ch.text.match(/\bfetch(ing|ed)?\b/gi) || []).length;
            if (s || f) setAiCost((c) => ({ ...c, searches: c.searches + s, fetches: c.fetches + f }));
            setPhase((p) => (p === "casting" ? "hunting" : p));
          }
        }
      }
    };

    try {
      const r = await fetch("/api/explore/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: intent, cliId, model: model || undefined }),
      });
      if (r.status === 404) {
        runningRef.current = false;
        setPhase("blocked");
        return;
      }
      // Same rule as the scan path, and this is the call site the status-based
      // check actually broke: /api/explore/ai returns three different 400s
      // (malformed JSON, missing parameters, MODE_MISSING), and all three were
      // reported as "this checkout has no scanner". MODE_MISSING carries its own
      // copy about AI search, which the scanner panel overwrote.
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        sawScannerMissing = isScannerMissing(d);
        sawError = d.error || (sawScannerMissing ? t("explore.err.aiUnavailable") : t("explore.err.aiFailed", { status: r.status }));
      } else if (!r.body) {
        sawError = t("explore.err.noStream");
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          handle(parser.feed(dec.decode(value, { stream: true })));
        }
        handle(parser.flush());
      }
    } catch (e) {
      sawError = e instanceof Error ? e.message : t("explore.err.streamError");
    }

    runningRef.current = false;
    if (acc.length > 0) {
      setMatchCount(acc.length);
      setPhase("revealing");
      setStatus(t(acc.length === 1 ? "explore.disc.candidatesFoundOne" : "explore.disc.candidatesFoundMany", { n: acc.length }));
      window.setTimeout(() => setPhase("results"), 850);
    } else if (sawError) {
      setError(sawError);
      setScannerMissing(sawScannerMissing);
      setPhase("failed");
    } else {
      setPhase("empty-loose");
    }
  }, [t]);

  // Switch surface but PRESERVE the current results + filters — toggling scan↔AI must
  // not throw away a completed search (disc#5). A new search (discover/discoverAI)
  // clears + repopulates; an explicit reset() clears. Just stop any half-run.
  const setMode = useCallback((m: ExploreMode) => {
    runningRef.current = false;
    setModeState(m);
  }, []);

  // 扫描 tab 内的子 tab 集合由配置「扫描方式」决定（勾选了才显示，默认 BSK）。
  // ExploreProvider 是 shell 级单例、跨软导航不重挂载——所以不能在挂载时读一次就完事，
  // 否则在 /config 改了扫描方式再回到 /explore，集合仍是旧的（# 配置不同步 bug）。
  // 改为随路由路径变化重读配置并校正当前引擎，覆盖首次挂载 + 每次跨页软导航。
  const pathname = usePathname();
  useEffect(() => {
    const list = readScanSources();
    setEnabledSources(list);
    setScanSource((s) => (list.includes(s) ? s : list[0]));
  }, [pathname]); // 修复：跨页/挂载都重读配置

  // Rehydrate the last settled result set on mount (per-tab sessionStorage), unless a
  // search is already running. Done in an effect (not a useState initializer) to avoid
  // an SSR hydration mismatch.
  useEffect(() => {
    if (runningRef.current) return;
    let snap: ResultSnapshot | null = null;
    try {
      snap = JSON.parse(sessionStorage.getItem(RESULTS_KEY) || "null") as ResultSnapshot | null;
    } catch {
      snap = null;
    }
    if (!snap || snap.v !== 1 || !Array.isArray(snap.offers)) return;
    setModeState(snap.mode === "ai" ? "ai" : snap.mode === "browser" ? "browser" : "scan");
    setScanSource(snap.scanSource ?? (snap.mode === "browser" ? "bsk" : SCAN_SOURCE_DEFAULT[0]));
    setOffers(snap.offers);
    setMatchCount(typeof snap.matchCount === "number" ? snap.matchCount : snap.offers.length);
    setCompaniesScanned(snap.companiesScanned ?? 0);
    setCompaniesAvailable(snap.companiesAvailable ?? 0);
    setCapHit(!!snap.capHit);
    setDroppedNoDate(snap.droppedNoDate ?? 0);
    setSources(snap.sources ?? {});
    setPartial(!!snap.partial);
    setStatus(typeof snap.status === "string" ? snap.status : "");
    setError(typeof snap.error === "string" ? snap.error : "");
    setScannerMissing(!!snap.scannerMissing);
    setAdded(new Set(Array.isArray(snap.added) ? snap.added : []));
    setAiTrace(Array.isArray(snap.aiTrace) ? snap.aiTrace : []);
    setAiCost(snap.aiCost ?? { searches: 0, candidates: 0, fetches: 0 });
    if (typeof snap.aiIntent === "string") setAiIntent(snap.aiIntent);
    // Never rehydrate INTO a running phase — no live stream backs it.
    const RUNNING = new Set<Phase>(["casting", "scanning", "revealing", "hunting"]);
    setPhase(RUNNING.has(snap.phase) ? (snap.offers.length ? "results" : "idle") : snap.phase);
  }, []);

  // Persist only SETTLED states (never mid-stream) so a reload restores a complete set.
  useEffect(() => {
    const SETTLED = new Set<Phase>(["results", "empty-current", "empty-loose", "failed", "degraded", "blocked"]);
    if (!SETTLED.has(phase)) return;
    try {
      const snap: ResultSnapshot = {
        v: 1, mode, scanSource, phase, offers, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, sources,
        partial, status, error, scannerMissing, added: [...added], aiTrace, aiCost, aiIntent,
      };
      sessionStorage.setItem(RESULTS_KEY, JSON.stringify(snap));
    } catch {
      /* sessionStorage full/unavailable — non-fatal */
    }
  }, [phase, mode, scanSource, offers, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, sources, partial, status, error, scannerMissing, added, aiTrace, aiCost, aiIntent]);

  const value = useMemo(
    () => ({
      filters, setFilters, initFilters, phase,
      running: phase === "casting" || phase === "scanning" || phase === "revealing" || phase === "hunting",
      offers, sources, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, status, partial, error, scannerMissing, added, adding,
      discover, discoverBrowser, loadFresh, addToPipeline, applyPatch, reset,
      mode, setMode, scanSource, setScanSource, enabledSources, aiIntent, setAiIntent, discoverAI, aiTrace, aiCost,
    }),
    [filters, setFilters, initFilters, phase, offers, sources, matchCount, companiesScanned, companiesAvailable, capHit, droppedNoDate, status, partial, error, scannerMissing, added, adding, discover, discoverBrowser, loadFresh, addToPipeline, applyPatch, reset, mode, setMode, scanSource, setScanSource, enabledSources, aiIntent, discoverAI, aiTrace, aiCost],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

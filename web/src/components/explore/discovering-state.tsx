"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { ApplyBackdrop } from "@/components/apply/apply-backdrop";
import { instrumentSerif } from "@/lib/fonts";
import { ATS_LABEL, ATS_SOURCES, BROWSER_LABEL, BROWSER_SOURCES, type AtsSource, type BrowserSource } from "@/lib/explore";
import { chipProgressPct } from "@/lib/browser-progress.mjs";
import { useExplore, type SourceState } from "./explore-provider";
import { useI18n } from "@/lib/i18n/context";

const STYLE = `
.co-disc{position:relative;z-index:1;display:flex;min-height:78vh;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:1.6rem;padding:2rem}
.co-disc__counter{font-variant-numeric:tabular-nums;line-height:1;font-size:clamp(4rem,13vw,8rem)}
.co-src{display:flex;flex-wrap:wrap;justify-content:center;gap:.6rem}
.co-src__chip{display:flex;align-items:center;gap:.5rem;border-radius:.8rem;border:1px solid var(--border,hsl(0 0% 50% / .2));padding:.5rem .8rem;min-width:9.5rem;background:color-mix(in srgb, var(--bg) 70%, transparent);transition:opacity .3s,border-color .3s}
.co-src__chip[data-state="queued"]{opacity:.4;border-style:dashed}
.co-src__chip[data-state="active"]{border-color:hsl(26 73% 51% / .45)}
.co-src__orb{width:.55rem;height:.55rem;border-radius:50%;background:hsl(26 80% 55%);box-shadow:0 0 0 0 hsl(26 80% 55% / .5);animation:co-orb 1.4s ease-out infinite}
.co-src__bar{height:3px;border-radius:2px;background:hsl(26 73% 51%);transition:width .4s ease}
.co-src__chip[data-engine="browser"][data-state="swept"] .co-src__bar{background:hsl(160 64% 46%)}
.co-src__num{font-variant-numeric:tabular-nums;font-size:12px;font-weight:600;line-height:1;color:var(--fg);opacity:.85}
.co-src__chip[data-state="queued"] .co-src__num{font-weight:400}
.co-src__chip[data-state="swept"] .co-src__num{color:hsl(160 60% 40%)}
html.dark .co-src__chip[data-state="swept"] .co-src__num{color:hsl(158 64% 62%)}
.co-src__track{height:3px;border-radius:2px;background:color-mix(in srgb, var(--fg) 14%, transparent);overflow:hidden;width:3.5rem}
.co-disc__skel{display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.7rem;width:100%;max-width:46rem;margin-top:.5rem}
.co-disc__skelcard{height:4.4rem;border-radius:.8rem;border:1px solid var(--border,hsl(0 0% 50% / .15));background:color-mix(in srgb, var(--bg) 60%, transparent);overflow:hidden;position:relative}
.co-disc__skelcard::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb, var(--fg) 8%, transparent),transparent);transform:translateX(-100%);animation:co-shimmer 1.5s infinite}
.co-ledger{display:inline-flex;align-items:center;gap:.5rem;border-radius:999px;border:1px solid hsl(160 64% 46% / .3);background:hsl(160 64% 46% / .1);color:hsl(160 60% 40%);padding:.35rem .85rem;font-size:12.5px;font-weight:600}
html.dark .co-ledger{color:hsl(158 64% 62%)}
@keyframes co-orb{0%{box-shadow:0 0 0 0 hsl(26 80% 55% / .5)}70%{box-shadow:0 0 0 .5rem hsl(26 80% 55% / 0)}100%{box-shadow:0 0 0 0 hsl(26 80% 55% / 0)}}
@keyframes co-shimmer{100%{transform:translateX(100%)}}
@media (prefers-reduced-motion: reduce){.co-src__orb,.co-disc__skelcard::after{animation:none}}
`;

export function useCountUp(target: number): number {
  const [val, setVal] = useState(target);
  const raf = useRef(0);
  useEffect(() => {
    const tick = () => {
      setVal((v) => {
        const diff = target - v;
        if (Math.abs(diff) < 0.5) return target;
        raf.current = requestAnimationFrame(tick);
        return v + diff * 0.18;
      });
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target]);
  return Math.round(val);
}

/** 逐平台采到数文案（ADR-0069 决议 5）：仅浏览器模式且分母已知时显示——
 *  queued `—/上限`、active `n/上限`、swept `✓ n`（上限是截断保护不是目标，
 *  采完即转 ✓ 停比）；noisy 保持 `~n skipped` 行，数字定格在失败时刻。
 *  ATS 分支不显数：done/total 在公司数语义轴上，与条数不同口径。 */
function browserCountLabel(s: SourceState | undefined, state: SourceState["state"], isBrowser?: boolean): string {
  if (!isBrowser || !s?.total) return "";
  if (state === "swept") return `✓ ${s.done ?? 0}`;
  if (state === "queued") return `—/${s.total}`;
  return `${s.done ?? 0}/${s.total}`;
}

function SourceChip({ ats, label, s, isBrowser }: { ats: string; label: string; s?: SourceState; isBrowser?: boolean }) {
  const state = s?.state ?? "queued";
  const pct = chipProgressPct(s, state);
  const countLabel = browserCountLabel(s, state, isBrowser);
  return (
    <div className="co-src__chip" data-engine={isBrowser ? "browser" : "ats"} data-state={state === "noisy" ? "active" : state}>
      {state === "active" ? (
        <span className="co-src__orb" />
      ) : state === "swept" || state === "noisy" ? (
        <Check className="size-3.5 text-emerald-500" />
      ) : (
        <span className="size-2.5 rounded-full border border-current opacity-40" />
      )}
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      <div className="ml-auto flex flex-col items-end gap-1">
        {state === "noisy" && <span className="text-[10px] text-faint">~{s?.unreachable} skipped</span>}
        {countLabel && <span className="co-src__num">{countLabel}</span>}
        <div className="co-src__track">
          <div className="co-src__bar" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

export function DiscoveringState() {
  const { sources, matchCount, companiesScanned, status, phase, mode, scanSource, filters } = useExplore();
  const { t } = useI18n();
  const shown = useCountUp(matchCount);
  const companies = useCountUp(companiesScanned);
  // BSK/浏览器抓取走的是 PLATFORMS（BOSS/猎聘/智联），不是 ATS 网络 —— chips 与
  // 进度条据此切换到浏览器源集合。老「浏览器」tab 并入「扫描」后，引擎由
  // scanSource（或兼容旧会话的 mode==="browser"）决定，不再只看顶层 tab。
  const isBrowser = mode === "browser" || scanSource === "bsk";
  const chipIds = isBrowser ? (BROWSER_SOURCES as string[]) : (ATS_SOURCES as unknown as string[]);
  const chipLabel = (id: string) => (isBrowser ? BROWSER_LABEL[id as BrowserSource] : ATS_LABEL[id as AtsSource]) ?? id;
  const platforms = isBrowser ? filters.browserSources?.length ?? BROWSER_SOURCES.length : 0;

  return (
    <>
      <ApplyBackdrop intense={phase !== "revealing"} />
      <div className="co-disc">
        <style>{STYLE}</style>

        <div className="co-ledger">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          0 tokens · $0.00 {companies > 0 && <span className="opacity-70">{isBrowser ? t("explore.disc.platforms", { n: companies.toLocaleString() }) : `· ${companies.toLocaleString()} companies`}</span>}
        </div>

        <div>
          <div className={`${instrumentSerif.className} co-disc__counter text-foreground`}>{shown}</div>
          <p className="mt-1 text-sm text-muted">
            {phase === "revealing"
              ? isBrowser
                ? t("explore.disc.browserReveal")
                : "fresh roles found — free"
              : matchCount > 0
                ? "fresh roles and counting…"
                : isBrowser
                  ? t("explore.disc.browserScanning")
                  : "scanning the network…"}
          </p>
        </div>

        <div className="co-src">
          {chipIds.map((a) => (
            <SourceChip key={a} ats={a} label={chipLabel(a)} s={sources[a]} isBrowser={isBrowser} />
          ))}
        </div>

        <p className="flex items-center gap-2 text-[13px] text-faint">
          <Loader2 className="size-3.5 animate-spin" />
          {status || t("explore.disc.castingNet")}
        </p>

        {phase !== "revealing" && (
          <div className="co-disc__skel" aria-hidden>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="co-disc__skelcard" />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

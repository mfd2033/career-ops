"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Send, Lock, ExternalLink } from "lucide-react";
import { useJobs } from "@/components/jobs/job-store";
import { useApply } from "@/components/apply/apply-provider";
import { useI18n } from "@/lib/i18n/context";
import { readApplyBehavior, APPLY_BEHAVIOR_DEFAULT, type ApplyBehavior } from "@/lib/apply-behavior";

// The "Apply" CTA — brand orange CTA. Behavior is set in the settings page
// (config.applyBehavior, persisted in career-ops:config):
//   - "link"（默认）：新标签页直接打开该职位的职位链接，仅需 URL 即可启用；
//   - "form"：打开申请表单代理（预填供用户核对 + 自行提交），要求该职位的
//     定制 CV 已就绪（tracker 的 PDF 列为 ✅，或本 #n 的 pdf worker 刚结束）。
// 无论哪种模式，都不会自动替用户提交申请。
export function ApplyButton({ n, url, company, pdfReady }: { n: string; url?: string; company: string; pdfReady: boolean }) {
  const router = useRouter();
  const { jobs } = useJobs();
  const apply = useApply();
  const { t } = useI18n();

  // SSR 以默认行为渲染；客户端挂载后对齐持久化配置。
  const [behavior, setBehavior] = useState<ApplyBehavior>(APPLY_BEHAVIOR_DEFAULT);
  useEffect(() => {
    setBehavior(readApplyBehavior());
  }, []);

  const pdfJobDone = jobs.some((j) => j.kind === "pdf" && j.input === n && j.status === "done");
  const hasUrl = !!url && /^https?:\/\//i.test(url);
  // 打开职位链接只需 URL；读取申请表单额外要求定制 CV 就绪。
  const ready = behavior === "link" ? hasUrl : (pdfReady || pdfJobDone) && hasUrl;

  if (!ready) {
    // 禁用态 title 按原因区分：缺 URL 优先，读表单模式缺 CV 时提示先生成。
    const title = !hasUrl ? t("apply.noAppUrl") : behavior === "form" ? t("apply.genCvFirst") : t("apply.openJob");
    return (
      <button
        type="button"
        disabled
        title={title}
        className="inline-flex cursor-not-allowed items-center justify-center gap-1.5 rounded-full border border-border bg-surface/40 px-3.5 py-1 text-xs font-medium text-faint max-sm:min-h-[44px]"
      >
        <Lock className="size-3.5" /> {behavior === "form" ? t("apply.apply") : t("apply.openJob")}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        if (behavior === "link") {
          // 打开职位链接模式：新标签页跳转，保留管道页上下文。
          window.open(url!, "_blank", "noreferrer");
          return;
        }
        // 读取申请表单模式：n + from 随行，返回时标记 Applied 并回跳。
        const { pathname, search, hash } = window.location;
        apply.open(url!, { prefill: true, company, n, from: `${pathname}${search}${hash}` });
        router.push("/apply");
      }}
      className="inline-flex items-center justify-center gap-1.5 rounded-full bg-brand px-3.5 py-1 text-xs font-medium text-brand-foreground shadow-sm transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
      title={behavior === "form" ? t("apply.applyTitle") : t("apply.openJobTitle")}
    >
      {behavior === "form" ? (
        <>
          <Send className="size-3.5" /> {t("apply.apply")}
        </>
      ) : (
        <>
          <ExternalLink className="size-3.5" /> {t("apply.openJob")}
        </>
      )}
    </button>
  );
}
"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { methodologyEn } from "@/content/methodology.en";
import { methodologyZh } from "@/content/methodology.zh";
import { useI18n } from "@/lib/i18n/context";
import { goBackOr } from "@/lib/nav-history";

// 评分方法论全文页（站内文档，取代原先指向上游官网的外链）。
// 两份正文存于 src/content/methodology.{zh,en}.ts（字符串模块，随 build 编进 JS chunk）；
// 不用 .md 是因为 Next 16.3 的 Turbopack 没有可用的文本导入机制，见 ADR-0072。
// 语言跟随全站 useI18n().lang，不另设开关（与侧栏语言切换同一状态源）。
export function MethodologyDoc() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const doc = lang === "zh" ? methodologyZh : methodologyEn;

  return (
    <div className="w-full px-6 py-8">
      <div className="mx-auto max-w-[820px]">
        <button
          type="button"
          onClick={() => goBackOr(router, "/pipeline")}
          className="inline-flex min-h-[44px] items-center gap-2 text-sm text-muted transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> {t("pipeline.methodologyBack")}
        </button>

        {/* .report-prose 是报告正文共用的主题化 markdown 样式（含表格/引用/hr）。 */}
        <article className="report-prose mt-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc}</ReactMarkdown>
        </article>
      </div>
    </div>
  );
}

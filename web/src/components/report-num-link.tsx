"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";

// The "#N" affordance that jumps to /report/{n}. Rendered as a role="link"
// span (NOT an <a>) because its hosts — the worker tray pills, the /jobs list
// rows — are already <Link>s, and a nested anchor is invalid HTML; the
// preventDefault/stopPropagation keeps the outer link from winning.
export function ReportNumLink({ n, className }: { n: string; className?: string }) {
  const router = useRouter();
  const { t } = useI18n();
  const go = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    router.push(`/report/${n}`);
  };
  return (
    <span
      role="link"
      tabIndex={0}
      onClick={go}
      onKeyDown={(e) => {
        if (e.key === "Enter") go(e);
      }}
      title={t("jobs.viewReport")}
      className={className ?? "shrink-0 cursor-pointer font-medium tabular-nums text-faint transition-colors hover:text-brand"}
    >
      #{n}
    </span>
  );
}

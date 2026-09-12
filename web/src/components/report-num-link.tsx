"use client";

import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/cn";

// The "#N" affordance that jumps to /report/{n}. Rendered as a role="link"
// span (NOT an <a>) because its hosts — the worker tray pills, the /jobs list
// rows — are already <Link>s, and a nested anchor is invalid HTML; the
// preventDefault/stopPropagation keeps the outer link from winning.
//
// BASE carries the interactive affordances and is MERGED with the caller's
// className, never replaced by it (a `className ?? BASE` would silently drop
// the hand cursor for any caller — the two original hosts hid that because they
// wrap this span in an <a>, which supplies its own cursor; the job detail page
// renders it outside any link, where the omission showed as "visible but no
// hand on hover").
const BASE = "shrink-0 cursor-pointer font-medium tabular-nums text-faint transition-colors hover:text-brand";

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
      className={cn(BASE, className)}
    >
      #{n}
    </span>
  );
}

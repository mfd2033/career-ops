"use client";

import { Ban } from "lucide-react";
import { BlacklistView } from "@/components/blacklist-view";
import { useI18n } from "@/lib/i18n/context";

export const dynamic = "force-dynamic";

export default function BlacklistPage() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="flex items-center gap-3">
        <Ban className="size-6 text-brand" />
        <h1 className="font-display text-2xl tracking-tight text-landing">{t("blacklist.title")}</h1>
      </div>
      <p className="mt-1.5 max-w-xl text-sm text-muted">{t("blacklist.intro")}</p>
      <BlacklistView />
    </div>
  );
}

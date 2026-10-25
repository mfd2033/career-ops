"use client";

import Link from "next/link";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";
import { CoMark } from "@/components/co-mark";
import { AssistantConsole } from "@/components/assistant-console";
import { MobileNav } from "@/components/mobile-nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { JobsProvider } from "@/components/jobs/job-store";
import { PipelineProvider } from "@/components/pipeline/pipeline-provider";
import { ApplyProvider } from "@/components/apply/apply-provider";
import { ExploreProvider } from "@/components/explore/explore-provider";
import { FirstScoreView } from "@/components/explore/first-score-view";
import { WorkerPills } from "@/components/jobs/worker-pills";
import { UsageMeter } from "@/components/usage-meter";
import { instrumentSerif } from "@/lib/fonts";
import { NAV_ITEMS, isActivePath } from "@/lib/nav-items";
import { useI18n } from "@/lib/i18n/context";
import { LanguageToggle } from "@/components/language-toggle";
import { pushNavHistory } from "@/lib/nav-history";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { t } = useI18n();

  // 记录应用内导航：路由变化时把当前完整路由压入会话栈，供详情页“返回”按钮判断
  // 回到进入详情页之前的页面。软导航下 AppShell 不重挂载，因此依赖 pathname 变化触发。
  useEffect(() => {
    pushNavHistory(window.location.pathname + window.location.search);
  }, [pathname]);
  return (
    <JobsProvider>
      <PipelineProvider>
      <ApplyProvider>
      <ExploreProvider>
      <MobileNav />
      <div className="flex min-h-screen">
        {/* 工作器区（fitToHeight）用 flex-1 min-h-0 吸收剩余空间并按可用高度自适应张数，
            正常窗口下内容恰好填满 h-screen → 整侧栏不会出现纵向滚动条。
            仍保留 overflow-y-auto 作为兵底（而非 hidden）：ghost 已不再撑大溢出区，
            只有当 logo+导航+底部控件本身都放不下（极高窗口内容区 < ~610px）时，才回退
            为可滚动以保住底部语言/主题/用量控件；overflow-anchor:none 防止被静默滚动。 */}
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface/30 p-4 [overflow-anchor:none] md:flex">
          <Link href="/" className="mb-8 flex items-center gap-2.5 px-1">
            <CoMark size={32} />
            <span className={`${instrumentSerif.className} relative -top-px text-2xl font-normal tracking-tight text-landing`}>
              career-ops
            </span>
          </Link>
          <nav className="shrink-0 flex flex-col gap-1">
            {NAV_ITEMS.map(({ href, labelKey, icon: Icon }) => {
              const active = isActivePath(href, pathname);
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-brand-soft text-brand-text"
                      : "text-muted hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {t(labelKey)}
                </Link>
              );
            })}
          </nav>

          <WorkerPills fitToHeight />

          <div className="mt-auto shrink-0 space-y-3 pt-4">
            <UsageMeter />
            <LanguageToggle trailing={<ThemeToggle />} />
          </div>
        </aside>
        {/* overflow-x-clip（非 hidden）：hidden 会把 overflow-y 计算值强制成 auto，使 main
            变成滚动容器，从而破坏页内 sticky 侧栏（配置页 TOC）——clip 同样裁剪横向溢出
            但不建立滚动容器，sticky 仍相对视口生效。
            min-w-0：flex item 默认 min-width:auto，clip 不建立滚动容器所以不会把这条隐式最小宽
            归零——内容比可用宽度宽时 main 会被 min-content 顶大，整页跟着横向溢出（798px 窗口
            实测 scrollWidth 958 vs clientWidth 783，多出的 175px 全从这里来）。min-w-0 允许
            它收缩到可用宽度，clip 再把真的放不下的部分裁掉。 */}
        <main className="min-w-0 flex-1 overflow-x-clip">{children}</main>
        <AssistantConsole />
        <FirstScoreView />
      </div>
      </ExploreProvider>
      </ApplyProvider>
      </PipelineProvider>
    </JobsProvider>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
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

  // 桌面侧栏收起态：先按展开渲染避免 SSR/水合不一致，挂载后再读 localStorage 恢复。
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("career-ops:sidebar-collapsed") === "1") setCollapsed(true);
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      localStorage.setItem("career-ops:sidebar-collapsed", c ? "0" : "1");
      return !c;
    });
  };

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
        {/* 收起态只留图标列：hover 图标时用 tooltip 显示菜单文字。展开态保持原有的
            overflow-y-auto 兵底；收起态改为 overflow-visible，否则溢出裁剪会把
            伸到侧栏右侧的 tooltip 一起裁掉（overflow-y 非 visible 会把 overflow-x
            强制成 auto，建立滚动容器）。收起后内容只有一列图标，本身不需要滚动。 */}
        <aside
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-surface/30 [overflow-anchor:none] transition-[width,padding] duration-200 md:flex",
            collapsed ? "w-16 overflow-visible px-2 py-4" : "w-60 overflow-y-auto p-4",
          )}
        >
          <Link href="/" className={cn("mb-8 flex items-center gap-2.5 px-1", collapsed && "justify-center px-0")}>
            <CoMark size={32} />
            {!collapsed && (
              <span className={`${instrumentSerif.className} relative -top-px text-2xl font-normal tracking-tight text-landing`}>
                career-ops
              </span>
            )}
          </Link>
          <nav className="shrink-0 flex flex-col gap-1">
            {NAV_ITEMS.map(({ href, labelKey, icon: Icon }) => {
              const active = isActivePath(href, pathname);
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                    collapsed && "justify-center px-0",
                    active
                      ? "bg-brand-soft text-brand-text"
                      : "text-muted hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {!collapsed && t(labelKey)}
                  {/* 收起态 tooltip：hover（或键盘 focus）图标 300ms 后浮现，随点击目标导航 */}
                  {collapsed && (
                    <span
                      role="tooltip"
                      className="pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-hover:delay-300 group-focus-visible:opacity-100 group-focus-visible:delay-300"
                    >
                      {t(labelKey)}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          {!collapsed && <WorkerPills fitToHeight />}

          <div className="mt-auto shrink-0 space-y-3 pt-4">
            {collapsed ? (
              <button
                type="button"
                onClick={toggleCollapsed}
                aria-label={t("nav.expandSidebar")}
                title={t("nav.expandSidebar")}
                className="group relative flex w-full cursor-default items-center justify-center rounded-md py-2 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <PanelLeftOpen className="size-4" />
              </button>
            ) : (
              <>
                <UsageMeter />
                <LanguageToggle trailing={<ThemeToggle />} />
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-label={t("nav.collapseSidebar")}
                  className="flex w-full cursor-default items-center gap-3 rounded-md px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
                >
                  <PanelLeftClose className="size-4" />
                  {t("nav.collapseSidebar")}
                </button>
              </>
            )}
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

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
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
  // 收起/展开动效开关：挂载后先按 localStorage 直接就位（此时 transition 未放开，
  // 恢复收起态不会播一段从展开滑过去的动画），下一帧再放开过渡。
  const [sidebarReady, setSidebarReady] = useState(false);
  useEffect(() => {
    if (localStorage.getItem("career-ops:sidebar-collapsed") === "1") setCollapsed(true);
  }, []);
  useEffect(() => {
    const id = requestAnimationFrame(() => setSidebarReady(true));
    return () => cancelAnimationFrame(id);
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

  // 目录切换特效：活动项高亮块不再是各自链接上的静态底色，而是一个共享的绝对定
  // 位块，随路由切换平滑滑动到新活动项（transform 过渡）。位置用 offsetTop/Height
  // 实测而非硬编码（条目高度虽一致，但收起态/字体加载仍可能微移）；collapsed 也进
  // 依赖——收起/展开后重测，指示块跟着滑到新几何位置。首测前不渲染，避免闪错位。
  const navRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [indicator, setIndicator] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const idx = NAV_ITEMS.findIndex(({ href }) => isActivePath(href, pathname));
    const el = navRefs.current[idx];
    if (el) setIndicator({ top: el.offsetTop, height: el.offsetHeight });
  }, [pathname, collapsed]);
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
        {/* z-30：sticky 不带 z-index 时侧栏在定位层里按 DOM 顺序先画，main 里那些
            绝对定位的装饰层（HeroGlow 的 绝对 inset-0 canvas、可读性蒙层）排在它
            后面就会盖住伸出侧栏的 tooltip——即使 tooltip 自身 z-50 也无效，因为它
            被困在侧栏这个层叠上下文里。给侧栏一个正 z-index 把整列抬到 main 的
            定位层之上；弹窗/控制台等 z-40+ 的固定层仍在其上。 */}
        <aside
          data-sidebar-ready={sidebarReady}
          className={cn(
            "sticky top-0 z-30 hidden h-screen shrink-0 flex-col border-r border-border bg-surface/30 [overflow-anchor:none] transition-[width,padding] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] md:flex",
            collapsed ? "w-16 overflow-visible px-2 py-4 delay-100" : "w-60 overflow-y-auto p-4",
          )}
        >
          {/* 顶栏：logo 左、收起/展开开关右上角。开关改为绝对定位：展开态贴顶栏
              右缘，收起态滑到 logo 下方居中——位置随宽度过渡一起滑动而非跳位。
              文字常驻挂载，收起时 max-width 收到 0 + 淡出（宽度的延迟拍之前退完），
              展开时延迟随宽度打开后擦入。 */}
          <div
            className={cn(
              "relative flex items-center transition-[margin] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
              collapsed ? "mb-12" : "mb-8",
            )}
          >
            <Link href="/" className="flex items-center gap-2.5 px-1">
              <CoMark size={32} />
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200",
                  collapsed ? "max-w-0 opacity-0" : "max-w-[10rem] opacity-100 delay-100",
                )}
              >
                <span className={`${instrumentSerif.className} relative -top-px text-2xl font-normal tracking-tight text-landing`}>
                  career-ops
                </span>
              </span>
            </Link>
            <button
              type="button"
              onClick={toggleCollapsed}
              aria-label={t(collapsed ? "nav.expandSidebar" : "nav.collapseSidebar")}
              className={cn(
                "absolute flex size-8 items-center justify-center rounded-md text-muted transition-[left,top,background-color,color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-surface-hover hover:text-foreground",
                collapsed ? "left-[calc(50%-1rem)] top-11" : "left-[calc(100%-2rem)] top-0",
              )}
            >
              {/* key 重挂载让图标重放轻缩放入场；按钮全程在动（折叠时先沿右缘下落、
                  宽度收拢后再带到居中位），图标换新不落在静止画面里，不会显得卡顿 */}
              <span key={String(collapsed)} className="sidebar-toggle-icon grid place-items-center">
                {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
              </span>
            </button>
          </div>
          <nav className="relative shrink-0 flex flex-col gap-1">
            {/* 滑动高亮块：画在链接下层（DOM 在前），随 pathname/collapsed 平滑滑动 */}
            {indicator && (
              <div
                aria-hidden
                className="absolute left-0 right-0 rounded-md bg-brand-soft transition-[transform,height] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
                style={{ transform: `translateY(${indicator.top}px)`, height: indicator.height }}
              />
            )}
            {NAV_ITEMS.map(({ href, labelKey, icon: Icon }, i) => {
              const active = isActivePath(href, pathname);
              return (
                <Link
                  key={href}
                  ref={(el) => { navRefs.current[i] = el; }}
                  href={href}
                  className={cn(
                    "group relative flex items-center gap-3 rounded-md py-2 text-sm transition-[padding,background-color,color] duration-200",
                    collapsed ? "px-4" : "px-3",
                    active
                      ? "text-brand-text"
                      : "text-muted hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  {/* key={pathname}：路由切换时重挂载图标，让新活动项重放轻弹动画。
                      shrink-0：收起态行内容 = 图标16 + gap12 + label(0)，超出 px-4 后
                      的 16px 内容盒，不锁死最小宽度的话 flex 会把图标挤瘪成小点。 */}
                  <Icon key={pathname} className={cn("size-4 shrink-0", active && "nav-icon-pop")} />
                  {/* 文字常驻挂载：收起时 max-width 收 0 + 淡出（先于侧栏宽度退场），
                      展开时延迟随宽度打开后擦入；padding 过渡让图标平滑滑向居中位 */}
                  <span
                    className={cn(
                      "overflow-hidden whitespace-nowrap transition-[max-width,opacity] duration-200",
                      collapsed ? "max-w-0 opacity-0" : "max-w-[10rem] opacity-100 delay-100",
                    )}
                  >
                    {t(labelKey)}
                  </span>
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

          {/* 托盘卡与底部控件常驻挂载：收起时快速淡出并移出焦点序（visibility），
              宽度延迟收窄后不会看到内容溢出侧栏边缘；展开时延迟随宽度打开后淡入 */}
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col transition-[opacity,visibility]",
              collapsed ? "invisible opacity-0 duration-150" : "opacity-100 delay-150 duration-300",
            )}
          >
            <WorkerPills fitToHeight />
          </div>

          <div
            className={cn(
              "mt-auto shrink-0 space-y-3 pt-4 transition-[opacity,visibility]",
              collapsed ? "invisible opacity-0 duration-150" : "opacity-100 delay-150 duration-300",
            )}
          >
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
        <main className="min-w-0 flex-1 overflow-x-clip">
          {/* 目录切换特效：pathname 变化时重挂载包装层，重放 page-enter 入场动画
              （globals.css）。软导航下 AppShell 不重挂载，动画只随路由重放。 */}
          <div key={pathname} className="page-enter">
            {children}
          </div>
        </main>
        <AssistantConsole />
        <FirstScoreView />
      </div>
      </ExploreProvider>
      </ApplyProvider>
      </PipelineProvider>
    </JobsProvider>
  );
}

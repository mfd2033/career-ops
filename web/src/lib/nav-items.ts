import { LayoutDashboard, Compass, ListChecks, Send, Radar, BarChart3, FileText, Settings } from "lucide-react";
import type { ComponentType, SVGProps } from "react";

// Single source of truth for the app's primary destinations — shared by the
// desktop sidebar and the mobile nav so they can never drift. `labelKey` is an
// i18n dictionary key (nav.*) resolved through the language provider.
export type NavItem = {
  href: string;
  labelKey: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  chipKey?: string;
};

export const NAV_ITEMS: NavItem[] = [
  { href: "/", labelKey: "nav.today", icon: LayoutDashboard },
  { href: "/explore", labelKey: "nav.explore", icon: Compass, chipKey: "nav.newChip" },
  { href: "/pipeline", labelKey: "nav.pipeline", icon: ListChecks },
  { href: "/followups", labelKey: "nav.followups", icon: Send },
  { href: "/portals", labelKey: "nav.portals", icon: Radar },
  { href: "/analytics", labelKey: "nav.analytics", icon: BarChart3 },
  { href: "/cv", labelKey: "nav.cv", icon: FileText },
  { href: "/config", labelKey: "nav.config", icon: Settings },
];

export function isActivePath(href: string, pathname: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

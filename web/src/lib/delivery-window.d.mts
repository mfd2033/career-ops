// delivery-window.mjs 的类型声明（房规 ADR-0050：纯模块 + 同族 d.ts）。
// 引擎只回码与数值，不含任何人类文案（文案在 i18n clusters/delivery.ts）。

export type DeliveryLevel = "best" | "ok" | "avoid";
export type DayType = "mon" | "midweek" | "fri" | "weekend";
export type DeliveryAction = "send" | "ok" | "wait";

export type MatrixWindow = { start: number; end: number; level: DeliveryLevel };

export type UpcomingWindow = {
  start: Date;
  end: Date;
  startMin: number;
  endMin: number;
  level: DeliveryLevel;
  /** 相对 from 所在日的天数：0 = 今天，1 = 明天。 */
  dayOffset: number;
  /** true = from 已落在该窗口内。 */
  current: boolean;
};

export type PlatformAdvice = {
  platform: string;
  dayType: DayType;
  level: DeliveryLevel;
  window: MatrixWindow;
  nextBest: UpcomingWindow | null;
};

export type DeliverySummary = {
  clock: string;
  dayType: DayType;
  action: DeliveryAction;
  platforms: PlatformAdvice[];
  nextGold: (UpcomingWindow & { platform: string }) | null;
};

export const PLATFORMS: string[];
export const LEVELS: DeliveryLevel[];
export const DAY_TYPES: DayType[];

export function dayTypeOf(date: Date): DayType;
export function minutesOfDay(date: Date): number;
export function formatMinutes(min: number): string;
export function windowsFor(platform: string, dayType: DayType): MatrixWindow[];
export function windowAt(platform: string, date: Date): MatrixWindow;
export function nextWindow(
  platform: string,
  from: Date,
  opts?: { levels?: DeliveryLevel[]; horizonDays?: number },
): UpcomingWindow | null;
export function adviceFor(platform: string, now: Date): PlatformAdvice;
/**
 * `platformIds` 指定只看哪几个平台（缺省全部）；传空数组或全是未知 id →
 * `platforms: []`、`action: "wait"`、`nextGold: null`，调用方据此改说
 * 「该来源没有已知规律」。
 */
export function summarize(now?: Date, opts?: { platformIds?: string[] }): DeliverySummary;

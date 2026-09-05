// 申请按钮行为配置：决定「管道页面」上的 Apply 按钮点击后做什么。
//
// - "link"（默认）：直接在新标签页打开职位链接，进阶申请流程无关；
// - "form"：读取申请表单 —— 走 apply.open() 表单代理流程（预填 + 用户自行提交）。
//
// 值持久化在 localStorage 的 career-ops:config（与 cliId/model 同处），
// 缺失或非法值回落到默认 "link"，保证老用户/SSR 行为一致、无异常。

export type ApplyBehavior = "link" | "form";

/** 配置值存放的 localStorage 主键（与 saved-cli.ts 的 CONFIG_KEY 同值）。 */
export const APPLY_BEHAVIOR_KEY = "career-ops:config";

/** 字段名，写入 career-ops:config 对象的属性。 */
export const APPLY_BEHAVIOR_FIELD = "applyBehavior";

/** 未配置时的默认行为：直接打开职位链接。 */
export const APPLY_BEHAVIOR_DEFAULT: ApplyBehavior = "link";

function isApplyBehavior(value: unknown): value is ApplyBehavior {
  return value === "link" || value === "form";
}

/**
 * 读取当前配置的申请按钮行为。仅在客户端可用（依赖 localStorage）；
 * SSR 时调用方应在 useEffect 等浏览器阶段调用，或以默认值/加载态兜底。
 */
export function readApplyBehavior(): ApplyBehavior {
  try {
    const raw = localStorage.getItem(APPLY_BEHAVIOR_KEY);
    const value = raw ? (JSON.parse(raw) as Record<string, unknown>)[APPLY_BEHAVIOR_FIELD] : undefined;
    return isApplyBehavior(value) ? value : APPLY_BEHAVIOR_DEFAULT;
  } catch {
    return APPLY_BEHAVIOR_DEFAULT;
  }
}

/** 持久化申请按钮行为，不影响 career-ops:config 中其它字段。 */
export function persistApplyBehavior(behavior: ApplyBehavior) {
  try {
    const raw = localStorage.getItem(APPLY_BEHAVIOR_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    localStorage.setItem(APPLY_BEHAVIOR_KEY, JSON.stringify({ ...prev, [APPLY_BEHAVIOR_FIELD]: behavior }));
  } catch {
    /* quota / private mode */
  }
}
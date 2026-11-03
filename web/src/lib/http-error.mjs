/**
 * 接口失败 → 闭集错误类 → i18n 键（一处口径，多个调用方）。
 *
 * 为什么需要它：`/api/*` 回的 `{error: "..."}` 是**内部措辞**——`"bad json"`、
 * `"invalid word list"`、`"portals.yml not found"`、`"company is required"`——
 * 直接上屏等于把实现细节交给用户，而且指不出一条他能做的动作。
 *
 * 为什么抽出来：这条口径一旦各写一份，第三个页面必然再漏一次。事实来源很近：
 * 黑名单页在 UI 审计 FAIL #11 之后做对过一次（短码映射），标题门在 2026-11-03
 * 的审查里又漏了一次。判定放这里，页面只负责给每个类一条文案。
 *
 * 注意它**不做**的事：不猜服务端文案、不把 status 拼进界面、不吞掉未识别的类
 * （未覆盖的类回落到调用方的 `server` 键，而不是静默渲染成裸 id）。
 */

/** 闭集：一次接口失败只可能是这几类之一。 */
export const ERROR_CLASSES = Object.freeze(["bad_request", "not_found", "conflict", "server", "network"]);

/**
 * 一次失败归到哪一类。
 *
 * `status` 缺省（`fetch` 自己抛——服务没起、断网、被取消）= `"network"`：那是最常见
 * 的一种「没有状态码」，把它算成 server 会让文案指向「服务端出错」，方向是错的。
 *
 * @param {number | string | null | undefined} status
 * @returns {"bad_request" | "not_found" | "conflict" | "server" | "network"}
 */
export function errorClass(status) {
  const code = Number(status);
  if (status == null || !Number.isInteger(code) || code < 100) return "network";
  if (code === 400 || code === 422) return "bad_request";
  if (code === 404) return "not_found";
  if (code === 409) return "conflict";
  return "server";
}

/**
 * 错误类 → i18n 键。
 *
 * `keys.server` 是必填的通用兜底：任何没被显式覆盖的类都回落到它，所以新增一类失败
 * 不会渲染成裸键名，只是暂时共用通用文案。
 *
 * @param {{server: string, network?: string, bad_request?: string, not_found?: string, conflict?: string}} keys
 * @param {number | string | null | undefined} [status] 省略 = 网络失败
 * @returns {string} i18n 键（不是译文——调用方在渲染时 `t()`，切换语言才能跟上）
 */
export function errorKey(keys, status) {
  const cls = errorClass(status);
  return keys[cls] ?? keys.server;
}

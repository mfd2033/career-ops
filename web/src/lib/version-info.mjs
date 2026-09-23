// /api/version 的核心版本折叠（纯函数，fork #8）。
//
// WHY THIS EXISTS: 打包版跑的是 Next standalone 树，运行时 cwd 落在
// `.dashboard-runtime\v{ver}\app\`，那里没有仓库根的 VERSION 文件、旧打包的
// build-info.json 也不含 core 版本，`coreVersion` 会静默塌成空串；哪天打 RC 包时
// channel 也会因读不到 core 后缀而误报。把三个来源折成响应字段这一步抽出来，
// 既让 route.ts 保持薄，也能不启服务锁死口径（见 tests/lib/version-info.test.mjs）。
//
// 来源优先级：打包时冻结的 buildInfoCoreVersion 胜出 —— 运行时 cwd 在用户 checkout
// 内，磁盘 VERSION 反映的是用户工作树而非这个 bundle（同 sha 的取舍，见 route.ts）。
// dev 没有 build-info → 回落磁盘 VERSION。
//
// Plain .mjs（同 run-steps.mjs）：node --test 锁定，不 import tsx。

/** 取首个空白分隔 token 并去空白：兼容 `1.28.0 # x-release-please-version` 这类带注释的版本串。 */
const firstToken = (s) => (typeof s === "string" && s.trim() ? s.trim().split(/\s+/)[0] : "");

/**
 * @param {{ fileVersion?: string, buildInfoCoreVersion?: string, webVersion?: string }} src
 *   - fileVersion: 磁盘 VERSION 文件内容（dev 来源）
 *   - buildInfoCoreVersion: 打包时写入 build-info.json 的 core 版本（packaged 来源，优先）
 *   - webVersion: web 组件自身 package.json 版本
 * @returns {{ version: string, coreVersion: string, channel: string }}
 */
export function resolveVersionChannels({ fileVersion, buildInfoCoreVersion, webVersion } = {}) {
  const coreVersion = firstToken(buildInfoCoreVersion) || firstToken(fileVersion);
  const web = firstToken(webVersion);
  // Channel precedence: an explicit core pre-release suffix wins (RC installs);
  // otherwise the web component's own maturity decides — pre-1.0 on main IS the
  // alpha, and the banner/bug-report stay visible until web graduates to 1.0.
  const m = coreVersion.match(/-(rc|beta|alpha|next)\b/i);
  const channel = m ? m[1].toLowerCase() : web && /^0\./.test(web) ? "alpha" : "stable";
  const version = web ? `web ${web}` : coreVersion;
  return { version, coreVersion, channel };
}

/**
 * 这台服务端的能力清单（ADR-0051 决议 11）：build 期常量，不是用户配置。
 *
 * WHY HERE, NOT IN /api/config: 那个端点背后的 store 是用户可改的
 * `~/.career-ops-web/config.json`——拿它做协议协商就是把「用户设了啥」当成
 * 「代码能干什么」；常量放这里，老服务端没这个字段就是不支持，无需额外版本比较。
 *
 * - `single-eval-inline-jd`：`/api/run` 认 `jdText`/`company`（内联 JD 已下沉到
 *   `buildPrompt`），所以浏览器扩展的单职位评估可以走 `/api/run` + `/api/events`。
 */
export const SERVER_CAPABILITIES = Object.freeze(["single-eval-inline-jd"]);

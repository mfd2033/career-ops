// ext-nav-paths.mjs — 扩展 → web 前端路由跳转的路径白名单（ADR-0055 修订 / ADR-0078）。
//
// 窗口消息对页面内任何脚本可见，路由目标必须白名单化——Next 文档也明确禁止把未消毒
// 的 URL 交给 router.push（javascript: 之类会在本页上下文执行）。判断抽成无依赖模块：
// ExtNavBridge（TSX）消费它，node 单测直接 import 门住，白名单改动不过测不进去。

export const REPORT_PATH_RE = /^\/report\/[0-9]{1,6}$/;
export const PIPELINE_PATH_RE = /^\/pipeline$/;

/**
 * 扩展允许前端路由跳转的 path：
 *   - /report/{n}  评估报告页（ADR-0055）
 *   - /pipeline    收件箱——浮窗标题栏 🌐 的固定落点（ADR-0078）
 * 不匹配的一律不应答（让扩展回退到它自己拼好的整页 URL）。
 * @param {string} path
 */
export function isExtNavPath(path) {
  return REPORT_PATH_RE.test(path) || PIPELINE_PATH_RE.test(path);
}

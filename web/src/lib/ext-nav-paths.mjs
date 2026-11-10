// ext-nav-paths.mjs — 扩展 → web 前端路由跳转的路径白名单（ADR-0055 修订 / ADR-0078）。
//
// 窗口消息对页面内任何脚本可见，路由目标必须白名单化——Next 文档也明确禁止把未消毒
// 的 URL 交给 router.push（javascript: 之类会在本页上下文执行）。判断抽成无依赖模块：
// ExtNavBridge（TSX）消费它，node 单测直接 import 门住，白名单改动不过测不进去。

export const REPORT_PATH_RE = /^\/report\/[0-9]{1,6}$/;
export const PIPELINE_PATH_RE = /^\/pipeline$/;
// 工作器任务页：列表卡上「评估中 / 排队中」胶囊的落点。扩展发起的 run 被 web 端接管后
// 卡片 id 是 adopt-{runId}（web/src/lib/job-adopt.mjs 的 ADOPT_PREFIX），runId 只收
// UUID 形态——这条 path 会直接进 router.push，收紧到「前缀 + 标准 UUID」比放行任意
// /jobs/* 更省事，也不给别的卡片 id 开后门。
export const JOB_ADOPT_PATH_RE =
  /^\/jobs\/adopt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 扩展允许前端路由跳转的 path：
 *   - /report/{n}            评估报告页（ADR-0055）
 *   - /pipeline              收件箱——浮窗标题栏 🌐 的固定落点（ADR-0078）
 *   - /jobs/adopt-{uuid}     工作器任务页——列表卡「评估中 / 排队中」胶囊的落点
 * 不匹配的一律不应答（让扩展回退到它自己拼好的整页 URL）。
 * @param {string} path
 */
export function isExtNavPath(path) {
  return REPORT_PATH_RE.test(path) || PIPELINE_PATH_RE.test(path) || JOB_ADOPT_PATH_RE.test(path);
}

// followup-cadence-read — core `followup-cadence.mjs --json` 的 stdout 解析
// （ADR-0075 决议 7）。纯逻辑、零依赖：单测可直接 node --test 导入。
//
// 契约：解析不出来一律 null——调用方 fail-closed（报告页入口隐藏、
// /api/followups 回 available:false），绝不抛错、绝不猜半截输出。
// 从第一个 `{` 起解析：现实 stdout 允许噪声前缀（与抽取前路由内联解析的
// 行为逐项一致——CLI 若先打 warning 行，载荷仍要被找到）。

/**
 * @param {unknown} stdout core 进程的原始 stdout
 * @returns {{ metadata: unknown, entries: unknown[], cadenceConfig: unknown } | null}
 */
export function parseCadenceStdout(stdout) {
  if (typeof stdout !== "string") return null;
  const start = stdout.indexOf("{");
  if (start === -1) return null;
  let j;
  try {
    j = JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
  return {
    metadata: j.metadata ?? null,
    entries: Array.isArray(j.entries) ? j.entries : [],
    cadenceConfig: j.cadenceConfig ?? null,
  };
}

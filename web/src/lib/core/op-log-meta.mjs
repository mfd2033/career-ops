/**
 * op-log-meta.mjs — 配置类台账的 meta 组装。
 *
 * 为什么单独成一个纯 .mjs：这段纪律（只记键名、不记值、字段数封顶）比它看起来
 * 重要得多——cv.md / config/profile.yml / portals.yml 的值里有本机绝对路径、邮箱、
 * 密钥，台账是回看用的索引，不是数据的副本。放在 .ts 里 node --test 够不着，
 * 于是这条纪律只能靠人读代码守住；下沉成纯函数后 tests/lib/op-log-meta.test.mjs
 * 就能钉住它。
 *
 * 调用方（web/src/lib/op-log-server.ts 的 logConfigWrite）只负责提供键名列表，
 * 值由各路由自己决定要不要记——本函数不会、也不该去猜测哪些是敏感值。
 */

/** fields 条目最多列几个键：再多就不是「改了哪些」，而是一份字段清单。 */
export const MAX_CONFIG_FIELDS = 12;

/**
 * 组装一条配置类台账的 meta：调用方自带的 key/value 在前，`fields` 条目在后。
 *
 * @param {unknown} [fields] 被改动的键名（非字符串会被 String() 转换；空串与
 *   空白项丢弃，绝不留下占位）
 * @param {Array<{k: string, v: string}>} [meta] 调用方要额外记录的键值（如词条数）
 * @returns {Array<{k: string, v: string}>} 可直接落盘的新数组
 */
export function buildConfigMeta(fields, meta = []) {
  const out = [...(meta ?? [])];
  const keys = (Array.isArray(fields) ? fields : [])
    .map((f) => String(f ?? "").trim())
    .filter(Boolean)
    .slice(0, MAX_CONFIG_FIELDS);
  if (keys.length > 0) out.push({ k: "fields", v: keys.join(", ") });
  return out;
}

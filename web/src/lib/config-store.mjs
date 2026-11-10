// career-ops:config 的整包快照写入。
//
// 这个 localStorage 键上住着多个模块各自负责的字段：
//   - saved-cli.ts：mode / cliId / model / modelCliId / unknownEmployer
//   - scan-mode.ts：scanSource
//   - apply-behavior.ts：applyBehavior
//   - scan-max.mjs：scanMaxBySource
//   - config-form.tsx：logos
// 每个模块各自 read-modify-write 自己的字段（spread 合并），谁都不拥有整对象。
//
// 配置页「保存」是唯一一次整包写入，它按自己的白名单重建对象，于是把别人写的字段
// 一起删了——`scanMaxBySource` 就是这么丢的：save() 先 persistScanMax()，紧接着
// 白名单整包写入抹掉它，配置页刷新后回落默认值（猎聘 1200），而保存条照样显示「已保存」。
// 所以整包写入必须只在 prev 上覆盖自己负责的字段，绝不重建对象。
//
// 纯 .mjs 便于 node --test 直接用假的 localStorage 钉住这条边界。

/** 配置值存放的 localStorage 主键。 */
export const CONFIG_KEY = "career-ops:config";

/** 读出整个配置对象；缺失或损坏（非 JSON / 非对象）时回落空对象。 */
export function readConfigObject() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 整包写入配置快照：`fields` 覆盖同名字段，其余字段（属于别的模块）原样保留。
 * @param {Record<string, unknown>} fields 本次保存负责的字段
 * @returns {boolean} 是否写成功（quota / 隐私模式返回 false，不抛）
 */
export function writeConfigSnapshot(fields) {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...readConfigObject(), ...fields }));
    return true;
  } catch {
    return false;
  }
}

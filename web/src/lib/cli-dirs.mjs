import path from "node:path";

// 用户为某个引擎指定的安装目录（ADR-0097）。
//
// 归一化只有这一份实现：写端（/api/config）与用端（clis.ts 的检测、派发、
// 目录测试）都过它。分成两份的代价是同一个值在两处以不同形状参与查找，而
// 「我明明填了目录，用的却还是别处那份」是这个功能最难自查的失败。
//
// 纯函数：平台、home 都由调用方注入，测试因此不需要碰真实环境。

/** 引擎 id 的形状（`claude`、`qoder-cn`）——目录表的键只认这个，别的键一律丢弃。 */
const ENGINE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** 目录字符串的长度上限：真实路径远短于此，超长只可能是贴错了东西。 */
const MAX_DIR_LENGTH = 512;

/**
 * 把一个用户填的目录归一化；不可用时返回 null。
 *
 * 处理的三件真实麻烦：资源管理器「复制路径」会带引号（含空格路径尤其常见）；
 * `~` 是用户对 home 的写法；相对路径的解析基准是被派发子进程的 cwd，用户无从
 * 知道，所以一律拒绝而不是猜一个。
 *
 * @param {unknown} raw - 输入框原值
 * @param {string} [home] - 用户 home，用于展开 `~`
 * @returns {string|null} 绝对路径（去掉尾部路径分隔符），或 null
 */
export function normalizeCliDir(raw, home = "") {
  if (typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value || value.length > MAX_DIR_LENGTH) return null;
  if (value.length > 1) {
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1).trim();
  }
  if (!value || value.length > MAX_DIR_LENGTH) return null;
  if (value === "~") value = home;
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = path.join(home, value.slice(2));
  if (!path.isAbsolute(value)) return null;
  // `D:\tools\bin\` 与 `D:\tools\bin` 是同一个目录；统一成一种形状，界面回显
  // 才不会因为多了一个反斜杠看起来像「没保存成功」。
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed || value;
}

/**
 * 清洗整张「引擎 id → 安装目录」表：非对象 → 空表，键不是引擎 id 的项丢弃，
 * 值归一化失败的项丢弃。脏值宁可消失，也不要带着一个不可解析的目录去派发。
 *
 * @param {unknown} raw
 * @param {string} [home]
 * @returns {Record<string, string>}
 */
export function sanitizeCliDirs(raw, home = "") {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!ENGINE_ID_RE.test(key)) continue;
    const dir = normalizeCliDir(value, home);
    if (dir) out[key] = dir;
  }
  return out;
}

/**
 * `file` 是否就在 `dir` 里面（含子目录）。用于回答「这次命中的二进制是不是来自
 * 你指定的那个目录」——`path.relative` 比字符串前缀可靠：后者会把
 * `/opt/bin2/x` 误判成在 `/opt/bin` 里。
 *
 * @param {string} dir
 * @param {string} file
 * @returns {boolean}
 */
export function isInsideDir(dir, file) {
  if (!dir || !file) return false;
  const rel = path.relative(dir, file);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * 目录表的签名，供检测缓存在目录变化时自动失效（ADR-0097 决议 4）。
 * 排序后再序列化：写入顺序变化不等于目录变化。
 *
 * @param {Record<string, string>} [dirs]
 * @returns {string}
 */
export function cliDirsSignature(dirs) {
  const entries = Object.entries(dirs ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

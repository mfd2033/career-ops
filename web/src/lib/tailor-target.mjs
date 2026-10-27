// 定制简历目标解析（findTailorTarget 的纯内核）。
//
// 给定 tracker 编号，纯函数解析出定制简历生成链路所需的全部输入：
//   { ok: true, company, role, jdText, reportPath }
// 行不存在或没有可定制的 JD/报告时返回结构化错误：
//   { ok: false, reason: "row-not-found" | "missing-jd" }
//
// WHY PLAIN .mjs + 依赖注入：与 cv-pdf-resolve.mjs / pdf-paths.mjs 同一条纪律——
// 纯逻辑落在 .mjs 里，`node --test` 能直接锁契约（career-ops.ts 是 TS，跑不了裸
// node --test）；`root`、tracker/report 读取、jds 归档查找都由调用方注入，本模块
// 不 import TypeScript，也不碰网络或写操作。调用方（career-ops.ts）把这些依赖接成
// 真实读盘，路由再 import career-ops.ts 的 findTailorTarget（与 findCheckupTarget 同源）。
//
// company 解析复用 findCheckupTarget 的模式：`?` 未知雇主行回退到报告 Via（招聘
// 主体），这样产物目录键与后续尽调用的是同一个可读名字；解析不出就用原始 company
// （slugify 后会落 "application"，定制链路只把它当目录键，不需要它是干净雇主名）。
//
// jdText 的取值顺序（openai-tailor.mjs 同时吃 --jd 与 --report，两者都得有）：
//   1. `jds/` 里按报告号命中的归档正文（剥掉 frontmatter，够长才算数）；
//   2. 回退到评估报告正文（Block A 岗位概览即来自 JD，报告在场就总能拿去定制）。
// 报告文件本身缺失 = 没有可定制的对象 = missing-jd（openai-tailor 硬性要求 --report）。

/** jdText 视为「可用」的最小正文长度——空壳/坏归档不参定制，同 jdsBodies 的防噪声口径。 */
const MIN_JD_BODY = 50;

/** 剥掉 markdown 归档头部的 YAML frontmatter（`---\n...\n---`），返回其后的正文。 */
function stripFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** 够长且非纯空白才算一份可用的 JD 正文。 */
function usableBody(text) {
  return typeof text === "string" && text.trim().length >= MIN_JD_BODY ? text.trim() : null;
}

/**
 * 解析定制简历目标。所有外部读取都通过 deps 注入，本函数不做任何 I/O。
 *
 * @param {string} n tracker 行号（字符串，允许带前导零）。
 * @param {{
 *   findApplication: (n: string) => { company?: string, role?: string } | null,
 *   findCheckupTarget?: (n: string) => { ok: true, company: string } | { ok: false },
 *   findReportFilePath: (n: string) => string | null,
 *   readTextFile: (absPath: string) => string | null,
 *   findJdCapturePath?: (n: string) => string | null,
 * }} deps
 * @returns {{ ok: true, company: string, role: string, jdText: string, reportPath: string }
 *          | { ok: false, reason: "row-not-found" | "missing-jd" }}
 */
export function resolveTailorTarget(n, deps) {
  const { findApplication, findReportFilePath, readTextFile } = deps;
  const app = findApplication(n);
  if (!app) return { ok: false, reason: "row-not-found" };

  const role = String(app.role ?? "").trim();

  // company：优先复用 findCheckupTarget 的 `?`→Via 回退（同一个可读招聘主体名），
  // 拿不到就退回 tracker 行的原始 company；两者都空时用空串（下游 slugify 兜底）。
  let company = String(app.company ?? "").trim();
  const resolved = deps.findCheckupTarget ? deps.findCheckupTarget(n) : null;
  if (resolved && resolved.ok && resolved.company) company = resolved.company;

  // 报告是定制链路的硬前置：openai-tailor 需要 --report，且 JD 回退也读它。
  const reportPath = findReportFilePath(n);
  if (!reportPath) return { ok: false, reason: "missing-jd" };

  // jdText：优先 jds 归档正文，其次报告正文。两者都不可用 → missing-jd。
  const capturePath = deps.findJdCapturePath ? deps.findJdCapturePath(n) : null;
  if (capturePath) {
    const captureBody = usableBody(stripFrontmatter(readTextFile(capturePath) ?? ""));
    if (captureBody) return { ok: true, company, role, jdText: captureBody, reportPath };
  }
  const reportBody = usableBody(readTextFile(reportPath) ?? "");
  if (reportBody) return { ok: true, company, role, jdText: reportBody, reportPath };

  return { ok: false, reason: "missing-jd" };
}

// job-label.mjs — 任务卡标题的「公司 · 岗位」可读标签。
//
// WHY: 批量评估的并发池卡片（/api/batch-evaluate 的 acquire）以前 title 直接是 URL，
// 于是 /jobs 历史列表与侧栏托盘把一串招聘站链接当标题印出来，看不出在评估谁。这里
// 把两处**诚实**来源拼成展示标签，供派发与台账写入端消费：
//   1. 派发时能带就带：pipeline.md 待办行本就写着 `URL | 公司 | 岗位`（readInbox），
//      批量派发的 URL 大多与这些行同源，直接命中；
//   2. 完成后回填：报告 Machine Summary 的 `company`/`role` 是评估员落定的事实，
//      worker 写出报告后用它覆盖（URL 不在 pipeline.md 时也只有这一条路）。
// 拼不出的字段一律不猜——返回空串，调用方保留原 URL（不编造）。
//
// Plain .mjs：node --test 锁定（同 report-salary.mjs）。

/** Machine Summary 的字段行（YAML 围栏内，行首、可能带缩进与引号）。 */
const COMPANY_LINE_RE = /^[ \t]*company:[ \t]*(.*)$/m;
const ROLE_LINE_RE = /^[ \t]*role:[ \t]*(.*)$/m;
/** YAML 里的「没有值」写法——不算有值。 */
const NO_VALUE_RE = /^(null|~|none|n\/a|-)$/i;

/** 去 YAML 引号/空白；空值与占位返回 ""。 */
function cleanFieldValue(raw) {
  const text = String(raw ?? "").trim().replace(/^["']|["']$/g, "").trim();
  return !text || NO_VALUE_RE.test(text) ? "" : text;
}

/**
 * 「公司 · 岗位」展示标签；两个字段缺一即退化，都缺返回 ""。
 * @param {unknown} company
 * @param {unknown} role
 * @returns {string}
 */
export function jobLabel(company, role) {
  const c = cleanFieldValue(company);
  const r = cleanFieldValue(role);
  if (c && r) return `${c} · ${r}`;
  return c || r || "";
}

/** 报告 Markdown 里 `## Machine Summary` 之后的片段（无该标题时退回全文）。 */
function machineSummarySection(md) {
  const m = md.match(/^##\s+Machine Summary\s*$/m);
  return m && m.index != null ? md.slice(m.index) : md;
}

/**
 * 报告 Markdown → 展示标签（解析 Machine Summary 的 company/role）。缺字段返回 ""。
 * @param {string} reportMd - 报告全文
 * @returns {string}
 */
export function reportJobLabel(reportMd) {
  const md = String(reportMd ?? "");
  if (!md) return "";
  const section = machineSummarySection(md);
  const c = section.match(COMPANY_LINE_RE);
  const r = section.match(ROLE_LINE_RE);
  return jobLabel(c && c[1], r && r[1]);
}

/**
 * pipeline.md 的 inbox 条目 → `Map<url, label>`（缺公司或岗位、或空 URL 的行不入表）。
 * 同 URL 重复出现时保留第一条（与 readInbox 的读取顺序一致）。
 * @param {Array<{url?: string, company?: string, role?: string}>} inbox - readInbox() 的结果
 * @returns {Map<string, string>}
 */
export function pipelineUrlLabels(inbox) {
  const map = new Map();
  for (const job of Array.isArray(inbox) ? inbox : []) {
    const url = typeof job?.url === "string" ? job.url.trim() : "";
    if (!url) continue;
    const label = jobLabel(job.company, job.role);
    if (label && !map.has(url)) map.set(url, label);
  }
  return map;
}
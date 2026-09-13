/**
 * unknown-employer.mjs — the unknown-employer policy's vocabulary plus the
 * precedence rule between the two places the value is stored.
 *
 * The policy lives in TWO stores on purpose, and they are read by different
 * consumers (ADR-0004 D3/D6):
 *
 *   - `localStorage["career-ops:config"]` — what the config page paints and what
 *     `report-view.tsx` reads to render a historical `?` row's agency fallback.
 *   - `~/.career-ops-web/config.json` (via `/api/config`) — what `/api/run` and
 *     `/api/batch-evaluate` read to build the worker prompt. The evaluate worker
 *     is a headless CLI, so it CANNOT read localStorage; this file is the only
 *     channel through which the user's choice reaches an actual evaluation.
 *
 * The failure that makes this module load-bearing: the client store can be
 * updated while the server write is lost (the mirror POST is best-effort), and
 * the drift is INVISIBLE — the config page paints from localStorage, so it
 * happily shows "显示代招方" while every evaluation silently reads the server's
 * "?" default and writes `?` into the tracker. That is exactly the report-#836
 * shape. So: the server value is the one an evaluation obeys and therefore WINS
 * when the two disagree; anything outside the two documented values is not a
 * value at all, and must never be treated as one (a junk string used to be able
 * to reach the UI and the prompt).
 *
 * Plain .mjs (not .ts) so `node --test` can pin the precedence rule directly —
 * the same convention as tracker-table.mjs / report-files.mjs.
 */

/**
 * @typedef {"placeholder" | "agency"} UnknownEmployerPolicy
 */

/** The two documented policies, and the only values either store may hold. */
/** @type {readonly UnknownEmployerPolicy[]} */
export const UNKNOWN_EMPLOYER_OPTIONS = ["placeholder", "agency"];

/** Displayed when neither store holds a usable value (`?` sentinel, current behaviour). */
/** @type {UnknownEmployerPolicy} */
export const UNKNOWN_EMPLOYER_DEFAULT = "placeholder";

/** The tracker's Company cell for a posting whose end employer is not named. */
export const UNKNOWN_EMPLOYER_SENTINEL = "?";

/**
 * 代招消歧后缀。ADR-0004 的风险节已经写明理由：代招公司是**中介不是雇主**，只显示它的
 * 名字会把粗心的读者引向错误结论（"我投的是云憬人力"）。后缀让「这是谁发布的」和
 * 「这是哪家雇的」在视觉上不混同；`—`（直招）不参与。
 */
export const AGENCY_DISPLAY_SUFFIX = "（代招）";

/**
 * @param {unknown} value
 * @returns {boolean} True when `value` is one of the two documented policies.
 */
export function isUnknownEmployerPolicy(value) {
  return UNKNOWN_EMPLOYER_OPTIONS.includes(/** @type {UnknownEmployerPolicy} */ (value));
}

/**
 * Which policy the page should display — and, because the evaluation reads the
 * server store, which policy is actually in force.
 *
 * Precedence: server > local > default. The server wins because it is what a
 * run obeys; showing the local value instead would re-create the silent drift
 * this module exists to end. `local` is only a fallback for the window before
 * the server has ever been told anything (fresh install, or `/api/config`
 * unreachable), so a first-run page still reflects whatever was picked locally.
 *
 * @param {{ server?: unknown, local?: unknown }} stores
 * @returns {UnknownEmployerPolicy}
 */
export function resolveUnknownEmployer({ server, local } = {}) {
  if (isUnknownEmployerPolicy(server)) return /** @type {UnknownEmployerPolicy} */ (server);
  if (isUnknownEmployerPolicy(local)) return /** @type {UnknownEmployerPolicy} */ (local);
  return UNKNOWN_EMPLOYER_DEFAULT;
}

// ── the poster label ("显示代招方") ──────────────────────────────────────────
//
// The report's `**Via:**` header is a free-text field: the same 猎头 writes
// themselves as 「云憬人力·猎头顾问（猎头中介）」, 「锐仕方达 (猎头顾问 王女士，哈尔滨分公司)」
// or press-ganged as 「猎头（河南万仕企业管理咨询有限公司）」. Rendering that raw string
// next to 「（代招）」 produces 「云憬人力·猎头顾问（猎头中介）（代招）」 — the firm name
// buried in the agency's own self-description. These helpers reduce it to the firm
// name, then add the marker. Observed shapes are pinned by
// tests/lib/unknown-employer-policy.test.mjs using the real Via values in this
// user's tracker, so a new shape shows up as a failing expectation rather than a
// quietly uglier label.

/** 中介在 Via 里给自己写的前缀/后缀角色词（不是公司名的一部分）。 */
const BARE_ROLE = /^(猎头|中介|外包|派遣|招聘|人力资源|HR)(顾问|中介|招聘)?$/;
/** 「这段文本里有公司名的特征」——决定「猎头（XX公司）」该保留哪一半。 */
const FIRM_HINT = /(公司|企业|集团|中心|服务|事务所|人力|科技|网络|信息)/;
/** 「这段括号里只是角色/联系人」——猎头、中介、张女士、outsourcing… */
const ROLE_HINT = /(猎头|中介|代招|外包|派遣|招聘|顾问|先生|女士|HR|outsourcing)/i;
/** 分隔公司名与联系人的中缀（「云憬人力·猎头顾问」「猎头 — 郑州睿资达…」）。 */
const NAME_SEPARATOR = /\s*[·・•—–]\s*/;

/**
 * Reduce a Via value to the poster's firm name ("" when there is no usable name).
 * Pure string surgery — no data is written back anywhere, so a wrong guess costs
 * one ugly label, never a corrupted tracker.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeAgencyName(raw) {
  let s = String(raw ?? "").trim().replace(/\s+/g, " ");
  if (!s || s === "—") return "";

  // 「云憬人力·猎头顾问」→ 前半是公司名；「猎头 — 郑州睿资达…」→ 前半只是角色词。
  const sep = s.match(NAME_SEPARATOR);
  if (sep && sep.index > 0) {
    const head = s.slice(0, sep.index).trim();
    const tail = s.slice(sep.index + sep[0].length).trim();
    s = normalizeAgencyName(tail && BARE_ROLE.test(head) ? tail : head || tail || s);
    return s;
  }

  // 「猎头（河南万仕企业管理咨询有限公司）」: the bracket holds the firm.
  const lead = s.match(/^([^（(]*?)\s*[（(]([^）)]+)[）)]$/);
  if (lead && BARE_ROLE.test(lead[1].trim()) && FIRM_HINT.test(lead[2])) s = lead[2].trim();

  // 「上海爱博斯…有限公司 (猎头夏女士)」: the bracket is only a role/contact.
  const trail = s.match(/^(.+?)\s*[（(]([^）)]*)[）)]$/);
  if (trail && ROLE_HINT.test(trail[2])) s = trail[1].trim() || s;

  return s.trim();
}

/**
 * The label to render for a `?` row under the agency policy: firm name + 代招 marker.
 * Already-marked text is returned unchanged (no 「（代招）（代招）」); an unusable
 * Via returns "" so the caller keeps the `?` sentinel instead of an empty cell.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function agencyDisplayLabel(raw) {
  const name = normalizeAgencyName(raw);
  if (!name) return "";
  return name.includes("代招") ? name : `${name}${AGENCY_DISPLAY_SUFFIX}`;
}

/**
 * The company cell / report title a row should display.
 *
 * Used by BOTH the pipeline list and the report page — one rule, so the two
 * surfaces cannot disagree (they drifted apart once already: the page had an
 * agency fallback the list never had).
 *
 * @param {{ company?: unknown, agency?: unknown, policy?: unknown }} row
 * @returns {string} the tracker value for a known employer, `?` when the policy is
 *   placeholder (or no agency was recorded), else 「{agency}（代招）」.
 */
export function resolveCompanyLabel({ company, agency, policy } = {}) {
  const raw = String(company ?? "").trim();
  if (raw !== UNKNOWN_EMPLOYER_SENTINEL) return raw;
  if (policy !== "agency") return raw;
  return agencyDisplayLabel(agency) || raw;
}

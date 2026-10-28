// 跟进话术模板的纯解析与填充（ADR-0080）。
//
// 事实来源：仓库根的 templates/followup-scripts.md（行式严格 markdown）。同一份
// 文件既要给人读（行动清单生成）又要给机器读（LogDialog 生成话术），所以解析
// 规则必须窄且确定：`##` 标题 = 模板名；正文固定四条 `- 分组/场景/事实/意向/
// 下一步:`。解析器不猜、不补、不丢弃——白名单外的占位符原样保留 `{key}`。
//
// 拆成纯 .mjs 是为了让 node --test 直接门住解析与填充（web/tests/lib/
// followup-scripts.test.mjs）——路由 .ts 无法被裸 node 导入（同 ADR-0079 决策 7）。

/** 四个场景桶，顺序即 UI 一级 chips 的顺序（ADR-0080 决策 5）。 */
export const SCRIPT_GROUPS = ["首轮跟进", "二轮保岗", "售前问出差", "留档"];

/** 正文固定三行，顺序即渲染顺序；左栏标签与正文同 line-height 对齐。 */
export const LINE_LABELS = ["事实", "意向", "下一步"];

/** 自动占位符：话术里的键 → CadenceEntry 上的字段。取不到值就保留花括号。 */
export const AUTO_PLACEHOLDER_MAP = {
  "{投递日}": "appliedDate",
  "{岗位名}": "role",
  "{编号}": "num",
  "{公司名}": "company",
  "{天数}": "daysSinceApplication",
  "{跟进次数}": "followupCount",
  "{上次跟进日}": "lastFollowupDate",
};

/** 手填占位符：没有数据源，复制后由用户自己补——刻意保留花括号当提示。 */
export const MANUAL_PLACEHOLDERS = ["{城市}", "{原因}", "{时间}"];

/** 文件里出现的每个 `{...}` 键（自动 + 手填 + 任何用户新写的）。 */
export function placeholderKeys(text) {
  const out = [];
  const re = /\{([^{}]+)\}/g;
  let m;
  while ((m = re.exec(String(text ?? ""))) !== null) out.push(`{${m[1]}}`);
  return out;
}

/**
 * CadenceEntry（或任何同形状对象）→ 占位符值。返回 null 表示这个键取不到值，
 * 调用方保留花括号。`{上次跟进日}` 取最近一条跟进记录；`{编号}` 去掉小数尾巴
 * 防 `137.0` 这种脏值落进话术。
 */
function valueFor(key, row) {
  if (!row || typeof row !== "object") return null;
  const field = AUTO_PLACEHOLDER_MAP[key];
  if (!field) return null;
  let value;
  if (field === "lastFollowupDate") {
    const list = Array.isArray(row.followups) ? row.followups : [];
    value = list.length ? list[list.length - 1]?.date : null;
  } else {
    value = row[field];
  }
  if (value === undefined || value === null || value === "") return null;
  return typeof value === "number" ? String(value) : String(value);
}

/**
 * 把一段正文里的占位符替换掉。取不到值 / 不在自动映射表里的键原样保留，并
 * 收集到 missing 里——UI 据此标「复制后你自己补」，测试据此断言不静默清空。
 */
export function fillText(text, row) {
  const missing = [];
  const filled = String(text ?? "").replace(/\{[^{}]+\}/g, (token) => {
    const value = valueFor(token, row);
    if (value === null) {
      if (!missing.includes(token)) missing.push(token);
      return token;
    }
    return value;
  });
  return { text: filled, missing };
}

const NAME_RE = /^##\s+(.+?)\s*$/;
const FIELD_RE = /^-\s*(分组|场景|事实|意向|下一步)\s*[:：]\s*(.*)$/;

/**
 * 解析 templates/followup-scripts.md → 模板数组。
 *
 * 只认 `##` 标题与那四条 bullet：文件头的说明 bullet（`- **自动填充的占位符**…`）
 * 天然不匹配 FIELD_RE，因此不会污染正文。缺正文（只有标题）的块被跳过——空模板
 * 进 UI 只会是空面板。
 */
export function parseScripts(markdown) {
  const scripts = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    const hasBody = LINE_LABELS.some((label) => current.lines[label]);
    if (hasBody) scripts.push(current);
    current = null;
  };

  for (const rawLine of String(markdown ?? "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const nameMatch = NAME_RE.exec(line);
    if (nameMatch) {
      flush();
      current = { name: nameMatch[1], group: "", scenario: "", lines: {} };
      continue;
    }
    if (!current) continue;
    const fieldMatch = FIELD_RE.exec(line);
    if (!fieldMatch) continue;
    const [, label, value] = fieldMatch;
    if (label === "分组") current.group = value.trim();
    else if (label === "场景") current.scenario = value.trim();
    else current.lines[label] = value.trim();
  }
  flush();

  return scripts.map((script) => ({
    ...script,
    placeholders: LINE_LABELS.flatMap((label) => placeholderKeys(script.lines[label] ?? "")),
  }));
}

/**
 * 按 row（CadenceEntry）填充一条模板 → 三行正文 + 缺值清单。
 * 返回新对象，不改动原模板。
 */
export function fillScript(script, row) {
  const missing = [];
  const lines = LINE_LABELS.map((label) => {
    const { text, missing: lineMissing } = fillText(script.lines[label] ?? "", row);
    for (const key of lineMissing) if (!missing.includes(key)) missing.push(key);
    return { label, text };
  });
  return {
    name: script.name,
    group: script.group,
    scenario: script.scenario,
    lines,
    missing,
  };
}

/** 一次填充全部模板。 */
export function fillScripts(scripts, row) {
  return scripts.map((script) => fillScript(script, row));
}

/**
 * 分组顺序：已知四桶按 SCRIPT_GROUPS 排在前，未知分组按出现顺序沉底——用户在
 * 文件里新加一个桶时不会静默丢掉它，只是排在后面。
 */
export function groupOrder(scripts) {
  const present = [];
  for (const script of scripts) {
    if (script.group && !present.includes(script.group)) present.push(script.group);
  }
  const known = SCRIPT_GROUPS.filter((g) => present.includes(g));
  const unknown = present.filter((g) => !SCRIPT_GROUPS.includes(g));
  return [...known, ...unknown];
}

/** 某个分组下的模板，保持文件里的顺序。 */
export function scriptsInGroup(scripts, group) {
  return scripts.filter((script) => script.group === group);
}

// 按推进情况自动挑话术的规则表（用户决策：不让用户选轮次，UI 直接显示当前阶段）。
// 顺序即优先级——freezeSuggested 要在「已跟进」之前判，冻结优先于常规再触达。
// prefer 是变体关键词：在目标桶里按模板名匹配，匹配不到落桶内第一条。
const STAGE_RULES = [
  {
    when: (row) => row.status === "applied" && (row.followupCount ?? 0) === 0,
    group: "首轮跟进",
    prefer: "投递",
  },
  {
    when: (row) => row.status === "applied" && row.freezeSuggested === true,
    group: "二轮保岗",
    prefer: "关闭",
  },
  {
    when: (row) => row.status === "applied",
    group: "首轮跟进",
    prefer: "已读",
  },
  {
    when: (row) => row.status === "responded",
    group: "售前问出差",
    prefer: "约面",
  },
  {
    when: (row) => row.status === "interview",
    group: "二轮保岗",
    prefer: "面",
  },
];

/**
 * 按本行推进情况自动挑一条话术。返回 scripts 的下标；空数组返回 -1。
 *
 * 规则（由 tracker 行的 status/followupCount/freezeSuggested 推导）：
 * - applied 且从未跟进过 → 首轮跟进·投递后无回应
 * - applied 且已跟进、引擎判定该冻结 → 二轮保岗·岗位或将关闭
 * - applied 且已跟进（其余情况）→ 首轮跟进·已读不回再触达
 * - responded（对方已回，约面阶段）→ 售前问出差·约面先问清
 * - interview（面后在等结果）→ 二轮保岗·面后等结果
 *
 * 模板名由用户随时改写，prefer 关键词只做「尽量」：目标桶里匹配不到就落桶内
 * 第一条，目标桶整个不存在就落第一条——绝不因名字变了而空手而归。
 */
export function suggestScriptIndex(scripts, row) {
  const list = Array.isArray(scripts) ? scripts : [];
  if (!list.length) return -1;
  const r = row && typeof row === "object" ? row : {};
  const status = String(r.status ?? "").toLowerCase();
  const rule = STAGE_RULES.find(({ when }) => when({ ...r, status }));
  if (!rule) return 0;
  const inGroup = scriptsInGroup(list, rule.group);
  if (!inGroup.length) return 0;
  const preferred = inGroup.find((script) => String(script.name ?? "").includes(rule.prefer));
  return list.indexOf(preferred ?? inGroup[0]);
}

/**
 * 二级 chips 的短名：模板名按 `·` 拆开后取最后一段（「首轮跟进 · 投递后无回应」
 * → 「投递后无回应」）。没有分隔符就整名返回——用户新写的命名不会因为格式不同
 * 而显示成空按钮。
 */
export function shortName(name) {
  const parts = String(name ?? "")
    .split("·")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(name ?? "").trim();
}

/**
 * 分组 → 显示用 i18n 键，与 followup-channel.mjs 的 channelLabelKey 同款：
 * 已知四桶有键，未知分组返回 null、调用方原样显示（用户在文件里新加的桶）。
 */
export function groupLabelKey(group) {
  return SCRIPT_GROUPS.includes(group) ? `followups.scriptGroup.${group}` : null;
}

/** 渲染层共用助手：分组值 → 显示文本。未知分组原样返回（不显示键名）。 */
export function groupLabel(group, t) {
  const key = groupLabelKey(group);
  return key ? t(key) : group;
}

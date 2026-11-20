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

/** 「适用」的通用值：没写 `- 适用:` 的模板对任何岗位可用（ADR-0080 修订 1）。 */
export const APPLIES_TO_ANY = "通用";

/**
 * `- 适用:` 原始文本 → 关键词数组。中英文逗号、顿号、斜杠都当分隔符；空值
 * 回落成「通用」——用户漏写一行不该让模板从所有岗位消失。
 */
export function splitApplies(raw) {
  const parts = String(raw ?? "")
    .split(/[,，、/]/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length ? parts : [APPLIES_TO_ANY];
}

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
    // 取日期最大的一条：引擎输出的 followups[] 虽然降序，但顺序不是契约，
    // 依赖下标会在多条跟进时取成最早的那次（报告 1165：11-11 写成 11-04）。
    const list = Array.isArray(row.followups) ? row.followups : [];
    value = list.reduce((latest, item) => {
      const date = item && item.date ? String(item.date) : "";
      if (!date) return latest;
      return !latest || date > latest ? date : latest;
    }, null);
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
const FIELD_RE = /^-\s*(分组|场景|适用|事实|意向|下一步)\s*[:：]\s*(.*)$/;

/**
 * 解析 templates/followup-scripts.md → 模板数组。
 *
 * 只认 `##` 标题与那五条 bullet（`适用` 可选）：文件头的说明 bullet（`- **自动填充
 * 的占位符**…`）天然不匹配 FIELD_RE，因此不会污染正文。缺正文（只有标题）的块被
 * 跳过——空模板进 UI 只会是空面板。
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
      current = { name: nameMatch[1], group: "", scenario: "", appliesRaw: "", lines: {} };
      continue;
    }
    if (!current) continue;
    const fieldMatch = FIELD_RE.exec(line);
    if (!fieldMatch) continue;
    const [, label, value] = fieldMatch;
    if (label === "分组") current.group = value.trim();
    else if (label === "场景") current.scenario = value.trim();
    else if (label === "适用") current.appliesRaw = value.trim();
    else current.lines[label] = value.trim();
  }
  flush();

  return scripts.map(({ appliesRaw, ...script }) => ({
    ...script,
    appliesTo: splitApplies(appliesRaw),
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
    // 适用条件必须随填充结果一起出到前端——选择器在 fillScripts 之后运行，
    // 这里丢了字段，岗位过滤就整体失效（ADR-0080 修订 1）。
    appliesTo: Array.isArray(script.appliesTo) && script.appliesTo.length ? script.appliesTo : [APPLIES_TO_ANY],
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

// 按推进情况自动挑话术的规则表（ADR-0080 修订 1：状态 → 候选桶序列）。
// 顺序即优先级——freezeSuggested 要在「已跟进」之前判，冻结优先于常规再触达。
// 每个候选桶一次只回答「这个桶里有没有适用于本岗位的模板」；不适用就换下一个
// 桶。prefer 只做桶内变体关键词匹配，匹配不到落该桶内第一条适用模板。
const STAGE_RULES = [
  {
    when: (row) => row.status === "applied" && (row.followupCount ?? 0) === 0,
    buckets: [{ group: "首轮跟进", prefer: "投递" }],
  },
  {
    when: (row) => row.status === "applied" && row.freezeSuggested === true,
    buckets: [{ group: "二轮保岗", prefer: "关闭" }],
  },
  {
    when: (row) => row.status === "applied",
    buckets: [{ group: "首轮跟进", prefer: "已读" }],
  },
  {
    when: (row) => row.status === "responded",
    // 售前类岗位先问出差；其余岗位「售前问出差」整桶不适用，落到通用的
    // 「对方已回」——1336（IT研发负责人）就是这条的回退路径。
    buckets: [
      { group: "售前问出差", prefer: "约面" },
      { group: "首轮跟进", prefer: "已回" },
    ],
  },
  {
    when: (row) => row.status === "interview",
    buckets: [{ group: "二轮保岗", prefer: "面" }],
  },
];

/**
 * 岗位名是否命中模板的适用条件。只做包含判断，不猜语义：
 * `通用`（或没写适用行）对任何岗位成立，其余关键词任一出现在岗位名里即成立。
 */
export function appliesToRole(script, role) {
  const applies = Array.isArray(script?.appliesTo) && script.appliesTo.length ? script.appliesTo : [APPLIES_TO_ANY];
  if (applies.includes(APPLIES_TO_ANY)) return true;
  const name = String(role ?? "");
  if (!name) return false;
  return applies.some((keyword) => keyword && name.includes(keyword));
}

/** 在一个候选桶里挑一条：先过滤适用岗位，再按 prefer 名称匹配，最后落桶内第一条。 */
function pickFromBucket(list, bucket, role) {
  const inGroup = scriptsInGroup(list, bucket.group).filter((script) => appliesToRole(script, role));
  if (!inGroup.length) return null;
  const preferred = inGroup.find((script) => String(script.name ?? "").includes(bucket.prefer));
  return preferred ?? inGroup[0];
}

/**
 * 按本行推进情况自动挑一条话术。返回 scripts 的下标；空数组返回 -1。
 *
 * 规则（由 tracker 行的 status/followupCount/freezeSuggested/role 推导）：
 * - applied 且从未跟进过 → 首轮跟进·投递后无回应
 * - applied 且已跟进、引擎判定该冻结 → 二轮保岗·岗位或将关闭
 * - applied 且已跟进（其余情况）→ 首轮跟进·已读不回再触达
 * - responded → 售前类岗位：售前问出差·约面先问清；其余岗位：首轮跟进·对方已回
 * - interview（面后在等结果）→ 二轮保岗·面后等结果
 *
 * 模板名由用户随时改写，prefer 关键词只做「尽量」：桶内匹配不到就落桶内第一条
 * 适用模板；候选桶全部没有适用模板，就退回全库第一条适用模板——绝不因名字或
 * 岗位不同而空手而归。
 */
export function suggestScriptIndex(scripts, row) {
  const list = Array.isArray(scripts) ? scripts : [];
  if (!list.length) return -1;
  const r = row && typeof row === "object" ? row : {};
  const status = String(r.status ?? "").toLowerCase();
  const rule = STAGE_RULES.find(({ when }) => when({ ...r, status }));
  for (const bucket of rule?.buckets ?? []) {
    const picked = pickFromBucket(list, bucket, r.role);
    if (picked) return list.indexOf(picked);
  }
  const anyFit = list.find((script) => appliesToRole(script, r.role));
  return list.indexOf(anyFit ?? list[0]);
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

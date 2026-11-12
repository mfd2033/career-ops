// 历史联系人聚合（纯逻辑）：把一条申请的已记录跟进（entry.followups）折叠成
// 「联系人 → 最近一次使用」，供「记录跟进」弹窗的联系人字段做选择。
//
// 拆成纯 .mjs 的原因与 followup-channel.mjs 相同：web/tests/lib 下的
// node --test 无法导入 .ts 组件，聊天逻辑落在这里才门得住。

/**
 * 折叠历史跟进里的联系人。
 *
 * 输入通常是引擎输出的 entry.followups（followup-cadence.mjs 已按日期倒序），
 * 所以某个联系人的首次出现就是它最近一次被使用。同一联系人只保留一条：
 * 去重键对大小写与首尾空白不敏感（"Zhang Wei " 与 "zhang wei" 是同一个人），
 * 展示值取最近一次记录里的原文，并累计使用次数。
 *
 * 空联系人（没填联系人的跟进）不参与，否则会冒出一个空 chip。
 *
 * @param {Array<{contact?: string, date?: string, channel?: string}>} followups
 * @returns {Array<{contact: string, date: string, channel: string, count: number}>}
 */
export function historyContacts(followups) {
  const byKey = new Map();
  for (const followup of Array.isArray(followups) ? followups : []) {
    const contact = typeof followup?.contact === "string" ? followup.contact.trim() : "";
    if (!contact) continue;
    const key = contact.toLowerCase();
    const hit = byKey.get(key);
    if (hit) {
      hit.count += 1;
      continue;
    }
    byKey.set(key, {
      contact,
      date: typeof followup.date === "string" ? followup.date : "",
      channel: typeof followup.channel === "string" ? followup.channel : "",
      count: 1,
    });
  }
  return [...byKey.values()];
}

/**
 * 拆分「常驻显示前 visible 个」与「其余收起进下拉」。
 * 用户在原型里选定 A+B：前三个直接点，剩下的不占版面。
 *
 * visible 非法（负数、NaN、非数字）时按 0 处理——全部进溢出，位置依旧确定。
 *
 * @template T
 * @param {Array<T>} list
 * @param {number} [visible]
 * @returns {{visible: Array<T>, overflow: Array<T>}}
 */
export function splitHistoryContacts(list, visible = 3) {
  const items = Array.isArray(list) ? list : [];
  const count = Number.isFinite(visible) && visible > 0 ? Math.floor(visible) : 0;
  return { visible: items.slice(0, count), overflow: items.slice(count) };
}

/**
 * 联系人候选行：历史跟进里的联系人（带日期/渠道）+ 报告建议联系人（带姓名），
 * 按输入内容做大小写不敏感的包含匹配。
 *
 * 换成自绘下拉的原因：原生 <datalist> 的弹出层由浏览器绘制，样式完全不受
 * 控制，跟弹窗里的其余控件不是一套；这里把「候选 + 过滤」收敛成数据，组件
 * 只负责画。
 *
 * 顺序即展示顺序：历史在前（最近用过的先出现），建议联系人在后；
 * 同一个地址只保留一条——历史里已经跟过的人不再重复出现。
 *
 * @param {{history?: Array<{contact: string, date: string, channel: string, count: number}>, suggested?: Array<{email: string, name: string | null}>, query?: string}} [input]
 * @returns {Array<{value: string, label: string, date: string, channel: string, source: "history" | "suggested"}>}
 */
export function contactOptions(input = {}) {
  const { history = [], suggested = [], query = "" } = input;
  /** @type {Array<{value: string, label: string, date: string, channel: string, source: "history" | "suggested"}>} */
  const rows = [];
  const seen = new Set();

  for (const h of Array.isArray(history) ? history : []) {
    const value = typeof h?.contact === "string" ? h.contact.trim() : "";
    if (!value) continue;
    seen.add(value.toLowerCase());
    rows.push({
      value,
      label: value,
      date: typeof h.date === "string" ? h.date : "",
      channel: typeof h.channel === "string" ? h.channel : "",
      source: "history",
    });
  }

  for (const s of Array.isArray(suggested) ? suggested : []) {
    const email = typeof s?.email === "string" ? s.email.trim() : "";
    if (!email) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const name = typeof s?.name === "string" ? s.name.trim() : "";
    rows.push({ value: email, label: name || email, date: "", channel: "", source: "suggested" });
  }

  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (row) => row.value.toLowerCase().includes(needle) || row.label.toLowerCase().includes(needle),
  );
}

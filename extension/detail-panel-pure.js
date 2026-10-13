// detail-panel-pure.js — 详情页职位浮窗视图态的纯逻辑层（ADR-0074）。
//
// 职位详情页过去由 core.js 往右侧扔四个各自独立的 position:fixed 元素（已评估徽章 /
// 快评徽章 / 评估本职位按钮 / 快评按钮），谁出现谁消失，位置靠互相测距堆叠。合并成
// 一个浮窗后，「四行读数各显示什么、缺值显示什么、分数什么颜色、按钮文案是什么、
// 收起药丸显示哪一个分」这些判断全部收在本文件，core.js 只剩 DOM 胶水。
//
// 之所以抽出来：占位符分支、药丸回退链、状态字典这些在真实招聘站页面上几乎没法稳定
// 复现，只有纯函数才测得起（同 badge-pure.js / report-target-pure.js 的口径）。
//
// content script 与 node 单测共用本文件：浏览器侧经 self.__careerOpsDetailPanelPure
// 取用（content script 与 service worker 都有 self），单测经 module.exports 守卫直接
// import。本文件严禁引用 chrome / window / document / location —— service worker 里
// 没有 window，且房规（ADR-0050）要求纯层可脱离浏览器测。

(function () {
  "use strict";

  // 分数分档阈值沿用 core.js 既有 scoreColor（≥4 绿 / ≥3 橙 / <3 红 / 非数值灰），
  // 保证浮窗与列表卡片徽章同一分数永远是同一个颜色。
  const SCORE_GREEN = "#00c68d";
  const SCORE_AMBER = "#f5a623";
  const SCORE_RED = "#d93026";
  const SCORE_NEUTRAL = "#8a8f98";
  // 快评是另一条通道（秒出、只读、不写 tracker），紫色与完整评估的绿橙红区分开。
  const QUICK_PURPLE = "#7c5cff";
  // 体检星用金色（与体检报告的推荐星级一致）；只在真的有体检结果时上色。
  const CHECKUP_GOLD = "#ffcb52";

  const PLACEHOLDER_STATUS = "未评估";
  const PLACEHOLDER_DASH = "—";

  // ---- 状态字典（接缝 C，ADR-0074）-------------------------------------
  //
  // 这是中文状态标签的第二份副本，有意的：web 侧真值在 TS i18n
  // （web/src/lib/i18n/clusters/pipeline.ts 的 pipeline.status.*），而 content script
  // 是纯 JS，import 不进去 TS 模块。契约只走原始码（语言不进接口），两边必须逐状态
  // 对齐；这笔双份债由单测钉住 —— 改中文名时只改一处会在测试里当场死。
  //
  // 键 = templates/states.yml 的 label（九个规范状态，大小写不敏感匹配）；
  // zh = web i18n 的同名标签（注意 skip 在两边都是「跳过」，不带「已」）；
  // color = 沿生命周期递进取色，跟分数分档共用一套 palette。
  // 本字典不列 states.yml 的 aliases（那是写入端的归一问题，set-status.mjs 已卡住），
  // 只兜「原始码认不出来」这一种情况：回退中性「已评估」并在 title 透出原值。
  const STATUS_DICT = {
    Evaluated: { zh: "已评估", color: "#6ea8fe" },
    Applied: { zh: "已申请", color: "#4aa3ff" },
    Responded: { zh: "已回复", color: "#00b8d9" },
    Interview: { zh: "面试中", color: "#f5a623" },
    Offer: { zh: "录用通知", color: "#14b8a6" },
    Hired: { zh: "已入职", color: "#00c68d" },
    Rejected: { zh: "已拒绝", color: "#d93026" },
    Discarded: { zh: "已放弃", color: "#6b7280" },
    SKIP: { zh: "跳过", color: "#8a8f98" },
  };

  /**
   * 原始状态码 → 中文标签 + 取色。大小写不敏感（states.yml 本身就这么要求）。
   * @param {string|null|undefined} raw
   * @returns {{text:string, color:string, known:boolean, title:string}}
   */
  function statusLabel(raw) {
    const v = typeof raw === "string" ? raw.trim() : "";
    if (!v) return { text: PLACEHOLDER_STATUS, color: SCORE_NEUTRAL, known: false, title: "" };
    const key = Object.keys(STATUS_DICT).find((k) => k.toLowerCase() === v.toLowerCase());
    if (key) return { text: STATUS_DICT[key].zh, color: STATUS_DICT[key].color, known: true, title: `状态：${v}` };
    // 认不出来的码不能拿它当颜色信号 —— 涂中性灰、文案退到「已评估」（能进 tracker
    // 至少说明评估过），原值只进 title，用户悬停看得到到底是什么鬼。
    return {
      text: STATUS_DICT.Evaluated.zh,
      color: SCORE_NEUTRAL,
      known: false,
      title: `未识别的状态值：${v}`,
    };
  }

  /**
   * 分数 → 分档色。输入沿用 tracker/report-status 的 `"4.3/5"` 字符串口径。
   * @param {string|null|undefined} scoreStr
   * @returns {{color:string, numeric:(number|null)}}
   */
  function scoreBand(scoreStr) {
    const n = parseFloat(scoreStr);
    if (!Number.isFinite(n)) return { color: SCORE_NEUTRAL, numeric: null };
    if (n >= 4) return { color: SCORE_GREEN, numeric: n };
    if (n >= 3) return { color: SCORE_AMBER, numeric: n };
    return { color: SCORE_RED, numeric: n };
  }

  /** 有值判定：非空字符串才算有值（`""` 与 `null` 同走占位符）。 */
  function has(v) {
    return typeof v === "string" ? v.trim() !== "" : v != null;
  }

  /**
   * 浮窗视图态（四行读数：已评估 / 快评 / 状态 / 体检）。行结构恒定，缺值走
   * 占位符 —— 页面懒加载、换职位、评估完成都只改内容，不改布局。
   *
   * @param {object}  [p]
   * @param {object}  [p.entry]        evaluated[normalizeUrl] —— {score, reportNum, status, checkupStar}
   * @param {object}  [p.quick]        quickMap[normalizeUrl] —— {score, grade, reason}
   * @returns {{evalRow:object, quickRow:object, statusRow:object, checkupRow:object,
   *            evalBtnLabel:string, pill:object}}
   */
  function panelView(p = {}) {
    const entry = p.entry || null;
    const quick = p.quick || null;

    // 已评估行：分数 + 报告号。报告号缺失（tracker 行没链到报告）时行仍显示分数，
    // 只是行尾的 ↗ 没有去处 → openable=false。
    const evalScore = entry && has(entry.score) ? String(entry.score).trim() : "";
    const evalColor = scoreBand(evalScore).color;
    const reportNum = entry && has(entry.reportNum) ? String(entry.reportNum).trim() : null;

    // 快评行：判「有没有值」沿用既有快评徽章的 `q.score == null` 口径（0 也是一个
    // 得分，不能靠 falsy 当成缺值）—— 口径不一致时，同一个职位的快评徽章与浮窗
    // 会对同一个分数给出两种说法。
    const quickScore = quick && quick.score != null && Number.isFinite(Number(quick.score)) ? Number(quick.score) : null;

    const evalBtnLabel = entry ? "重新评估" : "评估本职位";

    // 收起态药丸：已评估分数优先，缺失退快评分，两者都无 → 占位符。
    const pillScoreText = evalScore || (quickScore != null ? `${quickScore}/5` : PLACEHOLDER_DASH);

    // 状态行：契约只给原始码，中文与色由本文件的字典出。
    const statusRaw = entry && has(entry.status) ? String(entry.status).trim() : "";
    // tracker 行在、但契约没带状态（老行或状态列为空）→ 退到「已评估」：有行 =
    // 至少评估过。连 tracker 行都没有才是占位符「未评估」。
    const st = entry && !statusRaw
      ? { text: STATUS_DICT.Evaluated.zh, color: SCORE_NEUTRAL, known: false, title: "tracker 行没有状态值" }
      : statusLabel(statusRaw);
    const statusRow = {
      label: "状态",
      text: st.text,
      color: st.color,
      dot: !!statusRaw, // 有真实状态才画色点（与收起态药丸同一个信号）
      raw: statusRaw || null,
      title: st.title,
      openable: false,
    };

    // 体检行：契约只给一个星数（1.0–5.0，或 null = 未体检）。判「有值」的口径与
    // report-status-map 一致：非得是个大于 0 的有限数 —— 0 / NaN / 字符串都不是
    // 「体检过」，不能拿它们涂金。
    const rawStar = entry ? Number(entry.checkupStar) : NaN;
    const star = Number.isFinite(rawStar) && rawStar > 0 ? rawStar : null;
    const checkupRow = {
      label: "体检",
      text: star != null ? `推荐 ${star.toFixed(1)}/5` : PLACEHOLDER_DASH,
      color: star != null ? CHECKUP_GOLD : SCORE_NEUTRAL,
      // 报告号缺失时不给 ↗：那个行尾入口的唯一去处是体检报告本身，点开一个 fetch
      // 不到东西的弹窗比不给入口更坑。
      openable: star != null && !!reportNum,
      title: star != null && reportNum ? `打开最近一次公司体检报告（#${reportNum}）` : "",
    };

    return {
      evalRow: {
        label: "已评估",
        text: evalScore || PLACEHOLDER_STATUS,
        color: evalScore ? evalColor : SCORE_NEUTRAL,
        reportNum,
        openable: !!reportNum,
      },
      quickRow: {
        label: "快评",
        text: quickScore != null ? `${quickScore}/5` : PLACEHOLDER_DASH,
        // 色轨只在有值时上色：缺值还涂紫，等于用颜色宣称「这里有个快评结果」。
        color: quickScore != null ? QUICK_PURPLE : SCORE_NEUTRAL,
        title: quick && quick.reason ? `快评：${quick.grade || ""} — ${quick.reason}`.trim() : "",
        openable: false,
      },
      // 状态行：契约原始码 + 本文件中文字典（接缝 C）。
      statusRow,
      // 体检行：契约 checkupStar，有值才涂金（接缝 B 的前端侧）。
      checkupRow,
      evalBtnLabel,
      pill: {
        // 药丸的三个槽位恒定（状态色点 / 状态文字 / 总分），缺值走占位符 —— 收起态
        // 也不因为哪一行有值而改变宽度节奏。色点跟状态走（不跟分数走），分数自己
        // 另带一个 scoreColor，两个信号不互相伪报。
        dotColor: statusRow.color,
        statusText: statusRow.text,
        scoreText: pillScoreText,
        scoreColor: evalScore ? evalColor : quickScore != null ? QUICK_PURPLE : SCORE_NEUTRAL,
      },
    };
  }

  // ---- 评估报告的 markdown 子集渲染（接缝 E，ADR-0074）---------------------
  //
  // 只实现报告真正用到的那部分排版：标题、段落、表格、列表、引用、围栏代码、分隔
  // 线与 `**粗**` / `` `码` `` / `[文本](链接)`。不是通用 markdown 引擎，也不打算长成
  // 那样 —— 报告的版式由我们自己的生成流程控制，这里只要把它读出来就行。
  //
  // 安全口径只有一条：**先整体转义，再上标记**。每段文本都先过 escapeHtml，标记只加
  // 在已转义的字符串上，所以正文里的 `<script>`、表格单元里的 `<img onerror>` 都只是
  // 文字；href 属性同机制 —— URL 里的引号转义后不再满足链接正则，直接不当链接认。
  // 输出的 class 带 cr- 前缀，对应 core.js 里锁在阅读弹窗底下的那份样式。

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** 行内标记（输入是原始 markdown 文本，输出已转义 + 已上标记）。 */
  function inlineMd(s) {
    let t = escapeHtml(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  }

  /** 表格行 → 单元格数组（去掉首尾竖线）。 */
  function splitCells(row) {
    return row.replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  }

  /** 标题里给目录用的纯文本：把行内标记括平（胶水直接写 textContent，不再转第二遍）。 */
  function headingPlain(s) {
    return String(s)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .trim();
  }

  /** 报告头部连续的 `**键:** 值` 行 → 元信息网格（而不是当作普通段落堆在一起）。 */
  function kvGroup(lines) {
    const items = [];
    for (const ln of lines) {
      const re = /\*\*([^*]+):\*\*\s*([\s\S]*?)(?=\s*\*\*[^*]+:\*\*|$)/g;
      let m;
      while ((m = re.exec(ln))) {
        const k = m[1].trim();
        const v = m[2].trim();
        if (!v) continue;
        const shown = /^https?:\/\//.test(v)
          ? `<a href="${escapeHtml(v)}" target="_blank" rel="noopener">${escapeHtml(v.replace(/^https?:\/\//, "").slice(0, 52))}</a>`
          : inlineMd(v);
        items.push(`<div class="cr-kv"><b>${escapeHtml(k)}:</b><span>${shown}</span></div>`);
      }
    }
    return `<div class="cr-kvs">${items.join("")}</div>`;
  }

  /**
   * 评估报告 markdown → 阅读正文 HTML + 目录。
   *
   * @param {string} src 报告原文（从 /api/report-source 经 background 取回）
   * @returns {{html:string, toc:Array<{id:string, level:number, text:string}>}}
   *   toc 只收 h2/h3（报告的一级标题只有一个：报告头本身），id 与正文里的
   *   `sec-N` 一一对应，level 给目录缩进用。
   */
  function mdToHtml(src) {
    if (typeof src !== "string") return { html: "", toc: [] };
    const lines = src.split(/\r?\n/);
    const out = [];
    const toc = [];
    let i = 0;

    const heading = (hashes, text) => {
      const level = hashes.length;
      const body = inlineMd(text);
      if (level !== 2 && level !== 3) {
        out.push(`<h${level}>${body}</h${level}>`);
        return;
      }
      const id = `sec-${toc.length}`;
      toc.push({ id, level, text: headingPlain(text) });
      out.push(`<h${level} id="${id}">${body}</h${level}>`);
    };

    while (i < lines.length) {
      const ln = lines[i];
      if (/^\s*$/.test(ln)) { i++; continue; }
      let m;
      // 围栏代码块：yaml/json 默认展开（用户定稿：不让机器可读摘要默认藏起来）
      if (/^```/.test(ln)) {
        const lang = ln.slice(3).trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++; // 吃掉闭合围栏（报告残缺时这一下越界，循环条件兼住）
        const code = `<pre><code>${escapeHtml(buf.join("\n"))}</code></pre>`;
        out.push(/^(yaml|yml|json)$/i.test(lang)
          ? `<details open><summary>机器可读摘要（${escapeHtml(lang)}）</summary>${code}</details>`
          : code);
        continue;
      }
      if (/^(---|\*\*\*|___)\s*$/.test(ln)) { out.push("<hr>"); i++; continue; }
      if ((m = /^(#{1,4})\s+(.*)$/.exec(ln))) { heading(m[1], m[2]); i++; continue; }
      // 表格：表头行 + `|---|` 分隔行，两者缺一行就当普通段落读
      if (/^\|/.test(ln) && /^\|[\s:|-]+\|?\s*$/.test(lines[i + 1] || "")) {
        const head = splitCells(ln);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) { rows.push(splitCells(lines[i])); i++; }
        out.push(
          "<table><thead><tr>" + head.map((c) => `<th>${inlineMd(c)}</th>`).join("") + "</tr></thead><tbody>" +
            rows.map((r) => "<tr>" + r.map((c) => `<td>${inlineMd(c)}</td>`).join("") + "</tr>").join("") +
            "</tbody></table>"
        );
        continue;
      }
      if (/^\*\*[^*]+:\*\*/.test(ln)) {
        const grp = [];
        while (i < lines.length && /^\*\*[^*]+:\*\*/.test(lines[i])) { grp.push(lines[i]); i++; }
        out.push(kvGroup(grp));
        continue;
      }
      if (/^>\s?/.test(ln)) {
        const bq = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { bq.push(lines[i].replace(/^>\s?/, "")); i++; }
        out.push(`<blockquote>${inlineMd(bq.join(" "))}</blockquote>`);
        continue;
      }
      if ((m = /^([-*]|\d+\.)\s+(.*)$/.exec(ln))) {
        const ord = /^\d/.test(m[1]);
        const items = [];
        while (i < lines.length && (m = /^([-*]|\d+\.)\s+(.*)$/.exec(lines[i]))) { items.push(m[2]); i++; }
        const tag = ord ? "ol" : "ul";
        out.push(`<${tag}>${items.map((x) => `<li>${inlineMd(x)}</li>`).join("")}</${tag}>`);
        continue;
      }
      const para = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^(```|#{1,4}\s|\||>|[-*]\s|\d+\.\s)/.test(lines[i]) &&
        !/^\*\*[^*]+:\*\*/.test(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      // 兜住「任何分支都必须前进」这条不变量：`|` 开头的行被段落循环排除在外，而它又没凑成
      // 表格（缺分隔行，或分隔行里混了中文）时，上面一轮都不执行 → i 不前进 → 死循环，
      // 整个招聘站标签页会卡在这里（真实报告里确实存在这种畸形行）。按上面注释说的
      // 「当普通段落读」补上这一行。
      if (para.length === 0) {
        para.push(lines[i]);
        i++;
      }
      out.push(`<p>${para.map(inlineMd).join("<br>")}</p>`);
    }
    return { html: out.join("\n"), toc };
  }

  const api = {
    SCORE_GREEN,
    SCORE_AMBER,
    SCORE_RED,
    SCORE_NEUTRAL,
    QUICK_PURPLE,
    CHECKUP_GOLD,
    PLACEHOLDER_STATUS,
    PLACEHOLDER_DASH,
    STATUS_DICT,
    statusLabel,
    scoreBand,
    panelView,
    mdToHtml,
  };

  // content script（页面全局）：挂 window / self。
  if (typeof self !== "undefined" && self && !self.__careerOpsDetailPanelPure) {
    self.__careerOpsDetailPanelPure = api;
  }
  // node 单测：module.exports 守卫（同 badge-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

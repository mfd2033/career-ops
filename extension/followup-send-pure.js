// followup-send-pure.js — 「自动跟进」发送链路的纯逻辑层（三站共用）。
//
// 只做判断、不碰 DOM：站点表、文本规整、输入框/发送按钮候选打分、发送结果核对、
// 联系人候选挑选。DOM 采集在 followup-send.js；SW 路由在 background.js。
//
// 三站没有公开的聊天 DOM 契约，选择器一改版就失效。所以这里刻意不写死选择器，
// 改成「按特征打分 + 阈值」：输入框看标签/尺寸/离屏底距离/关键词，发送按钮看
// 文案与类名，且**明确排除「发送简历 / 投递 / 申请」这类表单按钮**——自动跟进
// 只允许发聊天消息，不许碰到投递动作。
//
// 加载方式沿用仓库口径：内容脚本挂 window.__careerFollowupSendPure；node 单测走
// module.exports。本文件严禁引用 window/document/chrome/location。

(function () {
  "use strict";

  // 三站表：host 用后缀匹配（www / m / c 等子域太多），label 进备注与失败原因。
  const SITES = [
    { id: "boss", label: "BOSS直聘", host: "zhipin.com" },
    { id: "liepin", label: "猎聘", host: "liepin.com" },
    { id: "zhaopin", label: "智联招聘", host: "zhaopin.com" },
  ];

  // 输入框特征词：命中越多越像聊天输入框。
  const INPUT_KEYWORDS = [
    "聊天",
    "输入",
    "消息",
    "回复",
    "说点",
    "打招呼",
    "沟通",
    "chat",
    "message",
    "msg",
    "input",
    "reply",
    "editor",
  ];
  // 反特征：搜索/筛选框。命中一次扣 3 分，避免把页面搜索框当聊天框。
  const INPUT_ANTI = ["搜索", "search", "filter", "筛选"];

  // 发送按钮文案：整词匹配优先（4 分），含关键词次之。
  const SEND_TEXT_RE = /^(发送|发送消息|发送信息|发消息|send)$/i;
  const SEND_KEYWORDS = ["send", "发送", "submit"];
  // 危险文案：投递/申请类按钮一律不点。代发跟进消息绝不等于代投简历。
  const SEND_ANTI_TEXT = /简历|投递|申请|报名|apply|resume|submit/i;

  const CONTACT_KEYWORDS = ["name", "nick", "hr", "boss", "recruit", "姓名", "招聘", "昵称"];
  // 联系人反特征：页面导航、会话列表预览、状态词。
  const CONTACT_ANTI = /搜索|消息|我的|简历|职位|公司|在线|离线|已读|未读|设置|更多|聊天|发送/;

  // ---- 会话作用域（读联系人 / 找发送按钮的落脚点）---------------------------
  //
  // 三站的输入框都裹在「组合器」外壳里，而外壳类名往往带着 chat / im 前缀。
  // 智联实测：`TEXTAREA.im-sender__input` 的父节点是
  // `DIV.im-sender__input-wrapper` —— 它自己就命中 `[class*="im-"]`，于是
  // `closest()` 就地停下，作用域缩进输入区，会话头部（`im-chat-header__name`）
  // 和消息流全在作用域外，联系人恒为空、回读恒收不到消息。
  //
  // 判据两条：类名要带会话语义词（chat / conversation / dialog / im- / panel），
  // 且不能是组合器外壳（input / textarea / editor / sender / composer / toolbar /
  // footer / btn）。外壳那几个词是硬否决——`chat-editor`、`chat-input` 也带 chat，
  // 但它们恰恰就是输入区本身。
  const SCOPE_HINT = /(chat|conversation|dialog|im-|panel)/i;
  const SCOPE_ANTI = /(input|textarea|editor|sender|composer|toolbar|footer|btn)/i;

  const INPUT_MIN_SCORE = 5;
  const SEND_MIN_SCORE = 3;

  /** URL → 三站之一；非三站返回 null（调用方回落复制+打开）。 */
  function siteForUrl(url) {
    if (typeof url !== "string" || !url) return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname.toLowerCase();
    for (const site of SITES) {
      if (host === site.host || host.endsWith(`.${site.host}`)) return site;
    }
    return null;
  }

  /**
   * 聊天框里回车=发送，所以多行话术必须压成一行。
   * 顺带把行内连续空白压成一个空格、丢掉空行——粘进对话框的文本与确认过的
   * 文本只差空白，不差字。
   */
  function joinMessage(text) {
    return String(text == null ? "" : text)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/[ \t\u3000]+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
  }

  /** 未替换的 `{占位符}`（去重、保序），UI 据此提示「还有几处要你自己补」。 */
  function placeholderTokens(text) {
    const out = [];
    const re = /\{[^{}]+\}/g;
    let m;
    while ((m = re.exec(String(text == null ? "" : text))) !== null) {
      if (!out.includes(m[0])) out.push(m[0]);
    }
    return out;
  }

  /**
   * 回读校验用的尾部指纹：去空白后的末 n 个字。太短（<4）无法区分，返回空串。
   * n 不能太小：三站的会话列表预览里常有同一个话术模板，末 12 字会撞上别的会话，
   * 把「没发出去」判成「已回显」。
   */
  function fingerprint(text, n = 24) {
    const s = joinMessage(text).replace(/\s+/g, "");
    if (s.length < 4) return "";
    return s.slice(Math.max(0, s.length - n));
  }

  /** 输入框候选打分；-1 = 不可用（隐藏、只读、尺寸不像聊天框）。 */
  function scoreInputCandidate(c) {
    if (!c || typeof c !== "object") return -1;
    if (c.visible === false) return -1;
    if (c.disabled || c.readOnly) return -1;
    const tag = String(c.tag || "").toLowerCase();
    const multilineInput = tag === "textarea";
    const singleLineInput = tag === "input" && (!c.type || c.type === "text");
    if (!c.contentEditable && !multilineInput && !singleLineInput) return -1;
    if (!(c.height >= 20) || !(c.width >= 60)) return -1;

    let score = 0;
    if (multilineInput) score += 3;
    else if (c.contentEditable) score += 2;

    // bottomGap = 视口底部到输入框顶部的距离：聊天框几乎总贴着屏底，
    // 而会话列表的搜索框在页面顶部。BOSS 的聊天页顶部就有一个搜索框，
    // 扣分不够时它会被选成「聊天框」，跟进话术就被打进了搜索里（实测踩到）。
    if (typeof c.bottomGap === "number") {
      if (c.bottomGap <= 260) score += 3;
      else if (c.bottomGap <= 480) score += 1;
      else if (c.bottomGap <= 720) score -= 1;
      else score -= 6; // 高于半屏：就是顶部搜索/筛选框，直接判死
    }

    const hay = `${c.placeholder || ""} ${c.classText || ""} ${c.idText || ""} ${c.ariaLabel || ""}`.toLowerCase();
    const hits = INPUT_KEYWORDS.filter((k) => hay.includes(k)).length;
    score += Math.min(hits, 3);
    score -= INPUT_ANTI.filter((k) => hay.includes(k)).length * 3;
    // 单行输入框且毫无聊天特征：多半是搜索框。
    if (hits === 0 && singleLineInput) score -= 2;
    return score;
  }

  /** 发送按钮候选打分；-1 = 不可用（隐藏、禁用、投递类文案）。 */
  function scoreSendCandidate(c) {
    if (!c || typeof c !== "object") return -1;
    if (c.visible === false || c.disabled) return -1;
    if (!(c.width >= 20) || !(c.height >= 16)) return -1;
    const text = String(c.text || "").replace(/\s+/g, "");
    if (text && SEND_ANTI_TEXT.test(text)) return -1;

    let score = 0;
    if (text && SEND_TEXT_RE.test(text)) score += 4;
    else if (text && text.length <= 6 && /发送|send/i.test(text)) score += 3;

    const hay = `${c.classText || ""} ${c.idText || ""} ${c.ariaLabel || ""} ${c.title || ""}`.toLowerCase();
    if (SEND_KEYWORDS.some((k) => hay.includes(k))) score += 2;
    if (String(c.tag || "").toLowerCase() === "button") score += 1;
    return score;
  }

  /** 通用择优：返回 {index, score} 或 null（全部低于阈值）。 */
  function pickBest(list, scorer, minScore) {
    let best = null;
    (Array.isArray(list) ? list : []).forEach((c, index) => {
      const score = scorer(c);
      if (score < minScore) return;
      if (!best || score > best.score) best = { index, score };
    });
    return best;
  }

  function pickInputCandidate(list) {
    return pickBest(list, scoreInputCandidate, INPUT_MIN_SCORE);
  }

  function pickSendCandidate(list) {
    return pickBest(list, scoreSendCandidate, SEND_MIN_SCORE);
  }

  /**
   * 联系人候选：取聊天头部那个名字。特征词加分，越靠上越好；反特征与长度
   * 不合（2–24 字）的直接跳过。
   */
  function pickContactCandidate(list) {
    let best = null;
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || c.visible === false) continue;
      const text = String(c.text || "").replace(/\s+/g, " ").trim();
      if (text.length < 2 || text.length > 24) continue;
      if (CONTACT_ANTI.test(text)) continue;
      const hay = String(c.classText || "").toLowerCase();
      let score = CONTACT_KEYWORDS.some((k) => hay.includes(k)) ? 3 : 0;
      if (typeof c.top === "number") score -= Math.min(Math.max(c.top, 0), 800) / 400;
      if (!best || score > best.score) best = { text, score };
    }
    return best ? best.text : null;
  }

  /**
   * 从输入框往上的祖先链里挑会话作用域，返回下标（由近到远，第一个合格的），
   * 全不合格返回 -1（调用方回落输入框父节点）。
   *
   * @param {Array<{tag?: string, classText?: string}>} ancestors 由近到远的祖先描述
   */
  function pickChatScope(ancestors) {
    const list = Array.isArray(ancestors) ? ancestors : [];
    for (let i = 0; i < list.length; i += 1) {
      const cls = String((list[i] && list[i].classText) || "");
      if (!SCOPE_HINT.test(cls)) continue;
      if (SCOPE_ANTI.test(cls)) continue;
      return i;
    }
    return -1;
  }

  /**
   * 发送结果核对（原型里定的两条都成立才报「已发送」）：
   *   1. 输入框已清空；2. 聊天流里出现刚发的那句（尾部指纹命中）。
   * 任一不成立 → ok:false，调用方报「不确定」。
   */
  function verifySend({ after, messages, expectText }) {
    const fp = fingerprint(expectText);
    const cleared = String(after == null ? "" : after).trim() === "";
    const list = Array.isArray(messages) ? messages : [];
    const echoed = fp ? list.some((m) => String(m == null ? "" : m).replace(/\s+/g, "").includes(fp)) : false;
    return { ok: cleared && echoed, cleared, echoed };
  }

  const api = {
    SITES,
    INPUT_MIN_SCORE,
    SEND_MIN_SCORE,
    siteForUrl,
    joinMessage,
    placeholderTokens,
    fingerprint,
    scoreInputCandidate,
    scoreSendCandidate,
    pickInputCandidate,
    pickSendCandidate,
    pickContactCandidate,
    pickChatScope,
    verifySend,
  };

  if (typeof window !== "undefined" && window && !window.__careerFollowupSendPure) {
    window.__careerFollowupSendPure = api;
  }
  // node 单测：module.exports 守卫（同 scan-pure.js / card-status-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

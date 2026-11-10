// BOSS直聘 site 适配 — 选择器 / JD 提取 / 列表右栏面板按钮。
//
// 站点无关逻辑（徽章、详情页按钮、消息、observer、diag）在 core.js；
// 本文件只含 BOSS 专属事实，末尾把适配对象交给 core 启动。
// 原 content.js 中的 CARD_SELECTOR/LINK_SELECTOR、extractDetailJd、
// extractPosterName、extractListPaneJd、ensureRightPaneButton 逻辑整体迁移至此。

(function () {
  "use strict";

  const C = window.__careerExtCore;

  // BOSS /web/geek/jobs list card container. The job-name anchor sits in
  // DIV.job-title > DIV.job-info > LI.job-card-box (older .job-card-wrapper is
  // gone after BOSS' list revamp). One LI per posting.
  //
  // 个人中心「感兴趣」列表（/web/geek/recommend，tab 切到「感兴趣」）是另一套骨架：
  // UL.user-jobs-ul > LI.item-boss，卡片同样带 /job_detail/ 锚点（实证 2026-11-10）。
  // 两种容器并列进选择器 —— 互斥（各自页面只出现一种），任一命中即可。
  const CARD_SELECTOR = "li.job-card-box, li.item-boss";
  const LINK_SELECTOR = 'a[href*="/job_detail/"]';

  function isDetailPath(pathname) {
    return pathname.includes("/job_detail/");
  }

  function cardIsList(card) {
    return !isDetailPath(location.pathname) && !!card.querySelector(LINK_SELECTOR);
  }

  /** Absolute posting URL for a list card (from its detail anchor). */
  function cardUrl(card) {
    const a = card.querySelector(LINK_SELECTOR);
    if (!a) return null;
    const href = a.href || a.getAttribute("href");
    return href && /^https?:\/\//i.test(href) ? href : null;
  }

  /**
   * 列表卡片的全量元字段（URL 复用 cardUrl）。BOSS v 改版多，选择器取宽、尽力而为：
   * 抓不到即空串，绝不因某字段缺失抛错。city 不在此定点（BOSS 卡片无稳定城市 class，
   * 城市过滤交由 web 侧 matchesBrowserCity 以 title 兜底，ADR-0007 E4）。
   */
  /** 卡片文本级薪资兜底提取（纯函数）。BOSS 薪资数字多为 PUA 字形混淆（清洗后无
   *  ASCII 数字 → 归「薪资未知」）；未混淆卡片经此兜底在 class 选择器落空时仍可
   *  带出薪资。规则与 bsk-extract.mjs 的 extractSalaryFromText / site-liepin 的
   *  extractSalaryFromCardText 同款，三处同改。 */
  function extractSalaryFromCardText(text) {
    const t = String(text ?? "");
    if (!t) return "";
    const m = t.match(
      /\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*(?:千|[kK]|万)(?:\s*·\s*\d+\s*薪)?|\d+(?:\.\d+)?\s*(?:千|[kK]|万)(?:\s*·\s*\d+\s*薪)?/,
    );
    return m ? m[0].trim() : "";
  }

  function cardMeta(card) {
    const text = (sel) => {
      const el = card.querySelector(sel);
      return el ? (el.innerText || el.textContent || "").trim() : "";
    };
    const salary = text('[class*="salary"],[class*="job-price"],[class*="price"],.job-area') || extractSalaryFromCardText(card.innerText || "");
    const company = text('[class*="company-name"],[class*="company"] .name,.company-info .name,.company-info .text b,.company-info b,[class*="brand"]');
    return {
      url: cardUrl(card),
      // .job-name-text 是个人中心列表卡片的标题节点：那里锚点的 innerText 还裹着
      // 「[城市·区域]」，直接取会把城市拼进标题。先取标题节点，落空再回退锚点。
      title: text(".job-name-text") || text(LINK_SELECTOR),
      company,
      salary,
      city: undefined, // BOSS 无卡片城市 class —— 城市过滤走 web 侧 title 匹配
    };
  }

  function currentActiveUrl() {
    const ac = document.querySelector(`${CARD_SELECTOR}.active`) || document.querySelector(".job-card-wrap.active");
    const a = ac && ac.querySelector(LINK_SELECTOR);
    return a && a.href ? a.href : null;
  }

  /**
   * 从详情页 DOM 提取 JD 文本（标题+薪资+描述正文），供快评直连 LLM，免服务端
   * 二次抓取。描述区选择器尽量宽松：优先含「职位描述/职位直聘描述/岗位职责」标题
   * 的文本容器，其次常见 .job-sec-text/.job-detail-txt/.text；都找不到则回退标题+
   * body 紧凑文本。返回 {title,text}，text 为空表示提取失败（按钮置灰）。
   */
  function extractDetailJd() {
    const titleEl = document.querySelector("h1") || document.querySelector('[class*="job-name"],[class*="job_title"],[class*="name"]');
    const title = titleEl ? titleEl.innerText.trim() : "";
    const priceEl = document.querySelector('[class*="job-price"],[class*="salary"],[class*="job-area"]');
    const price = priceEl ? priceEl.innerText.trim() : "";
    // 优先找描述区：遍历元素，取第一个「文本短前缀命中职位描述类词 且 内容足够长」的容器。
    let desc = "";
    const descHit = document.querySelector('.job-sec-text, .job-detail-txt, [class*="job-sec"] .text, [class*="job-detail-text"], .text, .desc');
    if (descHit) {
      const t = descHit.innerText.trim();
      if (t.length > 80) desc = t;
    }
    if (!desc) {
      const anchors = ["职位描述", "职位直聘描述", "岗位职责", "职位详情", "职责"];
      for (const el of document.querySelectorAll("div,section,dl,dd")) {
        const txt = (el.innerText || "").trim();
        if (!txt || txt.length < 120) continue;
        const head = txt.replace(/\s+/g, "").slice(0, 12);
        if (anchors.some((a) => head.includes(a)) || head.startsWith("职位")) {
          desc = txt;
          break;
        }
      }
    }
    // 组合：标题 + 薪资 + 描述正文。
    const parts = [title];
    if (price) parts.push(price);
    if (desc) parts.push(desc);
    const text = parts.join("\n").trim().slice(0, 12000);
    return { title, text };
  }

  /**
   * 尽力提取发帖公司名（详情页职位下方的公司块）。代招页发帖方恒在但 DOM 结构随
   * BOSS 改版变动，故选择器取宽、取不到返回空串（快评跟随策略时退回不前缀）。
   *
   * 策略：先限在职位详情主区域（.job-detail / .job-detail-banner）内找，避免页面
   * 上推荐职位/看了又看等干扰区域的公司名被首选匹配；找不到再回退全局搜索。
   */
  function extractPosterName() {
    // 职位详情主区域容器（class 随 BOSS 改版可能变化，取宽匹配）。
    const detailArea = document.querySelector(
      '.job-detail, .job-detail-banner, [class*="job-detail"], [class*="job-banner"]'
    );
    if (detailArea) {
      const el = detailArea.querySelector(
        '[class*="company-name"], [class*="company"] .name, .name-box .name, .job-co-name'
      );
      if (el) {
        const t = (el.innerText || el.textContent || "").trim();
        if (t) return t.slice(0, 40);
      }
    }
    // 回退：全局找第一个匹配（最后手段）。
    const sel = [
      '[class*="company-name"]',
      '[class*="poster-name"]',
      '.job-co-name',
      '.name-box .name',
      '.company-info .name',
      '[class*="company_info"] .name',
      '[class*="job"] [class*="company"] .name a',
    ].join(",");
    const el = document.querySelector(sel);
    if (!el) return "";
    const t = (el.innerText || el.textContent || "").trim();
    return t.slice(0, 40);
  }

  /**
   * 从列表页右栏(被选中职位的描述面板)提取 JD 文本，供「快评」用。回退到 active
   * 卡片的标题。返回 {title,text}；text 为空表示提取失败。
   */
  function extractListPaneJd() {
    const pane = document.querySelector('.job-detail-body, [class*="job-detail-body"], .job-detail-info, [class*="job-sec"]');
    let text = pane ? pane.innerText.trim() : "";
    const ac = document.querySelector(`${CARD_SELECTOR}.active`) || document.querySelector(".job-card-wrap.active");
    const titleEl = ac && (ac.querySelector('[class*="job-name"], [class*="name"]'));
    const title = titleEl ? titleEl.innerText.trim() : "";
    // 若描述区太短(没抓到正文)，拼上标题凑足可打分文本。
    if (!text || text.length < 120) text = [title, text].filter(Boolean).join("\n");
    return { title, text: text.trim().slice(0, 12000) };
  }

  // List page "评估本职位" button — pinned to the right-hand detail pane (BOSS
  // /web/geek/jobs renders the selected job's description beside the list in a
  // .job-detail-body panel). Clicking it evaluates the currently-selected card
  // (the .active one), reusing the same engine as the detail-page button.
  const LIST_EVAL_BTN_ID = "career-ext-list-eval-btn";
  const LIST_QUICK_BTN_ID = "career-ext-list-quick-btn";

  const BUTTON_CSS =
    "padding:6px 12px;border:none;border-radius:6px;cursor:pointer;vertical-align:middle;" +
    "background:#00c68d;color:#fff;font-size:13px;font-weight:600;margin-left:8px;" +
    "font-family:system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.2);";
  const QUICK_BUTTON_CSS =
    "padding:6px 12px;border:none;border-radius:6px;cursor:pointer;vertical-align:middle;" +
    "background:#7c5cff;color:#fff;font-size:13px;font-weight:600;margin-left:8px;" +
    "font-family:system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.2);";

  function ensureRightPaneButton() {
    if (isDetailPath(location.pathname)) {
      // Detail page — the dedicated full-page button owns this; don't add the pane one.
      const stale = document.getElementById(LIST_EVAL_BTN_ID);
      if (stale) stale.remove();
      return;
    }
    // 个人中心列表没有右栏，但有每卡操作区：站点重渲染可能把它摘掉，顺路补一遍。
    if (document.querySelector(".user-jobs-area")) C.sweepCards();
    const opBar = document.querySelector(".job-detail-op");
    if (!opBar) return; // pane not rendered yet — observer will retry
    if (document.getElementById(LIST_EVAL_BTN_ID)) return;
    const btn = C.makeButton({ id: LIST_EVAL_BTN_ID, text: "评估本职位", css: BUTTON_CSS });
    btn.addEventListener("click", () => {
      const el = document.getElementById(LIST_EVAL_BTN_ID);
      const url = currentActiveUrl();
      if (!url) {
        C.toast("未选中职位，请先在左侧点击一个职位", true);
        return;
      }
      el.disabled = true;
      el.textContent = "评估中...";
      // 内联右栏面板 JD 全文 + 发帖公司名:BOSS 的 WebFetch 被风控拦截返回空,
      // 不带文本会让 agent 落到 browser-extract 卡死;与详情页同口径,免二次抓取。
      const { title, text } = extractListPaneJd();
      const extra = {};
      if (text) {
        extra.jdText = [title, text].filter(Boolean).join("\n").trim().slice(0, 12000);
        extra.company = extractPosterName();
      }
      // 登记 core 的收尾轮询:评估完成后无论消息路径是否失效(BOSS 评估通常
      // 跑 20-40s,background SW 可能被 Chrome 空闲终止),按钮都能恢复可点。
      C.beginEval(url);
      C.sendSingleEvaluate(url, (err) => {
        el.disabled = false;
        el.textContent = "评估本职位";
        C.endEval();
        C.toast(err, true);
      }, extra);
    });
    // Sit immediately left of the "微信扫码分享" share button inside the op bar;
    // fall back to the bar's first child if the share anchor isn't found.
    const share = Array.from(opBar.querySelectorAll("a,button,span")).find((el) =>
      /微信|分享/.test(el.textContent || ""),
    );
    opBar.insertBefore(btn, share || opBar.firstChild);

    // 快评 — 列表右栏秒出分数徽章，独立于「评估本职位」(完整报告)。
    const qbtn = C.makeButton({ id: LIST_QUICK_BTN_ID, text: "快评", css: QUICK_BUTTON_CSS });
    qbtn.addEventListener("click", () => {
      if (C.isQuickEvaluating() || qbtn.disabled) return;
      const url = currentActiveUrl();
      if (!url) {
        C.toast("未选中职位，请先在左侧点击一个职位", true);
        return;
      }
      const { title, text } = extractListPaneJd();
      if (!text) {
        C.toast("快评：未能提取职位描述文本", true);
        return;
      }
      C.setQuickEvaluating(true);
      qbtn.disabled = true;
      qbtn.textContent = "快评中...";
      C.sendQuickEval({ url, title, text, poster: extractPosterName() }, (err) => {
        C.setQuickEvaluating(false);
        qbtn.disabled = false;
        qbtn.textContent = "快评";
        C.showQuickError(err);
      });
    });
    opBar.insertBefore(qbtn, (share && share.nextSibling) || btn.nextSibling);
  }

  // ---- 每卡操作区（快评 / 评估 + 状态胶囊）的挂载点 -----------------------
  //
  // 按钮、胶囊、评估/快评的派发与收尾全在 core（三站共用一份），本站只回答
  // 「插到哪」和「JD / 公司名从哪来」。两种卡片骨架：
  //   • /web/geek/jobs 列表卡 li.job-card-box —— 操作行接在 .job-card-footer 之后；
  //   • 个人中心「感兴趣」li.item-boss —— 没有 footer，追加在 .job-info 末尾
  //     （个人中心也没有 /web/geek/jobs 那个右栏详情面板，右栏那套按钮在那儿
  //      无处安放，所以历来是每卡一排）。
  // 两种都是整行（胶囊在左、按钮在右），只给 mounts.row。
  //
  // 快评与完整评估都需要 JD 正文，而列表卡没有：由卡片锚点**站内 fetch**详情页
  // HTML 再解析（实证 2026-11-10：带 cookie 的站内 fetch 返回完整 SSR HTML，
  // .job-sec-text 可读，不触发验证页）。这条路必须走 —— 服务端抓 BOSS 会被风控
  // 拦成空页，不带 JD 的评估会让 agent 落到 browser-extract 卡死。
  function cardActionMounts(card) {
    const footer = card.querySelector(".job-card-footer");
    if (footer && footer.parentElement) {
      return { row: { parent: footer.parentElement, before: footer.nextSibling } };
    }
    const host = card.querySelector(".job-info") || card.querySelector(".item-content") || card;
    return { row: { parent: host, before: null } };
  }

  /** 卡片上的公司名（个人中心卡片里是 b > a[href*="/gongsi/"]）。 */
  function cardCompany(card) {
    const el =
      card.querySelector('a[href*="/gongsi/"]') ||
      card.querySelector('.company-info .text b, .company-info b, [class*="company-name"]');
    const t = el ? (el.innerText || el.textContent || "").trim() : "";
    return (t.split("\n")[0] || "").trim().slice(0, 40);
  }

  /**
   * 解析详情页 HTML → { title, text }。desc 取职位描述区（.job-sec-text 为主）；
   * 不足 80 字视为没抓到（多半是验证页/骨架页），此时 text 只剩标题+薪资，
   * 由 fetchCardJd 按长度判失败 —— 这里不抛错，便于区分「HTML 能读但没描述」
   * 与「网络就失败」两种成因，报错文案不同。
   */
  function parseDetailHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    const pick = (sel) => {
      const el = doc.querySelector(sel);
      if (!el) return "";
      return (el.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    };
    const title = pick("h1, .job-banner .name h1, [class*='job-name']");
    const price = pick(".job-banner .salary, [class*='job-salary'], [class*='salary']");
    const desc = pick(".job-sec-text, .job-detail-section .text, [class*='job-sec'] .text");
    const parts = [title];
    if (price) parts.push(price);
    if (desc.length >= 80) parts.push(desc);
    return { title, text: parts.filter(Boolean).join("\n").trim().slice(0, 12000) };
  }

  /** 站内抓详情页并解析出 JD；失败一律抛带原因的 Error（调用方 toast）。 */
  async function fetchCardJd(url) {
    let res;
    try {
      res = await fetch(url, { credentials: "include" });
    } catch (err) {
      throw new Error(`详情页抓取失败：${err && err.message ? err.message : err}`);
    }
    if (!res.ok) throw new Error(`详情页抓取失败：HTTP ${res.status}`);
    const jd = parseDetailHtml(await res.text());
    if (jd.text.length < 80) throw new Error("详情页没返回职位描述（可能需要验证）");
    return jd;
  }

  const BOSS_SITE = {
    hostMatch: /(^|\.)zhipin\.com$/i,
    // scan mode 上报的 source 根:web 侧按 browser-{source} 归属平台(BROWSER_SOURCES)。
    source: "zhipin",
    cardSelector: CARD_SELECTOR,
    linkSelector: LINK_SELECTOR,
    // BOSS直聘 board-specific: securityId is the anti-bot session token and ka is
    // a click-source param — both vary per-request, never identify the posting.
    extraTrackingParams: [/^securityId$/i, /^ka$/i],
    ids: { listEvalBtn: LIST_EVAL_BTN_ID, listQuickBtn: LIST_QUICK_BTN_ID },
    isDetailPath,
    cardIsList,
    cardUrl,
    cardMeta,
    currentActiveUrl,
    extractDetailJd,
    extractPosterName,
    extractListPaneJd,
    ensureRightPaneButton,
    // 每卡操作区（快评 / 评估 + 胶囊）的挂载点与素材来源；形状与状态机在 core。
    cardActionMounts,
    cardCompany,
    fetchCardJd,
    // 声明详情页评估内联 DOM 提取的 JD 全文 + 雇主名,绕开服务端 WebFetch
    // (BOSS 被风控拦截返回空,会导致 agent 落 browser-extract 卡死)。
    evaluateInlineJd: true,
  };

  C.init(BOSS_SITE);
})();

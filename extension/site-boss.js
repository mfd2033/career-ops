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
  const CARD_SELECTOR = "li.job-card-box";
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
    const company = text('[class*="company-name"],[class*="company"] .name,.company-info .name,[class*="brand"]');
    return {
      url: cardUrl(card),
      title: text(LINK_SELECTOR),
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
    // 声明详情页评估内联 DOM 提取的 JD 全文 + 雇主名,绕开服务端 WebFetch
    // (BOSS 被风控拦截返回空,会导致 agent 落 browser-extract 卡死)。
    evaluateInlineJd: true,
  };

  C.init(BOSS_SITE);
})();

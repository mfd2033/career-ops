// 猎聘 site 适配 — 选择器 / JD 提取。
//
// 站点无关逻辑（徽章、详情页按钮、消息、observer、diag）在 core.js；
// 本文件只含猎聘专属事实，末尾把适配对象交给 core 启动。
// DOM 调研事实见 docs/adr/0005-liepin-extension-adaptation.md。
//
// 与 BOSS 的差异：
//   • 搜索页无右侧详情面板 → 不提供 ensureRightPaneButton / extractListPaneJd /
//     currentActiveUrl（core 以 typeof 守卫，缺失即跳过）；
//   • 搜索页卡片无职位描述全文 → 列表无快评入口，只有已评估徽章；
//   • 详情页无 <h1> → 标题取 .name-box > span.name；
//   • 推荐位详情变体 /a/{id}.shtml 与 /job/{id}.shtml 都算详情页。

(function () {
  "use strict";

  // 猎聘搜索页卡片容器：外层带每次加载随机变化的哈希 class，不能依赖前缀以外
  // 的部分；职位链接稳定锚点是 a[data-nick="job-detail-job-info"]。
  const CARD_SELECTOR = "[class*='job-card-pc-container']";
  const LINK_SELECTOR = 'a[data-nick="job-detail-job-info"]';

  // 详情页：/job/{id}.shtml 与推荐位变体 /a/{id}.shtml。数字 + .shtml 结尾，
  // 防误判 /zhaopin/ 等列表路径。
  function isDetailPath(pathname) {
    return /^\/(job|a)\/\d+\.shtml$/i.test(pathname);
  }

  function cardIsList(card) {
    return !isDetailPath(location.pathname) && !!card.querySelector(LINK_SELECTOR);
  }

  // 猎聘搜索页是「分页型」平台（非懒加载滚动，ADR-0001）：职位量靠翻页控件逐页
  // 加载。扫描采集经 DOM 翻页驱动 —— 点击「下一页」按钮引页面原生加载，新卡片由
  // core 的 MutationObserver 捕获进累积器（猎聘卡片有真实锚点，无需智联式 API 直连）。
  // 下一页按钮选择器：
  //   1) antd 分页（现猎聘前端，实测 2026-09-11）：`ul.ant-pagination > li.ant-pagination-next
  //      > button.ant-pagination-item-link`，末页时 li 打 `ant-pagination-disabled` class、
  //      按钮打 `ant-pagination-item-link-disabled`，都排除；
  //   2) 旧版猎聘骨架（zh-collect.mjs findNextPage 沿用）`a.pager-next` 等作兼容兜底。
  // 优先命中可见且未禁用的 next 控件。
  const PAGE_NEXT_SELECTORS = [
    'li.ant-pagination-next:not(.ant-pagination-disabled) button.ant-pagination-item-link',
    'li.ant-pagination-next:not(.ant-pagination-disabled) a',
    'a.ant-pagination-item-link:not(.ant-pagination-item-link-disabled)',
    'a.pager-next:not([class*="disabled"]):not([aria-disabled="true"])',
    'li.pager-next:not([class*="disabled"]) a',
    '.pager a.next:not([class*="disabled"]):not([aria-disabled="true"])',
    'li.next a:not([class*="disabled"]):not([aria-disabled="true"])',
    'a[class*="pager-next"]:not([class*="disabled"]):not([aria-disabled="true"])',
    'button[class*="next"]:not([disabled])',
  ];

  /** 找猎聘分页「下一页」控件（可见、未禁用）。找不到返回 null = 已到末页。 */
  function findNextPageBtn() {
    for (const sel of PAGE_NEXT_SELECTORS) {
      const el = document.querySelector(sel);
      if (!el) continue;
      // 可见性：命中但被隐藏/移出视口的控件不采（offsetParent 为 null 即不可见）。
      if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
    }
    return null;
  }

  /** 列表卡片的职位绝对 URL（取自详情锚点）。 */
  function cardUrl(card) {
    const a = card.querySelector(LINK_SELECTOR);
    if (!a) return null;
    const href = a.href || a.getAttribute("href");
    return href && /^https?:\/\//i.test(href) ? href : null;
  }

  /**
   * 卡片文本级薪资提取（纯函数,node 单测直测）。猎聘卡片容器哈希 class 多变,
   * `[class*="salary"]` 在改版后会落空（实证 2026-09: cardMeta.salary 抓到空串,
   * 门控只能按「薪资未知」放行）——兜底从卡片全文按 bsk 路径同款 ASCII 薪资
   * 形态正则提取（与 bsk-extract.mjs 的 extractSalaryFromText 同规则,两处同改）。
   * 经验年限「5-10年」/「13薪」单独出现不构成命中。
   */
  function extractSalaryFromCardText(text) {
    const t = String(text ?? "");
    if (!t) return "";
    const m = t.match(
      /\d+(?:\.\d+)?\s*[-–~]\s*\d+(?:\.\d+)?\s*(?:千|[kK]|万)(?:\s*·\s*\d+\s*薪)?|\d+(?:\.\d+)?\s*(?:千|[kK]|万)(?:\s*·\s*\d+\s*薪)?/,
    );
    return m ? m[0].trim() : "";
  }

  /**
   * 列表卡片全量元字段（URL 复用 cardUrl）。猎聘卡片容器哈希 class 多变，内容选择器
   * 取宽、尽力而为，抓不到即空串。salary 选择器落空时回退卡片文本级提取。
   * city 不在此定点（无稳定卡片城市 class，城市过滤走 web 侧 matchesBrowserCity
   * 以 title 兜底，ADR-0007 E4）。
   */
  function cardMeta(card) {
    const text = (sel) => {
      const el = card.querySelector(sel);
      return el ? (el.innerText || el.textContent || "").trim() : "";
    };
    const salary = text('[class*="salary"],[class*="item-salary"],[class*="price"]') || extractSalaryFromCardText(card.innerText || "");
    return {
      url: cardUrl(card),
      title: text(LINK_SELECTOR),
      company: text('[class*="company"].job-company, .item-company, [class*="company-name"], [class*="company"] .name'),
      salary,
      city: undefined, // 猎聘无卡片城市 class —— 城市过滤走 web 侧 title 匹配
    };
  }

  /**
   * 从详情页 DOM 提取 JD 文本。猎聘无 <h1>，标题在
   * .job-apply-container .name-box > span.name；薪资 span.salary；职位描述
   * section.job-intro-container dl.paragraph dd[data-selector="job-intro-content"]
   * （含岗位职责+任职要求全文）。返回 {title,text}，text 为空表示提取失败。
   */
  function extractDetailJd() {
    const titleEl = document.querySelector(
      '.job-apply-container .name-box span.name, .name-box span.name, [class*="name-box"] [class*="name"]',
    );
    const title = titleEl ? titleEl.innerText.trim() : "";
    const priceEl = document.querySelector("span.salary, [class*='salary']");
    const price = priceEl ? priceEl.innerText.trim() : "";
    // 描述区：data-selector 稳定锚点优先，其次宽选择器回退。
    let desc = "";
    const descHit = document.querySelector(
      'dd[data-selector="job-intro-content"], [data-selector="job-intro-content"], section.job-intro-container dl.paragraph dd',
    );
    if (descHit) {
      const t = descHit.innerText.trim();
      if (t.length > 80) desc = t;
    }
    if (!desc) {
      const anchors = ["职位描述", "岗位职责", "任职要求", "职位详情"];
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
    const parts = [title];
    if (price) parts.push(price);
    if (desc) parts.push(desc);
    const text = parts.join("\n").trim().slice(0, 12000);
    return { title, text };
  }

  /**
   * 尽力提取发帖公司名。详情页公司块在 .recruiter-container a[href*="/company/"]，
   * 文本常带"· "前缀。取不到返回空串（快评跟随策略时退回不前缀）。
   *
   * 策略：先限在职位详情主区域内找，避免页面上推荐职位/侧边推荐等干扰区域的公司名
   * 被首选匹配；找不到再回退全局搜索。
   */
  function extractPosterName() {
    // 职位详情主区域容器（class 随站点改版可能变化，取宽匹配）。
    const detailArea = document.querySelector(
      '.job-apply-container, [class*="job-apply"], [class*="job-detail"]'
    );
    if (detailArea) {
      const el = detailArea.querySelector(
        '.recruiter-container a[href*="/company/"], a[href*="/company/"], [class*="company-name"]'
      );
      if (el) {
        let t = (el.innerText || el.textContent || "").trim();
        t = t.replace(/^[·\s.]+\s*/, "").trim();
        if (t) return t.slice(0, 40);
      }
    }
    // 回退：全局找第一个匹配（最后手段）。
    const sel = [
      '.recruiter-container a[href*="/company/"]',
      'a[href*="/company/"]',
      '[class*="recruiter-container"] a',
      '[class*="company-name"]',
      '.company-info .name',
    ].join(",");
    const el = document.querySelector(sel);
    if (!el) return "";
    let t = (el.innerText || el.textContent || "").trim();
    t = t.replace(/^[·\s.]+\s*/, "").trim();
    return t.slice(0, 40);
  }

  const LIEPIN_SITE = {
    hostMatch: /(^|\.)liepin\.com$/i,
    source: "liepin",
    cardSelector: CARD_SELECTOR,
    linkSelector: LINK_SELECTOR,
    // 猎聘反爬/跟踪参数：每次请求变化，去重键 strip 后仅留 job/{id}.shtml。
    // skId/fkId/ckId 等价 BOSS 的 securityId。
    extraTrackingParams: [
      /^pgRef$/i, /^d_sfrom$/i, /^d_ckId$/i, /^d_curPage$/i, /^d_pageSize$/i,
      /^d_headId$/i, /^d_posi$/i, /^skId$/i, /^fkId$/i, /^ckId$/i,
      /^sfrom$/i, /^curPage$/i, /^pageSize$/i, /^index$/i,
    ],
    // 猎聘搜索页是分页型平台：扫全量靠点「下一页」而非滚动。core scan mode 见
    // isPageMode=true 即走 DOM 翻页驱动（findNextPageBtn → click → MutationObserver
    // 采新卡），不再滚动步进；无下一页控件 = 末页，配合静默阈值收尾。
    isPageMode: true,
    findNextPageBtn,
    // 猎聘无列表右栏面板，不提供 ids/ensureRightPaneButton/extractListPaneJd/
    // currentActiveUrl —— core 以 typeof 守卫，缺失即跳过。
    // evaluateInlineJd: 详情页完整评估带 DOM 提取的 JD 全文+雇主名,绕开服务端
    // 抓取(猎聘搜索页需登录、详情页游客可读但裸抓不可靠)。
    evaluateInlineJd: true,
    isDetailPath,
    cardIsList,
    cardUrl,
    cardMeta,
    extractDetailJd,
    extractPosterName,
  };

  // 浏览器环境: 交给 core 启动站点注入; 非浏览器(node 单元测试)只导出纯函数,
  // 不引用 window/document/location。
  if (typeof window === "undefined" || !window.__careerExtCore) {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = { LIEPIN_SITE, isDetailPath, cardIsList, cardUrl, cardMeta, extractDetailJd, extractPosterName, findNextPageBtn, extractSalaryFromCardText };
    }
    return;
  }
  window.__careerExtCore.init(LIEPIN_SITE);
})();

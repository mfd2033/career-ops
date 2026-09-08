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

  /** 列表卡片的职位绝对 URL（取自详情锚点）。 */
  function cardUrl(card) {
    const a = card.querySelector(LINK_SELECTOR);
    if (!a) return null;
    const href = a.href || a.getAttribute("href");
    return href && /^https?:\/\//i.test(href) ? href : null;
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
    cardSelector: CARD_SELECTOR,
    linkSelector: LINK_SELECTOR,
    // 猎聘反爬/跟踪参数：每次请求变化，去重键 strip 后仅留 job/{id}.shtml。
    // skId/fkId/ckId 等价 BOSS 的 securityId。
    extraTrackingParams: [
      /^pgRef$/i, /^d_sfrom$/i, /^d_ckId$/i, /^d_curPage$/i, /^d_pageSize$/i,
      /^d_headId$/i, /^d_posi$/i, /^skId$/i, /^fkId$/i, /^ckId$/i,
      /^sfrom$/i, /^curPage$/i, /^pageSize$/i, /^index$/i,
    ],
    // 猎聘无列表右栏面板，不提供 ids/ensureRightPaneButton/extractListPaneJd/
    // currentActiveUrl —— core 以 typeof 守卫，缺失即跳过。
    // evaluateInlineJd: 详情页完整评估带 DOM 提取的 JD 全文+雇主名,绕开服务端
    // 抓取(猎聘搜索页需登录、详情页游客可读但裸抓不可靠)。
    evaluateInlineJd: true,
    isDetailPath,
    cardIsList,
    cardUrl,
    extractDetailJd,
    extractPosterName,
  };

  // 浏览器环境: 交给 core 启动站点注入; 非浏览器(node 单元测试)只导出纯函数,
  // 不引用 window/document/location。
  if (typeof window === "undefined" || !window.__careerExtCore) {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = { LIEPIN_SITE, isDetailPath, cardIsList, cardUrl, extractDetailJd, extractPosterName };
    }
    return;
  }
  window.__careerExtCore.init(LIEPIN_SITE);
})();

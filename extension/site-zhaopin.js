// 智联招聘 site 适配 — 选择器 / JD 提取 / positionList 职位 URL / 右栏面板按钮。
//
// 站点无关逻辑（徽章、详情页按钮、消息、observer、diag）在 core.js；
// 本文件只含智联专属事实，末尾把适配对象交给 core 启动。
// DOM 调研事实见 docs/adr/0006-zhaopin-extension-adaptation.md。
//
// 与 BOSS/猎聘的关键差异：
//   • 搜索页 = 左列表 + 右描述面板（两栏，同 BOSS，非猎聘"仅徽章"）→ 提供
//     ensureRightPaneButton / extractListPaneJd / currentActiveUrl，右栏快评可行；
//   • 搜索卡片 DIV.job-card 内【无职位 <a>】（唯一 <a> 指向公司详情）→ 职位 URL
//     无法从卡片 DOM 取得，必须用 window.__INITIAL_STATE__.positionList 的
//     positionUrl 按卡片 index 映射；
//   • 列表 SSR 只渲染首屏 20 条且 positionList 不随懒加载增长（顺序还会错位）→
//     首屏外的职位经 fetchRestPages 由 background MAIN world 直连
//     /c/i/search/positions 翻页拉取（ADR-0008），不依赖 DOM 卡片；
//   • active 卡 = DIV.job-card--active（点击实时重渲染右栏）;__INITIAL_STATE__
//     .selectedJobId 是冻结快照、不随动 —— 读当前职位一律以 .job-card--active +
//     右栏内容为准，不信 selectedJobId；
//   • 描述容器 class 是站点拼写 typo "describtion-card"（非 description），照用；
//   • 城市无独立稳定 class，从 positionList[].workCity 取；勿用 header .city
//     （那是站点城市非职位城市）。

(function () {
  "use strict";

  // 惰性引用 core:前导声明避免 node 测试(无 window)加载即崩;浏览器分支 init
  // 前赋值,ensureRightPaneButton(仅浏览器路径调用)用时必已就位。
  let C = null;

  // 搜索页列表卡片。SPA 渲染，卡片是 DIV.job-card（BEM 块），active 为
  // BEM 修饰符 job-card--active。卡片内无职位 <a>。
  //
  // 「我的收藏」（i.zhaopin.com/position/collect）是另一套骨架：
  // DIV.joblist-box__item，职位锚点是 a.joblist-box__iteminfo（指向
  // jobs.zhaopin.com/CC…J….htm），右侧原生操作列 DIV.joblist-box__item__jobbtn。
  // 两种容器互斥（各自页面只出现一种），并列进选择器 —— 在此之前收藏页整页匹配 0，
  // 插件在那里完全不生效。
  const COLLECT_CARD_SELECTOR = "div.joblist-box__item";
  const CARD_SELECTOR = "div.job-card, div.joblist-box__item";
  // 卡片内唯一 <a> 指向公司详情（留作 diag 参考锚点，非职位锚）。
  const LINK_SELECTOR = 'a[href*="companydetail"]';

  /** 收藏页卡片？两套骨架的挂载点与 URL 来源完全不同，先分流再各自处理。 */
  function isCollectCard(card) {
    return !!card && typeof card.matches === "function" && card.matches(COLLECT_CARD_SELECTOR);
  }

  /**
   * 职位 URL 统一转写成规范形态 `https://www.zhaopin.com/jobdetail/{id}.htm`。
   *
   * 智联的职位 URL 按入口有三种写法：搜索页 positionList 给 www 详情页；收藏页卡片
   * 锚点给 jobs.zhaopin.com/CC…J….htm；tracker 里存的是 www 形态（isDetailPath 的口径）。
   * 不转写的话徽章匹配不上已有报告、评估还会重复建行。两种形态实测都 200 且 SSR
   * 带 describtion-card 正文，所以只是同一职位换了个壳。
   * 认不出 id 返回 null（调用方据此跳过这张卡，不拼一个必然 404 的 URL）。
   */
  function canonicalDetailUrl(raw) {
    const s = typeof raw === "string" ? raw.trim() : "";
    if (!s) return null;
    const m = s.match(/\/jobdetail\/([^/?#]+?)(?:\.htm)?(?:[?#]|$)/i) || s.match(/(CC[0-9A-Za-z]+J[0-9A-Za-z]+)(?:\.htm)?/);
    return m ? "https://www.zhaopin.com/jobdetail/" + m[1] + ".htm" : null;
  }

  /**
   * 从 window.__INITIAL_STATE__.positionList 读取职位列表。
   * 数组对象 key 极多，positionUrl（完整绝对 URL）与 number（=公司号+J+jobId）
   * 是关键；positionCount 恒为 0 不可信。返回数组，读不到返回 []。
   *
   * 智联改版后 __INITIAL_STATE__ 只在主世界可见，isolated world 直接读
   * window.__INITIAL_STATE__ 拿不到(positionList 在扩展侧实测恒空，卡无职位锚
   * 致 url 全 null、扫描 count=0)。故改为：主世界注入脚本把精简后的
   * positionList 写入 <html data-zpstate='...'>，本函数从该 dataset 解析；
   * 缓存缺或为空时触发一次主世界注入刷新，绕开 world 隔离拿到职位 url。
   */
  let _zpCacheTs = 0;
  const ZP_STATE_ATTR = "data-zpstate";

  /** 从 html[data-zpstate] 读精简 positionList 缓存,无/空返回 null。 */
  function _zpFromAttr() {
    const raw = document.documentElement.getAttribute(ZP_STATE_ATTR);
    if (!raw) return null;
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length ? arr : null;
    } catch {
      return null;
    }
  }

  /**
   * 刷新 data-zpstate 缓存(该字段为智联职位 url 数据源,loaded 自后台 MAIN world 读取)。
   * 后台经 chrome.scripting.executeScript({world:'MAIN'}) 读 window.__INITIAL_STATE__
   * .positionList(页面 CSP script-src 禁内联注入,故不走 <script> 弹入;扩展 programmatic
   * 注入豁免 CSP),精简 {url,name,city}[] 回传后写入本属性。返回实际写入条数。
   */
  function useMainWorldToReadPositionList(cb) {
    if (C && typeof C.sendMsg === "function") {
      C.sendMsg({ type: "zp-get-state" }, (res) => {
        const list = (res && res.ok && Array.isArray(res.list) && res.list) || [];
        try {
          document.documentElement.setAttribute(ZP_STATE_ATTR, JSON.stringify(list));
        } catch (e) {
          /* attr write best-effort */
        }
        _zpCacheTs = Date.now();
        if (typeof cb === "function") cb(list);
      });
      return;
    }
    if (typeof cb === "function") cb([]);
  }

  function getPositionList() {
    try {
      const cached = _zpFromAttr();
      if (cached) return cached;
      // 无缓存:直接读 window 快照兜底(大多数情况空,因隔离;至少不崩)。
      const st = window.__INITIAL_STATE__;
      if (st && Array.isArray(st.positionList)) return st.positionList;
    } catch (e) {
      /* state read must never sink the DOM read */
    }
    return [];
  }

  /** 启动采集前确保 url 缓存就绪(异步):refresh 一次填充 data-zpstate。 */
  function ensureZpState() {
    return new Promise((resolve) => useMainWorldToReadPositionList(() => resolve()));
  }

  /**
   * 翻页采集 relay(ADR-0008):SSR 首屏 20 条之外的剩余页,经 background MAIN world
   * 注入循环 POST /c/i/search/positions 直接拉取(页面自身 load-more XHR 实测挂起,
   * 见 ADR-0008 调研)。回传精简 {url,title,company,salary,city}[],由 core 直喂
   * 采集累积器 — 不依赖 DOM 卡片增长,与首屏卡片按归一 URL 去重。node 环境(单测)
   * 无 C.sendMsg,回空调空数组,不影响纯函数路径。
   */
  function fetchRestPagesViaBackground(cb) {
    if (C && typeof C.sendMsg === "function") {
      C.sendMsg({ type: "zp-fetch-pages" }, (res) => {
        const metas = (res && res.ok && Array.isArray(res.metas) && res.metas) || [];
        if (typeof cb === "function") cb(metas);
      });
      return;
    }
    if (typeof cb === "function") cb([]);
  }

  /** 详情页：/jobdetail/{number}.htm。不带查询条件与列表路径,用正则精确匹配。 */
  function isDetailPath(pathname) {
    return /^\/jobdetail\/[^/?#]+\.htm$/i.test(pathname);
  }

  /**
   * 列表页 job-card / 收藏页 joblist-box__item 即列表卡（详情页不存在这两种容器）。
   * 收藏卡没有 companydetail 锚点，改按「能不能解析出职位 URL」判定。
   */
  function cardIsList(card) {
    if (!card || isDetailPath(location.pathname)) return false;
    if (isCollectCard(card)) return !!cardUrl(card);
    return !!card.querySelector(LINK_SELECTOR);
  }

  /**
   * 列表卡片的职位绝对 URL（一律转写成 www 规范形态，见 canonicalDetailUrl）。
   *   • 收藏卡：锚点 a.joblist-box__iteminfo 直给 jobs.zhaopin.com/CC…J….htm；
   *   • 搜索卡：卡片内无职位 <a>，须从 positionList[].positionUrl 按卡片 index 映射
   *     （数组顺序与 DOM 卡片顺序一致），再按标题文本兜底一次。
   */
  function cardUrl(card) {
    if (isCollectCard(card)) {
      const a = card.querySelector(
        'a[href*="/jobdetail/"], a[href*="jobs.zhaopin.com"], a.joblist-box__iteminfo',
      );
      return canonicalDetailUrl(a && a.href);
    }
    const list = getPositionList();
    if (!list.length) return null;
    // 1) index 映射：找该卡在 DOM 中的位置，对应 positionList[index]。
    const cards = Array.prototype.slice.call(document.querySelectorAll(CARD_SELECTOR));
    const idx = cards.indexOf(card);
    if (idx >= 0 && idx < list.length) {
      const p = list[idx];
      // 三种字段名都要认：直读 __INITIAL_STATE__ 是 positionUrl，而经
      // zp-get-state 写进 html[data-zpstate] 的精简壳用的是 url（同
      // zhaopinPositionFor 的口径）—— 只认前两种会让搜索卡的分数/状态全部落空。
      const url = p && (p.positionUrl || p.positionURL || p.url);
      if (url) return canonicalDetailUrl(String(url)) || String(url);
    }
    // 2) 回退：按卡片标题文本匹配 positionList[].name。
    const titleEl = card && card.querySelector('[class*="job-card__title"], h2, a');
    const title = titleEl ? (titleEl.innerText || titleEl.textContent || "").trim() : "";
    if (title) {
      const hit = list.find((p) => p && p.name && p.name === title) || list.find((p) => p && p.name && title.includes(p.name));
      if (hit) {
        const url = hit.positionUrl || hit.positionURL || hit.url;
        if (url) return canonicalDetailUrl(String(url)) || String(url);
      }
    }
    return null;
  }

  /**
   * 返回该列表卡片命中的 positionList 项（index 映射优先，名称匹配兜底），取不到 null。
   * URL / workCity / 标题都从这一项取，保证卡片与状态数据永远对齐。
   */
  function zhaopinPositionFor(card) {
    const list = getPositionList();
    if (!list || !list.length) return null;
    const cards = Array.prototype.slice.call(document.querySelectorAll(CARD_SELECTOR));
    const idx = cards.indexOf(card);
    if (idx >= 0 && idx < list.length) {
      const p = list[idx];
      // data-zpstate 缓存存精简壳字段 url(name/city);直读 __INITIAL_STATE__ 是
      // positionUrl。两种都认,避免缓存字段名与原始状态错位致 url 取不到。
      if (p && (p.positionUrl || p.positionURL || p.url)) return p;
    }
    const titleEl = card && card.querySelector('[class*="job-card__title"], h2, a');
    const title = titleEl ? (titleEl.innerText || titleEl.textContent || "").trim() : "";
    if (title) {
      const hit = list.find((p) => p && p.name && (p.name === title || title.includes(p.name)));
      // 命中后同样认缓存 shell 的 url 字段。
      return hit && (hit.positionUrl || hit.positionURL || hit.url) ? hit : null;
    }
    return null;
  }

  /**
   * 列表卡片全量元字段。url 取 positionList 状态（卡片 DOM 无职位 <a>，同 cardUrl 口径）；
   * city 权威源是 positionList[].workCity（ADR-0007 E4）：优先查传入的 cityMap 快照
   * （{归一/原始 positionUrl → workCity}），查不到回退 positionList 对应项，再回退 title。
   */
  function cardMeta(card, ctx) {
    const text = (sel) => {
      const el = card.querySelector(sel);
      return el ? (el.innerText || el.textContent || "").trim() : "";
    };
    // 收藏页卡片不吃 positionList（那是搜索页的状态）：标题/公司都在 iteminfo 里，
    // 城市无稳定 class（扫描时城市过滤走 web 侧 title 匹配，同 BOSS/猎聘口径）。
    if (isCollectCard(card)) {
      return {
        url: cardUrl(card),
        title: text(".joblist-box__iteminfo [class*='title'], [class*='iteminfo'] h3, h3") || text("a.joblist-box__iteminfo"),
        company: text("[class*='company-name'], [class*='company'] .name, h4"),
        salary: text("[class*='salary'], [class*='price']"),
        city: undefined,
      };
    }
    const p = zhaopinPositionFor(card);
    const url = p ? String(p.positionUrl || p.positionURL || p.url) : null;
    const title = text('[class*="job-card__title"], h2');
    let city;
    if (ctx && ctx.cityMap && url) {
      const hit = ctx.cityMap[url];
      if (hit) city = hit;
    }
    if (!city && p && p.workCity) city = String(p.workCity).trim();
    return { url, title, company: text('[class*="company-name"],[class*="company"] .name,h3'), salary: text('[class*="salary"],[class*="price"]'), city: city || undefined };
  }

  /**
   * 由 positionList 快照构建 {positionUrl → workCity} 映射表（ADR-0007 E4）。
   * 采集开始时快照一次，cardMeta 优先查此表，避免工作时反复读 window 状态。
   */
  function buildZhaopinCityMap(positionList) {
    const map = {};
    const list = Array.isArray(positionList) ? positionList : [];
    for (const p of list) {
      if (!p) continue;
      const u = p.positionUrl || p.positionURL || p.url;
      if (u && p.workCity) map[String(u)] = String(p.workCity).trim();
    }
    return map;
  }

  /**
   * 当前选中职位 URL。优先取右栏面板内职位标题 <a href*=...jobdetail...>.htm>
   * （纯 DOM，不受扩展 isolated world 读不到 __INITIAL_STATE__.positionList 影响，
   * 修复"未选中职位"）；取不到再回退 active 卡 + positionList 映射。
   * 归一到 https://www.zhaopin.com/jobdetail/{number}.htm，去跟踪参数。
   */
  function currentActiveUrl() {
    const a = document.querySelector('.job-detail-panel a[href*="jobdetail"]');
    if (a) {
      const m = a.href.match(/\/jobdetail\/([^/?#]+?)(?:\.htm|$)/i);
      if (m) return "https://www.zhaopin.com/jobdetail/" + m[1] + ".htm";
    }
    const active = document.querySelector(`${CARD_SELECTOR}--active`) || document.querySelector(CARD_SELECTOR);
    return active ? cardUrl(active) : null;
  }

  /**
   * 从搜索页右栏面板（.job-detail-panel 含当前选中职位描述全文）提取 JD 文本，
   * 供「快评」用。回退到 active 卡片标题。返回 {title,text}。
   */
  function extractListPaneJd() {
    const panel = document.querySelector(".job-detail-panel");
    let text = panel ? (panel.innerText || "").trim() : "";
    const active = document.querySelector(`${CARD_SELECTOR}--active`) || document.querySelector(CARD_SELECTOR);
    const titleEl = active && active.querySelector('[class*="job-card__title"], h2, a');
    let title = titleEl ? (titleEl.innerText || titleEl.textContent || "").trim() : "";
    // 标题取不到时退化用右栏标题（若存在 <h1>/title）。
    if (!title) {
      const t = document.querySelector(".job-detail-panel h1, .job-detail-panel [class*='title']");
      if (t) title = (t.innerText || "").trim();
    }
    if (!text || text.length < 120) text = [title, text].filter(Boolean).join("\n");
    return { title, text: text.trim().slice(0, 12000) };
  }

  /**
   * 从详情页 DOM 提取 JD 文本（标题+薪资+描述正文）。详情页专属锚点：
   * 标题 h1、薪资 SPAN.summary-planes__salary、正文 DIV.describtion-card
   * （站点拼写 typo，照用）。城市从 positionList 按 number 匹配取 workCity。
   * 返回 {title,text}，text 为空表示提取失败。
   */
  function extractDetailJd() {
    const titleEl = document.querySelector("h1");
    const title = titleEl ? titleEl.innerText.trim() : "";
    const priceEl = document.querySelector("span.summary-planes__salary");
    const price = priceEl ? priceEl.innerText.trim() : "";
    // 描述区：站点 typo class 照用，宽选择器回退。
    let desc = "";
    const descHit = document.querySelector(
      "div.describtion-card.seo-card, [class*='describtion-card'], [class*='job-description']",
    );
    if (descHit) {
      const t = descHit.innerText.trim();
      if (t.length > 80) desc = t;
    }
    if (!desc) {
      const anchors = ["职位描述", "岗位职责", "任职要求", "职位详情", "职责"];
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
    // 城市：详情 URL /jobdetail/{number}.htm 的 number 与 positionList[].number 相同，
    // 据此补城市文本（无独立稳定 class）。
    let city = "";
    const m = location.pathname.match(/\/jobdetail\/([^/]+)\.htm/i);
    if (m) {
      const p = getPositionList().find((x) => x && x.number === m[1]);
      if (p && p.workCity) city = String(p.workCity).trim();
    }
    const parts = [title];
    if (price) parts.push(price);
    if (city) parts.push(city);
    if (desc) parts.push(desc);
    const text = parts.join("\n").trim().slice(0, 12000);
    return { title, text };
  }

  /**
   * 尽力提取发帖公司名。详情页公司块 DIV.company-info，文本形如
   * "天原集团 已上市 · 1000-9999人 · …"，公司名在首段。取不到返回空串。
   *
   * 策略：先限在职位详情主区域（.job-detail-panel / .describtion-card）内找，
   * 避免页面上推荐职位/侧边推荐等干扰区域的公司名被首选匹配；找不到再回退全局搜索。
   */
  function extractPosterName() {
    // 职位详情主区域容器（class 随站点改版可能变化，取宽匹配）。
    const detailArea = document.querySelector(
      '.job-detail-panel, .describtion-card, [class*="job-detail"], [class*="description"]'
    );
    if (detailArea) {
      const el = detailArea.querySelector(
        ".company-info, .job-company-info, [class*='company-info']"
      );
      if (el) {
        let t = (el.innerText || el.textContent || "").trim();
        t = t.split(/\s{2,}|[·|/,，,]/)[0] || "";
        t = t.replace(/^\s+|\s+$/g, "").trim();
        if (t) return t.slice(0, 40);
      }
    }
    // 回退：全局找第一个匹配（最后手段）。
    const el = document.querySelector(".company-info, .job-company-info, [class*='company-info']");
    if (!el) return "";
    let t = (el.innerText || el.textContent || "").trim();
    t = t.split(/\s{2,}|[·|/,，,]/)[0] || "";
    t = t.replace(/^\s+|\s+$/g, "").trim();
    return t.slice(0, 40);
  }

  // 列表右栏「评估本职位」+「快评」按钮 — 锚到搜索页右栏 .job-detail-panel。
  // 智联右栏无 BOSS 的 .job-detail-op 操作栏，故按钮以 absolute 定位到面板
  // 顶部右侧，随面板重渲染跟着走（面板每次换选会重建，ensureRightPaneButton
  // 由 core 的 applyAllInjections / observer 反复调用，重插同 id 时跳过）。
  const LIST_EVAL_BTN_ID = "career-ext-list-eval-btn";
  const LIST_QUICK_BTN_ID = "career-ext-list-quick-btn";

  // 横向布局不写死在 CSS：位置由 positionPaneButtons 依据面板/摘要锚计算，
  // 两按钮同一行靠右排（修 bug2 重叠）并避开面板右侧官方 收藏/分享/举报 与 投递 按钮（修 bug3 遮盖）。
  const BUTTON_CSS =
    "position:absolute;z-index:50;" +
    "padding:6px 12px;border:none;border-radius:6px;cursor:pointer;" +
    "background:#00c68d;color:#fff;font-size:13px;font-weight:600;" +
    "font-family:system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.2);";
  const QUICK_BUTTON_CSS = BUTTON_CSS.replace("background:#00c68d", "background:#7c5cff");

  function ensureRightPaneButton() {
    if (isDetailPath(location.pathname)) {
      const s = document.getElementById(LIST_EVAL_BTN_ID);
      const q = document.getElementById(LIST_QUICK_BTN_ID);
      if (s) s.remove();
      if (q) q.remove();
      return;
    }
    const panel = document.querySelector(".job-detail-panel");
    if (!panel) return; // 面板未渲染 — observer 会重试
    // 同排布局：两按钮同一行、右缘对齐，位于摘要段(含 立即投递/收藏/分享/举报)横线之下，避开官方按钮。
    const positionPaneButtons = (btn, qbtn) => {
      const pr = panel.getBoundingClientRect();
      let topPx = 8;
      // 横线锚 = 摘要段(含 立即投递/收藏/分享/举报 .job-detail-summary…)的底边框；
      // 按钮放该横线之下(边框下 10px)。摘要段取不到时回退 apply 按钮所在容器。
      let anchor = panel.querySelector(
        '.job-detail-summary, section[class*="job-detail-summary"], section[class*="summary"]',
      );
      if (!anchor) {
        const ap = panel.querySelector('button[class*="apply"], a[class*="apply"], [class*="__apply"]');
        anchor = ap ? ap.closest("section,div") : null;
      }
      if (anchor) topPx = anchor.getBoundingClientRect().bottom - pr.top + 10;
      const pos = getComputedStyle(panel).position;
      if (pos === "static" || pos === "" || pos === "sticky") panel.style.position = "relative";
      btn.style.position = "absolute";
      btn.style.right = "8px";
      btn.style.top = topPx + "px";
      if (qbtn) {
        const w = btn.offsetWidth || 90;
        qbtn.style.position = "absolute";
        qbtn.style.right = 8 + w + 6 + "px";
        qbtn.style.top = topPx + "px";
      }
    };

    // 创建/取回按钮：已存在时返回既有元素，不重复创建。listener 绑定与创建
    // 解耦，统一走 bindOnce —— 只有全新实例才绑定，既有实例直接跳过。
    const make = (id, text, q) => {
      const existing = document.getElementById(id);
      if (existing) return existing;
      const b = C.makeButton({ id, text, css: q ? QUICK_BUTTON_CSS : BUTTON_CSS });
      panel.appendChild(b);
      return b;
    };
    // 一次性绑定 click：同一按钮实例只绑一次监听器。防止 observer / applyAllInjections
    // 反复调用 ensureRightPaneButton 时，对已存在于 DOM 的按钮叠加监听器 —— 否则
    // 一次点击触发多个 handler、对同一职位派发多次评估（报告号 226→243 持续
    // 增长即此缺陷）。面板若重建销毁旧按钮，新按钮无 dataset.extBound 标记，
    // 会重新绑定，覆盖重建场景。
    const bindOnce = (btn, tag, handler) => {
      if (btn.dataset.extBound) return;
      btn.dataset.extBound = tag;
      btn.addEventListener("click", handler);
    };
    const btn = make(LIST_EVAL_BTN_ID, "评估本职位", false);
    if (btn) {
      bindOnce(btn, "eval", () => {
        const el = document.getElementById(LIST_EVAL_BTN_ID);
        const url = currentActiveUrl();
        if (!url) {
          C.toast("未选中职位，请先在左侧点击一个职位", true);
          return;
        }
        el.disabled = true;
        el.textContent = "评估中...";
        const { title, text } = extractListPaneJd();
        const extra = {};
        if (text) {
          extra.jdText = [title, text].filter(Boolean).join("\n").trim().slice(0, 12000);
          extra.company = extractPosterName();
        }
        C.beginEval(url);
        C.sendSingleEvaluate(url, (err) => {
          el.disabled = false;
          el.textContent = "评估本职位";
          C.endEval();
          C.toast(err, true);
        }, extra);
      });
    }
    const qbtn = make(LIST_QUICK_BTN_ID, "快评", true);
    if (qbtn) {
      bindOnce(qbtn, "quick", () => {
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
    }
    // 面板每次重建/换选都重排（top/left 计算幂等，重复执行安全）。
    if (btn && qbtn) positionPaneButtons(btn, qbtn);
  }

  // ---- 每卡操作区（快评 / 评估 + 状态胶囊）--------------------------------
  //
  // 形状、按钮与评估/快评的派发全在 core（三站共用一份），这里只给挂载点与素材。
  // 智联两种骨架的挂法不同：
  //   • 搜索卡 div.job-card：整行接在 .job-card__company-row 之后；
  //   • 收藏卡 div.joblist-box__item：左右分栏 —— 胶囊仍在左侧信息区
  //     (.joblist-box__iteminfo) 末尾，按钮进右侧原生操作列
  //     (.joblist-box__item__jobbtn) 底部，与「已收藏 / 申请职位」同列同右缘。
  //     原生两颗按钮不动。
  function cardActionMounts(card) {
    if (isCollectCard(card)) {
      const info = card.querySelector(".joblist-box__iteminfo, [class*='iteminfo']");
      const ops = card.querySelector(".joblist-box__item__jobbtn, [class*='jobbtn']");
      if (info && ops) return { chips: { parent: info, before: null }, buttons: { parent: ops, before: null } };
      return info ? { row: { parent: info, before: null } } : null;
    }
    const row = card.querySelector(".job-card__company-row");
    if (row && row.parentElement) return { row: { parent: row.parentElement, before: row.nextSibling } };
    return { row: { parent: card, before: null } };
  }

  /** 卡片上的公司名（搜索卡与收藏卡的公司块 class 不同，逐候选取第一段）。 */
  function cardCompany(card) {
    const el = card.querySelector(
      '[class*="company-name"], [class*="company"] .name, .joblist-box__item__company, h3, h4',
    );
    const t = el ? (el.innerText || el.textContent || "").trim().split("\n")[0] : "";
    return t.trim().slice(0, 40);
  }

  /**
   * 解析详情页 HTML → { title, text }。选择器与 extractDetailJd 同一套（标题 h1、
   * 薪资 span.summary-planes__salary、正文 div.describtion-card —— 站点拼写 typo
   * 照用），数据源换成 background 代抓回来的 HTML 文本。
   */
  function parseDetailHtml(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    const pick = (sel) => {
      const el = doc.querySelector(sel);
      if (!el) return "";
      return (el.textContent || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    };
    const title = pick("h1");
    const price = pick("span.summary-planes__salary, [class*='salary']");
    const desc = pick("div.describtion-card, [class*='describtion-card'], [class*='job-description']");
    const parts = [title];
    if (price) parts.push(price);
    if (desc.length >= 80) parts.push(desc);
    return { title, text: parts.filter(Boolean).join("\n").trim().slice(0, 12000) };
  }

  /**
   * 站内抓详情页在页面上下文会被 CORS 挡死（收藏页 i.zhaopin.com 抓
   * jobs.zhaopin.com 实测 Failed to fetch），必须由 background 代抓
   * （host_permissions 已覆盖 https://*.zhaopin.com/*），解析仍在本文件。
   */
  async function fetchCardJd(url) {
    const res = await new Promise((resolve) => C.sendMsg({ type: "fetch-detail-html", url }, resolve));
    if (!res || !res.ok) throw new Error((res && res.error) || "详情页抓取失败");
    const jd = parseDetailHtml(res.html);
    if (jd.text.length < 80) throw new Error("详情页没返回职位描述（可能需要验证）");
    return jd;
  }

  const ZHAOPIN_SITE = {
    hostMatch: /(^|\.)zhaopin\.com$/i,
    source: "zhaopin",
    cardSelector: CARD_SELECTOR,
    linkSelector: LINK_SELECTOR,
    // 智联板反爬/跟踪参数：页内跳转锚点带 refcode/srccode/preactionid，其中
    // preactionid 每次操作即变 uuid。职位详情 URL (/jobdetail/{n}.htm) 本身无
    // 参数，jl/kw 是搜索查询条件保留。
    extraTrackingParams: [/^refcode$/i, /^srccode$/i, /^preactionid$/i],
    ids: { listEvalBtn: LIST_EVAL_BTN_ID, listQuickBtn: LIST_QUICK_BTN_ID },
    isDetailPath,
    cardIsList,
    cardUrl,
    cardMeta,
    buildScanCityMap: () => buildZhaopinCityMap(getPositionList()),
    // core 采集启动前 await 此钩子,确保 html[data-zpstate] url 缓存就位
    // (isolation 读不到页面 state → background MAIN world 注入读取)。
    ensureZpState,
    // 翻页采集 relay:首屏 20 条外的剩余页经 background 直连搜索 API 拉取
    // (ADR-0008),core 在采集启动后并行拉起,回传 meta[] 直喂累积器。
    fetchRestPages: fetchRestPagesViaBackground,
    currentActiveUrl,
    extractDetailJd,
    extractPosterName,
    extractListPaneJd,
    ensureRightPaneButton,
    // 每卡操作区（快评 / 评估 + 状态胶囊）的挂载点与素材来源。
    cardActionMounts,
    cardCompany,
    fetchCardJd,
    // 详情页完整评估带 DOM 提取的 JD 全文+雇主名，绕开服务端 WebFetch
    // (智联拦截 WebFetch/Playwright，与 BOSS/猎聘同口径)。
    evaluateInlineJd: true,
  };

  // 浏览器环境: 交给 core 启动站点注入; 非浏览器(node 单元测试)只导出纯函数,
  // 不引用 window/document/location。
  if (typeof window === "undefined" || !window.__careerExtCore) {
    if (typeof module !== "undefined" && module.exports) {
      module.exports = {
        ZHAOPIN_SITE, isDetailPath, cardIsList, cardUrl, currentActiveUrl,
        extractDetailJd, extractPosterName, extractListPaneJd,
      };
    }
    return;
  }
  C = window.__careerExtCore;
  C.init(ZHAOPIN_SITE);
})();
// 就地评估 — 站点无关核心 content script.
//
// 与原 BOSS 单文件 content.js 的差异：站点相关部分（选择器、JD 提取、右栏
// 面板按钮）移入 site-boss.js / site-liepin.js，通过 site 适配对象注入。
// 本文件只承载站点无关逻辑：归一 URL、徽章/按钮注入、评估/快评消息、
// MutationObserver、diag。每站入口文件（site-*.js）末尾调用
// window.__careerExtCore.init(site) 启动。
//
// 职责边界：
//   • core 不出现任何站点专属选择器字符串（一律走 site.*）；
//   • site 不复制状态机（evaluated/quickMap/selection/detail flags 全在 core）。

(function () {
  "use strict";

  // ---- site 适配对象（由 site-*.js 注入，init 前即就位） -------------------
  let site = null;
  // scan-pure.js 的纯逻辑层(先于本文件加载,window.__careerScanPure)。node 无此
  // 上下文;scan mode 全部走 SCAN.* 守卫,缺失即静默不提供采集。
  let SCAN = null;

  // The evaluated map lives in the background; this mirrors it locally on refresh.
  let evaluated = {}; // normalizedUrl → { score, reportNum }
  let quickMap = {}; // normalizedUrl → { score, grade, reason } (快评持久化徽章)
  let inited = false;

  // Canonical posting-URL key — mirrors web/src/lib/core/url-key.mjs `normalizeUrl`
  // (the same key that /api/report-status uses) so a badge matches an evaluation.
  // 全局跟踪参数（与站点无关）+ site.extraTrackingParams（站点专属）合并。
  const GLOBAL_TRACKING_PARAMS = [
    /^utm_/i, /^gh_src$/i, /^fbclid$/i, /^gclid$/i,
    /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^_hsenc$/i, /^_hsmi$/i, /^trk$/i, /^trackingid$/i,
  ];
  function normalizeUrl(raw) {
    if (typeof raw !== "string") return "";
    const s = raw.trim();
    if (!s) return "";
    let u;
    try {
      u = new URL(s);
    } catch {
      return "";
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    const tracking = GLOBAL_TRACKING_PARAMS.concat(site && Array.isArray(site.extraTrackingParams) ? site.extraTrackingParams : []);
    const keep = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!tracking.some((re) => re.test(k))) keep.push([k, v]);
    }
    keep.sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)));
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  }

  // ---- 共享状态 ------------------------------------------------------------
  const selectedKeys = new Set();
  let detailInjected = false;
  let detailEvaluating = false;
  let quickEvaluating = false;
  let resolvedOnce = false;
  // 评估收尾轮询状态:正在评估的职位 URL(detail 按钮或 BOSS 列表右栏按钮共用),
  // 评估发起时登记、收尾时清除。驱动收尾的是轮询而非消息 —— evaluated-updated
  // 依赖 background SW 存活,SW 空闲 30s 被 Chrome 终止后消息永不送达,按钮就卡
  // "评估中";轮询每 3s 拉一次评估地图(get-evaluated 消息会唤醒 SW),命中即收尾。
  let evalPollUrl = null;
  let evalPollTimer = null;

  // ---- 扩展上下文失效保护 ----------------------------------------------------
  // 扩展重载(chrome://extensions 刷新)后,旧页面里已注入的 content script 上下文
  // 立即失效:任何 chrome.runtime 调用都会抛 "Extension context invalidated"。
  // 统一经 sendMsg 发送;一旦捕获失效,停掉所有定时器/observer 静默退出 —— 页面
  // 刷新后新实例重新注入,不再有 uncaught error 刷屏扩展管理页。
  let invalidated = false;
  let observer = null; // boot 时赋值,teardown 需要 disconnect
  const timers = new Set(); // 受管定时器 id,teardown 统一清理
  function trackTimer(t) {
    if (t != null) timers.add(t);
    return t;
  }
  function teardown() {
    invalidated = true;
    for (const t of timers) clearInterval(t);
    timers.clear();
    if (observer) {
      try {
        observer.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
  function sendMsg(msg, cb) {
    if (invalidated) return;
    try {
      chrome.runtime.sendMessage(msg, cb);
    } catch {
      teardown();
    }
  }

  // ---- DOM 工具 ------------------------------------------------------------

  function showToast(text, isError) {
    const t = document.createElement("div");
    t.textContent = text;
    t.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;" +
      "padding:10px 14px;border-radius:8px;color:#fff;font-size:13px;" +
      `background:${isError ? "#d93026" : "#00c68d"};box-shadow:0 4px 12px rgba(0,0,0,.3);` +
      "font-family:system-ui,sans-serif;";
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  const QUICK_ERR_ID = "career-ext-quick-error";
  // 持久错误框（非气泡）：气泡自动消失太快，来不及复制错误信息。此框带「复制」
  // 和「关闭」，停留到用户处理完，可选中文本。
  function showQuickError(text) {
    let box = document.getElementById(QUICK_ERR_ID);
    if (box) box.remove();
    box = document.createElement("div");
    box.id = QUICK_ERR_ID;
    box.style.cssText =
      "position:fixed;top:88px;right:16px;z-index:2147483647;max-width:420px;" +
      "background:#d93026;color:#fff;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.35);" +
      "font-family:system-ui,sans-serif;font-size:12px;padding:10px 12px;line-height:1.5;";
    const label = document.createElement("div");
    label.textContent = "快评出错（点击复制）";
    label.style.cssText = "font-weight:700;margin-bottom:6px;font-size:11px;opacity:.9;";
    const pre = document.createElement("pre");
    pre.textContent = text;
    pre.style.cssText =
      "margin:0;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;" +
      "user-select:text;background:rgba(0,0,0,.25);border-radius:6px;padding:8px;";
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "margin-top:8px;display:flex;gap:8px;justify-content:flex-end;";
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "复制";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = "关闭";
    for (const b of [copyBtn, closeBtn]) {
      b.style.cssText =
        "border:none;border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;" +
        "font-family:system-ui,sans-serif;background:#fff;color:#d93026;font-weight:600;";
    }
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text).then(() => {
        copyBtn.textContent = "已复制";
        setTimeout(() => (copyBtn.textContent = "复制"), 900);
      });
    });
    closeBtn.addEventListener("click", () => box.remove());
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(closeBtn);
    box.appendChild(label);
    box.appendChild(pre);
    box.appendChild(btnRow);
    document.body.appendChild(box);
  }

  /** 创建统一风格按钮（site 文件组装右栏面板按钮时复用）。 */
  function makeButton({ id, text, css }) {
    const b = document.createElement("button");
    if (id) b.id = id;
    b.textContent = text;
    b.style.cssText = css;
    return b;
  }

  function openReport(num) {
    sendMsg({ type: "open-report", num }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        showToast(res && res.error ? res.error : "本地报告打不开：本地 web 服务可能未运行", true);
      }
    });
  }

  // ---- badge / checkbox injection (list cards) ------------------------------

  // Make the card a positioned context so absolutely-annexed badges/checkboxes
  // pin to IT, not to some far ancestor or a fragile zero-size holder.
  function ensurePositioned(card) {
    const pos = getComputedStyle(card).position;
    if (pos === "static" || pos === "sticky" || pos === "") card.style.position = "relative";
  }

  function scoreColor(scoreStr) {
    const n = parseFloat(scoreStr);
    if (Number.isFinite(n)) {
      if (n >= 4) return "#00c68d";
      if (n >= 3) return "#f5a623";
      return "#d93026";
    }
    return "#8a8f98";
  }

  function injectBadge(card, entry) {
    const badge = document.createElement("span");
    badge.dataset.careerBadge = "1";
    badge.textContent = `已评估 ${entry.score || ""}`.trim();
    badge.title = `点击打开报告 #${entry.reportNum}`;
    badge.style.cssText =
      "position:absolute;top:56px;right:8px;z-index:50;" +
      "cursor:pointer;font-size:12px;line-height:1;padding:4px 8px;border-radius:999px;" +
      `background:${scoreColor(entry.score)};color:#fff;font-weight:600;` +
      "box-shadow:0 2px 6px rgba(0,0,0,.25);font-family:system-ui,sans-serif;";
    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openReport(entry.reportNum);
    });
    ensurePositioned(card);
    card.appendChild(badge);
  }

  function injectCheckbox(card, key) {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.title = "选择此职位以便批量评估";
    cb.style.cssText =
      "position:absolute;top:8px;left:8px;z-index:50;width:16px;height:16px;" +
      "cursor:pointer;margin:0;accent-color:#00c68d;";
    cb.checked = selectedKeys.has(key);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedKeys.add(key);
      else selectedKeys.delete(key);
      syncSelection();
    });
    ensurePositioned(card);
    card.appendChild(cb);
  }

  // ---- 评估/快评消息（站点无关，site 只提供提取函数） ----------------------

  function sendSingleEvaluate(url, onFail, extra) {
    const msg = { type: "single-evaluate", url };
    if (extra && extra.jdText) msg.jdText = extra.jdText;
    if (extra && extra.company) msg.company = extra.company;
    sendMsg(msg, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        onFail((res && res.error) || "评估发起失败：本地 web 服务未运行?");
      }
    });
  }

  function sendQuickEval({ url, title, text, poster }, onFail) {
    sendMsg({ type: "quick-evaluate", url, title, text, poster }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        onFail((res && res.error) || "快评发起失败：本地 web 服务未运行?");
      }
    });
  }

  // ---- detail page button ---------------------------------------------------

  const DETAIL_BADGE_ID = "career-ext-detail-badge";
  const DETAIL_QUICK_BADGE_ID = "career-ext-detail-quick-badge";
  const DETAIL_EVAL_BTN_ID = "career-ext-eval-btn";
  const DETAIL_QUICK_BTN_ID = "career-ext-quick-btn";

  function injectDetailButton() {
    if (detailInjected) return;
    detailInjected = true;
    const btn = makeButton({
      id: DETAIL_EVAL_BTN_ID,
      text: "评估本职位",
      css:
        "position:fixed;right:20px;top:80px;z-index:2147483647;" +
        "padding:10px 16px;border:none;border-radius:8px;cursor:pointer;" +
        "background:#00c68d;color:#fff;font-size:14px;font-weight:600;" +
        "font-family:system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);",
    });
    btn.addEventListener("click", () => {
      if (detailEvaluating) return;
      detailEvaluating = true;
      btn.disabled = true;
      btn.textContent = "评估中...";
      // 站点声明 evaluateInlineJd 时(猎聘等登录墙站),详情页评估直接带 DOM 提取
      // 的 JD 全文 + 雇主名,绕开服务端二次抓取;BOSS 不声明,行为保持原样。
      const extra = {};
      if (site.evaluateInlineJd) {
        const { title, text } = site.extractDetailJd();
        if (text) {
          extra.jdText = [title, text].filter(Boolean).join("\n").trim().slice(0, 12000);
          extra.company = site.extractPosterName();
        }
      }
      sendSingleEvaluate(location.href, (err) => {
        detailEvaluating = false;
        btn.disabled = false;
        btn.textContent = "评估本职位";
        stopEvalPoll();
        showToast(err, true);
      }, extra);
      // 登记轮询收尾:SW 死亡等消息路径失效时,轮询保证按钮能恢复。
      startEvalPoll(location.href);
    });
    document.body.appendChild(btn);

    // 「快评」— 独立按钮，秒出分数徽章，只读（不写 tracker/报告/CV）。
    const qbtn = makeButton({
      id: DETAIL_QUICK_BTN_ID,
      text: "快评",
      css:
        "position:fixed;right:20px;top:80px;z-index:2147483647;" +
        "padding:10px 16px;border:none;border-radius:8px;cursor:pointer;" +
        "background:#7c5cff;color:#fff;font-size:14px;font-weight:600;" +
        "font-family:system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);",
    });
    qbtn.addEventListener("click", () => {
      if (quickEvaluating || qbtn.disabled) return;
      const { title, text } = site.extractDetailJd();
      if (!text) {
        showToast("快评：未能提取职位描述文本", true);
        return;
      }
      quickEvaluating = true;
      qbtn.disabled = true;
      qbtn.textContent = "快评中...";
      sendQuickEval({ url: location.href, title, text, poster: site.extractPosterName() }, (err) => {
        quickEvaluating = false;
        qbtn.disabled = false;
        qbtn.textContent = "快评";
        showQuickError(err);
      });
    });
    document.body.appendChild(qbtn);
    updateButtonPosition();
  }

  // Keep the eval + quick buttons vertically stacked under the detail badge; when
  // no badge is present they sit in the badge's own spot (top:80px). Re-measured
  // whenever the badge appears/disappears so an evaluation repositions them.
  function updateButtonPosition() {
    const btn = document.getElementById(DETAIL_EVAL_BTN_ID);
    const qbtn = document.getElementById(DETAIL_QUICK_BTN_ID);
    let top = 80;
    const badge = document.getElementById(DETAIL_BADGE_ID);
    const qbadge = document.getElementById(DETAIL_QUICK_BADGE_ID);
    if (badge) {
      const r = badge.getBoundingClientRect();
      top = Math.round(r.bottom + 8);
    }
    if (qbadge) {
      qbadge.style.top = `${top}px`;
      top = Math.round(qbadge.getBoundingClientRect().bottom + 8);
    }
    if (btn) btn.style.top = `${top}px`;
    if (qbtn) qbtn.style.top = btn ? `${top + btn.offsetHeight + 10}px` : `${top}px`;
  }

  function refreshQuickDetailBadge() {
    if (!site.isDetailPath(location.pathname)) return;
    const q = quickMap[normalizeUrl(location.href)];
    const existing = document.getElementById(DETAIL_QUICK_BADGE_ID);
    if (!q || q.score == null) {
      if (existing) existing.remove();
      updateButtonPosition();
      return;
    }
    const label = `快评 ${q.score}/5`.trim();
    if (existing) {
      if (existing.textContent !== label) {
        existing.textContent = label;
        existing.title = q.reason ? `快评：${q.grade} — ${q.reason}` : `快评：${q.grade}`;
        updateButtonPosition();
      }
      return;
    }
    const badge = document.createElement("div");
    badge.id = DETAIL_QUICK_BADGE_ID;
    badge.textContent = label;
    badge.title = q.reason ? `快评：${q.grade} — ${q.reason}` : `快评：${q.grade}`;
    badge.style.cssText =
      "position:fixed;top:80px;right:20px;z-index:2147483646;" +
      "cursor:default;font-size:13px;line-height:1;padding:8px 12px;border-radius:999px;" +
      "background:#7c5cff;color:#fff;font-weight:600;" +
      "box-shadow:0 4px 12px rgba(0,0,0,.3);font-family:system-ui,sans-serif;";
    document.body.appendChild(badge);
    updateButtonPosition();
  }

  function refreshQuick() {
    return new Promise((resolve) => {
      sendMsg({ type: "get-quick" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          resolve(false);
          return;
        }
        quickMap = res.map || {};
        applyAllInjections();
        resolve(true);
      });
    });
  }

  function refreshDetailBadge() {
    if (!site.isDetailPath(location.pathname)) return;
    const entry = evaluated[normalizeUrl(location.href)];
    const existing = document.getElementById(DETAIL_BADGE_ID);
    if (!entry) {
      if (existing) existing.remove();
      updateButtonPosition();
      return;
    }
    if (existing) {
      if (existing.textContent !== `已评估 ${entry.score || ""}`.trim()) {
        existing.textContent = `已评估 ${entry.score || ""}`.trim();
        updateButtonPosition();
      }
      return;
    }
    const badge = document.createElement("div");
    badge.id = DETAIL_BADGE_ID;
    badge.textContent = `已评估 ${entry.score || ""}`.trim();
    badge.title = `点击打开报告 #${entry.reportNum}`;
    badge.style.cssText =
      "position:fixed;top:80px;right:20px;z-index:2147483647;" +
      "cursor:pointer;font-size:13px;line-height:1;padding:8px 12px;border-radius:999px;" +
      `background:${scoreColor(entry.score)};color:#fff;font-weight:600;` +
      "box-shadow:0 4px 12px rgba(0,0,0,.3);font-family:system-ui,sans-serif;";
    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openReport(entry.reportNum);
    });
    document.body.appendChild(badge);
    updateButtonPosition();
  }

  // 统一重置所有评估按钮(detail 固定按钮 + BOSS 列表右栏按钮)。幂等:按钮
  // 不在 DOM 时(如 SPA 导航后)无操作,评估中的按钮恢复可点。
  function settleButtons() {
    detailEvaluating = false;
    const btn = document.getElementById(DETAIL_EVAL_BTN_ID);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "评估本职位";
    }
    const listBtn = site.ids && document.getElementById(site.ids.listEvalBtn);
    if (listBtn) {
      listBtn.disabled = false;
      listBtn.textContent = "评估本职位";
    }
  }

  function stopEvalPoll() {
    if (evalPollTimer) {
      clearInterval(evalPollTimer);
      evalPollTimer = null;
    }
    evalPollUrl = null;
  }

  /**
   * 评估中轮询收尾兜底。evaluated-updated 消息路径依赖 background SW 存活,
   * SW 被 Chrome 终止(空闲 30s)后消息永不送达 → 按钮卡"评估中";此轮询每 3s
   * 拉一次评估地图(get-evaluated 消息本身会唤醒 SW),命中即 finalizeDetail 收尾。
   * 与消息路径互补:任意一条先命中都安全 —— settleButtons 幂等,收尾时停轮询,
   * 不会双弹 toast/confirm。240 次(12min)上限防 SPA 导航后 URL 失配泄漏。
   */
  function startEvalPoll(url) {
    evalPollUrl = url;
    if (evalPollTimer) return;
    let tries = 0;
    evalPollTimer = trackTimer(setInterval(async () => {
      tries++;
      if (!evalPollUrl) {
        stopEvalPoll();
        return;
      }
      await refreshEvaluated();
      if (evalPollUrl && evaluated[normalizeUrl(evalPollUrl)]) {
        finalizeDetail();
        return;
      }
      if (tries >= 240) stopEvalPoll();
    }, 3000));
  }

  // Reset the detail button once the evaluated map comes back fresh.
  function finalizeDetail() {
    // 评估中的职位可能是 detail 页(固定按钮)或 BOSS 列表右栏(被选中职位),用
    // 轮询登记的真实 URL 查命中,而不是 location.href(列表页时不是职位 URL)。
    const key = evalPollUrl ? normalizeUrl(evalPollUrl) : normalizeUrl(location.href);
    const entry = evaluated[key];
    settleButtons();
    stopEvalPoll();
    if (entry) {
      showToast(`已评估 ${entry.score || ""}，报告 #${entry.reportNum}，已打开`.trim());
      // 评估完成自动打开报告页（用户确认过的手势：单职位评估结束后直接看报告，
      // 不再弹 confirm 让用户多点一次；confirm 在后台标签页还可能被浏览器拦截）。
      setTimeout(() => openReport(entry.reportNum), 400);
    }
  }

  // ---- selection sync (list cards) ------------------------------------------

  function syncSelection() {
    const urls = [];
    document.querySelectorAll(site.cardSelector).forEach((card) => {
      if (!site.cardIsList(card)) return;
      const key = normalizeUrl(site.cardUrl(card) || "");
      if (key && selectedKeys.has(key)) {
        const u = site.cardUrl(card);
        if (u) urls.push(u);
      }
    });
    sendMsg({ type: "selection-update", urls });
  }

  // ---- evaluated map (background-backed) ------------------------------------

  function refreshEvaluated() {
    return new Promise((resolve) => {
      sendMsg({ type: "get-evaluated" }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          resolvedOnce && showToast("本地 web 服务未运行", true);
          resolvedOnce = true;
          resolve(false);
          return;
        }
        evaluated = res.map || {};
        applyAllInjections();
        resolve(true);
      });
    });
  }

  // ---- per-card injection -----------------------------------------------

  function processCard(card) {
    if (card.__careerExt) return;
    card.__careerExt = true;

    if (site.cardIsList(card)) {
      const url = site.cardUrl(card);
      const key = url ? normalizeUrl(url) : "";
      if (!key) return;
      // Batch-evaluation checkboxes are disabled for now (feature dormant);
      // keep only the evaluated badge on list cards. Skeleton (injectCheckbox /
      // selectedKeys / syncSelection) stays for reinstating batch eval later.
      const entry = evaluated[key];
      if (entry) injectBadge(card, entry);
    }
  }

  function applyAllInjections() {
    document.querySelectorAll(site.cardSelector).forEach((card) => {
      if (!card.__careerExt) processCard(card);
      else {
        // Re-render badge when the entry (newly evaluated) appeared after init.
        if (site.cardIsList(card)) {
          const url = site.cardUrl(card);
          const key = url ? normalizeUrl(url) : "";
          const entry = key ? evaluated[key] : undefined;
          let badge = card.querySelector("span[data-career-badge]");
          if (entry && !badge) injectBadge(card, entry);
          else if (!entry && badge) badge.remove();
        }
      }
    });
    if (site.isDetailPath(location.pathname)) injectDetailButton();
    refreshDetailBadge();
    refreshQuickDetailBadge();
    if (typeof site.ensureRightPaneButton === "function") site.ensureRightPaneButton();
  }

  // ---- scan mode（扩展驱动采集，ADR-0007） ----------------------------------

  // 采集循环节奏常量(与 scan-pure.js 的批/上限分离:一个是纯切批,这里的节流/滚动
  // /静止判据是 DOM 实时节奏)。任一终止条件即停 —— 满上限 / 连续 8s 无新卡 /
  // 页面无可见滚动区(ADR-0007 E7)。
  const SCAN_QUIET_MS = 8000; // 连续无新卡片静默 8s = 懒加载到头
  const SCAN_BATCH_INTERVAL_MS = 2000; // 50 条/2s 节流上报(E5,防 web 端连点/风控)
  const SCAN_SCROLL_INTERVAL_MS = 900; // 滚动步进节奏
  const SCAN_SCROLL_HOLD_TICKS = 3; // 用户滚轮后暂停自动滚动 tick 数(让出接管)
  // 无可见滚动区的判定取「页面整页装下」而非「scrollTop 贴底不动」:触底贴住是
  // 懒加载页(智联分页/懒加载)的正常等待态,滚到底却仍有更多卡片时,自动滚动位置
  // 不动但 DOM 在涨,绝不按 scrollTop 判死。只有 maxY<=0(一屏装下,真无滚动区)
  // 才累计 noMoveTicks 收尾;触底后新卡来得慢的情况交给 SCAN_QUIET_MS 兜底。
  const SCAN_MAX_MOVE_TICKS = 3; // 无滚动区(整页装下)连续 tick 数,尽快收尾

  // 活跃扫描状态;null 表示未在采集。扫描本身不锁,用户可自由滚动/翻页 ——
  // MutationObserver 持续捕获新卡,滚轮只在短暂 holdTicks 内让出自动滚动。
  // pendingEnrich 字段:站点补充采集(智联翻页 API)在途标志,抑制终止条件。
  let scan = null;

  /** 站点平台名(web 侧 BROWSER_SOURCES 口径),来自 site.source;缺省 browser。 */
  function currentPlatform() {
    return (site && typeof site.source === "string" && site.source) || "browser";
  }

  /** 采集循环:每个 tick 先查终止条件,再滚一步 / 点下一页 / 让出用户接管。 */
  function scanTick() {
    if (!scan) return;
    // SPA 导航到详情页 → 列表不存在,立即收尾。
    if (site.isDetailPath(location.pathname)) {
      finishScan("navigated");
      return;
    }
    // 终态:满上限(needs 收集循环主动兜底,不依赖 flush 时机)。
    if (scan.acc.reachedMax) {
      finishScan("max");
      return;
    }
    // 分页型平台(猎聘):不走滚动/静止判定,驱动「下一页」逐页采集。
    if (site.isPageMode === true) {
      pagingAwareStep();
      if (scan) scan.scanTicks += 1;
      return;
    }
    // 终态:连续多 tick 无位移(无可见滚动区)。pendingEnrich(智联翻页 API 补采
    // 在途)期间不终止 — 首屏可能一屏装下提前触发 no-scroll,翻页数据还没回来。
    if (!scan.pendingEnrich && scan.noMoveTicks >= SCAN_MAX_MOVE_TICKS) {
      finishScan("no-scroll");
      return;
    }
    // 终态:已滚过且连续 8s 无新卡(懒加载到头)。翻页补采在途同样不终止。
    if (scan.hasScrolled && !scan.pendingEnrich && Date.now() - scan.lastNewAt > SCAN_QUIET_MS) {
      finishScan("quiet");
      return;
    }
    scrollAwareStep();
    if (scan) scan.scanTicks += 1;
  }

  /** 向当前 window 滚动容器步进一段。只有页面整页装下(无可见滚动区)才累计
   *  noMoveTicks;滚到底贴住但仍有更多卡片(懒加载)时正常等待,让 DOM 增长,
   *  no-scroll 终止交给 maxY<=0 兜底,加载慢交给 SCAN_QUIET_MS。 */
  function scrollAwareStep() {
    if (!scan) return;
    // 用户滚轮接管期:让出自动滚动,等hold结束再续(无锁,只是短暂让步)。
    if (scan.holdTicks > 0) {
      scan.holdTicks -= 1;
      return;
    }
    const scroller = document.scrollingElement || document.documentElement;
    if (!scroller) {
      scan.noMoveTicks += 1;
      return;
    }
    const maxY = scroller.scrollHeight - scroller.clientHeight;
    scan.maxY = maxY;
    scan.lastScrollTop = scroller.scrollTop;
    if (maxY <= 0) {
      // 无可见滚动区(整页装下) → 后续 tick 收尾。
      scan.noMoveTicks += 1;
      return;
    }
    const targetY = Math.min(scroller.scrollTop + Math.max(400, (window.innerHeight || 800) * 0.8), maxY);
    scroller.scrollTop = targetY;
    scan.hasScrolled = scan.hasScrolled || scroller.scrollTop > 0;
    // 触底(滚到底但还有懒加载区)不累计 noMoveTicks —— no-scroll 只按 maxY<=0 判。
    scan.noMoveTicks = 0;
  }

  // 分页型平台(猎聘)翻页驱动节奏:点击「下一页」后页面原生加载,新卡片经
  // MutationObserver 采入累积器;900ms tick 内采不完会连点下一页,加载慢交给
  // SCAN_QUIET_MS 兜底。任一终态即停 —— 满上限(scanTick 已查) / 无下一页控件后
  // 连续静默(末页数据已采完)。
  const SCAN_PAGING_MIN_GAP_MS = 1500; // 两次翻页最小间隔,防连点触发风控/重复加载

  /** 分页型平台:每个 tick 点一次「下一页」(有控件且距上次足够久),无控件则等到
   *  静默超阈值收尾。用户可自由点页码,采集只读不干预。lastPageClickAt 挂在 scan
   *  上(非模块级),避免多次扫描串扰。 */
  function pagingAwareStep() {
    if (!scan) return;
    const lastClick = scan.lastPageClickAt || 0;
    // 用户滚轮接管期语义保留(翻页页无滚动,实际不影响,仅防重复 handler)。
    if (scan.holdTicks > 0) {
      scan.holdTicks -= 1;
      return;
    }
    const nextBtn = site.findNextPageBtn ? site.findNextPageBtn() : null;
    if (!nextBtn) {
      // 无下一页控件 = 已到末页。该页新卡已采(或本就没有),等待静默收尾。
      if (Date.now() - scan.lastNewAt > SCAN_QUIET_MS) finishScan("paged");
      return;
    }
    // 末页判定兜底:控件存在但被禁用(点击无效果) → 视为无下一页。
    if (nextBtn.disabled || (nextBtn.getAttribute && nextBtn.getAttribute("aria-disabled") === "true")) {
      if (Date.now() - scan.lastNewAt > SCAN_QUIET_MS) finishScan("paged");
      return;
    }
    // 翻页节流:距上次点击不足最小间隔则等待(给 MutationObserver 采当前页时间)。
    if (Date.now() - lastClick < SCAN_PAGING_MIN_GAP_MS) return;
    try {
      nextBtn.click();
      scan.lastPageClickAt = Date.now();
    } catch {
      /* 点击场景:元素在点击瞬间失效(页面重渲染),交给下次 tick 重试 */
    }
  }

  /** 尝试把一张卡片收入扫描累积器(URL 已采则忽略,绝不重报)。取不到 url 的卡
   * 直接跳过:智联懒加载新卡(首屏 20 外)的职位 url 既不在 positionList 里,DOM
   * 也无锚点 — 这些职位由 site.fetchRestPages 直连搜索 API 补采(ADR-0008),
   * 卡片路径只负责首屏;曾试过的"刷新缓存重试"每次拉回同样 20 条,纯开销,已撤。
   */
  function scanCollect(card) {
    if (!scan || !SCAN || !card || !site.cardIsList(card)) return;
    let meta;
    try {
      meta = site.cardMeta(card, scan.ctx);
    } catch {
      return; // 某站提取异常不影响采集循环
    }
    if (!meta || !meta.url) return;
    const res = scan.acc.add(meta);
    if (res.added) scan.lastNewAt = Date.now();
  }

  /** 按批(50条)将待上报卡 POST 到 background(经 SW 转发 web,ADR-0007 E5)。 */
  function flushScanBatch() {
    if (!scan || !SCAN) return;
    const { batch } = scan.acc.flush(SCAN.SCAN_BATCH_SIZE);
    if (batch.length) {
      scan.pendingReports += batch.length;
      const offers = batch.map((e) => SCAN.toDiscoveredOffer(e.meta, currentPlatform()));
      sendMsg({ type: "scan-batch", scanId: scan.scanId, offers });
    }
    if (scan.acc.reachedMax) finishScan("max");
  }

  /** 清空定时器 / 监听器,上报剩余批次 + 完成通知,置 scan=null。 */
  function finishScan(reason) {
    if (!scan) return;
    const s = scan;
    if (SCAN) {
      // 收尾时把池中剩余一次性清空(超上半段一并上报),不被批大小截断。
      const { batch } = s.acc.flush(Infinity);
      if (batch.length) {
        s.pendingReports += batch.length;
        const offers = batch.map((e) => SCAN.toDiscoveredOffer(e.meta, currentPlatform()));
        sendMsg({ type: "scan-batch", scanId: s.scanId, offers });
      }
    }
    if (s.timers) {
      clearInterval(s.timers.scrollT);
      clearInterval(s.timers.batchT);
    }
    if (s.wheelFn) window.removeEventListener("wheel", s.wheelFn, { passive: true });
    const count = s.acc.count;
    scan = null;
    sendMsg({ type: "scan-done", scanId: s.scanId, count, reason });
    showToast(`采集结束：${count} 条新职位`, false);
  }

  /** 开始一轮采集(scanId 为空时生成一次会话 id)。智联需先经 ensureZpState 刷新
   *  data-zpstate url 缓存(isolated world 读不到页面 state),其它站无此钩子直接开跑。 */
  async function startScan(rawScanId) {
    if (!SCAN || !site) return;
    if (scan) return; // 已在采集,幂等
    if (site.isDetailPath(location.pathname)) return;
    // 智联 isolated world 读不到页面 state → 先经 ensureZpState 刷新
    // html[data-zpstate] url 缓存(background MAIN world 注入读 __INITIAL_STATE__);
    // 其它站无此钩子直接跳过,不影响同步路径。
    if (typeof site.ensureZpState === "function") {
      await site.ensureZpState();
    }
    if (scan) return; // ensureZpState await 期间被用户/其它消息停掉
    scan = {
      scanId: rawScanId && String(rawScanId).trim() ? String(rawScanId).trim() : `ext-scan-${Date.now()}`,
      ctx: typeof site.buildScanCityMap === "function" ? { cityMap: site.buildScanCityMap() } : {},
      acc: SCAN.createScanAccumulator({ normalizeKey: normalizeUrl }),
      lastNewAt: Date.now(),
      hasScrolled: false,
      noMoveTicks: 0,
      holdTicks: 0,
      scanTicks: 0,
      lastPageClickAt: 0, // 分页型平台最近一次点击「下一页」的时间戳(防连点)
      pendingReports: 0,
      timers: null,
      wheelFn: null,
    };
    // 初始:已渲染的卡片先采一轮(懒加载的由 MutationObserver 后续喂入)。
    document.querySelectorAll(site.cardSelector).forEach((c) => scanCollect(c));
    // 站点补充采集(智联,ADR-0008):直连搜索 API 拉首屏 20 条外的剩余页,回传
    // meta[] 直喂累积器(按归一 URL 与卡片路径去重)。在途期间抑制 quiet/no-scroll
    // 终止(pendingEnrich);60s 看门狗防 relay 悬挂把扫描卡成永不收尾。
    if (typeof site.fetchRestPages === "function") {
      scan.pendingEnrich = true;
      const enrichWatchdog = trackTimer(
        setTimeout(() => {
          if (scan) scan.pendingEnrich = false;
        }, 60000),
      );
      site.fetchRestPages((metas) => {
        clearTimeout(enrichWatchdog);
        if (!scan) return; // 扫描已被用户/导航收尾,迟到的翻页数据丢弃
        scan.pendingEnrich = false;
        if (!Array.isArray(metas) || !metas.length) return;
        for (const m of metas) {
          const res = scan.acc.add(m);
          if (res.added) scan.lastNewAt = Date.now();
        }
      });
    }
    const scrollT = trackTimer(setInterval(scanTick, SCAN_SCROLL_INTERVAL_MS));
    const batchT = trackTimer(setInterval(() => flushScanBatch(), SCAN_BATCH_INTERVAL_MS));
    const wheelFn = () => {
      if (scan) scan.holdTicks = SCAN_SCROLL_HOLD_TICKS; // 用户接管:短暂让出自动滚动
    };
    window.addEventListener("wheel", wheelFn, { passive: true });
    scan.timers = { scrollT, batchT };
    scan.wheelFn = wheelFn;
    showToast("开始采集职位...", false);
  }

  // ---- message listeners ----------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // 上下文已失效(扩展重载后):丢弃消息,不再调 sendResponse —— 背景端
    // sendMessage 会拿 lastError 并已 catch,静默即可。
    if (invalidated) return;
    if (msg && msg.type === "start-scan") {
      // background 驱动的扩展采集入口(ADR-0007 E2/E5)。scan-pure 缺失(旧版本
      // 缓存)时静默拒绝,不进采集循环。
      if (!SCAN || !site) {
        sendResponse({ ok: false, error: "scan module unavailable" });
        return true;
      }
      if (scan) {
        sendResponse({ ok: true, already: true, scanId: scan.scanId });
        return true;
      }
      if (site.isDetailPath(location.pathname)) {
        sendResponse({ ok: false, error: "需在列表页才能采集" });
        return true;
      }
      startScan(msg.scanId).then(() => {
        sendResponse({ ok: true, scanId: scan ? scan.scanId : null });
      });
      return true;
    }
    if (msg && msg.type === "stop-scan") {
      if (scan) {
        const id = scan.scanId;
        finishScan("stopped");
        sendResponse({ ok: true, scanId: id });
      } else {
        sendResponse({ ok: false, error: "no active scan" });
      }
      return true;
    }
    if (msg && msg.type === "evaluated-updated") {
      // 快速路径:消息能到说明 SW 活着;refreshEvaluated 完成后 map 已新,立即
      // 收尾(toast/confirm + 重置)。轮询兜底仍在 —— finalizeDetail 内部会停。
      // 若 SW 已死,此消息不会到,按钮收尾交给 startEvalPoll 的 3s 轮询。
      refreshEvaluated().then(() => {
        if (detailEvaluating || evalPollUrl) finalizeDetail();
      });
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === "single-eval-error") {
      // Evaluation failed (background routed it back because the popup auto-closes).
      stopEvalPoll();
      settleButtons();
      showToast((msg.error || "评估失败"), true);
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === "quick-updated") {
      refreshQuick();
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === "quick-eval-result") {
      // 快评完成：把分数写进按钮文本 + reason 放 title；同时刷新 quickMap 使详情页
      // 也能立刻显示快评徽章。不覆盖完整评估。
      quickEvaluating = false;
      refreshQuick();
      const qbtn = document.getElementById(DETAIL_QUICK_BTN_ID);
      if (qbtn) {
        qbtn.disabled = false;
        qbtn.textContent = `快评 ${msg.score}/5`;
        qbtn.title = msg.reason ? `快评：${msg.grade} — ${msg.reason}` : `快评：${msg.grade}`;
      }
      const lqbtn = site.ids && document.getElementById(site.ids.listQuickBtn);
      if (lqbtn) {
        lqbtn.disabled = false;
        lqbtn.textContent = `快评 ${msg.score}/5`;
        lqbtn.title = msg.reason ? `快评：${msg.grade} — ${msg.reason}` : `快评：${msg.grade}`;
      }
      showToast(`快评 ${msg.score}/5 · ${msg.grade}`);
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === "quick-eval-error") {
      quickEvaluating = false;
      const qbtn = document.getElementById(DETAIL_QUICK_BTN_ID);
      if (qbtn) {
        qbtn.disabled = false;
        qbtn.textContent = "快评";
      }
      const lqbtn = site.ids && document.getElementById(site.ids.listQuickBtn);
      if (lqbtn) {
        lqbtn.disabled = false;
        lqbtn.textContent = "快评";
      }
      showQuickError(msg.error || "快评不可用：本地 web 服务/接口异常");
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false });
    return;
  });

  // ---- boot ------------------------------------------------------------

  function matchCardParent(node) {
    if (!node || node.nodeType !== 1) return null;
    return node.closest ? node.closest(site.cardSelector) : null;
  }

  function handleAddedNode(node) {
    if (!node || node.nodeType !== 1) return 0;
    let touched = 0;
    const batch = [];
    if (typeof node.matches === "function") {
      if (node.matches(site.cardSelector)) {
        // The added node IS a card.
        batch.push(node);
      } else {
        // Container node (e.g. UL.rec-job-list): process every card inside, but
        // DON'T treat the container itself as a card — that would mark it
        // __careerExt and skip all its real card children.
        if (node.appendChild) batch.push(...node.querySelectorAll(site.cardSelector));
        const parentCard = matchCardParent(node);
        if (parentCard && !batch.includes(parentCard)) batch.push(parentCard);
      }
    }
    for (const c of batch) {
      if (c) {
        if (!c.__careerExt) {
          processCard(c);
          touched++;
        }
        // 采集态:新落到的卡片同样计入扫描(累积器自身去重,幂等)。
        scanCollect(c);
      }
    }
    return touched;
  }

  function init(nextSite) {
    if (inited) return;
    if (!nextSite) {
      // site-*.js 未注入时静默退出（不应发生：manifest 每站 entry 都带 site 文件）。
      return;
    }
    site = nextSite;
    inited = true;
    // scan-pure.js 先行加载;取不到(异常注入顺序)则 scan mode 静默不可用。
    SCAN = (typeof window !== "undefined" && window.__careerScanPure) || null;

    // Diag: snapshot + report DOM state to the background (BOSS blocks DevTools
    // by resizing/kicking the page, so the popup reads this instead). Re-sent on
    // a timer so lazily-scrolled cards refresh the numbers for the popup.
    const __diag = (window.__careerExtDiag = {});
    const snap = () => {
      __diag.evaluatedKeys = Object.keys(evaluated).length;
      __diag.cards = document.querySelectorAll(site.cardSelector).length;
      const first = document.querySelector(site.cardSelector);
      __diag.cardHasLink = !!(first && first.querySelector(site.linkSelector));
      __diag.cardHref = first ? (first.querySelector(site.linkSelector) || {}).href || null : null;
      __diag.pathname = location.pathname;
      __diag.badges = document.querySelectorAll("span[data-career-badge]").length;
      __diag.boxes = document.querySelectorAll("input[type=checkbox][title^=选择]").length;
      // BOSS changed its list markup (pathname=/web/geek/jobs); .job-card-wrapper
      // no longer matches. Snapshot the REAL card container's class chain from the
      // first job_detail anchor so we can fix the site's cardSelector.
      __diag.linkAnchors = document.querySelectorAll(site.linkSelector).length;
      const anchor = document.querySelector(site.linkSelector);
      __diag.anchorClass = anchor ? anchor.className : null;
      __diag.anchorId = anchor ? anchor.id : null;
      // Walk up ~6 ancestors from the first job-name anchor and record the
      // tag.class of each, so we can spot the real card container (old BOSS used
      // .job-card-wrapper; the new /web/geek/jobs list markup differs).
      const chain = [];
      let el = anchor;
      for (let i = 0; i < 6 && el && el.parentElement; i++) {
        el = el.parentElement;
        const cls = el.className ? String(el.className) : "";
        chain.push(`${el.tagName}${cls ? "." + cls.split(/\s+/).join(".").slice(0, 120) : ""}`);
      }
      __diag.ancestorChain = chain;
      // Detail-page diagnosis: does THIS posting exist in the evaluated map, and
      // does the detail badge element actually get injected? (badges/boxes above
      // only count list-card spans/checkboxes, not the detail badge div.)
      __diag.detailUrl = site.isDetailPath(location.pathname) ? location.href : null;
      __diag.detailKey = site.isDetailPath(location.pathname) ? normalizeUrl(location.href) : null;
      __diag.detailHit = __diag.detailKey ? Object.prototype.hasOwnProperty.call(evaluated, __diag.detailKey) : null;
      __diag.detailBadgeEl = !!document.getElementById(DETAIL_BADGE_ID);
      // List-page right pane (BOSS /web/geek/jobs shows the selected job's detail
      // beside the list). Diagnose where the current selection's URL lives and what
      // container holds the description area so we can anchor the inline eval button.
      __diag.activeCardUrl = (() => {
        if (typeof site.currentActiveUrl !== "function") return null;
        return site.currentActiveUrl();
      })();
      // job_detail anchors that are NOT inside a list card — likely the right pane's
      // own title link. Record each with a short ancestor tag.class chain.
      __diag.rightPanes = (() => {
        const out = [];
        document.querySelectorAll(site.linkSelector).forEach((a) => {
          if (a.closest(site.cardSelector)) return;
          let el = a;
          const chain = [];
          for (let i = 0; i < 5 && el && el.parentElement; i++) {
            el = el.parentElement;
            const cls = el.className ? String(el.className).split(/\s+/).join(".") : "";
            chain.push(`${el.tagName}${cls ? "." + cls.slice(0, 100) : ""}`);
          }
          out.push({ href: a.href, chain });
        });
        return out.slice(0, 5);
      })();
      // The user wants the eval button to sit left of the "微信扫码分享" share
      // element in the right pane. Snapshot any element whose own/descendant text
      // mentions 微信/分享/收藏, with ancestors + viewport rect, to anchor it.
      __diag.shareEls = (() => {
        const out = [];
        const seen = new Set();
        document.querySelectorAll("a,button,span,div").forEach((el) => {
          if (seen.has(el)) return;
          const t = (el.textContent || "").replace(/\s+/g, "").slice(0, 40);
          if (!/(微信|扫码|分享|收藏)/.test(t)) return;
          let a = el;
          const chain = [];
          for (let i = 0; i < 4 && a && a.parentElement; i++) {
            a = a.parentElement;
            const cls = a.className ? String(a.className).split(/\s+/).join(".") : "";
            chain.push(`${a.tagName}${cls ? "." + cls.slice(0, 80) : ""}`);
          }
          const r = el.getBoundingClientRect();
          out.push({
            tag: el.tagName,
            cls: el.className ? String(el.className).split(/\s+/).join(".") : "",
            text: t,
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            chain: chain.reverse(),
          });
        });
        return out.slice(0, 6);
      })();
      sendMsg({ type: "diag-report", data: __diag });
    };
    __diag.snap = snap;
    trackTimer(setInterval(snap, 3000)); // keep the popup's debug box live as cards lazy-load

    // Fresh page → drop any selection the previous load left on this tab.
    sendMsg({ type: "selection-update", urls: [] });

    observer = new MutationObserver((records) => {
      let touched = 0;
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          touched += handleAddedNode(node);
        }
      }
      if (touched) syncSelection();
      // The right pane (.job-detail-body) re-renders when the selection changes;
      // re-check it on every mutation batch so the eval button survives the swap.
      if (typeof site.ensureRightPaneButton === "function") site.ensureRightPaneButton();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Even if existing + listen for a first sync of the evaluated map.
    refreshEvaluated().then(() => snap());
    // Also sync the quick-score map so a detail page opened directly still shows
    // a previous list-page quick eval's badge.
    refreshQuick().then(() => snap());
  }

  function start(siteDef) {
    if (document.body) init(siteDef);
    else document.addEventListener("DOMContentLoaded", () => init(siteDef));
  }

  // 站点文件通过此入口启动，并用 core 工具组装右栏按钮。
  window.__careerExtCore = {
    init: start,
    normalizeUrl,
    toast: showToast,
    showQuickError,
    makeButton,
    openReport,
    sendSingleEvaluate,
    sendQuickEval,
    // 通用消息通道(带回调):site 文件可用它向 background 发请求并取回(structured
    // clone 回传),如智联 zp-get-state relay。回调签名 cb(res)。content script 侧
    // chrome.runtime 可用,background 的 executeScript 结果经此取回。
    sendMsg,
    // 评估收尾轮询的登记/清除:site 文件(如 BOSS 列表右栏按钮)发起完整评估时
    // 调用 beginEval(url) 登记,成功后轮询自动收尾;发起失败时 endEval() 释放。
    beginEval: (url) => startEvalPoll(url),
    endEval: () => stopEvalPoll(),
    isQuickEvaluating: () => quickEvaluating,
    setQuickEvaluating: (v) => {
      quickEvaluating = v;
    },
  };
})();

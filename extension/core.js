// 就地评估 — 站点无关核心 content script.
//
// 与原 BOSS 单文件 content.js 的差异：站点相关部分（选择器、JD 提取、右栏
// 面板按钮）移入 site-boss.js / site-liepin.js，通过 site 适配对象注入。
// 本文件只承载站点无关逻辑：归一 URL、徽章/浮窗注入、评估/快评消息、
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
  // detail-panel-pure.js 的纯逻辑层（同样先于本文件加载）：详情页浮窗「显示什么」
  // 的全景判断在那边，core 只做 DOM 胶水。缺失时浮窗静默不提供。
  let PANEL = null;

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
      // 避开右上角的详情页浮窗（top:80/right:20）与右下角的 toast：落到左下角。
      "position:fixed;left:16px;bottom:16px;z-index:2147483647;max-width:420px;" +
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

  // 跳转落点（复用已打开的 web 端 / 新开标签页）由 background 解析（ADR-0055）：
  // 成功时把结果交给 onDone，调用方据此按实际落点写文案；失败仍是同一句 toast。
  // kind 决定落点是评估报告页还是体检报告页（"report" 缺省 / "checkup"），
  // 在弹窗里它是「在 web 端打开」这个次要出口的去处。
  function openReport(num, onDone, kind) {
    sendMsg({ type: "open-report", num, kind }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        showToast(res && res.error ? res.error : "本地报告打不开：本地 web 服务可能未运行", true);
        return;
      }
      if (onDone) onDone(res);
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

  // ---- 详情页浮窗（ADR-0074）-----------------------------------------------
  // 曾经是右侧四个各自 position:fixed 的独立元素（已评估徽章 / 快评徽章 / 评估按钮 /
  // 快评按钮），靠互相测距堆叠，谁出现谁消失。合并成单个浮窗后：
  //   • 「显示什么」（占位符、分色、按钮文案、收起药丸取哪个分）全在 detail-panel-pure.js；
  //   • 本段只做 DOM 胶水 —— 建一次骨架、把视图态涂上去、接拖拽/收起/动作事件。
  // 动作按钮沿用原 id：评估收尾（settleButtons）与快评消息处理器认的就是这两个 id。
  const DETAIL_PANEL_ID = "career-ext-detail-panel";
  const DETAIL_PANEL_CSS_ID = "career-ext-detail-panel-css";
  const DETAIL_EVAL_BTN_ID = "career-ext-eval-btn";
  const DETAIL_QUICK_BTN_ID = "career-ext-quick-btn";

  // 类名一律带 ce- 前缀，且每条规则锁在 #career-ext-detail-panel 之下 —— 招聘站样式表
  // 里躺着 .row / .panel / .btn 这类名字的概率极高，撞上一个就被反向污染。
  // 不用 color-mix()：manifest 的 minimum_chrome_version 是 110，而它要 111+。
  const PANEL_CSS = [
    `#${DETAIL_PANEL_ID}{position:fixed;top:80px;right:20px;z-index:2147483647;width:230px;`,
    "background:rgba(18,22,28,.92);color:#eef2f7;border:1px solid #1d2430;border-radius:14px;",
    "box-shadow:0 12px 34px rgba(0,0,0,.38);backdrop-filter:blur(6px);font-size:13px;user-select:none;",
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}',
    `#${DETAIL_PANEL_ID} *,#${DETAIL_PANEL_ID} *::before,#${DETAIL_PANEL_ID} *::after{box-sizing:border-box;margin:0}`,
    // 标题栏 —— 唯一拖拽热区
    `#${DETAIL_PANEL_ID} .ce-bar{display:flex;align-items:center;gap:8px;padding:9px 10px 9px 12px;`,
    "cursor:grab;border-bottom:1px solid rgba(255,255,255,.08)}",
    `#${DETAIL_PANEL_ID}.ce-collapsed .ce-bar{border-bottom:none}`,
    `#${DETAIL_PANEL_ID} .ce-bar:active{cursor:grabbing}`,
    `#${DETAIL_PANEL_ID} .ce-grip{color:#8a929c;letter-spacing:-2px;font-weight:700}`,
    `#${DETAIL_PANEL_ID} .ce-title{font-weight:600;font-size:12px;letter-spacing:.02em;flex:1;color:#eef2f7}`,
    `#${DETAIL_PANEL_ID} .ce-toggle{appearance:none;-webkit-appearance:none;border:0;width:22px;height:22px;`,
    "background:rgba(255,255,255,.08);color:#eef2f7;border-radius:6px;cursor:pointer;font-size:12px;",
    "line-height:1;display:grid;place-items:center;font-family:inherit}",
    `#${DETAIL_PANEL_ID} .ce-toggle:hover{background:rgba(255,255,255,.16)}`,
    `#${DETAIL_PANEL_ID} .ce-toggle:focus-visible{outline:2px solid #4aa3ff;outline-offset:1px}`,
    // 面板级 Web 端入口（ADR-0078）：规格同 .ce-toggle，但 hover/focus 用蓝色词汇
    // （与行内报告链接同源）——🌐 是彩色 emoji 不吃 currentColor，色彩信号由底色承担。
    `#${DETAIL_PANEL_ID} .ce-web{appearance:none;-webkit-appearance:none;border:0;width:22px;height:22px;`,
    "background:rgba(255,255,255,.08);color:#eef2f7;border-radius:6px;cursor:pointer;font-size:12px;",
    "line-height:1;display:grid;place-items:center;font-family:inherit;padding:0}",
    `#${DETAIL_PANEL_ID} .ce-web:hover{background:rgba(74,163,255,.16)}`,
    `#${DETAIL_PANEL_ID} .ce-web:focus-visible{outline:2px solid #4aa3ff;outline-offset:1px}`,
    // 读数行 —— 签名元素：左侧语义色轨 + 等宽数字；最后一列固定宽，链接藏而不删
    `#${DETAIL_PANEL_ID} .ce-body{padding:6px 12px 12px}`,
    `#${DETAIL_PANEL_ID}.ce-collapsed .ce-body{display:none}`,
    `#${DETAIL_PANEL_ID} .ce-row{display:grid;grid-template-columns:4px 62px 1fr 22px;align-items:center;`,
    "gap:9px;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.05)}",
    `#${DETAIL_PANEL_ID} .ce-row:last-child{border-bottom:none}`,
    `#${DETAIL_PANEL_ID} .ce-rail{width:4px;height:22px;border-radius:2px;background:#8a8f98}`,
    `#${DETAIL_PANEL_ID} .ce-k{color:#8a929c;font-size:12px}`,
    `#${DETAIL_PANEL_ID} .ce-v{font-variant-numeric:tabular-nums;font-weight:600;text-align:right;color:#eef2f7;`,
    "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    `#${DETAIL_PANEL_ID} .ce-v em{font-style:normal;color:#8a929c;font-weight:500}`,
    `#${DETAIL_PANEL_ID} .ce-rpt{color:#8a929c;font-weight:500;font-size:11px;margin-left:6px}`,
    `#${DETAIL_PANEL_ID} .ce-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;`,
    "vertical-align:1px}",
    `#${DETAIL_PANEL_ID} .ce-link{background:none;border:0;color:#4aa3ff;cursor:pointer;font-size:14px;`,
    "padding:2px 4px;border-radius:5px;width:22px;font-family:inherit}",
    `#${DETAIL_PANEL_ID} .ce-link:hover{background:rgba(74,163,255,.16)}`,
    `#${DETAIL_PANEL_ID} .ce-link:focus-visible{outline:2px solid #4aa3ff;outline-offset:1px}`,
    // 动作区
    `#${DETAIL_PANEL_ID} .ce-acts{display:flex;gap:8px;margin-top:12px}`,
    `#${DETAIL_PANEL_ID} .ce-btn{flex:1;border:0;border-radius:9px;padding:9px 8px;font:inherit;`,
    "font-weight:600;font-size:12.5px;cursor:pointer;color:#fff;transition:filter .15s ease}",
    `#${DETAIL_PANEL_ID} .ce-btn:hover{filter:brightness(1.08)}`,
    `#${DETAIL_PANEL_ID} .ce-btn:focus-visible{outline:2px solid #fff;outline-offset:-3px}`,
    `#${DETAIL_PANEL_ID} .ce-btn-eval{background:#00c68d}`,
    `#${DETAIL_PANEL_ID} .ce-btn-quick{background:#7c5cff}`,
    `#${DETAIL_PANEL_ID} .ce-btn[disabled]{opacity:.6;cursor:default;filter:none}`,
    // 收起态药丸
    `#${DETAIL_PANEL_ID} .ce-pill{display:none;align-items:center;gap:8px;padding:10px 12px}`,
    `#${DETAIL_PANEL_ID}.ce-collapsed .ce-pill{display:flex}`,
    `#${DETAIL_PANEL_ID} .ce-pill .ce-score{font-variant-numeric:tabular-nums;font-weight:700;`,
    "margin-left:auto;color:#eef2f7}",
    `#${DETAIL_PANEL_ID} .ce-expand{background:rgba(255,255,255,.1);border:0;color:#eef2f7;border-radius:6px;`,
    "padding:3px 8px;font-size:11px;cursor:pointer;font-family:inherit}",
    `#${DETAIL_PANEL_ID} .ce-expand:hover{background:rgba(255,255,255,.2)}`,
    "@media (prefers-reduced-motion:reduce){", `#${DETAIL_PANEL_ID} *,#${DETAIL_PANEL_ID} *::before,`,
    `#${DETAIL_PANEL_ID} *::after{transition:none!important;animation:none!important}}`,
  ].join("");

  // 骨架一次建好，之后只改 textContent/style，绝不重建节点 —— 换职位时拖拽位置与
  // 展开/收起态要保持不变。四行读数恒定存在，缺值走占位符，行结构不跳动。
  const PANEL_HTML = [
    '<div class="ce-bar">',
    '<span class="ce-grip" title="拖动">⠿</span>',
    '<span class="ce-title">career-ops</span>',
    '<button class="ce-web" type="button" title="在 Web 端打开这份职位报告" aria-label="在 Web 端打开职位报告">🌐</button>',
    '<button class="ce-toggle" type="button" title="收起" aria-label="收起浮窗">–</button>',
    "</div>",
    '<div class="ce-body">',
    '<div class="ce-row"><span class="ce-rail" data-r="eval"></span><span class="ce-k">已评估</span>',
    '<span class="ce-v" data-v="eval"></span>',
    '<button class="ce-link" type="button" data-link="eval" title="打开评估报告">↗</button></div>',
    '<div class="ce-row"><span class="ce-rail" data-r="quick"></span><span class="ce-k">快评</span>',
    '<span class="ce-v" data-v="quick"></span><span></span></div>',
    '<div class="ce-row"><span class="ce-rail" data-r="status"></span><span class="ce-k">状态</span>',
    '<span class="ce-v" data-v="status"></span><span></span></div>',
    '<div class="ce-row"><span class="ce-rail" data-r="checkup"></span><span class="ce-k">体检</span>',
    '<span class="ce-v" data-v="checkup"></span>',
    '<button class="ce-link" type="button" data-link="checkup" title="打开体检报告">↗</button></div>',
    '<div class="ce-acts">',
    `<button class="ce-btn ce-btn-eval" type="button" id="${DETAIL_EVAL_BTN_ID}">评估本职位</button>`,
    `<button class="ce-btn ce-btn-quick" type="button" id="${DETAIL_QUICK_BTN_ID}">快评</button>`,
    "</div></div>",
    '<div class="ce-pill">',
    '<span class="ce-dot" data-pill="dot"></span><span class="ce-k" data-pill="status"></span>',
    '<span class="ce-score" data-pill="score"></span>',
    '<button class="ce-expand" type="button" data-pill="expand">展开</button></div>',
  ].join("");

  let panelEl = null;
  let panelRefs = null;
  let panelCollapsed = false; // 收起态在本标签页内延续（位置不持久化，刷新回默认位）
  let panelSig = null; // 上次渲染的视图指纹，用于跳过无变化的重涂
  let panelReportNum = null; // ↗ 的去处，随当前职位更新

  function injectPanelStyles() {
    if (document.getElementById(DETAIL_PANEL_CSS_ID)) return;
    const s = document.createElement("style");
    s.id = DETAIL_PANEL_CSS_ID;
    s.textContent = PANEL_CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function setPanelCollapsed(c) {
    panelCollapsed = c;
    if (!panelEl) return;
    panelEl.classList.toggle("ce-collapsed", c);
    const t = panelRefs.toggle;
    t.textContent = c ? "+" : "–";
    t.title = c ? "展开" : "收起";
    t.setAttribute("aria-label", c ? "展开浮窗" : "收起浮窗");
  }

  function removeDetailPanel() {
    if (!panelEl) return;
    panelEl.remove();
    panelEl = null;
    panelRefs = null;
    panelSig = null;
    // 浮窗没了，压在上面的阅读弹窗也就没了载体（SPA 从详情页切回列表页时）。
    removeReader();
  }

  /** 完整评估：与旧固定按钮同一套流程（inline JD 直传 + 轮询收尾兜底）。 */
  function onPanelEvalClick() {
    const btn = panelRefs.btnEval;
    if (detailEvaluating || btn.disabled) return;
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
    sendSingleEvaluate(
      location.href,
      (err) => {
        detailEvaluating = false;
        btn.disabled = false;
        stopEvalPoll();
        renderDetailPanel();
        showToast(err, true);
      },
      extra
    );
    // 登记轮询收尾:SW 死亡等消息路径失效时,轮询保证按钮能恢复。
    startEvalPoll(location.href);
  }

  /** 快评：秒出分数，只读（不写 tracker/报告/CV）；分数落在快评行而非按钮上。 */
  function onPanelQuickClick() {
    const btn = panelRefs.btnQuick;
    if (quickEvaluating || btn.disabled) return;
    const { title, text } = site.extractDetailJd();
    if (!text) {
      showToast("快评：未能提取职位描述文本", true);
      return;
    }
    quickEvaluating = true;
    btn.disabled = true;
    btn.textContent = "快评中...";
    sendQuickEval({ url: location.href, title, text, poster: site.extractPosterName() }, (err) => {
      quickEvaluating = false;
      btn.disabled = false;
      btn.textContent = "快评";
      showQuickError(err);
    });
  }

  function buildDetailPanel() {
    injectPanelStyles();
    const el = document.createElement("div");
    el.id = DETAIL_PANEL_ID;
    el.innerHTML = PANEL_HTML;
    document.body.appendChild(el);
    panelEl = el;
    const q = (sel) => el.querySelector(sel);
    panelRefs = {
      bar: q(".ce-bar"),
      toggle: q(".ce-toggle"),
      web: q(".ce-web"),
      btnEval: el.querySelector(`#${DETAIL_EVAL_BTN_ID}`),
      btnQuick: el.querySelector(`#${DETAIL_QUICK_BTN_ID}`),
      rails: { eval: q('[data-r="eval"]'), quick: q('[data-r="quick"]'), status: q('[data-r="status"]'), checkup: q('[data-r="checkup"]') },
      vals: { eval: q('[data-v="eval"]'), quick: q('[data-v="quick"]'), status: q('[data-v="status"]'), checkup: q('[data-v="checkup"]') },
      links: { eval: q('[data-link="eval"]'), checkup: q('[data-link="checkup"]') },
      pill: { dot: q('[data-pill="dot"]'), status: q('[data-pill="status"]'), score: q('[data-pill="score"]'), expand: q('[data-pill="expand"]') },
    };

    // 拖拽：只有标题栏是热区；切成 left/top 定位才能自由移动，位置不写进 storage。
    let drag = null;
    panelRefs.bar.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".ce-toggle, .ce-web")) return; // 按钮不该顺手把面板拖走
      const r = el.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      el.style.right = "auto";
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      panelRefs.bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    panelRefs.bar.addEventListener("pointermove", (e) => {
      if (!drag) return;
      el.style.left = `${e.clientX - drag.dx}px`;
      el.style.top = `${e.clientY - drag.dy}px`;
    });
    const endDrag = () => {
      drag = null;
    };
    panelRefs.bar.addEventListener("pointerup", endDrag);
    panelRefs.bar.addEventListener("pointercancel", endDrag);

    panelRefs.toggle.addEventListener("click", () => setPanelCollapsed(!panelCollapsed));
    // 面板级 Web 端入口（ADR-0078 修订）：行级 ↗ 是页内弹窗阅读，🌐 是切去 web 端
    // 的这份职位报告（/report/{n}，num 来自已评估行，未评估为 null）；无报告号时
    // SW 兜底进 /pipeline 收件箱。目标解析走 open-report 同一条链（复用已开标签页 →
    // 前端路由优先 → 双兜底），这里只管发消息与兜底报错。
    panelRefs.web.addEventListener("click", () => {
      sendMsg({ type: "open-web", num: panelReportNum || null }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          showToast(res && res.error ? res.error : "Web 端打不开：本地 web 服务可能未运行", true);
        }
      });
    });
    panelRefs.pill.expand.addEventListener("click", () => setPanelCollapsed(false));
    panelRefs.btnEval.addEventListener("click", onPanelEvalClick);
    panelRefs.btnQuick.addEventListener("click", onPanelQuickClick);
    // 详情页读报告的主路径：页内弹窗（ADR-0074），不再把用户丢到另一个标签页。
    for (const name of ["eval", "checkup"]) {
      panelRefs.links[name].addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openReader(name === "checkup" ? "checkup" : "report", panelReportNum);
      });
    }
    setPanelCollapsed(panelCollapsed);
  }

  /**
   * 一行的视图态 → DOM。缺值走 <em> 占位符（纯层用 PLACEHOLDER_* 表达缺值），
   * ↗ 用 visibility 而非移除，保证列宽不因为哪一行有值而跳。
   */
  function paintRow(name, row) {
    panelRefs.rails[name].style.background = row.color;
    const v = panelRefs.vals[name];
    v.textContent = "";
    if (row.dot) {
      const d = document.createElement("span");
      d.className = "ce-dot";
      d.style.background = row.color;
      v.appendChild(d);
    }
    const isPlaceholder = !row.text || row.text === PANEL.PLACEHOLDER_STATUS || row.text === PANEL.PLACEHOLDER_DASH;
    if (isPlaceholder) {
      const em = document.createElement("em");
      em.textContent = row.text || PANEL.PLACEHOLDER_DASH;
      v.appendChild(em);
    } else {
      v.appendChild(document.createTextNode(row.text));
    }
    if (row.reportNum) {
      const s = document.createElement("span");
      s.className = "ce-rpt";
      s.textContent = `#${row.reportNum}`;
      v.appendChild(s);
    }
    v.title = row.title || "";
    const link = panelRefs.links[name];
    if (link) {
      link.style.visibility = row.openable ? "visible" : "hidden";
      // 悬停提示落在真正可点的 ↗ 上（而不是只落在读数上），提示与点击目标对齐；
      // 没给 title 的行（已评估）保留骨架里的静态文案，不拿空串把它抹掉。
      if (row.title) link.title = row.title;
    }
  }

  function renderDetailPanel() {
    if (!site || !PANEL) return; // 纯层缺失（异常注入顺序）→ 静默不提供浮窗，同 SCAN 口径
    if (!site.isDetailPath(location.pathname)) {
      removeDetailPanel();
      return;
    }
    const key = normalizeUrl(location.href);
    const view = PANEL.panelView({ entry: evaluated[key] || null, quick: quickMap[key] || null });
    // 同一职位、同一状态不重涂：MutationObserver 在懒加载页上打得很密。
    // panelEl 还要确认仍在 DOM 里：站点 SPA 如果把 body 直接子节点摘掉重装，光判变量
    // 非空会让浮窗永不重建（与 ensureReader 同一个口径）。
    const sig = [
      key,
      view.evalRow.text,
      view.evalRow.reportNum,
      view.quickRow.text,
      view.statusRow.text,
      view.checkupRow.text,
      view.evalBtnLabel,
      detailEvaluating,
      view.pill.scoreText,
    ].join("|");
    if (panelEl && document.body.contains(panelEl) && sig === panelSig) return;
    if (!panelEl || !document.body.contains(panelEl)) buildDetailPanel();
    panelSig = sig;
    panelReportNum = view.evalRow.reportNum;
    paintRow("eval", view.evalRow);
    paintRow("quick", view.quickRow);
    paintRow("status", view.statusRow);
    paintRow("checkup", view.checkupRow);
    if (!detailEvaluating) panelRefs.btnEval.textContent = view.evalBtnLabel;
    panelRefs.pill.dot.style.background = view.pill.dotColor;
    panelRefs.pill.status.textContent = view.pill.statusText;
    panelRefs.pill.score.textContent = view.pill.scoreText;
    panelRefs.pill.score.style.color = view.pill.scoreColor;
  }

  // ---- 页内阅读弹窗（ADR-0074）-----------------------------------------
  //
  // 详情页读报告的主路径：点浮窗行尾 ↗ 就在本页弹出居中 modal，不再把用户丢到另一个
  // 标签页（ADR-0055 的跳转降级为标题栏的「在 web 端打开」次要出口）。
  //   • 评估报告（markdown）→ 纯层 mdToHtml 渲染；正文浅色阅读版式，不跟随 web 端的深色
  //     主题（阅读体验跟这个页面绑定，不跟另一个产品的主题色绑定），右侧目录默认展开。
  //   • 体检报告（自包含 HTML）→ iframe srcdoc + sandbox=""：无脚本、不透明源，第三方
  //     生成的 HTML 只当数据读，绝不进本页 DOM。
  // 正文一律经 background 代取（https 页面 fetch http://localhost 被混合内容规则拦下）。
  // 类名带 cr- 前缀且每条规则锁在 #career-ext-reader 之下 —— 同浮窗的样式隔离纪律。
  const READER_ID = "career-ext-reader";
  const READER_CSS_ID = "career-ext-reader-css";

  const READER_CSS = [
    `#${READER_ID}{position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;`,
    "padding:32px;background:rgba(9,11,15,.62);backdrop-filter:blur(2px);",
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}',
    `#${READER_ID}.cr-open{display:flex}`,
    `#${READER_ID} *,#${READER_ID} *::before,#${READER_ID} *::after{box-sizing:border-box;margin:0}`,
    `#${READER_ID} .cr-modal{width:min(1120px,80vw);height:min(880px,85vh);display:flex;flex-direction:column;`,
    "background:#fff;border-radius:16px;overflow:hidden;border:1px solid rgba(0,0,0,.18);",
    "box-shadow:0 24px 60px rgba(0,0,0,.45)}",
    // 标题栏 —— 唯一保留深色 chrome 的地方
    `#${READER_ID} .cr-bar{display:flex;align-items:center;gap:10px;padding:11px 14px;flex:0 0 auto;`,
    "background:rgba(18,22,28,.97);color:#eef2f7}",
    `#${READER_ID} .cr-kind{font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:999px;`,
    "background:rgba(255,255,255,.12);color:#eef2f7;flex:0 0 auto}",
    `#${READER_ID} .cr-kind-eval{background:rgba(0,198,141,.2);color:#00c68d}`,
    `#${READER_ID} .cr-kind-check{background:rgba(255,203,82,.2);color:#ffcb52}`,
    `#${READER_ID} .cr-title{font-size:13px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
    `#${READER_ID} .cr-rpt{color:#8a929c;font-size:12px;font-variant-numeric:tabular-nums;flex:0 0 auto}`,
    `#${READER_ID} .cr-act{appearance:none;-webkit-appearance:none;border:1px solid rgba(255,255,255,.14);`,
    "background:rgba(255,255,255,.06);color:#eef2f7;border-radius:7px;padding:4px 9px;font-size:11.5px;",
    "cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-family:inherit;flex:0 0 auto}",
    `#${READER_ID} .cr-act:hover{background:rgba(255,255,255,.16)}`,
    `#${READER_ID} .cr-act[hidden]{display:none}`,
    `#${READER_ID} .cr-close{appearance:none;-webkit-appearance:none;border:0;background:rgba(255,255,255,.08);`,
    "color:#eef2f7;width:26px;height:26px;border-radius:7px;cursor:pointer;font-size:16px;line-height:1;",
    "display:grid;place-items:center;font-family:inherit;flex:0 0 auto}",
    `#${READER_ID} .cr-close:hover{background:rgba(255,255,255,.18)}`,
    `#${READER_ID} .cr-act:focus-visible,#${READER_ID} .cr-close:focus-visible,#${READER_ID} .cr-toc-i:focus-visible{`,
    "outline:2px solid #4aa3ff;outline-offset:1px}",
    // 正文区：恒定 flex，iframe / 滚动区才拿得到确定高度
    `#${READER_ID} .cr-body{flex:1 1 auto;display:flex;overflow:hidden;background:#f7f8fa}`,
    `#${READER_ID} .cr-scroll{flex:1 1 auto;overflow:auto;min-width:0}`,
    `#${READER_ID} .cr-body iframe{display:block;width:100%;height:100%;border:0;background:#f7f8fa}`,
    `#${READER_ID} .cr-load,#${READER_ID} .cr-err{flex:1;display:grid;place-items:center;padding:28px;`,
    "color:#6b7280;font-size:13px;text-align:center;line-height:1.6}",
    `#${READER_ID} .cr-err{color:#b42318}`,
    // 右侧目录（默认展开，标题栏一键收起）
    `#${READER_ID} .cr-toc{flex:0 0 220px;overflow:auto;background:#fff;border-left:1px solid #e5e7eb;padding:16px 12px}`,
    `#${READER_ID}.cr-toc-off .cr-toc{display:none}`,
    `#${READER_ID} .cr-toc h4{margin:0 0 10px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280}`,
    `#${READER_ID} .cr-toc-i{display:block;font-size:12.5px;color:#374151;padding:5px 8px;border-radius:6px;`,
    "border-left:2px solid transparent;line-height:1.4;cursor:pointer;background:none;border-top:0;border-right:0;",
    "border-bottom:0;width:100%;text-align:left;font-family:inherit}",
    `#${READER_ID} .cr-toc-i:hover{background:#eef2f7}`,
    `#${READER_ID} .cr-toc-i.cr-l3{padding-left:18px;font-size:12px;color:#6b7280}`,
    `#${READER_ID} .cr-toc-i.cr-active{background:#eaf1ff;color:#2b5fd9;border-left-color:#3370ff;font-weight:600}`,
    // 评估报告阅读版式 —— 浅色，与体检报告的卡片语言对齐
    `#${READER_ID} .cr-md{max-width:880px;margin:0 auto;padding:28px 20px 48px;color:#1f2329;line-height:1.65}`,
    `#${READER_ID} .cr-md h1{font-size:23px;margin:0 0 10px;padding-bottom:12px;border-bottom:2px solid #3370ff}`,
    `#${READER_ID} .cr-md h2{font-size:17px;margin:26px 0 10px;border-left:4px solid #3370ff;padding-left:10px;scroll-margin-top:12px}`,
    `#${READER_ID} .cr-md h3{font-size:15px;margin:18px 0 8px;color:#374151;scroll-margin-top:12px}`,
    `#${READER_ID} .cr-md h4{font-size:14px;margin:14px 0 6px;color:#4b525b}`,
    `#${READER_ID} .cr-md p{font-size:14px;margin:8px 0;color:#374151}`,
    `#${READER_ID} .cr-md ul,#${READER_ID} .cr-md ol{margin:8px 0 8px 22px;padding:0}`,
    `#${READER_ID} .cr-md li{font-size:14px;margin:4px 0;color:#374151}`,
    `#${READER_ID} .cr-md hr{border:0;border-top:1px solid #e5e7eb;margin:22px 0}`,
    `#${READER_ID} .cr-md a{color:#3370ff;text-decoration:none;border-bottom:1px solid rgba(51,112,255,.3)}`,
    `#${READER_ID} .cr-md code{background:#eef0f3;border-radius:4px;padding:1px 5px;font-size:12.5px;`,
    "font-family:ui-monospace,Consolas,monospace;color:#b3261e}",
    `#${READER_ID} .cr-md pre{background:#1f2329;color:#e6e9ef;border-radius:10px;padding:14px 16px;overflow:auto;`,
    "font-size:12.5px;line-height:1.55}",
    `#${READER_ID} .cr-md pre code{background:none;color:inherit;padding:0}`,
    `#${READER_ID} .cr-md details{margin:10px 0}`,
    `#${READER_ID} .cr-md summary{cursor:pointer;font-size:12.5px;color:#6b7280;user-select:text}`,
    `#${READER_ID} .cr-md details[open]>summary{margin-bottom:8px}`,
    `#${READER_ID} .cr-md table{width:100%;border-collapse:collapse;margin:12px 0;background:#fff;font-size:13.5px;`,
    "border:1px solid #e5e7eb;border-radius:8px;overflow:hidden}",
    `#${READER_ID} .cr-md th{background:#eef2f7;text-align:left;font-weight:600;color:#374151;width:34%}`,
    `#${READER_ID} .cr-md th,#${READER_ID} .cr-md td{padding:9px 12px;border-bottom:1px solid #eef0f3;vertical-align:top}`,
    `#${READER_ID} .cr-md tr:last-child td{border-bottom:0}`,
    `#${READER_ID} .cr-md blockquote{margin:10px 0;padding:8px 14px;background:#fff8e6;border-left:4px solid #f0a020;`,
    "border-radius:0 8px 8px 0;font-size:14px;color:#5c4a1e}",
    // 报告头部元信息网格
    `#${READER_ID} .cr-kvs{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:6px 18px;`,
    "background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px 18px;margin:0 0 18px}",
    `#${READER_ID} .cr-kv{display:flex;gap:8px;font-size:13px;line-height:1.6}`,
    `#${READER_ID} .cr-kv b{color:#6b7280;font-weight:600;flex:0 0 auto}`,
    `#${READER_ID} .cr-kv span{color:#1f2329;word-break:break-all}`,
    "@media (prefers-reduced-motion:reduce){", `#${READER_ID} *,#${READER_ID} *::before,`,
    `#${READER_ID} *::after{transition:none!important;animation:none!important}}`,
  ].join("");

  // 弹窗只建一次、常驻 DOM（靠 display 开关）：重建会把已取回的正文再 fetch 一遍，
  // 也抹不掉用户的展开/收起轨迹。
  const READER_HTML = [
    '<div class="cr-modal" role="dialog" aria-modal="true">',
    '<div class="cr-bar">',
    '<span class="cr-kind" data-r="kind"></span>',
    '<span class="cr-title" data-r="title"></span>',
    '<span class="cr-rpt" data-r="rpt"></span>',
    '<button class="cr-act" type="button" data-r="toc" hidden>☰ 目录</button>',
    '<button class="cr-act" type="button" data-r="web" title="在本地 web 端打开">↗ 在 web 端打开</button>',
    '<button class="cr-close" type="button" data-r="close" aria-label="关闭报告弹窗">×</button>',
    "</div>",
    '<div class="cr-body" data-r="body"></div>',
    "</div>",
  ].join("");

  let readerEl = null;
  let readerRefs = null;
  let readerOpen = false;
  let readerKind = null; // "report" | "checkup"
  let readerNum = null;
  let readerLastTrigger = null;
  let readerPrevOverflow = ""; // 打开前的 body.style.overflow，关闭时原样归还
  let readerReqSeq = 0; // 只认最后一次请求：连点两个 ↗ 时，旧响应不能盖新正文
  let readerKeyWired = false;

  function ensureReader() {
    if (readerEl && document.body.contains(readerEl)) return;
    if (!document.getElementById(READER_CSS_ID)) {
      const s = document.createElement("style");
      s.id = READER_CSS_ID;
      s.textContent = READER_CSS;
      (document.head || document.documentElement).appendChild(s);
    }
    const el = document.createElement("div");
    el.id = READER_ID;
    el.innerHTML = READER_HTML;
    document.body.appendChild(el);
    readerEl = el;
    const q = (sel) => el.querySelector(sel);
    readerRefs = {
      modal: q(".cr-modal"),
      kind: q('[data-r="kind"]'),
      title: q('[data-r="title"]'),
      rpt: q('[data-r="rpt"]'),
      tocBtn: q('[data-r="toc"]'),
      webBtn: q('[data-r="web"]'),
      closeBtn: q('[data-r="close"]'),
      body: q('[data-r="body"]'),
    };
    readerRefs.closeBtn.addEventListener("click", closeReader);
    readerRefs.tocBtn.addEventListener("click", () => el.classList.toggle("cr-toc-off"));
    // 次要出口：弹窗是主阅读路径，但回 web 端看完整页（那里有导航与操作区）仍保留。
    readerRefs.webBtn.addEventListener("click", () => openReport(readerNum, null, readerKind));
    // 点遮罩本身（不是 modal）也算关 —— 但只有落在遮罩自身体才关，不抢正文里的点击。
    el.addEventListener("click", (e) => {
      if (e.target === el) closeReader();
    });
    if (!readerKeyWired) {
      // 挂在 document 而不是弹窗上：弹窗内只有一个按钮时 Tab 很容易跑到遮罩后面，
      // 那里根本没焦点、弹窗自己的监听器也听不到。
      document.addEventListener("keydown", readerKeydown, true);
      readerKeyWired = true;
    }
  }

  function readerKeydown(e) {
    if (!readerOpen) return;
    if (e.key === "Escape") {
      closeReader();
      return;
    }
    if (e.key !== "Tab") return;
    const f = readerRefs.modal.querySelectorAll(`button:not([hidden]),.cr-toc-i,a`);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (!readerEl.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
    // 已知局限：sandboxed iframe 内是嵌套浏览上下文，本页的监听器看不到它内部的焦点，
    // Tab 从 iframe 里出来时会落到弹窗外 —— 浏览器标准行为（无脚本沙箱无法反向接管
    // 焦点），不在正式代码里绕。
  }

  function openReader(kind, num) {
    if (!PANEL || !num) return; // 纯层缺失 → 不渲染（宁可不读，也不把未转义的报告灌进页面）
    const nextKind = kind === "checkup" ? "checkup" : "report";
    const nextNum = String(num);
    // 重入守卫：同一份报告重复点开（评估收尾自动弹 + 用户手点 ↗ 会撞上）直接返回 ——
    // 不短路的话下面会把“已是 hidden 的 overflow”当成打开前的原值抢下来，关掉弹窗后
    // 页面再也滚不动，焦点归还也会落到弹窗自己内部的节点上。
    if (readerOpen && readerKind === nextKind && readerNum === nextNum) return;
    // 换读另一份：先按正确顺序归还 overflow / 焦点 / 在途请求，再重新打开。
    if (readerOpen) closeReader();
    ensureReader();
    readerKind = nextKind;
    readerNum = nextNum;
    readerLastTrigger = document.activeElement;
    readerEl.classList.remove("cr-toc-off");
    readerRefs.kind.textContent = readerKind === "checkup" ? "公司体检" : "评估报告";
    readerRefs.kind.className = "cr-kind " + (readerKind === "checkup" ? "cr-kind-check" : "cr-kind-eval");
    readerRefs.title.textContent = "…加载中";
    readerRefs.rpt.textContent = `#${readerNum}`;
    readerRefs.tocBtn.hidden = readerKind !== "report";
    readerRefs.body.innerHTML = '<div class="cr-load">加载中…</div>';
    readerEl.classList.add("cr-open");
    readerOpen = true;
    // 遮罩期间锁背景滚动；归还时写回原来的 inline 值而不是直接清空 —— 站点可能本来就设了。
    readerPrevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    readerRefs.closeBtn.focus();
    const seq = ++readerReqSeq;
    sendMsg({ type: "fetch-report-content", num: readerNum, kind: readerKind }, (res) => {
      if (seq !== readerReqSeq) return; // 已关 / 已在读另一份 —— 这一份到手也没用了
      if (chrome.runtime.lastError || !res || !res.ok) {
        readerRefs.title.textContent = "…加载失败";
        readerRefs.body.innerHTML = "";
        const err = document.createElement("div");
        err.className = "cr-err";
        // 文案口径在纯层：页面没重载扩展时，跑着的还是旧 service worker，它会把这条
        // 消息当成未知类型回一句英文黑话 —— readerErrorText 把它翻成「去重载扩展」。
        err.textContent = PANEL.readerErrorText(res, "本地报告打不开：本地 web 服务可能未运行");
        readerRefs.body.appendChild(err);
        return;
      }
      renderReaderBody(readerKind, res.text || "");
    });
  }

  function renderReaderBody(kind, text) {
    const scroll = document.createElement("div");
    scroll.className = "cr-scroll";
    readerRefs.body.innerHTML = "";

    if (kind === "checkup") {
      // 体检报告是台账里那份自包含 HTML：无脚本、不透明源，只当数据读。
      const t = (/<title>([^<]*)<\/title>/.exec(text) || [])[1] || "公司体检报告";
      readerRefs.title.textContent = t.trim();
      const f = document.createElement("iframe");
      f.setAttribute("sandbox", "");
      f.setAttribute("title", t.trim());
      f.srcdoc = text;
      scroll.appendChild(f);
      readerRefs.body.appendChild(scroll);
      return;
    }

    const h1 = /^#\s+(.*)$/m.exec(text);
    readerRefs.title.textContent = (h1 ? h1[1].replace(/^Evaluation:\s*/, "").trim() : "") || "评估报告";
    const rendered = PANEL.mdToHtml(text);
    const box = document.createElement("div");
    box.className = "cr-md";
    // 安全前提在纯层：mdToHtml 先整体转义再上标记，报告里任何 HTML 都只当文字。
    box.innerHTML = rendered.html;
    scroll.appendChild(box);
    readerRefs.body.appendChild(scroll);

    if (!rendered.toc.length) {
      readerRefs.tocBtn.hidden = true; // 这份报告没 h2/h3，目录开关也就没意义
      return;
    }
    const aside = document.createElement("aside");
    aside.className = "cr-toc";
    const h4 = document.createElement("h4");
    h4.textContent = "目录";
    aside.appendChild(h4);
    for (const t of rendered.toc) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "cr-toc-i" + (t.level === 3 ? " cr-l3" : "");
      b.textContent = t.text; // 纯文本走 textContent，不再走一次 innerHTML
      b.dataset.t = t.id;
      b.addEventListener("click", () => {
        const target = box.querySelector(`#${CSS.escape(t.id)}`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      aside.appendChild(b);
    }
    readerRefs.body.appendChild(aside);

    // 滚动时高亮当前节：抽成函数，渲染完先跑一次（否则刚打开时目录无一高亮）。
    const markActiveToc = () => {
      const hs = box.querySelectorAll("h2,h3");
      let act = null;
      for (const h of hs) {
        if (h.getBoundingClientRect().top <= 140) act = h;
        else break;
      }
      for (const b of aside.querySelectorAll(".cr-toc-i")) {
        b.classList.toggle("cr-active", !!act && b.dataset.t === act.id);
      }
    };
    scroll.addEventListener("scroll", markActiveToc, { passive: true });
    markActiveToc();
  }

  function closeReader() {
    if (!readerEl || !readerOpen) return;
    readerEl.classList.remove("cr-open");
    readerOpen = false;
    readerReqSeq++; // 在途响应到此作废
    document.body.style.overflow = readerPrevOverflow || "";
    // 立刻放掉正文（尤其是 iframe）：体检 HTML 的文档上下文不该在关掉后还挂着。
    readerRefs.body.innerHTML = "";
    if (readerLastTrigger && document.body.contains(readerLastTrigger)) readerLastTrigger.focus();
    readerLastTrigger = null;
  }

  /** 离开详情页（SPA 导航到列表）时连同弹窗一起摘掉，不留一个压在列表页上的遮罩。 */
  function removeReader() {
    if (!readerEl) return;
    closeReader();
    readerEl.remove();
    readerEl = null;
    readerRefs = null;
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

  // 统一重置所有评估动作(浮窗内的评估按钮 + BOSS 列表右栏按钮)。幂等:浮窗
  // 不在 DOM 时(如 SPA 导航后)无操作,评估中的按钮恢复可点 —— 文案交给
  // panelView,已评估过的职位恢复后显示「重新评估」而不是硬写回「评估本职位」。
  function settleButtons() {
    detailEvaluating = false;
    if (panelRefs) {
      panelRefs.btnEval.disabled = false;
      renderDetailPanel();
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
      // 评估完成自动打开报告（用户确认过的手势：单职位评估结束后直接看报告，
      // 不再弹 confirm 让用户多点一次；confirm 在后台标签页还可能被浏览器拦截）。
      // 详情页浮窗在场 → 就地开页内阅读弹窗（主路径，ADR-0074）；列表页没有浮窗
      // 载体 → 仍按 ADR-0055 跳转，文案按实际落点写（复用 web 端 / 新开标签页）。
      const onDetailPage = !!(site && site.isDetailPath) && site.isDetailPath(location.pathname);
      setTimeout(() => {
        if (onDetailPage && PANEL) {
          openReader("report", entry.reportNum);
          showToast(`已评估 ${entry.score || ""}，报告 #${entry.reportNum}`.trim());
          return;
        }
        openReport(
          entry.reportNum,
          (res) => {
            const where = res.mode === "created" ? "已在新标签页打开" : "已在本地 web 端打开";
            showToast(`已评估 ${entry.score || ""}，报告 #${entry.reportNum}，${where}`.trim());
          },
          "report"
        );
      }, 400);
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
    // 详情页浮窗：四行读数 + 两个动作，取代过去的四个独立固定元素。
    renderDetailPanel();
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

  // 分页型平台(猎聘)翻页驱动(ADR-0070)：点击「下一页」不再靠固定最小间隔 + 900ms tick
  // 边界门控(那种精确周期最易触发站点异常行为检测)。改为调度式细抖——每次点击后用独立
  // setTimeout 排下一次，间隔从 scan-pure 的 pickPagingGap 在 [1300,2700]ms 均匀随机取，
  // 点击时刻与 tick 解耦。tick 只保留翻页后全量重扫 + 到末页静默收尾的簿记。任一终态即
  // 停 —— 满上限/跳详情页(doPageClick 主动查 + scanTick 每 tick 兜底查) / 无下一页控件后
  // 连续静默(末页数据已采完，交给 tick 收尾并停链)。
  // pickPagingGap 缺失(旧缓存)时的回退间隔：与 scan-pure 的区间下限同源，不另立魔数；
  // scan-pure 也未加载(异常注入顺序)时用同值兜底。
  const SCAN_PAGING_MIN_GAP_MS = (SCAN && SCAN.SCAN_PAGING_GAP_MIN_MS) || 1300;

  /** 排一次「下一页」点击：清掉在途定时器，用受管 setTimeout 在 delayMs 后触发 doPageClick。
   *  句柄同时挂 scan(收尾精确清)与 trackTimer(实例销毁兜底清)，同 scrollT/batchT 口径。 */
  function scheduleNextPageClick(delayMs) {
    if (!scan) return;
    if (scan.nextPageTimer) clearTimeout(scan.nextPageTimer);
    const delay = Number(delayMs) > 0 ? Number(delayMs) : SCAN_PAGING_MIN_GAP_MS;
    scan.nextPageTimer = trackTimer(setTimeout(doPageClick, delay));
  }

  /** 点一次「下一页」→ 记录点击态 → 无论成功或瞬态失败都重排下一次(到末页真正交由 tick
   *  的静默判定 finishScan)。满上限/跳详情页即刻停排并收尾，杜绝停不下来的孤儿定时器。 */
  function doPageClick() {
    if (!scan) return;
    scan.nextPageTimer = null;
    if (site.isDetailPath(location.pathname)) {
      finishScan("navigated");
      return;
    }
    if (scan.acc.reachedMax) {
      finishScan("max");
      return;
    }
    const nextBtn = site.findNextPageBtn ? site.findNextPageBtn() : null;
    const disabled = !!nextBtn && (nextBtn.disabled || (nextBtn.getAttribute && nextBtn.getAttribute("aria-disabled") === "true"));
    if (nextBtn && !disabled) {
      try {
        nextBtn.click();
        scan.lastPageClickAt = Date.now();
        // 点击后页面原生加载/重渲染，期间「无新卡」正常 —— 拉回静默起点，避免旧页末卡
        // 时间戳被误判为「已静默 8s」提前收尾漏采下一页。新页卡采入后继续刷新 lastNewAt。
        scan.lastNewAt = Date.now();
        scan.pendingRescan = true; // 让下一 tick 主动全扫新页卡片，双保险兜 observer 漏采
        scan.lastClickUrl = location.href;
      } catch {
        /* 点击瞬间元素失效(页面重渲染)，交给下一次重排重试 */
      }
    }
    // 控件缺失/禁用(瞬态或末页)也继续重排；真到末页时 tick 的静默判定会 finishScan 停链。
    scheduleNextPageClick(SCAN.pickPagingGap ? SCAN.pickPagingGap() : SCAN_PAGING_MIN_GAP_MS);
  }

  /** tick 内分页簿记(点击不在此发生，由 scheduleNextPageClick 调度)：翻页后 URL 已切到
   *  新页才主动全量重扫(兜 observer 漏采)；到末页(无下一页控件/禁用)且静默超阈值即收尾。 */
  function pagingAwareStep() {
    if (!scan) return;
    // 用户滚轮接管期语义保留(翻页页无滚动，实际不影响，仅防重复 handler)。
    if (scan.holdTicks > 0) {
      scan.holdTicks -= 1;
      return;
    }
    // 翻页后主动全量重扫当前页卡片(不依赖 MutationObserver 捕获)。猎聘 SPA 翻页复用卡片
    // 节点/列表容器时 childList 只报增删，textContent 替换或同层节点复用会被 observer 漏掉
    // → 漏采整页。URL 去重保证重扫幂等，首次进累积器才计新卡。仅在 URL 已切到新页(与点击
    // 时不同)才消费 pendingRescan —— 翻页未完成(还停旧页)时不浪费全扫，留待下一 tick。
    if (scan.pendingRescan && location.href !== scan.lastClickUrl) {
      scan.pendingRescan = false;
      document.querySelectorAll(site.cardSelector).forEach((c) => scanCollect(c));
    }
    const nextBtn = site.findNextPageBtn ? site.findNextPageBtn() : null;
    const gone = !nextBtn || nextBtn.disabled || (nextBtn.getAttribute && nextBtn.getAttribute("aria-disabled") === "true");
    // 无下一页控件/禁用 = 已到末页：点击链会持续重排空点(无害)，由静默超阈值收尾停链。
    if (gone && Date.now() - scan.lastNewAt > SCAN_QUIET_MS) finishScan("paged");
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
    // 分页型平台的调度点击定时器随扫描实例收尾一并清除(ADR-0070 停点纪律)。
    if (s.nextPageTimer) {
      clearTimeout(s.nextPageTimer);
      s.nextPageTimer = null;
    }
    if (s.wheelFn) window.removeEventListener("wheel", s.wheelFn, { passive: true });
    const count = s.acc.count;
    scan = null;
    sendMsg({ type: "scan-done", scanId: s.scanId, count, reason });
    showToast(`采集结束：${count} 条新职位`, false);
  }

  /** 开始一轮采集(scanId 为空时生成一次会话 id)。智联需先经 ensureZpState 刷新
   *  data-zpstate url 缓存(isolated world 读不到页面 state),其它站无此钩子直接开跑。 */
  async function startScan(rawScanId, maxCount) {
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
      // maxCount 覆盖硬编码 SCAN_MAX:分页型平台(猎聘)大关键词 >400 条时不被截末页。
      // 未传(旧版本/手动扫)回落 scan-pure 默认。
      acc: SCAN.createScanAccumulator({ normalizeKey: normalizeUrl, maxCount }),
      lastNewAt: Date.now(),
      pendingRescan: false, // 首屏由下方初始 forEach 采;翻页后才置 true 主动重扫
      lastClickUrl: "",
      hasScrolled: false,
      noMoveTicks: 0,
      holdTicks: 0,
      scanTicks: 0,
      lastPageClickAt: 0, // 分页型平台最近一次点击「下一页」的时间戳(防连点)
      nextPageTimer: null, // 分页型平台调度式细抖的「下一页」点击定时器句柄(ADR-0070)
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
    // 分页型平台(猎聘)：点击与 tick 解耦，首点排一个随机间隔做并发错峰(ADR-0070)。
    if (site.isPageMode === true) {
      scheduleNextPageClick(SCAN.pickPagingGap ? SCAN.pickPagingGap() : SCAN_PAGING_MIN_GAP_MS);
    }
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
      startScan(msg.scanId, typeof msg.maxCount === "number" && msg.maxCount > 0 ? msg.maxCount : undefined).then(() => {
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
    if (msg && msg.type === "scan-ping") {
      // 存活探测(ADR-0007 E10):背景端借探索页 2s 一次的轮询顺手问"这页还在采吗"。
      // 只答本实例的真实状态 —— 反爬把 tab 整页跳到验证页后,站点会重新注入一个新
      // content script(或干脆没有),它的 scan 是 null,如实答否,后台据此把该驱动
      // 按结束处理(摘登记 + 收尾),而不是让用户停在验证页上。
      sendResponse({ ok: true, active: !!scan, scanId: scan ? scan.scanId : null });
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
      // 浮窗里的快评按钮只负责触发，分数落在「快评」行上（refreshQuick 回来后
      // 由 renderDetailPanel 涂）；这里只把按钮解锁回默认文案。
      const qbtn = document.getElementById(DETAIL_QUICK_BTN_ID);
      if (qbtn) {
        qbtn.disabled = false;
        qbtn.textContent = "快评";
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
    // detail-panel-pure.js 同理：拿不到就不提供浮窗（而不是退回旧的四个固定元素，
    // 两套 UI 同时存在比没有 UI 更难解释）。
    PANEL = (typeof window !== "undefined" && window.__careerOpsDetailPanelPure) || null;

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
      // does the detail panel actually get injected? (badges/boxes above only count
      // list-card spans/checkboxes, not the panel.)
      __diag.detailUrl = site.isDetailPath(location.pathname) ? location.href : null;
      __diag.detailKey = site.isDetailPath(location.pathname) ? normalizeUrl(location.href) : null;
      __diag.detailHit = __diag.detailKey ? Object.prototype.hasOwnProperty.call(evaluated, __diag.detailKey) : null;
      __diag.detailPanelEl = !!document.getElementById(DETAIL_PANEL_ID);
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

    // 浮窗先常驻建起来（不依赖本地 web 服务地图拉回）：服务未起时用户仍看得到
    // 入口，点了会得到「本地 web 服务未运行」的 toast，而不是整块 UI 消失。
    renderDetailPanel();

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
      // SPA 换职位 / 离开详情页时浮窗跟着当前 URL 走。视图指纹没变时直接返回，
      // 所以这一行在懒加载页的密集变更里也便宜。
      renderDetailPanel();
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

// BOSS直聘 就地评估 — content script.
//
// Runs on every *.zhipin.com page. Injections:
//   • list cards: a "已评估 N.N" badge (score) + an evaluation checkbox;
//   • detail page: a single "评估本职位" button;
//   • MutationObserver follows BOSS' SPA re-renders so lazily-loaded cards get
//     badges too.
// All cross-origin work (evaluated map, batch evaluate, report open) is proxied
// through the background service worker — this script only ever talks to it via
// chrome.runtime.* messages and never fetches localhost itself.

// The evaluated map lives in the background; this mirrors it locally on refresh.
let evaluated = {}; // normalizedUrl → { score, reportNum }
let quickMap = {}; // normalizedUrl → { score, grade, reason } (快评持久化徽章)
let inited = false;

// Canonical posting-URL key — mirrors web/src/lib/core/url-key.mjs `normalizeUrl`
// (the same key that /api/report-status uses) so a badge matches an evaluation.
const TRACKING_PARAMS = [
  /^utm_/i, /^gh_src$/i, /^fbclid$/i, /^gclid$/i,
  /^mc_cid$/i, /^mc_eid$/i, /^igshid$/i, /^_hsenc$/i, /^_hsmi$/i, /^trk$/i, /^trackingid$/i,
  // BOSS直聘 board-specific: securityId is the anti-bot session token and ka is
  // a click-source param — both vary per-request, never identify the posting.
  // A listing's detail URL carries ?securityId=...&ka=... while the list card
  // link doesn't, so stripping keeps both views on the same dedup key.
  /^securityId$/i, /^ka$/i,
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
  const keep = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!TRACKING_PARAMS.some((re) => re.test(k))) keep.push([k, v]);
  }
  keep.sort((x, y) => (x[0] !== y[0] ? (x[0] < y[0] ? -1 : 1) : (x[1] < y[1] ? -1 : x[1] > y[1] ? 1 : 0)));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

// ---- DOM helpers ----------------------------------------------------------

// BOSS /web/geek/jobs list card container. The job-name anchor sits in
// DIV.job-title > DIV.job-info > LI.job-card-box (older .job-card-wrapper is
// gone after BOSS' list revamp). One LI per posting.
const CARD_SELECTOR = "li.job-card-box";
const LINK_SELECTOR = 'a[href*="/job_detail/"]';

function cardIsList(card) {
  return !location.pathname.includes("/job_detail/") && !!card.querySelector(LINK_SELECTOR);
}

/** Absolute posting URL for a list card (from its detail anchor). */
function cardUrl(card) {
  const a = card.querySelector(LINK_SELECTOR);
  if (!a) return null;
  const href = a.href || a.getAttribute("href");
  return href && /^https?:\/\//i.test(href) ? href : null;
}

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

function openReport(num) {
  chrome.runtime.sendMessage({ type: "open-report", num }, (res) => {
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

function scoreColor(scoreStr) {
  const n = parseFloat(scoreStr);
  if (Number.isFinite(n)) {
    if (n >= 4) return "#00c68d";
    if (n >= 3) return "#f5a623";
    return "#d93026";
  }
  return "#8a8f98";
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

// ---- detail page button ---------------------------------------------------

let detailInjected = false;
let detailEvaluating = false;
let quickEvaluating = false;

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

function injectDetailButton() {
  if (detailInjected) return;
  detailInjected = true;
  const btn = document.createElement("button");
  btn.textContent = "评估本职位";
  btn.style.cssText =
    "position:fixed;right:20px;top:80px;z-index:2147483647;" +
    "padding:10px 16px;border:none;border-radius:8px;cursor:pointer;" +
    "background:#00c68d;color:#fff;font-size:14px;font-weight:600;" +
    "font-family:system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);";
  btn.id = "career-ext-eval-btn";
  btn.addEventListener("click", () => {
    if (detailEvaluating) return;
    detailEvaluating = true;
    btn.disabled = true;
    btn.textContent = "评估中...";
    chrome.runtime.sendMessage({ type: "single-evaluate", url: location.href }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        detailEvaluating = false;
        btn.disabled = false;
        btn.textContent = "评估本职位";
        showToast((res && res.error) || "评估发起失败：本地 web 服务未运行?", true);
      }
    });
  });
  document.body.appendChild(btn);

  // 「快评」— 独立按钮，秒出分数徽章，只读（不写 tracker/报告/CV）。
  const qbtn = document.createElement("button");
  qbtn.textContent = "快评";
  qbtn.style.cssText =
    "position:fixed;right:20px;top:80px;z-index:2147483647;" +
    "padding:10px 16px;border:none;border-radius:8px;cursor:pointer;" +
    "background:#7c5cff;color:#fff;font-size:14px;font-weight:600;" +
    "font-family:system-ui,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.3);";
  qbtn.id = "career-ext-quick-btn";
  qbtn.addEventListener("click", () => {
    if (quickEvaluating || qbtn.disabled) return;
    const { title, text } = extractDetailJd();
    if (!text) {
      showToast("快评：未能提取职位描述文本", true);
      return;
    }
    quickEvaluating = true;
    qbtn.disabled = true;
    qbtn.textContent = "快评中...";
    chrome.runtime.sendMessage({ type: "quick-evaluate", url: location.href, title, text }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        quickEvaluating = false;
        qbtn.disabled = false;
        qbtn.textContent = "快评";
        showQuickError((res && res.error) || "快评发起失败：本地 web 服务未运行?");
      }
    });
  });
  document.body.appendChild(qbtn);
  updateButtonPosition();
}

// Keep the eval + quick buttons vertically stacked under the detail badge; when
// no badge is present they sit in the badge's own spot (top:80px). Re-measured
// whenever the badge appears/disappears so an evaluation repositions them.
function updateButtonPosition() {
  const btn = document.getElementById("career-ext-eval-btn");
  const qbtn = document.getElementById("career-ext-quick-btn");
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

// Detail-page badge: shows the evaluation score for an already-evaluated
// posting high up the page (fixed, so it survives BOSS' layout shifts), and
// opens the report on click. Kept in sync with the evaluated map via
// refreshDetailBadge() on every applyAllInjections pass.
const DETAIL_BADGE_ID = "career-ext-detail-badge";

// Detail-page quick badge: shows the quick-eval score (purple pill, standalone
// from the full-eval badge) once a quick eval has been run for the current URL —
// even if that quick eval happened on the list page before navigation. Backed by
// the background's quickScores map (chrome.storage.local), so it survives reload.
const DETAIL_QUICK_BADGE_ID = "career-ext-detail-quick-badge";

function refreshQuickDetailBadge() {
  if (!location.pathname.includes("/job_detail/")) return;
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
    chrome.runtime.sendMessage({ type: "get-quick" }, (res) => {
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
  if (!location.pathname.includes("/job_detail/")) return;
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

// Reset the detail button once the evaluated map comes back fresh.
function finalizeDetail() {
  detailEvaluating = false;
  const btn = document.getElementById("career-ext-eval-btn");
  if (btn) {
    btn.disabled = false;
    btn.textContent = "评估本职位";
  }
  const entry = evaluated[normalizeUrl(location.href)];
  if (entry) {
    showToast(`已评估 ${entry.score || ""}，报告 #${entry.reportNum}`.trim());
    setTimeout(() => {
      if (confirm(`评估完成，打开报告 #${entry.reportNum}？`)) openReport(entry.reportNum);
    }, 400);
  }
}

// ---- selection sync (list cards) ------------------------------------------

const selectedKeys = new Set();

function syncSelection() {
  const urls = [];
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    if (!cardIsList(card)) return;
    const key = normalizeUrl(cardUrl(card) || "");
    if (key && selectedKeys.has(key)) {
      const u = cardUrl(card);
      if (u) urls.push(u);
    }
  });
  chrome.runtime.sendMessage({ type: "selection-update", urls });
}

// ---- evaluated map (background-backed) ------------------------------------

function refreshEvaluated() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "get-evaluated" }, (res) => {
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

let resolvedOnce = false;

// ---- per-card injection -----------------------------------------------

function processCard(card) {
  if (card.__careerExt) return;
  card.__careerExt = true;

  if (cardIsList(card)) {
    const url = cardUrl(card);
    const key = url ? normalizeUrl(url) : "";
    if (!key) return;
    // Batch-evaluation checkboxes are disabled for now (feature dormant);
    // keep only the evaluated badge on list cards. Skeleton (injectCheckbox /
    // selectedKeys / syncSelection) stays for reinstating batch eval later.
    const entry = evaluated[key];
    if (entry) injectBadge(card, entry);
  }
}

// List page "评估本职位" button — pinned to the right-hand detail pane (BOSS
// /web/geek/jobs renders the selected job's description beside the list in a
// .job-detail-body panel). Clicking it evaluates the currently-selected card
// (the .active one), reusing the same engine as the detail-page button.
const LIST_EVAL_BTN_ID = "career-ext-list-eval-btn";

function currentActiveUrl() {
  const ac = document.querySelector(`${CARD_SELECTOR}.active`) || document.querySelector(".job-card-wrap.active");
  const a = ac && ac.querySelector(LINK_SELECTOR);
  return a && a.href ? a.href : null;
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

function ensureRightPaneButton() {
  if (location.pathname.includes("/job_detail/")) {
    // Detail page — the dedicated full-page button owns this; don't add the pane one.
    const stale = document.getElementById(LIST_EVAL_BTN_ID);
    if (stale) stale.remove();
    return;
  }
  const opBar = document.querySelector(".job-detail-op");
  if (!opBar) return; // pane not rendered yet — observer will retry
  if (document.getElementById(LIST_EVAL_BTN_ID)) return;
  const btn = document.createElement("button");
  btn.id = LIST_EVAL_BTN_ID;
  btn.textContent = "评估本职位";
  btn.style.cssText =
    "padding:6px 12px;border:none;border-radius:6px;cursor:pointer;vertical-align:middle;" +
    "background:#00c68d;color:#fff;font-size:13px;font-weight:600;margin-left:8px;" +
    "font-family:system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.2);";
  btn.addEventListener("click", () => {
    const btn = document.getElementById(LIST_EVAL_BTN_ID);
    const url = currentActiveUrl();
    if (!url) {
      showToast("未选中职位，请先在左侧点击一个职位", true);
      return;
    }
    btn.disabled = true;
    btn.textContent = "评估中...";
    chrome.runtime.sendMessage({ type: "single-evaluate", url }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        btn.disabled = false;
        btn.textContent = "评估本职位";
        showToast((res && res.error) || "评估发起失败：本地 web 服务未运行?", true);
      }
    });
  });
  // Sit immediately left of the "微信扫码分享" share button inside the op bar;
  // fall back to the bar's first child if the share anchor isn't found.
  const share = Array.from(opBar.querySelectorAll("a,button,span")).find((el) =>
    /微信|分享/.test(el.textContent || ""),
  );
  opBar.insertBefore(btn, share || opBar.firstChild);

  // 快评 — 列表右栏秒出分数徽章，独立于「评估本职位」(完整报告)。
  const qbtn = document.createElement("button");
  qbtn.id = "career-ext-list-quick-btn";
  qbtn.textContent = "快评";
  qbtn.style.cssText =
    "padding:6px 12px;border:none;border-radius:6px;cursor:pointer;vertical-align:middle;" +
    "background:#7c5cff;color:#fff;font-size:13px;font-weight:600;margin-left:8px;" +
    "font-family:system-ui,sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.2);";
  qbtn.addEventListener("click", () => {
    if (quickEvaluating || qbtn.disabled) return;
    const url = currentActiveUrl();
    if (!url) {
      showToast("未选中职位，请先在左侧点击一个职位", true);
      return;
    }
    const { title, text } = extractListPaneJd();
    if (!text) {
      showToast("快评：未能提取职位描述文本", true);
      return;
    }
    quickEvaluating = true;
    qbtn.disabled = true;
    qbtn.textContent = "快评中...";
    chrome.runtime.sendMessage({ type: "quick-evaluate", url, title, text }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        quickEvaluating = false;
        qbtn.disabled = false;
        qbtn.textContent = "快评";
        showQuickError((res && res.error) || "快评发起失败：本地 web 服务未运行?");
      }
    });
  });
  opBar.insertBefore(qbtn, (share && share.nextSibling) || btn.nextSibling);
}

function applyAllInjections() {
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    if (!card.__careerExt) processCard(card);
    else {
      // Re-render badge when the entry (newly evaluated) appeared after init.
      if (cardIsList(card)) {
        const url = cardUrl(card);
        const key = url ? normalizeUrl(url) : "";
        const entry = key ? evaluated[key] : undefined;
        let badge = card.querySelector("span[data-career-badge]");
        if (entry && !badge) injectBadge(card, entry);
        else if (!entry && badge) badge.remove();
      }
    }
  });
  if (location.pathname.includes("/job_detail/")) injectDetailButton();
  refreshDetailBadge();
  refreshQuickDetailBadge();
  ensureRightPaneButton();
}

// ---- message listeners ----------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "evaluated-updated") {
    refreshEvaluated();
    if (detailEvaluating) finalizeDetail();
    sendResponse({ ok: true });
    return;
  }
  if (msg && msg.type === "single-eval-error") {
    // Evaluation failed (background routed it back because the popup auto-closes).
    detailEvaluating = false;
    const btn = document.getElementById("career-ext-eval-btn");
    if (btn) {
      btn.disabled = false;
      btn.textContent = "评估本职位";
    }
    const listBtn = document.getElementById(LIST_EVAL_BTN_ID);
    if (listBtn) {
      listBtn.disabled = false;
      listBtn.textContent = "评估本职位";
    }
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
    const qbtn = document.getElementById("career-ext-quick-btn");
    if (qbtn) {
      qbtn.disabled = false;
      qbtn.textContent = `快评 ${msg.score}/5`;
      qbtn.title = msg.reason ? `快评：${msg.grade} — ${msg.reason}` : `快评：${msg.grade}`;
    }
    const lqbtn = document.getElementById("career-ext-list-quick-btn");
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
    const qbtn = document.getElementById("career-ext-quick-btn");
    if (qbtn) {
      qbtn.disabled = false;
      qbtn.textContent = "快评";
    }
    const lqbtn = document.getElementById("career-ext-list-quick-btn");
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
  return node.closest ? node.closest(CARD_SELECTOR) : null;
}

function handleAddedNode(node) {
  if (!node || node.nodeType !== 1) return 0;
  let touched = 0;
  const batch = [];
  if (typeof node.matches === "function") {
    if (node.matches(CARD_SELECTOR)) {
      // The added node IS a card.
      batch.push(node);
    } else {
      // Container node (e.g. UL.rec-job-list): process every card inside, but
      // DON'T treat the container itself as a card — that would mark it
      // __careerExt and skip all its real card children.
      if (node.appendChild) batch.push(...node.querySelectorAll(CARD_SELECTOR));
      const parentCard = matchCardParent(node);
      if (parentCard && !batch.includes(parentCard)) batch.push(parentCard);
    }
  }
  for (const c of batch) {
    if (c && !c.__careerExt) {
      processCard(c);
      touched++;
    }
  }
  return touched;
}

function init() {
  if (inited) return;
  inited = true;

  // Diag: snapshot + report DOM state to the background (BOSS blocks DevTools
  // by resizing/kicking the page, so the popup reads this instead). Re-sent on
  // a timer so lazily-scrolled cards refresh the numbers for the popup.
  const __diag = window.__careerExtDiag = {};
  const snap = () => {
    __diag.evaluatedKeys = Object.keys(evaluated).length;
    __diag.cards = document.querySelectorAll(CARD_SELECTOR).length;
    const first = document.querySelector(CARD_SELECTOR);
    __diag.cardHasLink = !!(first && first.querySelector(LINK_SELECTOR));
    __diag.cardHref = first ? (first.querySelector(LINK_SELECTOR) || {}).href || null : null;
    __diag.pathname = location.pathname;
    __diag.badges = document.querySelectorAll("span[data-career-badge]").length;
    __diag.boxes = document.querySelectorAll("input[type=checkbox][title^=选择]").length;
    // BOSS changed its list markup (pathname=/web/geek/jobs); .job-card-wrapper
    // no longer matches. Snapshot the REAL card container's class chain from the
    // first job_detail anchor so we can fix CARD_SELECTOR.
    __diag.linkAnchors = document.querySelectorAll(LINK_SELECTOR).length;
    const anchor = document.querySelector(LINK_SELECTOR);
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
    __diag.detailUrl = location.pathname.includes("/job_detail/") ? location.href : null;
    __diag.detailKey = location.pathname.includes("/job_detail/") ? normalizeUrl(location.href) : null;
    __diag.detailHit = __diag.detailKey ? Object.prototype.hasOwnProperty.call(evaluated, __diag.detailKey) : null;
    __diag.detailBadgeEl = !!document.getElementById(DETAIL_BADGE_ID);
    // List-page right pane (BOSS /web/geek/jobs shows the selected job's detail
    // beside the list). Diagnose where the current selection's URL lives and what
    // container holds the description area so we can anchor the inline eval button.
    __diag.activeCardUrl = (() => {
      const ac = document.querySelector(`${CARD_SELECTOR}.active`) || document.querySelector(".job-card-wrap.active");
      const a = ac && ac.querySelector(LINK_SELECTOR);
      return a && a.href ? a.href : null;
    })();
    // job_detail anchors that are NOT inside a list card — likely the right pane's
    // own title link. Record each with a short ancestor tag.class chain.
    __diag.rightPanes = (() => {
      const out = [];
      document.querySelectorAll(LINK_SELECTOR).forEach((a) => {
        if (a.closest(CARD_SELECTOR)) return;
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
    chrome.runtime.sendMessage({ type: "diag-report", data: __diag });
  };
  __diag.snap = snap;
  setInterval(snap, 3000); // keep the popup's debug box live as cards lazy-load

  // Fresh page → drop any selection the previous load left on this tab.
  chrome.runtime.sendMessage({ type: "selection-update", urls: [] });

  const observer = new MutationObserver((records) => {
    let touched = 0;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        touched += handleAddedNode(node);
      }
    }
    if (touched) syncSelection();
    // The right pane (.job-detail-body) re-renders when the selection changes;
    // re-check it on every mutation batch so the eval button survives the swap.
    ensureRightPaneButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Even if existing + listen for a first sync of the evaluated map.
  refreshEvaluated().then(() => snap());
  // Also sync the quick-score map so a detail page opened directly still shows
  // a previous list-page quick eval's badge.
  refreshQuick().then(() => snap());
}

if (document.body) init();
else document.addEventListener("DOMContentLoaded", () => init());
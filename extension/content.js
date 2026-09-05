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
  updateButtonPosition();
}

// Keep the eval button vertically stacked under the detail badge; when no badge
// is present it sits in the badge's own spot (top:80px). Re-measured whenever the
// badge appears/disappears so an evaluation that just completes repositions it.
function updateButtonPosition() {
  const btn = document.getElementById("career-ext-eval-btn");
  if (!btn) return;
  const badge = document.getElementById(DETAIL_BADGE_ID);
  if (badge) {
    const r = badge.getBoundingClientRect();
    btn.style.top = `${Math.round(r.bottom + 8)}px`;
  } else {
    btn.style.top = "80px";
  }
}

// Detail-page badge: shows the evaluation score for an already-evaluated
// posting high up the page (fixed, so it survives BOSS' layout shifts), and
// opens the report on click. Kept in sync with the evaluated map via
// refreshDetailBadge() on every applyAllInjections pass.
const DETAIL_BADGE_ID = "career-ext-detail-badge";

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
    showToast((msg.error || "评估失败"), true);
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
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Evening existing + listen for a first sync of the evaluated map.
  refreshEvaluated().then(() => snap());
}

if (document.body) init();
else document.addEventListener("DOMContentLoaded", () => init());
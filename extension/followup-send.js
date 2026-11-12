// followup-send.js — 「自动跟进」发送端（只挂三站：BOSS直聘 / 猎聘 / 智联招聘）。
//
// 职责单一：SW 转来一条已由用户确认过的文本，本脚本把它填进当前页聊天框、
// 点一次发送、回读校验，然后如实回报三态：
//   sent       输入框已清空 且 聊天流出现该句 → 才报成功
//   uncertain  两项只成立一项 → 报「不确定」，由用户到页面上确认
//   failed     找不到输入框 / 输入框写完仍为空 / 异常
//
// 边界（与 ADR-0081 一脉相承）：一次点击只发一条，不重试、不批量、不代投。
// 找不到就报找不到，不猜选择器、不盲点按钮——「发送简历」类按钮在纯逻辑层
// 打分时就被排除了（followup-send-pure.js 的 SEND_ANTI_TEXT）。
//
// 三站没有稳定的聊天 DOM 契约，这里走特征启发式：输入框按尺寸/位置/关键词打分，
// 发送按钮按文案找、回车兜底。站点改版只会让结果落到 failed/uncertain，
// 不会静默发错东西。

(function () {
  "use strict";

  const P = window.__careerFollowupSendPure;
  if (!P) {
    console.log("[followup-send] 纯逻辑模块缺失：扩展文件不完整");
    return;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const MAX_CONTACT_SCAN = 300;

  function classTextOf(el) {
    return typeof el.className === "string" ? el.className : "";
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    return Number(style.opacity || 1) > 0.05;
  }

  /** 页面上所有可编辑节点 → {el, desc}，desc 是纯逻辑层的输入。 */
  function inputCandidates() {
    const nodes = document.querySelectorAll('textarea, input[type="text"], [contenteditable="true"], [contenteditable=""]');
    const out = [];
    for (const el of nodes) {
      const rect = el.getBoundingClientRect();
      out.push({
        el,
        desc: {
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || "",
          contentEditable: el.isContentEditable === true,
          visible: isVisible(el),
          width: rect.width,
          height: rect.height,
          bottomGap: window.innerHeight - rect.top,
          placeholder: el.getAttribute("placeholder") || el.getAttribute("data-placeholder") || "",
          classText: classTextOf(el),
          idText: el.id || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          readOnly: el.readOnly === true || el.getAttribute("aria-readonly") === "true",
          disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
        },
      });
    }
    return out;
  }

  /** 职位详情页常常只有「立即沟通 / 继续沟通」按钮，聊窗要点一下才出来。 */
  function clickChatEntry() {
    const entries = document.querySelectorAll("button, a, [role='button']");
    for (const el of entries) {
      const text = (el.innerText || "").replace(/\s+/g, "");
      if (!text || text.length > 8) continue;
      if (!/立即沟通|继续沟通|聊一聊|发消息|在线沟通|打招呼/.test(text)) continue;
      if (!isVisible(el)) continue;
      el.click();
      return true;
    }
    return false;
  }

  async function findInput(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let triedEntry = false;
    while (Date.now() < deadline) {
      const candidates = inputCandidates();
      const best = P.pickInputCandidate(candidates.map((c) => c.desc));
      if (best) return candidates[best.index].el;
      if (!triedEntry) {
        triedEntry = true;
        if (clickChatEntry()) {
          await sleep(900);
          continue;
        }
      }
      await sleep(300);
    }
    return null;
  }

  function readValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") return String(el.value || "");
    return String(el.innerText || el.textContent || "");
  }

  /** React 站点只认原生 setter + input 事件；contenteditable 走 insertText。 */
  function fillInput(el, text) {
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") {
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    }
  }

  /** 在输入框所在的聊天容器里找发送按钮；找不到返回 null（调用方回车兜底）。 */
  function findSendButton(inputEl) {
    const scope =
      inputEl.closest('[class*="chat"],[class*="im-"],[class*="dialog"],[class*="panel"],[class*="conversation"]') ||
      inputEl.parentElement ||
      document.body;
    const nodes = scope.querySelectorAll("button, [role='button'], a, div, span");
    const pairs = [];
    let scanned = 0;
    for (const el of nodes) {
      if (scanned++ > MAX_CONTACT_SCAN) break;
      const text = (el.innerText || "").replace(/\s+/g, "");
      if (text.length > 8) continue; // 发送按钮不会有长文案
      const rect = el.getBoundingClientRect();
      pairs.push({
        el,
        desc: {
          text,
          tag: el.tagName.toLowerCase(),
          visible: isVisible(el),
          disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
          width: rect.width,
          height: rect.height,
          classText: classTextOf(el),
          idText: el.id || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          title: el.getAttribute("title") || "",
        },
      });
    }
    const best = P.pickSendCandidate(pairs.map((p) => p.desc));
    return best ? pairs[best.index].el : null;
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }

  async function waitCleared(el, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (readValue(el).trim() === "") return true;
      await sleep(100);
    }
    return readValue(el).trim() === "";
  }

  /** 聊天流里最后几条消息文本（只取最内层节点，避免容器把整段拼成一条）。 */
  function readMessages(inputEl) {
    const scopes = [
      inputEl.closest('[class*="chat"],[class*="conversation"],[class*="im-"],[class*="message"]'),
      document.body,
    ].filter(Boolean);
    const leafSelector = '[class*="message"],[class*="msg"],[class*="bubble"],[class*="chat-item"]';
    for (const scope of scopes) {
      const texts = [];
      for (const node of scope.querySelectorAll(leafSelector)) {
        if (node.querySelector(leafSelector)) continue;
        const text = String(node.innerText || "").trim();
        if (text && text.length <= 400) texts.push(text);
      }
      if (texts.length) return texts.slice(-8);
    }
    return [];
  }

  /** 聊天头部招聘方名字；读不到返回空串（记录里那格留空，不编人名）。 */
  function readContact(inputEl) {
    const scopes = [
      inputEl.closest('[class*="chat"],[class*="conversation"],[class*="dialog"],[class*="panel"]'),
      null,
    ];
    for (const scope of scopes) {
      const root = scope || document.body;
      const nodes = root.querySelectorAll('[class*="name"],[class*="nick"],[class*="title"],[class*="hr"]');
      const candidates = [];
      let scanned = 0;
      for (const node of nodes) {
        if (scanned++ > MAX_CONTACT_SCAN) break;
        const text = String(node.innerText || "").trim();
        if (!text || text.length > 40) continue;
        const rect = node.getBoundingClientRect();
        candidates.push({ text, classText: classTextOf(node), top: rect.top, visible: isVisible(node) });
      }
      const hit = P.pickContactCandidate(candidates);
      if (hit) return hit;
    }
    return "";
  }

  async function runSend(msg) {
    const text = P.joinMessage(msg && msg.text);
    if (!text) return { ok: false, status: "failed", reason: "empty-text" };
    const site = P.siteForUrl(location.href);

    const input = await findInput(6000);
    if (!input) return { ok: false, status: "failed", reason: "no-input", site: site ? site.id : null };

    const contact = readContact(input);
    fillInput(input, text);
    const filled = readValue(input).trim();
    if (!filled) {
      return { ok: false, status: "failed", reason: "input-rejected", contact, site: site ? site.id : null };
    }

    const button = findSendButton(input);
    if (button) button.click();
    else pressEnter(input);

    const cleared = await waitCleared(input, 2000);
    await sleep(400);
    const messages = readMessages(input);
    const verdict = P.verifySend({ after: readValue(input), messages, expectText: text });

    let reason = null;
    if (!verdict.ok) {
      if (!verdict.cleared && !verdict.echoed) reason = "unverified";
      else if (!verdict.cleared) reason = "input-not-cleared";
      else reason = "no-echo";
    }
    return {
      ok: verdict.ok,
      status: verdict.ok ? "sent" : "uncertain",
      reason,
      cleared: verdict.cleared,
      echoed: verdict.echoed,
      contact,
      site: site ? site.id : null,
      sentAt: new Date().toISOString(),
    };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "followup-send") return undefined;
    runSend(msg).then(sendResponse, (err) => {
      sendResponse({
        ok: false,
        status: "failed",
        reason: "exception",
        detail: (err && err.message) || String(err),
      });
    });
    return true; // 异步应答
  });
})();

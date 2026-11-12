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
  /** 本次运行里有没有点过「立即沟通/继续沟通」跳进聊天页（ADR-0100 修订版的门槛）。 */
  let clickedChatEntry = false;

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
      if (!/立即沟通|继续沟通|继续聊|聊一聊|发消息|在线沟通|打招呼/.test(text)) continue;
      if (!isVisible(el)) continue;
      el.click();
      return true;
    }
    return false;
  }

  /** 当前页面上最像聊天输入框的那个；没有返回 null。 */
  function currentInput() {
    const candidates = inputCandidates();
    const best = P.pickInputCandidate(candidates.map((c) => c.desc));
    return best ? candidates[best.index].el : null;
  }

  /** 等聊天框出现（只等，不点任何按钮：点入口在 runSend 里单独处理）。 */
  async function findInput(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const box = currentInput();
      if (box) return box;
      await sleep(300);
    }
    return null;
  }

  function readValue(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") return String(el.value || "");
    return String(el.innerText || el.textContent || "");
  }

  /**
   * React 站点只认原生 setter + input 事件；contenteditable 走 insertText。
   * 返回实际用了哪条路：`insertText` 与 `value` 站点的状态能收到，`textContent`
   * 只是把字画在页面上，编辑器自己的 state 仍是空的——那种情况下点「发送」不会
   * 有任何事发生，字会留在框里。这个区别必须回传，否则只能靠猜。
   */
  function fillInput(el, text) {
    el.focus();
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea" || tag === "input") {
      const proto = tag === "textarea" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "value";
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
    if (inserted) return "insertText";
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
    return "textContent";
  }

  /**
   * 编辑器的「已接收」信号：BOSS 的发送按钮在空内容时带 `disabled` 类，收到内容才摘掉。
   * 这比等固定毫秒数可靠——按钮还禁用着就点，等于什么都没发生，字却会留在框里
   * 或被下一次渲染抹掉（这时读到的「已清空」是假的）。
   */
  function sendReady(buttonEl) {
    if (!buttonEl) return false;
    if (buttonEl.disabled === true || buttonEl.getAttribute("aria-disabled") === "true") return false;
    return !/\bdisabled\b/.test(String(buttonEl.className || ""));
  }

  async function waitSendReady(buttonEl, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (sendReady(buttonEl)) return true;
      await sleep(100);
    }
    return sendReady(buttonEl);
  }

  /** 备用注入：走 paste 事件。富文本编辑器多半自己接管粘贴，比 execCommand 更容易进状态。 */
  function pasteInput(el, text) {
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const event = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
    } catch {
      return false;
    }
    return readValue(el).trim() !== "";
  }

  /**
   * 输入框所在的聊天容器。必须从 parentElement 往上找：三站的输入框类名自己就带
   * chat / im-（BOSS 是 div#chat-input.chat-input，猎聘是 ant-im-input im-ui-textarea），
   * 直接从输入框 closest 会把作用域缩成输入框内部，发送按钮和消息列表全都找不到。
   *
   * 也不能只取最近那个命中 `[class*="im-"]` 的祖先：那个命中往往就是输入框自己的
   * 外壳（智联 `DIV.im-sender__input-wrapper`），作用域一缩进去，会话头部和消息流
   * 全在圈外，联系人读到的永远是空。选谁交给纯逻辑 pickChatScope（可单测），这里
   * 只负责把祖先链摘成描述。
   */
  function chatScopeOf(inputEl) {
    const from = inputEl && inputEl.parentElement;
    if (!from) return document.body;
    const chain = [];
    const els = [];
    let node = from;
    let depth = 0;
    while (node && node !== document.body && depth < 12) {
      chain.push({ tag: node.tagName.toLowerCase(), classText: classTextOf(node) });
      els.push(node);
      node = node.parentElement;
      depth += 1;
    }
    const idx = P.pickChatScope(chain);
    return idx >= 0 ? els[idx] : from;
  }

  /**
   * 消息流的容器：从输入框往上取**最外层**那个像聊天区的祖先。
   * 取最近的那个会把作用域缩成编辑器外壳（BOSS 是 div.chat-input 外面一圈），
   * 消息列表根本不在里面，于是「发出去了」被读成「聊天流里没出现」。
   * 放宽后会连左侧会话列表一起进来，所以 readMessages 里要把列表预览类节点排掉。
   */
  function messageScopeOf(inputEl) {
    let node = inputEl && inputEl.parentElement;
    let best = null;
    let depth = 0;
    while (node && node !== document.body && depth < 12) {
      if (node.matches && node.matches('[class*="chat"],[class*="im-"]')) best = node;
      node = node.parentElement;
      depth += 1;
    }
    return best || chatScopeOf(inputEl);
  }

  /**
   * 在聊天容器里找发送按钮；找不到返回 null（调用方回车兜底）。
   * BOSS 的「发送」在编辑器的兄弟节点里，不在编辑器的父链容器内，所以按由近到远
   * 三级找；最后一级扫全页时只收与输入框同一水平带（±80px）的候选，免得点中页面
   * 别处的「发送」（比如「发送简历」）。
   */
  function findSendButton(inputEl) {
    const er = inputEl.getBoundingClientRect();
    const midLine = er.top + er.height / 2;
    const scopes = [
      { scope: chatScopeOf(inputEl), near: false },
      { scope: inputEl.closest('[class*="chat"],[class*="im-"]'), near: false },
      { scope: document.body, near: true },
    ];
    for (const step of scopes) {
      if (!step.scope) continue;
      const pairs = collectSendCandidates(step.scope, step.near ? midLine : null);
      // 同一个「发送」往往是按钮 + 外面一整条动作栏。猎聘实测收到的是
      // DIV.im-ui-input-actions（434px 宽，整条栏），点它的中心等于点空白，
      // 消息原地不动。留最内层那个：被别的候选包住、文案又相同的直接丢掉。
      for (let i = pairs.length - 1; i >= 0; i -= 1) {
        const p = pairs[i];
        if (pairs.some((q) => q !== p && p.el.contains(q.el) && q.desc.text === p.desc.text)) pairs.splice(i, 1);
      }
      const best = P.pickSendCandidate(pairs.map((p) => p.desc));
      if (best) return pairs[best.index].el;
    }
    return null;
  }

  /** 收容器里的短文案可点节点；midLine 非空时只留与这条水平线相邻的。 */
  function collectSendCandidates(scope, midLine) {
    const nodes = scope.querySelectorAll("button, [role='button'], a, div, span");
    const pairs = [];
    let scanned = 0;
    for (const el of nodes) {
      if (scanned++ > MAX_CONTACT_SCAN) break;
      const text = (el.innerText || "").replace(/\s+/g, "");
      if (text.length > 8) continue; // 发送按钮不会有长文案
      const rect = el.getBoundingClientRect();
      if (midLine !== null && Math.abs(rect.top + rect.height / 2 - midLine) > 80) continue;
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
    return pairs;
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

  /**
   * 聊天流里的消息文本。两处必须这么写：
   *   • 作用域从输入框的父节点往上找，不能把输入框自己算进去（否则只剩刚才填的草稿）；
   *   • **不回落 document.body**。三站的页面侧栏都是「所有会话的最后一条消息预览」，
   *     同一套话术模板会在别的会话里出现，末段指纹一撞就把「没发出去」判成「已回显」。
   * 也不再要求「最内层节点」：猎聘的 im-ui-message-* 层层套娃，最内层不带定位类名，
   * 按最内层筛结果一条都收不到，只能按整条消息节点的 innerText 收、再按文本去重。
   */
  function readMessages(inputEl) {
    const scope = messageScopeOf(inputEl);
    if (!scope || scope === document.body) return [];
    const selector = '[class*="message"],[class*="msg"],[class*="bubble"],[class*="chat-item"]';
    // 作用域放宽后会把左侧会话列表包进来，那里每行都挂着「最后一条消息」预览，
    // 同一套话术模板撞上就成假阳性。预览类节点在这里排掉。
    const previewLike = /last-?msg|preview|unread|brief|abstract/i;
    const texts = [];
    for (const node of scope.querySelectorAll(selector)) {
      if (node === inputEl || node.contains(inputEl)) continue; // 输入框里的草稿不算回显
      if (previewLike.test(String(node.className || ""))) continue;
      const text = String(node.innerText || "").trim();
      if (!text || text.length > 400) continue;
      if (!texts.includes(text)) texts.push(text);
    }
    return texts.slice(-12);
  }

  /**
   * 聊天头部招聘方名字；读不到返回空串（记录里那格留空，不编人名）。
   * 容器同 readMessages；另外**跳过按钮/链接里的文字**——那是「交换手机号」「求简历」
   * 这类操作标签，不是人名，早先真被填进过联系人。
   */
  function readContact(inputEl) {
    const scope = chatScopeOf(inputEl);
    if (!scope || scope === document.body) return "";
    const nodes = scope.querySelectorAll('[class*="name"],[class*="nick"],[class*="title"],[class*="hr"]');
    const candidates = [];
    let scanned = 0;
    for (const node of nodes) {
      if (scanned++ > MAX_CONTACT_SCAN) break;
      if (node.closest("button, a, [role='button']")) continue;
      // 消息流里的节点也带 name/title 类名（智联 im-message__name-wrapper、
      // im-msg-11__title）。作用域放宽到整个会话容器后它们会进候选池，而
      // 视口上方（top<0）的节点还会因位置得分被抬高 —— 一条短消息能压过
      // 会话头部的真名。人名只在头部，消息区一律不看。
      if (node.closest('[class*="timeline"],[class*="message"],[class*="msg"],[class*="bubble"]')) continue;
      const text = String(node.innerText || "").trim();
      if (!text || text.length > 40) continue;
      const rect = node.getBoundingClientRect();
      candidates.push({ text, classText: classTextOf(node), top: rect.top, visible: isVisible(node) });
    }
    return P.pickContactCandidate(candidates) || "";
  }

  /**
   * 岗位详情页上的招聘者姓名——聊天窗读不到时的回退来源。
   * BOSS 把它写成标题「赵女士」，紧跟「· 小猎吧」「猎头顾问」。只认 2–7 字、
   * 以称呼结尾的短文本；别的站没这种写法就返回空串，不猜。
   */
  function readJobPageContact() {
    const pattern = /^[\u4e00-\u9fa5A-Za-z]{1,5}(女士|先生|小姐|老师)$/;
    const nodes = document.querySelectorAll("h1, h2, h3, h4, [class*='boss'], [class*='hr'], [class*='recruit']");
    let scanned = 0;
    for (const el of nodes) {
      if (scanned++ > MAX_CONTACT_SCAN) break;
      if (!isVisible(el)) continue;
      if (el.closest("a, button, [role='button']")) continue;
      const text = String(el.innerText || "").replace(/\s+/g, "").trim();
      if (!pattern.test(text)) continue;
      return text;
    }
    return "";
  }

  /** 页面是不是 BOSS 的会话列表页（左列会话、右侧聊天区）。 */
  function isConversationListPage() {
    return location.pathname.replace(/\/+$/, "") === "/web/geek/chat";
  }

  async function runSend(msg) {
    const text = P.joinMessage(msg && msg.text);
    if (!text) return { ok: false, status: "failed", reason: "empty-text" };
    const site = P.siteForUrl(location.href);
    // SW 会在点过入口、页面加载完之后把这条标志带回来：新文档凭它知道自己是从
    // 该岗位的「继续沟通」进来的（点完必然跳页，本脚本往往等不到那之后）。
    const entryClicked = Boolean(msg && msg.entryClicked === true);
    clickedChatEntry = entryClicked;

    let input = currentInput();
    if (!input && !entryClicked) {
      if (clickChatEntry()) {
        // 页面要跳去聊天页，本脚本可能随文档一起销毁，等下去没有意义：
        // 交回给 SW，它等页面加载后再发一次，并带上 entryClicked。
        // 岗位页上的招聘者姓名一并交回：聊天窗里读不到时用它兜（用户定的口径）。
        return {
          ok: false,
          status: "navigating",
          reason: "chat-entry-clicked",
          site: site ? site.id : null,
          entryContact: readJobPageContact(),
        };
      }
    }
    if (!input) input = await findInput(6000);
    if (!input) return { ok: false, status: "failed", reason: "no-input", site: site ? site.id : null };

    // BOSS 的会话列表页默认打开上一条会话。只有「本次从该岗位详情页点了继续沟通
    // 才落到这个聊天页」时，右侧才是这条岗位的招聘者；否则无从判断发给谁，
    // 宁可不发（ADR-0100 修订版）。
    if (site && site.id === "boss" && isConversationListPage() && !clickedChatEntry) {
      return {
        ok: false,
        status: "failed",
        reason: "unknown-target",
        site: "boss",
        detail: `entry | 页面停在会话列表，本次没有经过岗位页的继续沟通 ; ${describeInput(input)} ; ${describeSendArea(input)}`,
      };
    }

    // 先读聊天窗；读不到就用上一跳从岗位页带回来的招聘者姓名。
    const contact = readContact(input) || String((msg && msg.jobContact) || "");
    // 填字前先找一次按钮，记下它此刻是不是禁用态：BOSS 空内容时带 `disabled` 类，
    // 只有「本来就禁用」的站点才需要后面的就绪等待，免得改到另两站的行为。
    const buttonBefore = findSendButton(input);
    const gatedByButton = buttonBefore ? !sendReady(buttonBefore) : false;
    let fillMode = fillInput(input, text);
    const filled = readValue(input).trim();
    if (!filled) {
      return {
        ok: false,
        status: "failed",
        reason: "input-rejected",
        contact,
        site: site ? site.id : null,
        detail: `${describeInput(input)}|fill=${fillMode}`,
      };
    }
    // 给站点一拍把内容同步进它自己的状态：React 那边是异步批处理的，
    // 刚 dispatch 完就点「发送」，处理器读到的可能还是空内容（点了等于没点）。
    await sleep(300);

    // 有些站点的「发送」要等编辑器拿到内容、重新渲染后才出现，给一拍再找一次。
    let button = buttonBefore || findSendButton(input);
    if (!button) {
      await sleep(400);
      button = findSendButton(input);
    }

    // 真正决定能不能发的是「编辑器有没有收到内容」，这里用按钮的禁用态当信号。
    // 看到还禁着就换 paste 再来一次；两次都没进状态就报失败，绝不硬点。
    if (button && gatedByButton) {
      let ready = await waitSendReady(button, 1500);
      if (!ready) {
        if (pasteInput(input, text)) fillMode = `${fillMode}->paste`;
        await sleep(300);
        ready = await waitSendReady(button, 1500);
      }
      if (!ready) {
        return {
          ok: false,
          status: "failed",
          reason: "input-not-registered",
          contact,
          site: site ? site.id : null,
          detail: `${describeInput(input)}|fill=${fillMode} ; ${describeButton(button)} | ${describeSendArea(input)}`,
        };
      }
    }
    if (button) button.click();
    else pressEnter(input);

    const cleared = await waitCleared(input, 2000);
    // 回显晚于输入框清空：轮询到 3 秒再判定，读早了会把「已发出」报成「没出现」。
    const fp = P.fingerprint(text);
    let messages = [];
    const echoDeadline = Date.now() + 3000;
    while (Date.now() < echoDeadline) {
      messages = readMessages(input);
      if (fp && messages.some((m) => String(m).replace(/\s+/g, "").includes(fp))) break;
      await sleep(250);
    }
    const notes = collectNotes();
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
      notes,
      contact,
      site: site ? site.id : null,
      sentAt: new Date().toISOString(),
      // 没发出去时把输入框附近的候选抖出来：BOSS 一开 DevTools 就整页刷新，
      // 这条路是唯一能拿到它真实 DOM 的通道。
      detail: verdict.ok
        ? null
        : `${describeInput(input)}|fill=${fillMode} ; ${button ? `clicked ${describeButton(button)}` : "enter"}${notes ? ` ; note=${notes}` : ""} | ${describeSendArea(input)}`,
    };
  }

  /**
   * 点完发送后页面上冒出来的短提示。站点拒收（次数上限、需先交换联系方式、
   * 发送失败）都只弹一句 toast，页面上不留痕，不抓就永远只能猜。
   */
  function collectNotes() {
    const selector = '[role="alert"],[class*="toast"],[class*="tip"],[class*="notice"],[class*="error"],[class*="warn"]';
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!isVisible(el)) continue;
      const text = String(el.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 60) continue;
      if (!out.includes(text)) out.push(text);
      if (out.length >= 4) break;
    }
    return out.join(" / ");
  }

  /** 被点下去的那个「发送」是谁：标签、类名、文案、位置、是否禁用。 */
  function describeButton(el) {
    const r = el.getBoundingClientRect();
    const cls = String(el.className || "").slice(0, 24);
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    const clsDisabled = /\bdisabled\b/.test(String(el.className || ""));
    return `${el.tagName}.${cls}|text=${(el.innerText || "").replace(/\s+/g, "").slice(0, 6)}|rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}|disabled=${disabled}|clsDisabled=${clsDisabled}`;
  }

  /**
   * 被当成聊天框的那个节点是谁：标签、类名、占位、位置与尺寸、离屏底距离。
   * 三站靠特征打分选输入框，选错时只看邻居快照分不清「选错了谁」，这一行补上。
   */
  function describeInput(inputEl) {
    const r = inputEl.getBoundingClientRect();
    const cls = String(inputEl.className || "").slice(0, 32);
    const ph = (inputEl.getAttribute("placeholder") || inputEl.getAttribute("data-placeholder") || "").slice(0, 12);
    return `input | ${inputEl.tagName}.${cls}${inputEl.id ? `#${inputEl.id}` : ""}|ph=${ph}|rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}|gap=${Math.round(window.innerHeight - r.top)}`;
  }

  /** 输入框同一水平带上的短文案可点节点，压缩成一行，用于排障。 */
  function describeSendArea(inputEl) {
    const r = inputEl.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const out = [];
    for (const el of document.querySelectorAll("button, [role='button'], a, div, span")) {
      const b = el.getBoundingClientRect();
      if (!b.width || Math.abs(b.top + b.height / 2 - mid) > 120) continue;
      const text = (el.innerText || "").replace(/\s+/g, "").slice(0, 8);
      const cls = String(el.className || "").slice(0, 28);
      const aria = (el.getAttribute("aria-label") || "").slice(0, 12);
      if (!text && !cls && !aria) continue;
      out.push(`${el.tagName}.${cls}|${text}|${aria}`);
      if (out.length >= 12) break;
    }
    return out.join(" ; ");
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

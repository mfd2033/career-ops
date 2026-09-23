// web-bridge.js — localhost web 面板 ↔ 扩展 SW 的桥(ADR-0007 E2 转发链路)。
//
// 探索页拿不到 chrome.runtime,无法直接向 background SW 发消息。页面 origin 按家规
// (modes/_custom.md)应为 http://localhost:{3000-3040};用户手敲 IP 时则是
// http://127.0.0.1:{3000-3040}。两者是不同 origin,manifest 的 matches 同时覆盖,本桥对
// 两者行为一致:把页面上带 __careerExt:req 标签的 window.postMessage 转成
// chrome.runtime.sendMessage,再把 SW 的回调经 __careerExt:res postMessage 原路返回。
// 页面侧据此驱动扫描,不新增其它通道(仅响应本页自己的消息;非本扩展标签的消息一律忽略)。
//
// 与 background 的消息契约按 msg.type 路由:drive-scan / ping / get-state 等;
// scan-batch / scan-done 由三站 content script 直接发 SW,不经本桥。
// 该桥对与扩展无关的 localhost 页面零副作用(只认带标签的 postMessage)。
//
// 反方向(ADR-0055 修订):SW 要请 web 端「不刷新地跳到某张报告」,于是多一条
// chrome.runtime.onMessage 入口 —— 收到 career-navigate 后把 __careerExt:nav 投给页面,
// 页面(根 layout 的 ExtNavBridge)路由跳转后回 __careerExt:nav-ack。本桥等到该 ack 才
// 应答 SW:旧版 web 没有这个监听器时不应答,SW 便回退整页导航。

(() => {
  "use strict";

  const TAG = "__careerExt";

  // SW 回调是异步的(sendMessage 带响应),这里把它压缩成 Promise 以便统一回传。
  function sendToBackground(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          resolve(chrome.runtime.lastError ? { ok: false, error: String(chrome.runtime.lastError.message || chrome.runtime.lastError) } : (res || { ok: false }));
        });
      } catch {
        resolve({ ok: false, error: "bridge:send-failed" });
      }
    });
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const data = e.data;
    if (!data || data.tag !== `${TAG}:req`) return;
    const id = data.id;
    const msg = data.msg;
    sendToBackground(msg).then((res) => {
      try {
        window.postMessage({ tag: `${TAG}:res`, id, res }, "*");
      } catch {
        /* window tearing down — drop the reply */
      }
    });
  });

  // 页面回 ack 的等待窗口:hydration 完成后的页面是同步应答的,800ms 只用来兜住
  // 「还没 hydrate / 老版本 web 没有监听器」——那两种情况必须让 SW 走整页导航回退,
  // 而不是把用户的点击悬在半空。
  const NAV_ACK_TIMEOUT_MS = 800;
  let navSeq = 0;

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "career-navigate" || typeof msg.path !== "string") return undefined;
    const id = ++navSeq;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onAck);
      sendResponse(ok ? { ok: true } : { ok: false, error: "no-page-ack" });
    };
    const onAck = (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.tag !== `${TAG}:nav-ack` || d.id !== id) return;
      finish(true);
    };
    const timer = setTimeout(() => finish(false), NAV_ACK_TIMEOUT_MS);
    window.addEventListener("message", onAck);
    try {
      window.postMessage({ tag: `${TAG}:nav`, id, path: msg.path }, "*");
    } catch {
      finish(false);
    }
    return true; // 异步应答:ack 或超时后才回话
  });
})();
// web-bridge.js — localhost web 面板 → 扩展 SW 的桥(ADR-0007 E2 转发链路)。
//
// 探索页页面跑在 http://127.0.0.1:{3000-3040} origin,拿不到 chrome.runtime,无法
// 直接向 background SW 发消息。本 content script 配合 manifest 的 localhost 匹配,
// 把页面上带 __careerExt:req 标签的 window.postMessage 转成 chrome.runtime.sendMessage,
// 再把 SW 的回调经 __careerExt:res postMessage 原路返回。页面侧据此驱动扫描,不新增
// 其它通道(仅响应本页自己的消息;非本扩展标签的消息一律忽略)。
//
// 与 background 的消息契约按 msg.type 路由:drive-scan / ping / get-state 等;
// scan-batch / scan-done 由三站 content script 直接发 SW,不经本桥。
// 该桥对与扩展无关的 localhost 页面零副作用(只认带标签的 postMessage)。

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
})();
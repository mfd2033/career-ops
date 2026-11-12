// localhost 面板 → 扩展 SW 的桥调用（ADR-0007 E5）。
//
// 页面拿不到 chrome.runtime，所以请求走 window.postMessage 打 `__careerExt:req`
// 标签，由 web-bridge.js 这个内容脚本转成 chrome.runtime.sendMessage，再把 SW 的
// 回调经 `__careerExt:res` 原路送回。扩展未装 / 没重载 / 超时 → { ok:false }，
// 调用方据此走降级路径，不抛异常。
//
// 抽成独立模块是因为两个调用点（探索页的扫描驱动、跟进页的自动跟进）需要同一份
// 语义：同一套标签、同一个自增 id、同一条超时。改口径只改这里。

const EXT_BRIDGE_TAG = "__careerExt";
let extMsgSeq = 0;

/**
 * 向扩展 SW 发一条消息并等应答。
 *
 * @param msg 消息体（type 决定 SW 侧分支）
 * @param timeoutMs 超时；普通探测默认 4s，要等开 tab / 内容脚本就绪的调用方自己放宽
 */
export function extRequest(msg: unknown, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve({ ok: false, error: "no-window" });
      return;
    }
    const id = ++extMsgSeq;
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", onMsg);
      resolve({ ok: false, error: "ext-bridge-timeout" });
    }, timeoutMs);
    function onMsg(e: MessageEvent) {
      const d = e.data;
      if (!d || d.tag !== `${EXT_BRIDGE_TAG}:res` || d.id !== id) return;
      window.removeEventListener("message", onMsg);
      clearTimeout(timer);
      resolve((d.res || { ok: false }) as Record<string, unknown>);
    }
    window.addEventListener("message", onMsg);
    window.postMessage({ tag: `${EXT_BRIDGE_TAG}:req`, id, msg }, "*");
  });
}

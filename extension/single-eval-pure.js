// single-eval-pure.js — 扩展「评估本职位」走单任务链路的纯逻辑层（ADR-0051）。
//
// 从 background.js 的 fetch/stream 回调里剥出四件能脱离浏览器单测的判断：
//   • pickEvalRoute      —— 服务端能力位决定这次单职位评估走 /api/run 还是回落批量路；
//   • createRunState /
//     consumeRunEvent    —— 把 /api/events 上的单任务事件折叠成 popup 既有的 stage 形状
//                           （含 seq 重放去重、VERDICT/ERROR 累积抽取）；
//   • composeFailureNotice —— 登录墙失败时优先用 worker 自己说的 ERROR 行。
//
// 之所以是 reducer 而不是逐个函数：文本要累积才能抽 VERDICT，seq 要记着才能对抗
// 总线重连回放（/api/events 一连上就把该 run 的缓冲整段重发一遍，不折叠就是把
// 进度文本喂两遍、结论行造两次）。
//
// background.js 以经典 service worker 方式 importScripts 本文件，经
// self.__careerOpsSingleEvalPure 取用；node 单测以 module.exports 守卫直接 import
// （与 badge-pure.js / wrapup-pure.js / scan-pure.js 同口径）。本文件严禁引用
// chrome/window/document/location —— service worker 里没有 window，加载即崩。

(function () {
  "use strict";

  // 服务端能力位（ADR-0051 决议 11）：/api/version 的 capabilities 里出现它，
  // 才说明这台 web 服务的 /api/run 认 jdText —— 缺位就是老 exe / 老 dev 服务。
  var CAP_SINGLE_EVAL_INLINE_JD = "single-eval-inline-jd";

  // 文本尾巴上限：与 web job-store 同口径（8000），VERDICT 单独 latch，不让长任务
  // 的叙述把结论挤出窗口。
  var TEXT_TAIL = 8000;

  // popup 步骤文本上限：status 文案很短，给个防御性上界。
  var STATUS_TAIL = 200;

  /**
   * 单职位评估走哪条链路。
   * @param {unknown} payload /api/version 的响应体（脏值、null、缺字段都要活）
   * @returns {"run" | "batch"}
   */
  function pickEvalRoute(payload) {
    var caps = payload && payload.capabilities;
    if (!Array.isArray(caps)) return "batch";
    return caps.indexOf(CAP_SINGLE_EVAL_INLINE_JD) >= 0 ? "run" : "batch";
  }

  /**
   * 一次单职位评估的事件折叠状态。url 是详情页/右栏发起时那个职位 URL，
   * 合成的结论行要用它跟 popup 的 items 表对上。
   * @param {string} url
   */
  function createRunState(url) {
    return { url: String(url || ""), text: "", verdict: null, errLine: null, lastSeq: 0, finished: false };
  }

  /** 取最后一条 `VERDICT: n/5 — …`：多条时后面的赢（agent 会改口）。 */
  function lastVerdict(text) {
    var all = String(text || "").match(/VERDICT:[^\n]*/gi);
    if (!all || !all.length) return null;
    var line = all[all.length - 1];
    var m = line.match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
    return { line: line, score: m ? Number(m[1]) : null };
  }

  /** 取最后一条 `ERROR: …`（登录墙提取失败的唯一可读原因）。 */
  function lastErrorLine(text) {
    var all = String(text || "").match(/ERROR:[^\n]*/gi);
    if (!all || !all.length) return null;
    return all[all.length - 1].trim().slice(0, STATUS_TAIL);
  }

  /**
   * 失败文案优先级（ADR-0051 决议 7）：worker 自己说的那句能定位根因，
   * 路由器的门文案只能当附注。
   * @param {{msg?: string, errLine?: string|null}} p
   * @returns {string}
   */
  function composeFailureNotice(p) {
    var msg = String((p && p.msg) || "").trim();
    var line = (p && p.errLine) || "";
    if (line && msg) return line + "（" + msg + "）";
    return line || msg || "评估失败";
  }

  /**
   * 折叠一条总线事件，返回新的状态与要 announce 的 popup 事件列表。
   *
   * 纯函数：不碰 chrome API、不改入参状态对象。`finished` 一旦置上，后续事件
   * 一律不再产出——重连回放、error 之后又冒 done 都不能给 popup 两次终态。
   *
   * @param {ReturnType<createRunState>} state
   * @param {{type?: string, label?: string, text?: string, msg?: string, seq?: number}} ev
   * @returns {{state: object, events: Array<object>}}
   */
  function consumeRunEvent(state, ev) {
    var next = {
      url: state.url,
      text: state.text,
      verdict: state.verdict,
      errLine: state.errLine,
      lastSeq: state.lastSeq,
      finished: state.finished,
    };
    if (!ev || typeof ev !== "object") return { state: next, events: [] };
    // 总线重放去重：与 job-store 同一手法（seq 单调，小于等于已应用的就丢）。
    if (typeof ev.seq === "number") {
      if (ev.seq <= next.lastSeq) return { state: next, events: [] };
      next.lastSeq = ev.seq;
    }
    if (next.finished) return { state: next, events: [] };

    if (ev.type === "text") {
      var full = next.text + String(ev.text || "");
      var v = lastVerdict(full);
      if (v) next.verdict = v;
      var e = lastErrorLine(full);
      if (e) next.errLine = e;
      next.text = full.slice(-TEXT_TAIL);
      return { state: next, events: [{ stage: "text", text: String(ev.text || "") }] };
    }

    if (ev.type === "status") {
      return { state: next, events: [{ stage: "status", text: String(ev.label || "").slice(0, STATUS_TAIL) }] };
    }

    if (ev.type === "done") {
      next.finished = true;
      var out = [];
      // 单任务总线没有 item 事件：结论行在这里合成，形状与批量 item 事件一致。
      if (next.verdict) out.push({ stage: "item", url: next.url, ok: true, score: next.verdict.score });
      out.push({ stage: "done", ok: 1, failed: 0 });
      return { state: next, events: out };
    }

    if (ev.type === "error") {
      next.finished = true;
      return {
        state: next,
        events: [
          { stage: "item", url: next.url, ok: false, score: null },
          { stage: "error", error: composeFailureNotice({ msg: ev.msg, errLine: next.errLine }) },
        ],
      };
    }

    // tool / keepalive / phase 之外的未知类型：单任务链路里 popup 不消费逐工具步骤
    // （要看步骤去 /jobs/{id}，那里从台账重建），丢弃即最小映射的本义。
    return { state: next, events: [] };
  }

  var api = {
    CAP_SINGLE_EVAL_INLINE_JD: CAP_SINGLE_EVAL_INLINE_JD,
    pickEvalRoute: pickEvalRoute,
    createRunState: createRunState,
    consumeRunEvent: consumeRunEvent,
    composeFailureNotice: composeFailureNotice,
    lastVerdict: lastVerdict,
  };

  // service worker（经典脚本，background.js 经 importScripts 引入）：挂 self。
  if (typeof self !== "undefined" && self && !self.__careerOpsSingleEvalPure) {
    self.__careerOpsSingleEvalPure = api;
  }
  // node 单测：module.exports 守卫（同 badge-pure.js / wrapup-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

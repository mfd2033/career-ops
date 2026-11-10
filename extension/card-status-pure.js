// card-status-pure.js — 列表卡片「状态胶囊 + 分数胶囊」的纯逻辑层。
//
// 三站（BOSS / 猎聘 / 智联）的列表卡与收藏卡共用同一套胶囊口径，差异只在挂载点
// （谁家的卡片骨架长什么样）——那部分留在 site-*.js 的 cardActionMounts 里。这里
// 只回答「这张卡该显示哪几颗胶囊、能不能点」：
//   • 状态胶囊：已申请 / 已回复 / 面试中 / 录用通知 …… 文案与取色来自
//     detail-panel-pure.js 的 STATUS_DICT（由调用方 resolve 好再传进来，本文件不
//     持有第二份字典）；
//   • 分数胶囊：纯分数（`4.3/5`），颜色由调用方按既有分档规则算好；
//   • 临时态：评估中 / 排队中顶掉状态胶囊、保留分数胶囊，且**可点** —— 点了跳
//     web 端工作器里对应的那条任务。
//
// 两条不重复的口径：
//   1. `Evaluated` 不出状态胶囊 —— 分数胶囊本身就是「已评估」的结论，再贴一颗
//      「已评估」等于同一条信息说两遍；
//   2. tracker 行没有状态值时同样不出状态胶囊（老行/状态列为空），同上。
//
// 之所以抽成纯函数：胶囊的组合规则（谁顶掉谁、什么时候可点、↗ 后缀跟不跟）在真实
// 招聘站页面上几乎没法稳定复现 —— 既要等评估真正进池、又要在卡片被站点重渲染时
// 抢在同一帧里观察，只有纯函数才测得起（同 detail-panel-pure.js / report-target-pure.js
// 的口径）。
//
// content script 侧经 self.__careerOpsCardStatusPure 取用；node 单测经 module.exports
// 守卫直接 import。本文件严禁引用 chrome / window / document / location。

(function () {
  "use strict";

  // 临时态取色：与 web 端工作器卡片同源（running 蓝、queued 中性灰）。不新增色板。
  const RUN_RUNNING_COLOR = "#4aa3ff";
  const RUN_QUEUED_COLOR = "#8a8f98";
  // 可点胶囊的文字后缀：整颗胶囊没有别的位置能挂图标，`↗` 是唯一的可点暗示
  // （悬停变手型 + 下划线由 DOM 侧补）。
  const RUN_LINK_SUFFIX = " ↗";
  const RUN_RUNNING_TEXT = "评估中";
  const RUN_QUEUED_TEXT = "排队中";
  // 与 tracker/states.yml 的规范码同名，仅用于「别重复贴已评估」这一条判断。
  const EVALUATED_RAW = "evaluated";

  /**
   * 临时态码归一并校验：只认 running / queued，其余（含空值）返回 null。
   * @param {string|null|undefined} status
   * @returns {"running"|"queued"|null}
   */
  function isRunState(status) {
    const v = typeof status === "string" ? status.trim().toLowerCase() : "";
    return v === "running" || v === "queued" ? v : null;
  }

  /** 状态胶囊：临时态优先（顶掉 tracker 状态），其次 tracker 状态，否则没有。 */
  function statusChip(p = {}) {
    const state = isRunState(p.run && p.run.status);
    if (state) {
      const running = state === "running";
      return {
        kind: "run",
        text: (running ? RUN_RUNNING_TEXT : RUN_QUEUED_TEXT) + RUN_LINK_SUFFIX,
        color: running ? RUN_RUNNING_COLOR : RUN_QUEUED_COLOR,
        clickable: true,
        runId: (p.run && p.run.runId) || null,
        title: "在 Worker 列表里打开这个任务",
      };
    }
    const st = p.status;
    if (!st || typeof st.raw !== "string" || !st.raw.trim()) return null;
    if (st.raw.trim().toLowerCase() === EVALUATED_RAW) return null; // 分数胶囊已表达
    return {
      kind: "status",
      text: st.text,
      color: st.color,
      clickable: false,
      runId: null,
      title: st.title || `状态：${st.raw}`,
    };
  }

  /**
   * 分数胶囊：完整评估优先（可点开报告），其次快评（只读、无报告可开）。
   * 颜色不在这里算 —— 分档规则归 core.js 的 scoreColor / detail-panel-pure 的
   * scoreBand，调用方把色一起传进来，避免同一个分数在浮窗与卡片上是两种颜色。
   */
  function scoreChip(p = {}) {
    const full = p.score;
    if (full && typeof full.text === "string" && full.text.trim()) {
      const reportNum = full.reportNum == null ? null : String(full.reportNum).trim();
      return {
        kind: "score",
        text: full.text.trim(),
        color: full.color,
        clickable: !!reportNum,
        reportNum: reportNum || null,
        title: reportNum ? `点击打开报告 #${reportNum}` : "评估分数",
      };
    }
    const quick = p.quick;
    if (quick && quick.score != null && Number.isFinite(Number(quick.score))) {
      return {
        kind: "score",
        text: `${Number(quick.score)}/5`,
        // 快评是另一条通道（秒出、只读、不写 tracker）：沿用「与快评按钮同色」的
        // 既有口径，不与完整评估的分档色混成一片。
        color: quick.color,
        clickable: false,
        reportNum: null,
        title: quick.grade
          ? `快评：${quick.grade}${quick.reason ? ` — ${quick.reason}` : ""}`
          : "快评分数",
      };
    }
    return null;
  }

  /**
   * 一张卡该显示的两颗胶囊（顺序：状态在前、分数在后）。
   * @param {object} [p]
   * @param {?{raw:string, text:string, color:string, title?:string}} [p.status] 已 resolve 的 tracker 状态
   * @param {?{text:string, color:string, reportNum?:string|number}} [p.score] 完整评估分数
   * @param {?{score:number, grade?:string, reason?:string, color:string}} [p.quick] 快评分
   * @param {?{status:string, runId:string}} [p.run] /api/active-runs 里同 URL 的任务
   * @returns {{status:(object|null), score:(object|null)}}
   */
  function cardChips(p = {}) {
    return { status: statusChip(p), score: scoreChip(p) };
  }

  /**
   * 幂等指纹：MutationObserver 在懒加载页打得很密，胶囊内容没变就不该重建节点。
   * 只纳入「看得见」与「点了会去哪」两类事实 —— title 之类的提示文案变了不必重绘。
   */
  function chipFingerprint(chips) {
    const one = (c) =>
      c ? `${c.kind}:${c.text}:${c.color}:${c.clickable ? 1 : 0}:${c.runId || c.reportNum || ""}` : "-";
    return `${one(chips && chips.status)}|${one(chips && chips.score)}`;
  }

  // ---- 点击闸门与收尾轮询裁决（完整评估同 URL 单飞配套） ----------------------
  //
  // 扩展不再全局单飞：服务端全局并发池满员时 FIFO 入队（ADR-0014），第二张卡的
  // 「评估」照常派发，卡片凭 /api/active-runs 出「评估中 / 排队中」胶囊。闸门只挡
  // 同一 URL 重复派发（另一张同职位卡 / 按钮被站点重渲染重建后 disabled 丢失）。
  // 2026-11-10 个人中心「感兴趣」列表实测出两个真缺陷：
  //   • 第一份评估在跑时点第二张卡的「评估」被全局单飞无声吞掉 —— 像按钮坏了；
  //   • 收尾轮询 12min 到期只停轮询不解锁 —— 单飞锁永久卡死，之后所有「评估」
  //     点击永远无反应。
  // 两处决策都在真实页面上无法稳定复现（要等评估真在跑/真超时），故抽到这里钉住。

  // 收尾轮询上限（次）。3s/次 × 240 = 12min，与 core.js 原有上限同值。
  const EVAL_POLL_MAX_TRIES = 240;
  const EVAL_BUSY_TOAST = "该职位的评估已在进行中，请等它完成";
  const EVAL_POLL_EXPIRED_TOAST = "等待评估结果超时，按钮已恢复；任务可能仍在后台运行";

  /**
   * 卡片「评估」点击闸门：这次点击放不放行、要不要说话。
   * 按钮自身禁用（文案就是「评估中…」）时不重复 toast —— 可见状态已足够；
   * 同一 URL 已在评估（跨卡/重建按钮）时挡下并开口；其余一律放行交给并发池排队。
   * @param {{btnDisabled?: boolean, urlInFlight?: boolean}} [p]
   * @returns {{allow: boolean, toast: string|null}}
   */
  function cardEvalGate(p) {
    const btnDisabled = !!(p && p.btnDisabled);
    const urlInFlight = !!(p && p.urlInFlight);
    if (btnDisabled || urlInFlight) {
      return { allow: false, toast: btnDisabled ? null : EVAL_BUSY_TOAST };
    }
    return { allow: true, toast: null };
  }

  /**
   * 收尾轮询一次 tick 的到期裁决。到期不能只停轮询：必须同时 settle（解锁按钮）
   * 并告知用户，否则单飞锁永久卡死（见上方实测记录）。
   * @param {number} tries 已轮询次数（脏值一律视为未到期）
   * @param {number} [max] 上限覆盖（测试注入用，缺省 EVAL_POLL_MAX_TRIES）
   * @returns {{stop: boolean, settle: boolean, toast: string|null}}
   */
  function evalPollVerdict(tries, max) {
    const cap = Number.isFinite(max) && max > 0 ? max : EVAL_POLL_MAX_TRIES;
    const n = Number(tries);
    if (Number.isFinite(n) && n >= cap) {
      return { stop: true, settle: true, toast: EVAL_POLL_EXPIRED_TOAST };
    }
    return { stop: false, settle: false, toast: null };
  }

  const api = {
    RUN_RUNNING_COLOR,
    RUN_QUEUED_COLOR,
    RUN_LINK_SUFFIX,
    EVAL_POLL_MAX_TRIES,
    isRunState,
    statusChip,
    scoreChip,
    cardChips,
    chipFingerprint,
    cardEvalGate,
    evalPollVerdict,
  };

  // content script（页面全局）：挂 self。
  if (typeof self !== "undefined" && self && !self.__careerOpsCardStatusPure) {
    self.__careerOpsCardStatusPure = api;
  }
  // node 单测：module.exports 守卫（同 detail-panel-pure.js 口径）。
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})();

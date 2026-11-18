// followup-settle-bar.js — 「自动跟进」发送成功后停在招聘页时的倒计时条（三站）。
//
// 只做一件事：SW 通知「已发出，停留 N 毫秒」，就在页面顶部居中浮出一条胶囊。
// 底衬进度条随时间从满到空，秒数每秒翻动；用户点「留在本页」即发
// followup-settle-stop 取消这次自动切回（SW 收到后结束停留、不回面板）。
// 5 秒走完条自己退场，SW 那边同时结束停留并切回面板。
//
// 为什么必须在招聘站页面上：这 5 秒里用户视线在聊天窗，页面被切到后台会打断
// 站点的提交收尾；能不能中断、还剩多久，只有在这一侧才看得见。
//
// 视觉沿用 core.js 的深色浮层口径（#1f2329 + 白色 8% 描边按钮），圆角用 G3-B：
// 胶囊端头 18px、按钮 11px，均叠加 corner-shape: squircle（Chromium 139+ 生效，
// 低版本静默退回普通圆角，不影响任何功能）。

(function () {
  "use strict";

  const BAR_ID = "career-ext-followup-settle";
  const STYLE_ID = "career-ext-followup-settle-style";
  const DEFAULT_MS = 5000;
  /** 结果提示（已取消 / 取消失败）留多久再淡出。 */
  const TIP_MS = 1600;

  const TEXT_SENDING = "已发送 · 5 秒后返回面板";
  const TEXT_STAY = "已取消返回 · 留在本页";
  const TEXT_CANCEL_FAILED = "取消未生效，稍后自动返回";
  const BTN_STAY = "留在本页";

  const CSS = `
#${BAR_ID}{
  position:fixed;top:14px;left:50%;translate:-50% 0;z-index:2147483647;
  width:max-content;max-width:calc(100vw - 32px);
  display:flex;align-items:center;gap:10px;
  padding:9px 12px 11px 14px;
  background:#1f2329;color:#f2f4f7;font-size:12.5px;line-height:1.4;
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  border-radius:18px;corner-shape:squircle;
  box-shadow:0 8px 22px rgba(0,0,0,.3);overflow:hidden;
  opacity:0;transform:translateY(-14px) scale(.96);
  transition:opacity .26s cubic-bezier(.32,.72,0,1),transform .34s cubic-bezier(.32,.72,0,1);
  will-change:opacity,transform;
}
#${BAR_ID}.is-in{opacity:1;transform:translateY(0) scale(1)}
#${BAR_ID}.is-out{opacity:0;transform:translateY(-10px) scale(.97);transition-duration:.2s}
#${BAR_ID}::after{
  content:"";position:absolute;top:0;bottom:0;left:-34%;width:34%;pointer-events:none;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.14),transparent);
  transform:translateX(-120%);
}
#${BAR_ID}.is-in::after{animation:career-settle-sweep .85s .12s cubic-bezier(.4,0,.2,1) 1}
@keyframes career-settle-sweep{to{transform:translateX(420%)}}
#${BAR_ID} .career-settle-dot{
  width:7px;height:7px;flex:0 0 auto;border-radius:999px;background:hsl(26 73% 51%);
  animation:career-settle-pulse 2s infinite;
}
@keyframes career-settle-pulse{
  0%{box-shadow:0 0 0 0 hsl(26 73% 51% / .5)}
  70%{box-shadow:0 0 0 7px hsl(26 73% 51% / 0)}
  100%{box-shadow:0 0 0 0 hsl(26 73% 51% / 0)}
}
#${BAR_ID} .career-settle-text{white-space:nowrap}
#${BAR_ID} .career-settle-count{
  color:#9aa3ad;font-variant-numeric:tabular-nums;min-width:22px;display:inline-block;
}
#${BAR_ID} .career-settle-count.is-bump{animation:career-settle-bump .18s ease-out}
@keyframes career-settle-bump{
  from{opacity:.35;transform:translateY(-3px)}
  to{opacity:1;transform:translateY(0)}
}
#${BAR_ID} .career-settle-btn{
  border:1px solid rgba(255,255,255,.3);background:rgba(255,255,255,.08);color:#fff;
  border-radius:11px;corner-shape:squircle;padding:4px 12px;
  font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;
  font-family:inherit;
  transition:background .15s ease,transform .12s ease;
}
#${BAR_ID} .career-settle-btn:hover{background:rgba(255,255,255,.16)}
#${BAR_ID} .career-settle-btn:active{transform:scale(.96)}
#${BAR_ID} .career-settle-btn:disabled{cursor:default;opacity:.6}
#${BAR_ID} .career-settle-track{
  position:absolute;left:0;right:0;bottom:0;height:2px;background:rgba(255,255,255,.12);
}
#${BAR_ID} .career-settle-fill{
  display:block;height:100%;width:100%;background:hsl(26 73% 51%);
  transform-origin:left center;transform:scaleX(1);
}
@media (prefers-reduced-motion:reduce){
  #${BAR_ID},#${BAR_ID}.is-in,#${BAR_ID}.is-out{opacity:1;transform:none;transition:none}
  #${BAR_ID}::after{animation:none !important}
  #${BAR_ID} .career-settle-dot{animation:none}
  #${BAR_ID} .career-settle-count.is-bump{animation:none}
}
`;

  let bar = null;
  let rafId = 0;
  let tickId = 0;
  let autoId = 0;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  function clearTimers() {
    if (rafId) cancelAnimationFrame(rafId);
    if (tickId) clearInterval(tickId);
    if (autoId) clearTimeout(autoId);
    rafId = 0;
    tickId = 0;
    autoId = 0;
  }

  function dismiss() {
    clearTimers();
    if (bar) {
      bar.remove();
      bar = null;
    }
  }

  /**
   * 落地结果：自动走完直接收掉；被用户取消时换成一句提示再消失，
   * 让「这次没切回去」有明确回执（否则用户会以为按钮没反应）。
   */
  function finish(mode) {
    if (!bar || bar.dataset.done === "1") return;
    const el = bar;
    el.dataset.done = "1";
    clearTimers();
    el.classList.remove("is-in");
    el.classList.add("is-out");

    const tip = mode === "stay" ? TEXT_STAY : mode === "cancel-failed" ? TEXT_CANCEL_FAILED : "";
    setTimeout(() => {
      if (bar !== el) return;
      if (!tip) {
        dismiss();
        return;
      }
      for (const sel of [".career-settle-btn", ".career-settle-count", ".career-settle-dot", ".career-settle-track"]) {
        const node = el.querySelector(sel);
        if (node) node.remove();
      }
      const text = el.querySelector(".career-settle-text");
      if (text) text.textContent = tip;
      el.classList.remove("is-out");
      void el.offsetWidth;
      el.classList.add("is-in");
      setTimeout(() => {
        if (bar !== el) return;
        el.classList.remove("is-in");
        el.classList.add("is-out");
        setTimeout(() => {
          if (bar === el) dismiss();
        }, 260);
      }, TIP_MS);
    }, 240);
  }

  function show(ms) {
    dismiss();
    const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : DEFAULT_MS;
    ensureStyle();

    const el = document.createElement("div");
    el.id = BAR_ID;
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");

    const dot = document.createElement("span");
    dot.className = "career-settle-dot";
    const text = document.createElement("span");
    text.className = "career-settle-text";
    text.textContent = TEXT_SENDING;
    const count = document.createElement("span");
    count.className = "career-settle-count";
    count.textContent = `${Math.ceil(total / 1000)}s`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "career-settle-btn";
    btn.textContent = BTN_STAY;
    const track = document.createElement("span");
    track.className = "career-settle-track";
    const fill = document.createElement("span");
    fill.className = "career-settle-fill";
    track.appendChild(fill);

    el.append(dot, text, count, btn, track);
    (document.body || document.documentElement).appendChild(el);
    bar = el;

    // 入场：下一帧再挂 is-in，transition 才有起点
    requestAnimationFrame(() => {
      if (bar === el) el.classList.add("is-in");
    });

    const startAt = performance.now();
    const paint = (now) => {
      if (bar !== el) return;
      const left = Math.max(0, total - (now - startAt));
      fill.style.transform = `scaleX(${left / total})`;
      rafId = requestAnimationFrame(paint);
    };
    rafId = requestAnimationFrame(paint);

    let leftSec = Math.ceil(total / 1000);
    tickId = setInterval(() => {
      if (bar !== el) return;
      leftSec -= 1;
      if (leftSec <= 0) {
        count.textContent = "0s";
        finish("auto");
        return;
      }
      count.textContent = `${leftSec}s`;
      count.classList.remove("is-bump");
      void count.offsetWidth;
      count.classList.add("is-bump");
    }, 1000);

    // 兜底：即使 rAF/interval 被页面节流，到点也一定收掉
    autoId = setTimeout(() => finish("auto"), total + 40);

    btn.addEventListener("click", () => {
      if (bar !== el) return;
      btn.disabled = true;
      chrome.runtime.sendMessage({ type: "followup-settle-stop" }, (res) => {
        const failed = Boolean(chrome.runtime.lastError) || !res || res.ok !== true;
        finish(failed ? "cancel-failed" : "stay");
      });
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "followup-settle") return undefined;
    show(msg.ms);
    return undefined;
  });
})();
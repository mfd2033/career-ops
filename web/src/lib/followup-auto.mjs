// 「自动跟进」的前端纯口径：三站表、话术压行、占位符枚举、备注模板。
//
// 与 extension/followup-send-pure.js 是同一份事实的两侧实现——内容脚本不能 import
// ES 模块，扩展又不能依赖 web 源码，只能各存一份。漂移由单测守：
// web/tests/lib/auto-followup.test.mjs 直接 require 扩展的纯模块，比对三站表与
// 压行结果，任一侧改了忘了另一侧就会红。
//
// 拆成 .mjs 是为了让 node --test 直接读（与 followup-channel.mjs 同口径）。

/** 能走自动发送的三站；host 后缀匹配，label 进备注与话术预览。 */
export const AUTO_SEND_SITES = [
  { id: "boss", label: "BOSS直聘", host: "zhipin.com" },
  { id: "liepin", label: "猎聘", host: "liepin.com" },
  { id: "zhaopin", label: "智联招聘", host: "zhaopin.com" },
];

/**
 * URL → 三站之一；其余站点（企业官网等）返回 null，调用方回落「复制话术 + 打开职位」。
 * 只认 http(s)，与「打开职位」按钮的可点条件同一口径。
 */
export function autoSiteForUrl(url) {
  if (typeof url !== "string" || !url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase();
  for (const site of AUTO_SEND_SITES) {
    if (host === site.host || host.endsWith(`.${site.host}`)) return site;
  }
  return null;
}

/**
 * 聊天框里回车=发送，所以多行话术压成一行再发。规则必须与扩展侧 joinMessage
 * 逐字一致（单测比对），否则「确认的文本」和「发出的文本」就不是同一句。
 */
export function toSingleLine(text) {
  return String(text == null ? "" : text)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\u3000]+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}

/** 还没替换掉的 `{占位符}`（去重、保序）；UI 用一行提示列出来。 */
export function placeholderTokens(text) {
  const out = [];
  const re = /\{[^{}]+\}/g;
  let m;
  while ((m = re.exec(String(text == null ? "" : text))) !== null) {
    if (!out.includes(m[0])) out.push(m[0]);
  }
  return out;
}

/** 备注模板：与扩展侧 autoNotes 同一条句子，发送成功后自动回填到记录里。 */
export function autoNotes(siteLabel) {
  const label = String(siteLabel || "").trim() || "招聘平台";
  return `${label}站内信发送跟进话术`;
}

# 中文招聘站提取规则（BOSS直聘 / 猎聘 / 智联）

> 触发在 `modes/_custom.md` House Rules，优先级高于任何 mode 默认。适用域名：zhipin.com / kanzhun.com / liepin.com / zhaopin.com。

## 1. 提取路径优先级：bsk 登录态浏览器 > WebSearch 检索层 > 如实报告拿不到

- URL 一律第一步 `node browser-extract.mjs <url> --extractor auto`：auto 对中文站自动走 bsk 登录态真实浏览器；可能弹验证码需手动处理；强制登录浏览器时显式 `--extractor bsk`；批量同理。
- 无头/未登录抓取的后果：三站把流量挡在验证码墙后，只得空白/loading 页，且内容残缺（缺任职要求、缺薪资/地点元信息）；「碰巧成功一次」会固化错误路径——因此 **禁止先发无头 Playwright / MCP / WebFetch 探测**。

## 2. bsk 失败即停、禁止推断（强制）

- `browser-extract.mjs` 以 `bsk_*` 错误码非零退出（如 `bsk_missing`）→ **立即停止**，让用户安装 browser-skill 并运行 `bsk status`。
- **绝不**从相似职位推断 JD——没有 JD 就如实说没有。

## 3. WAF/验证码兜底（检索层）

- 直连被 WAF/验证码拦截（如拉勾返回 `CF_APP_WAF` 验证页、猎聘返回「猎聘安全中心」）时，用 `WebSearch` 取搜索引擎**已收录**的 JD 正文，再用同公司猎聘帖 / 官网招聘页 / 职友集交叉印证。
- 2026-08-25 实测：WAF 绕不过抓取层，但检索层可完整取回 JD 并完成评估。局限：仅已收录内容，新发布 / 登录可见的 JD 仍可能缺失。

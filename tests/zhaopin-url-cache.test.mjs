// tests/zhaopin-url-cache.test.mjs
// 锁定智联列表卡「职位 URL 取不到」的修法（症状：点卡片「评估」弹「未能识别该职位的链接」）。
//
// 事实前提：搜索/推荐页卡片内没有职位 <a>，URL 只能来自主世界 positionList；扩展侧
// 读的是 html[data-zpstate] 缓存，而该缓存此前只在「采集」开始时写入，日常点击必然
// 取不到。修法把「取 URL」收敛成 ensureCardUrl：先读缓存，缺失就补一次再读。
//
//   S1: 缓存缺失时 cardUrl 返回 null（复现原症状，防止有人把补齐前行为当成正常）
//   S2: ensureCardUrl 补一次缓存后拿到规范 URL，并写入归属标记
//   S3: 缓存命中后不再打后台（第二次取 ≠ 第二次注入）
//   S4: 列表身份（path+query）变了，旧缓存作废并重新补 —— 不允许拿旧下标张冠李戴
//   S5: 并发补齐单飞（首屏 20 张卡同时缺 URL 只发一次注入）
//   S6: 后台失败时返回 null、不抛，并写入空缓存（下次仍会重试）
//
// Auto-discovered by test-all.mjs；用 pass/fail 上报，不自行 exit。

import { pass, fail } from './helpers.mjs';

const CARD_SELECTOR = 'div.job-card, div.joblist-box__item, div.scheduletab div.js-item';
const JOB_URL = 'https://www.zhaopin.com/jobdetail/CC698663920J40890192907.htm';

// ── 站点环境桩（site-zhaopin.js 走 node 分支时仍需 document/location）────────
const attrs = new Map();
const cards = Array.from({ length: 20 }, () => ({
  matches: () => false,
  closest: () => null,
  querySelector: () => null,
}));

globalThis.document = {
  documentElement: {
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => {
      attrs.set(k, v);
    },
  },
  querySelectorAll: () => cards,
  querySelector: (sel) => (sel === 'div.job-card' ? cards[0] : null),
};
globalThis.location = { pathname: '/jobs/', search: '?pageMode=recommend' };

const site = await import('../extension/site-zhaopin.js');
const {
  cardUrl,
  ensureCardUrl,
  ensureUrlCache,
  setZpTransport,
  getPositionList,
} = site.default || site;

console.log('\nzhaopin-url-cache — 列表卡 URL 缓存补齐');

// 可切换的 transport：记录调用次数，可模拟失败与异步（拉开并发窗口）
const transport = {
  calls: 0,
  ok: true,
  list: Array.from({ length: 20 }, () => ({ url: JOB_URL, name: 'IT研发负责人', city: '郑州' })),
  async: false,
};
setZpTransport((msg, cb) => {
  transport.calls += 1;
  const reply = transport.ok ? { ok: true, list: transport.list } : { ok: false, error: 'no state' };
  if (transport.async) setImmediate(() => cb(reply));
  else cb(reply);
});

function reset() {
  attrs.clear();
  transport.calls = 0;
  transport.ok = true;
  transport.async = false;
  globalThis.location = { pathname: '/jobs/', search: '?pageMode=recommend' };
}

// ── S1: 缓存缺失 → cardUrl null（原症状）───────────────────────────────
reset();
if (cardUrl(cards[0]) === null) pass('  S1 缓存缺失时 cardUrl 返回 null（复现「未能识别链接」）');
else fail(`  S1 缓存缺失却解析出 URL: ${cardUrl(cards[0])}`);

if (getPositionList().length === 0) pass('  S1 getPositionList 在无缓存时返回空数组');
else fail('  S1 getPositionList 无缓存时非空');

// ── S2: ensureCardUrl 补缓存后取到 URL ────────────────────────────────
reset();
const url2 = await ensureCardUrl(cards[0]);
if (url2 === JOB_URL) pass('  S2 ensureCardUrl 补一次缓存后返回规范 URL');
else fail(`  S2 ensureCardUrl 返回 ${JSON.stringify(url2)}`);

if (transport.calls === 1) pass('  S2 补齐只发一次后台注入');
else fail(`  S2 后台注入次数 ${transport.calls}`);

const cached = attrs.get('data-zpstate');
if (cached && JSON.parse(cached)[0].url === JOB_URL) pass('  S2 缓存写入 data-zpstate');
else fail('  S2 data-zpstate 未按预期写入');

if (attrs.get('data-zpstate-key') === '/jobs/?pageMode=recommend') pass('  S2 缓存写入归属标记（列表身份）');
else fail(`  S2 归属标记异常: ${attrs.get('data-zpstate-key')}`);

// ── S3: 缓存命中不再打后台 ─────────────────────────────────────────────
const url3 = await ensureCardUrl(cards[5]);
if (url3 === JOB_URL && transport.calls === 1) pass('  S3 缓存命中时不再请求后台');
else fail(`  S3 url=${JSON.stringify(url3)} calls=${transport.calls}`);

// ── S4: 列表身份变化 → 旧缓存作废并重补 ───────────────────────────────
globalThis.location = { pathname: '/jobs/', search: '?pageMode=recommend&page=2' };
if (cardUrl(cards[0]) === null) pass('  S4 列表身份变化后旧缓存不再被采用（防下标错位）');
else fail('  S4 旧缓存仍被跨页采用');

const url4 = await ensureCardUrl(cards[0]);
if (url4 === JOB_URL && transport.calls === 2) pass('  S4 身份变化后重新补一次缓存');
else fail(`  S4 url=${JSON.stringify(url4)} calls=${transport.calls}`);

// ── S5: 并发单飞 ──────────────────────────────────────────────────────
reset();
transport.async = true;
const before5 = transport.calls;
const [u5a, u5b] = await Promise.all([ensureCardUrl(cards[0]), ensureCardUrl(cards[1])]);
if (u5a === JOB_URL && u5b === JOB_URL) pass('  S5 并发两张卡都能取到 URL');
else fail(`  S5 并发取值异常: ${JSON.stringify([u5a, u5b])}`);
if (transport.calls - before5 === 1) pass('  S5 并发补齐单飞：只发一次后台注入');
else fail(`  S5 并发补齐打了 ${transport.calls - before5} 次后台`);

// ── S6: 后台失败不抛错 ────────────────────────────────────────────────
reset();
transport.ok = false;
let threw = null;
let url6 = 'unset';
try {
  url6 = await ensureCardUrl(cards[0]);
} catch (e) {
  threw = e;
}
if (!threw && url6 === null) pass('  S6 后台失败时返回 null 且不抛');
else fail(`  S6 threw=${threw && threw.message} url=${JSON.stringify(url6)}`);

// 失败后允许下次点击再试：缓存仍为空，ensureCardUrl 会重新请求
transport.ok = true;
const url6b = await ensureCardUrl(cards[0]);
if (url6b === JOB_URL) pass('  S6 失败后再次点击能重试成功（不是死路）');
else fail(`  S6 重试返回 ${JSON.stringify(url6b)}`);

// ── S7: 收藏卡/求职进展卡不触发 positionList 补齐 ─────────────────────
reset();
const collectCard = {
  matches: (sel) => sel === 'div.joblist-box__item',
  closest: () => null,
  querySelector: () => null,
};
const before7 = transport.calls;
const url7 = await ensureCardUrl(collectCard);
if (url7 === null && transport.calls === before7) pass('  S7 收藏卡取不到锚点时不去补 positionList');
else fail(`  S7 url=${JSON.stringify(url7)} calls=${transport.calls - before7}`);

// 守卫：选择器常量与站点一致（防止测试桩与实现漂移后失去意义）
if (site.default?.ZHAOPIN_SITE?.cardSelector === CARD_SELECTOR || site.ZHAOPIN_SITE?.cardSelector === CARD_SELECTOR) {
  pass('  S7 测试桩选择器与 ZHAOPIN_SITE.cardSelector 一致');
} else {
  fail('  S7 测试桩选择器与 ZHAOPIN_SITE.cardSelector 已漂移');
}

// ── S8: 非搜索/推荐页（无 div.job-card 骨架）不白发注入 ────────────────
reset();
const realQuerySelector = document.querySelector;
document.querySelector = () => null; // 收藏页 / 求职进展页：没有 positionList 语义
const before8 = transport.calls;
const ok8 = await ensureUrlCache();
document.querySelector = realQuerySelector;
if (ok8 === false && transport.calls === before8) pass('  S8 非搜索骨架页补缓存直接跳过，不打后台');
else fail(`  S8 ok=${ok8} calls=${transport.calls - before8}`);

setZpTransport(null);
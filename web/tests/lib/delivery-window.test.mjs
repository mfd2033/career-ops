// 投递时机（CO-44 / ADR-0085）的纯逻辑测试 —— 直接引 delivery-window.mjs（生产同一份）。
// 每条断言都把《投简历黄金时间指南-20261010》里的一格矩阵写成可执行口径：
// 改矩阵数据表时，这里会立刻指出哪条规律变了。
//
// Run:  node --test tests/lib/delivery-window.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAY_TYPES,
  PLATFORMS,
  dayTypeOf,
  formatMinutes,
  nextWindow,
  summarize,
  windowAt,
  windowsFor,
} from "../../src/lib/delivery-window.mjs";
import { sourceLabel, sourcePlatform } from "../../src/lib/source-label.mjs";

// 2026-10-19 是周一，当天起一周的各日型都覆盖到（本地时间构造，不碰 UTC）。
const at = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute);
const MON = 19;
const TUE = 20;
const WED = 21;
const THU = 22;
const FRI = 23;
const SAT = 24;
const SUN = 25;

test("日型映射：周一 / 周二~周四 / 周五 / 周六日", () => {
  assert.equal(dayTypeOf(at(MON, 10)), "mon");
  for (const day of [TUE, WED, THU]) assert.equal(dayTypeOf(at(day, 10)), "midweek");
  assert.equal(dayTypeOf(at(FRI, 10)), "fri");
  assert.equal(dayTypeOf(at(SAT, 10)), "weekend");
  assert.equal(dayTypeOf(at(SUN, 10)), "weekend");
});

test("矩阵完整性：每个平台每天型的时段首尾相接、覆盖 00:00–24:00", () => {
  for (const platform of PLATFORMS) {
    for (const dayType of DAY_TYPES) {
      const rows = windowsFor(platform, dayType);
      assert.ok(rows.length > 0, `${platform}/${dayType} 不能为空`);
      assert.equal(rows[0].start, 0, `${platform}/${dayType} 必须从 00:00 起`);
      assert.equal(rows[rows.length - 1].end, 1440, `${platform}/${dayType} 必须到 24:00`);
      for (let i = 1; i < rows.length; i++) {
        assert.equal(rows[i].start, rows[i - 1].end, `${platform}/${dayType} 第 ${i} 行与前一行不衔接`);
      }
    }
  }
});

test("Boss直聘：工作日白天黄金、周末只有晚间黄金、深夜避开", () => {
  assert.equal(windowAt("boss", at(TUE, 10)).level, "best"); // 09:00–11:00 上午黄金
  assert.equal(windowAt("boss", at(TUE, 15)).level, "best"); // 14:00–17:00 下午黄金
  assert.equal(windowAt("boss", at(TUE, 20)).level, "best"); // 19:00–22:00 晚间高峰
  assert.equal(windowAt("boss", at(TUE, 8)).level, "ok"); // 07:00–09:00 早起
  assert.equal(windowAt("boss", at(SAT, 10)).level, "ok"); // 周末白天只是「可以」
  assert.equal(windowAt("boss", at(SAT, 20)).level, "best"); // 周末晚间仍是高峰
  assert.equal(windowAt("boss", at(TUE, 3)).level, "avoid"); // 深夜不投
});

test("猎聘/智联：只认工作日，午休与 18:00 后避开，周末全线避开", () => {
  assert.equal(windowAt("liepin", at(TUE, 10)).level, "best"); // 周二~周四上午黄金
  assert.equal(windowAt("liepin", at(TUE, 15)).level, "best"); // 周二~周四下午黄金
  assert.equal(windowAt("liepin", at(MON, 10)).level, "ok"); // 周一开晨会，只是「可以」
  assert.equal(windowAt("liepin", at(FRI, 10)).level, "ok"); // 周五同上
  assert.equal(windowAt("liepin", at(TUE, 13)).level, "avoid"); // 午休
  assert.equal(windowAt("liepin", at(TUE, 21)).level, "avoid"); // 下班后
  assert.equal(windowAt("liepin", at(FRI, 17)).level, "avoid"); // 周五下午收尾
  assert.equal(windowAt("liepin", at(SAT, 10)).level, "avoid"); // 周末积压
  assert.equal(windowAt("liepin", at(SUN, 15)).level, "avoid");
});

test("智联与猎聘共用同一张矩阵", () => {
  for (const day of [MON, TUE, FRI, SAT]) {
    for (const hour of [3, 8, 10, 11, 13, 15, 17, 21]) {
      const now = at(day, hour);
      assert.equal(
        windowAt("zhaopin", now).level,
        windowAt("liepin", now).level,
        `${day} 日 ${hour} 点两平台口径不一致`,
      );
    }
  }
});

test("未知平台回退成整日避开，不抛异常", () => {
  assert.deepEqual(windowsFor("unknown", "mon"), []);
  assert.equal(windowAt("unknown", at(TUE, 10)).level, "avoid");
});

test("formatMinutes：补零，1440 记作 24:00", () => {
  assert.equal(formatMinutes(0), "00:00");
  assert.equal(formatMinutes(570), "09:30");
  assert.equal(formatMinutes(1440), "24:00");
});

test("nextWindow：已在黄金窗口内时返回当前窗口并标记 current", () => {
  const next = nextWindow("boss", at(TUE, 10, 30));
  assert.equal(next.current, true);
  assert.equal(next.dayOffset, 0);
  assert.equal(next.startMin, 540); // 09:00
  assert.equal(next.endMin, 660); // 11:00
});

test("nextWindow：同一天向前找下一段黄金", () => {
  // 午休 12:00–14:00 只是「可以」，下一段黄金是 14:00 的下午高峰
  const next = nextWindow("boss", at(TUE, 12, 30));
  assert.equal(next.current, false);
  assert.equal(next.dayOffset, 0);
  assert.equal(formatMinutes(next.startMin), "14:00");
});

test("nextWindow：跨天找到下一段黄金（猎聘周五深夜 → 下周二上午）", () => {
  const next = nextWindow("liepin", at(FRI, 23));
  assert.equal(next.dayOffset, 4); // 周六、周日、周一都无 best，落在下周二
  assert.equal(formatMinutes(next.startMin), "09:30");
});

test("nextWindow：前瞻窗口不够时返回 null，而不是编一个窗口", () => {
  assert.equal(nextWindow("liepin", at(FRI, 23), { horizonDays: 1 }), null);
});

test("summarize：三个平台都在黄金时段 → send，并给出最早的黄金窗口", () => {
  const s = summarize(at(TUE, 10));
  assert.equal(s.action, "send");
  assert.equal(s.clock, "10:00");
  assert.equal(s.dayType, "midweek");
  assert.deepEqual(s.platforms.map((p) => p.level), ["best", "best", "best"]);
  assert.equal(s.nextGold.platform, "boss"); // 09:00 起，比猎聘/智联的 09:30 更早
  assert.equal(s.nextGold.current, true);
});

test("summarize：只有 Boss 周末白天可投 → ok", () => {
  const s = summarize(at(SAT, 12));
  assert.equal(s.action, "ok");
  assert.deepEqual(s.platforms.map((p) => p.level), ["ok", "avoid", "avoid"]);
  assert.equal(s.nextGold.platform, "boss");
  assert.equal(s.nextGold.dayOffset, 0); // 当晚 19:00 就是 Boss 的黄金时段
  assert.equal(formatMinutes(s.nextGold.startMin), "19:00");
});

test("summarize：周六凌晨三平台都避开 → wait", () => {
  const s = summarize(at(SAT, 3));
  assert.equal(s.action, "wait");
  assert.deepEqual(s.platforms.map((p) => p.level), ["avoid", "avoid", "avoid"]);
});

test("summarize：周一上午猎聘/智联只是「可以」→ ok", () => {
  const s = summarize(at(MON, 13));
  assert.equal(s.action, "ok");
  assert.deepEqual(s.platforms.map((p) => p.level), ["ok", "avoid", "avoid"]);
});

// ── UI 接线守卫（组件无测试面，同 ADR-0077）：键对称 + 挂载点存在 ──
const here = dirname(fileURLToPath(import.meta.url));

test("i18n：delivery 语料簇 en/zh 键集合对称且同序", () => {
  const src = readFileSync(join(here, "../../src/lib/i18n/clusters/delivery.ts"), "utf8");
  const keys = [...src.matchAll(/"([^"]+)":\s*"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0 && keys.length % 2 === 0, "语料簇应分成 en/zh 两块等量键");
  const half = keys.length / 2;
  assert.deepEqual(keys.slice(0, half), keys.slice(half));
});

test("组件接线：管道页页头挂上了投递时机条，且文案全部走 delivery.* 键", () => {
  const view = readFileSync(join(here, "../../src/components/pipeline-view.tsx"), "utf8");
  assert.match(view, /import \{ DeliveryTimeHint \} from "@\/components\/delivery-time-hint"/);
  assert.match(view, /<DeliveryTimeHint \/>/);

  const hint = readFileSync(join(here, "../../src/components/delivery-time-hint.tsx"), "utf8");
  assert.match(hint, /summarize\(now\)/);
  // 文案一律走 i18n：把中文注释剔除后，组件正文不应再出现中文。
  const code = hint.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /[\u4e00-\u9fa5]/, "组件正文不应含硬编码中文（注释除外）");
});

test("组件接线：报告详情页只显示「该报告来源平台」的建议（/pipeline/{n} 与 /report/{n} 共用 ReportView）", () => {
  const reportView = readFileSync(join(here, "../../src/components/report-view.tsx"), "utf8");
  assert.match(reportView, /import \{ DeliveryTimeHint \} from "@\/components\/delivery-time-hint"/);
  // 必须把来源平台传下去：不传就退回三平台视角，针对性就没了。
  assert.match(reportView, /<DeliveryTimeHint platforms=\{deliveryPlatform \? \[deliveryPlatform\] : \[\]\} \/>/);
  assert.match(reportView, /const deliveryPlatform = sourcePlatform\(url\)/);
  // 两条路由都渲染 ReportView，所以挂在这一层就同时覆盖详情页与深链页。
  for (const route of ["../../src/app/pipeline/[id]/page.tsx", "../../src/app/report/[id]/page.tsx"]) {
    assert.match(readFileSync(join(here, route), "utf8"), /<ReportView\b/);
  }
});

// ── 平台来源还原（source-label.mjs）：详情页只按这一套认平台 ──
test("sourcePlatform：三个有矩阵的平台各自识别，其余来源一律 null", () => {
  assert.equal(sourcePlatform("https://www.zhipin.com/job_detail/abc.html"), "boss");
  assert.equal(sourcePlatform("https://www.liepin.com/job/1234.shtml"), "liepin");
  assert.equal(sourcePlatform("https://jobs.zhaopin.com/CC123.htm"), "zhaopin");
  // 有标签但没矩阵：拉勾/ATS 不套别家口径
  assert.equal(sourcePlatform("https://www.lagou.com/jobs/123.html"), null);
  assert.equal(sourcePlatform("https://boards.greenhouse.io/acme/jobs/1"), null);
  // 未知域名、空值、非法 URL
  assert.equal(sourcePlatform("https://careers.example.com/123"), null);
  assert.equal(sourcePlatform(""), null);
  assert.equal(sourcePlatform(null), null);
  assert.equal(sourcePlatform("not-a-url"), null);
  // 子串不能误伤（域名后缀匹配）
  assert.equal(sourcePlatform("https://notzhipin.com/job/1"), null);
  // 源标签本身仍照旧（两套映射同源，不漂）
  assert.equal(sourceLabel("https://www.zhipin.com/job_detail/abc.html"), "BOSS直聘");
});

test("summarize：只看指定平台——猎聘的职位不会拿 Boss 的时段做结论", () => {
  // 周六 20:00：Boss 晚间黄金，猎聘/智联周末全避开
  const all = summarize(at(SAT, 20));
  assert.equal(all.action, "send"); // 三平台视角：能投（因为 Boss）

  const liepinOnly = summarize(at(SAT, 20), { platformIds: ["liepin"] });
  assert.equal(liepinOnly.platforms.length, 1);
  assert.equal(liepinOnly.platforms[0].platform, "liepin");
  assert.equal(liepinOnly.action, "wait"); // 来源是猎聘 → 周末就是不建议投
});

test("summarize：空平台列表/未知平台 id → 没有可判平台（调用方改说「无规律」）", () => {
  for (const platformIds of [[], ["greenhouse"], ["bogus"]]) {
    const s = summarize(at(TUE, 10), { platformIds });
    assert.deepEqual(s.platforms, []);
    assert.equal(s.action, "wait");
    assert.equal(s.nextGold, null);
  }
});

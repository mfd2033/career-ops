// Tests for extractBrowserQuery() — the CLI scan_queries → browser-mode
// keyword seed. Imports directly from browser-search.mjs (single source of
// truth) so test and production code can never drift out of sync.
//
// Run:  node --test tests/lib/browser-search.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBrowserQuery, buildSearchUrls, expandSearchTargets, parseSalaryText, matchesBrowserSalary, isSalaryUnknown, browserToParams, applyBrowserSalaryGate, applyBrowserCityGate, applyBrowserTitleGate, effectiveBrowserCity, browserCityValue, ZH_CITY_ANY, cleanSalaryText } from "../../src/lib/browser-search.mjs";

// ── cleanSalaryText —— 字形反爬清洗（工单 03 缺陷修复）──

test("cleanSalaryText: 剥离 PUA 码点（BOSS 数字字体混淆），保留可读文本", () => {
  assert.equal(cleanSalaryText("\uE032\uE036-\uE034\uE031K"), "-K");
  assert.equal(cleanSalaryText("15-\uE0305K·14薪"), "15-5K·14薪");
  assert.equal(cleanSalaryText("20-35K·14薪"), "20-35K·14薪");
  assert.equal(cleanSalaryText("\uE032\uE036"), "");
  assert.equal(cleanSalaryText(undefined), "");
});

test("parseSalaryText: BOSS PUA 数字已在采集侧解码为 ASCII，web 侧直接可解析", () => {
  // 采集侧解码后的形态（15-30K / 20-30K·13薪）走正常解析路径
  assert.deepEqual(parseSalaryText("15-30K", "zhipin"), { minK: 15, maxK: 30 });
  assert.deepEqual(parseSalaryText("20-30K·13薪", "zhipin"), { minK: 20, maxK: 30 });
});

// ── browserToParams —— smin 编码（工单 02）──

test("browserToParams: 薪资下限编码为 smin，0/缺省省略", () => {
  assert.ok(browserToParams("项目经理", ["zhipin"], "郑州", 20).includes("smin=20"));
  assert.ok(!browserToParams("项目经理", ["zhipin"], "郑州", 0).includes("smin"));
  assert.ok(!browserToParams("项目经理", ["zhipin"], "郑州", undefined).includes("smin"));
  assert.ok(!browserToParams("项目经理", ["zhipin"], "郑州", -5).includes("smin"));
  // 小数保留 1 位
  assert.ok(browserToParams("项目经理", ["zhipin"], "", 22.25).includes("smin=22.3"));
});

test("drops site:/OR/city tokens and keeps every position keyword across OR groups", () => {
  assert.equal(
    extractBrowserQuery("site:zhipin.com 项目经理 郑州 OR 技术经理 郑州 OR IT项目经理 郑州"),
    "项目经理 技术经理 IT项目经理",
  );
});

test("typical first entry with liepin domain — city stripped, all groups kept", () => {
  assert.equal(
    extractBrowserQuery("site:liepin.com 项目经理 郑州 OR 技术经理 郑州 OR 软件项目经理 郑州"),
    "项目经理 技术经理 软件项目经理",
  );
});

test("no OR → keeps every non-site, non-city token", () => {
  assert.equal(extractBrowserQuery("site:zhaopin.com 技术经理 郑州"), "技术经理");
});

test("no site:, no OR → plain phrase passes with city dropped", () => {
  assert.equal(extractBrowserQuery("项目经理 郑州"), "项目经理");
});

test("site: token not at the front", () => {
  assert.equal(extractBrowserQuery("技术经理 郑州 site:liepin.com OR 测试"), "技术经理 测试");
});

test("case-insensitive OR — tokens across OR kept, city/descriptors remain", () => {
  assert.equal(extractBrowserQuery("软件工程师 site:a.com or 高级 or 资深"), "软件工程师 高级 资深");
});

test("empty / whitespace-only input → empty string", () => {
  assert.equal(extractBrowserQuery(""), "");
  assert.equal(extractBrowserQuery("   "), "");
  assert.equal(extractBrowserQuery(undefined), "");
  assert.equal(extractBrowserQuery(null), "");
});

test("only site: tokens → empty string", () => {
  assert.equal(extractBrowserQuery("site:zhipin.com site:liepin.com"), "");
});

test("site:-only first group → falls through and keeps later position keywords", () => {
  assert.equal(extractBrowserQuery("site:liepin.com OR 项目经理 郑州 OR 技术经理"), "项目经理 技术经理");
});

test("leading OR does not crash — yields the following phrase without city", () => {
  assert.equal(extractBrowserQuery("OR 项目经理 郑州"), "项目经理");
});

// ── buildSearchUrls / expandSearchTargets —— 多关键词展开与猎聘单关键词限制 ──

test("buildSearchUrls keeps one URL per source with OR-joined query", () => {
  const urls = buildSearchUrls(["zhipin", "liepin", "zhaopin"], "经理 OR 工程师", "郑州");
  assert.equal(urls.length, 3);
  for (const u of urls) assert.ok(u.includes("OR"), `期望 OR 保留在整串查询里: ${u}`);
});

test("expandSearchTargets splits liepin multi-keyword into one URL per word", () => {
  // 猎聘搜索框不支持 OR/空格分隔的多关键词 —— 逐词拆成多条搜索 URL。
  const targets = expandSearchTargets(["liepin"], "经理 OR 工程师 OR 架构师", "郑州");
  assert.equal(targets.length, 3);
  assert.ok(targets.every((t) => t.source === "liepin"));
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("经理"))), "含第一词 URL");
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("工程师"))), "含第二词 URL");
  assert.ok(targets.some((t) => t.url.includes(encodeURIComponent("架构师"))), "含第三词 URL");
});

test("expandSearchTargets keeps BOSS/zhaopin as a single OR-joined URL (they accept multi keywords)", () => {
  const targets = expandSearchTargets(["zhipin", "zhaopin"], "经理 OR 工程师", "郑州");
  assert.equal(targets.length, 2); // 每源仍一条
  for (const t of targets) assert.ok(t.url.includes("OR"));
});

test("expandSearchTargets mixes sources correctly without heal-order drift", () => {
  const targets = expandSearchTargets(["zhipin", "liepin"], "经理 OR 工程师", "");
  // order: zhipin×1, liepin×2
  assert.equal(targets.length, 3);
  assert.equal(targets[0].source, "zhipin");
  assert.equal(targets[1].source, "liepin");
  assert.equal(targets[2].source, "liepin");
});

test("expandSearchTargets empty liepin query degrades to a single national search", () => {
  const targets = expandSearchTargets(["liepin"], "  ", "郑州");
  assert.equal(targets.length, 1);
  assert.ok(targets[0].url.startsWith("https://www.liepin.com/zhaopin/?key="));
});

// ── parseSalaryText —— 薪资文本 → 月薪 K 区间（工单 01）──

test("parseSalaryText: BOSS K 区间按月薪直取，忽略「·14薪」系数", () => {
  assert.deepEqual(parseSalaryText("20-35K·14薪", "zhipin"), { minK: 20, maxK: 35 });
  assert.deepEqual(parseSalaryText("20-35K", "zhipin"), { minK: 20, maxK: 35 });
  assert.deepEqual(parseSalaryText("20K-35K", "zhipin"), { minK: 20, maxK: 35 });
});

test("parseSalaryText: 智联「万」按月薪 ×10 折算", () => {
  assert.deepEqual(parseSalaryText("1.5-2.5万·13薪", "zhaopin"), { minK: 15, maxK: 25 });
  assert.deepEqual(parseSalaryText("2万-3万", "zhaopin"), { minK: 20, maxK: 30 });
});

test("parseSalaryText: 猎聘裸「万」按年薪 ÷12 折算", () => {
  const r = parseSalaryText("20-35万", "liepin");
  assert.equal(r.minK, Math.round((200 / 12) * 10) / 10);
  assert.equal(r.maxK, Math.round((350 / 12) * 10) / 10);
  // 猎聘的 K 形态仍是月薪，不受万口径影响
  assert.deepEqual(parseSalaryText("15-25K·14薪", "liepin"), { minK: 15, maxK: 25 });
});

test("parseSalaryText: 显式「/年」「年薪」标记一律按年薪 ÷12，与站点无关", () => {
  const r = parseSalaryText("24-36万/年", "zhaopin");
  assert.equal(r.minK, 20);
  assert.equal(r.maxK, 30);
});

test("parseSalaryText: 单值形态取同值区间", () => {
  assert.deepEqual(parseSalaryText("30K", "zhipin"), { minK: 30, maxK: 30 });
  assert.deepEqual(parseSalaryText("2.5万", "zhaopin"), { minK: 25, maxK: 25 });
});

test("parseSalaryText: 非月薪口径与乱文本 → null（归入薪资未知）", () => {
  assert.equal(parseSalaryText("200-350元/天", "zhipin"), null);
  assert.equal(parseSalaryText("面议", "zhaopin"), null);
  assert.equal(parseSalaryText("", "liepin"), null);
  assert.equal(parseSalaryText(undefined, "zhaopin"), null);
  assert.equal(parseSalaryText("3个月", "zhipin"), null);
  assert.equal(parseSalaryText("100人", "zhaopin"), null);
});

test("parseSalaryText: 智联「元」月薪形态 ÷1000 折算（7000-8000元 → 7-8K）", () => {
  assert.deepEqual(parseSalaryText("7000-8000元", "zhaopin"), { minK: 7, maxK: 8 });
  assert.deepEqual(parseSalaryText("8000-14000元", "zhaopin"), { minK: 8, maxK: 14 });
  assert.deepEqual(parseSalaryText("8000元", "zhaopin"), { minK: 8, maxK: 8 });
  // 元/天等非月薪口径仍归未知，不受元月薪支持影响
  assert.equal(parseSalaryText("200-350元/天", "zhaopin"), null);
});

test("parseSalaryText: 未知站点来源的裸「万」按月薪保守处理", () => {
  assert.deepEqual(parseSalaryText("2-3万", ""), { minK: 20, maxK: 30 });
});

test("parseSalaryText: 混合单位区间各按自身单位折算（8千-1.2万）", () => {
  assert.deepEqual(parseSalaryText("8千-1.2万", "zhaopin"), { minK: 8, maxK: 12 });
  assert.deepEqual(parseSalaryText("20K-3.5万", "zhaopin"), { minK: 20, maxK: 35 });
});

// ── applyBrowserSalaryGate —— 两条驱动路径共享的门控组合（工单 03/04）──

test("applyBrowserSalaryGate: 丢弃不达标、保留达标、未知打标、门关时原样返回", () => {
  const jobs = [
    { salary: "10-18K", source: "zhipin" },
    { salary: "20-35K", source: "zhipin" },
    { salary: "", source: "zhaopin" },
    { salary: "面议", source: "liepin" },
  ];
  const gated = applyBrowserSalaryGate(jobs, 20);
  assert.equal(gated.length, 3); // 10-18K 丢弃，其余保留
  assert.equal(gated[0].salary, "20-35K");
  assert.equal(gated[0].salaryUnknown, undefined);
  assert.equal(gated[1].salaryUnknown, true); // 无薪资 → 打标
  assert.equal(gated[2].salaryUnknown, true);
  // 门关（0/缺省）→ 原数组原样返回（含不达标者）
  assert.equal(applyBrowserSalaryGate(jobs, 0).length, 4);
  assert.equal(applyBrowserSalaryGate(undefined, 20).length, 0);
});

test("applyBrowserSalaryGate: defaultSource 补上 bsk 列表行缺失的站点口径", () => {
  // bsk 列表行只有 {title,url,city,salary}——没有 source。薪资口径逐站不同
  // （猎聘裸「万」是年薪 ÷12，智联是月薪 ×10，工单 01），所以知道平台的一方必须
  // 把平台传进来。漏传 = 猎聘裸万按未知源（智联口径）×10 算成 200-350K，薪资下限
  // 对猎聘静默失效——这是本次修复钉住的回归点。
  const bskRows = [
    { title: "A", salary: "20-35万" }, // 猎聘年薪 → 16.7-29.2K
    { title: "B", salary: "12-18万" }, // 猎聘年薪 → 10-15K
  ];
  // 漏传 source：裸万按未知源（智联月薪口径）×10 → 两条上限都远超 40，全留下
  assert.equal(applyBrowserSalaryGate(bskRows, 40).length, 2);
  // 传上 liepin：按年薪 ÷12 → 两条上限（29.2 / 15）都不足 40，全部丢弃
  assert.equal(applyBrowserSalaryGate(bskRows, 40, "liepin").length, 0);
  // 下限落在区间内 → 只留达标那条，且原行其余字段不动
  const kept = applyBrowserSalaryGate(bskRows, 20, "liepin");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].title, "A");
  assert.equal(kept[0].salary, "20-35万");
});

test("applyBrowserSalaryGate: 行自带的 source 优先于 defaultSource", () => {
  const rows = [{ title: "A", salary: "30K", source: "zhipin" }];
  const gated = applyBrowserSalaryGate(rows, 20, "liepin");
  assert.equal(gated.length, 1);
  assert.equal(gated[0].source, "zhipin");
});

// ── matchesBrowserSalary —— 重叠判定门控（工单 01）──

test("matchesBrowserSalary: 区间上限 ≥ 薪资下限即保留（重叠判定）", () => {
  assert.equal(matchesBrowserSalary({ salary: "15-25K", source: "zhipin" }, 20), true);
  assert.equal(matchesBrowserSalary({ salary: "20-35K", source: "zhipin" }, 20), true);
  assert.equal(matchesBrowserSalary({ salary: "10-18K", source: "zhipin" }, 20), false);
});

test("matchesBrowserSalary: 无薪资/解析失败放行（薪资未知，不误删）", () => {
  assert.equal(matchesBrowserSalary({ salary: "", source: "zhipin" }, 20), true);
  assert.equal(matchesBrowserSalary({ salary: "面议", source: "zhaopin" }, 20), true);
  assert.equal(matchesBrowserSalary({}, 20), true);
  assert.equal(matchesBrowserSalary(undefined, 20), true);
});

test("matchesBrowserSalary: 薪资下限为 0/缺省时全放行（门未启用）", () => {
  assert.equal(matchesBrowserSalary({ salary: "10-18K", source: "zhipin" }, 0), true);
  assert.equal(matchesBrowserSalary({ salary: "10-18K", source: "zhipin" }, undefined), true);
});

test("matchesBrowserSalary: source 兼容 browser- 前缀（DiscoveredOffer.source 形态）", () => {
  // 猎聘裸万按年薪：20-35万 → ≈16.7-29.2K，上限 ≥ 20 保留
  assert.equal(matchesBrowserSalary({ salary: "20-35万", source: "browser-liepin" }, 20), true);
  // 12-18万（年薪）→ 10-15K，上限 < 20 丢弃
  assert.equal(matchesBrowserSalary({ salary: "12-18万", source: "browser-liepin" }, 20), false);
});

test("isSalaryUnknown: 无薪资或解析不出数值即未知（与门是否启用无关）", () => {
  assert.equal(isSalaryUnknown({ salary: "", source: "zhipin" }), true);
  assert.equal(isSalaryUnknown({ salary: "面议", source: "zhaopin" }), true);
  assert.equal(isSalaryUnknown({ salary: "200-350元/天", source: "zhipin" }), true);
  assert.equal(isSalaryUnknown({ salary: "20-35K", source: "zhipin" }), false);
});

// ── applyBrowserCityGate —— 城市门的列表级形态（两条 driver 共用，ADR-0029 决议 7）──
//
// 改动前城市门只接在 bsk 服务端路径上（逐职位埋在采集循环里），扩展路径只套了薪资
// 门——带城市条件的扩展扫描因此漏进异地卡片。列表级形态让两条 driver 用同一条组合
// 表达式，keep/drop 由同一段代码保证，而不是靠两处各自正确。

test("applyBrowserCityGate: 结构化城市字段优先，缺失回退 title，门关时原样返回", () => {
  const jobs = [
    { city: "郑州", title: "项目经理" },
    { city: "安庆", title: "叉车司机" }, // 异地——扩展路径改动前会漏进结果区
    { title: "IT项目管理 【 郑州-高新区 】 5-8k 3年以上 统招本科" }, // 无 city 字段，title 兜底
    { title: "财务主管 【 苏州-吴中区 】 10-15k" }, // 无 city 字段，title 不含目标城市
    { city: "郑州 金水区", title: "软件实施工程师" }, // 复合城市值
  ];
  const gated = applyBrowserCityGate(jobs, "郑州");
  assert.deepEqual(
    gated.map((j) => j.title),
    ["项目经理", "IT项目管理 【 郑州-高新区 】 5-8k 3年以上 统招本科", "软件实施工程师"],
  );
  // 门关（""/缺省）→ 原数组原样返回（含异地岗），与改动前的行为逐例一致
  assert.equal(applyBrowserCityGate(jobs, "").length, 5);
  assert.equal(applyBrowserCityGate(jobs, undefined).length, 5);
  assert.equal(applyBrowserCityGate(undefined, "郑州").length, 0);
});

test("采集门组合（薪资门 → 城市门）：顺序无关，空条件退化为恒等", () => {
  // browser-scan（服务端）与 explore-provider（页面侧）用的是同一条组合表达式。
  // 钉住它的两条性质：①两道门是互相独立的谓词，先后顺序不改变 keep 集合（任一侧
  // 即使内部调序也不会与另一侧分叉）；②任一条件为空即门关闭、组合退化为恒等——
  // 「城市条件留空」的行为因此不受接上城市门这件事影响（回落语义见工单 04）。
  const rows = [
    { title: "A", city: "郑州", salary: "20-35K", source: "zhipin" },
    { title: "B", city: "安庆", salary: "20-35K", source: "zhipin" },
    { title: "C", city: "郑州", salary: "8-10K", source: "zhipin" },
    { title: "D", city: "安庆", salary: "8-10K", source: "zhipin" },
    { title: "E", city: "郑州", salary: "面议", source: "zhipin" },
  ];
  const titles = (xs) => xs.map((x) => x.title);
  const salaryThenCity = applyBrowserCityGate(applyBrowserSalaryGate(rows, 20), "郑州");
  const cityThenSalary = applyBrowserSalaryGate(applyBrowserCityGate(rows, "郑州"), 20);
  assert.deepEqual(titles(salaryThenCity), titles(cityThenSalary));
  assert.deepEqual(titles(salaryThenCity), ["A", "E"]); // B/D 异地、C 薪资不达标
  // 两道门都关 → 恒等（含异地与不达标行）
  assert.equal(applyBrowserCityGate(applyBrowserSalaryGate(rows, 0), "").length, 5);
});

// ── 被毙原因（gate-visibility 工单 03）──────────────────────────────────────
// 规则牌要把「为什么被毙」说给人听。原因是门自己算出来的（buildTitleFilterExplained
// 的同一份编译结果），不是面板再判一遍——面板重判会在词表被编辑之后与事实不一致，而
// 那正是用户最需要信这条信息的时候。

test("applyBrowserTitleGate: 被毙条目带原因，说得出是被哪个词毙的", () => {
  const filter = { positive: ["软件", "技术"], negative: ["销售", "兼职"] };
  const jobs = [
    { title: "软件项目经理" },
    { title: "（高薪）软件/项目销售" },
    { title: "叉车司机" },
    { title: "兼职居家ERP 开发项目经理" },
    { title: "销售兼职" },
  ];
  const { kept, dropped } = applyBrowserTitleGate(jobs, filter);
  assert.deepEqual(kept.map((j) => j.title), ["软件项目经理"]);
  assert.equal("gateReason" in kept[0], false, "放行条目不该带原因");
  assert.deepEqual(
    dropped.map((j) => j.gateReason),
    [
      { type: "negative", words: ["销售"] },
      { type: "no-positive", words: [] },
      { type: "negative", words: ["兼职"] },
      { type: "negative", words: ["销售", "兼职"] },
    ],
    "命中的黑名单条目要全列（一条是一个否决，不是排序），「没命中白名单」是另一类原因——两者要对症下药，改法相反",
  );
  assert.deepEqual(dropped.map((j) => j.title), jobs.slice(1).map((j) => j.title), "被毙的仍按原序返回，offer 自己的字段都在");
});

test("applyBrowserTitleGate: 空词表不产生任何原因（不设约束）", () => {
  const none = applyBrowserTitleGate([{ title: "叉车司机" }], {});
  assert.equal(none.kept.length, 1);
  assert.equal(none.dropped.length, 0, "空 positive 是「不设约束」而不是「什么都不匹配」——这里若反了，原因会声称一个不存在的白名单没命中");
  const negOnly = applyBrowserTitleGate([{ title: "行政专员" }], { negative: ["行政"] });
  assert.deepEqual(negOnly.dropped[0].gateReason, { type: "negative", words: ["行政"] }, "只有黑名单时，原因仍是「被这个词毙掉」");
});

// ── applyBrowserTitleGate —— 标题门的列表级形态（ADR-0029 决议 1/2/3）──────
//
// 词表来源是 portals.yml 的 title_filter，判定走 web 镜像（parity 由根目录的
// tests/title-keywords-parity.test.mjs 守着），所以探索页与 CLI 扫描器对同一份
// 词表给出同一判定。与城市门/薪资门不同，这一道把被毙者留在 dropped 里——台账的
// skipped_title 与结果区的「已过滤」折叠区都从它取值。

const REAL_FILTER = {
  positive: ["软件", "技术", "信息化", "IT", "系统", "交付", "数据"],
  negative: ["销售", "行政", "技术员", "实习生", "兼职"],
};

test("applyBrowserTitleGate: positive 必命中、negative 一票否决，被毙者留在 dropped", () => {
  const jobs = [
    { title: "软件实施工程师" },
    { title: "叉车司机【安庆-迎江区】7-8k1-3年学历不限" },
    { title: "行政后勤/总务【上海-浦东新区】9-12k经验不限大专" },
    { title: "技术员" },
    { title: "（高薪）软件/项目销售" },
  ];
  const { kept, dropped } = applyBrowserTitleGate(jobs, REAL_FILTER);
  assert.deepEqual(kept.map((j) => j.title), ["软件实施工程师"]);
  assert.deepEqual(dropped.map((j) => j.title), [
    "叉车司机【安庆-迎江区】7-8k1-3年学历不限",
    "行政后勤/总务【上海-浦东新区】9-12k经验不限大专",
    "技术员",
    "（高薪）软件/项目销售",
  ]);
  // 一条也不能凭空消失：kept ∪ dropped 必须等于输入
  assert.equal(kept.length + dropped.length, jobs.length);
});

test("applyBrowserTitleGate: 匹配面是原始 title，不剥尾", () => {
  // 猎聘把城市/薪资/经验/学历 glue 在标题上，门控刻意照原样看（ADR-0029 决议 3）。
  // 这行的尾部不含任何 positive 词，故被毙——尾巴里出现 positive 词就会反过来救活它。
  const { kept, dropped } = applyBrowserTitleGate(
    [{ title: "财务主管 【 苏州-吴中区 】 10-15k" }],
    { positive: ["软件"] },
  );
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 1);
  const tail = applyBrowserTitleGate([{ title: "财务主管 【 苏州-吴中区 】 10-15k · 软件" }], { positive: ["软件"] });
  assert.equal(tail.kept.length, 1, "尾部命中即算命中——这正是「不剥尾」的代价，也由干跑清单量出");
});

test("applyBrowserTitleGate: 词表缺省/为空 = 不设约束，全部保留（绝不空转成整批否决）", () => {
  const jobs = [{ title: "叉车司机" }, { title: "软件实施工程师" }];
  assert.equal(applyBrowserTitleGate(jobs, undefined).kept.length, 2);
  assert.equal(applyBrowserTitleGate(jobs, {}).kept.length, 2);
  assert.equal(applyBrowserTitleGate(jobs, { positive: [], negative: [] }).kept.length, 2);
  assert.equal(applyBrowserTitleGate(undefined, { positive: ["软件"] }).kept.length, 0);
});

// 这条钉的是本仓共享匹配规则的 CJK 词边界修复（根模块与镜像同改）。曾经 \p{L}
// 把汉字算作「词字符」，于是 `IT` 匹配不到 `IT项目管理`——用户词表里恰有 `IT`，存量
// 里也有 `IT项目管理 【 郑州-高新区 】 5-8k` 这类明确想要的岗，门一接上就会静默毙掉。
// 现在汉字反而是边界。行为细节的守卫在 tests/title-filter-word-prefix.test.mjs (f)。
test("applyBrowserTitleGate: 缩写跨越汉字边界时命中（CJK 词边界修复）", () => {
  const cjk = applyBrowserTitleGate([{ title: "IT项目管理 【 郑州-高新区 】 5-8k" }], { positive: ["IT"] });
  assert.equal(cjk.kept.length, 1, "汉字应构成词边界，IT项目管理 必须命中");
  assert.equal(cjk.dropped.length, 0);
  // 拉丁侧不受影响：IT 仍不能命中 IThub / unit
  const ascii = applyBrowserTitleGate(
    [{ title: "IThub Platform" }, { title: "Unit Tests" }],
    { positive: ["IT"] },
  );
  assert.equal(ascii.kept.length, 0);
  assert.equal(ascii.dropped.length, 2);
});

// ── effectiveBrowserCity —— 城市条件的三种状态（ADR-0029 决议 6）──────────────

test("effectiveBrowserCity: 显式城市覆盖偏好，「全国」哨兵关掉城市门", () => {
  assert.equal(effectiveBrowserCity({ zhCity: "郑州", zhCityPreference: "北京" }), "郑州");
  assert.equal(effectiveBrowserCity({ zhCity: ZH_CITY_ANY, zhCityPreference: "北京" }), "");
  assert.equal(effectiveBrowserCity({ zhCity: ZH_CITY_ANY }), "");
});

test("effectiveBrowserCity: 未设置回落偏好城市（即 seedExploreFilters 解析出的那一个）", () => {
  assert.equal(effectiveBrowserCity({ zhCity: "", zhCityPreference: "郑州" }), "郑州");
  assert.equal(effectiveBrowserCity({ zhCity: "   ", zhCityPreference: "郑州" }), "郑州");
  assert.equal(effectiveBrowserCity({ zhCityPreference: "郑州" }), "郑州");
  // 两条 seed 路径都没有 → 门关闭，全国
  assert.equal(effectiveBrowserCity({ zhCity: "", zhCityPreference: "" }), "");
  assert.equal(effectiveBrowserCity({}), "");
  assert.equal(effectiveBrowserCity(undefined), "");
});

test("effectiveBrowserCity: 不是已知城市的值绝不成为城市条件（否则静默筛掉一切）", () => {
  // location_filter.allow 是 CLI 扫描器的清单，可以放「河南」这类地区名，profile 的
  // location.city 也可能写任意文本。拿它们当城市条件会让城市门对每一行都不命中——
  // 比放行更糟，且完全没有症状。
  assert.equal(effectiveBrowserCity({ zhCity: "河南" }), "");
  assert.equal(effectiveBrowserCity({ zhCityPreference: "河南" }), "");
  assert.equal(effectiveBrowserCity({ zhCity: "不存在的城市", zhCityPreference: "郑州" }), "郑州");
});

test("城市条件的两个「无具体城市」状态在分享链接里可区分", () => {
  // 未设置 → 不带 city 参数；全国 → 带哨兵值。这正是决议 6 要保住的可区分性。
  assert.ok(!browserToParams("项目经理", ["zhipin"], "").includes("city="));
  assert.ok(!browserToParams("项目经理", ["zhipin"], undefined).includes("city="));
  assert.equal(new URLSearchParams(browserToParams("项目经理", ["zhipin"], ZH_CITY_ANY)).get("city"), ZH_CITY_ANY);
  // 哨兵在站点侧退化成「无城市槽」＝全国搜索，与它的语义一致
  assert.equal(browserCityValue("zhipin", ZH_CITY_ANY), "");
});

test("城市门接上解析值：未设置按偏好筛，选『全国』全过", () => {
  const jobs = [{ city: "郑州", title: "A" }, { city: "安庆", title: "B" }];
  const unset = { zhCity: "", zhCityPreference: "郑州" };
  assert.deepEqual(applyBrowserCityGate(jobs, effectiveBrowserCity(unset)).map((j) => j.title), ["A"]);
  const national = { zhCity: ZH_CITY_ANY, zhCityPreference: "郑州" };
  assert.equal(applyBrowserCityGate(jobs, effectiveBrowserCity(national)).length, 2);
  // 偏好缺失时门关闭——不误删，与另两道门同取向
  assert.equal(applyBrowserCityGate(jobs, effectiveBrowserCity({})).length, 2);
});
// report-status-store.mjs — /api/report-status 的读取层（ADR-0098 决议 4/5/7）。
//
// WHY: 这条接口给浏览器扩展发「哪些职位评估过了」的索引，要逐行去 `reports/` 找报告、
// 读 6.3MB、解析出 `**URL:**`。原实现全同步：816 行 = 约 850ms 连续占住事件循环，
// 三个并发请求串成 1~2.8 秒；期间 `/api/version` 探针跟着超时，托盘与扩展于是同时
// 报「异常」。ADR-0098 把它拆成三层：
//
//   1. tracker 行：按 `applications.md + check-ups` 的签名缓存（`appsSignature`）
//   2. reports/ 目录清单：按「文件名清单」签名缓存（`listReports` + `numberIndex`）
//   3. 单份报告的 URL：按 (mtimeMs, size) 缓存（`statFile` + `readUrl`）
//
// 稳态因此只剩「一次解析 + 824 次 stat」，且 stat 走异步——事件循环不再被占住。
// 刻意不做 TTL：tracker 与报告都是用户刚写的东西，TTL 会让「刚写完看不到」和
// 「没变也白算」同时成立（ADR-0098 Alternatives）。
//
// 全部 IO 由调用方注入（route 侧接真盘、测试接假盘），这里只放判定与缓存规则。

/**
 * @typedef {object} ReportStatusStoreDeps
 * @property {() => Promise<string>} appsSignature  applications.md + check-ups 的签名
 * @property {() => Promise<string[]>} listReports  `reports/` 的文件名清单（不含路径）
 * @property {(names: string[]) => Map<number, string>} numberIndex 文件名清单 → 号→文件名
 * @property {(app: any, index: Map<number, string>) => (string|null)} reportPathOf 行 → 报告绝对路径
 * @property {(file: string) => Promise<({mtimeMs: number, size: number}|null)>} statFile
 * @property {(file: string) => Promise<(string|null)>} readUrl 报告正文 → 职位 URL
 * @property {() => Promise<any[]>} loadApps 读 tracker 行（含 checkupStar join）
 * @property {(apps: any[], urlByNum: Record<string, string>) => object} buildMap 装配契约 map
 */

/**
 * @param {ReportStatusStoreDeps} deps
 * @returns {{ get: () => Promise<object>, invalidate: () => void, stats: () => object }}
 */
export function createReportStatusStore(deps) {
  const required = [
    "appsSignature",
    "listReports",
    "numberIndex",
    "reportPathOf",
    "statFile",
    "readUrl",
    "loadApps",
    "buildMap",
  ];
  for (const name of required) {
    if (typeof deps?.[name] !== "function") {
      throw new TypeError(`createReportStatusStore: 缺少依赖 ${name}`);
    }
  }
  const { appsSignature, listReports, numberIndex, reportPathOf, statFile, readUrl, loadApps, buildMap } = deps;

  // URL 缓存独立于 tracker 缓存：报告文件与 tracker 行各自的失效条件不同，
  // 一份新报告不该把 816 行全部重解析，改一行 tracker 也不该让报告全部重读。
  /** @type {Map<string, {mtimeMs: number, size: number, url: (string|null)}>} */
  const urls = new Map();
  let apps = { sig: /** @type {string|null} */ (null), value: /** @type {any[]} */ ([]) };
  let reports = { sig: /** @type {string|null} */ (null), index: /** @type {Map<number, string>} */ (new Map()) };
  // 行 → 报告路径的解析结果（含包含性校验）。只在「tracker 或目录清单变了」时重算：
  // 定位一次要 lstat（符号链接判定），而路径本身在两次签名之间不会变，不必每请求
  // 再付 824 次。
  let paths = { sig: /** @type {string|null} */ (null), byNum: /** @type {Map<string, (string|null)>} */ (new Map()) };
  let reads = 0;
  /** @type {Promise<object>|null} */
  let inflight = null;

  /** 单份报告 → URL，命中条件严格到「同一文件、同一次内容」。
   *  `stamp` 已经量好时就传进来，免得同一个文件 stat 两次。 */
  async function urlFor(file, stamp) {
    const st = stamp === undefined ? await statFile(file) : stamp;
    if (!st) {
      urls.delete(file); // 报告被删/改名：缓存跟着走，别留幽灵
      return null;
    }
    const hit = urls.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.url;
    const url = await readUrl(file);
    reads += 1;
    urls.set(file, { mtimeMs: st.mtimeMs, size: st.size, url });
    return url;
  }

  async function build() {
    const appSig = await appsSignature();
    if (apps.sig !== appSig) apps = { sig: appSig, value: await loadApps() };

    const names = await listReports();
    // 排序后再拼签名：readdir 的顺序不构成语义，但缓存键必须稳定。
    const dirSig = names.slice().sort().join("\n");
    if (reports.sig !== dirSig) reports = { sig: dirSig, index: numberIndex(names) };

    // 行的变化或目录的变化都可能改变「这一行对应哪份报告」。
    const pathSig = `${appSig}\u0000${dirSig}`;
    if (paths.sig !== pathSig) paths = { sig: pathSig, byNum: new Map() };

    /** @type {{n: string, file: string}[]} */
    const targets = [];
    for (const app of apps.value) {
      let file;
      if (paths.byNum.has(app.n)) {
        file = paths.byNum.get(app.n);
      } else {
        file = reportPathOf(app, reports.index);
        paths.byNum.set(app.n, file);
      }
      if (!file) continue;
      targets.push({ n: app.n, file });
    }

    // 并发 stat：串行 await 816 次在 Windows 上要 ~80ms（每次一次 libuv 往返），
    // 并发后回到十几毫秒。
    const stamps = await Promise.all(targets.map((t) => statFile(t.file).catch(() => null)));

    /** @type {Record<string, string>} */
    const urlByNum = {};
    await Promise.all(
      targets.map(async (t, i) => {
        const url = await urlFor(t.file, stamps[i]);
        if (url) urlByNum[t.n] = url;
      }),
    );

    // 本轮没被引用的文件（行被删、报告改名）从缓存里落下去：否则一次改名就把一份
    // 6~10KB 的正文永远留在内存里，而且下次同路径新文件会误命中旧内容。
    const seen = new Set(targets.map((t) => t.file));
    for (const file of urls.keys()) {
      if (!seen.has(file)) urls.delete(file);
    }
    return buildMap(apps.value, urlByNum);
  }

  return {
    /**
     * 当前快照。并发调用共享同一次构建（决议 5）：三个请求同时到达不会读三遍报告。
     * @returns {Promise<object>}
     */
    async get() {
      if (inflight) return inflight;
      const running = build();
      inflight = running;
      try {
        return await running;
      } finally {
        if (inflight === running) inflight = null;
      }
    },
    /** 写路径后主动失效（`level: "all"` 也清掉 URL 缓存）。 */
    invalidate(level = "apps") {
      apps = { sig: null, value: [] };
      reports = { sig: null, index: new Map() };
      paths = { sig: null, byNum: new Map() };
      if (level === "all") urls.clear();
    },
    /** 诊断/测试用：看过多少份报告正文、缓存了多少条。 */
    stats() {
      return { reads, urlEntries: urls.size, apps: apps.value.length, paths: paths.byNum.size };
    },
  };
}

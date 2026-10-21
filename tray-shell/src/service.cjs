"use strict";

// dashboard 服务的监管（工单 02 / ADR-0086 决策 2·3）。
//
// 语义逐条搬自 dashboard-ui/launcher.go，唯一有意的改动是 owned：
//   - 3000 上已有一个**应答的** career-ops → 复用，owned=false，不 spawn、不杀、退出不碰；
//   - 有进程占着但不应答 → 杀进程树，等端口空出，再起；
//   - 空闲 → 直接起。
// 端口写死 3000、绑定 IPv4 环回、env 与旧 platform_windows.go 一模一样 —— 换壳不该动这些。
//
// 这一层只记录**原始事实**（starting/ready/failed/pid/…），托盘状态由 state.cjs 收敛，
// 避免同一份状态两处各算一次（ADR-0086 被拒方案）。

const { spawn } = require("node:child_process");
const proc = require("./proc.cjs");

const WEB_PORT = 3000;

const ACTION_REUSE = "reuse";
const ACTION_START_FRESH = "start-fresh";
const ACTION_KILL_THEN_START = "kill-then-start";

// 健康探测的超时给宽一点：本地服务平时 10ms，但壳刚起来（Electron 冷启动 + 面板首帧）
// 那两秒里偶发一次 1.5s 超时，没必要让托盘闪一下灰。
const HEALTH_TIMEOUT_MS = 2500;
// 端口在听却一直答不上来（真卡死）时，攒够这么多次仍判 down。2s 一次 ≈ 30s。
const HEALTH_HUNG_MISSES = 15;

/**
 * 接管决策（纯函数，无 OS）：应答的服务优先复用，哪怕它明显占着 socket。
 *
 * @param {boolean} probeOK `/api/version` 是否 200
 * @param {number} listenerPID 监听 3000 的 PID（0 = 空闲）
 * @returns {"reuse"|"start-fresh"|"kill-then-start"}
 */
function decideTakeover(probeOK, listenerPID) {
  if (probeOK) return ACTION_REUSE;
  if (listenerPID > 0) return ACTION_KILL_THEN_START;
  return ACTION_START_FRESH;
}

/** 杀不掉/等不到空闲时的提示：点名占用者，绝不给「换个端口」这条路（ADR-0063）。 */
function cannotFreeMsg(occupant, cause) {
  const who = occupant && occupant.pid ? `${occupant.image || "未知进程"} (PID ${occupant.pid})` : "未知";
  let msg = `无法启动 dashboard：3000 端口被占用，且无法释放。\n\n占用进程：${who}`;
  if (cause) msg += `\n结束该进程失败：${cause}`;
  return `${msg}\n\n请手动结束它后重试（端口固定为 3000，不会改用其它端口）。`;
}

/**
 * @param {{port?: number, careerRoot: string, runtime: {nodePath: string, serverDir: string, runtimeDir: string},
 *          logs: {line: Function, stream: Function, path: string},
 *          openBrowser?: () => void, procApi?: object}} opts
 */
function createService({ port = WEB_PORT, careerRoot, runtime, logs, openBrowser = () => {}, procApi = proc, cacheVersion = "" }) {
  const url = `http://localhost:${port}`;

  const facts = {
    starting: false,
    ready: false,
    failed: false,
    failReason: "",
    owned: false,
    pid: 0,
    since: 0,
    healthMs: null,
    version: "",
    sha: "",
    coreVersion: "",
    packaged: false,
  };

  // 当前子进程句柄 + 「这次退出是我们主动杀的」标记：重启/退出时先立标记，
  // 否则旧子进程的 exit 会被当成崩溃（launcher.go 里 curCmd.Store(nil) 的同款用意）。
  let current = null;
  let healthMisses = 0;

  const log = (text) => logs.line("launcher", text);

  function factsOf() {
    return { ...facts };
  }

  function applyVersion(payload, ms) {
    if (typeof ms === "number") facts.healthMs = ms;
    if (!payload) return;
    facts.version = typeof payload.version === "string" ? payload.version : facts.version;
    facts.coreVersion = typeof payload.coreVersion === "string" ? payload.coreVersion : facts.coreVersion;
    facts.sha = typeof payload.sha === "string" ? payload.sha : facts.sha;
    facts.packaged = payload.packaged === true;
  }

  function markFailed(reason) {
    facts.starting = false;
    facts.ready = false;
    facts.failed = true;
    facts.failReason = reason;
    facts.healthMs = null;
    log(`启动失败：${reason.split("\n")[0]}`);
    log(`完整启动过程与服务输出见 ${logs.path}`);
  }

  /** 起服 + 等就绪。timeoutMs 由调用方给（冷启动 60s，重启 30s）。 */
  async function spawnAndWait(timeoutMs) {
    let child;
    try {
      child = spawn(runtime.nodePath, ["server.js"], {
        cwd: runtime.serverDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CAREER_OPS_ROOT: careerRoot,
          PORT: String(port),
          // 绑定地址（不是访问 URL）：Windows 把 localhost 先解析成 ::1，写 localhost 会绑错栈。
          HOSTNAME: "127.0.0.1",
        },
      });
    } catch (error) {
      markFailed(`failed to start the dashboard server: ${error.message}`);
      return false;
    }

    // stdout 与 stderr 各一个行缓冲实例：两条流交错时不会粘行/撕行（logsink.go 同款）。
    child.stdout.pipe(logs.stream("server"));
    child.stderr.pipe(logs.stream("server"));

    current = { child, deliberate: false };
    facts.owned = true;
    facts.pid = child.pid || 0;
    facts.since = Date.now();
    facts.starting = true;
    facts.ready = false;
    facts.failed = false;
    facts.failReason = "";
    healthMisses = 0;
    log(`已派生服务子进程 pid=${facts.pid}，等待就绪（最长 ${Math.round(timeoutMs / 1000)}s）…`);

    child.on("error", (error) => {
      if (current && current.child === child && !current.deliberate) {
        markFailed(`dashboard 服务进程启动失败：${error.message}`);
      }
    });

    child.on("exit", (code, signal) => {
      const deliberate = !current || current.child !== child || current.deliberate;
      if (deliberate) return;
      const detail = `code=${code}${signal ? `, signal=${signal}` : ""}`;
      markFailed(`dashboard 服务意外退出（${detail}）`);
    });

    const ready = await waitReady(timeoutMs);
    if (ready) {
      facts.starting = false;
      facts.ready = true;
      facts.failed = false;
      facts.failReason = "";
      log(`服务就绪：${url}`);
      openBrowser();
      return true;
    }

    // 子进程自己死了（exit/error 已经 markFailed 过）：保留那条准确死因，不要再盖成「未就绪」。
    if (facts.failed) return false;

    // 超时：把半死不活的子进程收掉，托盘留驻（旧行为：弹窗 + 驻留，不退出）。
    if (current && current.child === child) current.deliberate = true;
    try {
      child.kill();
    } catch {
      /* 已经死了 */
    }
    markFailed(`dashboard 服务在 ${port} 端口未能就绪（可能启动即崩溃）`);
    return false;
  }

  /** 轮询 `/api/version` 每 300ms，最长 timeoutMs。 */
  async function waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const probe = await procApi.httpJson(port, "/api/version", 1500);
      if (probe.ok) {
        applyVersion(probe.json, probe.ms);
        return true;
      }
      // 子进程已经崩了（启动即死）：不必空等满 60s，托盘该立刻变红。
      if (facts.failed) return false;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /** 冷启动入口：接管链 → 起服 → 等就绪。 */
  async function start() {
    if (facts.starting) return false;
    facts.starting = true;
    facts.failed = false;
    facts.failReason = "";
    log(`launcher 启动：pid=${process.pid} port=${port} runtime=${runtime.runtimeDir} 日志=${logs.path}`);
    // 运行时来源写第二行（首行永远是「launcher 启动」，验收靠它定位一次运行）。
    // cacheVersion 来自打包注入的 version.json；空值 = 开发态，按 vdev 处理。
    log(`运行时来源：${runtime.source}（cacheVersion=${cacheVersion || "vdev"}）`);

    const probe = await procApi.httpJson(port, "/api/version", 1500);
    const occupant = probe.ok ? { pid: 0, image: "" } : await procApi.listenerOf(port);
    const action = decideTakeover(probe.ok, occupant.pid);

    if (action === ACTION_REUSE) {
      // 有意与旧 Go 不同：不再「开浏览器即退出」，壳驻留并在面板标「外部实例」。
      log("接管决策：3000 已应答，复用现有实例（服务输出归持口实例，本壳不记，退出不杀）");
      // 复用时不 spawn，但仍把监听 PID 查出来给面板看（“谁在跑”是用户在意的）。
      const owner = await procApi.listenerOf(port);
      facts.owned = false;
      facts.starting = false;
      facts.ready = true;
      facts.failed = false;
      facts.since = Date.now();
      facts.pid = owner.pid || 0;
      applyVersion(probe.json, probe.ms);
      openBrowser();
      return true;
    }

    if (action === ACTION_KILL_THEN_START) {
      log(`接管决策：3000 被 ${occupant.image || "未知进程"}(pid=${occupant.pid}) 占用且无应答，杀进程树后起服`);
      const killed = await procApi.killTree(occupant.pid);
      if (!killed) {
        markFailed(cannotFreeMsg(occupant, "taskkill 返回失败"));
        return false;
      }
      if (!(await procApi.waitPortFree(port, 10_000))) {
        const again = await procApi.listenerOf(port);
        markFailed(cannotFreeMsg(again, "等待端口空闲超时"));
        return false;
      }
    } else {
      log("接管决策：3000 空闲，直接起服");
    }

    return spawnAndWait(60_000);
  }

  /** 重启：先停自己的子进程 → 确保端口空出（必要时清掉抢位的第三方）→ 重起 → 等 30s。 */
  async function restart() {
    if (facts.starting) return false;
    if (facts.ready && !facts.owned) {
      // 外部实例（dev server / 另一个 exe）：按 owned 语义一律不碰，别让「重启」变成暗杀。
      log("重启：3000 上是外部实例，不受本壳管理，不做任何操作");
      return false;
    }

    facts.starting = true;
    facts.ready = false;
    facts.failed = false;
    facts.failReason = "";
    log("重启：先停旧子进程，再确保 3000 空闲");

    if (current) {
      current.deliberate = true;
      await procApi.killTree(current.child.pid);
      current = null;
    }
    facts.owned = false;
    facts.pid = 0;

    if (!(await procApi.waitPortFree(port, 10_000))) {
      const occupant = await procApi.listenerOf(port);
      if (!occupant.pid || !(await procApi.killTree(occupant.pid)) || !(await procApi.waitPortFree(port, 5_000))) {
        markFailed(cannotFreeMsg(occupant, "重启时端口未能空出"));
        return false;
      }
    }

    return spawnAndWait(30_000);
  }

  /** 退出：只有 owned 才杀子进程树；外部实例什么都不做。 */
  async function stop() {
    if (!facts.owned) {
      log("退出：3000 上是外部实例，不杀（owned=false）");
      return;
    }
    if (current) {
      current.deliberate = true;
      log(`退出：结束服务子进程 pid=${current.child.pid}`);
      await procApi.killTree(current.child.pid);
      current = null;
    }
    facts.owned = false;
    facts.pid = 0;
    facts.ready = false;
    facts.starting = false;
  }

  /**
   * 健康探测（2s 一次）：通 → run；连续两次不通且不在启动中 → 掉回 down。
   *
   * 「一次 HTTP 探测超时」不等于「服务没了」：壳刚起的两秒里探测就可能超时，而端口明明还在听。
   * 所以判 down 之前补一次 TCP connect —— 端口还在听就只把本轮的 ms 置空（读不到就当未知），
   * 状态保持 run；只有端口彻底没人听、或端口在听却连续 30s 答不上来（真卡死）才掉 down。
   * 验收时踩过：外部实例场景面板一度显示「已停止」，实际 3000 一直 200。
   */
  async function health() {
    const probe = await procApi.httpJson(port, "/api/version", HEALTH_TIMEOUT_MS);
    if (probe.ok) {
      healthMisses = 0;
      facts.ready = true;
      facts.failed = false;
      facts.failReason = "";
      // 后起的服务（外部实例晚到 / 手动拉起）第一次通时补上观察起点。
      if (!facts.since) facts.since = Date.now();
      applyVersion(probe.json, probe.ms);
      return;
    }
    if (facts.starting) return;
    healthMisses += 1;
    // 单次抖动（GC / 一次慢请求）不该把托盘闪成灰色。
    if (healthMisses < 2) return;
    facts.healthMs = null;
    const listening = await procApi.isPortListening(port, 500);
    if (listening && healthMisses < HEALTH_HUNG_MISSES) return;
    facts.ready = false;
    if (listening) log(`健康探测连续 ${healthMisses} 次超时（端口仍在听，判为无应答），托盘转「已停止」`);
  }

  // 复用外部实例时 since 记的是「本壳开始观察它」的时间，面板上写「外部实例」而不是
  // 「已运行 1h」——见 panel.js 里 svcMeta 的文案分工。
  function isRestartable() {
    return !(facts.ready && !facts.owned);
  }

  return { facts: factsOf, start, restart, stop, health, isRestartable, url, port };
}

module.exports = {
  ACTION_KILL_THEN_START,
  ACTION_REUSE,
  ACTION_START_FRESH,
  WEB_PORT,
  cannotFreeMsg,
  createService,
  decideTakeover,
};

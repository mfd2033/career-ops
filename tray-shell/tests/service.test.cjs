"use strict";

// createService 的行为测试：注入假的 procApi，不碰真端口、不 spawn 真进程。
//
// 覆盖工单 02 里最容易被改坏的三件事：
//   1. 复用外部实例时 owned=false、不 spawn、不杀（退出语义全挂在 owned 上）；
//   2. 杀不掉占用者时给 failed + 点名 PID，绝不换端口；
//   3. 健康探测：一次 HTTP 超时不算「服务没了」，端口还在听就保持 run。

const test = require("node:test");
const assert = require("node:assert/strict");
const { createService } = require("../src/service.cjs");

const runtime = { nodePath: "node.exe", serverDir: "C:\\fake\\app", runtimeDir: "C:\\fake", source: "versioned" };

function fakeLogs() {
  const lines = [];
  return {
    lines,
    path: "C:\\fake\\launcher.log",
    fileOk: true,
    line: (source, text) => lines.push(`[${source}] ${text}`),
    stream: () => ({ write: () => {} }),
  };
}

function makeService(overrides = {}) {
  const calls = { spawn: 0, killTree: [], waitPortFree: [], openBrowser: 0 };
  const logs = fakeLogs();
  const procApi = {
    httpJson: async () => ({ ok: false, status: 0, json: null, ms: 0 }),
    listenerOf: async () => ({ pid: 0, image: "" }),
    killTree: async (pid) => {
      calls.killTree.push(pid);
      return true;
    },
    waitPortFree: async (port) => {
      calls.waitPortFree.push(port);
      return true;
    },
    isPortListening: async () => false,
    ...overrides.procApi,
  };
  const service = createService({
    port: 3000,
    careerRoot: "C:\\fake",
    runtime,
    logs,
    cacheVersion: "testdev",
    procApi,
    openBrowser: () => {
      calls.openBrowser += 1;
    },
  });
  return { service, calls, logs };
}

test("复用外部实例：owned=false、ready=true、pid 取监听者，且不 spawn", async () => {
  const { service, calls } = makeService({
    procApi: {
      httpJson: async () => ({ ok: true, status: 200, json: { coreVersion: "1.28.0", sha: "abc1234", packaged: true }, ms: 9 }),
      listenerOf: async () => ({ pid: 62312, image: "node.exe" }),
    },
  });

  assert.equal(await service.start(), true);
  const facts = service.facts();
  assert.equal(facts.owned, false);
  assert.equal(facts.ready, true);
  assert.equal(facts.starting, false);
  assert.equal(facts.pid, 62312);
  assert.equal(facts.coreVersion, "1.28.0");
  assert.equal(facts.sha, "abc1234");
  assert.deepEqual(calls.killTree, []);
  // 外部实例：退出与重启都不许碰它
  assert.equal(service.isRestartable(), false);
  assert.equal(await service.restart(), false);
  await service.stop();
  assert.deepEqual(calls.killTree, []);
});

test("杀不掉占用者：failed + 点名 PID，且不换端口", async () => {
  const { service, calls } = makeService({
    procApi: {
      listenerOf: async () => ({ pid: 4242, image: "chrome.exe" }),
      killTree: async (pid) => {
        calls.killTree.push(pid);
        return false;
      },
    },
  });

  assert.equal(await service.start(), false);
  const facts = service.facts();
  assert.equal(facts.failed, true);
  assert.equal(facts.ready, false);
  assert.equal(facts.starting, false);
  assert.match(facts.failReason, /chrome\.exe \(PID 4242\)/);
  assert.match(facts.failReason, /端口固定为 3000/);
  assert.deepEqual(calls.killTree, [4242]);
  assert.deepEqual(calls.waitPortFree, []);
});

test("健康探测：通 → run；端口彻底没人听两次 → down", async () => {
  let probeOK = true;
  const { service } = makeService({
    procApi: {
      httpJson: async () =>
        probeOK ? { ok: true, status: 200, json: {}, ms: 12 } : { ok: false, status: 0, json: null, ms: 2500 },
      isPortListening: async () => false,
    },
  });

  await service.health();
  assert.equal(service.facts().ready, true);
  assert.equal(service.facts().healthMs, 12);

  probeOK = false;
  await service.health();
  assert.equal(service.facts().ready, true, "单次抖动不翻状态");
  await service.health();
  assert.equal(service.facts().ready, false, "端口没人听 + 两次超时 = 真的没了");
  assert.equal(service.facts().healthMs, null);
});

test("健康探测：HTTP 超时但端口仍在听 → 保持 run（只丢 ms），连超 15 次才认输", async () => {
  let probeOK = true;
  const { service } = makeService({
    procApi: {
      httpJson: async () =>
        probeOK ? { ok: true, status: 200, json: {}, ms: 11 } : { ok: false, status: 0, json: null, ms: 2500 },
      isPortListening: async () => true,
    },
  });

  await service.health();
  assert.equal(service.facts().ready, true);
  assert.equal(service.facts().healthMs, 11);

  // 端口一直在听、HTTP 一直超时：壳刚起来时的冷抖动 / 服务卡在慢 IO
  probeOK = false;
  for (let i = 0; i < 14; i += 1) await service.health();
  assert.equal(service.facts().ready, true, "端口还在听：14 次超时也保持 run");
  assert.equal(service.facts().failed, false, "超时不是 failed，别把面板染红");
  assert.equal(service.facts().healthMs, null, "读不到耗时就不显示 ms");

  await service.health(); // 第 15 次
  assert.equal(service.facts().ready, false, "端口在听但连续 30s 答不上来 = 真卡死");
});

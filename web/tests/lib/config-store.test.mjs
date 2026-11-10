// config-store 单测：配置页整包保存不得抹掉别的模块写进 career-ops:config 的字段。
//
// 事故形状：配置页改「每站采集上限」（scanMaxBySource，scan-max.mjs 负责）后点保存，
// save() 先 persistScanMax 再按白名单整包重建对象 → 该字段被删 → 刷新回默认 1200。
//
// Run:  node --test tests/lib/config-store.test.mjs

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** node 里没有 localStorage：用内存版替身，按 key 存字符串。 */
class MemoryStorage {
  #map = new Map();
  getItem(key) {
    return this.#map.has(key) ? this.#map.get(key) : null;
  }
  setItem(key, value) {
    this.#map.set(key, String(value));
  }
  removeItem(key) {
    this.#map.delete(key);
  }
  clear() {
    this.#map.clear();
  }
}

globalThis.localStorage = new MemoryStorage();

const { CONFIG_KEY, readConfigObject, writeConfigSnapshot } = await import("../../src/lib/config-store.mjs");
const { persistScanMax, readScanMax, SCAN_MAX_DEFAULT } = await import("../../src/lib/scan-max.mjs");

const seed = (obj) => localStorage.setItem(CONFIG_KEY, JSON.stringify(obj));

beforeEach(() => localStorage.clear());

test("整包保存保留其它模块的字段（scanMaxBySource 不被抹掉）", () => {
  seed({ cliId: "claude", scanMaxBySource: { zhipin: 400, liepin: 2000, zhaopin: 400 } });
  writeConfigSnapshot({ mode: "cli", cliId: "claude", scanSource: ["bsk"] });
  const after = readConfigObject();
  assert.deepEqual(after.scanMaxBySource, { zhipin: 400, liepin: 2000, zhaopin: 400 });
  assert.deepEqual(after.scanSource, ["bsk"]); // 自己负责的字段照旧被覆盖
});

test("保存链路的真实顺序：persistScanMax → 整包保存 → readScanMax 仍读回自定义值", () => {
  persistScanMax({ zhipin: 400, liepin: 2000, zhaopin: 400 });
  writeConfigSnapshot({ mode: "cli", cliId: "claude", scanSource: ["bsk"], applyBehavior: "auto" });
  assert.equal(readScanMax().liepin, 2000);
});

test("整包保存覆盖自己负责的字段（不因保留旧值而失效）", () => {
  seed({ mode: "key", scanSource: ["ats"], scanMaxBySource: { liepin: 800 } });
  writeConfigSnapshot({ mode: "cli", scanSource: ["bsk"] });
  const after = readConfigObject();
  assert.equal(after.mode, "cli");
  assert.deepEqual(after.scanSource, ["bsk"]);
  assert.equal(after.scanMaxBySource.liepin, 800);
});

test("存储损坏时整包保存不抛，并写成一份干净快照", () => {
  localStorage.setItem(CONFIG_KEY, "{not json");
  assert.equal(writeConfigSnapshot({ mode: "cli" }), true);
  assert.deepEqual(readConfigObject(), { mode: "cli" });
});

test("空存储首次保存：其余字段直接落盘，scanMax 读回归默认值", () => {
  writeConfigSnapshot({ mode: "cli", cliId: "claude" });
  assert.equal(readConfigObject().cliId, "claude");
  assert.deepEqual(readScanMax(), { ...SCAN_MAX_DEFAULT });
});

test("setItem 抛错（quota / 隐私模式）时返回 false 而不抛", () => {
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  try {
    assert.equal(writeConfigSnapshot({ mode: "cli" }), false);
  } finally {
    globalThis.localStorage = real;
  }
});

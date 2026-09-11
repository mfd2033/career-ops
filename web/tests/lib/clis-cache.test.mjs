// Guards the browser-side runtime-detection cache (ADR-0015).
//
// The cache's presence IS the "already checked" flag that decides whether the
// config page auto-detects. The invariants that matter are therefore about
// what counts as usable, not about storage mechanics:
//   1. A successful write must read back intact (roundtrip) — otherwise the
//      page would silently re-check on every open, reintroducing the cost
//      this cache exists to remove.
//   2. Anything unreadable — missing key, corrupt JSON, wrong shape — must
//      read as null ("never checked"), never throw: a corrupt entry must
//      degrade to one extra auto-check, not a broken page.
//
// Run:  node --test tests/lib/clis-cache.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readClisCache, writeClisCache, CLIS_CACHE_KEY } from "../../src/lib/clis-cache.mjs";

/** Install a Map-backed localStorage stub and clean it up afterwards. */
function withStorage(fn) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    return fn(store);
  } finally {
    delete globalThis.localStorage;
  }
}

test("a written detection reads back intact", () => {
  withStorage(() => {
    const clis = [{ id: "claude", installed: true, path: "C:\\x\\claude.exe", model: { options: [] } }];
    writeClisCache(clis);
    const read = readClisCache();
    assert.ok(read, "a successful write must be readable");
    assert.equal(typeof read.checkedAt, "number");
    assert.deepEqual(read.clis, clis);
  });
});

test("no entry means never checked — null, not a throw", () => {
  withStorage(() => {
    assert.equal(readClisCache(), null);
  });
});

test("corrupt JSON degrades to null — one extra auto-check, not a broken page", () => {
  withStorage((store) => {
    store.set(CLIS_CACHE_KEY, "{not json");
    assert.equal(readClisCache(), null);
  });
});

test("a wrong-shaped entry is not usable as an already-checked marker", () => {
  withStorage((store) => {
    // checkedAt missing — the "last checked" readout would lie.
    store.set(CLIS_CACHE_KEY, JSON.stringify({ clis: [] }));
    assert.equal(readClisCache(), null);
    // clis missing/not an array — the dropdown would have nothing to render.
    store.set(CLIS_CACHE_KEY, JSON.stringify({ checkedAt: 123 }));
    assert.equal(readClisCache(), null);
    store.set(CLIS_CACHE_KEY, JSON.stringify({ checkedAt: 123, clis: "claude" }));
    assert.equal(readClisCache(), null);
  });
});

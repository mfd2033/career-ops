// data-events.mjs — 进程内「用户层数据变了」的通知总线（ADR-0101）。
//
// WHY: tracker 的写入早就是对的（扩展 → /api/status → set-status.mjs 改盘），页面
// 也是每次请求重读磁盘；唯一缺的是「别人写完了，告诉我重取一次」——已打开的标签页
// 没有任何通道监听外部写入，用户改完状态切回来看到的还是旧值。这条总线只做一件事：
// 把一次成功写入变成一条通道级帧，让所有打开页面的标签页各自 router.refresh()。
//
// 刻意不做缓冲/重放：一次变更只是「去重取一次」的提示，错过它的代价是这个标签页
// 保持原样，而它本来会在下次导航时自愈。补推历史反而会让「刷新」这件事带上顺序语义。
//
// 帧形状与 ADR-0020 的通道级帧（`{type:"keepalive"}`）同级：**不带 runId**，不认识
// 它的旧客户端按「无 runId 帧」忽略，不破坏既有线协议。帧里只放 scope，不放行号与
// 字段值——接收方整体刷新拿真值，不在客户端装配第二份 tracker。

/** 目前只有一类被广播的数据：tracker（`data/applications.md` 及其台账）。 */
export const DATA_SCOPE_TRACKER = "tracker";

/** @type {Set<(change: {scope: string, ts: number, [key: string]: unknown}) => void>} */
const subscribers = new Set();

/**
 * 通道帧（`/api/events` 的线协议）。集中在这里，路由不手拼对象：形状一改，
 * 单测与路由一起红，而不是某个调用点悄悄多/少一个字段。
 *
 * @param {string} scope 数据域（`DATA_SCOPE_TRACKER`）
 * @param {number} [ts] 服务端墙钟；缺省取当前时刻
 * @returns {{type: "data-changed", scope: string, ts: number}}
 */
export function dataChangeFrame(scope, ts) {
  return { type: "data-changed", scope, ts: typeof ts === "number" ? ts : Date.now() };
}

/**
 * 扇出一次变更。空 scope / 非字符串一律静默丢弃：发布点位于成功写入之后，
 * 这里抛错会把一次已经落盘的写变成 500，代价远大于少一次刷新。
 *
 * @param {string} scope
 * @param {Record<string, unknown>} [detail] 附加信息（当前无消费方，留给诊断）
 */
export function publishDataChange(scope, detail = {}) {
  if (typeof scope !== "string" || !scope.trim()) return;
  const change = { scope, ts: Date.now(), ...detail };
  for (const fn of subscribers) {
    try {
      fn(change);
    } catch {
      // 一个死掉的订阅者（abort 中的连接）不该影响其它标签页
    }
  }
}

/**
 * 订阅变更。返回退订函数——每条 `/api/events` 长连接在 cleanup 里必须调用它，
 * 否则关掉的标签页会在进程里留下一个已死的 controller。
 *
 * @param {(change: {scope: string, ts: number}) => void} fn
 * @returns {() => void}
 */
export function subscribeDataChanges(fn) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** 当前订阅者数量（诊断/测试用）。 */
export function dataChangeSubscriberCount() {
  return subscribers.size;
}

/** 测试用：清空订阅者。 */
export function __resetDataEventsForTest() {
  subscribers.clear();
}

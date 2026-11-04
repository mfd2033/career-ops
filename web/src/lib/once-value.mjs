// once-value.mjs — 进程内「只算一次」的取值器（ADR-0098 决议 2）。
//
// WHY: `/api/version` 是托盘与浏览器扩展共用的探针，托盘 2.5s、扩展 6s 就判死。
// 它原先每次请求都 `execSync("git rev-parse")` + 读 3~4 个文件，而 web 是单进程
// 单事件循环——别的路由一占住循环，探针自己就先超时，「服务在忙」于是被误报成
// 「服务没起」。探针要回答的是「这是哪个正在运行的服务」，这个答案在一次进程
// 生命周期里不会变，所以算一次就够。
//
// 语义边界（刻意保守）：
//   • 只 memo `compute` 的返回值，不吞异常——compute 抛错就照抛，调用方决定降级；
//   • 首次调用发生在**第一个请求**而不是模块加载时：dev 下 `git rev-parse` 不该
//     拖慢服务启动，也不该在进程刚起来、cwd 还没稳的时候跑；
//   • 永不失效。需要「会变」的值就别用它（那类读数应该走 mtime 签名缓存，见
//     ADR-0098 决议 4）。
//
// `compute` 返回 Promise 时 memo 的是那个 Promise（并发调用共享同一次计算），
// 拒绝同样被记住——重试是调用方的事。

/**
 * @template T
 * @param {() => T} compute 只应执行一次的计算
 * @returns {() => T} 同一个结果；首次调用时才真正执行 compute
 */
export function createOnceValue(compute) {
  if (typeof compute !== "function") throw new TypeError("createOnceValue 需要一个函数");
  let done = false;
  let value;
  return function onceValue() {
    if (!done) {
      value = compute();
      done = true;
    }
    return value;
  };
}

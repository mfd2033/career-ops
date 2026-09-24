// Tests for win-reveal.mjs —— Windows 下「在资源管理器中定位文件并把窗口提到前台」
// 的 helper 拼装与 spawn 编排。用 node --test 直接跑：
//   node --test tests/lib/win-reveal.test.mjs
//
// 背景（ADR-0058）：/api/cv-pdf/open 由后台服务器进程 spawn
// `explorer /select,<path>`，Windows 前台锁定导致资源管理器窗口开到背后。
// 修复是再 spawn 一个隐藏窗口的 powershell helper，轮询匹配目标目录的
// Explorer 窗口并用 SwitchToThisWindow 前置。本测试锁三件事：
//   1. PowerShell 脚本的字面量转义（路径含单引号不能撕开字符串字面量）；
//   2. spawn 编排（先 explorer 后 powershell，detached + unref，错误静默）；
//   3. 路由接线（win32 分支必须走本模块，不许再直接 spawn explorer）。
// 前置效果本身无法在 CI 断言（需要真实桌面会话），由本机手动清单验证。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildForegroundScript, revealCvPdfInExplorer } from "../../src/lib/win-reveal.mjs";

// ── buildForegroundScript：纯字符串拼装，可测的全部风险都在这里 ──

test("buildForegroundScript: 脚本包含前置所需的三要素（P/Invoke、Shell.Application、超时轮询）", () => {
  const script = buildForegroundScript("D:\\workspace\\career-ops\\output");

  // SwitchToThisWindow 是唯一能绕开前台锁定的 user32 入口（Alt+Tab 专用）
  assert.match(script, /SwitchToThisWindow/);
  assert.match(script, /user32\.dll/);
  // 窗口枚举走 Shell.Application，不用进程 MainWindowHandle（explorer 共享进程）；
  // 集合必须来自 Windows() 方法 —— $shell 自身没有 Count/Item（首轮冒烟实测）。
  assert.match(script, /Shell\.Application/);
  assert.match(script, /\$wins=\$shell\.Windows\(\)/);
  assert.doesNotMatch(script, /\$shell\.Count/, "不许直接数 $shell（永远空转）");
  // 默认 3 秒轮询窗口：出现即抢，超时静默放弃（短窗口内必抢决议）
  assert.match(script, /AddMilliseconds\(3000\)/);
  assert.match(script, /Start-Sleep -Milliseconds 150/);
});

test("buildForegroundScript: 目标目录以单引号字面量嵌入，单引号按 PowerShell 惯例加倍转义", () => {
  // 路径里带单引号 —— 若不转义会撕开字符串字面量，轻则脚本报错重则注入
  const script = buildForegroundScript("D:\\it's\\output");
  assert.ok(script.includes("'D:\\it''s\\output'"), "单引号必须加倍且整体在单引号字面量内");
  // 正常路径不加任何多余转义，逐字嵌入
  const plain = buildForegroundScript("D:\\workspace\\career-ops\\output");
  assert.ok(plain.includes("'D:\\workspace\\career-ops\\output'"));
});

test("buildForegroundScript: timeoutMs/pollMs 可覆盖（供手动排障调参，不改默认值）", () => {
  const script = buildForegroundScript("D:\\x", { timeoutMs: 800, pollMs: 40 });
  assert.match(script, /AddMilliseconds\(800\)/);
  assert.match(script, /Start-Sleep -Milliseconds 40/);
});

// ── revealCvPdfInExplorer：spawn 编排（注入 mock spawn，不碰真实进程）──

function mockSpawn() {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    const rec = { cmd, args, opts, unrefed: false, onError: null };
    rec.on = (evt, fn) => {
      if (evt === "error") rec.onError = fn;
      return rec;
    };
    rec.unref = () => {
      rec.unrefed = true;
    };
    calls.push(rec);
    return rec;
  };
  spawn.calls = calls;
  return spawn;
}

test("revealCvPdfInExplorer: 先 spawn explorer /select，再 spawn 隐藏 powershell helper", () => {
  const spawn = mockSpawn();
  revealCvPdfInExplorer("D:\\workspace\\career-ops\\output\\cv-x.pdf", { spawn });

  assert.equal(spawn.calls.length, 2);
  const [explorer, helper] = spawn.calls;
  assert.equal(explorer.cmd, "explorer");
  assert.deepEqual(explorer.args, ["/select,D:\\workspace\\career-ops\\output\\cv-x.pdf"]);
  assert.equal(helper.cmd, "powershell.exe");
  // 隐藏窗口 + 无 profile + 非交互：不闪黑框、不怕 profile 干扰
  assert.ok(helper.args.includes("-WindowStyle"), "必须带 -WindowStyle");
  assert.equal(helper.args[helper.args.indexOf("-WindowStyle") + 1], "Hidden");
  assert.ok(helper.args.includes("-NoProfile"));
  assert.ok(helper.args.includes("-NonInteractive"));
  // helper 盯的是 PDF 的父目录（资源管理器窗口标题即所在文件夹路径）
  const cmd = helper.args[helper.args.indexOf("-Command") + 1];
  assert.ok(cmd.includes("'D:\\workspace\\career-ops\\output'"), "脚本字面量应为父目录");
  assert.ok(!cmd.includes("cv-x.pdf"), "helper 只匹配目录，不该带上文件名");
});

test("revealCvPdfInExplorer: explorer 走 detached；helper 绝不 detached（控制台应用会启动即死），靠 windowsHide+unref", () => {
  const spawn = mockSpawn();
  revealCvPdfInExplorer("D:\\x\\a.pdf", { spawn });
  const [explorer, helper] = spawn.calls;
  assert.equal(explorer.opts.detached, true);
  // 2026-09-24 marker 实验：detached 的 powershell 连第一行日志都写不出来。
  assert.notEqual(helper.opts.detached, true, "helper 绝不允许 detached（ps 静默死亡，前置永不生效）");
  assert.equal(helper.opts.windowsHide, true, "非 detached 要靠 windowsHide 防闪控制台窗");
  for (const rec of spawn.calls) {
    assert.equal(rec.opts.stdio, "ignore");
    assert.equal(rec.unrefed, true);
  }
});

test("revealCvPdfInExplorer: explorer 的已知非零退出/error 事件静默吞掉，不抛出", () => {
  const spawn = mockSpawn();
  revealCvPdfInExplorer("D:\\x\\a.pdf", { spawn });
  // explorer 成功时也常报非零退出码 —— error 回调必须存在且无害
  for (const rec of spawn.calls) {
    assert.equal(typeof rec.onError, "function");
    assert.doesNotThrow(() => rec.onError(new Error("spawn boom")));
  }
});

// ── 路由接线锁：/api/cv-pdf/open 的 win32 分支必须走本模块 ──

test("cv-pdf/open 路由不再直接 spawn explorer，改走 revealCvPdfInExplorer", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../src/app/api/cv-pdf/open/route.ts"),
    "utf8",
  );
  assert.ok(src.includes("revealCvPdfInExplorer"), "win32 分支必须经 win-reveal 模块前置");
  assert.doesNotMatch(src, /spawn\(\s*"explorer"/, "路由里不许再有裸 explorer spawn");
  // darwin/linux 分支不在本次修复范围，必须原样保留
  assert.match(src, /spawn\("open",\s*\["-R"/);
  assert.match(src, /spawn\("xdg-open"/);
});

#!/usr/bin/env node
// 评估耗时埋点：记录一次完整评估各步骤的墙钟耗时，追加到 data/eval-timings.tsv。
// 用法：
//   node log-eval-timing.mjs <报告号> <步骤> start
//   node log-eval-timing.mjs <报告号> <步骤> end
//   node log-eval-timing.mjs clear
// 步骤名（保持拼写一致，避免统计对不上）：extract / liveness / eval / report / pdf / answers / tracker
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const STATE = join(root, '.scratch', 'eval-timing-state.json');
const TSV = join(root, 'data', 'eval-timings.tsv');

const [, , report, step, phase] = process.argv;

// 确保状态/日志目录存在
mkdirSync(dirname(STATE), { recursive: true });
mkdirSync(dirname(TSV), { recursive: true });

if (report === 'clear') {
  writeFileSync(STATE, '{}');
  console.log('timing state cleared');
  process.exit(0);
}

if (!report || !step || !phase || !['start', 'end'].includes(phase)) {
  console.error('用法: node log-eval-timing.mjs <报告号> <步骤> start|end');
  process.exit(1);
}

// 读状态；文件缺失/损坏按空状态处理，避免埋点本身打断评估
let state = {};
try {
  state = JSON.parse(readFileSync(STATE, 'utf8'));
} catch {}

const key = `${report}:${step}`;
const now = Date.now();

if (phase === 'start') {
  state[key] = now;
} else {
  const start = state[key];
  if (!start) {
    console.error(`缺少 start 标记: ${key}`);
    process.exit(1);
  }
  delete state[key];
  const seconds = ((now - start) / 1000).toFixed(1);
  const iso = new Date(now).toISOString();
  // 首次写文件时补表头，方便人读
  if (!existsSync(TSV)) {
    appendFileSync(TSV, '# report\tstep\tseconds\tfinished_at\n');
  }
  appendFileSync(TSV, `${report}\t${step}\t${seconds}\t${iso}\n`);
  console.log(`timed ${key}: ${seconds}s`);
}

writeFileSync(STATE, JSON.stringify(state));

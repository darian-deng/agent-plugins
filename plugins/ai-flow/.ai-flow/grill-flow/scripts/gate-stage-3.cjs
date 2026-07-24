#!/usr/bin/env node
// grill-flow stage-3 完成门（秒级结构检查，fail-closed）。
// 引擎在 AI 写 signal=done 时以 cwd=flowDir 跑 `node scripts/gate-stage-3.cjs`。
// stage-3 无人工 gate——通过即自动进 stage-4，所以这道门尤其必须 fail-closed：
// 显式断言"≥1 个已勾 ticket AND 无未勾 ticket"，绝不依赖"空文件天然失败"。
// 诚实定位：只防"忘做"（漏勾）+ 编译级破坏；拦不住 AI 谎标 [x] / 空实现——
// 真正反谎报靠 stage-4 全量测试 + 人工 gate。
'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const PASS = 0;
const FAIL = 1;
const err = (m) => process.stderr.write('❌  ' + m + '\n');

const flowDir = join(__dirname, '..');
const projectRoot = join(flowDir, '..', '..');

let flowId;
try {
  flowId = require(join(flowDir, 'state', 'active.json')).flow_id;
} catch (e) {
  err('无法读取 state/active.json 的 flow_id: ' + e.message);
  process.exit(FAIL);
}
if (!flowId) {
  err('active.json 缺 flow_id 字段');
  process.exit(FAIL);
}

const tickets = join(projectRoot, 'docs', 'grill-flows', flowId, 'tickets.md');
if (!existsSync(tickets)) {
  err('缺 tickets.md');
  process.exit(FAIL);
}

const text = readFileSync(tickets, 'utf-8');
const done = (text.match(/^- \[[xX]\] T\d/gm) || []).length;
const undone = (text.match(/^- \[ \] T\d/gm) || []).length;
// fail-closed：ticket 级行只认 [ ] / [x] / [X]。出现非标准 marker（如 [-] in-progress）
// 既不计 done 也不计 undone，会被误放行——显式拦下。
const allTicketLines = (text.match(/^- \[.\] T\d/gm) || []).length;
if (allTicketLines !== done + undone) {
  err('tickets.md 存在非标准复选框的 ticket 级行（只认 [ ] / [x]）');
  process.exit(FAIL);
}

if (undone > 0) {
  err('还有 ' + undone + ' 个未完成 ticket（未勾 - [ ] T<n>）');
  process.exit(FAIL);
}
if (done === 0) {
  // 空文件 / 无 ticket 级项都落这里——显式断言，不放行。
  err('tickets.md 无任何已完成 ticket 级项（空文件或格式不符）');
  process.exit(FAIL);
}

process.exit(PASS);

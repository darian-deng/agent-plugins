#!/usr/bin/env node
// grill-flow stage-3 完成门（秒级结构检查，fail-closed）。
// 引擎在 AI 写 signal=done 时以 cwd=flowDir 跑 `node scripts/gate-stage-3.cjs`。
// stage-3 无人工 gate——通过即自动进 stage-4，所以这道门尤其必须 fail-closed。
// 断言：① ≥1 已勾 ticket 且无未勾（只认标准复选框）；② qc:done 数 ≥ 已勾数；
//       ③ 每个 [x] ticket 在 base_sha_code..HEAD 有一笔 message 含该 ticket 号的 commit
//          （防"勾了 [x] 却没做 / 没 commit"）。
// 诚实定位：拦"忘做 / 漏 commit / 漏 qc"+ 编译级破坏；拦不住"有 commit 但空实现 / 谎标"——
//          那靠 stage-4 全量测试 + 人工 gate。
'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');
const { execFileSync } = require('child_process');

const PASS = 0;
const FAIL = 1;
const err = (m) => process.stderr.write('❌  ' + m + '\n');

const flowDir = join(__dirname, '..');
const projectRoot = join(flowDir, '..', '..');

let state;
try {
  state = require(join(flowDir, 'state', 'active.json'));
} catch (e) {
  err('无法读取 state/active.json: ' + e.message);
  process.exit(FAIL);
}

const flowId = state.flow_id;
if (!flowId) {
  err('active.json 缺 flow_id 字段');
  process.exit(FAIL);
}

// base_sha_code 由 stage-3 入场 Step 1 的 mark-base 触发引擎捕获、写入 active.json。
// 缺它无法核对 ticket↔commit —— fail-closed。
const baseSha = state.base_sha_code;
if (!baseSha) {
  err('active.json 缺 base_sha_code（stage-3 入场 Step 1 未触发 mark-base 捕获？无法核对 ticket↔commit）');
  process.exit(FAIL);
}

const tickets = join(projectRoot, 'docs', 'grill-flows', flowId, 'tickets.md');
if (!existsSync(tickets)) {
  err('缺 tickets.md');
  process.exit(FAIL);
}

const text = readFileSync(tickets, 'utf-8');
const doneNums = [...text.matchAll(/^- \[[xX]\] (T\d+)/gm)].map((m) => m[1]);
const undone = (text.match(/^- \[ \] T\d/gm) || []).length;
// fail-closed：ticket 级行只认 [ ] / [x] / [X]。非标准 marker（如 [-] in-progress）
// 既不计 done 也不计 undone，会被误放行——显式拦下。
const allTicketLines = (text.match(/^- \[.\] T\d/gm) || []).length;
if (allTicketLines !== doneNums.length + undone) {
  err('tickets.md 存在非标准复选框的 ticket 级行（只认 [ ] / [x]）');
  process.exit(FAIL);
}

if (undone > 0) {
  err('还有 ' + undone + ' 个未完成 ticket（未勾 - [ ] T<n>）');
  process.exit(FAIL);
}
if (doneNums.length === 0) {
  // 空文件 / 无 ticket 级项都落这里——显式断言，不放行。
  err('tickets.md 无任何已完成 ticket 级项（空文件或格式不符）');
  process.exit(FAIL);
}

// qc:done 数 ≥ 已勾数（每个走完 per-ticket 收尾的 ticket 都写了 qc:done）。
const qcCount = (text.match(/qc:done/g) || []).length;
if (qcCount < doneNums.length) {
  err('qc:done 标记数(' + qcCount + ') < 已勾 ticket 数(' + doneNums.length + ')——有 ticket 勾了 [x] 却没写 qc:done');
  process.exit(FAIL);
}

// 每个 [x] ticket 在 base_sha_code..HEAD 要有一笔 message 含该 ticket 号的 commit。
let log;
try {
  log = execFileSync('git', ['log', '--format=%s%n%b', baseSha + '..HEAD'], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
} catch (e) {
  err('git log ' + baseSha + '..HEAD 失败（base_sha_code 无效或非 git 仓库）: ' + (e.message || e));
  process.exit(FAIL);
}
// \bT<n>\b：词边界保证 T1 不误匹配 T10、T10 不误匹配 T1。
const missing = doneNums.filter((t) => !new RegExp('\\b' + t + '\\b').test(log));
if (missing.length > 0) {
  err('这些已勾 ticket 在 ' + baseSha.slice(0, 8) + '..HEAD 找不到对应 commit（message 需含 ticket 号）: ' + missing.join(', '));
  process.exit(FAIL);
}

process.exit(PASS);

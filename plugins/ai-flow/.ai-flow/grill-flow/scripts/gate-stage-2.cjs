#!/usr/bin/env node
// grill-flow stage-2 完成门（秒级结构检查，fail-closed）。
// 引擎在 AI 写 signal=done 时以 cwd=flowDir 跑 `node scripts/gate-stage-2.cjs`。
// exit 0 = 通过（随后进人工 gate）；非 0 = deny 写 signal，stderr 回给 AI 逼修。
// 只做结构检查（文件存在 + 段落非空 + ticket 格式），不跑测试、不做语义判断。
'use strict';

const { existsSync, readFileSync } = require('fs');
const { join } = require('path');

const PASS = 0;
const FAIL = 1;
const err = (m) => process.stderr.write('❌  ' + m + '\n');

// __dirname = <proj>/.ai-flow/grill-flow/scripts —— 用它定位，不依赖 cwd。
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

const docsDir = join(projectRoot, 'docs', 'grill-flows', flowId);
const spec = join(docsDir, 'spec.md');
const tickets = join(docsDir, 'tickets.md');
const html = join(docsDir, 'tech-design.html');

// fail-closed：每个被检文件先确认存在（缺文件直接失败，绝不放行）。
for (const [name, p] of [['spec.md', spec], ['tickets.md', tickets], ['tech-design.html', html]]) {
  if (!existsSync(p)) {
    err('缺文件: docs/grill-flows/' + flowId + '/' + name);
    process.exit(FAIL);
  }
}

// spec.md 三个段必须存在且非空（段标题到下一个 ## / 文件尾之间有非空白内容）。
// 段标题字符串与 stage-2 提示词写死一致（改一处必同步另一处，否则门永远失败）。
function sectionNonEmpty(text, heading) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 前缀匹配，不锚行尾——允许标题后带注解（如 "## User Stories（编号）"），
  // 避免注解诱导下门永远失败（见 design §14 必修1 的字符串对死风险）。
  const re = new RegExp('^##\\s+' + esc, 'm');
  const m = re.exec(text);
  if (!m) return false;
  const rest = text.slice(m.index + m[0].length);
  const nextIdx = rest.search(/^##\s/m);
  const body = (nextIdx === -1 ? rest : rest.slice(0, nextIdx)).trim();
  return body.length > 0;
}
const specText = readFileSync(spec, 'utf-8');
for (const h of ['User Stories', 'Testing Decisions', '方案审查']) {
  if (!sectionNonEmpty(specText, h)) {
    err('spec.md 的 "## ' + h + '" 段缺失或为空');
    process.exit(FAIL);
  }
}

// tickets.md：至少 1 个 ticket 级项（- [ ] T<n> / - [x] T<n>），且每个都声明 Blocked by。
const lines = readFileSync(tickets, 'utf-8').split('\n');
const idxs = [];
lines.forEach((l, i) => { if (/^- \[[ xX]\] T\d/.test(l)) idxs.push(i); });
if (idxs.length === 0) {
  err('tickets.md 无 ticket 级项（应形如 "- [ ] T1 <标题>"）');
  process.exit(FAIL);
}
for (let k = 0; k < idxs.length; k++) {
  const start = idxs[k];
  const end = k + 1 < idxs.length ? idxs[k + 1] : lines.length;
  const block = lines.slice(start, end).join('\n');
  if (!/Blocked by/i.test(block)) {
    err('ticket 缺 "Blocked by" 声明: ' + lines[start].trim());
    process.exit(FAIL);
  }
}

process.exit(PASS);

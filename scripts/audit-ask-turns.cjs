#!/usr/bin/env node
// 抽查 ai-flow session 的 transcript：找出「把下一步交给开发者」的回合，看它之前有没有走
// grill-flow 的提问纪律（references/ask-before-asking.md 的三步 + 岔路表的动作格）。
//
// 用法：
//   node scripts/audit-ask-turns.cjs [--days N] [--all] [transcript.jsonl | 目录 ...]
//     不给路径 → 扫 ~/.claude/projects 下最近 N 天（默认 7）改过的 .jsonl
//     --all    → 连「合规」的回合也列出来（默认只列疑似违规）
//
// 只审 grill-flow stage-3 的回合：以 transcript 里**最近一次**引擎注入（hook 的 additionalContext）
// 带的「grill-flow 第 3/5 步」为准——纪律写在 stage-3 提示词里，别的 stage / flow 不适用。
//
// 「交给开发者的回合」两种：
//   tool  = 调了 AskUserQuestion
//   text  = 一个回合（到下一条真人消息为止）的最后一段正文以问句收尾，或含「待拍板」「要你拍」
//           ——⚠️ 这是启发式，会有误报（比如回答里顺带反问），也会漏报（不带问号的交还）。
// 每个回合给三项事实（自上一条真人消息、且自最近一次 /clear 以来）：
//   ask  = 读过 ask-before-asking.md
//   act  = 读过动作格文档（mid-flight-ticket / side-fix / revision-protocol）
//   agent= 派过子代理（Agent 工具）——三步里「先派对抗审查」的必要条件，不是充分条件
// 三项全无 ⇒ 列为「疑似违规」。判不判得上违规要人看原文：有些回合本就该问（安全红线、L1/L2）。
// 另一类单独标：以「要我现在开吗 / 要不要继续」收尾 = stage-3「连续执行」禁止的 check-in，
// 三项事实救不了它（同一回合里前面派过子代理，照样不该停下来问要不要继续）。

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
let days = 7;
let showAll = false;
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days') days = Number(args[++i]);
  else if (args[i] === '--all') showAll = true;
  else targets.push(args[i]);
}

function collect(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) for (const f of fs.readdirSync(p)) collect(path.join(p, f), out);
  else if (p.endsWith('.jsonl')) out.push(p);
}

const files = [];
if (targets.length) for (const t of targets) collect(t, files);
else {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const since = Date.now() - days * 86400e3;
  const all = [];
  collect(root, all);
  // 子代理的 transcript 在 <session>/subagents/ 下：它们不对开发者提问，不在审计范围。
  for (const f of all) if (!f.includes(`${path.sep}subagents${path.sep}`) && fs.statSync(f).mtimeMs >= since) files.push(f);
}

const ACTION_DOCS = /(mid-flight-ticket|side-fix|revision-protocol)\.md/;
const ASK_DOC = /ask-before-asking\.md/;
const HANDOFF_TEXT = /待拍板|要你拍|你来拍|你来定/;
const STAGE_MARK = 'grill-flow 第 3/5 步';
const ANY_STAGE = /\S+-flow 第 \d+\/\d+ 步/;
const CHECKIN_TEXT = /要我(现在)?(开|开始|继续)(吗|？|\?)|要不要继续|是否继续/;

function contentBlocks(msg) {
  const c = msg && msg.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
}

// 真人消息：不是工具结果、不是系统注入的通知 / 子代理回报 / 本地命令回显。
function isHumanTurn(entry) {
  if (entry.type !== 'user' || entry.isMeta) return false;
  const blocks = contentBlocks(entry.message);
  if (blocks.some((b) => b.type === 'tool_result')) return false;
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) return false;
  return !/^(<task-notification>|<local-command|<command-|Another Claude session sent a message|\[SYSTEM NOTIFICATION)/.test(text);
}

function isClear(entry) {
  return entry.type === 'user' && contentBlocks(entry.message)
    .some((b) => b.type === 'text' && /<command-name>\/clear<\/command-name>/.test(b.text));
}

function toolInputText(b) {
  try { return JSON.stringify(b.input); } catch { return ''; }
}

let flagged = 0;
let total = 0;
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of raw) { try { entries.push(JSON.parse(line)); } catch { /* 半行：进行中的 session */ } }
  if (!raw.some((l) => l.includes(STAGE_MARK))) continue;

  let facts = { ask: false, act: false, agent: false };
  let turn = null; // { kind, text, ts, idx }
  let inStage3 = false;
  const report = (t, f) => {
    if (!inStage3) return;
    total++;
    const checkin = t.kind === 'text' && CHECKIN_TEXT.test(t.text.slice(-200));
    const ok = !checkin && (f.ask || f.act || f.agent);
    if (!ok) flagged++;
    if (ok && !showAll) return;
    const mark = checkin ? '🟠   ' : ok ? '  ok ' : '🔴   ';
    const snippet = t.text.replace(/\s+/g, ' ').slice(-160);
    console.log(`${mark}${path.basename(file)} #${t.idx} ${t.ts || ''} [${t.kind}] ask=${+f.ask} act=${+f.act} agent=${+f.agent}`);
    console.log(`       …${snippet}`);
  };
  const closeTurn = () => { if (turn) report(turn, facts); turn = null; };

  entries.forEach((e, idx) => {
    if (e.type === 'attachment' && e.attachment && e.attachment.type === 'hook_additional_context') {
      const c = e.attachment.content;
      const m = ANY_STAGE.exec(Array.isArray(c) ? c.join('\n') : String(c));
      if (m) { closeTurn(); inStage3 = m[0] === STAGE_MARK; }
      return;
    }
    if (isClear(e)) { closeTurn(); facts = { ask: false, act: false, agent: false }; return; }
    if (isHumanTurn(e)) { closeTurn(); facts = { ask: false, act: false, agent: false }; return; }
    if (e.type !== 'assistant') return;
    for (const b of contentBlocks(e.message)) {
      if (b.type === 'tool_use') {
        const input = toolInputText(b);
        if (ASK_DOC.test(input)) facts.ask = true;
        if (ACTION_DOCS.test(input)) facts.act = true;
        if (b.name === 'Agent' || b.name === 'Task') facts.agent = true;
        if (b.name === 'AskUserQuestion') { closeTurn(); report({ kind: 'tool', text: input, ts: e.timestamp, idx }, { ...facts }); }
      } else if (b.type === 'text' && b.text.trim()) {
        // 回合里最后一段正文才算「收尾」；前面的正文被后来的覆盖。
        const t = b.text.trim();
        const asks = /[？?]\s*$/.test(t) || HANDOFF_TEXT.test(t);
        turn = asks ? { kind: 'text', text: t, ts: e.timestamp, idx } : null;
      }
    }
  });
  closeTurn();
}

console.log(`\n${files.length} 个 transcript · ${total} 个交还回合 · 疑似违规 ${flagged}（🔴 三项全无 · 🟠 要不要继续式 check-in）`);

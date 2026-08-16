#!/usr/bin/env node
// 把已安装插件里的 flow 定义（stages / references / scripts / config.json / helper.md / preflight）
// 覆盖到一个或多个项目的 `.ai-flow/<flow>/`，**保留运行状态 `state/`**。
//
// 为什么不用 `ai-flow install --flow <f> --dir <d> --force`：
//   0.57.0 之前那条命令会 `rmSync` 整个 flow 目录再拷模板，`state/` 一起没——而 `state/`
//   被 gitignore（`.ai-flow/*/state/`），里面是 active.json（flow 停在哪个 stage、两个 diff
//   基准、归属 session）、signal、mark-base、transitions.log。删了不可恢复：一次「想升级
//   stage 提示词」的重装会静默杀死正在跑的 flow。0.57.0 起已修，但**这个脚本不依赖你装的是
//   哪个版本**——它自己只删模板拥有的条目。
//
// 用法：
//   node upgrade-flows.cjs --project <项目根> [--project <另一个>] [--flow grill-flow] [--flow feat-flow]
//                          [--from <插件根>] [--dry-run] [--yes]
//   --flow 省略 = 升级该项目下已安装的全部 flow
//   --from 省略 = 自动取 ~/.claude/plugins/cache/darian-agent-plugins/ai-flow/ 下版本号最大的那个
//
// 退出码：0 全部成功；1 有任何一项被拒绝或失败（**拒绝发生在删除之前**，不会留下半吊子状态）。

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// `state/` 是引擎拥有的，模板从不带它。任何时候都不删。
const ENGINE_OWNED = new Set(['state']);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const many = (n) => argv.reduce((a, v, i) => (v === '--' + n && argv[i + 1] ? a.concat(argv[i + 1]) : a), []);
const one = (n) => many(n)[0];

const DRY = flag('dry-run');
const YES = flag('yes');

function die(msg) { process.stderr.write('❌ ' + msg + '\n'); process.exit(1); }
function say(msg) { process.stdout.write(msg + '\n'); }

// ── 找插件源 ──────────────────────────────────────────────────────────────────
function pluginRoot() {
  const given = one('from');
  if (given) return path.resolve(given);
  const base = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'darian-agent-plugins', 'ai-flow');
  if (!fs.existsSync(base)) die(`找不到插件缓存 ${base}\n   先跑 claude plugin update ai-flow@darian-agent-plugins --scope user，或用 --from 指定`);
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    return 0;
  };
  const vers = fs.readdirSync(base)
    .filter((d) => /^\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(base, d, '.ai-flow')))
    .sort(cmp);
  if (!vers.length) die(`${base} 下没有任何带 .ai-flow 的版本目录`);
  return path.join(base, vers[vers.length - 1]);
}

// ── 读状态（只读，不抛） ──────────────────────────────────────────────────────
function activeStateOf(dest) {
  const p = path.join(dest, 'state', 'active.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return { __unreadable: true }; }
}
function stageIdsOf(flowDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(flowDir, 'config.json'), 'utf-8'));
    return (cfg.stages || []).map((s) => String(s.id || '')).filter(Boolean);
  } catch { return []; }
}
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
const SRC_ROOT = pluginRoot();
const SRC_FLOWS = path.join(SRC_ROOT, '.ai-flow');
if (!fs.existsSync(SRC_FLOWS)) die(`插件源里没有 .ai-flow：${SRC_FLOWS}`);
let srcVersion = '(未知)';
try { srcVersion = JSON.parse(fs.readFileSync(path.join(SRC_ROOT, '.claude-plugin', 'plugin.json'), 'utf-8')).version; } catch {}

const projects = many('project');
if (!projects.length) die('至少要一个 --project <项目根>');
const wantFlows = many('flow');

say(`源：${SRC_ROOT}  (插件 v${srcVersion})`);
say(`模式：${DRY ? '试运行（只报告，不改动）' : '实际写入'}\n`);

// 第一遍：只检查，不动任何文件。任何一项不通过就整体退出。
const jobs = [];
for (const proj of projects) {
  const root = path.resolve(proj);
  const af = path.join(root, '.ai-flow');
  if (!fs.existsSync(af)) die(`${root} 下没有 .ai-flow 目录——确认项目根写对了`);
  const installed = fs.readdirSync(af).filter((d) => fs.existsSync(path.join(af, d, 'config.json')));
  const flows = wantFlows.length ? wantFlows : installed;
  for (const flow of flows) {
    const dest = path.join(af, flow);
    const src = path.join(SRC_FLOWS, flow);
    if (!fs.existsSync(path.join(src, 'config.json'))) die(`插件源里没有 flow '${flow}'（有的是：${fs.readdirSync(SRC_FLOWS).join(', ')}）`);
    if (!fs.existsSync(path.join(dest, 'config.json'))) die(`${root} 没装过 '${flow}'——这个脚本只做升级，不做首次安装（首次装用 /ai-flow:add）`);

    const live = activeStateOf(dest);
    if (live && live.__unreadable) die(`${dest}/state/active.json 读不出来（损坏？）——先人工确认，不敢在这上面动手`);
    if (live && live.current_stage) {
      const incoming = stageIdsOf(src);
      if (incoming.length && !incoming.includes(live.current_stage)) {
        die(`拒绝覆盖 ${dest}\n` +
            `   这里有一个正在跑的 flow（${live.flow_id}），停在 stage '${live.current_stage}'，\n` +
            `   而新模板的 config.json 里没有这个 stage（新的是：${incoming.join(', ')}）。\n` +
            `   直接覆盖会让它在下一次工具调用时抛异常、无法继续，而 state/ 不在 git 里、救不回来。\n` +
            `   先选一条：① 等它跑完；② \`${flow} abort\` 存快照；③ 手工改 state/active.json 的 current_stage。`);
      }
    }
    jobs.push({ root, flow, src, dest, live });
  }
}

say('将要升级：');
for (const j of jobs) {
  const tag = j.live ? `⚠️ 有正在跑的 flow：${j.live.flow_id}（stage ${j.live.current_stage}）—— state/ 会原样保留` : '（无运行中的 flow）';
  say(`  ${j.root}  →  ${j.flow}   ${tag}`);
}
say('');

if (DRY) { say('试运行结束，未改动任何文件。去掉 --dry-run 实际执行。'); process.exit(0); }
if (!YES && !process.env.CI) {
  say('这会覆盖上面这些 flow 的 stages / references / scripts / config.json / helper.md。');
  say('确认无误后加 --yes 重跑。');
  process.exit(0);
}

// 第二遍：执行。
let failed = 0;
for (const j of jobs) {
  try {
    // 只清模板拥有的条目，`state/` 一个字节都不碰
    for (const entry of fs.readdirSync(j.dest)) {
      if (ENGINE_OWNED.has(entry)) continue;
      fs.rmSync(path.join(j.dest, entry), { recursive: true, force: true });
    }
    fs.cpSync(j.src, j.dest, { recursive: true });
    const sh = path.join(j.dest, 'preflight.sh');
    if (fs.existsSync(sh)) { try { fs.chmodSync(sh, 0o755); } catch {} }

    // 落地后复核：状态还在、且新 config 认得它停的那个 stage
    const after = activeStateOf(j.dest);
    if (j.live && !after) die(`${j.dest}：升级后 state/active.json 不见了——这不该发生，立刻停下`);
    if (after && after.current_stage && !stageIdsOf(j.dest).includes(after.current_stage)) {
      die(`${j.dest}：升级后 current_stage='${after.current_stage}' 不在新 config.json 里`);
    }
    const n = walk(j.dest).filter((p) => !p.includes(`${path.sep}state${path.sep}`)).length;
    say(`✅ ${j.flow} @ ${j.root}   写入 ${n} 个文件${after ? `，state/ 保留（${after.flow_id} · ${after.current_stage}）` : ''}`);
  } catch (e) {
    failed++;
    process.stderr.write(`❌ ${j.flow} @ ${j.root}：${e && e.message ? e.message : String(e)}\n`);
  }
}

say('');
if (failed) { say(`有 ${failed} 项失败，见上。`); process.exit(1); }
say('全部完成。若目标 session 还开着，在那边跑 /reload-plugins 让引擎读到新定义。');

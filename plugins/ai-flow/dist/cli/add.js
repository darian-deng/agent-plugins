// src/cli/add.ts
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  cpSync,
  rmSync,
  chmodSync,
  appendFileSync,
  realpathSync
} from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { execFileSync, spawnSync } from "child_process";
var __dirname = dirname(fileURLToPath(import.meta.url));
var PLUGIN_ROOT = resolve(__dirname, "..", "..");
var PLUGIN_FLOWS_DIR = join(PLUGIN_ROOT, ".ai-flow");
var PROJECT_MARKERS = [
  "package.json",
  "pyproject.toml",
  "go.mod",
  "go.work",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "pnpm-workspace.yaml"
];
var ENGINE_OWNED_ENTRIES = /* @__PURE__ */ new Set(["state"]);
function wipeTemplateEntries(dest) {
  for (const entry of readdirSync(dest)) {
    if (ENGINE_OWNED_ENTRIES.has(entry)) continue;
    rmSync(join(dest, entry), { recursive: true, force: true });
  }
}
function liveFlowAt(dest) {
  const p = join(dest, "state", "active.json");
  if (!existsSync(p)) return null;
  try {
    const s = JSON.parse(readFileSync(p, "utf-8"));
    if (!s.current_stage) return null;
    return { flow_id: String(s.flow_id ?? "(\u672A\u77E5)"), current_stage: s.current_stage };
  } catch {
    return null;
  }
}
function stageIdsOf(flowDir) {
  try {
    const cfg = JSON.parse(readFileSync(join(flowDir, "config.json"), "utf-8"));
    return (cfg.stages ?? []).map((s) => String(s.id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}
function checkForceReinstall(src, dest, flowName) {
  const live = liveFlowAt(dest);
  if (!live) return { ok: true, live: null };
  const incoming = stageIdsOf(src);
  if (incoming.length === 0 || incoming.includes(live.current_stage)) return { ok: true, live };
  return {
    ok: false,
    reason: `\u62D2\u7EDD\u8986\u76D6:\u8FD9\u91CC\u6709\u4E00\u4E2A\u6B63\u5728\u8DD1\u7684 flow\uFF08${live.flow_id}\uFF09\uFF0C\u5B83\u505C\u5728 stage '${live.current_stage}'\uFF0C
\u800C\u65B0\u6A21\u677F\u7684 config.json \u91CC\u6CA1\u6709\u8FD9\u4E2A stage\uFF08\u65B0\u7684\u662F:${incoming.join(", ")}\uFF09\u3002
\u76F4\u63A5\u8986\u76D6\u4F1A\u8BA9\u5B83\u5728\u4E0B\u4E00\u6B21\u5DE5\u5177\u8C03\u7528\u65F6\u629B\u5F02\u5E38\u3001\u65E0\u6CD5\u7EE7\u7EED,\u800C\u4E14 state/ \u4E0D\u5728 git \u91CC\u3001\u6551\u4E0D\u56DE\u6765\u3002
\u5148\u9009\u4E00\u6761:\u2460 \u7B49\u5B83\u8DD1\u5B8C\u518D\u5347\u7EA7;\u2461 \`${flowName} abort\` \u5B58\u5FEB\u7167\u540E\u518D\u5347\u7EA7;\u2462 \u624B\u5DE5\u628A state/active.json \u7684 current_stage \u6539\u6210\u65B0\u914D\u7F6E\u91CC\u7684\u5BF9\u5E94 stage id,\u518D\u91CD\u8DD1\u672C\u547D\u4EE4\u3002`
  };
}
function builtinFlows() {
  if (!existsSync(PLUGIN_FLOWS_DIR)) return [];
  const out = [];
  for (const entry of readdirSync(PLUGIN_FLOWS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = join(PLUGIN_FLOWS_DIR, entry.name, "config.json");
    if (!existsSync(cfgPath)) continue;
    let description = "";
    try {
      description = String(JSON.parse(readFileSync(cfgPath, "utf-8")).description ?? "");
    } catch {
    }
    out.push({ name: entry.name, description });
  }
  return out;
}
function hasProjectMarker(dir) {
  for (const m of PROJECT_MARKERS) {
    if (existsSync(join(dir, m))) return m;
  }
  return null;
}
function nearestProjectRoot(dir) {
  let cur = resolve(dir);
  while (true) {
    const marker = hasProjectMarker(cur);
    if (marker) return { dir: cur, marker };
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
function canonical(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
function gitRoot(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function outerAiFlow(dir) {
  let cur = dirname(resolve(dir));
  while (true) {
    if (existsSync(join(cur, ".ai-flow"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}
function installedFlows(dir) {
  const af = join(dir, ".ai-flow");
  if (!existsSync(af)) return [];
  try {
    return readdirSync(af, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(af, e.name, "config.json"))).map((e) => e.name);
  } catch {
    return [];
  }
}
function detect(cwd) {
  const resolvedCwd = canonical(cwd);
  const git = gitRoot(resolvedCwd);
  const npr = nearestProjectRoot(resolvedCwd);
  const seen = /* @__PURE__ */ new Set();
  const candidates = [];
  const add = (dir, reason) => {
    if (!dir) return;
    const r = canonical(dir);
    if (seen.has(r)) return;
    seen.add(r);
    candidates.push({
      dir: r,
      reason,
      isCwd: r === resolvedCwd,
      outerAiFlow: outerAiFlow(r),
      existingFlows: installedFlows(r)
    });
  };
  if (hasProjectMarker(resolvedCwd)) add(resolvedCwd, `\u5F53\u524D\u76EE\u5F55\u5C31\u662F\u9879\u76EE\u6839(${hasProjectMarker(resolvedCwd)})`);
  if (npr && npr.dir !== resolvedCwd) add(npr.dir, `\u6700\u8FD1\u7684\u9879\u76EE\u6839(${npr.marker})`);
  add(git, "git \u6839");
  if (candidates.length === 0) add(resolvedCwd, "\u5F53\u524D\u76EE\u5F55(\u65E0\u9879\u76EE\u6807\u8BB0\u3001\u975E git \u4ED3)");
  return {
    cwd: resolvedCwd,
    gitRoot: git,
    recommended: candidates[0]?.dir ?? resolvedCwd,
    candidates
  };
}
function fail(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}
function install(flow, dir, force) {
  const src = join(PLUGIN_FLOWS_DIR, flow);
  if (!existsSync(join(src, "config.json"))) {
    fail(`\u5185\u7F6E flow '${flow}' \u4E0D\u5B58\u5728\u3002\u53EF\u7528:${builtinFlows().map((f) => f.name).join(", ") || "(\u65E0)"}`);
  }
  const target = resolve(dir);
  if (!existsSync(target)) fail(`\u76EE\u6807\u76EE\u5F55\u4E0D\u5B58\u5728:${target}`);
  const dest = join(target, ".ai-flow", flow);
  const lines = [];
  if (existsSync(join(dest, "config.json")) && !force) {
    fail(`'${flow}' \u5DF2\u5B89\u88C5\u5728 ${target}/.ai-flow/${flow}\u3002\u5982\u9700\u8986\u76D6,\u91CD\u8DD1\u5E76\u52A0 --force\u3002`);
  }
  const outer = outerAiFlow(target);
  if (outer) {
    lines.push(`\u26A0\uFE0F  \u5916\u5C42\u76EE\u5F55\u5DF2\u5B58\u5728 .ai-flow:${outer}`);
    lines.push(`    \u5728 ${target} \u5B89\u88C5\u540E,\u5728\u6B64\u5B50\u6811\u5DE5\u4F5C\u65F6\u5F15\u64CE\u4F1A\u5C31\u8FD1\u951A\u5B9A\u5230 ${target}/.ai-flow,`);
    lines.push(`    **\u5B8C\u5168\u5C4F\u853D** ${outer}/.ai-flow \u7684 flow(\u8FD9\u662F\u9879\u76EE\u9694\u79BB\u7684\u9884\u671F\u884C\u4E3A)\u3002\u786E\u8BA4\u8FD9\u662F\u4F60\u8981\u7684\u3002`);
    lines.push("");
  }
  if (force && existsSync(dest)) {
    const check = checkForceReinstall(src, dest, flow);
    if (!check.ok) fail(`${check.reason}
\u4F4D\u7F6E:${dest}`);
    if (check.live) {
      lines.push(`\u26A0\uFE0F  ${dest} \u6709\u4E00\u4E2A\u6B63\u5728\u8DD1\u7684 flow:${check.live.flow_id}\uFF08\u5F53\u524D stage:${check.live.current_stage}\uFF09`);
      lines.push(`    \u8986\u76D6\u4F1A**\u7ACB\u5373\u6362\u6389\u5B83\u540E\u7EED\u8981\u7528\u7684 stage \u63D0\u793A\u8BCD / references / scripts**;`);
      lines.push(`    \u8FD0\u884C\u72B6\u6001(state/)\u539F\u6837\u4FDD\u7559,flow \u4E0D\u4F1A\u4E2D\u65AD\u3002\u82E5\u8BE5 session \u8FD8\u5F00\u7740,\`/reload-plugins\` \u540E\u7EE7\u7EED\u5373\u53EF\u3002`);
      lines.push("");
    }
    wipeTemplateEntries(dest);
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  const preflightSh = join(dest, "preflight.sh");
  if (existsSync(preflightSh)) {
    try {
      chmodSync(preflightSh, 493);
    } catch {
    }
  }
  ensureGitignore(target);
  lines.push(`\u2705 \u5DF2\u5B89\u88C5 '${flow}' \u2192 ${dest}`);
  lines.push("");
  const preflightResult = runPreflight(dest, target);
  if (preflightResult !== null) {
    lines.push(preflightResult.ok ? "\u2705 preflight \u901A\u8FC7" : "\u274C preflight \u672A\u901A\u8FC7(flow \u5DF2\u5B89\u88C5,\u8865\u9F50\u4E0B\u5217\u4F9D\u8D56\u540E\u5373\u53EF\u542F\u52A8):");
    if (preflightResult.output.trim()) lines.push(preflightResult.output.trimEnd());
    lines.push("");
  }
  let desc = "";
  try {
    desc = String(JSON.parse(readFileSync(join(dest, "config.json"), "utf-8")).description ?? "");
  } catch {
  }
  lines.push(`\u{1F4CB} ${flow}${desc ? " \u2014 " + desc : ""}`);
  lines.push(`\u951A\u70B9(\u9879\u76EE\u6839):${target}`);
  lines.push(`\u542F\u52A8:\u5728 ${target} \u76EE\u5F55\u7684 session \u91CC\u8F93\u5165  ${flow} start <\u9700\u6C42\u63CF\u8FF0>`);
  lines.push(`\u67E5\u770B\u6D41\u7A0B:${flow} help`);
  process.stdout.write(lines.join("\n") + "\n");
}
function ensureGitignore(target) {
  const root = gitRoot(target) ?? target;
  const giPath = join(root, ".gitignore");
  const rules = ["**/.ai-flow/**/state/", ".worktrees/"];
  let existing = "";
  try {
    existing = existsSync(giPath) ? readFileSync(giPath, "utf-8") : "";
  } catch {
  }
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = rules.filter((r) => !present.has(r));
  if (missing.length === 0) return;
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  try {
    appendFileSync(giPath, `${prefix}${missing.join("\n")}
`);
  } catch {
  }
}
function runPreflight(flowDir, cwd) {
  let res;
  const cjs = join(flowDir, "preflight.cjs");
  const mjs = join(flowDir, "preflight.mjs");
  const sh = join(flowDir, "preflight.sh");
  if (existsSync(cjs)) res = spawnSync(process.execPath, [cjs], { cwd, encoding: "utf-8", timeout: 3e4 });
  else if (existsSync(mjs)) res = spawnSync(process.execPath, [mjs], { cwd, encoding: "utf-8", timeout: 3e4 });
  else if (existsSync(sh)) res = spawnSync("sh", [sh], { cwd, encoding: "utf-8", timeout: 3e4 });
  else return null;
  const output = [res.stdout, res.stderr].filter(Boolean).join("\n");
  return { ok: res.status === 0, output };
}
function getOpt(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : void 0;
}
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd === "list") {
    process.stdout.write(JSON.stringify(builtinFlows(), null, 2) + "\n");
    return;
  }
  if (cmd === "detect") {
    const cwd = getOpt(argv, "cwd") ?? process.cwd();
    process.stdout.write(JSON.stringify(detect(cwd), null, 2) + "\n");
    return;
  }
  if (cmd === "install") {
    const flow = getOpt(argv, "flow");
    const dir = getOpt(argv, "dir") ?? process.cwd();
    const force = argv.includes("--force");
    if (!flow) fail("\u7528\u6CD5:install --flow <name> --dir <dir> [--force]");
    install(flow, dir, force);
    return;
  }
  fail(`\u672A\u77E5\u547D\u4EE4:${cmd ?? "(\u7A7A)"}\u3002\u53EF\u7528:list | detect | install`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
export {
  builtinFlows,
  checkForceReinstall,
  detect,
  ensureGitignore,
  nearestProjectRoot,
  wipeTemplateEntries
};

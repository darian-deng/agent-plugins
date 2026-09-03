// src/cli/add.ts
import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
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
function overrideKeys(configPath) {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed);
  } catch {
    return [];
  }
}
function stageIdsOf(configPath) {
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
    return (cfg.stages ?? []).map((s) => String(s.id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}
function forceWouldStrandFlow(defConfigPath, overridePath, live) {
  if (!live) return { stranded: false };
  if (!overrideKeys(overridePath).includes("stages")) return { stranded: false };
  const incoming = stageIdsOf(defConfigPath);
  if (incoming.length === 0 || incoming.includes(live.current_stage)) return { stranded: false };
  return { stranded: true, incoming };
}
function install(flow, dir, force) {
  const defDir = join(PLUGIN_FLOWS_DIR, flow);
  if (!existsSync(join(defDir, "config.json"))) {
    fail(`\u5185\u7F6E flow '${flow}' \u4E0D\u5B58\u5728\u3002\u53EF\u7528:${builtinFlows().map((f) => f.name).join(", ") || "(\u65E0)"}`);
  }
  const target = resolve(dir);
  if (!existsSync(target)) fail(`\u76EE\u6807\u76EE\u5F55\u4E0D\u5B58\u5728:${target}`);
  const dest = join(target, ".ai-flow", flow);
  const overridePath = join(dest, "config.json");
  const alreadyInstalled = existsSync(overridePath);
  const lines = [];
  const outer = outerAiFlow(target);
  if (outer) {
    lines.push(`\u26A0\uFE0F  \u5916\u5C42\u76EE\u5F55\u5DF2\u5B58\u5728 .ai-flow:${outer}`);
    lines.push(`    \u5728 ${target} \u5B89\u88C5\u540E,\u5728\u6B64\u5B50\u6811\u5DE5\u4F5C\u65F6\u5F15\u64CE\u4F1A\u5C31\u8FD1\u951A\u5B9A\u5230 ${target}/.ai-flow,`);
    lines.push(`    **\u5B8C\u5168\u5C4F\u853D** ${outer}/.ai-flow \u7684 flow(\u8FD9\u662F\u9879\u76EE\u9694\u79BB\u7684\u9884\u671F\u884C\u4E3A)\u3002\u786E\u8BA4\u8FD9\u662F\u4F60\u8981\u7684\u3002`);
    lines.push("");
  }
  const live = liveFlowAt(dest);
  if (live) {
    lines.push(`\u2139\uFE0F  ${dest} \u6709\u4E00\u4E2A\u6B63\u5728\u8DD1\u7684 flow:${live.flow_id}(\u5F53\u524D stage:${live.current_stage})`);
    lines.push(`    \u5B83\u7684 stage \u63D0\u793A\u8BCD / references / scripts \u88C5\u5728\u63D2\u4EF6\u91CC\u3001\u968F\u63D2\u4EF6\u7248\u672C\u8D70,\u672C\u547D\u4EE4\u4E00\u4E2A\u5B57\u90FD\u4E0D\u4F1A\u52A8;`);
    lines.push(`    \u8FD0\u884C\u72B6\u6001(state/)\u539F\u6837\u4FDD\u7559,flow \u4E0D\u4F1A\u4E2D\u65AD\u3002`);
    lines.push("");
  }
  mkdirSync(dest, { recursive: true });
  if (!alreadyInstalled) {
    writeFileSync(overridePath, "{}\n");
    lines.push(`\u2705 \u5DF2\u5B89\u88C5 '${flow}' \u2192 ${dest}`);
  } else if (!force) {
    lines.push(`\u2705 '${flow}' \u5DF2\u88C5\u5728 ${dest},\u672C\u6B21\u53EA\u8865\u9F50\u7F3A\u5931\u7684\u90E8\u5206\u3002`);
    lines.push(`    config.json(\u9879\u76EE\u4FA7\u7A00\u758F\u8986\u76D6\u5C42)\u4FDD\u6301\u539F\u6837\u672A\u52A8\u2014\u2014\u8981\u628A\u5B83\u91CD\u7F6E\u6210 {} \u8BF7\u91CD\u8DD1\u5E76\u52A0 --force\u3002`);
  } else {
    const strand = forceWouldStrandFlow(join(defDir, "config.json"), overridePath, live);
    if (strand.stranded) {
      fail(
        `\u62D2\u7EDD\u91CD\u7F6E:\u8FD9\u91CC\u6709\u4E00\u4E2A\u6B63\u5728\u8DD1\u7684 flow(${live.flow_id}),\u5B83\u505C\u5728 stage '${live.current_stage}',
\u800C\u9879\u76EE\u4FA7 config.json \u7528\u81EA\u5DF1\u7684 stages \u8986\u76D6\u4E86\u63D2\u4EF6\u7684\u9636\u6BB5\u8868\u3002\u91CD\u7F6E\u6210 {} \u4E4B\u540E\u9636\u6BB5\u8868\u6362\u6210\u63D2\u4EF6\u90A3\u4EFD
(${strand.incoming.join(", ")}),\u91CC\u9762\u6CA1\u6709 '${live.current_stage}'\u3002
\u540E\u679C\u4E0D\u662F\u62A5\u9519\u800C\u662F**\u9759\u9ED8\u5931\u6548**:\u5F15\u64CE\u4E24\u6761\u70ED\u8DEF\u5F84\u90FD\u4F1A\u6355\u83B7\u5F02\u5E38\u5E76\u653E\u884C,\u4E8E\u662F\u65B0 session \u4E0D\u518D\u6CE8\u5165
stage \u63D0\u793A\u8BCD\u3001PreToolUse \u7684\u5B88\u536B\u5168\u90E8 fail open\u3001signal \u4E5F\u4E0D\u518D\u88AB\u62E6\u622A,flow \u6C38\u8FDC\u63A8\u8FDB\u4E0D\u4E0B\u53BB,
\u53EA\u5728 flow.log \u7559\u4E00\u884C ERROR\u3002
\u5148\u9009\u4E00\u6761:\u2460 \u7B49\u5B83\u8DD1\u5B8C\u518D\u91CD\u7F6E;\u2461 \`${flow} abort\` \u5B58\u5FEB\u7167\u540E\u518D\u91CD\u7F6E;\u2462 \u624B\u5DE5\u628A state/active.json \u7684 current_stage \u6539\u6210\u63D2\u4EF6\u9636\u6BB5\u8868\u91CC\u7684\u5BF9\u5E94 id,\u518D\u91CD\u8DD1\u672C\u547D\u4EE4\u3002
\u4F4D\u7F6E:${dest}`
      );
    }
    const kept = overrideKeys(overridePath);
    if (kept.length > 0) {
      lines.push(`\u26A0\uFE0F  --force:\u4E0B\u9762\u8FD9\u4EFD\u9879\u76EE\u4FA7 config.json \u88AB\u91CD\u7F6E\u6210\u4E86 {},\u539F\u5185\u5BB9\u5728\u6B64(git \u91CC\u4E5F\u8FD8\u80FD\u627E\u56DE):`);
      lines.push("```json");
      lines.push(readFileSync(overridePath, "utf-8").trimEnd());
      lines.push("```");
      lines.push(`    \u91CD\u7F6E\u540E\u672C flow \u5168\u90E8\u4F7F\u7528\u63D2\u4EF6\u9ED8\u8BA4\u503C(${join(defDir, "config.json")})\u3002`);
      if (kept.includes("stages")) {
        lines.push(`    \u26A0\uFE0F \u4E22\u6389\u7684\u952E\u91CC\u6709 stages:\u9636\u6BB5\u8868\u5C06\u6362\u56DE\u63D2\u4EF6\u9ED8\u8BA4\u7684\u90A3\u4E00\u4EFD\u3002`);
      }
      lines.push("");
    }
    writeFileSync(overridePath, "{}\n");
    lines.push(`\u2705 \u5DF2\u91CD\u7F6E '${flow}' \u7684\u9879\u76EE\u4FA7\u8986\u76D6\u5C42 \u2192 ${overridePath}`);
  }
  mkdirSync(join(dest, "state"), { recursive: true });
  ensureGitignore(target);
  lines.push("");
  const preflightResult = runPreflight(defDir, target, dest);
  if (preflightResult !== null) {
    lines.push(preflightResult.ok ? "\u2705 preflight \u901A\u8FC7" : "\u274C preflight \u672A\u901A\u8FC7(\u951A\u70B9\u5DF2\u5EFA\u597D,\u8865\u9F50\u4E0B\u5217\u4F9D\u8D56\u540E\u5373\u53EF\u542F\u52A8):");
    if (preflightResult.output.trim()) lines.push(preflightResult.output.trimEnd());
    lines.push("");
  }
  let desc = "";
  try {
    desc = String(JSON.parse(readFileSync(join(defDir, "config.json"), "utf-8")).description ?? "");
  } catch {
  }
  lines.push(`\u{1F4CB} ${flow}${desc ? " \u2014 " + desc : ""}`);
  lines.push(`\u6D41\u7A0B\u5B9A\u4E49(\u968F\u63D2\u4EF6\u7248\u672C\u8D70,\u4E0D\u590D\u5236\u5230\u9879\u76EE):${defDir}`);
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
function runPreflight(defDir, cwd, anchorDir) {
  let res;
  const env = { ...process.env, AI_FLOW_FLOW_DIR: anchorDir, AI_FLOW_PROJECT_ROOT: cwd };
  const opts = { cwd, env, encoding: "utf-8", timeout: 3e4 };
  const cjs = join(defDir, "preflight.cjs");
  const mjs = join(defDir, "preflight.mjs");
  const sh = join(defDir, "preflight.sh");
  if (existsSync(cjs)) res = spawnSync(process.execPath, [cjs], opts);
  else if (existsSync(mjs)) res = spawnSync(process.execPath, [mjs], opts);
  else if (existsSync(sh)) res = spawnSync("sh", [sh], opts);
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
  detect,
  ensureGitignore,
  forceWouldStrandFlow,
  install,
  nearestProjectRoot
};

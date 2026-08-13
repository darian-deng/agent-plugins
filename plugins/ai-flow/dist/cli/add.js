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
  if (force && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
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
  detect,
  ensureGitignore,
  nearestProjectRoot
};

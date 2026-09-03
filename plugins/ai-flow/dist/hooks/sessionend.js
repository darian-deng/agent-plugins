#!/usr/bin/env node

// src/hooks/sessionend.ts
import { readFileSync as readFileSync3 } from "fs";

// src/lib/state.ts
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  writeFileSync as writeFileSync2,
  readFileSync as readFileSync2,
  readdirSync as readdirSync2,
  appendFileSync,
  renameSync as renameSync2,
  openSync,
  closeSync,
  unlinkSync as unlinkSync2,
  statSync,
  realpathSync
} from "fs";
import { randomBytes } from "crypto";
import { execFileSync } from "child_process";
import { join as join2, dirname, resolve, relative } from "path";

// src/lib/session-registry.ts
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
function claudeDir() {
  return process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");
}
function registryDir() {
  return join(claudeDir(), "ai-flow", "sessions");
}
function bindingPath(sessionId) {
  const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(registryDir(), `${safe}.json`);
}
function lookupSession(sessionId) {
  try {
    const p = bindingPath(sessionId);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    if (!parsed || typeof parsed.projectRoot !== "string" || typeof parsed.flowName !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function unbindSession(sessionId) {
  try {
    const p = bindingPath(sessionId);
    if (existsSync(p)) unlinkSync(p);
  } catch {
  }
}
function listBindings() {
  try {
    const dir = registryDir();
    if (!existsSync(dir)) return [];
    const out = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if (parsed && typeof parsed.sessionId === "string" && typeof parsed.projectRoot === "string" && typeof parsed.flowName === "string") {
          out.push(parsed);
        }
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  }
}
function removeBinding(sessionId) {
  unbindSession(sessionId);
}

// src/lib/state.ts
function statePath(repoRoot, flowName, file) {
  return join2(repoRoot, ".ai-flow", flowName, "state", file);
}
function stateDir(repoRoot, flowName) {
  return join2(repoRoot, ".ai-flow", flowName, "state");
}
function normalizeActiveState(parsed) {
  const { context_warning: legacy, context_blocked: legacyLatched, ...rest } = parsed;
  if (rest.context_wrap_up && typeof rest.context_wrap_up === "object") return rest;
  const latched = legacyLatched === true;
  const atPct = latched ? legacy?.warned_at_pct ?? null : null;
  return { ...rest, context_wrap_up: { at_pct: atPct } };
}
async function readActiveState(repoRoot, flowName) {
  const path = statePath(repoRoot, flowName, "active.json");
  if (!existsSync2(path)) return null;
  try {
    return normalizeActiveState(JSON.parse(readFileSync2(path, "utf-8")));
  } catch {
    return null;
  }
}
async function writeActiveState(repoRoot, flowName, state) {
  const dir = stateDir(repoRoot, flowName);
  mkdirSync2(dir, { recursive: true });
  const tmp = statePath(repoRoot, flowName, `active.json.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync2(tmp, JSON.stringify(state, null, 2));
  renameSync2(tmp, statePath(repoRoot, flowName, "active.json"));
}
var LOCK_STALE_MS = 1e4;
var LOCK_POLL_MS = 8;
var LOCK_MAX_WAIT_MS = 1e3;
async function acquireStateLock(repoRoot, flowName) {
  const lockPath = statePath(repoRoot, flowName, "active.json.lock");
  mkdirSync2(stateDir(repoRoot, flowName), { recursive: true });
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  for (; ; ) {
    try {
      closeSync(openSync(lockPath, "wx"));
      return () => {
        try {
          unlinkSync2(lockPath);
        } catch {
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync2(lockPath);
      } catch {
      }
    }
    if (Date.now() >= deadline) return () => {
    };
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
}
async function patchActiveState(repoRoot, flowName, patch) {
  const release = await acquireStateLock(repoRoot, flowName);
  try {
    const current = await readActiveState(repoRoot, flowName);
    if (!current) return null;
    const merged = { ...current, ...typeof patch === "function" ? patch(current) : patch };
    await writeActiveState(repoRoot, flowName, merged);
    return merged;
  } finally {
    release();
  }
}
function isInsideLinkedWorktree(dir) {
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const [gitDir, commonDir] = out.trim().split("\n");
    if (!gitDir || !commonDir) return false;
    return resolve(gitDir) !== resolve(commonDir);
  } catch {
    return false;
  }
}
function realPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
async function anchorFlow(dir) {
  const aiFlowDir = join2(dir, ".ai-flow");
  if (!existsSync2(aiFlowDir)) return null;
  for (const entry of readdirSync2(aiFlowDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const state = await readActiveState(dir, entry.name);
    if (state) return { flowName: entry.name, state, repoRoot: dir };
  }
  return null;
}
function siblingCheckoutAnchors(dir) {
  try {
    const out = execFileSync(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    );
    const [commonDir, wtRoot] = out.trim().split("\n");
    if (!commonDir || !wtRoot) return [];
    const self = realPath(dir);
    const rel = relative(resolve(wtRoot), self);
    if (rel.startsWith("..")) return [];
    const roots = execFileSync("git", ["-C", dir, "worktree", "list", "--porcelain"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length).trim()).filter(Boolean);
    const mainRoot = dirname(resolve(commonDir));
    const sharedPrefix = (a, b) => {
      const x = a.split("/"), y = b.split("/");
      let n = 0;
      while (n < x.length && n < y.length && x[n] === y[n]) n++;
      return n;
    };
    const ordered = [mainRoot, ...roots.filter((r) => resolve(r) !== mainRoot)].sort((a, b) => sharedPrefix(resolve(b), self) - sharedPrefix(resolve(a), self));
    const seen = /* @__PURE__ */ new Set();
    const out2 = [];
    for (const root of ordered) {
      const cand = rel ? join2(root, rel) : root;
      const key = resolve(cand);
      if (key === self || seen.has(key)) continue;
      seen.add(key);
      out2.push(cand);
    }
    return out2;
  } catch {
    return [];
  }
}
async function hasActiveFlow(cwd) {
  let dir = cwd;
  while (true) {
    if (existsSync2(join2(dir, ".ai-flow"))) {
      const here = await anchorFlow(dir);
      if (here) return here;
      if (!isInsideLinkedWorktree(dir)) return null;
      const candidates = siblingCheckoutAnchors(dir);
      if (candidates.length > 0) {
        for (const cand of candidates) {
          if (!existsSync2(join2(cand, ".ai-flow"))) continue;
          const over = await anchorFlow(cand);
          if (over) return { ...over, viaSibling: true };
        }
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
async function resolveActiveFlow(cwd, sessionId) {
  if (sessionId) {
    const binding = lookupSession(sessionId);
    if (binding) {
      const state = await readActiveState(binding.projectRoot, binding.flowName);
      if (state) {
        return { flowName: binding.flowName, state, repoRoot: binding.projectRoot };
      }
    }
  }
  return hasActiveFlow(cwd);
}
async function gcRegistry() {
  for (const b of listBindings()) {
    let dead = false;
    try {
      const state = await readActiveState(b.projectRoot, b.flowName);
      if (!state || state.last_session_id !== null && state.last_session_id !== b.sessionId) dead = true;
    } catch {
      dead = true;
    }
    if (dead) removeBinding(b.sessionId);
  }
}
async function appendLog(repoRoot, flowName, sessionId, message) {
  const logPath = statePath(repoRoot, flowName, "flow.log");
  mkdirSync2(dirname(logPath), { recursive: true });
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  appendFileSync(logPath, `${timestamp} [${flowName}] [session=${sessionId}] ${message}
`);
}

// src/lib/session-end-handler.ts
async function handleSessionEnd(input2) {
  const { cwd, session_id } = input2;
  const active = await resolveActiveFlow(cwd, session_id).catch(() => null);
  if (active) {
    const { flowName, state, repoRoot } = active;
    if (state.last_session_id === session_id) {
      const written = await patchActiveState(
        repoRoot,
        flowName,
        (cur) => cur.last_session_id === session_id ? { last_session_id: null } : {}
      );
      if (written && written.last_session_id === null) {
        await appendLog(repoRoot, flowName, session_id, `SESSION_END cleared last_session_id`);
      }
    }
  }
  unbindSession(session_id);
  await gcRegistry().catch(() => {
  });
}

// src/hooks/sessionend.ts
var raw = (() => {
  try {
    return readFileSync3(0, "utf-8");
  } catch {
    return "{}";
  }
})();
var input = (() => {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
})();
try {
  await handleSessionEnd(input);
} catch (e) {
  process.stderr.write(`[ai-flow sessionend error] ${String(e)}
`);
}

#!/usr/bin/env node

// src/hooks/sessionend.ts
import { readFileSync as readFileSync3 } from "fs";

// src/lib/state.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, appendFileSync, renameSync as renameSync2 } from "fs";
import { randomBytes } from "crypto";
import { join as join2, dirname } from "path";

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
async function readActiveState(repoRoot, flowName) {
  const path = statePath(repoRoot, flowName, "active.json");
  if (!existsSync2(path)) return null;
  try {
    return JSON.parse(readFileSync2(path, "utf-8"));
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
async function hasActiveFlow(cwd) {
  let dir = cwd;
  while (true) {
    const aiFlowDir = join2(dir, ".ai-flow");
    if (existsSync2(aiFlowDir)) {
      for (const entry of readdirSync2(aiFlowDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const state = await readActiveState(dir, entry.name);
        if (state) return { flowName: entry.name, state, repoRoot: dir };
      }
      return null;
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
      await writeActiveState(repoRoot, flowName, { ...state, last_session_id: null });
      await appendLog(repoRoot, flowName, session_id, `SESSION_END cleared last_session_id`);
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

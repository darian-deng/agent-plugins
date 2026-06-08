#!/usr/bin/env node

// src/hooks/sessionend.ts
import { readFileSync as readFileSync2 } from "fs";

// src/lib/state.ts
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, renameSync } from "fs";
import { randomBytes } from "crypto";
import { join, dirname } from "path";
function statePath(repoRoot, flowName, file) {
  return join(repoRoot, ".ai-flow", flowName, "state", file);
}
function stateDir(repoRoot, flowName) {
  return join(repoRoot, ".ai-flow", flowName, "state");
}
async function readActiveState(repoRoot, flowName) {
  const path = statePath(repoRoot, flowName, "active.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}
async function writeActiveState(repoRoot, flowName, state) {
  const dir = stateDir(repoRoot, flowName);
  mkdirSync(dir, { recursive: true });
  const tmp = statePath(repoRoot, flowName, `active.json.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, statePath(repoRoot, flowName, "active.json"));
}
async function hasActiveFlow(cwd) {
  let dir = cwd;
  while (true) {
    const aiFlowDir = join(dir, ".ai-flow");
    if (existsSync(aiFlowDir)) {
      for (const entry of readdirSync(aiFlowDir, { withFileTypes: true })) {
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
async function appendLog(repoRoot, flowName, sessionId, message) {
  const logPath = statePath(repoRoot, flowName, "flow.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  appendFileSync(logPath, `${timestamp} [${flowName}] [session=${sessionId}] ${message}
`);
}

// src/lib/session-end-handler.ts
async function handleSessionEnd(input2) {
  const { cwd, session_id } = input2;
  const active = await hasActiveFlow(cwd).catch(() => null);
  if (!active) return;
  const { flowName, state, repoRoot } = active;
  if (state.last_session_id !== session_id) return;
  await writeActiveState(repoRoot, flowName, { ...state, last_session_id: null });
  await appendLog(repoRoot, flowName, session_id, `SESSION_END cleared last_session_id`);
}

// src/hooks/sessionend.ts
var raw = (() => {
  try {
    return readFileSync2(0, "utf-8");
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

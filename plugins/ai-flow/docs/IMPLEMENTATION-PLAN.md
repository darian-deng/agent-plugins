# ai-flow Engine — Implementation Plan

Execution method: TDD (red → green → refactor), strictly in dependency order.
Target: 100% line + branch coverage. Python3 tests use `skipIf(!hasPython3())`.

> **历史文档，不是当前实现的参考。** 这份计划记录的是引擎重写当时的设计意图，此后未再维护
> （最后一次改动是 Phase 9 的 `feat-flow` → `ai-flow` 改名）。多处命名与结构后来在实现中变了，
> 例如 Phase 3 列出的 `transitions.log` / `violations.log` 已合并为单一 `flow.log`（commit
> `2969545`），`gate-token` 整个机制已不存在。
>
> Phase 1 / 3 / 6e / 7c / 7d / 8 描述的两级 context（上下文窗口占用）保护也已经不是现在的样子：
> 原来的 `warn_at_pct`（到点注入提醒）+ `block_at_pct`（到点拒写）两个旋钮，已合并成单一的
> `wrap_up_at_pct`（默认 60）。越过阈值时一次性注入一份「开始为 /clear 收尾」的简报，此后主
> session 对代码的写入被拒，而当前 stage 的 `docs_paths` 仍然放行，正是为了让交接文档写得下去；
> 若该 stage 没有声明 `docs_paths`（schema 只在 `write_scope: 'docs_only'` 时要求它，所以
> `unrestricted` 的 stage 合法地可以没有），引擎在那个 stage 上一个写入都不拒 —— 拒了就连交接
> 都写不进去，而唯一的出路 `/clear` 恰恰要求先把交接落盘 —— wrap-up 在这种 stage 上退化成
> 「只通知、不强制」。状态字段上，Phase 3 的 `context_warning` 和当时另有的 `context_blocked`
> 已合并为一个 `context_wrap_up`：它非空就表示这个 session 已经进入收尾，同时兼作 latch（闩锁，
> 置上后不再重复注入简报）。日志事件名 `CONTEXT_WARN` / `CONTEXT_BLOCK` 已统一为
> `CONTEXT_WRAP_UP`（带 `pct` / `threshold` 和首次越线的 `first` 标记）。而 Phase 6a 提到的
> `block_start_if_above_pct` 已经**不是配置项**了：它现在是 `commands/start.ts` 里的常量
> `BLOCK_START_IF_ABOVE_PCT = 95`，`FlowConfigSchema` 里没有这个字段。照这份文档往
> `config.json` 里写它不会报错——zod 会静默 strip 掉未知键，所以它是**静默无效**。
>
> **要了解引擎当前行为，读 `src/`，不要读这份文档。**

---

## Phase 0 — Delete dead code (no tests needed)

Remove before writing a single new test. These modules are being fully replaced.

**Delete:**
- `src/lib/init-handler.ts` — init record mechanism gone
- `src/lib/preflight.ts` — replaced by per-flow preflight.sh
- `src/lib/compact-handler.ts` — PreCompact hook removed (no-op in new design)
- `src/hooks/compact.ts`
- `src/lib/commands/init.ts`
- All existing `tests/*.test.ts` — rewritten in each phase below
- `tests/fixtures/helpers.ts` — rewritten in Phase 2

**Keep (will be refactored, not deleted):**
- `src/lib/types.ts` — gutted and rewritten
- `src/lib/state.ts` — rewritten for new paths
- `src/lib/config.ts` — scope detection removed, Zod loader added
- `src/lib/context.ts` — kept as-is (context % calculation unchanged)
- `src/lib/commands/router.ts` — rewritten
- All hook entry points in `src/hooks/`

---

## Phase 1 — FlowConfig Schema (Zod v4)

**New file:** `src/lib/flow-schema.ts`

No I/O. Pure TypeScript. No fixtures needed.

### Tests to write (`tests/flow-schema.test.ts`):

**Valid configs:**
- Minimal config (1 stage, no script, no gate) → parses successfully
- Stage with `write_scope: 'docs_only'` + `docs_paths` → valid
- Stage with script only (no gate) → valid
- Stage with gate only (no script) → valid
- Stage with both script + gate → valid
- Stage with `task_gates` field → valid
- Config with custom `context` overrides → valid
- Multi-stage config (8 stages) → valid
- `docs_paths` with `{flow_id}` template strings → valid (schema does not expand templates)

**Invalid configs:**
- Missing `schema_version` → parse error
- `schema_version: '2.0'` (wrong literal) → parse error
- `stages: []` (empty array) → parse error with message "at least one stage"
- Stage `id` with uppercase → parse error (regex)
- Stage `id` with spaces → parse error
- `write_scope: 'docs_only'` with no `docs_paths` → refine error
- `write_scope: 'docs_only'` with `docs_paths: []` → refine error
- `script.command: ''` (empty string) → parse error
- `script.timeout_ms: -1` → parse error
- `context.warn_at_pct: 101` → parse error (max 99)
- `context.block_at_pct: 0` → parse error (min 1)

**Type inference:**
- `z.infer<typeof FlowConfigSchema>` produces correct TypeScript type

**Error messages:**
- Zod error for `write_scope: 'docs_only'` + no `docs_paths` includes path `['docs_paths']`
- Zod error for bad `id` regex includes stage index in path

---

## Phase 2 — Test Fixtures & Helpers

**New file:** `tests/fixtures/helpers.ts` (replaces old version)

### New `createFlowTestRepo(flowName, config, opts?)`:
- Creates real temp git repo (same `mkdtempSync` approach)
- Writes `.ai-flow/{flowName}/config.json` from provided `FlowConfig`
- Writes stub stage prompt files for each stage in config
  - Content: minimal markdown + the required signal instruction line
- Writes empty `preflight.sh` (executable, `exit 0` by default; overridable via `opts.preflightScript`)
- Creates `scripts/` directory (empty by default)
- Adds `.ai-flow/*/state/` to `.gitignore`
- Commits everything → clean working tree for `start` preflight
- Returns `{ repoRoot, flowDir, cleanup }`

### New `writeActiveState(repoRoot, flowName, state)`:
- Creates `.ai-flow/{flowName}/state/` directory
- Writes `active.json` with provided partial state (merges with sensible defaults)

### New `writeGateToken(repoRoot, flowName, token)`:
- Writes `.ai-flow/{flowName}/state/gate-token`

### New `readActiveState(repoRoot, flowName)`:
- Reads and parses `.ai-flow/{flowName}/state/active.json`

### New `hasPython3()`:
- `() => { try { execSync('python3 --version'); return true; } catch { return false; } }`

### Test `FlowConfig` constants:
```typescript
export const MINIMAL_CONFIG: FlowConfig = {
  schema_version: '1.0',
  name: 'test-flow',
  stages: [
    { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {} },
    { id: 'review', prompt: 'stages/review.md', write_scope: 'docs_only',
      docs_paths: ['docs/test-flow/{flow_id}/'], completion: { gate: true } },
  ],
};

export const GATED_CONFIG: FlowConfig = { ...MINIMAL_CONFIG with gate: true on all stages };
export const SCRIPTED_CONFIG: FlowConfig = { ...MINIMAL_CONFIG with script on stage 1 };
```

---

## Phase 3 — State Module

**Rewrite:** `src/lib/state.ts`

New paths:
- `active.json` → `.ai-flow/{flowName}/state/active.json`
- `gate-token` → `.ai-flow/{flowName}/state/gate-token`
- `signal` → `.ai-flow/{flowName}/state/signal`
- `transitions.log` → `.ai-flow/{flowName}/state/transitions.log`
- `violations.log` → `.ai-flow/{flowName}/state/violations.log`

New `ActiveState` type (simplified — no `waiting_for_gate`, `gate_type`, `approved_task_gates`):
```typescript
interface ActiveState {
  flow_id: string;
  flow_name: string;
  requirement: string;
  current_stage: string;
  base_sha: string;
  started_at: string;
  last_session_id: string | null;
  context_size: number;
  context_warning: ContextWarning;
}
```

**Removed from types.ts:** `StageId` union, `NEXT_STAGE`, `ActiveMarker`, `InitRecord`, `FeatFlowState`.

### Tests to write (`tests/state.test.ts`):

- `readActiveState` on nonexistent file → returns `null`
- `readActiveState` on valid file → returns parsed state
- `readActiveState` on corrupted JSON → returns `null`
- `writeActiveState` creates directory if not exists
- `writeActiveState` + `readActiveState` roundtrip
- `hasActiveFlow(repoRoot)` → scans `*/state/active.json`, returns `{flowName, state} | null`
- `hasActiveFlow` with 0 flows → null
- `hasActiveFlow` with 1 active flow → returns it
- `isGateActive(repoRoot, flowName)` → `existsSync(gate-token path)`
- `writeGateToken` + `isGateActive` = true
- `deleteGateToken` + `isGateActive` = false
- `appendTransition` creates file if not exists + appends lines
- `appendTransition` multiple calls → all lines present in order
- `nextStage(config, currentStageId)` → returns next stage id or null (last stage)
- `nextStage` with last stage → null

---

## Phase 4 — Config Loader

**New file:** `src/lib/flow-config-loader.ts`

### Tests to write (`tests/flow-config-loader.test.ts`):

- `loadFlowConfig(repoRoot, flowName)` with valid `config.json` → returns parsed FlowConfig
- `loadFlowConfig` with missing file → throws `FlowNotFoundError` with message "use /ai-flow to add"
- `loadFlowConfig` with invalid JSON → throws `FlowConfigParseError` with file path in message
- `loadFlowConfig` with schema violation → throws `FlowConfigValidationError` with Zod error details formatted as human-readable string
- `discoverFlows(repoRoot)` → scans `.ai-flow/*/config.json`, returns array of flow names
- `discoverFlows` with no `.ai-flow/` directory → returns `[]`
- `discoverFlows` with 3 flows → returns all 3 names
- `discoverFlows` ignores directories without `config.json`
- `getStageConfig(config, stageId)` → returns StageConfig or throws if not found
- `resolveDocsPaths(paths, flowId)` → replaces `{flow_id}` with actual flow_id

---

## Phase 5 — Script Executor

**New file:** `src/lib/script-executor.ts`

Runs user-defined validation scripts. Supports `bash`/`sh`, `node`, `python3`.

### Tests to write (`tests/script-executor.test.ts`):

**bash/sh:**
- `runScript('exit 0', repoRoot)` → `{ ok: true }`
- `runScript('exit 1', repoRoot)` → `{ ok: false, reason: '' }`
- `runScript('echo "check failed" && exit 2', repoRoot)` → `{ ok: false, reason: 'check failed' }`
- `runScript('bash scripts/check.sh', repoRoot)` with real script file → passes
- `runScript('nonexistent-cmd', repoRoot)` → `{ ok: false, reason: includes 'not found' }`
- timeout: `runScript('sleep 100', repoRoot, { timeout_ms: 50 })` → `{ ok: false, reason: includes 'timed out' }`

**node:**
- `runScript('node -e "process.exit(0)"', repoRoot)` → `{ ok: true }`
- `runScript('node -e "process.exit(1)"', repoRoot)` → `{ ok: false }`
- `runScript('node scripts/validate.js', repoRoot)` with real script → passes
- timeout with slow node script

**python3 (skipIf !hasPython3()):**
- `runScript('python3 -c "exit(0)"', repoRoot)` → `{ ok: true }`
- `runScript('python3 -c "exit(1)"', repoRoot)` → `{ ok: false }`
- timeout with slow python script

**cwd:**
- Script runs with `cwd = repoRoot` so relative paths resolve correctly
- Script can read files from the repo root

---

## Phase 6 — Command Handlers (TDD each)

**Rewrite:** All files in `src/lib/commands/`

### 6a. `start` (`tests/cmd-start.test.ts`)

- No `config.json` for flow → error "use /ai-flow"
- Any flow already active → error mentioning `abort`
- Dirty git working tree → error mentioning `git stash`
- `preflight.sh` exits 1 → error with preflight output
- `preflight.sh` does not exist → skipped (not an error)
- `context_size` above `block_start_if_above_pct` → error mentioning `/clear`
- All checks pass → creates `active.json`, first stage prompt in context
- Empty requirement string → error
- First stage is injected correctly (reads `stages/{id}.md`)
- `flow_id` format is deterministic enough to test (matches regex)
- `base_sha` matches current `git rev-parse HEAD`

### 6b. `approve` (`tests/cmd-approve.test.ts`)

- No active flow → error "no active flow"
- No gate active (no gate-token) → error "no pending gate"
- Wrong token → error with token hint
- Correct token + not last stage → advances `current_stage`, deletes gate-token, injects next stage prompt
- Correct token + last stage → flow marked complete, clears all state, success message
- After approve, reading `active.json` shows new `current_stage`
- Token comparison is constant-time (or at least correct)

### 6c. `abort` (`tests/cmd-abort.test.ts`)

- No active flow → error "no active flow"
- Active flow → creates branch `{flowName}/aborted-{timestamp}`
- Abort branch contains state snapshot at `docs/{flowName}/{flowId}/state-snapshot.json`
- After abort, `active.json` deleted
- After abort, `gate-token` deleted (cleanup)
- Abort branch name includes ISO timestamp (regex test)
- Works when there are staged changes
- Works when there are unstaged changes

### 6d. `resume` (`tests/cmd-resume.test.ts`)

- No branch name → error with usage hint
- Branch does not exist → error
- Branch exists but no snapshot → error
- Snapshot exists → restores `active.json`, creates active marker
- Restored state has correct `current_stage` from snapshot
- `last_session_id` reset to null on restore (new session)
- Injects stage context from current stage's prompt file
- Cannot resume if another flow already active

### 6e. `status` (`tests/cmd-status.test.ts`)

- No active flow → message "no active flow"
- Active flow, no gate → shows flow_name, current_stage, requirement
- Active flow, gate active → shows gate-token hint, approve instruction
- Context warning state shown if `warned: true`

### 6f. `help` (`tests/cmd-help.test.ts`)

- No `.ai-flow/` directory → shows "no flows configured, use /ai-flow"
- One flow configured → shows flow name, description, stage list
- Multiple flows → shows all flows
- Reads from `config.json`, not hardcoded

---

## Phase 7 — Hook Entry Points

### 7a. UserPromptSubmit (`tests/userprompt.test.ts`)

- Non-flow message → passes through (allow, no additionalContext)
- `ai-flow help` → engine-level help (lists available flows)
- `feat-flow start ...` → routes to start handler
- `feat-flow approve ...` → routes to approve handler
- `feat-flow abort` → routes to abort handler
- `feat-flow resume ...` → routes to resume handler
- `feat-flow status` → routes to status handler
- `feat-flow help` → routes to help handler
- `feat-flow unknowncmd` → soft error (allow + additionalContext, NOT deny)
  - Message includes list of valid commands
  - Does NOT show "operation blocked" banner
- Flow name not in `.ai-flow/` → soft error "use /ai-flow to add {flowName}"
- Non-gate message when gate is active → **clears gate** (deletes gate-token) + allows
- `_isError` flag on soft errors → prefix says "命令已处理" not "工作流已更新"
- Unknown flow prefix that matches no registered flow → pass through

### 7b. PreToolUse (`tests/pretool.test.ts`)

**No active flow:**
- Any write → null (pass through)

**Signal interception (`.ai-flow/{flowName}/state/signal`):**
- No script, no gate → ALLOW write, advance stage (update active.json)
- Script configured, script passes, no gate → ALLOW write, advance stage
- Script configured, script fails → DENY write, additionalContext includes failure reason
- Gate configured, no script → DENY write, gate-token created, AI told to wait
- Script passes + gate configured → DENY write, gate-token created
- Script fails + gate configured → DENY write (script failure wins, no gate token)
- Signal write when already at last stage → ALLOW, complete flow

**Control plane protection (`.ai-flow/{flowName}/config.json` etc.):**
- Write to `config.json` → DENY + violation logged
- Write to any `stages/*.md` in flow dir → DENY + violation logged  
- Write to `scripts/*.sh` in flow dir → DENY + special message "ask user to replace manually"
- Write to `state/active.json` directly → DENY
- Write to `state/gate-token` directly → DENY
- Bash command touching `state/signal` → DENY
- Bash command touching `state/active.json` → DENY
- Bash command touching `scripts/` → DENY + script protection message

**Write scope (`docs_only`):**
- Write to `docs/feat-flows/{flow_id}/design.md` → ALLOW (in docs_paths)
- Write to `src/index.ts` when scope=`docs_only` → DENY + violation logged
- Write to `docs/adr/` when in `docs_paths` → ALLOW
- `{flow_id}` in `docs_paths` correctly expanded → path check works

**Write scope (`unrestricted`):**
- Any path → ALLOW (subject to control plane rules)

**Read tools (`Read`, `Glob`, `Grep`, `LS`):**
- Read of `state/gate-token` → DENY (AI must not see token)
- Read of other state files → ALLOW
- Bash `cat state/gate-token` → DENY

### 7c. SessionStart (`tests/session.test.ts`)

- No active flow → null (no injection)
- Active flow, no gate → injects: flow summary, current stage prompt content, helper.md content
- Active flow with gate → injects gate status, token retrieval hint
- New session (different `last_session_id`) → context_warning reset in state
- Same session → context_warning NOT reset
- `last_session_id` updated in `active.json` after session start
- `context_size` updated from model if provided
- Missing stage prompt file → injects summary without stage content (no crash)
- Missing `helper.md` → injects summary without helper (no crash)

### 7d. PostToolUse (`tests/posttool.test.ts`)

- No active flow → null
- Non-write tool → null
- Write tool + context below `warn_at_pct` → null
- Write tool + context ≥ `warn_at_pct` → warning injected in additionalContext
- Write tool + context ≥ `block_at_pct` → urgent warning injected
- Warning re-triggers only if `rewarn_delta_pct` threshold exceeded
- Custom `context` config from `FlowConfig` overrides plugin defaults
- Warning state saved in `active.json` after triggering

---

## Phase 8 — Integration Tests

**New file:** `tests/integration/flow-lifecycle.test.ts`

These tests run a full flow start-to-finish using real temp git repos and real file I/O. They exercise the full handler chain, not individual units.

- **Happy path**: start → 2 stages auto-advance → complete
- **Gate flow**: start → gate triggered → approve → advance
- **Gate rejection**: gate triggered → non-command message → gate cleared → AI continues → gate triggered again
- **Script failure**: signal write → script fails → AI receives error → signal write again → script passes → advance
- **abort + resume**: start → partial work → abort → verify branch → resume → continues from correct stage
- **clear/resume**: start → session changes → SessionStart injects correct context → handler continues
- **Context warning**: start → simulate high context % → warning fires at threshold → re-warning respects delta
- **Multi-flow discovery**: two flows configured → each routes correctly → only one can be active

---

## Phase 9 — Rename & Cleanup

After all tests pass at 100% coverage:

1. Update `package.json`: `name: "ai-flow"`, `version: "1.0.0"`
2. Update `.claude-plugin/plugin.json`: name, description
3. Update `marketplace.json` in root: rename entry
4. Rename `plugins/feat-flow/` → `plugins/ai-flow/` (git mv)
5. Update all internal references to plugin name
6. Update `hooks/hooks.json` command paths if needed
7. Update CLAUDE.md

---

## File Change Summary

| Action | File |
|--------|------|
| DELETE | `src/lib/init-handler.ts` |
| DELETE | `src/lib/preflight.ts` |
| DELETE | `src/lib/compact-handler.ts` |
| DELETE | `src/hooks/compact.ts` |
| DELETE | `src/lib/commands/init.ts` |
| REWRITE | `src/lib/types.ts` |
| REWRITE | `src/lib/state.ts` |
| REWRITE | `src/lib/config.ts` |
| REWRITE | `src/lib/commands/router.ts` |
| REWRITE | `src/lib/commands/start.ts` |
| REWRITE | `src/lib/commands/approve.ts` |
| REWRITE | `src/lib/commands/abort.ts` |
| REWRITE | `src/lib/commands/resume.ts` |
| REWRITE | `src/lib/commands/status.ts` |
| REWRITE | `src/lib/commands/help.ts` |
| REWRITE | `src/lib/pretool-handler.ts` |
| REWRITE | `src/lib/posttool-handler.ts` |
| REWRITE | `src/lib/session-handler.ts` |
| REWRITE | `src/hooks/userprompt.ts` |
| REWRITE | `src/hooks/pretool.ts` |
| REWRITE | `src/hooks/posttool.ts` |
| REWRITE | `src/hooks/session.ts` |
| REWRITE | `tests/fixtures/helpers.ts` |
| NEW | `src/lib/flow-schema.ts` |
| NEW | `src/lib/flow-config-loader.ts` |
| NEW | `src/lib/script-executor.ts` |
| NEW | `tests/flow-schema.test.ts` |
| NEW | `tests/flow-config-loader.test.ts` |
| NEW | `tests/script-executor.test.ts` |
| NEW | `tests/state.test.ts` |
| NEW | `tests/cmd-start.test.ts` |
| NEW | `tests/cmd-approve.test.ts` |
| NEW | `tests/cmd-abort.test.ts` |
| NEW | `tests/cmd-resume.test.ts` |
| NEW | `tests/cmd-status.test.ts` |
| NEW | `tests/cmd-help.test.ts` |
| NEW | `tests/userprompt.test.ts` |
| NEW | `tests/pretool.test.ts` |
| NEW | `tests/session.test.ts` |
| NEW | `tests/posttool.test.ts` |
| NEW | `tests/integration/flow-lifecycle.test.ts` |

# ai-flow Domain Glossary

## Engine

**ai-flow**
The Claude Code plugin. A generic, data-driven workflow orchestration engine. Knows nothing about specific domain stages — all behavior comes from Flow Definitions in the project.

**Flow Definition**
A named workflow template stored at `.ai-flow/{flow-name}/`. Consists of `config.json`, `stages/`, `scripts/`, `preflight.sh`, and `helper.md`. Defines the stages, completion conditions, and write restrictions for one type of workflow.

**Flow Instance**
A single running execution of a Flow Definition. Created by `{flow-name} start <requirement>`. Tracked in `.ai-flow/{flow-name}/state/active.json`. Only one Flow Instance may be active at a time across all Flow Definitions.

**Stage**
One step within a Flow Definition. Has an AI prompt (`stages/*.md`), a write scope, optional task gates, and a Completion Config. Stages are ordered; a Flow Instance advances through them sequentially.

**Completion Config**
The per-Stage configuration that governs how stage advancement is triggered. Consists of two independent, optional layers: a Script Validator and a Gate. Both are absent by default (Signal → auto-advance).

## Completion Mechanism

**Signal**
The universal trigger for stage advancement. AI writes to the fixed path `.ai-flow/{flow-name}/state/signal`. The `PreToolUse` hook intercepts this Write and dispatches the Completion Config.

**Script Validator**
An optional shell/Node/Python script in `.ai-flow/{flow-name}/scripts/` that the engine runs when a Signal is detected. Exit 0 = validation passed. Non-zero = validation failed; AI is told the failure reason and must fix before retrying.

**Gate**
An optional human approval checkpoint. When triggered, generates a cryptographic token written to `.ai-flow/{flow-name}/state/gate-token`. Token is shown to the human via `systemMessage` only (never visible to AI). AI is halted until the human runs `{flow-name} approve <token>`. Runs after Script Validator passes.

**Task Gate**
A mid-Stage human checkpoint for individual tasks within a complex Stage. Handled entirely by Stage Prompt instructions, not by engine mechanics. The Stage Prompt tells the AI to pause and report to the user after each task. The Script Validator (not engine state) provides the mechanical guarantee that all tasks are complete before a Signal is accepted.

**Preflight**
A shell script at `.ai-flow/{flow-name}/preflight.sh` that runs exactly once when `{flow-name} start` is called. Verifies environment prerequisites (tools installed, dependencies available). Failure blocks the Flow Instance from starting.

## State

**base_sha**
The git commit SHA recorded at `{flow-name} start` time. Represents the clean baseline before the Flow Instance made any changes. Used for `abort` branching and `resume` state restoration.

**active.json**
The runtime state file for the current Flow Instance, at `.ai-flow/{flow-name}/state/active.json`. Gitignored. Contains: flow_id, flow_name, requirement, current_stage, base_sha, started_at, last_session_id, context_size, context_warning. Gate status is NOT stored here — it is inferred from whether `gate-token` exists.

**ResolvedFlow.viaSibling**
Set when the active flow was found in a DIFFERENT checkout of the same git repository than the caller's cwd. `hasActiveFlow` falls back to scanning every checkout (`git worktree list`) because a flow's own ticket worktrees carry a *tracked* copy of `.ai-flow/` with no `state/` of their own — without the fallback every subagent working in one resolves no flow at all, and `handlePreTool` then bails before any guard runs (fail-OPEN: no control-plane protection, no signal interception, no context accounting). git cannot distinguish a ticket tree from a worktree the developer created by hand for an unrelated branch, so the same fallback also resolves checkout A's flow for a session sitting in checkout B — observed in practice as "every session in B is read-only and nothing explains why". The resolution stays deliberately wide; the flag exists so callers that **mutate or explain** can behave differently: flow commands are refused (a `<flow> abort` typed in B would destroy A's flow state), and both the read-only notice and the owner-branch injection name both checkouts. Narrowing the resolution instead — e.g. only trusting paths under `<repo>.ai-flow-worktrees/` — reintroduces the fail-OPEN for any flow that names its worktrees differently.

**Gate status inference**
Whether a Gate is active is determined solely by `existsSync(gate-token path)`. No boolean field in active.json. Eliminates redundant state that could become inconsistent.

## Commands

**`{flow-name}` (bare, no subcommand)**
Invoking a flow name with no subcommand routes to the help handler for that flow, listing its stages and description. There is no engine-level `ai-flow` command prefix; all commands are prefixed by the specific flow name defined in `.ai-flow/`.

**`{flow-name} start <requirement>`**
Begins a Flow Instance. Runs Preflight, checks for clean git state, checks no other Flow Instance is active.

**`{flow-name} approve <token>`**
Advances the Flow Instance past a Gate. Validates the token cryptographically.

**`{flow-name} abort`**
Terminates the active Flow Instance. Saves current changes to a branch named `{flow-name}/aborted-{timestamp}`.

**`{flow-name} resume <branch>`**
Restores a Flow Instance from an aborted branch's state snapshot.

**`{flow-name} status`**
Shows current Stage, gate status, and progress of the active Flow Instance.

## Configuration

**FlowConfig**
The Zod-validated schema for `config.json`. Top-level fields: `schema_version`, `name`, `description`, `context`, `stages`.

**write_scope**
Per-Stage field. Either `docs_only` (writes restricted to `docs_paths`) or `unrestricted`. Enforced by `PreToolUse` hook.

**docs_paths**
List of allowed write paths when `write_scope` is `docs_only`. Supports `{flow_id}` template substitution.

**context.rewarn_delta_pct**
How many percent the water mark must climb before the same threshold speaks again. Guards the
warn branch always; the block branch throttles on `context_warning.block_reminded_at_pct` with
the same step. `grill-flow` runs it at **1** — deliberately, so the wrap-up window announces
itself continuously rather than in 10-point jumps once a session is over the line. Cheap because
the block branch says its full brief once and one line per percent after that; measured over
three recorded pct series, a session fires the warn line ~10 times between 50% and 60%, which is
the intended cadence. A pct series that oscillated would spam at this setting — the recorded ones
do not (4,059 samples, 3 decreases, all of them the `/clear` cliff, which resets the state
anyway).

**INLINE_INJECTION_BUDGET**
`prompt-render.ts`, 10,000 **characters** (not bytes — CJK would undercount ~1.9×). A stage
prompt is injected inline only while `rendered.length + overhead <= budget`; past that it is
materialised to disk and the model gets a "go Read this file" pointer instead, costing a round
trip on every entry into that stage — including every `/clear` re-entry. `rendered` counts the
prompt *after* `{{flow_root}}` / `{{project_root}}` expand to absolute paths, so the same file
costs more in a deeply nested monorepo. Before growing any `stages/*.md`, measure: expand the
placeholders against the longest project path you care about, add `writtenDocLengthNote()` plus
the assembly overhead, and compare. `grill-flow`'s stage-3 runs ~230–320 characters under the
cap, so it is the one that bites first — put new prose in a `references/*.md` (those are read on
demand and cost nothing here) and spend stage-page characters only on a pointer.

## Infrastructure

**`/ai-flow` skill**
A Claude Code slash-command skill. Manages Flow Definitions: adds the bundled `feat-flow` template, creates new custom Flow Definitions, or modifies existing ones.

**feat-flow**
The bundled default Flow Definition shipped with the ai-flow plugin. An 8-stage software feature development workflow.

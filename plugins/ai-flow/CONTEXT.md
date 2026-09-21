# ai-flow Domain Glossary

## Engine

**ai-flow**
The Claude Code plugin. A generic, data-driven workflow orchestration engine. Knows nothing about specific domain stages — all behavior comes from Flow Definitions.

**Definition layer / instance layer**
The two halves a flow is split across, and the distinction most path questions turn on
(`src/lib/flow-paths.ts` is the authority):

| | Definition layer — `flowDefDir()`, `{{flow_def}}` | Instance layer — `flowAnchorDir()`, `{{flow_root}}` |
|---|---|---|
| Where | `<PLUGIN>/.ai-flow/{flow-name}/` for a flow the plugin ships; `<repo>/.ai-flow/{flow-name}/` for a custom one it does not | always `<repo>/.ai-flow/{flow-name}/` |
| Holds | `config.json` (full defaults), `stages/`, `references/`, `scripts/`, `helper.md`, `preflight.cjs` | `config.json` (SPARSE overrides, usually `{}`), `state/` |
| Changes with | the plugin version — `/plugin update` | the project's own git history |

Until 0.68.0 both lived in the project: `/ai-flow:add` copied the whole template in. Across
the 7 installs measured before the change, not one file carried an intentional local edit and
every copy sat 2–25 entries behind, so the definition moved back into the plugin and
`/ai-flow:add` now creates only the instance layer. The project's `config.json` stays even
when empty: its presence is what `resolveActiveFlow` / `discoverFlows` read to answer "which
flows does this project run".

**Flow Definition**
A named workflow definition — `config.json`, `stages/`, `references/`, `scripts/`, `preflight.cjs`, `helper.md` — living in the definition layer above. Defines the stages, completion conditions, and write restrictions for one type of workflow.

**Flow Instance**
A single running execution of a Flow Definition. Created by `{flow-name} start <requirement>`. Tracked in `<repo>/.ai-flow/{flow-name}/state/active.json`. Only one Flow Instance may be active at a time across all Flow Definitions.

**Stage**
One step within a Flow Definition. Has an AI prompt (`stages/*.md`), a write scope, optional task gates, and a Completion Config. Stages are ordered; a Flow Instance advances through them sequentially.

**Completion Config**
The per-Stage configuration that governs how stage advancement is triggered. Consists of two independent, optional layers: a Script Validator and a Gate. Both are absent by default (Signal → auto-advance).

## Completion Mechanism

**Signal**
The universal trigger for stage advancement. AI writes to the fixed path `<repo>/.ai-flow/{flow-name}/state/signal` — the INSTANCE layer, written as `{{flow_root}}/state/signal` in a stage prompt. Aiming it at the definition layer instead is the one silent failure the layer split can produce: the Write succeeds and the engine simply never advances. The `PreToolUse` hook intercepts this Write and dispatches the Completion Config.

**Script Validator**
An optional shell/Node/Python script in the definition layer's `scripts/` that the engine runs when a Signal is detected. Exit 0 = validation passed. Non-zero = validation failed; AI is told the failure reason and must fix before retrying. It runs with cwd = the definition dir and with `AI_FLOW_FLOW_DIR` (the instance dir) and `AI_FLOW_PROJECT_ROOT` in its environment, because a script shipped inside the plugin can no longer derive the calling project from its own `__dirname`.

**Gate**
An optional human approval checkpoint, declared per stage as `completion.gate`. When the AI writes `done` on a gated stage the engine holds the signal instead of advancing, tells the human via `systemMessage`, and waits for `{flow-name} approve` — which takes no argument. Runs after Script Validator passes. (There is no token: an earlier design wrote a cryptographic one to `state/gate-token` so the AI could not self-approve; it was dropped, and `approve` is now gated by the human being the one who types the command.)

**Task Gate**
A mid-Stage human checkpoint for individual tasks within a complex Stage. Handled entirely by Stage Prompt instructions, not by engine mechanics. The Stage Prompt tells the AI to pause and report to the user after each task. The Script Validator (not engine state) provides the mechanical guarantee that all tasks are complete before a Signal is accepted.

**Preflight**
A script in the definition layer — `preflight.cjs` (Node, preferred; `.mjs` and a legacy `.sh` are also accepted) — run when `{flow-name} start` is called, and again by `/ai-flow:add`. Verifies environment prerequisites (tools installed, dependencies available). cwd is the project root. Failure blocks the Flow Instance from starting; it does not block the install, which has nothing to roll back.

## State

**base_sha**
The git commit SHA recorded at `{flow-name} start` time. Represents the clean baseline before the Flow Instance made any changes. Used for `abort` branching and `resume` state restoration.

**active.json**
The runtime state file for the current Flow Instance, at `<repo>/.ai-flow/{flow-name}/state/active.json`. Gitignored. Contains: flow_id, flow_name, requirement, current_stage, base_sha, started_at, last_session_id, context_size, context_wrap_up (`{ at_pct }`), plus the optional first_prompt_handled, base_sha_code and history_session_ids (append-only, every session that has ever held the flow — auditing only, no code treats it as a single current owner). Gate status is NOT stored here — it is derived from the `signal` file plus the stage's `completion.gate` (`isGatePending`, state.ts).

**ResolvedFlow.viaSibling**
Set when the active flow was found in a DIFFERENT checkout of the same git repository than the caller's cwd. `hasActiveFlow` falls back to scanning every checkout (`git worktree list`) because a flow's own ticket worktrees carry a *tracked* copy of `.ai-flow/` with no `state/` of their own — without the fallback every subagent working in one resolves no flow at all, and `handlePreTool` then bails before any guard runs (fail-OPEN: no control-plane protection, no signal interception, no context accounting). git cannot distinguish a ticket tree from a worktree the developer created by hand for an unrelated branch, so the same fallback also resolves checkout A's flow for a session sitting in checkout B — observed in practice as "every session in B is read-only and nothing explains why". The resolution stays deliberately wide; the flag exists so callers that **mutate or explain** can behave differently: flow commands are refused (a `<flow> abort` typed in B would destroy A's flow state), and both the read-only notice and the owner-branch injection name both checkouts. Narrowing the resolution instead — e.g. only trusting paths under `<repo>.ai-flow-worktrees/` — reintroduces the fail-OPEN for any flow that names its worktrees differently.

**Gate status inference**
Whether a Gate is pending is derived, not stored: `isGatePending` (state.ts) reads the `signal` file and the current stage's `completion.gate`. No boolean field in active.json. Eliminates redundant state that could become inconsistent.

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
Second job, on every stage regardless of scope: these are the paths that stay writable once
`context_wrap_up` has latched, so the handoff can land before `/clear`. Optional on an
`unrestricted` stage — and a stage that leaves it unset gets no wrap-up refusal at all, because
refusing there would leave nowhere to write the handoff.

**context.wrap_up_at_pct**
The one context threshold there is (percent of the window). Crossing it latches
`context_wrap_up` in `active.json`, and that latch does two things at once: `PostToolUse`
injects the wrap-up brief, and `PreToolUse` refuses further writes to the codebase while
leaving the current stage's `docs_paths` open so a handoff can still land. Absent → 60, the
number both shipped flows carried as the old `block_at_pct`. It replaces the deleted
two-level `warn_at_pct` / `block_at_pct` pair, and the `rewarn_delta_pct` that used to
throttle a repeat reminder between them; all three keys are silently stripped rather than
rejected (see `flow-schema.ts` for why: a validation error drops every guard that runs after
the config load). A stage that declares no `docs_paths` has no safe exit to keep open, so
nothing is refused there and the injected brief is the entire wrap-up.

**Wrap-up injection: once, at the crossing**
The brief fires exactly once — `PostToolUse` logs `CONTEXT_WRAP_UP pct=<N> threshold=<M>
first` and then never injects again for the rest of the flow. Occupancy is sampled on every
tool call, so anything that repeats fires 18–63 times per session (simulated against three
recorded pct series, not counted in the wild), and a repeat carries no
new information: the latch is persistent (`context_wrap_up.at_pct` stays non-null until a new
session or `/clear` clears it), and every subsequent attempt to write code hits the
`PreToolUse` refusal, whose text already says the wrap-up has started, which paths remain
writable, and what belongs in the handoff. `at_pct` freezes at the first crossing so that
refusal can name the level it happened at. Latching one-way is safe because the pct series
does not oscillate: 4,059 recorded samples contain 3 decreases, all of them the `/clear`
cliff, which resets the state anyway.

**INLINE_INJECTION_BUDGET**
`prompt-render.ts`, 10,000 **characters** (not bytes — CJK would undercount ~1.9×). A stage
prompt is injected inline only while `rendered.length + overhead <= budget`; past that it is
materialised to disk and the model gets a "go Read this file" pointer instead, costing a round
trip on every entry into that stage — including every `/clear` re-entry. `rendered` counts the
prompt *after* `{{flow_root}}` / `{{project_root}}` / `{{flow_def}}` expand to absolute paths, so
the same file costs more in a deeply nested monorepo — and `{{flow_def}}` expands to the
installed plugin path (`~/.claude/plugins/…/ai-flow/<version>/.ai-flow/<flow>`), which is
longer than the project path it replaced. Before growing any `stages/*.md`, measure: expand the
placeholders against the longest project path you care about, add `writtenDocLengthNote()` plus
the assembly overhead, and compare. `grill-flow`'s stage-3 runs ~230–320 characters under the
cap, so it is the one that bites first — put new prose in a `references/*.md` (those are read on
demand and cost nothing here) and spend stage-page characters only on a pointer.

## Stall watchdog

**Stall watchdog**
The engine's answer to a session that stopped when it should have kept going — most
often after a side conversation the model settled and then never returned from. It has
three moving parts and no process of its own:

| | what it is | where |
|---|---|---|
| the clock | `CronCreate`, a Claude Code session-scoped scheduled prompt, `*/5 * * * *` | created by the MODEL, lives in the host |
| the arming check | `Stop` hook reads `session_crons` and asks the model to create the cron when it is missing | `stop-handler.ts` |
| the decision | `UserPromptSubmit` recognises the tick and either blocks it or forwards it | `watchdog-tick.ts`, policy in `watchdog.ts` |

There is no timer hook — every hook is event-driven, and "the turn ended and nobody
came back" is the absence of events. Two mechanisms were rejected before this one:

- **A `Stop` hook that simply continues the turn.** `Stop` fires at the ZEROTH second
  of idleness, while the developer is still reading what they just got, and at that
  instant nothing mechanical separates a legitimate hand-back from a stall. Its only
  clock is the next turn end, which is exactly what a stalled session never produces,
  so it cannot express "five minutes later" at all.
- **A detached process posting to the session's inbox socket**
  (`CLAUDE_CODE_MESSAGING_SOCKET`). Measured on macOS / Claude Code 2.1.278 against a
  real receiving session: a session running with permission prompts bypassed receives
  nothing and the sender gets no failure signal; when delivery does work the host
  frames the text as coming from another session and tells the receiver it carries no
  consent, and the observed reaction was the model stopping to ask the developer
  whether the message was legitimate — the nudge producing the stall it exists to
  break. The frame format that design assumed (`{"type":"message",…}`) is also not the
  one the host accepts, and a wrong frame is accepted, closed and discarded silently.

**Tick, and the sentinel**
A tick is the cron firing: an ordinary prompt whose text starts with
`[ai-flow:watchdog]` (`WATCHDOG_SENTINEL`). Three places key off it — `Stop` matching
`session_crons[].prompt` to tell whether the cron exists, `UserPromptSubmit` routing
the prompt to `decideTick` instead of the command parser, and the same handler
declining to treat it as developer activity. That last one is load-bearing: a tick that
reset the nudge budget would re-arm its own watchdog every interval with nobody in the
room.

Recognition is the sentinel AND `UserPromptSubmit`'s `source` field (verified against
the 2.1.278 binary: `["user","sdk","system","loop_wakeup","schedule_wakeup",
"poll_event"]`, optional). `source` cannot carry the identity alone — a developer's own
`/loop` arrives as a wakeup too — but a prompt that arrives as `user` is never a tick,
so typing or pasting the prefix is not swallowed. An absent `source` falls back to the
text match.

**Suppression is the common case, and it is free**
`decideTick` blocks a tick when a gate is pending, when the last turn ended with
background work still in flight, when the session stopped more recently than
`idle_minutes`, when the stage's nudge budget is spent, or when the watchdog is off.
Blocking happens in `UserPromptSubmit` via top-level `decision: "block"`, so the model
is never invoked and the developer gets one line. That is what makes a five-minute poll
affordable to leave running: a tick that woke the model each time would re-read the
whole conversation to conclude nothing.

Note which way the background-task check cuts against the failure this repo actually
measured (`grill-flow/references/subagent-lifecycle.md`): a session that CLAIMS
background work it never started reports an empty array, so it is NOT suppressed. The
claim is invisible to the engine; the absence is not. A missing array (older host, task
registry unreachable) is read as "nothing running" rather than "unknown", because the
failure to prefer is the visible one — suppressing on absence would make the watchdog
do nothing forever, indistinguishable from a flow that never stalls.

**Nudge budget**
`watchdog.nudges_this_stage`, default cap 3, reset by any developer prompt and by every
stage advance. Not configurable, deliberately: it is the only bound on an unattended
loop. A nudged model that answers "I'm waiting for you" and stops produces a new turn
end, so the next tick sees a fresh `last_stop_at` and the cycle would otherwise repeat
until the cron's 7-day expiry, each iteration a fully-billed turn carrying the whole
flow context.

**Owner test: `!== null &&`, not `=== session_id`**
Both watchdog entry points use posttool-handler's lenient owner test. `<flow> resume`
writes `last_session_id: null` on purpose — "left null so the next SessionStart binds
normally" — while the session that typed the command carries straight on driving the
flow. Under a strict test that session never gets its turn ends stamped and is never
asked for a cron, `<flow> status` reports the watchdog unarmed for the rest of its life,
and nothing ever arms it. Same reasoning for the tick side, which would additionally
tell that session, every interval, that it is not the flow's executor.

**Why the state lives in active.json**
`ActiveState.watchdog` rather than a `state/watchdog.json`. Four processes write it, so
it needs the lock-and-re-read `patchActiveState` already provides — a second file
written whole would silently roll back a concurrent update. And active.json is already
fenced as control plane by `PreToolUse`, whereas a new file under `state/` matches none
of those path rules, which would let the model edit its own watchdog counters.

**`LIVE_OVERRIDE_KEYS`**
The top-level keys a project's sparse `config.json` may set (`context`, `watchdog`),
each mapped to the sub-keys this version still recognises. `legacy-cleanup` deletes
every project key absent from this table, so a schema knob added without being added
here is erased from every project that sets it on the next SessionStart — silently.
`flow-config-loader` merges the same blocks one level deep for the same reason.

## Infrastructure

**`/ai-flow` skill**
A Claude Code slash-command skill. `/ai-flow:add` attaches a bundled flow to a project (writing only the instance layer — a `{}` config.json and `state/`), `/ai-flow:create` writes a new custom Flow Definition straight into the project, and `/ai-flow:update` edits a definition where it lives: the plugin repo for a bundled flow, the project for a custom one.

**feat-flow**
The bundled default Flow Definition shipped with the ai-flow plugin, at `<PLUGIN>/.ai-flow/feat-flow/`. An 8-stage software feature development workflow.

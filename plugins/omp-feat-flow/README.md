# omp-feat-flow

A requirement-delivery flow for oh-my-pi: one owned run per requirement worktree, from boundary
clarification through an explicitly approved plan to a single PR and a Linear handoff.

## Install

```bash
omp plugin marketplace add darian-deng/agent-plugins   # once
omp plugin install omp-feat-flow                       # user scope
```

Then restart the host. `/reload-plugins` re-reads configuration but does **not** replace code that is
already loaded; only a real restart runs a new build.

## Commands

| Command | What it does |
|---|---|
| `/feat-flow-start <slug \| Linear identifier or URL>` | Creates or adopts a requirement. With a bound run it resumes instead of creating another issue, branch or workspace. |
| `/feat-flow-status` | The public observation surface: real phase, why it is waiting, owner, baseline, running build vs installed build, stale evidence, next allowed action. |
| `/feat-flow-approve` | Shows the current exact plan or knowledge-diff candidate, then asks for that candidate in a native confirm dialog. A cancelled, timed-out or model-claimed approval grants nothing. |
| `/feat-flow-sync` | Controlled sync to the PR target branch: preserves local progress, leaves real conflicts inspectable, advances the integration base and invalidates the old quality evidence. |
| `/feat-flow-update` | Checks the run's method dependency, reports whether content changed, and states the native install/restart path. There is no custom hot loader. |
| `/feat-flow-finish` | The delivery and cleanup step: an independent review helper must accept the change, its proof is recorded, the run syncs to the PR base first, the review judges that exact base-to-head change, the run enters the delivery phase, pushes, opens exactly one PR, writes the issue state back, and only then closes the workspace this run owns. It refuses while any effect is dispatched or unknown, and never merges, publishes or removes another run's worktree. |

## Permission boundaries

- Product writes stay closed until a human approves the exact candidate (plan or knowledge diff) in the
  native confirm dialog, and the candidate is unchanged at approval time.
- Boundary answers reach the run from the human's own files or the PRD (`boundariesPath` JSON or `prdPath`),
  never from the model's memory of the conversation; the model submits intents, the program records them.
- Model intents arrive through one durable request outbox (`feat_flow_request`): a task change, a design
  proposal, boundary answers, a plan, or a knowledge correction. Identity fields are filled by the program,
  duplicates and stale requests are refused, and a request is consumed atomically. A knowledge correction
  (path + concrete reason + full corrected content) becomes a candidate with its own native approval; the
  approval writes exactly that file and grants no write scope.
- Every tool call is classified before it can touch the worktree; unknown tools are treated as writes.
- An approved write is an approved capability: a shell tool admitted during implementation can still perform
  external effects on its own (for example a direct `git push`). "One PR, opened by finish" is enforced on the
  finish path, not on every admitted shell command.
- Subagent spawning (`task`) stays denied for the whole run; isolation for review and cold reading comes from
  the plugin's own helper sessions instead.
- Helpers (cold reader, review) run in separate sessions with no ambient MCP, and the cold reader gets no
  tools at all.

## Before the first run in a project

Two one-time steps, in this order.

1. **Domain docs and tracker layout** — upstream `setup-matt-pocock-skills` scaffolds `GLOSSARY.md`,
   `docs/adr/`, `docs/agents/domain.md` and the issue-tracker choice. Skipping it is fine: the glossary is created
   lazily by `domain-modeling` once a term is actually settled. `GLOSSARY.md` and ADRs are what make decisions
   readable after a lost conversation, and the delivery reviewer now receives both in its prompt.
2. **Flow defaults** — this plugin refuses to guess, so record the project's own values once:

```json
{
  "git": { "remote": "origin", "startRef": "origin/main", "prBase": "main", "worktreeRoot": "../<repo>-worktrees" },
  "github": { "host": "github.com", "repository": "owner/repo" },
  "linear": { "workspaceId": "...", "teamId": "...",
              "statusMapping": { "inProgress": "In Dev", "inReview": "In QA", "done": "Done" } },
  "models": { "author": "provider/model", "helper": "provider/model", "reviewer": "provider/model" },
  "knowledge": { "entryPaths": ["GLOSSARY.md", "docs/adr"] }
}
```

Written to `<git-common-dir>/omp-feat-flow/project.json` through `saveProject`; `/feat-flow-start` refuses a
project without it, and names the missing defaults instead of assuming `origin/staging`.

## Methods

The flow binds methodology skills from `mattpocock/skills` by name; it never vendors them.

- **Core, blocking:** `grilling`, `tdd`, `code-review`. A missing core method refuses `/feat-flow-start`; a locally
  modified copy is preserved and simply not auto-updated.
- **Conditional, never blocking:** `research`, `prototype`, `codebase-design`, `to-spec`, `to-tickets`, `wizard`,
  `wayfinder`, `diagnosing-bugs`, `to-questionnaire`, and since the 2026-11 audit also `domain-modeling` and `retro`.
- `domain-modeling` is what keeps grilling's decisions durable for humans: it writes `GLOSSARY.md` and
  `docs/adr/` inline, so a decision survives a lost conversation even when the run state also holds it.
- `retro` is the method behind knowledge maintenance: it looks for navigation pointers, missing mechanical checks,
  coding standards for the reviewer, `AGENTS.md` bloat, tool economy, no-ops and information access. Mechanical
  violations become deterministic checks; only genuine judgement calls become prose rules.
- **Alignment entry is `grill-with-docs`**, per upstream's own router: it runs `grilling` and writes what it
  learns into `GLOSSARY.md` / `docs/adr/` in the same pass. A run's alignment stage is expected to use it, so
  decisions exist for humans even when the conversation is gone.
- **Maintenance method is `retro`**: the end-of-run loop over navigation pointers, missing mechanical checks,
  reviewer standards, steering-file bloat, tooling and information access. Mechanical mistakes become deterministic
  checks; only judgement calls become prose. It is human-invoked, not an automatic post-delivery step.

## Prerequisites

- oh-my-pi 19.x, Bun ≥ 1.4.4.
- Git with a remote; the run creates its worktree from the configured base (`origin/staging` by default).
- The core methods (`grilling`, `tdd`, `code-review`) installed from a known source. A missing or modified
  core blocks `/feat-flow-start`; a locally modified copy is preserved and simply not auto-updated.
- The project must record its defaults (`git.remote`, `git.startRef`, `git.prBase`, `git.worktreeRoot`, the GitHub
  repository and the Linear team plus status mapping). `/feat-flow-start` refuses a project without them rather
  than assuming `origin/staging`.
- GitHub uses the `gh` CLI's existing authentication; Linear uses a GraphQL key from `LINEAR_API_KEY` or the
  developer's `omp-linear-api-key` keychain item. Delivery also validates the exact minted MCP tool name that
  was captured at startup and refuses to substitute a different connection.

## Verified behaviour and known limits

Verified with real services in this repository: real GitHub push and a single PR against a disposable
private repository, a real Linear backwrite that applied on the server while its receipt was lost and was
then settled by reading the exact issue back, native install of release A, upgrade to B reporting `stale`
while A kept running, and a real restart loading B.

Known limits, stated rather than hidden:

- Binding validation is name-level. The public extension API exposes only the active tool names, so a
  different server that minted the same name is indistinguishable; viewer, workspace and team identity
  cannot be checked from an extension.
- The Linear leg of the recorded delivery campaign ran against the real Linear server through the
  developer's existing authorized connection, not through the plugin's own process.
- Recovery after compaction, a fresh process, a failed material read and `new_session` is implemented and
  live-tested over the native RPC host. A real TUI `/clear` is live-tested as well: the next action demands a
  native re-authorization. Manual compaction typed inside the TUI is covered by a terminal-UI case that requires
  a configured model and real material.
- The kernel's delivery admission checks the worktree and integration base; HEAD and digest changes are
  caught by the delivery identity check itself, which refuses with a named stale proof.
- An interrupted sync is reconciled from observed Git state: a rebase still in progress or foreign changes block
  loudly; a clean worktree whose HEAD sits on top of the fetched base is settled as applied, and one still on the
  old base as not applied. Only a HEAD that descends from neither stays blocked for a human.
- cmux integration is opt-in (`OMP_FEAT_FLOW_CMUX=1`). Without cmux the flow reports the real continuation
  command instead of claiming a switch. The owned workspace id is persisted in the run, so a later session can
  still close it; only a close that cmux itself confirms is reported as done.

## Development

```bash
npm run typecheck
npm test                 # local cases only, no inference
npm run build:runtime    # writes runtime/index.mjs and runtime/release.json
```

The committed `runtime/` must match the source: the release id fingerprints sorted sources, static
resources, the build script, TypeScript config, the lockfile and tool identities, and excludes generated
output, timestamps and absolute paths. CI rebuilds into a temporary tree and compares bytes, fingerprint
and version; it never commits.

Live cases (`npm run test:live -- --campaign <id> [--case <name>]`) require an explicit campaign id, an
LLM proxy credential and a metered budget; they are never part of `npm test`.

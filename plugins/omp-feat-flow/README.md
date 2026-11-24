# omp-feat-flow (v0.2.0)

An oh-my-pi requirement-delivery extension: one owned run per requirement worktree, with two-tier onboarding, private bundled methods (`MethodPack`), adaptive small/medium/large workflows, offline `tech-design.html` alignment reviews, calibrated cold reads, optional independent Security/Performance audits, context-budget handoff, and resumable PR + Linear delivery.

Full visual guide (User Story, internal architecture, role isolation, and troubleshooting): [`docs/feat-flow-design.html`](./docs/feat-flow-design.html).

## Install

```bash
omp plugin marketplace add darian-deng/agent-plugins   # once
omp plugin install omp-feat-flow                       # user scope
```

Restart the host after installing or updating. (`/reload-plugins` does not replace already-loaded extension code.)

## First-Time Setup (Interactive, Zero Manual JSON)

1. **User-level onboarding (`~/.omp/agent/omp-feat-flow.json`)**: On your first `/feat-flow-start`, `omp-feat-flow` opens an interactive `ui.formDialog` (with sequential fallback) to configure models & thinking effort for isolated roles (`scout`, `coldReader`, `reviewer`, plus optional `author` default), Linear API key (`LINEAR_API_KEY` or macOS Keychain `omp-linear-api-key`), explicit opt-in for global skill overrides, and `gh` / `cmux` preferences. Interrupted onboarding resumes cleanly at the next unfinished step, and missing/unauthenticated role models are caught via drift detection.
2. **Project-level onboarding (`<git-common-dir>/omp-feat-flow/project.json`, v2)**: On the first `/feat-flow-start` in a Git repository, `omp-feat-flow` opens a single `ui.formDialog` pre-populated with inferred `remote`, `owner/repo`, local `prBase` candidates, `worktreeRoot` (relative to main checkout root), `knowledge.entryPaths`, and Linear team/reviewState (`mode: "required" | "optional" | "disabled"`). No manual SHA-256 `digest` is stored on disk; legacy v1 configs auto-migrate in memory.

Reconfigure anytime with `/feat-flow-start config [user|project|all]` (or choose `⚙ 修改个人 / 当前仓库配置...` inside `/feat-flow-start`).

## Private Bundled Methods (`resources/skills/`)

Curated methods (`grilling`, `tdd`, `code-review`, `domain-modeling`, `research`, `prototype`, `codebase-design`, `diagnosing-bugs`, `retro`) are bundled privately under `resources/skills/` (never top-level `skills/`), so `omp-feat-flow` **never** pollutes your `/` menu with duplicate `/skill:<name>` commands. On run creation, active methods (plus `~/.omp/agent/skills/<name>` or `~/.claude/skills/<name>` only when explicitly opted in via `methods.allowUserOverrides`) are snapshotted into `<commonDir>/omp-feat-flow/packs/<methodDigest>/`, and existing runs always verify and load their pinned `methodDigest`.

## Commands

| Command | What it does |
|---|---|
| `/feat-flow-start [需求描述 \| Linear ID/URL \| config]` | Accepts any natural-language requirement description or Linear ID/URL (no manual slug needed), searches repo-wide runs & branches first (switches cmux workspace via `cmux workspace select` if already open, or recreates), otherwise provisions a worktree and run (`owner: null`, persisted `initialTask`), or opens user/repo reconfiguration when passed `config`. |
| `/feat-flow-status` | Reports real phase, readiness, wait reason, owner, baseline/HEAD, proof freshness, and build identity. |
| `/feat-flow-approve` | Plan / Checkpoint / Amendment / Knowledge Gate: opens `ui.formDialog` (or confirm fallback) after calibrated JSON cold-read on Medium/Large docs or knowledge diffs, supports human Security/Performance review toggles, optional Mid-Checkpoint cadence on Large/multi-slice runs, and Small-tier `autoDeliver` opt-in, enforces Linear issue creation/binding when `linear.mode === "required"`, and unlocks implementation. |
| `/feat-flow-sync` | Rebases the owned worktree onto the latest `prBase` and reconciles any interrupted sync from observed Git state. |
| `/feat-flow-finish` | Delivery Gate: syncs to `prBase`, runs independent Code Review (+ Security/Performance audit when triggered) with full approved contracts, pushes with pinned expected remote tip, opens 1 PR, and updates Linear via state + idempotent comment. |
| `/feat-flow-update` | Verifies bundled private method integrity, upstream ref (`resources/skills-manifest.json`), and loaded vs installed build identity. |

## Workflow, Gates, & Context Continuity

- **Two Human Gates + Autonomous Execution**:
  - **Align (non-gate)**: Read-only exploration (`scout` allowed in both flat and batch `tasks[]` forms) + `ask` rounds + `knowledge` diff proposals for `GLOSSARY.md` / ADRs. Small-tier fixes may submit `plan` (or `boundaries` + `plan`) concisely in one call; Medium/Large converge 5 boundaries then submit inline `plan` + `signals` + `alignmentDoc` (no temp JSON files needed).
  - **Plan Gate (Gate 1)**: Host builds offline `tech-design.html` (showing this run's exact tier `small|medium|large`, scrollable Workflow Map & Placement SVGs, Security/Performance review flags + triggers, change surface, and decision ledger) and **auto-opens it in the browser once generated** in interactive sessions. Fixed approval packets are validated deterministically by the host; calibrated JSON cold-read runs once on variable model-authored content (`AlignmentReadModel` for Medium/Large, knowledge diff for Knowledge Gate). Gate 1 `ui.formDialog` lets the human toggle Security/Performance audits ON/OFF, optionally enable a **Mid-Implementation Checkpoint** for Large/multi-slice/uncertain-seam runs, or (for `small` tier with `declaredFiles`) opt into bounded `autoDeliver` (re-verified post-sync on final `HEAD` before delivery).
  - **Implement `k/N` (non-gate + optional Mid-Checkpoint & `plan.amend`)**: Serial TDD slices with `realpath` worktree containment (`scout` subagents remain available during implementation to preserve main context). Marking a slice `done` requires host-verified clean worktree, sequential order, new commit advancing past previous slices on `base..HEAD`, and an observed passing verification command (`bash` exit 0, or `no-tests:` only when the repo has no tests). Mid-flight discoveries can submit `plan.amend` (preserving completed slices verbatim & staging the delta atomically behind human approval; original `approvedScope` stays intact if rejected).
  - **Context Budget & Zero-Friction Continuity**: `ctx.getContextUsage()` returns a model-visible `45%` between-slice advisory in `feat_flow_request` output and latches `FINALIZING_SLICE` / `WRAP_UP` at `60%`. Same-process `/clear`, `compact`, and clean local sessions entering the worktree (`cleanRelease: true`, 0 unsettled ops, intact digests/materials) preserve or auto-inherit approved implementation authority regardless of `sessionId`, re-mint durable `pendingGate` tokens across restarts, and inject a full **Recovery Brief** (including `initialTask` and approved architecture/contracts) via `before_agent_start`. Crashes or unsettled operations stay strictly fail-closed.
  - **Delivery Gate (Gate 2) & Optional Retro**: Resumable per-step delivery ledger (`push` -> `pr` -> `linearState` -> `linearComment`) with durably pinned `expectedRemoteTip`, safe `returnToImplementation` on pre-effect review reject, and post-delivery prompt to optionally run Retro or cleanly persist state before closing an owned cmux workspace.

## Development

```bash
npm run typecheck
npm test                 # 116 local tests across 23 files
npm run build:runtime    # writes runtime/index.mjs and runtime/release.json
```

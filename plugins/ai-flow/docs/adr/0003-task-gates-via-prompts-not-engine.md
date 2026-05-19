# ADR 0003: Task-level gates handled by Stage Prompts, not engine state

## Status
Accepted

## Context
Complex stages (e.g., implementation with 10 tasks) need mid-stage human checkpoints. Old feat-flow tracked these in engine state (`approved_task_gates`, `gate_type: 'task'`). Two approaches:
1. Engine tracks which tasks have been gate-approved (old design)
2. Stage Prompt instructs AI to pause after each task; Script Validator provides mechanical completion check

## Decision
Remove all task-gate engine state. Handle task-level flow via Stage Prompt instructions + Script Validator.

## Reasons
- Stage Prompts already tell AI what to do at each step — extending them to cover task sequencing is natural
- Script Validator (e.g., `check-tasks.js`) provides a context-rot-proof mechanical check: if AI writes the completion signal before all tasks are done, the script catches it
- Engine state for task gates created complexity (scanning plan.md for `[GATE]` patterns, tracking approved list) that is better owned by the stage author
- Reduces `active.json` to pure flow-level state; task-level progress is tracked in the documents the AI is already writing (plan.md)

## Trade-offs
- No mechanical enforcement of individual task checkpoints — relies on Stage Prompt quality for mid-task pauses
- If a stage has no Script Validator, premature signal writes are not objectively blocked (mitigated by context monitoring and prompt design guidance)
- Users who want per-task mechanical gates must express this via a Script Validator that checks incremental progress

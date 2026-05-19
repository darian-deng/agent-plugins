# ADR 0002: Gate status inferred from gate-token file existence

## Status
Accepted

## Context
The flow engine needs to know whether a Gate is currently active (i.e., waiting for human approval). Two approaches:
1. Store `waiting_for_gate: boolean` in `active.json`
2. Infer gate status from whether `.ai-flow/{flow-name}/state/gate-token` exists

## Decision
Infer gate status from `gate-token` file existence. Remove `waiting_for_gate` from `active.json`.

## Reasons
- `waiting_for_gate` was a mirror of gate-token existence — two sources of truth for one fact
- A file either exists or it doesn't; there's no way for it to become inconsistent with itself
- Gate lifecycle is naturally managed: create token file = gate open, delete token file = gate closed
- Simplifies `active.json` schema and removes a class of consistency bugs

## Trade-offs
- All gate-status checks become `existsSync(gateTokenPath)` instead of reading a JSON field — slightly more I/O, negligible in practice
- Removes `gate_type` and `approved_task_gates` fields simultaneously, since task-level gates are now handled by Stage Prompts and Script Validators rather than engine state

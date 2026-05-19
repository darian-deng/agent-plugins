---
description: Manage Flow Definitions for the ai-flow engine. Use to add the bundled feat-flow template, create a new custom flow, or modify stages/completion config of an existing flow. Invoke with /ai-flow:ai-flow.
---

You are helping the user manage **Flow Definitions** for the ai-flow plugin.

A Flow Definition lives in `.ai-flow/{flow-name}/` and consists of:
- `config.json` — Zod-validated schema defining stages
- `stages/{id}.md` — AI prompt for each stage  
- `scripts/` — optional Script Validator scripts
- `preflight.sh` — optional environment check (must exit 0 to allow `start`)

## Step 1 — Determine what the user wants

Ask (or infer from $ARGUMENTS):

1. **Add bundled template** — scaffold the built-in `feat-flow` 8-stage software development flow into this project
2. **Create new flow** — design a brand-new Flow Definition from scratch
3. **Modify existing flow** — edit stages, completion config, or scripts of a flow already in `.ai-flow/`

If $ARGUMENTS clearly states one of the above, proceed directly. Otherwise ask.

---

## Step 2a — Add bundled `feat-flow` template

Create the following structure in the project root:

**.ai-flow/feat-flow/config.json**
```json
{
  "schema_version": "1.0",
  "name": "feat-flow",
  "description": "8-stage software feature development workflow",
  "stages": [
    { "id": "stage-1", "prompt": "stages/stage-1.md", "write_scope": "docs_only", "docs_paths": ["docs/feat-flows/{flow_id}/"], "completion": { "gate": true } },
    { "id": "stage-2", "prompt": "stages/stage-2.md", "write_scope": "docs_only", "docs_paths": ["docs/feat-flows/{flow_id}/"], "completion": {} },
    { "id": "stage-3", "prompt": "stages/stage-3.md", "write_scope": "docs_only", "docs_paths": ["docs/feat-flows/{flow_id}/"], "completion": { "gate": true } },
    { "id": "stage-4", "prompt": "stages/stage-4.md", "write_scope": "docs_only", "docs_paths": ["docs/feat-flows/{flow_id}/"], "completion": { "gate": true } },
    { "id": "stage-5", "prompt": "stages/stage-5.md", "write_scope": "unrestricted", "completion": {} },
    { "id": "stage-6", "prompt": "stages/stage-6.md", "write_scope": "unrestricted", "completion": {} },
    { "id": "stage-7", "prompt": "stages/stage-7.md", "write_scope": "docs_only", "docs_paths": ["docs/feat-flows/{flow_id}/"], "completion": { "gate": true } },
    { "id": "stage-8", "prompt": "stages/stage-8.md", "write_scope": "docs_only", "docs_paths": ["docs/feat-flows/{flow_id}/"], "completion": {} }
  ]
}
```

Then create stub `stages/stage-{1..8}.md` files. Each stub must contain a line instructing the AI to signal completion:

```
When this stage is complete, write any content to `.ai-flow/feat-flow/state/signal`.
```

Add `.ai-flow/*/state/` to the project's `.gitignore` if not already present.

Tell the user: **"feat-flow template added. Start with: `feat-flow start <requirement>`"**

---

## Step 2b — Create new flow

Interview the user:

1. **Flow name** (lowercase, hyphens only — will be the command prefix, e.g. `review-flow`)
2. **Stages** — for each stage collect:
   - `id` (lowercase-hyphen)
   - What the AI should do in this stage (you will write the prompt)
   - `write_scope`: does this stage need to write code (`unrestricted`) or only docs (`docs_only`)?
   - If `docs_only`: which paths? (supports `{flow_id}` template)
   - **Script Validator**: is there a shell check that must pass before advancing? (e.g. tests, lint)
   - **Gate**: does a human need to review and approve before moving to the next stage?
3. **Preflight**: any environment checks needed before `start` (e.g. `node --version`, `docker ps`)?

After collecting answers, generate:

- `.ai-flow/{flow-name}/config.json` (valid against FlowConfigSchema)
- `.ai-flow/{flow-name}/stages/{id}.md` for each stage — each must:
  - Describe clearly what AI should produce in this stage
  - End with the signal instruction: `When this stage is complete, write any content to \`.ai-flow/{flow-name}/state/signal\`.`
- `.ai-flow/{flow-name}/scripts/` — create any validator scripts the user described
- `.ai-flow/{flow-name}/preflight.sh` — if preflight checks were requested (chmod +x)
- Add `.ai-flow/*/state/` to `.gitignore`

Tell the user: **"Flow '{flow-name}' created. Start with: `{flow-name} start <requirement>`"**

---

## Step 2c — Modify existing flow

1. Run `ls .ai-flow/` to discover existing flows
2. Ask which flow to modify (or infer from $ARGUMENTS)
3. Read its `config.json` and relevant stage files
4. Ask what to change: add/remove/reorder stages, change completion config, update prompts, add scripts
5. Apply changes, keeping `config.json` valid against the schema

Show a summary of what changed.

---

## Schema reference (for validation)

```typescript
// stage id: /^[a-z0-9-]+$/
// write_scope: 'unrestricted' | 'docs_only'
// docs_only requires non-empty docs_paths
// script.command must be non-empty string
// script.timeout_ms must be positive integer
// context.warn_at_pct: 1–99
// context.block_at_pct: 1–99
// stages array must have at least 1 element
```

## Important rules

- Never write to `.ai-flow/*/state/` — that directory is runtime state, gitignored
- Stage prompt files must include the signal instruction or AI will not know how to complete the stage
- `docs_paths` supports `{flow_id}` which is replaced at runtime with the actual flow instance ID
- Gate tokens are delivered via systemMessage only — never put token retrieval instructions in stage prompts

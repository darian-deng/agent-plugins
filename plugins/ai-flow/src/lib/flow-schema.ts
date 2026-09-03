import { z } from 'zod';

const StageIdSchema = z.string().regex(/^[a-z0-9-]+$/, 'Stage id must be lowercase alphanumeric with hyphens');

const ScriptSchema = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
});

const CompletionSchema = z.object({
  script: ScriptSchema.optional(),
  gate: z.literal(true).optional(),
});

const StageConfigSchema = z.object({
  id: StageIdSchema,
  prompt: z.string().min(1),
  write_scope: z.enum(['unrestricted', 'docs_only']),
  /**
   * The flow's own documents. Two jobs, and the second one applies to EVERY stage:
   *  1. When `write_scope` is `docs_only`, this is the allow-list (required, non-empty).
   *  2. Whatever the write scope, these paths stay writable while the session is
   *     wrapping up for a `/clear` — the refusal stops new work, it must not also
   *     block the safe exit. A flow whose contract is "everything a later session
   *     needs is on disk" has to be able to put it there before `/clear`.
   * So set it on unrestricted stages too, even though scope enforcement ignores it
   * there: an `unrestricted` stage that leaves this unset is the one shape where the
   * wrap-up cannot be enforced at all. Refusing the codebase there would leave the
   * session with nowhere to write its handoff, so pretool-handler refuses nothing on
   * such a stage and the wrap-up degrades to the injected brief.
   */
  docs_paths: z.array(z.string()).optional(),
  completion: CompletionSchema,
  task_gates: z.array(z.string()).optional(),
}).refine(
  (s) => s.write_scope !== 'docs_only' || (s.docs_paths != null && s.docs_paths.length > 0),
  {
    message: "docs_paths is required and must be non-empty when write_scope is 'docs_only'",
    path: ['docs_paths'],
  }
);

const ContextConfigSchema = z.object({
  /**
   * Context occupancy (percent of the window) at which this flow's session starts
   * wrapping up FOR a `/clear`: the engine refuses further writes to the codebase
   * while leaving the flow's own `docs_paths` open, so the handoff can still land
   * (pretool-handler enforces both halves — on a stage that declares no `docs_paths`
   * there is no safe exit to keep open, so it refuses nothing and the wrap-up is the
   * injected brief alone). Absent → `DEFAULT_WRAP_UP_AT_PCT`.
   *
   * Replaces the earlier two-level `warn_at_pct` / `block_at_pct` pair, and the
   * `rewarn_delta_pct` that throttled the repeat reminder between them (the brief
   * now fires exactly once, at the crossing — see posttool-handler.ts). All three
   * keys are DROPPED rather than rejected, which is deliberate: a validation error
   * makes `loadFlowConfig` throw, and pretool-handler's catch-all turns that into
   * `return null` — i.e. every guard that runs AFTER the config load fails OPEN.
   * Installed flow copies still carrying the old keys (including live per-ticket
   * worktrees this change cannot reach) would lose the write-scope guard, the
   * control-plane Bash interception (signal / active.json / scripts / stages) and
   * the wrap-up refusal itself, along with the threshold. The non-owner write guard
   * is NOT among them: it depends only on state plus tool name and is deliberately
   * placed before `loadFlowConfig`, precisely so a broken config cannot fail open
   * into letting a foreign session write. Both shipped flows set `block_at_pct: 60`,
   * the same number the default lands on, so a stale copy keeps behaving as
   * configured until `/ai-flow:update` rewrites its config.json.
   */
  wrap_up_at_pct: z.number().int().min(1).max(99).optional(),
});

export const FlowConfigSchema = z.object({
  schema_version: z.literal('1.0'),
  name: z.string().min(1),
  description: z.string().optional(),
  context: ContextConfigSchema.optional(),
  stages: z.array(StageConfigSchema).min(1, 'at least one stage is required'),
});

export type FlowConfig = z.infer<typeof FlowConfigSchema>;
export type StageConfig = z.infer<typeof StageConfigSchema>;
export type ScriptConfig = z.infer<typeof ScriptSchema>;
export type CompletionConfig = z.infer<typeof CompletionSchema>;

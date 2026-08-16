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
   *     context-blocked — the block stops new work, it must not also block the safe
   *     exit. A flow whose contract is "everything a later session needs is on disk"
   *     has to be able to put it there before `/clear`; an `unrestricted` stage that
   *     leaves this unset gets no such escape and the handoff cannot be written.
   * So set it on unrestricted stages too, even though scope enforcement ignores it there.
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
  warn_at_pct: z.number().int().min(1).max(99).optional(),
  block_at_pct: z.number().int().min(1).max(99).optional(),
  rewarn_delta_pct: z.number().int().min(1).optional(),
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

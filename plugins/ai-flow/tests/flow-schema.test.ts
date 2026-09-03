import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { FlowConfigSchema, type FlowConfig } from '../src/lib/flow-schema.js';

const minimalStage = {
  id: 'work',
  prompt: 'stages/work.md',
  write_scope: 'unrestricted' as const,
  completion: {},
};

const minimalConfig = {
  schema_version: '1.0',
  name: 'test-flow',
  stages: [minimalStage],
};

describe('FlowConfigSchema — valid configs', () => {
  it('minimal config (1 stage, no script, no gate) parses successfully', () => {
    const result = FlowConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
  });

  it('stage with write_scope docs_only + docs_paths is valid', () => {
    const config = {
      ...minimalConfig,
      stages: [
        {
          id: 'docs',
          prompt: 'stages/docs.md',
          write_scope: 'docs_only',
          docs_paths: ['docs/flows/'],
          completion: {},
        },
      ],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(true);
  });

  it('stage with script only (no gate) is valid', () => {
    const config = {
      ...minimalConfig,
      stages: [
        {
          ...minimalStage,
          completion: { script: { command: 'bash scripts/check.sh', timeout_ms: 5000 } },
        },
      ],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(true);
  });

  it('stage with gate only (no script) is valid', () => {
    const config = {
      ...minimalConfig,
      stages: [{ ...minimalStage, completion: { gate: true } }],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(true);
  });

  it('stage with both script + gate is valid', () => {
    const config = {
      ...minimalConfig,
      stages: [
        {
          ...minimalStage,
          completion: {
            script: { command: 'bash check.sh' },
            gate: true,
          },
        },
      ],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(true);
  });

  it('stage with task_gates field is valid', () => {
    const config = {
      ...minimalConfig,
      stages: [{ ...minimalStage, task_gates: ['task1', 'task2'] }],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(true);
  });

  it('config with custom context overrides is valid', () => {
    const config = {
      ...minimalConfig,
      context: { wrap_up_at_pct: 70 },
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(true);
  });

  it('multi-stage config (8 stages) is valid', () => {
    const stages = Array.from({ length: 8 }, (_, i) => ({
      id: `stage-${i + 1}`,
      prompt: `stages/stage-${i + 1}.md`,
      write_scope: 'unrestricted' as const,
      completion: {},
    }));
    expect(FlowConfigSchema.safeParse({ ...minimalConfig, stages }).success).toBe(true);
  });

  it('docs_paths with {flow_id} template strings is valid (schema does not expand)', () => {
    const config = {
      ...minimalConfig,
      stages: [
        {
          id: 'docs',
          prompt: 'stages/docs.md',
          write_scope: 'docs_only',
          docs_paths: ['docs/flows/{flow_id}/'],
          completion: {},
        },
      ],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(true);
  });
});

describe('FlowConfigSchema — invalid configs', () => {
  it('missing schema_version → parse error', () => {
    const { schema_version: _, ...noVersion } = minimalConfig;
    expect(FlowConfigSchema.safeParse(noVersion).success).toBe(false);
  });

  it("schema_version: '2.0' (wrong literal) → parse error", () => {
    expect(FlowConfigSchema.safeParse({ ...minimalConfig, schema_version: '2.0' }).success).toBe(false);
  });

  it("stages: [] (empty array) → parse error with message 'at least one stage'", () => {
    const result = FlowConfigSchema.safeParse({ ...minimalConfig, stages: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' ');
      expect(messages).toMatch(/at least one stage/i);
    }
  });

  it('stage id with uppercase → parse error (regex)', () => {
    const config = { ...minimalConfig, stages: [{ ...minimalStage, id: 'Work' }] };
    expect(FlowConfigSchema.safeParse(config).success).toBe(false);
  });

  it('stage id with spaces → parse error', () => {
    const config = { ...minimalConfig, stages: [{ ...minimalStage, id: 'my stage' }] };
    expect(FlowConfigSchema.safeParse(config).success).toBe(false);
  });

  it("write_scope: 'docs_only' with no docs_paths → refine error", () => {
    const config = {
      ...minimalConfig,
      stages: [{ ...minimalStage, write_scope: 'docs_only' }],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(false);
  });

  it("write_scope: 'docs_only' with docs_paths: [] → refine error", () => {
    const config = {
      ...minimalConfig,
      stages: [{ ...minimalStage, write_scope: 'docs_only', docs_paths: [] }],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(false);
  });

  it("script.command: '' (empty string) → parse error", () => {
    const config = {
      ...minimalConfig,
      stages: [{ ...minimalStage, completion: { script: { command: '' } } }],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(false);
  });

  it('script.timeout_ms: -1 → parse error', () => {
    const config = {
      ...minimalConfig,
      stages: [
        { ...minimalStage, completion: { script: { command: 'bash check.sh', timeout_ms: -1 } } },
      ],
    };
    expect(FlowConfigSchema.safeParse(config).success).toBe(false);
  });

  it('context.wrap_up_at_pct: 101 → parse error (max 99)', () => {
    const config = { ...minimalConfig, context: { wrap_up_at_pct: 101 } };
    expect(FlowConfigSchema.safeParse(config).success).toBe(false);
  });

  it('context.wrap_up_at_pct: 0 → parse error (min 1)', () => {
    const config = { ...minimalConfig, context: { wrap_up_at_pct: 0 } };
    expect(FlowConfigSchema.safeParse(config).success).toBe(false);
  });

  // The removed keys — the two-level `warn_at_pct` / `block_at_pct` pair and the
  // `rewarn_delta_pct` that throttled the repeat reminder between them — are
  // DROPPED, not rejected. Rejecting would make
  // loadFlowConfig throw, and pretool-handler's catch-all turns a throw into
  // `return null` — so every guard that runs AFTER the config load would fail OPEN
  // for any install whose config.json still carries them: the write-scope guard, the
  // control-plane Bash interception (signal / active.json / scripts / stages) and the
  // wrap-up refusal. The non-owner write guard is not one of them — it runs before
  // `loadFlowConfig` on purpose, so a broken config cannot let a foreign session
  // write. Installed copies (including live per-ticket worktrees) are only rewritten
  // by `/ai-flow:update`, so they must stay loadable.
  it('removed warn_at_pct / block_at_pct / rewarn_delta_pct → still parses, keys stripped', () => {
    const config = {
      ...minimalConfig,
      context: { warn_at_pct: 50, block_at_pct: 60, rewarn_delta_pct: 1 },
    };
    const parsed = FlowConfigSchema.safeParse(config);
    expect(parsed.success).toBe(true);
    const ctx = parsed.success ? (parsed.data.context as Record<string, unknown>) : {};
    expect(ctx).not.toHaveProperty('warn_at_pct');
    expect(ctx).not.toHaveProperty('block_at_pct');
    expect(ctx).not.toHaveProperty('rewarn_delta_pct');
    // …which means the engine's own default has to land on the value those stale
    // configs asked for. Both shipped flows used block_at_pct: 60. That default is
    // pinned end-to-end in posttool.test.ts ('no context block in config → engine
    // default 60 applies'); asserting it here would only restate that the schema
    // has no `.default()`, which is what the stripping above already shows.
  });

  // A config that carries ONLY the dead throttle key still loads, and still gets
  // the wrap-up threshold from the engine default rather than a parse error.
  it('rewarn_delta_pct alone → still parses, key stripped', () => {
    const config = { ...minimalConfig, context: { rewarn_delta_pct: 1 } };
    const parsed = FlowConfigSchema.safeParse(config);
    expect(parsed.success).toBe(true);
    const ctx = parsed.success ? (parsed.data.context as Record<string, unknown>) : {};
    expect(ctx).not.toHaveProperty('rewarn_delta_pct');
  });
});

describe('FlowConfigSchema — type inference', () => {
  it('z.infer produces correct TypeScript type', () => {
    const parsed = FlowConfigSchema.parse(minimalConfig);
    const config: FlowConfig = parsed;
    expect(config.schema_version).toBe('1.0');
    expect(config.stages[0]!.id).toBe('work');
  });
});

describe('FlowConfigSchema — error messages', () => {
  it("docs_only + no docs_paths error includes path ['docs_paths']", () => {
    const config = {
      ...minimalConfig,
      stages: [{ ...minimalStage, write_scope: 'docs_only' }],
    };
    const result = FlowConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.flatMap((i) => i.path.map(String));
      expect(paths).toContain('docs_paths');
    }
  });

  it('bad id regex error includes stage index in path', () => {
    const config = { ...minimalConfig, stages: [{ ...minimalStage, id: 'Bad_Id' }] };
    const result = FlowConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.flatMap((i) => i.path);
      expect(paths).toContain(0); // stage index 0
    }
  });
});

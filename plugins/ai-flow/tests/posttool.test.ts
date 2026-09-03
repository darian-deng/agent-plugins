import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { handlePostTool } from '../src/lib/posttool-handler.js';
import { handlePreTool } from '../src/lib/pretool-handler.js';
import { readActiveState, signalPath, markBasePath } from '../src/lib/state.js';
import { execSync } from 'child_process';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG, BLOCKING_CONFIG, GATED_CONFIG, NO_ESCAPE_CONFIG } from './fixtures/helpers.js';
import type { PostToolInput } from '../src/lib/types.js';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

function makeRepo() {
  const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
  cleanups.push(repo.cleanup);
  return repo;
}

function makeInput(repoRoot: string, toolName: string, contextPct: number): PostToolInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-1',
    cwd: repoRoot,
    tool_name: toolName,
    tool_input: {},
    tool_response: null,
    context_size_pct: contextPct,
  } as PostToolInput & { context_size_pct: number };
}

describe('handlePostTool', () => {
  it('no active flow → null', async () => {
    const repo = makeRepo();
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 80));
    expect(out).toBeNull();
  });

  it('mark-base marker → engine captures base_sha_code = HEAD', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();
    const input = makeInput(repo.repoRoot, 'Write', 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    const out = await handlePostTool(input);
    expect(out?.additionalContext).toContain(head);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBe(head);
  });

  it('mark-base marker when base_sha_code already set → does not overwrite', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      base_sha_code: 'PRESET_SHA',
    });
    const input = makeInput(repo.repoRoot, 'Write', 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    const out = await handlePostTool(input);
    expect(out?.additionalContext).toMatch(/已存在/);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBe('PRESET_SHA');
  });

  // Context sampling deliberately runs for EVERY tool: a stage whose main session
  // "only schedules" edits its docs through Bash heredocs, so a write-tool-only
  // gate measured almost nothing (three recorded sessions did zero Edit/Write yet
  // peaked at 65–72.5% against a 60% block threshold).
  it('non-write tool → context is still sampled (no early return)', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Read', 80));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('80%');
  });

  it('non-write tool below the wrap-up threshold → null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Bash', 10))).toBeNull();
  });

  // The marker paths are matched on tool_input.file_path alone, and Read carries a
  // file_path too — pretool's own deny text even tells the AI to Read the signal
  // file. Sampling on every tool must therefore NOT let a read trip either marker.
  it('Read on the mark-base path does not capture base_sha_code', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const input = makeInput(repo.repoRoot, 'Read', 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    expect(await handlePostTool(input)).toBeNull();
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBeUndefined();
  });

  it('Read on the signal path does not advance the stage', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const input = makeInput(repo.repoRoot, 'Read', 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = sig;
    expect(await handlePostTool(input)).toBeNull();
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.current_stage).toBe('work');
  });

  it('write tool + context just below the wrap-up threshold → null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // MINIMAL_CONFIG declares no `context` block, so the engine default of 60
    // applies; 59 pins the boundary from below.
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 59));
    expect(out).toBeNull();
  });

  it('write tool + context ≥ the wrap-up threshold → brief injected', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 75));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/context|75/i);
  });

  it('wrap-up state saved in active.json after triggering', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    await handlePostTool(makeInput(repo.repoRoot, 'Write', 75));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_wrap_up).toEqual({ at_pct: 75 });
  });

  // The latch is persistent (only a new session / `/clear` clears it) and the
  // pretool refusal re-states the wrap-up on every attempted code write, so a
  // second injection carries no new information. It fires once and never again —
  // no matter how far the occupancy climbs afterwards.
  it('latch already set → nothing injected, however far the context climbs', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      context_wrap_up: { at_pct: 75 },
    });
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 76))).toBeNull();
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 90))).toBeNull();
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 99))).toBeNull();
    // …and the frozen level is untouched by those samples.
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_wrap_up).toEqual({ at_pct: 75 });
  });
});

describe('handlePostTool — wrap_up_at_pct', () => {
  function makeBlockingRepo() {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    return repo;
  }

  it('context one point below wrap_up_at_pct → nothing at all', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // The two-level design warned here (its warn tier sat at 30). There is no warn
    // tier any more, so 59 against a 60 threshold must produce nothing, and 60 must
    // produce the wrap-up brief — this pins the boundary from both sides.
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 59))).toBeNull();
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 60));
    expect(out!.additionalContext).toContain('Context 已达 60%');
    expect(out!.additionalContext).toContain('收尾阈值 60%');
  });

  it('context >= wrap_up_at_pct → wrap-up brief returned', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 65));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('65%');
    // The brief tells the model to wrap up, not to freeze: one session read the old
    // "stop calling tools" wording as "every tool is dead", wrote its handoff into a
    // session-private scratchpad the next session could not find, and lost a
    // correctness finding that overturned an earlier ruling.
    expect(out!.additionalContext).toContain('收尾');
    expect(out!.additionalContext).not.toContain('不要再尝试任何工具调用');
    expect(out!.additionalContext).toMatch(/仍然放行|仍可写/);
    // The old warn tier told the developer to "Ctrl+C 停止任务 → /clear" — at a
    // level where nothing had been wrapped up yet, so acting on it lost work.
    // Nothing in the merged text may say that any more.
    expect(out!.additionalContext).not.toContain('Ctrl+C');
    expect(out!.additionalContext).not.toContain('停止任务');
    // The facts that make a /clear safe afterwards have to be present.
    expect(out!.additionalContext).toContain('/clear');
    expect(out!.additionalContext).toContain('从断点继续');
  });

  it('context >= wrap_up_at_pct → the latch (at_pct) is saved in state', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    await handlePostTool(makeInput(repo.repoRoot, 'Write', 65));
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_wrap_up).toEqual({ at_pct: 65 });
  });

  // Sampling runs on EVERY tool call, so anything that fires more than once fires
  // 18–63 times per session (simulated against three recorded pct series). Driven
  // through the real crossing rather than a pre-seeded latch: the single fire has
  // to come from the code path that writes the latch, not from a fixture.
  it('crossing the threshold injects the brief exactly once', async () => {
    const repo = makeBlockingRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const first = await handlePostTool(makeInput(repo.repoRoot, 'Write', 65));
    expect(first!.additionalContext).toContain('Context 已达 65%');
    // Same level, then higher — both silent. The second is the case the deleted
    // `rewarn_delta_pct` used to let through.
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 65))).toBeNull();
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 80))).toBeNull();
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.context_wrap_up).toEqual({ at_pct: 65 });
  });

  // This used to assert the opposite — "no block_at_pct in config → block never
  // triggers even at 100%", with context_blocked still false. Under one threshold
  // the absent key means "use the engine default", not "off": leaving it off would
  // give a flow whose config.json predates the rename (the schema drops the old
  // keys instead of rejecting them) no context guard at all. 60 is the number both
  // shipped flows carried as block_at_pct, so a stale copy keeps its old timing.
  it('no context block in config → engine default 60 applies', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 59))).toBeNull();
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBeNull();

    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 60));
    expect(out!.additionalContext).toContain('收尾阈值 60%');
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBe(60);
  });

  // A flow may set its own point; the default must not override it.
  it('explicit wrap_up_at_pct overrides the engine default', async () => {
    const repo = createFlowTestRepo('test-flow', {
      ...MINIMAL_CONFIG,
      context: { wrap_up_at_pct: 40 },
    });
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 39))).toBeNull();
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 40));
    expect(out!.additionalContext).toContain('收尾阈值 40%');
  });
});

// The single threshold is not just a reminder: crossing it is what makes PreToolUse
// refuse writes to the codebase while leaving this flow's own docs_paths open. That
// pairing IS the design — "you may no longer produce code, you may still land a
// handoff" — so it is pinned end to end here, from the sample that latches it to the
// two decisions it produces. A stage that is `unrestricted` AND declares docs_paths
// is used deliberately: with a docs_only stage the write-scope guard would deny the
// code write on its own and prove nothing about this one.
describe('handlePostTool → handlePreTool — crossing the threshold refuses code, allows docs', () => {
  const WRAP_UP_CONFIG = {
    ...MINIMAL_CONFIG,
    context: { wrap_up_at_pct: 60 },
    stages: [
      {
        id: 'work',
        prompt: 'stages/work.md',
        write_scope: 'unrestricted' as const,
        docs_paths: ['docs/test-flow/{flow_id}/'],
        completion: {},
      },
    ],
  };

  function makeInputPre(repoRoot: string, toolName: string, toolInput: Record<string, unknown>) {
    return {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'sess-1',
      cwd: repoRoot,
      tool_name: toolName,
      tool_input: toolInput,
    };
  }

  async function latchedRepo() {
    const repo = createFlowTestRepo('test-flow', WRAP_UP_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const brief = await handlePostTool(makeInput(repo.repoRoot, 'Write', 62));
    expect(brief!.additionalContext).toContain('收尾阈值 60%');
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBe(62);
    return repo;
  }

  it('after the threshold: a write to the codebase is DENIED, naming the level', async () => {
    const repo = await latchedRepo();
    const out = await handlePreTool(makeInputPre(repo.repoRoot, 'Write', {
      file_path: join(repo.repoRoot, 'src', 'main.ts'), content: 'x',
    }));
    expect(out?.permissionDecision).toBe('deny');
    expect(out?.permissionDecisionReason).toContain('Context wrap-up started at 62%');
  });

  it("after the threshold: a write to the flow's own docs is still ALLOWED", async () => {
    const repo = await latchedRepo();
    const out = await handlePreTool(makeInputPre(repo.repoRoot, 'Write', {
      file_path: join(repo.repoRoot, 'docs', 'test-flow', 'test-flow-abc', 'handoff.md'),
      content: '交接块',
    }));
    // allow is asserted, not merely "the wrap-up guard did not fire": if some other
    // guard refuses the handoff the outcome is the same lost handoff.
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('below the threshold: nothing is latched and code writes are untouched', async () => {
    const repo = createFlowTestRepo('test-flow', WRAP_UP_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 59))).toBeNull();
    const out = await handlePreTool(makeInputPre(repo.repoRoot, 'Write', {
      file_path: join(repo.repoRoot, 'src', 'main.ts'), content: 'x',
    }));
    expect(out?.permissionDecision ?? 'allow').toBe('allow');
  });

  // The same crossing on a stage that declares NO docs_paths. That shape is legal
  // (the schema requires docs_paths only for `write_scope: 'docs_only'`), and before
  // this pairing was fixed it produced the one state the design forbids: the brief
  // said writes to "本 flow 自己的 docs 目录" were still allowed, and the very next
  // write — to the codebase AND to any handoff document — was denied, while the only
  // prescribed way out (`/clear`) needs that handoff on disk first.
  describe('the same crossing on a stage with no docs_paths', () => {
    async function latchedNoEscapeRepo() {
      const repo = createFlowTestRepo('test-flow', NO_ESCAPE_CONFIG);
      cleanups.push(repo.cleanup);
      writeActiveState(repo.repoRoot, 'test-flow', {
        flow_id: 'test-flow-abc',
        flow_name: 'test-flow',
        requirement: 'test',
        current_stage: 'work',
        base_sha: 'abc',
      });
      const brief = await handlePostTool(makeInput(repo.repoRoot, 'Write', 62));
      expect(brief).not.toBeNull();
      return { repo, brief: brief!.additionalContext };
    }

    it('the brief still fires, and no longer promises a docs directory the config never granted', async () => {
      const { brief } = await latchedNoEscapeRepo();
      expect(brief).toContain('Context 已达 62%');
      expect(brief).toContain('收尾');
      // The lie this fix removes: no claim that anything "仍然放行 / 仍可写", and no
      // invented directory name standing in for docs_paths.
      expect(brief).not.toMatch(/仍然放行|仍可写/);
      expect(brief).not.toContain('本 flow 自己的 docs 目录');
      // What it says instead: nothing is being refused, and why.
      expect(brief).toContain('docs_paths');
      expect(brief).toContain('写权限没有收窄');
      // The handoff still has to land somewhere a later session can find.
      expect(brief).toContain('scratchpad');
    });

    it('the latch is still recorded, so /ai-flow:status keeps reporting it', async () => {
      const { repo } = await latchedNoEscapeRepo();
      const state = await readActiveState(repo.repoRoot, 'test-flow');
      expect(state!.context_wrap_up).toEqual({ at_pct: 62 });
    });

    it('after the threshold: the code write is ALLOWED (a refusal here has no escape hatch)', async () => {
      const { repo } = await latchedNoEscapeRepo();
      const out = await handlePreTool(makeInputPre(repo.repoRoot, 'Write', {
        file_path: join(repo.repoRoot, 'src', 'main.ts'), content: 'x',
      }));
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    it('after the threshold: the handoff write is ALLOWED — the state this fix forbids is "neither"', async () => {
      const { repo } = await latchedNoEscapeRepo();
      const out = await handlePreTool(makeInputPre(repo.repoRoot, 'Write', {
        file_path: join(repo.repoRoot, 'docs', 'handoff.md'), content: '交接块',
      }));
      expect(out?.permissionDecision ?? 'allow').toBe('allow');
    });

    // The reported repro exactly: no `context` block in config.json either, so the
    // threshold is the engine's own default of 60. `/ai-flow:create` can emit this
    // whole shape — it is the combination that produced "code denied, docs denied".
    it('same shape with no `context` block at all (default 60) → brief fires, both writes ALLOWED', async () => {
      const repo = createFlowTestRepo('test-flow', {
        schema_version: '1.0',
        name: 'test-flow',
        stages: [
          { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {} },
        ],
      });
      cleanups.push(repo.cleanup);
      writeActiveState(repo.repoRoot, 'test-flow', {
        flow_id: 'test-flow-abc',
        flow_name: 'test-flow',
        requirement: 'test',
        current_stage: 'work',
        base_sha: 'abc',
      });
      const brief = await handlePostTool(makeInput(repo.repoRoot, 'Write', 60));
      expect(brief!.additionalContext).toContain('收尾阈值 60%');
      expect(brief!.additionalContext).not.toMatch(/仍然放行|仍可写/);
      expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBe(60);
      const code = await handlePreTool(makeInputPre(repo.repoRoot, 'Write', {
        file_path: join(repo.repoRoot, 'src', 'main.ts'), content: 'x',
      }));
      expect(code?.permissionDecision ?? 'allow').toBe('allow');
      const handoff = await handlePreTool(makeInputPre(repo.repoRoot, 'Write', {
        file_path: join(repo.repoRoot, 'docs', 'handoff.md'), content: '交接块',
      }));
      expect(handoff?.permissionDecision ?? 'allow').toBe('allow');
    });

    // The single fire is not a property of the docs_paths branch — the latch gates
    // the injection before the text is built, so this stage is silent afterwards too.
    it('a later sample injects nothing here either', async () => {
      const { repo } = await latchedNoEscapeRepo();
      expect(await handlePostTool(makeInput(repo.repoRoot, 'Write', 70))).toBeNull();
    });
  });

  // flow.log is the flow's single event log and the only record of a crossing that
  // survives the `/clear` the crossing asks for. The event name had no test at all.
  it('crossing the threshold writes a CONTEXT_WRAP_UP line to flow.log', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    await handlePostTool(makeInput(repo.repoRoot, 'Write', 62));
    // A second sample, 8 points up. It used to add a `repeat` line; the crossing is
    // a one-time event now, so the log must stay at one entry.
    await handlePostTool(makeInput(repo.repoRoot, 'Write', 70));
    const log = readFileSync(
      join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'flow.log'), 'utf-8'
    );
    const lines = log.trim().split('\n').filter((l) => l.includes('CONTEXT_WRAP_UP'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('CONTEXT_WRAP_UP pct=62 threshold=60 first');
    // No leftover event name from the deleted two-level model.
    expect(log).not.toMatch(/CONTEXT_WARN|CONTEXT_BLOCK/);
  });
});

function makeSignalInput(repoRoot: string, toolName: string, filePath: string, content: string): PostToolInput {
  return {
    hook_event_name: 'PostToolUse',
    session_id: 'sess-1',
    cwd: repoRoot,
    tool_name: toolName,
    tool_input: { file_path: filePath, content },
    tool_response: null,
    context_size_pct: 10,
  } as PostToolInput & { context_size_pct: number };
}

describe('handlePostTool — signal detection', () => {
  it("signal='done' via non-gate stage → stage advances, additionalContext contains next stage prompt", async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('review');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it("signal='done' via gate stage → additionalContext contains gate pending message", async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'review',
      base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/approve|gate|confirm/i);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it("signal='done' at terminal no-gate stage → active.json deleted", async () => {
    const repo = createFlowTestRepo('test-flow', {
      schema_version: '1.0',
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted', completion: {} },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'review',
      base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/complete|完成/i);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
  });

  it('non-signal write → no gate/advance logic, returns context warning or null', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', '/tmp/some-file.ts', 'content'));
    // Should be null or context warning — NOT gate/advance message
    if (out !== null) {
      expect(out.additionalContext).not.toMatch(/ai-flow.*stage.*complet/i);
    }
    // Stage unchanged
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
  });

  // ── New protocol: AI writes 'done' ──────────────────────────────────────

  it("signal='done' + non-gate stage → advances stage, signal cleared", async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'work', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toContain('review');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
    // Signal cleared after advance
    expect(existsSync(sig)).toBe(false);
  });

  it("signal='done' + gate stage → signal rewritten to next-stage-id, gate pending returned", async () => {
    // GATED_CONFIG: work has gate=true, next is 'review'
    const repo = createFlowTestRepo('test-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'work', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/approve|gate|confirm/i);
    // Non-terminal gate → advance wording, NOT end-flow wording
    expect(out!.additionalContext).toContain('进入下一阶段');
    expect(out!.additionalContext).not.toContain('结束流程');
    // Signal rewritten to next stage id (not 'done')
    expect(readFileSync(sig, 'utf-8').trim()).toBe('review');
    // Stage NOT advanced
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
  });

  it("signal='done' + terminal gate stage → signal rewritten to 'flow-complete', gate pending returned", async () => {
    // MINIMAL_CONFIG: review is terminal with gate=true
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'review', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/approve|gate|confirm/i);
    // Terminal gate → end-flow wording, NOT advance wording
    expect(out!.additionalContext).toContain('确认并结束流程');
    expect(out!.additionalContext).not.toContain('进入下一阶段');
    // Signal rewritten to 'flow-complete'
    expect(readFileSync(sig, 'utf-8').trim()).toBe('flow-complete');
    // Stage NOT advanced
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it("signal='done' + terminal no-gate stage → flow completes, active.json deleted", async () => {
    const noGateTerminalConfig = {
      schema_version: '1.0' as const,
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted' as const, completion: {} },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted' as const, completion: {} },
      ],
    };
    const repo = createFlowTestRepo('test-flow', noGateTerminalConfig);
    cleanups.push(repo.cleanup);
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 'test',
      current_stage: 'review', base_sha: 'abc',
    });
    const sig = signalPath(repo.repoRoot, 'test-flow');
    const { writeFileSync, mkdirSync } = await import('fs');
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state'), { recursive: true });
    writeFileSync(sig, 'done');
    const out = await handlePostTool(makeSignalInput(repo.repoRoot, 'Write', sig, 'done'));
    expect(out).not.toBeNull();
    expect(out!.additionalContext).toMatch(/complete|完成/i);
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
  });
});

describe('handlePostTool — concurrent state writes', () => {
  // PostToolUse fires per write tool call and hooks run in parallel, so the
  // mark-base capture and a context-warning write can be in flight at the same
  // moment, each holding the ActiveState it read at its own entry. A whole-document
  // write-back makes the later one erase the other's field; base_sha_code is the
  // costly loss, since the stage completion scripts that diff against it are
  // fail-closed and reject the gate when it is missing.
  it('mark-base capture racing a context warning → both fields survive', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();

    const markInput = makeInput(repo.repoRoot, 'Write', 10);
    (markInput.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    const warnInput = makeInput(repo.repoRoot, 'Write', 80);

    await Promise.all([handlePostTool(markInput), handlePostTool(warnInput)]);

    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.base_sha_code).toBe(head);
    expect(state!.context_wrap_up.at_pct).toBe(80);
  });

  it('two mark-base captures racing → first-writer-wins, one SHA only', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();
    const mark = () => {
      const i = makeInput(repo.repoRoot, 'Write', 10);
      (i.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
      return handlePostTool(i);
    };
    const outs = await Promise.all([mark(), mark()]);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBe(head);
    expect(outs.filter((o) => /已存在/.test(o?.additionalContext ?? ''))).toHaveLength(1);
  });

  it('two context samples racing → the brief is injected exactly once', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // PostToolUse fires once per tool call and the model issues tool calls in
    // parallel, so both samples read `at_pct` as null at hook entry. Deciding
    // against the entry-read copy injected the ~1.4 KB brief twice and wrote two
    // `first` lines to flow.log.
    const outs = await Promise.all([
      handlePostTool(makeInput(repo.repoRoot, 'Read', 61)),
      handlePostTool(makeInput(repo.repoRoot, 'Read', 62)),
    ]);
    const briefs = outs.filter((o) => /收尾阈值/.test(o?.additionalContext ?? ''));
    expect(briefs).toHaveLength(1);
    const log = readFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'flow.log'), 'utf-8');
    expect(log.split('\n').filter((l) => l.includes('CONTEXT_WRAP_UP'))).toHaveLength(1);
    // First writer wins the frozen level; the later sample must not move it.
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBe(61);
  });

  it('non-owner session cannot latch the wrap-up on the owner\'s flow', async () => {
    const repo = makeRepo();
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
      last_session_id: 'owner-session',
    });
    // A second session in the same checkout is read-only (session-handler returns
    // early for it), but active.json is shared: without an owner check it would
    // latch the wrap-up at ITS occupancy, and the owner — who never crossed
    // anything and never saw the brief — would start getting writes refused.
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Read', 77));
    expect(out).toBeNull();
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBeNull();
  });

  it('context warning does not resurrect a flow that completed meanwhile', async () => {
    const repo = makeRepo();
    // No active.json: stands in for a flow completed or aborted while a hook from
    // the previous stage was still in flight.
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 80));
    expect(out).toBeNull();
    expect(existsSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json'))).toBe(false);
  });
});

describe('handlePostTool — subagent context accounting', () => {
  function makeSubagentInput(repoRoot: string, contextPct: number, agentId = 'agent-abc'): PostToolInput {
    return { ...makeInput(repoRoot, 'Write', contextPct), agent_id: agentId, agent_type: 'reviewer' };
  }

  function seed(repoRoot: string): void {
    writeActiveState(repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
  }

  it('agent_id present → no warning injected and no state write', async () => {
    const repo = makeRepo();
    seed(repo.repoRoot);
    const before = readFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json'), 'utf-8');
    const out = await handlePostTool(makeSubagentInput(repo.repoRoot, 80));
    expect(out).toBeNull();
    const after = readFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'state', 'active.json'), 'utf-8');
    expect(after).toBe(before);
  });

  it('agent_id absent → brief injected (unchanged main-session behavior)', async () => {
    const repo = makeRepo();
    seed(repo.repoRoot);
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 80));
    expect(out!.additionalContext).toMatch(/Context 已达 80%/);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBe(80);
  });

  it('agent_id present + past the wrap-up threshold → latch NOT set', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    seed(repo.repoRoot);
    const out = await handlePostTool(makeSubagentInput(repo.repoRoot, 95));
    expect(out).toBeNull();
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBeNull();
  });

  it('agent_id absent + past the wrap-up threshold → latch set (unchanged)', async () => {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    seed(repo.repoRoot);
    const out = await handlePostTool(makeInput(repo.repoRoot, 'Write', 95));
    expect(out!.additionalContext).toMatch(/收尾阈值/);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.context_wrap_up.at_pct).toBe(95);
  });

  it('agent_id present → mark-base capture still runs (only accounting is skipped)', async () => {
    const repo = makeRepo();
    seed(repo.repoRoot);
    const head = execSync('git rev-parse HEAD', { cwd: repo.repoRoot, encoding: 'utf-8' }).trim();
    const input = makeSubagentInput(repo.repoRoot, 10);
    (input.tool_input as Record<string, unknown>)['file_path'] = markBasePath(repo.repoRoot, 'test-flow');
    await handlePostTool(input);
    expect((await readActiveState(repo.repoRoot, 'test-flow'))!.base_sha_code).toBe(head);
  });
});

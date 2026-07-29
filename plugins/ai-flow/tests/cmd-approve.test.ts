import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, writeFileSync, chmodSync } from 'fs';
import { handleApprove } from '../src/lib/commands/approve.js';
import { readActiveState } from '../src/lib/state.js';
import { createFlowTestRepo, writeActiveState as fixtureWriteState, writeSignal, MINIMAL_CONFIG, GATED_CONFIG } from './fixtures/helpers.js';
import type { FlowConfig } from '../src/lib/flow-schema.js';

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

describe('handleApprove', () => {
  it("no active flow → error 'no active flow'", async () => {
    const repo = makeRepo();
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/no active flow/i);
  });

  it("no gate pending (no signal) → error 'no pending gate'", async () => {
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // No signal written — not a gate stage (work has no gate)
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('deny');
    // New: specific message distinguishes "no signal yet" case
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/signal|completion|does not require/i);
  });

  it("gate pending but signal content wrong → error about mismatch", async () => {
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'review', // review has gate: true
      base_sha: 'abc',
    });
    // Signal content doesn't match nextStage for review (which is terminal → 'flow-complete')
    writeSignal(repo.repoRoot, 'test-flow', 'wrong-content');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('deny');
    // New: specific message distinguishes "wrong signal content" case
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/signal|does not match|checkpoint/i);
  });

  it('gate pending (signal == nextStageId, gate=true) → advance to next stage', async () => {
    // work stage has completion: {} (no gate), but we need a config where we can trigger gate
    // Use a config where work has gate: true
    const config = {
      schema_version: '1.0' as const,
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted' as const, completion: { gate: true as const } },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted' as const, completion: {} },
      ],
    };
    const repo = createFlowTestRepo('test-flow', config);
    cleanups.push(repo.cleanup);
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build something',
      current_stage: 'work',
      base_sha: 'abc',
    });
    // Signal must contain nextStageId = 'review'
    writeSignal(repo.repoRoot, 'test-flow', 'review');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('review');
  });

  it('after approve, active.json shows new current_stage', async () => {
    const config = {
      schema_version: '1.0' as const,
      name: 'test-flow',
      stages: [
        { id: 'work', prompt: 'stages/work.md', write_scope: 'unrestricted' as const, completion: { gate: true as const } },
        { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted' as const, completion: {} },
      ],
    };
    const repo = createFlowTestRepo('test-flow', config);
    cleanups.push(repo.cleanup);
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'test',
      current_stage: 'work',
      base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'review');
    await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it('gate pending at terminal stage (signal == flow-complete) → flow complete, clears state', async () => {
    // MINIMAL_CONFIG: review is last stage with gate: true
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc',
      flow_name: 'test-flow',
      requirement: 'build something',
      current_stage: 'review',
      base_sha: 'abc',
    });
    // Terminal stage signal must be 'flow-complete'
    writeSignal(repo.repoRoot, 'test-flow', 'flow-complete');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/complete|done|finished|完成/i);
  });

  // ── New protocol: AI writes 'done' (posttool may not have rewritten yet) ──

  it("signal='done' + non-terminal gate stage → approve succeeds, advances stage", async () => {
    // GATED_CONFIG: work has gate=true, next is 'review'
    const repo = createFlowTestRepo('test-flow', GATED_CONFIG);
    cleanups.push(repo.cleanup);
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'work', base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it("signal='done' + terminal gate stage → approve succeeds, flow complete", async () => {
    // MINIMAL_CONFIG: review is terminal with gate=true
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'review', base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state).toBeNull();
  });

  it("signal='done' + no-gate stage → approve denied (no gate)", async () => {
    // MINIMAL_CONFIG: work has no gate
    const repo = makeRepo();
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'work', base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('deny');
    expect((result as { action: 'deny'; reason: string }).reason).toMatch(/does not require/i);
  });

  // ── P1-6: release-time re-run of the completion.script gate ──────────────────
  // A stage with BOTH gate:true and a completion.script re-runs that script when
  // approve is called, so changes made during gate-pending can't slip past the
  // fail-closed structural gate.

  const SCRIPT_GATE_CONFIG: FlowConfig = {
    schema_version: '1.0',
    name: 'test-flow',
    stages: [
      {
        id: 'work',
        prompt: 'stages/work.md',
        write_scope: 'unrestricted',
        completion: { gate: true, script: { command: 'bash scripts/check.sh', timeout_ms: 5000 } },
      },
      { id: 'review', prompt: 'stages/review.md', write_scope: 'unrestricted', completion: {} },
    ],
  };

  function makeScriptGateRepo(scriptBody: string) {
    const repo = createFlowTestRepo('test-flow', SCRIPT_GATE_CONFIG);
    cleanups.push(repo.cleanup);
    const scriptPath = join(repo.flowDir, 'scripts', 'check.sh');
    writeFileSync(scriptPath, scriptBody);
    chmodSync(scriptPath, 0o755);
    fixtureWriteState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow',
      requirement: 'test', current_stage: 'work', base_sha: 'abc',
    });
    writeSignal(repo.repoRoot, 'test-flow', 'done');
    return repo;
  }

  it('gate+script, re-check passes → approve advances stage', async () => {
    const repo = makeScriptGateRepo('#!/bin/sh\nexit 0\n');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('allow');
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('review');
  });

  it('gate+script, re-check fails → approve denied, stderr returned, stage unchanged', async () => {
    const repo = makeScriptGateRepo('#!/bin/sh\necho "STRUCTURE VIOLATION: ticket-3 missing" >&2\nexit 1\n');
    const result = await handleApprove(repo.repoRoot, 'test-flow', 'test-sess');
    expect(result.action).toBe('deny');
    const reason = (result as { action: 'deny'; reason: string }).reason;
    expect(reason).toContain('STRUCTURE VIOLATION: ticket-3 missing');
    expect(reason).toContain('bash scripts/check.sh');
    // stage must NOT advance on failed re-check
    const state = await readActiveState(repo.repoRoot, 'test-flow');
    expect(state!.current_stage).toBe('work');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleHelp } from '../src/lib/commands/help.js';
import { createFlowTestRepo, MINIMAL_CONFIG } from './fixtures/helpers.js';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('handleHelp — no flowName (generic listing)', () => {
  it("no .ai-flow/ → shows 'no flows' with skill hints", async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-flow-help-test-'));
    cleanups.push(() => execSync(`rm -rf "${root}"`));
    const result = await handleHelp(root);
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/no flows configured/i);
    expect(ctx).toMatch(/\/ai-flow:add|\/ai-flow:create/i);
  });

  it('multiple flows → lists all with descriptions', async () => {
    const repo = createFlowTestRepo('flow-a', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    mkdirSync(join(repo.repoRoot, '.ai-flow', 'flow-b'), { recursive: true });
    writeFileSync(
      join(repo.repoRoot, '.ai-flow', 'flow-b', 'config.json'),
      JSON.stringify({ ...MINIMAL_CONFIG, name: 'flow-b' })
    );
    const result = await handleHelp(repo.repoRoot);
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('flow-a');
    expect(ctx).toContain('flow-b');
  });
});

describe('handleHelp — with flowName (flow-specific)', () => {
  it('flow has helper.md → injects helper.md content for interactive AI conversation', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    writeFileSync(
      join(repo.repoRoot, '.ai-flow', 'test-flow', 'helper.md'),
      '# test-flow\n\nThis flow does X.\n\n## Commands\n\ntest-flow start <req>'
    );
    const result = await handleHelp(repo.repoRoot, 'test-flow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('test-flow');
    expect(ctx).toContain('This flow does X.');
  });

  it('flow has no helper.md → falls back to stage list from config', async () => {
    const repo = createFlowTestRepo('test-flow', {
      ...MINIMAL_CONFIG,
      description: 'A test workflow',
    });
    cleanups.push(repo.cleanup);
    const result = await handleHelp(repo.repoRoot, 'test-flow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('test-flow');
    expect(ctx).toContain('work');
    expect(ctx).toContain('review');
  });

  it('unknown flowName → suggests add or create', async () => {
    const repo = createFlowTestRepo('test-flow', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    const result = await handleHelp(repo.repoRoot, 'nonexistent-flow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/\/ai-flow:add|\/ai-flow:create/i);
  });
});

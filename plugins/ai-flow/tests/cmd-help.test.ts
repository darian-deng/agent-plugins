import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleHelp } from '../src/lib/commands/help.js';
import { createFlowTestRepo, MINIMAL_CONFIG } from './fixtures/helpers.js';

let cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

describe('handleHelp', () => {
  it("no .ai-flow/ directory → shows 'no flows configured, use /ai-flow'", async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-flow-help-test-'));
    cleanups.push(() => execSync(`rm -rf "${root}"`));
    const result = await handleHelp(root);
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toMatch(/no flows configured|\/ai-flow/i);
  });

  it('one flow configured → shows flow name, description, stage list', async () => {
    const repo = createFlowTestRepo('test-flow', {
      ...MINIMAL_CONFIG,
      description: 'A test workflow',
    });
    cleanups.push(repo.cleanup);
    const result = await handleHelp(repo.repoRoot);
    expect(result.action).toBe('allow');
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('test-flow');
    expect(ctx).toContain('A test workflow');
    expect(ctx).toContain('work');
    expect(ctx).toContain('review');
  });

  it('multiple flows → shows all flows', async () => {
    const repo = createFlowTestRepo('flow-a', MINIMAL_CONFIG);
    cleanups.push(repo.cleanup);
    // Add a second flow to same repo
    const { mkdirSync: mkdir, writeFileSync: write } = await import('fs');
    mkdir(join(repo.repoRoot, '.ai-flow', 'flow-b'), { recursive: true });
    write(
      join(repo.repoRoot, '.ai-flow', 'flow-b', 'config.json'),
      JSON.stringify({ ...MINIMAL_CONFIG, name: 'flow-b' })
    );
    const result = await handleHelp(repo.repoRoot);
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('flow-a');
    expect(ctx).toContain('flow-b');
  });

  it('reads from config.json, not hardcoded', async () => {
    const repo = createFlowTestRepo('dynamic-flow', {
      schema_version: '1.0',
      name: 'dynamic-flow',
      description: 'My dynamic flow',
      stages: [
        { id: 'alpha', prompt: 'stages/alpha.md', write_scope: 'unrestricted', completion: {} },
        { id: 'beta', prompt: 'stages/beta.md', write_scope: 'unrestricted', completion: {} },
        { id: 'gamma', prompt: 'stages/gamma.md', write_scope: 'unrestricted', completion: {} },
      ],
    });
    cleanups.push(repo.cleanup);
    const result = await handleHelp(repo.repoRoot);
    const ctx = (result as { action: 'allow'; additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('alpha');
    expect(ctx).toContain('beta');
    expect(ctx).toContain('gamma');
    expect(ctx).toContain('My dynamic flow');
  });
});

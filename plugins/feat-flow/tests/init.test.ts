import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { createTestRepo, writeInitRecord } from './fixtures/helpers.js';
import { isInitDone } from '../src/lib/state.js';
import { handleUserPromptSubmit } from '../src/lib/commands/router.js';
import type { UserPromptInput } from '../src/lib/types.js';

function input(prompt: string, repoRoot: string): UserPromptInput {
  return { hook_event_name: 'UserPromptSubmit', session_id: 'sess-001', cwd: repoRoot, prompt: prompt };
}

// ─── isInitDone ────────────────────────────────────────────────────────────────

describe('isInitDone', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, pluginDataDir, cleanup } = createTestRepo()));
  afterEach(() => cleanup());

  it('returns false for uninitialised repo', () => {
    expect(isInitDone(repoRoot)).toBe(false);
  });

  it('returns true after writeInitRecord', () => {
    writeInitRecord(repoRoot, pluginDataDir);
    expect(isInitDone(repoRoot)).toBe(true);
  });

  it('is keyed by repo path — different repos are independent', () => {
    const { repoRoot: other, pluginDataDir: otherDataDir, cleanup: c2 } = createTestRepo();
    writeInitRecord(repoRoot, pluginDataDir);
    // other repo uses its own PLUGIN_DATA (set by its createTestRepo call)
    expect(isInitDone(other)).toBe(false);
    c2();
  });
});

// ─── feat-flow init command ────────────────────────────────────────────────────

describe('feat-flow init: idempotency', () => {
  let repoRoot: string;
  let pluginDataDir: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, pluginDataDir, cleanup } = createTestRepo()));
  afterEach(() => cleanup());

  it('marks project as initialised in PLUGIN_DATA', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow init', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(isInitDone(repoRoot)).toBe(true);
  });

  it('running init twice does not error or duplicate gitignore entries', async () => {
    await handleUserPromptSubmit(input('feat-flow init', repoRoot));
    const result = await handleUserPromptSubmit(input('feat-flow init', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');

    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf-8');
    const entries = gitignore.split('\n').filter(l => l.includes('.feat-flow/state.json'));
    expect(entries.length).toBe(1);
  });

  it('copies default stages on first init', async () => {
    await handleUserPromptSubmit(input('feat-flow init', repoRoot));
    expect(existsSync(join(repoRoot, '.feat-flow/stages/stage-1.md'))).toBe(true);
  });

  it('skips copying stages if .feat-flow/stages/ already exists', async () => {
    mkdirSync(join(repoRoot, '.feat-flow/stages'), { recursive: true });
    writeFileSync(join(repoRoot, '.feat-flow/stages/custom.md'), 'custom content');

    await handleUserPromptSubmit(input('feat-flow init', repoRoot));

    expect(readFileSync(join(repoRoot, '.feat-flow/stages/custom.md'), 'utf-8')).toBe('custom content');
    expect(existsSync(join(repoRoot, '.feat-flow/stages/stage-1.md'))).toBe(false);
  });

  it('completion message includes feat-flow reference', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow init', repoRoot));
    const ctx = result.hookSpecificOutput?.additionalContext ?? '';
    expect(ctx).toMatch(/feat-flow/i);
  });
});

// ─── auto-init ─────────────────────────────────────────────────────────────────

describe('auto-init: uninitialised project', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, cleanup } = createTestRepo()));
  afterEach(() => cleanup());

  it('feat-flow status auto-inits and returns status without error', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow status', repoRoot));
    expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
    expect(isInitDone(repoRoot)).toBe(true);
  });

  it('feat-flow start auto-inits then fails on start-specific checks (not on init)', async () => {
    const result = await handleUserPromptSubmit(input('feat-flow start build login', repoRoot));
    const reason = result.hookSpecificOutput?.permissionDecisionReason ?? '';
    expect(reason).not.toMatch(/init|setup/i);
    expect(isInitDone(repoRoot)).toBe(true);
  });
});

// ─── gitignore management ─────────────────────────────────────────────────────

describe('feat-flow init: gitignore', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => ({ repoRoot, cleanup } = createTestRepo()));
  afterEach(() => cleanup());

  it('adds required feat-flow entries', async () => {
    await handleUserPromptSubmit(input('feat-flow init', repoRoot));
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toMatch(/\.feat-flow\/state\.json/);
    expect(gitignore).toMatch(/\.feat-flow\/gate-token/);
  });

  it('does NOT add .feat-flow/.initialized', async () => {
    await handleUserPromptSubmit(input('feat-flow init', repoRoot));
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf-8');
    expect(gitignore).not.toMatch(/\.initialized/);
  });

  it('does NOT gitignore .feat-flow/stages/ (stages are committed)', async () => {
    await handleUserPromptSubmit(input('feat-flow init', repoRoot));
    const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf-8');
    expect(gitignore).not.toMatch(/stages/);
  });
});

import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FeatFlowState, ActiveMarker, InitRecord } from '../../src/lib/types.js';
import { writeInitRecord as stateWriteInitRecord } from '../../src/lib/state.js';

export const PLUGIN_ROOT = join(import.meta.dirname, '../..');
export const PLUGIN_STAGES_DIR = join(PLUGIN_ROOT, 'stages');
// Keep backward-compat alias
export const STAGE_DOCS_DIR = PLUGIN_STAGES_DIR;

/**
 * Create an isolated temp git repo + plugin data dir for each test.
 * Sets process.env.CLAUDE_PLUGIN_DATA to the temp data dir so all
 * production code under test uses it automatically.
 */
export function createTestRepo(): {
  repoRoot: string;
  pluginDataDir: string;
  cleanup: () => void;
} {
  const repoRoot = mkdtempSync(join(tmpdir(), 'feat-flow-test-'));
  const pluginDataDir = mkdtempSync(join(tmpdir(), 'feat-flow-data-'));

  const prevDataDir = process.env['CLAUDE_PLUGIN_DATA'];
  process.env['CLAUDE_PLUGIN_DATA'] = pluginDataDir;

  execSync('git init -q', { cwd: repoRoot });
  execSync('git config user.email "test@test.com"', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });
  writeFileSync(join(repoRoot, '.gitignore'), [
    '.feat-flow/state.json',
    '.feat-flow/gate-token',
    '.feat-flow/violations.log',
    '.feat-flow/*.tmp',
    '.feat-flow/transitions.log',
  ].join('\n'));
  execSync('git add .gitignore', { cwd: repoRoot });
  execSync('git commit -m "init" -q', { cwd: repoRoot });

  mkdirSync(join(repoRoot, '.claude'), { recursive: true });
  mkdirSync(join(repoRoot, '.feat-flow'), { recursive: true });

  // Simulate project-scope installation so isUserScopeInstall() returns false.
  // Commit so the working tree stays clean for preflight checks.
  writeFileSync(
    join(repoRoot, '.claude', 'settings.json'),
    JSON.stringify({ enabledPlugins: { 'feat-flow@darian-agent-plugins': true } }, null, 2),
  );
  execSync('git add .claude/settings.json', { cwd: repoRoot });
  execSync('git commit -m "chore: add feat-flow settings" -q', { cwd: repoRoot });

  return {
    repoRoot,
    pluginDataDir,
    cleanup: () => {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(pluginDataDir, { recursive: true, force: true });
      if (prevDataDir === undefined) delete process.env['CLAUDE_PLUGIN_DATA'];
      else process.env['CLAUDE_PLUGIN_DATA'] = prevDataDir;
    },
  };
}

/** Write an init record for the given repo — simulates "already initialised". */
export function writeInitRecord(
  repoRoot: string,
  pluginDataDir: string,
  record: Partial<InitRecord> = {},
): void {
  stateWriteInitRecord(repoRoot, record, pluginDataDir);
}

export function writeMarker(repoRoot: string, flowId: string): void {
  const marker: ActiveMarker = { flow_id: flowId, started_at: new Date().toISOString() };
  writeFileSync(join(repoRoot, '.claude/.feat-flow-active'), JSON.stringify(marker, null, 2));
}

export function writeState(repoRoot: string, partial: Partial<FeatFlowState>): void {
  const defaults: FeatFlowState = {
    _note: 'Do not manually edit.',
    schema_version: '1.0',
    flow_id: 'test-flow',
    requirement: 'test requirement',
    current_stage: 'stage-1',
    base_sha: 'abc123',
    started_at: '2026-01-01T00:00:00Z',
    last_session_id: null,
    context_size: 1_000_000,
    stage_progress: {},
    waiting_for_gate: false,
    gate_type: null,
    gate_context: null,
    expected_next: 'test',
    context_warning: { warned: false, warned_at_pct: null, warned_at: null },
    approved_task_gates: [],
  };
  writeFileSync(
    join(repoRoot, '.feat-flow/state.json'),
    JSON.stringify({ ...defaults, ...partial }, null, 2),
  );
}

export function writeGateToken(repoRoot: string, token: string): void {
  writeFileSync(join(repoRoot, '.feat-flow/gate-token'), token);
}

export function makeStage1Design(extraContent = ''): string {
  const base = `# User Authentication System

## 需求

This requirement specifies the implementation of a complete user authentication
system including login registration and password reset functionality. The system
must support JWT token based authentication and provide comprehensive error handling
with appropriate security protections throughout the entire application stack.

The frontend component uses React with TypeScript and communicates with the backend
Express server through a RESTful API. Error handling must be comprehensive with
appropriate HTTP status codes and descriptive messages for all failure scenarios
including invalid credentials expired tokens and rate limit violations on endpoints.

Feature scope includes user registration with email and password combination user
login that returns a signed JWT access token on success password reset via email
verification code sent to the registered address and login state persistence using
localStorage on the client side with proper descriptive error messages for invalid
credentials and other failure cases as well as rate limiting on authentication
endpoints to prevent brute force attacks on the authentication system.

Out of scope for this iteration are third party OAuth login providers such as
Google or GitHub multi factor authentication support including TOTP or SMS and
social login integrations of any kind across the platform.

## 约束

- Use the existing user database schema without any migrations required
- Read the JWT secret exclusively from environment variables at runtime

## 验收标准

- Registration endpoint returns HTTP 201 on success with created user data in body
- Login endpoint returns HTTP 200 with a valid JWT token on successful authentication
- Error cases return correct HTTP status codes and descriptive error messages in body
- Unit test coverage reaches at least eighty percent across all authentication modules
- TypeScript strict mode compilation passes with zero errors throughout the project

## STAGE-1-COMPLETE

Requirements confirmed.
`;
  return base + extraContent;
}

export function makePlanMd(options: {
  total: number;
  completed?: number;
  gateOnTask?: number;
  withStageComplete?: boolean;
}): string {
  const { total, completed = 0, gateOnTask, withStageComplete } = options;
  const lines = ['## Tasks', ''];
  for (let i = 1; i <= total; i++) {
    const done = i <= completed;
    const gate = gateOnTask === i ? ' [GATE]' : '';
    lines.push(`- [${done ? 'x' : ' '}] Task ${i}: implement feature ${i}${gate}`);
    lines.push(`  - AC: feature-${i}.ts exports correct interface`);
    lines.push('');
  }
  if (withStageComplete) {
    lines.push('## STAGE-5-COMPLETE', '');
    lines.push('Implementation complete.');
  }
  return lines.join('\n');
}

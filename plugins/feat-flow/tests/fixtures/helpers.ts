import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FeatFlowState, ActiveMarker, SetupMarker } from '../../src/lib/types.js';

export const PLUGIN_ROOT = join(import.meta.dirname, '../..');
export const STAGE_DOCS_DIR = join(PLUGIN_ROOT, 'stages');

/**
 * Create an isolated temp git repo for each test.
 * Returns the repo root path. Call cleanup() in afterEach.
 */
export function createTestRepo(): { repoRoot: string; cleanup: () => void } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'feat-flow-test-'));

  // git init with .gitignore so .feat-flow/ doesn't appear as untracked
  execSync('git init -q', { cwd: repoRoot });
  execSync('git config user.email "test@test.com"', { cwd: repoRoot });
  execSync('git config user.name "Test"', { cwd: repoRoot });
  writeFileSync(join(repoRoot, '.gitignore'), [
    '.feat-flow/secret',
    '.feat-flow/gate-token',
    '.feat-flow/state.json',
    '.feat-flow/violations.log',
    '.feat-flow/.initialized',
    '.feat-flow/*.tmp',
  ].join('\n'));
  execSync('git add .gitignore', { cwd: repoRoot });
  execSync('git commit -m "init" -q', { cwd: repoRoot });

  // create required dirs
  mkdirSync(join(repoRoot, '.claude'), { recursive: true });
  mkdirSync(join(repoRoot, '.feat-flow'), { recursive: true });

  return {
    repoRoot,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

export function writeMarker(repoRoot: string, flowId: string): void {
  const marker: ActiveMarker = {
    flow_id: flowId,
    started_at: new Date().toISOString(),
  };
  writeFileSync(
    join(repoRoot, '.claude/.feat-flow-active'),
    JSON.stringify(marker, null, 2),
  );
}

export function writeSetupMarker(repoRoot: string): void {
  const marker: SetupMarker = {
    setup_version: '1.0.0',
    setup_at: new Date().toISOString(),
    gitignore_ok: true,
  };
  writeFileSync(
    join(repoRoot, '.feat-flow/.initialized'),
    JSON.stringify(marker, null, 2),
  );
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

/** Build a design.md that passes stage-1 completion checks (200+ English words for wc -w). */
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

/** Build plan.md with N tasks, optionally marking some complete or adding [GATE]. */
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

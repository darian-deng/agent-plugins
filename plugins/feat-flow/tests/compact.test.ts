/**
 * PreCompact hook — protects stage-5 context from compaction.
 * Also resets context_warning when compaction completes (via PostCompact).
 *
 * Responsibilities:
 *  - Pass through when no active flow
 *  - Block compact during stage-5 (implementation context must be preserved)
 *  - Allow compact in all other stages
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestRepo,
  writeMarker,
  writeState,
} from './fixtures/helpers.js';
import type { PreCompactInput } from '../src/lib/types.js';

import { handlePreCompact } from '../src/lib/compact-handler.js';

function input(repoRoot: string): PreCompactInput {
  return {
    hook_event_name: 'PreCompact',
    session_id: 'sess-001',
    cwd: repoRoot,
  };
}

describe('PreCompact', () => {
  let repoRoot: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ repoRoot, cleanup } = createTestRepo());
  });
  afterEach(() => cleanup());

  it('no active flow → null (allow)', async () => {
    const result = await handlePreCompact(input(repoRoot));
    expect(result).toBeNull();
  });

  it('stage-5 → block with explanation', async () => {
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-5' });
    const result = await handlePreCompact(input(repoRoot));
    expect(result).not.toBeNull();
    // compact blocked
    expect(result?.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreCompact',
    });
    expect(result?.systemMessage).toMatch(/stage-5|实施/);
  });

  it('stage-1 → null (allow)', async () => {
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-1' });
    const result = await handlePreCompact(input(repoRoot));
    expect(result).toBeNull();
  });

  it('stage-3 → null (allow)', async () => {
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-3' });
    const result = await handlePreCompact(input(repoRoot));
    expect(result).toBeNull();
  });

  it('stage-8 → null (allow)', async () => {
    writeMarker(repoRoot, 'test-flow');
    writeState(repoRoot, { current_stage: 'stage-8' });
    const result = await handlePreCompact(input(repoRoot));
    expect(result).toBeNull();
  });
});

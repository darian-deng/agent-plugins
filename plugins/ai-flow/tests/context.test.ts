import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { contextWindowForModel, DEFAULT_CONTEXT_WINDOW, readTokenCount } from '../src/lib/context.js';

describe('contextWindowForModel', () => {
  it('claude-sonnet-4-6[1m] → 1_000_000', () => {
    expect(contextWindowForModel('claude-sonnet-4-6[1m]')).toBe(1_000_000);
  });

  it('claude-haiku-4-5[200k] → 200_000', () => {
    expect(contextWindowForModel('claude-haiku-4-5[200k]')).toBe(200_000);
  });

  it('model with no suffix → DEFAULT_CONTEXT_WINDOW (1M)', () => {
    expect(contextWindowForModel('claude-sonnet-4-6')).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('undefined → DEFAULT_CONTEXT_WINDOW', () => {
    expect(contextWindowForModel(undefined)).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it('unknown model string → DEFAULT_CONTEXT_WINDOW', () => {
    expect(contextWindowForModel('some-future-model-xyz')).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

// readTokenCount scans the transcript from the tail and stops at the first hit,
// so these cases pin the semantics that scan direction must not change: it is
// the last assistant entry WITH a usage block that wins — not the last
// assistant entry, and not the last entry of any type carrying usage.
describe('readTokenCount', () => {
  let dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  function writeTranscript(lines: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'ai-flow-transcript-'));
    dirs.push(dir);
    const p = join(dir, 'session.jsonl');
    writeFileSync(p, lines.join('\n'));
    return p;
  }

  const assistant = (input: number, cacheCreate: number, cacheRead: number) =>
    JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: input, cache_creation_input_tokens: cacheCreate, cache_read_input_tokens: cacheRead } },
    });

  it('sums the three token fields of the last assistant entry that has usage', () => {
    const p = writeTranscript([
      assistant(1, 2, 3),
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      assistant(100, 200, 300),
    ]);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(600);
  });

  it('skips trailing assistant entries that carry no usage', () => {
    const p = writeTranscript([
      assistant(10, 20, 30),
      JSON.stringify({ type: 'assistant', message: {} }),
      JSON.stringify({ type: 'assistant' }),
    ]);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(60);
  });

  it('ignores usage on non-assistant entries', () => {
    const p = writeTranscript([
      assistant(1, 1, 1),
      JSON.stringify({ type: 'user', message: { usage: { input_tokens: 9999 } } }),
    ]);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(3);
  });

  it('treats missing token fields as 0', () => {
    const p = writeTranscript([JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 42 } } })]);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(42);
  });

  it('skips malformed lines and keeps scanning', () => {
    const p = writeTranscript([assistant(5, 5, 5), '{not json at all', '', '   ']);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(15);
  });

  it('tolerates a malformed line sitting between two valid assistant entries', () => {
    const p = writeTranscript([assistant(1, 1, 1), '}}}broken', assistant(7, 0, 0)]);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(7);
  });

  it('handles a trailing newline (empty final line)', () => {
    const p = writeTranscript([assistant(4, 0, 0), '']);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(4);
  });

  it('returns 0 when no assistant entry has usage', () => {
    const p = writeTranscript([JSON.stringify({ type: 'user', message: { content: 'hi' } })]);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(0);
  });

  it('returns 0 for an empty transcript', () => {
    const p = writeTranscript([]);
    expect(readTokenCount('sess', '/nowhere', p)).toBe(0);
  });

  it('returns 0 when the transcript file does not exist', () => {
    expect(readTokenCount('sess', '/nowhere', join(tmpdir(), 'ai-flow-does-not-exist-xyz.jsonl'))).toBe(0);
  });

  it('returns 0 when the cwd-derived fallback path does not exist either', () => {
    expect(readTokenCount('no-such-session-id-xyz', '/nowhere/at/all')).toBe(0);
  });

  // The reader only pulls the tail of the file (transcripts reach tens of MB).
  // These pin the window mechanics: a hit past the first window must still be
  // found, and a window boundary must never corrupt or drop the answer.
  describe('tail-window reading', () => {
    // 256KB window, so ~400KB of filler pushes the answer out of the first read.
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) => JSON.stringify({ type: 'user', message: { content: 'x'.repeat(400), i } }));

    it('finds the answer when it sits beyond the first tail window', () => {
      const p = writeTranscript([assistant(9, 9, 9), ...filler(1000)]);
      expect(readTokenCount('sess', '/nowhere', p)).toBe(27);
    });

    it('is not corrupted by a multi-byte character split at the window boundary', () => {
      const wide = Array.from({ length: 1000 }, (_, i) =>
        JSON.stringify({ type: 'user', message: { content: '中文内容'.repeat(100), i } }));
      const p = writeTranscript([assistant(11, 0, 0), ...wide]);
      expect(readTokenCount('sess', '/nowhere', p)).toBe(11);
    });

    it('prefers the latest usage entry even when earlier ones sit past the window', () => {
      const p = writeTranscript([assistant(1, 1, 1), ...filler(1000), assistant(2, 0, 0)]);
      expect(readTokenCount('sess', '/nowhere', p)).toBe(2);
    });

    it('returns 0 for a large transcript that has no usage entry at all', () => {
      const p = writeTranscript(filler(1000));
      expect(readTokenCount('sess', '/nowhere', p)).toBe(0);
    });
  });
});

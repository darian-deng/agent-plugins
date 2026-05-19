import { describe, it, expect } from 'vitest';
import { contextWindowForModel, DEFAULT_CONTEXT_WINDOW } from '../src/lib/context.js';

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

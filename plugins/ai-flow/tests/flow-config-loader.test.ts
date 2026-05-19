import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  loadFlowConfig,
  discoverFlows,
  getStageConfig,
  resolveDocsPaths,
  FlowNotFoundError,
  FlowConfigParseError,
  FlowConfigValidationError,
} from '../src/lib/flow-config-loader.js';
import { MINIMAL_CONFIG } from './fixtures/helpers.js';

let tmpDirs: string[] = [];

function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'ai-flow-loader-test-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs) execSync(`rm -rf "${d}"`);
  tmpDirs = [];
});

function writeConfig(root: string, flowName: string, content: unknown): void {
  const dir = join(root, '.ai-flow', flowName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(content, null, 2));
}

describe('loadFlowConfig', () => {
  it('valid config.json → returns parsed FlowConfig', async () => {
    const root = makeTmp();
    writeConfig(root, 'test-flow', MINIMAL_CONFIG);
    const config = await loadFlowConfig(root, 'test-flow');
    expect(config.name).toBe('test-flow');
    expect(config.stages).toHaveLength(2);
  });

  it("missing file → throws FlowNotFoundError with 'use /ai-flow to add'", async () => {
    const root = makeTmp();
    await expect(loadFlowConfig(root, 'nonexistent')).rejects.toThrow(FlowNotFoundError);
    await expect(loadFlowConfig(root, 'nonexistent')).rejects.toThrow(/use \/ai-flow to add/);
  });

  it('invalid JSON → throws FlowConfigParseError with file path', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'bad-flow'), { recursive: true });
    writeFileSync(join(root, '.ai-flow', 'bad-flow', 'config.json'), '{ not json ');
    await expect(loadFlowConfig(root, 'bad-flow')).rejects.toThrow(FlowConfigParseError);
    try {
      await loadFlowConfig(root, 'bad-flow');
    } catch (e) {
      expect(String(e)).toContain('config.json');
    }
  });

  it('schema violation → throws FlowConfigValidationError with Zod error details', async () => {
    const root = makeTmp();
    writeConfig(root, 'bad-schema', { schema_version: '2.0', name: 'x', stages: [] });
    await expect(loadFlowConfig(root, 'bad-schema')).rejects.toThrow(FlowConfigValidationError);
    try {
      await loadFlowConfig(root, 'bad-schema');
    } catch (e) {
      expect(e instanceof FlowConfigValidationError).toBe(true);
      expect(String(e)).toMatch(/\w/); // has error details
    }
  });
});

describe('discoverFlows', () => {
  it("no .ai-flow/ directory → returns []", async () => {
    const root = makeTmp();
    expect(await discoverFlows(root)).toEqual([]);
  });

  it('3 flows → returns all 3 names', async () => {
    const root = makeTmp();
    writeConfig(root, 'flow-a', MINIMAL_CONFIG);
    writeConfig(root, 'flow-b', MINIMAL_CONFIG);
    writeConfig(root, 'flow-c', MINIMAL_CONFIG);
    const flows = await discoverFlows(root);
    expect(flows.sort()).toEqual(['flow-a', 'flow-b', 'flow-c']);
  });

  it('ignores directories without config.json', async () => {
    const root = makeTmp();
    mkdirSync(join(root, '.ai-flow', 'no-config'), { recursive: true });
    writeConfig(root, 'has-config', MINIMAL_CONFIG);
    const flows = await discoverFlows(root);
    expect(flows).toEqual(['has-config']);
  });
});

describe('getStageConfig', () => {
  it('returns StageConfig for valid id', () => {
    const stage = getStageConfig(MINIMAL_CONFIG, 'work');
    expect(stage.id).toBe('work');
  });

  it('throws if stage not found', () => {
    expect(() => getStageConfig(MINIMAL_CONFIG, 'nonexistent')).toThrow(/nonexistent/);
  });
});

describe('resolveDocsPaths', () => {
  it('replaces {flow_id} with actual flow_id', () => {
    const result = resolveDocsPaths(['docs/flows/{flow_id}/design.md'], 'abc-123');
    expect(result).toEqual(['docs/flows/abc-123/design.md']);
  });

  it('leaves paths without template unchanged', () => {
    const result = resolveDocsPaths(['docs/static/'], 'ignored');
    expect(result).toEqual(['docs/static/']);
  });
});

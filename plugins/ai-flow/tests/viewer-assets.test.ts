import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { handlePreTool } from '../src/lib/pretool-handler.js';
import { createFlowTestRepo, writeActiveState, MINIMAL_CONFIG } from './fixtures/helpers.js';

// The full-screen diagram viewer ships as a copy per flow: `ai-flow add` copies
// one flow directory with cpSync, so a shared location would never reach the
// consumer project. The duplication is deliberate — the drift is not. Only a
// header comment naming the sibling copy differs; everything below must match,
// or the viewer silently works in one flow and not the other (a divergence
// nobody notices, because the two flows are rarely opened side by side).
const FLOW_ROOT = join(__dirname, '..', '.ai-flow');

function assetBody(flow: string, file: string): string {
  const raw = readFileSync(join(FLOW_ROOT, flow, 'references', 'assets', file), 'utf-8');
  return raw.split('\n').slice(1).join('\n'); // drop the flow-specific header comment
}

function injectorBody(flow: string): string {
  const raw = readFileSync(join(FLOW_ROOT, flow, 'references', 'assets', 'inject-viewer.cjs'), 'utf-8');
  return raw.split('\n').slice(2).join('\n'); // drop shebang + flow-specific header comment
}

describe('viewer assets stay identical across flows', () => {
  /**
   * 资产清单**自动发现**，不手工枚举。
   *
   * 上一版把四个文件名写死在数组里，于是每加一份新资产都要有人记得同时改测试——
   * `mermaid-theme.json` 就是这么漏过一轮的（它是第 4 份，测试当时只守前 3 份）。
   * 手工清单守不住「只加到一个 flow 下」这种漏同步，而那正是这道门要防的事。
   */
  const assetsOf = (flow: string) =>
    readdirSync(join(FLOW_ROOT, flow, 'references', 'assets')).sort();

  it('两个 flow 的 assets/ 文件名集合完全相同', () => {
    expect(assetsOf('grill-flow')).toEqual(assetsOf('feat-flow'));
  });

  it('assets/ 非空（防止用例空跑成恒绿）', () => {
    expect(assetsOf('feat-flow').length).toBeGreaterThanOrEqual(4);
  });

  for (const file of assetsOf('feat-flow')) {
    it(`${file} matches between grill-flow and feat-flow`, () => {
      // .json / .css / .js 里只有 .cjs 与 .js/.css 带 flow 专属头注释；JSON 没有注释行，
      // 砍掉首行等于砍掉 `{`，会把两个坏掉的片段比成相等。
      if (file.endsWith('.json')) {
        const read = (flow: string) =>
          readFileSync(join(FLOW_ROOT, flow, 'references', 'assets', file), 'utf-8');
        expect(read('grill-flow')).toBe(read('feat-flow'));
      } else if (file === 'inject-viewer.cjs') {
        expect(injectorBody('grill-flow')).toBe(injectorBody('feat-flow'));
      } else {
        expect(assetBody('grill-flow', file)).toBe(assetBody('feat-flow', file));
      }
    });
  }

  it('mermaid-theme.json is valid JSON and still carries the two settings the contract promises', () => {
    const cfg = JSON.parse(
      readFileSync(join(FLOW_ROOT, 'feat-flow', 'references', 'assets', 'mermaid-theme.json'), 'utf-8'),
    );
    // Both contracts state these two verbatim as the reason for passing `-c` at all:
    // `theme: base` is the only mermaid theme whose themeVariables can be overridden, and
    // `layout: elk` is what turns "arrows don't cross boxes" from a self-check item into a
    // layout-engine guarantee. Losing either one is silent — mmdc still exits 0.
    expect(cfg.theme).toBe('base');
    expect(cfg.layout).toBe('elk');
    expect(Object.keys(cfg.themeVariables ?? {}).length).toBeGreaterThan(5);
  });

  it('viewer.js is non-empty and still the self-contained IIFE the HTML inlines', () => {
    const js = assetBody('grill-flow', 'viewer.js').trim();
    expect(js.length).toBeGreaterThan(1000);
    expect(js.startsWith('(function()')).toBe(true);
  });
});

// The injector has to live somewhere the agent is actually allowed to execute.
// PreToolUse fences Bash by PATH FRAGMENT on `.ai-flow/<flow>/scripts` (control
// plane — the deny message notes it covers reads too), so an injector parked
// there is unrunnable: the anchors survive, the viewer silently does nothing,
// and in grill-flow the stage-2 anchor check then makes the gate unpassable.
// A unit test of the script alone cannot catch that — only the guard can.
describe('the documented viewer-injection command survives the Bash guard', () => {
  let cleanups: Array<() => void> = [];
  afterEach(() => { for (const c of cleanups) c(); cleanups = []; });

  const commandIn = (doc: string): string => {
    const line = readFileSync(join(FLOW_ROOT, doc), 'utf-8')
      .split('\n').find((l) => l.includes('inject-viewer.cjs'));
    if (!line) throw new Error(`no inject-viewer command found in ${doc}`);
    return line.trim();
  };

  for (const [flow, doc] of [
    ['grill-flow', 'grill-flow/references/spec-view.md'],
    ['feat-flow', 'feat-flow/references/tech-design-view.md'],
  ] as const) {
    it(`${flow}: PreToolUse does not deny it`, async () => {
      const repo = createFlowTestRepo(flow, MINIMAL_CONFIG);
      cleanups.push(repo.cleanup);
      writeActiveState(repo.repoRoot, flow, {
        flow_id: `${flow}-abc`, flow_name: flow,
        requirement: 'r', current_stage: 'work', base_sha: 'abc',
      });
      // Resolve the placeholders exactly as renderPrompt would before the agent runs it.
      const command = commandIn(doc)
        .replace(/\{\{\s*flow_root\s*\}\}/g, join(repo.repoRoot, '.ai-flow', flow))
        .replace(/\{\{\s*project_root\s*\}\}/g, repo.repoRoot);

      const out = await handlePreTool({
        hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: repo.repoRoot,
        tool_name: 'Bash', tool_input: { command },
      });
      expect(out?.permissionDecision).not.toBe('deny');
    });
  }
});

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, '..', 'agents');

/**
 * 插件代理只指定模型家族：版本交给宿主的别名解析，effort 交给开发者的全局配置。
 * 定义文件头里写了 `effort:` 就会覆盖开发者的配置（实测：定义不写时子代理与主 session 同档）。
 * grill-qc 还要在正文里把模型原样交给 `qc-metrics`，那一处与文件头靠手工同步。
 */

function parse(file: string): { front: Record<string, string>; body: string } {
  const text = readFileSync(join(AGENTS_DIR, file), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}: 缺 frontmatter`);
  const front: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (kv) front[kv[1]!] = kv[2]!.trim();
  }
  return { front, body: m[2]! };
}

const files = readdirSync(AGENTS_DIR).filter(f => f.endsWith('.md'));

describe('插件代理定义', () => {
  it('至少有 grill-impl 与 grill-qc', () => {
    expect(files).toEqual(expect.arrayContaining(['grill-impl.md', 'grill-qc.md']));
  });

  for (const f of files) {
    it(`${f}: name 与文件名一致、禁掉 Agent 工具、只写模型家族、不写 effort`, () => {
      const { front } = parse(f);
      expect(front['name']).toBe(f.replace(/\.md$/, ''));
      expect(front['disallowedTools']?.split(/[,\s]+/)).toContain('Agent');
      expect(['opus', 'sonnet', 'haiku', 'inherit']).toContain(front['model']);
      expect(front['effort'], 'effort 交给开发者的全局配置，别在定义里写死').toBeUndefined();
    });
  }

  it('grill-qc 正文交给 qc-metrics 的 model= 与文件头一致', () => {
    const { front, body } = parse('grill-qc.md');
    expect(body).toContain(`model=${front['model']}`);
  });
});

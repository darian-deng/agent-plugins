import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, '..', 'agents');

/**
 * 插件代理的 model / effort 只能写在定义文件头（Agent 工具传不了 effort），而 grill-qc 还要在
 * 正文里把同样两个值原样交给 `qc-metrics`。两处靠手工同步：改了文件头忘了正文，每一行
 * qc-metrics 都会静默记成旧值，换模型前后的样本就分不开了。
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
    it(`${f}: name 与文件名一致，且禁掉 Agent 工具（子代理派孙代理只能空转等待）`, () => {
      const { front } = parse(f);
      expect(front['name']).toBe(f.replace(/\.md$/, ''));
      expect(front['disallowedTools']?.split(/[,\s]+/)).toContain('Agent');
      expect(front['model']).toBeTruthy();
      expect(front['effort']).toBeTruthy();
    });
  }

  it('grill-qc 正文交给 qc-metrics 的 model= / effort= 与文件头一致', () => {
    const { front, body } = parse('grill-qc.md');
    expect(body).toContain(`model=${front['model']} effort=${front['effort']}`);
  });
});

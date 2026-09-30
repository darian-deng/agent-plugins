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
  it('至少有 grill-impl、grill-qc、grill-comment', () => {
    expect(files).toEqual(expect.arrayContaining(['grill-impl.md', 'grill-qc.md', 'grill-comment.md']));
  });

  // 每次派发都一样的纪律只留一份：写在代理定义里（子代理系统提示，确定送达），契约里只留指针。
  // 实测「原样内联进 dispatch prompt」的规定下 27 份实施 prompt 只有 18 份带了注释纪律。
  it('注释写时纪律只在 grill-impl 定义里，不再重复在 per-ticket-review.md', () => {
    const { body } = parse('grill-impl.md');
    const contract = readFileSync(join(__dirname, '..', '.ai-flow', 'grill-flow', 'references', 'per-ticket-review.md'), 'utf8');
    for (const phrase of ['**默认不写。**', '本地四类 why', '硬预算（可数上限', '不写「进程指代」']) {
      expect(body, phrase).toContain(phrase);
      expect(contract, phrase).not.toContain(phrase);
    }
  });

  it('grill-comment 是 sonnet，正文带三条硬约束与搬迁清单', () => {
    const { front, body } = parse('grill-comment.md');
    expect(front['model']).toBe('sonnet');
    expect(body).toContain('ai-flow:comment');
    expect(body).toContain('不要执行 typecheck / lint / 测试命令');
    expect(body).toContain('零搬迁');
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

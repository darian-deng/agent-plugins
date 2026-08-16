import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderPrompt, injectableStagePrompt, assembledOverhead, buildAiFlowPreamble, INLINE_INJECTION_BUDGET } from '../src/lib/prompt-render.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = join(__dirname, '..', '.ai-flow');

/**
 * 一份 stage 提示词一旦渲染后超过宿主的内联上限，宿主就把它落盘、只回注约 2000 字符预览。
 * 这个失败是**静默**的：模型拿到开头一小段，没有任何东西告诉它「还有 90% 没给你」，
 * 而掉在边缘之外的恰好是那些「违反了也不会有东西变红」的规则。
 *
 * 上限是实测夹逼出来的（本机全部 transcript 里，内联最大 9893 字符、溢出最小 10003），
 * 且按**字符**算不按字节——中文一个字 3 字节，用字节做预算会把溢出低估约 1.9 倍。
 *
 * 这份测试是那条预算的唯一执行方。仓库里早有同类先例：`doc-length-note.test.ts` 给一条
 * 4 行的 note 设了硬预算——而比它大三个数量级的 stage 提示词此前没有任何约束。
 */
const KNOWN_OVERSIZE = new Set<string>([
  // 已知欠账：这些提示词现在就在丢内容，必须逐个拆到预算之内。
  // ⛔ 只许从这张表里删，不许往里加——加一条就是让一份新提示词开始静默丢内容。
]);

function stagePrompts(): Array<{ id: string; file: string }> {
  const out: Array<{ id: string; file: string }> = [];
  for (const flow of readdirSync(FLOWS_DIR)) {
    const cfgPath = join(FLOWS_DIR, flow, 'config.json');
    if (!existsSync(cfgPath)) continue;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as { stages: Array<{ prompt: string }> };
    for (const st of cfg.stages) out.push({ id: `${flow}/${st.prompt}`, file: join(FLOWS_DIR, flow, st.prompt) });
  }
  return out;
}

// 渲染时用一个「深 monorepo 子项目锚点」做基准：`{{flow_root}}` 会展开成绝对路径，
// 一份带十个占位符的提示词在深路径下要多花几百字符——按浅路径量会低估。
const DEEP_ANCHOR = '/Users/someone/Documents/Codes/worktrees/some-repo_main/apps/desktop';

/**
 * ⚠️ 宿主的上限管的是**组装后的整条 `additionalContext`**，不是提示词本身。引擎在提示词外面
 * 还要包一层：`[ai-flow:paths]` 前言（长度随项目路径深度变化）+ 分隔框 + 收尾指示。只量
 * `renderPrompt()` 会少算约 400 字符——一份实际会溢出的提示词能就这么当成「内联得下」通过，
 * 而溢出是静默的。所以这里复刻两个注入点各自的组装，取更大的那个当固定开销。
 */
function injectionOverhead(flow: string): number {
  const preamble = buildAiFlowPreamble(DEEP_ANCHOR, flow, 'a'.repeat(40));
  const advance = assembledOverhead((body) =>
    `[ai-flow] Stage 'stage-N' 已完成，进入 'stage-N'。\n\n` +
    `════════════════════════════════\n${body}\n════════════════════════════════\n\n` +
    `用 1-2 句自然语言告知用户已进入新阶段，然后直接开始工作，不要等待用户回复。`);
  const session = assembledOverhead((body) => preamble + [
    `[ai-flow] 流程 '${flow}' 恢复中，当前处于 'stage-N'。`, ``,
    `════════════════════════════════`, body, `════════════════════════════════`, ``,
    `阶段完成后，将 'done' 写入 signal 文件触发推进（引擎自动计算下一步）。`,
  ].join('\n'));
  return Math.max(advance, session);
}

describe('stage 提示词的内联预算', () => {
  const prompts = stagePrompts();

  it('至少找到了每个 flow 的 stage 提示词（防止用例空跑成恒绿）', () => {
    expect(prompts.length).toBeGreaterThanOrEqual(10);
    for (const p of prompts) expect(existsSync(p.file), p.id).toBe(true);
  });

  for (const p of stagePrompts()) {
    const known = KNOWN_OVERSIZE.has(p.id);
    it(`${p.id} ${known ? '（已知欠账，只许变小）' : '渲染后不超过内联上限'}`, () => {
      const flow = p.id.split('/')[0]!;
      const rendered = renderPrompt(readFileSync(p.file, 'utf-8'), DEEP_ANCHOR, flow);
      const total = rendered.length + injectionOverhead(flow);
      if (!known) {
        expect(total, `${p.id} 组装后 ${total} 字符（提示词 ${rendered.length} + 引擎包裹 ${injectionOverhead(flow)}）`).toBeLessThanOrEqual(INLINE_INJECTION_BUDGET);
      } else {
        // 欠账项：不卡上限，但必须仍然超限——一旦拆到预算之内，就从 KNOWN_OVERSIZE 里删掉，
        // 这条断言会提醒你去删。
        expect(total, `${p.id} 已降到预算内，请从 KNOWN_OVERSIZE 删除它`).toBeGreaterThan(INLINE_INJECTION_BUDGET);
      }
    });
  }
});

describe('injectableStagePrompt', () => {
  it('预算之内 → 原样注入', () => {
    const short = 'x'.repeat(100);
    expect(injectableStagePrompt(short, '/repo/.ai-flow/f/stages/s.md')).toBe(short);
  });

  it('包裹开销计入判据：正文本身没超、加上包裹就超 → 走兜底', () => {
    const body = 'x'.repeat(INLINE_INJECTION_BUDGET - 100);
    expect(injectableStagePrompt(body, '/p.md', 0)).toBe(body);          // 不计开销 → 通过
    const out = injectableStagePrompt(body, '/p.md', 400);               // 计入开销 → 兜底
    expect(out).toContain('/p.md');
    expect(out).not.toContain('xxxxx');
  });

  it('超预算 → 不注入截断正文，而是给出真实 stage 文件路径与「立刻 Read」的指令', () => {
    const long = '正文'.repeat(INLINE_INJECTION_BUDGET);
    const path = '/repo/.ai-flow/f/stages/stage-3.md';
    const out = injectableStagePrompt(long, path);
    expect(out).toContain(path);
    expect(out).toContain('Read');
    expect(out.length).toBeLessThan(INLINE_INJECTION_BUDGET);
    // 关键：一个字的正文都不带。截断的提示词比没有提示词更糟——模型无从知道它是残缺的。
    expect(out).not.toContain('正文正文');
  });
});

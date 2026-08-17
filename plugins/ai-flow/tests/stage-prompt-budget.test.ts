import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { advanceStage } from '../src/lib/advance-stage.js';
import { createFlowTestRepo, writeActiveState, BLOCKING_CONFIG } from './fixtures/helpers.js';
import { renderPrompt, injectableStagePrompt, assembledOverhead, buildAiFlowPreamble, gateProtocolNote, commandOutputPrefix, INLINE_INJECTION_BUDGET } from '../src/lib/prompt-render.js';

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

function stagePrompts(): Array<{ id: string; file: string; gated: boolean }> {
  const out: Array<{ id: string; file: string; gated: boolean }> = [];
  for (const flow of readdirSync(FLOWS_DIR)) {
    const cfgPath = join(FLOWS_DIR, flow, 'config.json');
    if (!existsSync(cfgPath)) continue;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')) as {
      stages: Array<{ prompt: string; completion?: { gate?: boolean } }>;
    };
    for (const st of cfg.stages) out.push({
      id: `${flow}/${st.prompt}`,
      file: join(FLOWS_DIR, flow, st.prompt),
      gated: st.completion?.gate === true,
    });
  }
  return out;
}

// 渲染时用一个「深 monorepo 子项目锚点」做基准：`{{flow_root}}` 会展开成绝对路径，
// 一份带十个占位符的提示词在深路径下要多花几百字符——按浅路径量会低估。
const DEEP_ANCHOR = '/Users/someone/Documents/Codes/worktrees/some-repo_main/apps/desktop';

/**
 * ⚠️ 宿主的上限管的是**组装后的整条 `additionalContext`**，不是提示词本身。只量 `renderPrompt()`
 * 会少算几百字符——一份实际会溢出的提示词就这么当成「内联得下」通过，而溢出是静默的。
 *
 * 有**四个**注入点（`grep -rn injectableStagePrompt src`）：`advance-stage` / `session-handler` /
 * `commands/start` / `commands/resume`。它们包的东西不一样，所以这里逐个复刻、取**最大**的那个：
 *
 * - `advance` 框架最短，但它的 `[ai-flow:paths]` 前言由**调用方**在外面拼，而 gated stage 全部经
 *   `approve` 进入——那条路径还要再叠一层命令输出前缀。**approve = 前言 + 命令前缀 + advance 框架**
 *   才是真正的最坏，比只取 `max(advance, session)` 多 155 字符。曾经按后者卡，于是一页写在
 *   9,432–9,586 区间会 CI 全绿、生产退化。
 * - gated stage 再加 `gateProtocolNote()`（约 347）。引擎一度在预算判定**之后**才追加它。
 * - `start` / `resume` 的框架里还含 `requirement` 原文，**长度无上界**。这里按 0 算，所以最紧那一页
 *   的余量必须留得出需求文案的余地——余量 200 就意味着 200 字的需求描述会把它顶出去。
 */
function injectionOverhead(flow: string, gated: boolean): number {
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
  const approve = preamble.length + commandOutputPrefix(flow).length + advance;
  return Math.max(advance, session, approve) + (gated ? ('\n' + gateProtocolNote()).length : 0);
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
      const overhead = injectionOverhead(flow, p.gated);
      const total = rendered.length + overhead;
      if (!known) {
        expect(total, `${p.id} 组装后 ${total} 字符（提示词 ${rendered.length} + 引擎包裹${p.gated ? '含 gate 协议' : ''} ${overhead}）`).toBeLessThanOrEqual(INLINE_INJECTION_BUDGET);
      } else {
        // 欠账项：不卡上限，但必须仍然超限——一旦拆到预算之内，就从 KNOWN_OVERSIZE 里删掉，
        // 这条断言会提醒你去删。
        expect(total, `${p.id} 已降到预算内，请从 KNOWN_OVERSIZE 删除它`).toBeGreaterThan(INLINE_INJECTION_BUDGET);
      }
    });
  }
});

/**
 * 上面那一组是**算术**测试：它在测试文件里复刻一遍 overhead 的算法，然后拿 flow 里的提示词去比。
 * 它抓不到「引擎忘了把某一段的长度传给 `injectableStagePrompt`」——那种漏算里，测试算的和引擎
 * 算的是两回事，而测试永远算对。实测过：把 `advance-stage.ts` 里 `+ gateNote.length` 删掉，
 * 上面 15 个用例连同全仓 557 个用例**全绿**。
 *
 * 所以这一组调**真的** `advanceStage()`，并且**不自己算 overhead**——先用一个已知长度的短提示词
 * 跑一次，从引擎实际输出的长度反推出它的包裹开销，再拿这个开销去卡临界值。引擎少算了什么，反推
 * 出的开销就会跟它自己的判据不一致，临界用例当场变红。
 */
describe('注入预算的行为级回归（调真引擎，不在测试里复算 overhead）', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const c of cleanups) c(); cleanups.length = 0; });

  // BLOCKING_CONFIG 的两个 stage 正好是「work（无 gate）→ review（有 gate）」，
  // 所以 advanceStage 推进进去的那一个带 gate 协议。
  async function advanceIntoGatedStage(promptLen: number): Promise<string> {
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    // 纯 'x' 不含占位符；renderPrompt 仍会无条件追加一段 writtenDocLengthNote()，但它**定长**，
    // 所以被一并算进「反推出的 overhead」里，反推照样精确。⚠️ 哪天那段改成按长度条件追加，
    // 探针与临界值的 note 长度就不同了，反推会静默失真而这两个用例照绿。
    writeFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'review.md'), 'x'.repeat(promptLen));
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 't',
      current_stage: 'work', base_sha: 'abc',
    });
    const out = await advanceStage(repo.repoRoot, 'test-flow', 'sess-1');
    return out.additionalContext;
  }

  const PROBE = 100;

  it('gated stage 落在临界之内 → 注入正文；越过一个字符 → 换成「立刻 Read」兜底', async () => {
    const probe = await advanceIntoGatedStage(PROBE);
    expect(probe, '探针本身不该兜底').toContain('x'.repeat(PROBE));
    // 引擎实际包裹了多少（分隔框 + 收尾指示 + gate 协议），从输出反推
    const overhead = probe.length - PROBE;
    expect(overhead).toBeGreaterThan(400);   // 至少含框架；gated 的还要加 gate 协议

    const atLimit = await advanceIntoGatedStage(INLINE_INJECTION_BUDGET - overhead);
    expect(atLimit, '刚好等于上限 → 仍应原样注入').toContain('xxxxxxxxxx');
    expect(atLimit.length).toBeLessThanOrEqual(INLINE_INJECTION_BUDGET);

    const overLimit = await advanceIntoGatedStage(INLINE_INJECTION_BUDGET - overhead + 1);
    expect(overLimit, '超一个字符 → 必须换成指路兜底').toContain('立刻用 Read');
    expect(overLimit, '兜底时一个字的正文都不许带').not.toContain('xxxxxxxxxx');
  });

  it('callerOverhead 计入判据：调用方额外前置的长度会把临界线往下压', async () => {
    const probe = await advanceIntoGatedStage(PROBE);
    const overhead = probe.length - PROBE;
    const justFits = INLINE_INJECTION_BUDGET - overhead;

    // 同一份提示词，调用方声明自己还要再前置 500 字符（approve 路径真实如此：
    // `[ai-flow:paths]` 前言 + 命令输出前缀）→ 必须从「刚好装得下」翻转成兜底。
    const repo = createFlowTestRepo('test-flow', BLOCKING_CONFIG);
    cleanups.push(repo.cleanup);
    writeFileSync(join(repo.repoRoot, '.ai-flow', 'test-flow', 'stages', 'review.md'), 'x'.repeat(justFits));
    writeActiveState(repo.repoRoot, 'test-flow', {
      flow_id: 'test-flow-abc', flow_name: 'test-flow', requirement: 't',
      current_stage: 'work', base_sha: 'abc',
    });
    const out = await advanceStage(repo.repoRoot, 'test-flow', 'sess-1', 500);
    expect(out.additionalContext).toContain('立刻用 Read');
    expect(out.additionalContext).not.toContain('xxxxxxxxxx');
  });
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

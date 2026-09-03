import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderPrompt, INLINE_INJECTION_BUDGET } from '../src/lib/prompt-render.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOWS_DIR = join(__dirname, '..', '.ai-flow');

/**
 * 把一份 stage 提示词拆成「常驻页 + 若干 references」之后，出现了两类**静默**新风险：
 *
 *  1. 路由表指向一份不存在的文件 —— 模型读不到，行为退回「凭记忆推」，而没有任何东西报错；
 *  2. 一条「违反了不会有东西变红」的红线被顺手搬进 references —— 它从此只在撞到某个岔路时
 *     才被读到，而它要防的正是「没意识到自己踩了」的那种错。
 *
 * 人工 CR 抓得住这两类里的第一次，抓不住此后每一次编辑。这份测试是它们的常设执行方。
 */

type FlowDoc = { flow: string; rel: string; abs: string };

/**
 * 每个 flow 的 stages/ + references/ 下全部 .md，外加 scripts/ 下的 .cjs。
 *
 * 脚本一起扫，是因为它们**在运行时把指路打给模型**（`schedule.cjs` 推荐车道模式时会打印
 * 「去读哪一份」，`gate-*.cjs` 的每条报错文案都带「怎么改」）。提示词拆分后指到一份不存在
 * 的文件，脚本不会因此失败——它照样 exit 0，只是把模型送去一个空地址。
 */
function flowDocs(): FlowDoc[] {
  const out: FlowDoc[] = [];
  for (const flow of readdirSync(FLOWS_DIR)) {
    if (!existsSync(join(FLOWS_DIR, flow, 'config.json'))) continue;
    for (const [sub, ext] of [['stages', '.md'], ['references', '.md'], ['scripts', '.cjs']] as const) {
      const dir = join(FLOWS_DIR, flow, sub);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(ext)) out.push({ flow, rel: `${sub}/${f}`, abs: join(dir, f) });
      }
    }
  }
  return out;
}

/**
 * 流程文档里出现的 `xxx.md` 分两类：flow 自带的 references/stages（必须存在），
 * 和 flow **产出**在项目 docs 目录下的产物（不在本仓库里，无从检查）。
 * 后者逐一列出——列表短、且新增一个产物本来就该是有意识的动作。
 */
const PROJECT_ARTIFACTS = new Set([
  'alignment.md',
  'wayfinder-map.md',
  'spec.md',
  'tickets.md',
  'tickets-archive.md',
  'candidates.md',
  'review.md',
  'plan.md',
  'design.md',
  'architecture.md',
  'tech-design.md',
  'task-reports.md',
  'context-delta.md',
  'research.md',
  'ledger.md',
  'CLAUDE.md',
  'CONTEXT.md',
  'README.md',
  'helper.md', // flow 根目录下，不在 stages/ 或 references/ 里
]);

// 插件自己的 skill 定义。flow 文档提到 `SKILL.md` 时讲的都是同一件事：**用 Skill 工具调，别去
// Read 这个文件**（插件缓存目录并存十几个历史版本，实测有一次读到五天前的旧版并照它已废弃的编排
// 派发），而这条禁令必须点出文件名才说得清。它不进 PROJECT_ARTIFACTS 白名单——那张表的语义是
// 「产物在项目 docs 目录下、本仓无从检查」，而 skills/ 就在本仓、查得到。放白名单等于把一个能真
// 查的断言关掉：skills/comment/ 被改名或移走时，四份 flow 文档里那句指令会指向不存在的位置而测试照绿。
const SKILL_DIRS = join(__dirname, '..', 'skills');

/** 从文档正文里解析出它点名的 skill 目录名（`skill: "ai-flow:comment"` → `comment`）。 */
function skillTargets(text: string): string[] {
  return [...text.matchAll(/ai-flow:([a-z0-9-]+)/g)].map((m) => m[1]!).filter((n) => n !== 'paths');
}

describe('flow 文档之间的指路不能断', () => {
  const docs = flowDocs();

  it('至少扫到了两个 flow 的文档（防止用例空跑成恒绿）', () => {
    expect(new Set(docs.map((d) => d.flow)).size).toBeGreaterThanOrEqual(2);
    expect(docs.length).toBeGreaterThanOrEqual(15);
  });

  for (const doc of flowDocs()) {
    it(`${doc.flow}/${doc.rel} 里提到的每份 flow 文档都真实存在`, () => {
      const text = readFileSync(doc.abs, 'utf-8');
      // 只认反引号里的 .md 名字——正文散句里的「见 xxx」不构成可执行的指路，不在此约束。
      const named = new Set([...text.matchAll(/`([^`\n]*?([A-Za-z0-9._-]+\.md))`/g)].map((m) => m[2]!));
      const dangling: string[] = [];
      for (const name of named) {
        if (PROJECT_ARTIFACTS.has(name)) continue;
        const hit =
          existsSync(join(FLOWS_DIR, doc.flow, 'references', name)) ||
          existsSync(join(FLOWS_DIR, doc.flow, 'stages', name)) ||
          // `SKILL.md` 落在 skills/<name>/ 下，不在任何 flow 目录里——但它在本仓，所以查得了。
          // ⚠️ 必须查**这份文档点名的那个** skill，不能「任意一个 skills/*/ 下有 SKILL.md 就算命中」——
          // 仓里五个 skill 目录**全都**带 SKILL.md，那种写法下把 skills/comment/ 删掉测试照样全绿，
          // 等于这条断言是空操作。所以从正文解析 `ai-flow:<name>` 拿目录名。
          // ⚠️ 精度边界（今天够用、以后可能不够）：解析的是**整份文件**、命中任一即算过。一份文档同时
          // 提到两个 skill 时，删掉其中一个不会变红。要收紧就得按段落配对，那需要先给文档定段落约定。
          skillTargets(text).some((dir) => existsSync(join(SKILL_DIRS, dir, name)));
        if (!hit) dangling.push(name);
      }
      expect(dangling, `${doc.flow}/${doc.rel} 指向了不存在的文件（拼错，或拆分时漏建）`).toEqual([]);
    });
  }
});

/**
 * 四份被拆过的 stage 提示词：原本都超过 10,000 字符的内联上限（1.3×–2.0×），
 * 现在都是「常驻页 + 若干按触发事件分的 references」。
 *
 * 下面三条守的是拆分本身的前提。任何一条破了，拆分就从「省 context」变成「静默丢规则」：
 *  - 路由表点名的 reference 必须真实存在（否则模型读不到，退回凭记忆推）；
 *  - 路由表必须整个落在预览窗口内（这页将来再被写胖到溢出时，路由仍在模型手上）；
 *  - 红线必须留在常驻页（违反它们不会有任何东西变红，搬下去等于藏起来）。
 */
type SplitStage = {
  flow: string;
  stage: string;
  /** 路由表必须点名、且必须真实存在的 references */
  routed: string[];
  /** 必须留在常驻页正文里的红线：违反时没有任何脚本 / 测试 / 退出码会报 */
  resident: Array<[string, RegExp]>;
};

const SPLIT_STAGES: SplitStage[] = [
  {
    flow: 'grill-flow',
    stage: 'stage-3.md',
    routed: [
      'execution-unit.md', 'lane-mode.md', 'subagent-lifecycle.md',
      'reentry.md', 'recovery.md', 'mid-flight-ticket.md',
      'per-ticket-review.md', 'quality-chain.md', 'revision-protocol.md',
    ],
    resident: [
      // `## 入场` 的 Step 0 三条预检。它们完全符合本字段的定义却一直没被钉住：`worktree.cjs` 从主仓
      // `git branch --show-current` 取需求分支名（脚本注释里写着），但**从不检查**它是不是 main；
      // `gate-stage-3.cjs` 的机器门⑤ 确实查残留 worktree，但那是 stage-3 的**出口**、且只按当前
      // `<flow_id>-` 前缀收窄（`gate-stage-3.cjs` 的「⑤ worktree 已收口」段），入场那一刻和别的
      // flow 留下的树都不在它视野里；`start.ts` 也没有分支检查。
      // 在 main 上开工的后果是每张票逐个从 main 开出再 ff-merge 回 main，不可逆——而搬走它们
      // （或把「停」改写成建议）不会让任何脚本、测试或退出码变红。
      ['Step 0 预检①：在 main/master 上不许开工', /`git branch --show-current` — 在 main\/master → 停/],
      ['Step 0 预检②：工作树有代码改动就停下问开发者', /`git status --porcelain` — 含代码改动 → 停问开发者/],
      ['Step 0 预检③：残留 worktree 先收口，别新开', /`git worktree list` — 有 `wt\/<flow_id>-` 分支的条目 → 上一轮残留/],
      ['记账顺序：rm:pending 必须在 qc:done 之前', /`rm:pending`\s*必须排在\s*`qc:done`\s*之前/],
      ['batch: 必须写在票行内或其缩进子项', /写在该票那条行内或其缩进子项/],
      ['车道模式派发前要落的是 wip: 而不是 lane:', /派发前真正要落的是\s*`wip: R<n>`/],
      ['close 必须单独成一条命令', /`close`\s*必须单独成一条命令/],
      // 一票走两段，首行判据按角色分两套。两套都必须常驻——判错了就是「这一票没交付」被读成交付。
      ['实施代理的首行判据 impl-done:', /首行必须是\s*`impl-done: <N> 个文件已改，未提交`/],
      ['质量链代理的首行判据 commit: <sha>', /首行必须是\s*`commit: <sha>`/],
      ['一票派两次，不是一次', /一票派两次，不是一次/],
      // 作用域是刻意限定的：子代理不能被唤醒，丢后台只能烧回合空等（实测 422 个空转回合）；
      // 而主 session 会被后台命令唤醒，它必须能丢后台，否则腾不出手做 15 分钟扫描。
      //
      // ⚠️ 这条红线的内容换过一次。原文是「子代理往下派孙代理必须同步（run_in_background: false）」，
      // 而那个参数在「子代理派孙代理」这一层根本不生效——实测有过对照：显式传 false，工具结果仍是
      // 「Async agent launched successfully… working in the background」，该参数也不在 Agent 工具的
      // schema 里。要求一个不存在的开关，实测被违反 9 次（每次约 90K token + 5–6 分钟空转）。
      // 所以红线改成「不许往下派」——同步既然拿不到，唯一可执行的形态就是自己顺序做完。
      ['子代理不许再往下派孙代理', /不许再往下派孙代理/],
      ['主 session 自己派子代理可以丢后台', /你自己派子代理反而可以丢后台/],
      ['票面整段内联，不给 tickets.md 路径', /票面整段内联，不给\s*`tickets\.md`\s*路径/],
      // 两段的复核判据方向相反：实施交付后树必须脏，质量链交付后必须干净。
      // 用错方向会永远判成「它还没停」，质量链永远派不出去——而这不报任何错。
      ['实施交付后复核树非空', /复核\s*`git -C <WT> status --porcelain`\s*\*{0,2}非空/],
      ['质量链交付后复核树为空且 HEAD 对得上', /复核树\*{0,2}为空\*{0,2}、`HEAD` 等于那个 sha/],
      ['别把两套复核用混', /别把两套用混/],
      ['<WT> 与 <WT_ROOT> 两个都要带进 dispatch prompt', /`<WT_ROOT>`/],
      ['不为「只跑验证」派子代理', /不为「只跑验证」派子代理/],
      ['不给子代理下整仓全量的地板要求', /不给子代理下「整仓全量」的地板要求/],
      ['通知是一次性的 → 每 15 分钟主动扫 status', /通知是一次性的[\s\S]{0,400}worktree\.cjs status/],
    ],
  },
  {
    flow: 'feat-flow',
    stage: 'stage-3.md',
    routed: ['plan-task-format.md', 'plan-decisions.md', 'plan-review.md', 'revision-protocol.md'],
    resident: [
      ['禁止 git commit', /禁止 git commit/],
      ['files 用符号锚点、禁止行号', /符号锚点[\s\S]{0,40}禁止行号/],
      ['decisions 必须带可回溯的 ⟵ 来源', /必须带可回溯的\s*`⟵ 来源`/],
      ['有分歧先落盘再开口', /先落盘再开口/],
      ['本 stage 无引擎 Gate，别提示 approve', /别提示开发者 approve/],
      ['重入时不重跑 review', /不重跑 review/],
    ],
  },
  {
    flow: 'feat-flow',
    stage: 'stage-4.md',
    routed: ['dispatch-unit.md', 'subagent-lifecycle.md', 'task-report-and-review.md', 'stage-4-exceptions.md', 'revision-protocol.md', 'adr-scan.md'],
    resident: [
      // 宿主对「干完了」和「停下了」发同一种 completed 通知，正文才是差别、且很容易被读成相反的意思。
      // 判错的后果落在同一棵主工作树上（feat-flow 不做工作树隔离），而没有任何机器门会拦。
      ['完成通知不等于子代理已停', /完成通知不等于子代理已停/],
      ['首行机械判据 impl-done: <commit sha>', /首行必须是\s*`impl-done: <commit sha>`/],
      ['钉死串行，绝不并行 dispatch 实施子代理', /绝不并行 dispatch 实施子代理/],
      ['dispatch = 机械拼装，不补 plan 没给的信息', /不补 plan 没给的信息/],
      ['抑制 SDD：不建 worktree', /不建 worktree/],
      ['抑制 SDD：不调 finishing-a-development-branch', /不调用 `finishing-a-development-branch`/],
      ['抑制 SDD：不跑整体 final reviewer', /不跑 SDD 的「整体 final reviewer」/],
      ['连续执行不等于省略调度动作', /不等于\*{0,2}省略每 task 之间的落盘/],
      ['主 session 禁止直接写代码', /禁止主 session 直接写代码/],
    ],
  },
  {
    flow: 'feat-flow',
    stage: 'stage-5.md',
    routed: ['assembly-review.md', 'review-md.md', 'final-review-and-squash.md', 'stage-5-reentry.md', 'adr-scan.md', 'revision-protocol.md'],
    resident: [
      // 空清单天然满足完成条件，于是全流程唯一的真机验证落点被整段跳过——而 stage-6 那行
      // 「建议人工测试」出现时代码已经 squash 完、flow 即将结束。
      ['真机验证清单没收口不许 squash', /真机验证清单没收口，不许 squash/],
      ['环节 C 入场顺序不能反：先写范围再 reset', /先\s*`git diff --name-only <base>\.\.HEAD`\s*把范围\*{0,2}写进 review\.md/],
      ['git add -A 之前先核范围', /`git add -A`\s*之前先核范围/],
      ['reset 之后必须用 --staged，不用 <base>..HEAD', /`git diff --staged <base>`[\s\S]{0,40}不用\s*`<base>\.\.HEAD`/],
      ['每轮处理后立即写 review.md', /每轮处理后立即写 review\.md/],
      ['安全视角强制不可跳过', /视角② 安全专项强制，不可跳过/],
      ['环节 C 走完前绝不写 signal', /本环节走完前绝不写 signal/],
      ['禁止改测试断言让它通过而不解释', /绝对禁止.{0,60}让测试「通过」而不解释/],
    ],
  },
];

// 与 stage-prompt-budget.test.ts 用同一个深锚点：占位符展开后才是模型真正看到的长度。
const DEEP_ANCHOR = '/Users/someone/Documents/Codes/worktrees/some-repo_main/apps/desktop';
/** 宿主超过内联上限时只回注约这么多字符的预览。路由表必须整个落在里面。 */
const PREVIEW_WINDOW = 2_000;

for (const sp of SPLIT_STAGES) {
  describe(`${sp.flow}/${sp.stage} 拆分后的前提`, () => {
    const path = join(FLOWS_DIR, sp.flow, 'stages', sp.stage);
    const raw = () => readFileSync(path, 'utf-8');
    const rendered = () => renderPrompt(raw(), DEEP_ANCHOR, sp.flow);

    it('拆出去的 references 都被路由表点名，且都存在', () => {
      const text = raw();
      for (const name of sp.routed) {
        expect(text.includes(`\`${name}\``), `路由表没有点名 ${name}，撞上它对应的岔路时无从知道该读哪份`).toBe(true);
        expect(existsSync(join(FLOWS_DIR, sp.flow, 'references', name)), name).toBe(true);
      }
    });

    it(`路由表整个落在渲染后的前 ${PREVIEW_WINDOW} 字符内`, () => {
      const r = rendered();
      const at = sp.routed.map((n) => r.indexOf(`\`${n}\``));
      expect(Math.min(...at), '有 reference 没被点名').toBeGreaterThan(0);
      expect(Math.max(...at), `路由表末尾落在第 ${Math.max(...at)} 字符，超出预览窗口`).toBeLessThan(PREVIEW_WINDOW);
    });

    for (const [label, re] of sp.resident) {
      it(`常驻红线仍在正文里：${label}`, () => {
        // 去掉 markdown 强调符再匹配——加粗/去粗不该让守卫失效。
        const flat = raw().replace(/\*\*/g, '');
        expect(re.test(flat), '这条红线不在常驻页上了。它违反时不会有任何东西变红，不能搬进 references。').toBe(true);
      });
    }

    it('拆分后仍在内联预算之内', () => {
      expect(rendered().length).toBeLessThanOrEqual(INLINE_INJECTION_BUDGET);
    });
  });
}

/**
 * references 里的 `{{flow_root}}` / `{{project_root}}` 永远不会被展开。
 *
 * `renderPrompt` 只跑在 `stages/*.md` 上（start / resume / advance-stage /
 * session-handler 四个调用点全是 `readFileSync(promptPath)`）。references 是模型自己
 * Read 进来的，占位符原样到手。
 *
 * 为什么这值得一道机器门：`sh` 里代入失败会报错，**Write 不会**——它会在仓库根下建出一个
 * 字面名为 `{{flow_root}}` 的目录，文件落在那里等于没写，而引擎不推进也不报错。
 * `grill-flow/stages/stage-3.md` 已经为它的 `<FR>` 简写写过这条警告，但那是 stage 提示词；
 * references 层一度没有任何东西守着，其中 `assembly-review.md` 恰好带着一条
 * 「重写 `{{flow_root}}/state/mark-base`」的指令。
 *
 * 判据不是「不许出现占位符」（讲路径就得写出来），而是「声明必须出现在首次使用之前」。
 *
 * ⚠️ **范围只有 `references/`，这是刻意的**：`helper.md` 与 `scripts/*.cjs` 里也出现这两个
 * 占位符，但那些地方是在**讲这个替换机制本身**（「stage 提示词里的路径用注入的绝对
 * `{{project_root}}` 锚定」），不是「照它写一个文件」的指令——要求它们声明「本文件的占位符
 * 不会展开」会和它们正在解释的事情自相矛盾。references 才是模型照着执行动作的地方。
 */
describe('references 里的占位符必须带声明，且声明在首次使用之前', () => {
  const PLACEHOLDER = /\{\{\s*(?:flow_root|project_root)\s*\}\}/;
  /**
   * 只认「明说花括号形式不会被展开」这一种写法。
   *
   * ⛔ 不能放宽成 `换成.*绝对路径` 这类泛用措辞——「绝对路径」是这批文档的高频说法，
   * 那样会让没有真声明的文件免检。
   *
   * ⛔ 也不能认「…`{{flow_root}}` 展开出来的就是它」这种句式。它读起来像声明，其实是
   * **尖括号简写的约定句**（「`<flow_root>` = 本文件所在目录的上一级；stage-3 提示词里
   * `{{flow_root}}` 展开出来的就是它」），说的是那个简写指向哪里，**没有**说本文件里的
   * 花括号不会被展开。更麻烦的是这句话自身含占位符，于是「声明行 ≤ 首次使用行」对它恒真
   * ——三份 reference（execution-unit / lane-mode / reentry）因此拿到永久豁免，往里加一条
   * 真的 `{{flow_root}}/state/…` 写盘指令，这道门照绿。实测过，所以它由 CONVENTION 单独识别。
   */
  const DECLARES = /没展开|不会被展开/;
  /** 尖括号简写的约定句：提到占位符只是为了说明简写指向哪里，不构成「会照字面用它」。 */
  const CONVENTION = /`<(?:flow_root|project_root)>`[^\n]*本文件所在目录的上一级/;

  const refs = flowDocs().filter((d) => d.rel.startsWith('references/') && d.rel.endsWith('.md'));

  it('扫到了两个 flow 的全部 reference（防止过滤器退化成只扫一个 flow）', () => {
    expect(refs.length).toBeGreaterThanOrEqual(25);
    for (const flow of ['feat-flow', 'grill-flow']) {
      expect(refs.some((d) => d.flow === flow), `${flow} 的 references 一份都没扫到`).toBe(true);
    }
  });

  for (const doc of refs) {
    const text = readFileSync(doc.abs, 'utf-8');
    if (!PLACEHOLDER.test(text)) continue;
    it(`${doc.flow}/${doc.rel} 的占位符声明出现在首次使用之前`, () => {
      const lines = text.split('\n');
      // 约定句与声明句本身不算「使用」——它们提到占位符是为了解释它，不是照字面写它。
      const uses = lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => PLACEHOLDER.test(l) && !CONVENTION.test(l) && !DECLARES.test(l));
      if (uses.length === 0) return; // 通篇只在解释机制，没有会被照字面执行的指令
      const declaredAt = lines.findIndex((l) => DECLARES.test(l));
      const firstUse = uses[0]!.i;
      expect(
        declaredAt >= 0 && declaredAt <= firstUse,
        declaredAt < 0
          ? '这份 reference 里写了 {{flow_root}} / {{project_root}}，但通篇没说明它们不会被引擎展开。' +
              '模型照字面 Write 会建出一个字面名的目录，落盘等于没写，且不报错。'
          : `声明在第 ${declaredAt + 1} 行，而首次使用在第 ${firstUse + 1} 行——声明必须排在前面，` +
              '否则模型可能在读到声明之前就照字面用了它。',
      ).toBe(true);
    });
  }
});

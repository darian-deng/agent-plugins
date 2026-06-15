# ai-flow 任意目录安装 — 设计文档

> 状态:已对齐,待实现
> 范围:ai-flow plugin(`plugins/ai-flow/`)
> 目标:让 ai-flow 支持在 monorepo 子项目里安装/运行 flow,且无 cwd 漂移导致的归属/路径 bug;同时把安装体验脚本化、把工具链统一到 Node。

---

## 1. 背景与问题

最初为了避免「agent 运行中 `cd` 到子目录后找不到根目录产物」,采取一刀切:只在根目录创建 flow、文档只沉淀在根目录。发布后 monorepo 用户反馈:他们日常在子 repo 工作,希望能在子 repo 里装、在子 repo 里跑 flow。

### 接地结论(推翻问题前提)

引擎**当前并不强制 git 根目录**,它锚定的是「最近的 `.ai-flow` 目录」:

- `findRepoRoot(cwd)` / `hasActiveFlow(cwd)` 从 cwd 向上找第一个含 `.ai-flow` 的目录,返回它作为 `repoRoot`(`src/lib/state.ts:73-100`),注释明确写 `monorepo-safe`。
- 所有产物相对该 `repoRoot` 拼绝对路径:flow 定义 `flow-config-loader.ts:27`、state `state.ts:47-53`、docs 快照 `abort.ts:47`。
- install 落点 = 运行命令时的 cwd(`skills/add/SKILL.md` 用相对 `.ai-flow/{name}`)。

也就是说「在子 repo 装」今天就能走通(`cd packages/foo && /ai-flow:add`),没有代码拦它。真正的约束与风险在别处 ↓

### 真正的风险:cwd 漂移后 flow 归属靠现场 walk-up 重算

每个 hook 触发时只拿到 `(cwd, session_id)`,靠 `hasActiveFlow(cwd)` 现场向上找最近 `.ai-flow` 决定归属;`last_session_id` 只用于互斥锁(`userprompt-handler.ts:59`),**无 session→flow 反向绑定**。

- 锚点在 git 根(现状):cwd 只会往**下**漂,walk-up 仍能找回根 → 现有 cwd 守卫(`pretool-handler.ts:77/124`)够用。
- 锚点下沉到 `packages/foo`(新特性):agent `cd /repo`(锚点**上方**)后,`hasActiveFlow(/repo)` 找不到 foo 的 flow——
  - 若根也有 active flow → 归属落到**错误的根 flow**(signal/gate/active.json 全错)。
  - 若根只有 `.ai-flow` 目录无 active(或没有)→ 返回 null,守卫全关,signal 相对路径写到错误位置,stage 永久卡住。

> 结论:**下沉安装会激活一个隐藏 bug,前置必修「session→锚点绑定」**。不做绑定不能开放子 repo 安装。

---

## 2. 已对齐的决策

| # | 决策 | 结论 |
|---|------|------|
| D1 | 锚点层级 | **项目根**(非 git root、非任意深目录)。项目根 = 含项目标记文件 或 git root 兜底 |
| D2 | 项目标记探测集 | **多语言通用集**:`package.json` / `pyproject.toml` / `go.mod` / `Cargo.toml` / `pom.xml` + workspace 成员 + git root 兜底 |
| D3 | install 落点 | cwd 是项目根→装这儿;cwd 在项目内非根→给「最近项目根 vs git 根」二选(默认前者);裸目录→退 git 根 |
| D4 | 嵌套 `.ai-flow` | install 时**主动检测外层 `.ai-flow` 并警告**(子 repo 会就近屏蔽外层 flow,这是正确的项目隔离语义) |
| D5 | cwd 限制 | **放开 cd**。靠「session→锚点绑定 + 提示词绝对路径」保证不翻车,守卫从硬禁 cd 降级为控制面保护 |
| D6 | 绑定存储 | **一份记录**:per-session 小文件 `~/.claude/ai-flow/sessions/<session_id>.json`。不在 active.json 加 flow_root(冗余:锚点 = active.json 自身所在位置) |
| D7 | 工具链 | **全 Node 化**,一次做完:去 sh、去 python,统一到已硬依赖的 Node |
| D8 | add 体验 | 非交互 node 脚本(`--list`/`--install`)+ LLM 的 AskUserQuestion 多选;装完跑 preflight + 打印用法 |
| D9 | 依赖声明 | Node≥18 是唯一普适前置(文档 + add 入口早检);git 按 flow 在 preflight 声明 |

### 命名约定(避免碰撞)

现有代码已在 `[ai-flow:paths]` preamble 注入两个变量,沿用,不造新词:
- `project_root` = 锚点 = `.ai-flow` 所在目录(= 我们讨论的「flow_root/session_cwd」)。
- `flow_root` = `<project_root>/.ai-flow/<flowName>`(flow 定义目录)。

提示词里要"钉死的绝对路径"用 **`project_root`**。

---

## 3. 为什么绑定只需一份记录

`flow_root`(锚点)恒等于 active.json 自身位置:`<锚点>/.ai-flow/<flow>/state/active.json` 上溯 4 层即锚点。往 active.json 里塞 flow_root 字段是冗余,且对"cwd 漂移后找不到 active.json"这个真问题毫无帮助。

打破循环依赖的唯一办法是一个 **cwd 无关、仅凭 session_id 可定位**的索引。active.json 在 repo 内、地址依赖锚点,不满足;`~/.claude/ai-flow/sessions/<session_id>.json` 满足。

**per-session 一个小文件**(而非单个大 JSON)的理由:

| 顾虑 | 单大 JSON | per-session 小文件 |
|------|-----------|--------------------|
| 无限膨胀 | 死 session 堆积 | 每 session 一个固定文件(覆盖写),GC 删死的 → 体量 ≈ 并发活 session 数 |
| 解析失败兜底 | 一坏全瘫 | 只坏自己,忽略 + 退回 walk-up;读失败一律 catch,**hook 绝不抛错** |
| 并发写冲突 | 多 session 抢同一文件 | 各写各的,零竞争;temp+rename 保原子 |

---

## 4. 工作流分解与实现地图

### WS1 — 引擎:session→锚点绑定 + 解析重构(前置·核心)

**新增 `src/lib/session-registry.ts`:**
- `registryDir()` → `join(homedir(), '.claude', 'ai-flow', 'sessions')`
- `bindSession(sessionId, projectRoot, flowName)`:写 `<dir>/<sessionId>.json = { projectRoot, flowName, boundAt }`,temp+rename 原子写(参考 `state.ts:68-70`)
- `lookupSession(sessionId)`:读并 JSON.parse,失败→null(catch)
- `unbindSession(sessionId)`:删文件,catch 忽略
- `gcRegistry()`:遍历目录,逐文件 try/catch 校验并删除失效项——① projectRoot 不存在;② `<projectRoot>/.ai-flow/<flowName>/state/active.json` 不存在;③ 该 active.json 的 `last_session_id !== 文件名 sessionId`(flow 已被接管/结束)

**新增解析入口 `resolveActiveFlow(cwd, sessionId)`(放 state.ts 或 registry):**
1. `lookupSession(sessionId)` 命中 → 用 `{ flowName, repoRoot: projectRoot }` 读 active.json,校验 `last_session_id === sessionId || null`,返回 `{ flowName, state, repoRoot }`
2. 未命中 → 回退 `hasActiveFlow(cwd)`(walk-up,保持向后兼容)

**改 5 个调用点**(都已有 session_id):
- `pretool-handler.ts:38`、`posttool-handler.ts:28`、`session-handler.ts:24`、`userprompt-handler.ts:52`、`session-end-handler.ts` → `hasActiveFlow(cwd)` 改 `resolveActiveFlow(cwd, session_id)`

**绑定写入点:**
- `commands/start.ts:108` 写 active.json 后 → `bindSession(sessionId, repoRoot, flowName)`
- `session-handler.ts`:解析成功后**回填**(覆盖)`bindSession`——兼容存量 flow + 抗 session 切换
- `session-end-handler.ts`:`unbindSession(sessionId)` + 顺手 `gcRegistry()`

**守卫降级(`pretool-handler.ts:67-87 / 117-134`):**
- 删除「cwd≠repoRoot 即 deny 所有 Bash」的硬禁
- 保留控制面保护(signal/active.json/scripts 的绝对路径拦截:`pretool-handler.ts:59-65`)
- 保留**相对路径写控制面文件时的 drift 警告**作为安全网(不再 blanket deny)

**附带修复**:`posttool-handler.ts:90` / `start.ts:49` 把 `repoRoot` 当 `contextPct` 的 cwd 传——transcript 路径应基于真实 session 项目目录,子 repo 锚点下会错。改为传 hook 输入的 `cwd`(或正确的 transcript 基准),并加注释。

### WS2 — 提示词绝对路径化

- 引擎在注入 stage 提示词时(`session-handler.ts:163`、`advance-stage` 读 prompt 处、`start.ts:114`)做占位符替换:`{{project_root}}` → 真实绝对锚点。
- feat-flow stage 提示词把内部相对路径(如 `.ai-flow/feat-flow/state/signal`、`docs/feat-flows/...`)改为 `{{project_root}}/...`。**走 `/ai-flow:update`**。
- `create` SKILL 文档化该约定:用户自建 flow 的提示词应使用 `{{project_root}}` 锚定路径。
- 安全网:engine 的 signal 检测已对相对路径用 repoRoot 解析(`posttool-handler.ts:37`),绝对路径化后实际写入位置与引擎预期一致,signal 不再丢。

### WS3 — install:项目根探测 + 落点确认 + 嵌套警告 + add 脚本化

**新增 node CLI(随 esbuild 打包到 `dist/`),子命令:**
- `--list`:读 plugin 内置 `.ai-flow/*/config.json`,输出 flow 名 + 描述(机器可读)
- `--install <names>`:对每个 flow——
  1. **前置检测**:目标目录是否项目根(D2 标记集探测;非根则报候选);`.ai-flow/<name>` 是否已存在(已装跳过/提示);**外层是否已有 `.ai-flow`(D4 警告)**
  2. 复制模板 + chmod
  3. 追加 `.gitignore`(`.ai-flow/*/state/`)
  4. 跑该 flow 的 preflight(fail-fast)
  5. 打印「如何启动」用法
- 全部返回结构化结果,确定性、可测

**瘦身 `skills/add/SKILL.md`:**
- Step 1:LLM 跑 `node --version` 早检(无 node 给清晰提示)
- Step 2:调 `--list` → 用 **AskUserQuestion(multiSelect)** 让用户选
- Step 3:调 `--install <选择>` → 展示脚本输出

> 注:交互式 TUI 经 skill/Bash 工具**不能**渲染(Bash 非交互捕获 stdout)。选择交互必须走 LLM 的 AskUserQuestion;脚本保持非交互。

### WS4 — 全 Node 化

- `preflight.sh` → `preflight.js`(node):工具检查、skill/plugin 检查全部用 node fs/child_process 重写
- `script-executor.ts:19`:`spawnSync('sh', ['-c', command])` → 改为执行 node 脚本(约定 flow 的 completion.script / preflight 为 `.js`,用 `process.execPath` 跑)
- feat-flow stage-4/5/6 的 `python3 -c`(读写 active.json 的 `base_sha_code` + 调 git):
  - `base_sha_code` 读写**收回引擎**(它已管 active.json),stage 不再手搓
  - 相关 git 调用走引擎(有 try/catch),消除 stage-4 那段无容错的 `subprocess.check_output(['git',...])`
- 结果:甩掉 sh + python 依赖,工具链只剩 Node → 真 Windows 支持(无需 Git Bash)

### WS5 — 依赖文档化 + 版本号 + 测试

- README + `marketplace.json` description:声明 **Node≥18 是唯一普适前置**;git 按 flow 在 preflight 声明
- add 入口早检 node(见 WS3 Step 1)
- 单测:registry 的 GC / 解析失败兜底 / drift 后 resolveActiveFlow 命中 / 嵌套屏蔽;项目根探测
- 版本号 bump:`package.json` + `.claude-plugin/plugin.json` 两处(提交前 `git diff` 确认)

---

## 5. 依赖矩阵(接地)

| 依赖 | 层级 | 必需性 | 说明 |
|------|------|--------|------|
| Node.js ≥18 | 引擎核心 | **硬** | 5 个 hook 全是 `node dist/hooks/*.js`(`hooks/hooks.json`)。唯一普适前置 |
| sh | 引擎核心 | 现状硬 → **WS4 后移除** | `script-executor.ts:19`。Node 化后不再需要 |
| git | 按 flow | feat-flow 硬 / 引擎可容忍 | 引擎 `start.ts:18-32` try-catch 兜底;feat-flow preflight 硬检 |
| python3 | feat-flow | 现状隐性硬 → **WS4 后移除** | 仅 stage-4/5/6 读写 base_sha_code,收回引擎 |

---

## 6. 验收标准

1. 子目录 `packages/foo` 跑 `/ai-flow:add` → `.ai-flow` 落 foo;flow start 后在 foo 里 Bash/Write 正常
2. `packages/foo/src` 跑 install → 提示「装 foo 还是 git 根」,默认 foo
3. 根已有 `.ai-flow`,子 repo 再装 → 警告「将屏蔽根 flow」并需确认
4. **flow 在 foo 运行,agent `cd /repo`(根)后**:引擎仍正确归属到 foo 的 flow,signal/gate/docs 不落到根 → 通过 session 绑定保证
5. 锚点在子 repo 时:`base_sha`/`git diff` 仍覆盖全 repo(git 靠 `.git` 上溯),`docs/` 落 foo 内
6. 裸目录(无项目标记、非 git 仓)install → 退 git 根并提示;无 git 则提示
7. 删除/损坏 `~/.claude/ai-flow/sessions/<id>.json` → 不崩,退回 walk-up;非正常退出的死项被下次 GC 回收
8. 无 Node → add 入口给出清晰「请装 Node≥18」提示(而非神秘 hook 报错)
9. Windows(无 Git Bash)下 hook/preflight 正常(全 Node 后)

---

## 6.5 实现记录(滚动更新)

- **WS1 ✅**:`session-registry.ts`(per-session 小文件绑定 + GC + 解析兜底,目录尊重 `CLAUDE_CONFIG_DIR`)、`state.ts` 的 `resolveActiveFlow`/`gcRegistry`、5 handler 改解析、start/SessionStart 绑定回填、SessionEnd 解绑。测试隔离 `tests/setup.ts`。
- **WS2 ✅(经选项 1)**:`prompt-render.ts` 的 `renderPrompt`(`{{project_root}}`/`{{flow_root}}` 占位替换)+ `buildAiFlowPreamble`(统一 `[ai-flow:paths]`,含注入 `base_sha_code`)。
  - **base_sha_code 改由引擎管理**(原 WS4 内容,提前以解开 cd 耦合):stage 写 `{{flow_root}}/state/mark-base` marker → PostToolUse 捕获 `git rev-parse HEAD`(在 repoRoot,cd 无关)写入 active.json,已存在则不覆写;stage-4/5/6 不再 python 读写 active.json,改读引擎注入的 `base_sha_code`。
  - stage 提示词:signal(6)、references(15)、stage-4 `git add`/`touch` docs 绝对化;helper.md 同步。
  - **守卫降级**:移除 Bash 的 cwd≠repoRoot 硬禁(放开 cd),保留控制面(signal/active.json/scripts)拦截;Write 守卫保留并改措辞(相对写漂移→提示用绝对路径)。
- **遗留(WS4 时清理)**:stage-4 Step 1 仍可能因 docs commit 用 `git add {{project_root}}/docs/...`——已绝对化,cd 安全。python 依赖已从 base_sha_code 路径消除;其余 python(若有)与 sh、preflight 的 Node 化留 WS4。
- **WS3 ✅**:新增 `src/cli/add.ts`(node CLI,自身定位 pluginRoot,免 python/$CLAUDE_PLUGIN_ROOT)——`list`(内置 flow JSON)、`detect`(项目根候选 + gitRoot + recommended + 嵌套 `outerAiFlow` + existingFlows)、`install --flow --dir [--force]`(复制 + chmod + .gitignore + 跑 preflight + 打印用法 + 已装拒绝 + 嵌套屏蔽警告)。加入 esbuild `build`/`build:local`(输出 `dist/cli`)。重写 `skills/add/SKILL.md`(经 skill-surgeon 整体重构):node≥18 早检 → node 读 installed_plugins 定位 CLI(去 python)→ `list` + AskUserQuestion 多选 flow → `detect` + AskUserQuestion 选锚点(讲清嵌套屏蔽)→ 逐个 `install`。CLI 的 preflight 优先跑 `preflight.js`(WS4 就绪),回退 `preflight.sh`。测试 `tests/cli-add.test.ts`。

- **WS4 ✅(全 Node 化)**:`preflight.sh` → `preflight.cjs`(纯 node builtin、`.cjs` 避开 ESM/CJS 歧义、尊重 `CLAUDE_CONFIG_DIR`,跨平台);新增 `src/lib/preflight.ts` 的 `findPreflightCommand`(优先 `.cjs`/`.mjs`,回退 `.sh`);`start.ts` 改用它;`script-executor` 由 `spawnSync('sh',['-c',...])` 改 `spawnSync(command,{shell:true})`(平台 shell,Windows 用 cmd);CLI `runPreflight` 优先 `.cjs`/`.mjs`;`skill-structure.test` 更新为 node preflight。feat-flow 运行时**零 python、零自带 .sh**。引擎层(hooks/CLI/preflight/executor)纯 node → 真跨平台;feat-flow 仍声明依赖 git(per-flow,preflight 检查),stage bash 块里的 git/touch 由 AI 执行。

- **收尾 ✅**:① stage 的 docs **读取/写入** 路径全部绝对化(`{{project_root}}/docs/feat-flows/...`),仅 commit body / prose / 报告文本保留相对——读写不再因 cwd 漂移翻车;② `create` / `update` 两个 meta-skill 的 preflight 指引从 `.sh` 改为 Node(`preflight.cjs`),指向 feat-flow/preflight.cjs 作范例 + node 检查块模板(走 skill-surgeon Safe Edit)。`.sh` 仅作未迁移旧 flow 的兼容回退保留。
- **仍遗留(影响极小)**:feat-flow stage bash 块里的 `touch`(unix-ism),Windows 下靠 Claude Code 的 Bash 工具 + AI 适配;非引擎层、不影响核心能力。

## 7. 实施顺序

WS1(前置·地基,可独立验证,不影响现有 git 根场景)→ WS2/WS4(提示词与工具链,走 `/ai-flow:update` 改 stage)→ WS3(install 体验)→ WS5(文档/测试/版本)。

每步 `npm run typecheck` + `npm test`;不提交,提交时机由开发者定。

# mattpocock skills 对 feat-flow 的逐项适用性评审

这是逐项方法评审，不是全部安装清单。39 项已完成上游逐文件初审；本轮按完整 grilling、单 Linear、串行实施、扁平命令和冷读要求修订取舍。用户已选择外部分发及每 run 实际技能内容快照，并单独授予来源可核对且无本地修改的选定依赖有限自动更新许可。本插件尚未实施。

## 来源与判断口径

固定上游版本：`5863806dd4e15c63174bee4e7515a4256792ecfa`。
来源：[完整固定版本源码树](https://github.com/mattpocock/skills/tree/5863806dd4e15c63174bee4e7515a4256792ecfa)。
2026-11-17T11:59:00Z 用 GitHub API 复核 HEAD，仍为同一 SHA；无需重审未变化的 39 份内容。此处固定的是实际审过的版本，不承诺运行时自动追随上游。
初审读取全部 39 个 SKILL.md，关键引用和副作用见 independent audit receipt retained in the private bootstrap index。
主代理另直接核对 grill-with-docs、wizard、omp skill 调用语义及现有知识维护协议。

27 个正式发布 skills（20 engineering、7 productivity），另有 4 个冻结 misc、8 个 in-progress。
MIT 许可；package.json 为 private:true，不能假设有可直接 npm 安装的已发布包。

这里的“适配”必须公开说明改变了什么，不把改写后的行为冒称为上游原生行为。
“可复用方法”不等于“每个需求必跑一步”。不按需求小中大分档，不用技能数量证明流程完整。

## Engineering：20 个正式 skills

| Skill | 原始职责 | 本流程取舍与原因 |
|---|---|---|
| ask-matt | 帮用户选择 skills 和流程路径 | 不作为运行时入口；借它的取舍问题。阶段由程序管理，开发者无需记住技能索引。 |
| code-review | Standards 与 Spec 两轴独立代码审查 | 复用审查分工与证据要求；适配 Linear、固定比较基线与既有项目规范；结果绑定代码/知识修订。不同轴负责不同错误，避免堆重复审查者。 |
| codebase-design | 深模块、接口、seam 等设计词汇 | 按需要加载设计参考，不新增固定 stage，不为“有设计”强造抽象。 |
| diagnosing-bugs | 构建可证伪反馈环后诊断 bug | 实施期确有异常/失败时选用，原始复现、假设、单变量验证纪律可复用；不是新需求入口的固定步骤。 |
| domain-modeling | 澄清术语，边讨论边写 glossary/ADR | 不直接自动写长期文件；必要时借术语/决策澄清方法，候选交统一知识治理与人工门。避免另建一套 glossary 或绕过知识批准。 |
| grill-with-docs | 仅组合 grilling + domain-modeling | 不作为默认入口；用户不接受强推文档体系，本体没有额外编排能力。 |
| implement | 按票/spec 做 TDD、检查、review，末尾 commit | 不直接作为运行时依赖；实施纪律可参考，不能引入第二个调度器、隐含提交或重复质量链。 |
| implement-spec | 自带 integration branch、并行 worktree、merge、PR 与关票编排 | 不直接调用；用户已选串行实施、单需求单与单 PR。仅参考依赖拆分，不继承其并行写手、分支归并与发布动作。 |
| improve-codebase-architecture | 探索并展示架构改善候选 | 不纳入每次需求收尾；仅当需求本身是架构改善时作为可选方法。报告展示形式可参考，不因此做全仓巡检。 |
| pr | Summary / Evidence / Merge Danger 正文规范 | 可复用正文方法；实际 push/建 PR/Linear 回写归幂等交付动作。不能把该模板当作已有建 PR 程序。 |
| prototype | 用一次性原型回答设计问题，另有原型提交约定 | 有真实未知、运行原型能减少风险时可选；在隔离目录中做，受批准范围约束；不默认创建额外 PR 或遗留原型分支。 |
| research | 新上下文代理查一手来源并留引用 | 有事实未知时可选；提供明确问题和证据产物。不能让调研代替用户决策，也不为每个小改动强制多代理研究。 |
| retro | 从会话错误反推环境、规范与检查改进 | 2026-11-20 复核 `abeeaf95` 版：七个候选类别（导航指针、机械检查、评审规则、AGENTS.md、工具经济、空转、信息可达）。采纳为**条件方法**，作为知识维护的方法背景；仍是人工显式触发，不随每次交付自动跑，也不另起总结文件。 |
| grill-with-docs | 组合 grilling + domain-modeling（`abeeaf95` 版仅 7 行，两次 Skill 调用） | 仍不作为入口：本流程已自行运行 grilling，包装无额外编排。其真正价值在 `domain-modeling`，已采纳为条件方法：决策当场写入 `GLOSSARY.md` / `docs/adr/`，让丢失会话后仍对人可读。 |
| setup-matt-pocock-skills | 为仓库建立 tracker/domain 等文档与入口 | 不原样执行；借“项目约定保存一次”的思想。项目配置保存 staging、Linear 状态、知识路径等，不创建通用软件存在性预检或强推 docs/agents 布局。 |
| tdd | 在约定测试 seam 上进行行为测试红绿循环 | 行为实现/修复使用已确认 seam 的逐片红绿循环；不测试私有实现、source-string 或 echo。纯文案等非行为改动验证真实消费面，不伪造红绿。 |
| to-spec | 将已经澄清的对话/代码事实综合成规格并发布 tracker | 需要独立规格时可选；简单需求可用短方案。发布 Linear、标签与批准时机需适配，不能原样打 ready-for-agent 自动推进。 |
| to-tickets | 垂直切片、依赖边、发布子票 | 复杂需求可借内部垂直切片与依赖思考；不执行上游发布子票/标签动作，不突破单 Linear 关联，也不发明票面格式平台。 |
| triage | 读取外部 issue、核实问题并分流 | 已有 Linear 需求输入时按需使用判据；不引入第二套 tracker 状态机、不默认关闭需求。 |
| wayfinder | 以决策地图逐步消除大任务未知 | 只在信息尚不足以制定方案时选用；不是“票多就启用”。适配 Linear 与持久进度，不能以它的人类分配认领代替文件锁/会话所有权。 |
| wizard | 生成脚本引导人完成只能人工做的设置/凭据/切换步骤 | 不是控制器或阶段引擎；只有实际遇到人工设置步骤才选用，不做每次 start 的安装向导。敏感输入不进日志，运行前展示具体副作用。 |

## Productivity：7 个正式 skills

| Skill | 原始职责 | 本流程取舍与原因 |
|---|---|---|
| grill-me | 用户命令别名，转调 grilling | 不新增为运行时依赖或兼容别名；新入口为 /feat-flow-start，实际边界澄清方法是 grilling。 |
| grilling | 决策树、按 frontier 访谈，事实由 AI 查、决策由人定 | 两个入口都覆盖完整需求边界，已有材料仅免去重复问答；“无待定问题”不授予实施权限。原生提问 UI 和每轮独立冷读是本流程的显式适配，不冒称上游自带。 |
| handoff | 写不重复已有产物的跨会话交接摘要，默认存临时目录 | 可借内容规则，不能用临时文件作唯一恢复来源；已批准决定、进行中工作与定位必须持久化。 |
| teach | 多会话教学工作区 | 不纳入需求交付流程。 |
| to-questionnaire | 将需要外部干系人回答的问题整理成问卷 | 需要外部问卷时可选；其中面向无前情收件人补齐背景的原则也用于设计本流程提问契约。上游这条原则不等于每轮独立冷读，后者由本流程新增。 |
| wait-what | 以更简单语言解释上一条内容 | 可作为用户随时要求的解释方法，不计入交付步骤，不依赖额外 glossary 建设。 |
| writing-for-agents | 知识指针、按需加载、完成判据、剪枝与单一真源 | 复用来编写精简 stage 和治理项目知识；它不能替代长期知识变更批准。 |

## Misc：4 个冻结 skills

| Skill | 取舍 |
|---|---|
| git-guardrails-claude-code | 不作为依赖；宿主不符且已冻结。已有 shell 黑名单已知绕过问题也不能变成新内核的安全保证。 |
| migrate-to-shoehorn | 与通用需求交付无关，不纳入；只有具体迁移需求才是独立工作。 |
| scaffold-exercises | 课程练习生成，不纳入。 |
| setup-pre-commit | 不把团队已有工具链安装重做一遍；不纳入。 |

## In-progress：8 个未正式发布 skills

| Skill | 取舍 |
|---|---|
| software-factory | 只参考去重、授权、触发器与刹车的设计问题；不依赖 beta skill，不采用其“run 从不等人”的模式。 |
| chief-of-staff | 可参考跨会话断言带日期/版本的思想；不引入 wiki、长期战略协调员或全任务外包架构。 |
| claude-handoff | 硬绑 Claude 后台进程，不纳入。 |
| loop-me | 用于发现重复工作并生成 workflows，不是当前已确认交付流程的运行依赖。 |
| setup-ts-deep-modules | 不强推 TS 架构工具；只借“检查必须被反例触发过”这个验证原则。 |
| writing-beats | 写作工具，不纳入。 |
| writing-fragments | 写作工具，不纳入。 |
| writing-shape | 写作工具，不纳入。 |

## 两个必须公开的适配边界

第一，上游没有本流程需要的持久状态机、文件锁、强制人工批准和 Linear 生命周期。复用 skills 不能代替引擎。

第二，上游部分 skills 标记 user-invoked。omp 的 hide/disableModelInvocation 只控制技能目录曝光，不等于可以把自动加载伪装成用户调用。交付包应记录上游来源/版本、哪些规则原样引用、哪些 invocation/副作用做了适配；不要求用户为满足上游调用假设逐个手动执行。

## 外部分发与升级边界（本轮已确认）

必须区分：外部技能安装、随插件发布技能文本、每次 run 保存实际采用内容。第三项不等于第二项，也不能用插件发版代替外部依赖的更新。

当前本机原生列表证实 grilling、tdd、code-review 来自 ~/.agents/skills，OMP 只发现和读取。插件不应无理由再安装另一套同名副本。skills CLI 的更新能力不等于可以安全覆盖全局用户修改；来源、实际内容与本地改动必须分别核对，不能用全局锁的上游 tree SHA 冒充本地校验。

设计采用的运行时核心为 grilling、tdd、code-review；条件方法为 research、prototype、codebase-design、to-spec、to-tickets、wizard、wayfinder、diagnosing-bugs、to-questionnaire，实际触发才需要。pr 的正文结构及 writing-for-agents、handoff 作为设计/编写参考，不据此要求用户安装额外编排器。用户已有的其他 skills 不因此卸载、禁用或被接管。

只检查/更新本流程选定依赖；不与 omp-feat-flow 发版绑定，不顺手更新全部 skills，不偷偷升级外部管理器。未确认来源/无法证明无本地修改时仍须询问。每次 run 的实际内容绑定不跟随全局副本变化；显式更新该 run 时核对契约并重做受影响证据。

核心控制器采用标准 OMP 加载和原生 /restart，不再留存/运行完整旧代码 H；这与保留外部方法及 assets 的 run 快照是两个不同决定。具体控制与验收以 omp-feat-flow-design.md 本轮正文为准。

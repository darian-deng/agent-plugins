# compact／clear 恢复核查：源码事实，不是 E2E 报告

核查对象为当前安装的 `@oh-my-pi/pi-coding-agent@18.22.2`，只读其 `src/`。
没有压缩或清空开发者的当前会话，没有实现插件，没有跑恢复 E2E。

## 已核实的关键事实

下列路径均相对 `$OMP_PACKAGE_ROOT/`。

| 事实 | 一手依据 |
|---|---|
| `before_agent_start` 是提交/批次级，不覆盖每个工具循环继续；自动和主动 compact 都可能经 `agent.continue()` 恢复 | `src/session/agent-session.ts:5560-5810,9574-9678`；`src/session/session-maintenance.ts:1650-1780,6430-6500` |
| ExtensionAPI `context` 在业务 agent 的每次请求准备时投影消息；不改持久会话历史 | `src/sdk.ts:4816-4819`；`src/extensibility/extensions/runner.ts:2488-2560` |
| `context` 的异常/超时可被宿主吞掉并继续原上下文，不能靠 throw 阻断模型；`tool_call` 异常/超时则 fail-closed | `src/extensibility/extensions/runner.ts:1933-2024,2325-2362,2512-2537` |
| TUI `/clear` 调用 reset-context，不是 `/new`；只有成功 clear 才发 `session_clear` | `src/slash-commands/builtin-lifecycle.ts:173-215`；`src/session/agent-session.ts:7232-7315` |
| `/clear` 保留 SessionManager 持久 ID 和文件，但刷新 provider-side session id、内部代次并清空模型消息；不能只比较持久 ID 判断是否重建写资格 | `src/session/agent-session.ts:6666-6678,7232-7315,8275-8283`；`src/extensibility/shared-events.ts:52-55` |
| `/new` / RPC `new_session` 经 before-switch/switch，不重新发 session_start；新进程启动才有 start | `src/session/agent-session.ts:12497-12620`；`src/modes/rpc/rpc-mode.ts:883-889`；`src/modes/runtime-init.ts:214` |
| 新会话改变 local:// 根；旧会话 local:// 不能当成跨会话稳定材料地址 | `src/internal-urls/local-protocol.ts:40-45` |
| RPC 没有真正 clear/reset-context 命令；把 `/clear` 当普通 prompt 发送不是原生清空 | `src/slash-commands/builtin-lifecycle.ts:205-215`；`src/modes/rpc/wire/commands.ts`；`src/slash-commands/acp-builtins.ts:37-40` |
| 存在公开自动压缩阈值、工具循环中途检查设置和原生 auto/manual 事件；可在专用配置中触发，不必假造 auto | `src/session/context-settings.ts:106-205`；`src/extensibility/shared-events.ts:253-273` |

## 采用的结论

每次业务模型请求都由 extension 的 `context` 路径投影已核验的当前执行快照。
生命周期事件用于失效旧绑定、重新定位/核验及生成接续回执，不能单靠启动时注入一次。
只读恢复/上下文准备不授予权限；所有受控写仍检查当前 run、owner、有效批准、材料和恢复状态。
恢复未完成或失败时，返回可解释的阻写状态，不能把 handler 抛错等同于安全阻断。
clear 和真正新会话分别验收，不能用 RPC new_session 替代真实 TUI clear。

## 不采纳或修正的研究建议

两份独立研究对 clear 的“会话身份”简述不够一致。一手源码将持久 SessionManager 身份
与 provider-side 身份分开：前者保留，后者刷新。设计必须明确这个层次，不选边投票。

不采用未核实的复制 `auth.json` 作为测试凭据方案；测试沿用已授权的原生凭据/公开注入
路径，不复制私有凭据存储、不打印 token、不改全局登录。具体测试运行配置仍须在实施计划
核准。也不硬编码一个可能小于固定上下文的低阈值，制造无进展的反复压缩。

`context` 可被后续 extension 改写，provider payload 又是 transport-specific；不能把本插件
handler 看过消息等同于任意最终传输都保留了它。E2E 需对选定真实 provider 观察首次实际请求，
被动 observer 不重写或补种内容；未知/不可观测不能标通过。不承诺对任意第三方改写的保护。

## 留给真实 E2E 的证明

至少独立驱动 auto、manual compact、TUI clear、new-session 四个入口；新会话再覆盖同 cwd
新进程。每例证明首次恢复业务请求含正确执行快照、可见回执准确，以及恢复受阻时实际受控写
被拒且真实 Git/文件未变。auto 还须包含工具循环直接 continue 的路径。

只看模型复述、控制器私有 state、造假 provider、未尝试的写入或简单 echo 都不算证明。
源码核查只证明可用接口与调用路径，不证明插件实现正确或 E2E 已通过。

研究来源：`NativeRestoreOrdering (private source-audit receipt)`、`NativeRestoreE2EDrivers (private source-audit receipt)` 的只读报告，
以及主会话对 clear、context、tool gate、事件类型和设置注册的一手源码复核。

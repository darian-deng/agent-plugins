import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveActiveProjectRegistryPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	getInstalledPlugin,
	getInstalledPluginsRegistryPath,
	readInstalledPluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/registry";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { readUserConfigSafe, type RoleEffort, type UserConfigV1 } from "./config";
import { createFlow, effectOf, flowCommandDescription, recoveryReceipt, type FlowController, type ModelStatus } from "./flow";
import { grillFromConversation, grillFromPrd, type BoundaryDecision } from "./grilling";
import { countProvidedIntents, isAllowedIntentCombination } from "./intents";
import type { ImplementationPlan } from "./plan";
import { alignmentDocumentSchema, deriveRequirementProfile, type RiskFlag } from "./profile";
import type { RequestIntent } from "./run";
import { isCmuxEnabled } from "./workspace";

const BUILD_ID = process.env.OMP_FEAT_FLOW_BUILD_ID ?? "unknown";

const EFFORT_TO_THINKING: Record<RoleEffort, ConfiguredThinkingLevel> = {
	off: ThinkingLevel.Off,
	minimal: ThinkingLevel.Minimal,
	low: ThinkingLevel.Low,
	medium: ThinkingLevel.Medium,
	high: ThinkingLevel.High,
	xhigh: ThinkingLevel.XHigh,
};

function usableCredential(key: string | undefined): boolean {
	if (!key || key === "N/A") return false;
	return /^[A-Z][A-Z0-9_]{2,}$/.test(key) ? Boolean(process.env[key]) : true;
}

function recordedAnswers(value: unknown): BoundaryDecision[] {
	if (Array.isArray(value)) return value as BoundaryDecision[];
	if (value !== null && typeof value === "object" && "decided" in value && Array.isArray(value.decided)) {
		return value.decided as BoundaryDecision[];
	}
	throw new Error("boundaries must hold an array of {category, answer} or an object with a decided array.");
}

function parseJson(text: string, field: string): unknown {
	try { return JSON.parse(text); } catch { throw new Error(`${field} must be valid JSON.`); }
}

function agentKindOf(ctx: ExtensionContext | null): "main" | "sub" {
	const agent = (ctx as { agent?: { kind?: "main" | "sub" } } | null)?.agent;
	return agent?.kind === "sub" ? "sub" : "main";
}

async function openFileInBrowser(path: string): Promise<boolean> {
	if (process.env.OMP_FEAT_FLOW_SKIP_OPEN === "1" || process.env.CI === "true") return false;
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
	const url = pathToFileURL(path).toString();
	const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const proc = Bun.spawn([opener, ...args], { stdout: "ignore", stderr: "ignore" });
		return (await proc.exited) === 0;
	} catch {
		return false;
	}
}

async function readReleaseJsonFromDir(pluginInstallPath: string): Promise<{ buildId: string; version: string } | null> {
	try {
		const release = JSON.parse(await readFile(join(pluginInstallPath, "runtime", "release.json"), "utf8")) as {
			buildId?: string;
			version?: string;
		};
		return typeof release.buildId === "string" && typeof release.version === "string"
			? { buildId: release.buildId, version: release.version }
			: null;
	} catch {
		return null;
	}
}

async function readInstalledReleaseForCwd(cwd: string): Promise<{ buildId: string; version: string } | null> {
	const registryPaths: string[] = [];
	try {
		const projReg = await resolveActiveProjectRegistryPath(cwd);
		if (projReg) registryPaths.push(projReg);
	} catch { /* ignore */ }
	try {
		registryPaths.push(getInstalledPluginsRegistryPath());
	} catch { /* ignore */ }

	for (const regPath of registryPaths) {
		try {
			const reg = await readInstalledPluginsRegistry(regPath);
			const direct = getInstalledPlugin(reg, "omp-feat-flow@darian-omp-plugins");
			const entries = direct ?? Object.entries(reg.plugins ?? {})
				.filter(([id]) => id === "omp-feat-flow" || id.startsWith("omp-feat-flow@"))
				.flatMap(([, list]) => list);
			const active = entries?.find(e => e.enabled !== false) ?? entries?.[0];
			if (active?.installPath) {
				const found = await readReleaseJsonFromDir(active.installPath);
				if (found) return found;
			}
		} catch { /* fallback to sibling release.json */ }
	}
	try {
		const release = JSON.parse(await readFile(new URL("./release.json", import.meta.url), "utf8")) as {
			buildId?: string;
			version?: string;
		};
		return typeof release.buildId === "string" && typeof release.version === "string"
			? { buildId: release.buildId, version: release.version }
			: null;
	} catch {
		return null;
	}
}

export default function featFlow(pi: ExtensionAPI): void {
	const processInstanceId = randomUUID();
	let sessionId = "";
	let context: ExtensionContext | null = null;
	let flow: FlowController | null = null;
	let loading: Promise<void> | null = null;
	let appliedAuthorForSession = false;
	let promptedGateId: string | null = null;
	let warnedCorruptConfig = false;

	const safeUserConfig = (): UserConfigV1 | null => {
		const res = readUserConfigSafe();
		if (!res.ok) {
			if (!warnedCorruptConfig) {
				warnedCorruptConfig = true;
				pi.logger.info(`omp-feat-flow ignored invalid user config at ${res.path}: ${res.error}`);
			}
			return null;
		}
		return res.config;
	};

	const refreshUI = (ctx: ExtensionContext | null): void => {
		if (!ctx || agentKindOf(ctx) !== "main" || !ctx.hasUI) return;
		const widget = controller().stageWidget();
		if (!widget) {
			ctx.ui.setStatus("feat-flow", undefined);
			ctx.ui.setWidget("feat-flow-stage", undefined);
			return;
		}
		ctx.ui.setStatus("feat-flow", widget.statusText);
		ctx.ui.setWidget("feat-flow-stage", widget.lines, { placement: "aboveEditor" });
	};

	const modelStatus = async (): Promise<ModelStatus> => {
		if (!context) return { ready: false, reason: "session-not-started", provider: null, model: null, guidance: null };
		const current = context.models.current();
		if (!current) {
			return {
				ready: false, reason: "no-model-selected", provider: null, model: null,
				guidance: "No model is selected. Run /model to pick a model before starting a requirement.",
			};
		}
		const key = await context.modelRegistry.getApiKeyForProvider(current.provider);
		if (!usableCredential(key)) {
			return {
				ready: false, reason: "credential-missing", provider: current.provider, model: current.id,
				guidance: `No credential is available for ${current.provider}/${current.id}. Run /login for ${current.provider}, `
					+ "or /model to choose an authenticated model; this flow does not retry or fall back to another model.",
			};
		}
		return { ready: true, reason: "ready", provider: current.provider, model: current.id, guidance: null };
	};

	const controller = (): FlowController => {
		flow ??= createFlow({
			cwd: () => process.cwd(),
			sessionId: () => sessionId,
			processInstanceId,
			buildId: BUILD_ID,
			agentKind: () => agentKindOf(context),
			notify: (text, type) => {
				pi.logger.info(text);
				if (context?.hasUI) context.ui.notify(text, type);
			},
			modelStatus,
			ui: {
				get hasUI() { return Boolean(context?.hasUI); },
				notify: (text, type) => {
					pi.logger.info(text);
					if (context?.hasUI) context.ui.notify(text, type);
				},
				confirm: (title, message) => {
					if (!context) throw new Error("The session UI is not available yet.");
					return context.ui.confirm(title, message);
				},
				select: (title, options) => {
					if (!context) throw new Error("The session UI is not available yet.");
					return context.ui.select(title, options);
				},
				input: (title, placeholder, dialogOpts) => {
					if (!context) throw new Error("The session UI is not available yet.");
					return context.ui.input(title, placeholder, dialogOpts);
				},
				get formDialog() {
					const fn = context?.ui?.formDialog;
					if (!fn) return undefined;
					return async (html: string) => {
						const res = await fn(html);
						return res?.data;
					};
				},
			},
			workspace: {
				get enabled() {
					return isCmuxEnabled(safeUserConfig()?.integrations.cmuxPreference ?? "auto");
				},
			},
			activeTools: () => pi.getActiveTools(),
			isReadOnlyMcpTool: (toolName: string) => {
				const tools = pi.getAllTools?.() ?? [];
				const found = tools.find(t => t.name === toolName);
				return found?.mcpReadOnlyHint === true;
			},
			helperSdk: () => pi.pi as never,
			modelRegistry: () => context?.modelRegistry,
			model: () => context?.models.current(),
			contextUsage: () => context?.getContextUsage(),
			onboarding: {
				enabled: process.env.OMP_FEAT_FLOW_SKIP_USER_ONBOARDING !== "1",
				availableModels: () => {
					const list = context?.models.list() ?? [];
					return list.map(m => ({ spec: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}` }));
				},
				resolveModel: spec => Boolean(context?.models.resolve(spec)),
				hasProviderKey: async spec => {
					const resolved = context?.models.resolve(spec);
					if (!resolved || !context) return false;
					return usableCredential(await context.modelRegistry.getApiKeyForProvider(resolved.provider));
				},
			},
			resolveRoleModel: (role, userCfg) => {
				const spec = userCfg?.roles[role];
				if (!spec || !context) return {};
				const resolved = context.models.resolve(spec.model);
				return {
					...(resolved ? { model: resolved } : {}),
					effort: spec.effort,
				};
			},
			openExternal: openFileInBrowser,
			installedRelease: () => readInstalledReleaseForCwd(process.cwd()),
			confirm: (title: string, message: string) => {
				if (!context) throw new Error("The session UI is not available yet.");
				return context.ui.confirm(title, message);
			},
		});
		return flow;
	};

	const start = async (ctx: ExtensionContext): Promise<void> => {
		context = ctx;
		if (agentKindOf(ctx) !== "main") {
			await controller().lifecycle({ type: "session_start" });
			return;
		}
		const nextSessionId = ctx.sessionManager.getSessionId();
		if (flow && sessionId && sessionId !== nextSessionId) {
			await flow.rebindSession();
			loading = null;
			appliedAuthorForSession = false;
			promptedGateId = null;
		}
		sessionId = nextSessionId;
		loading ??= controller().lifecycle({ type: "session_start" }).then(() => {
			refreshUI(ctx);
		});
		return loading;
	};

	pi.on("session_start", async (_event, ctx) => {
		await start(ctx);
	});

	pi.on("session_clear", async (_event, ctx) => {
		context = ctx;
		if (agentKindOf(ctx) !== "main") return;
		promptedGateId = null;
		await flow?.lifecycle({ type: "session_clear" }).catch(() => {});
		refreshUI(ctx);
	});

	pi.on("session_switch", async (event, ctx) => {
		context = ctx;
		if (agentKindOf(ctx) !== "main") return;
		// Always update sessionId before lifecycle() so re-opened/switched runs bind the new identity.
		sessionId = ctx.sessionManager.getSessionId();
		appliedAuthorForSession = false;
		promptedGateId = null;
		await flow?.lifecycle({ type: "session_switch", reason: event.reason }).catch(() => {});
		refreshUI(ctx);
	});

	pi.on("session_compact", async (_event, ctx) => {
		context = ctx;
		if (agentKindOf(ctx) !== "main") return;
		await flow?.lifecycle({ type: "session_compact" }).catch(() => {});
		refreshUI(ctx);
	});

	pi.on("session.compacting", async (_event, ctx) => {
		if (agentKindOf(ctx) !== "main") return;
		const brief = await controller().recoveryBrief(false);
		if (!brief) return;
		return { context: [brief] };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (agentKindOf(ctx) !== "main") return;
		await flow?.dispose({ clean: true });
		flow = null;
		loading = null;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		context = ctx;
		if (agentKindOf(ctx) !== "main") return;
		await start(ctx);
		const ctrl = controller();
		const view = ctrl.context();
		if (!view.located) return;

		if (!appliedAuthorForSession) {
			appliedAuthorForSession = true;
			const authorSpec = (ctrl.userConfig() ?? safeUserConfig())?.roles.author;
			if (authorSpec) {
				const resolved = ctx.models.resolve(authorSpec.model);
				if (resolved) await pi.setModel(resolved).catch(() => {});
				const level = EFFORT_TO_THINKING[authorSpec.effort];
				if (level === "off" || level === "minimal" || level === "low" || level === "medium" || level === "high" || level === "xhigh") {
					pi.setThinkingLevel(level);
				}
			}
		}

		const promptBlock = ctrl.stagePrompt();
		const brief = await ctrl.recoveryBrief(true);
		refreshUI(ctx);
		const nextSystem = promptBlock ? [...event.systemPrompt, promptBlock] : event.systemPrompt;
		if (brief) {
			return {
				systemPrompt: nextSystem,
				message: {
					customType: "feat-flow-recovery",
					content: [{ type: "text", text: brief }],
					display: false,
				},
			};
		}
		return promptBlock ? { systemPrompt: nextSystem } : undefined;
	});

	pi.on("before_subagent_spawn", async (event, ctx) => {
		if (agentKindOf(ctx) !== "main") return;
		const view = controller().context();
		if (!view.located) return;
		if (event.agent !== "scout") {
			return {
				block: true,
				reason: "feat-flow permits only read-only `scout` subagents; code edits must run serially in the main session.",
			};
		}
		const userCfg: UserConfigV1 | null = controller().userConfig() ?? safeUserConfig();
		const scoutSpec = userCfg?.roles.scout;
		if (scoutSpec) {
			return { model: `${scoutSpec.model}:${scoutSpec.effort}` };
		}
		return;
	});

	pi.on("tool_call", async (event, ctx) => {
		if (process.env.OMP_FEAT_FLOW_OFF === "1") return;
		context = ctx;
		await start(ctx);
		const input = (event as { input?: Record<string, unknown> }).input;
		const admission = controller().beforeTool({ toolCallId: event.toolCallId, toolName: event.toolName, input });
		if (admission.allow) return;
		pi.logger.info(`denied ${event.toolName} (${effectOf(event.toolName, input)}): ${admission.reason}`);
		return { block: true, reason: `feat-flow denied this ${effectOf(event.toolName, input)}: ${admission.reason}` };
	});

	pi.on("tool_result", async (event, ctx) => {
		context = ctx;
		if (agentKindOf(ctx) !== "main") return;
		const ctrl = controller();
		const input = (event as { input?: Record<string, unknown> }).input;
		ctrl.recordToolOutcome(event.toolCallId, event.toolName, input, event.isError);
		const sampled = await ctrl.onContextSample();
		refreshUI(ctx);
		if (sampled.latched && sampled.advisory) {
			return { additionalContext: sampled.advisory };
		}
		return;
	});

	pi.on("turn_end", (_event, ctx) => {
		refreshUI(ctx);
	});

	pi.on("session_stop", (event, ctx) => {
		if (agentKindOf(ctx) !== "main") return;
		const view = controller().context().view;
		if (view?.contextWrapUp && !view.contextWrapUp.checkpointed && !event.stop_hook_active) {
			return {
				continue: true,
				additionalContext: "Context wrap-up is latched and no checkpoint was saved yet. Call feat_flow_request({ checkpoint }) now before stopping.",
			};
		}
		return;
	});

	pi.on("agent_end", (event, ctx) => {
		if (agentKindOf(ctx) !== "main" || !ctx.hasUI) return;
		if (event.willContinue || event.awaitingAsyncWork) return;
		const token = controller().context().gateToken;
		if (!token || promptedGateId === token.id) return;
		setTimeout(() => {
			if (!ctx.isIdle()) return;
			const liveToken = controller().context().gateToken;
			if (!liveToken || liveToken.id !== token.id || promptedGateId === token.id) return;
			promptedGateId = token.id;
			void controller().decideGate({ tokenId: token.id, silentAuto: true })
				.then(decided => {
					if (!decided) promptedGateId = null;
					refreshUI(ctx);
				})
				.catch(err => {
					promptedGateId = null;
					ctx.ui.notify(err instanceof Error ? err.message : String(err), "warning");
					refreshUI(ctx);
				});
		}, 0);
	});

	const registerSimpleCommand = (name: "status" | "start" | "approve" | "sync" | "finish" | "update") => {
		pi.registerCommand(`feat-flow-${name}`, {
			description: flowCommandDescription(name),
			handler: async (args, ctx) => {
				await start(ctx);
				try {
					await controller().command(name, args);
					refreshUI(ctx);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					refreshUI(ctx);
					throw error;
				}
			},
		});
	};

	registerSimpleCommand("status");
	registerSimpleCommand("start");
	registerSimpleCommand("approve");
	registerSimpleCommand("sync");
	registerSimpleCommand("finish");
	registerSimpleCommand("update");
	const riskFlagEnum = pi.zod.enum([
		"auth", "crypto", "secrets", "untrusted-input", "network-protocol",
		"ipc", "db-schema", "data-migration", "payment", "lockfile-change",
		"permissions", "hot-path", "memory-sensitive",
	]);

	pi.registerTool({
		name: "feat_flow_request",
		label: "Feat Flow Request",
		loadMode: "essential",
		description: "Submit a structured intent to the active feat-flow run: boundaries, plan (+ alignmentDoc/signals), sliceUpdate, checkpoint, readyForDelivery, knowledge, or task. "
			+ "Small-tier runs may submit boundaries + plan together (or plan directly). Never write temp JSON files in alignment.",
		parameters: pi.zod.object({
			task: pi.zod.string().min(1).optional(),
			prdPath: pi.zod.string().min(1).optional().describe("Optional read-only PRD markdown path with ## Decisions."),
			boundaries: pi.zod.object({
				decided: pi.zod.array(pi.zod.object({
					category: pi.zod.enum(["goals", "non-goals", "business-boundary", "error-path", "acceptance"]),
					answer: pi.zod.string().min(1),
				}).strict()),
				open: pi.zod.array(pi.zod.enum(["goals", "non-goals", "business-boundary", "error-path", "acceptance"])).optional(),
			}).strict().optional(),
			boundariesPath: pi.zod.string().min(1).optional().describe("Legacy read-only JSON boundaries path."),
			plan: pi.zod.object({
				activities: pi.zod.array(pi.zod.object({
					kind: pi.zod.enum(["prototype", "research", "spec", "ticket", "wizard"]),
					seam: pi.zod.string().min(1),
					reason: pi.zod.string().min(1),
				}).strict()),
				slices: pi.zod.array(pi.zod.object({
					id: pi.zod.string().min(1),
					behavior: pi.zod.string().min(1),
					test: pi.zod.string().min(1),
					dependsOn: pi.zod.array(pi.zod.string()),
				}).strict()).min(1),
				invariant: pi.zod.string().min(8),
			}).strict().optional(),
			planPath: pi.zod.string().min(1).optional().describe("Legacy read-only JSON plan path."),
			amendPlan: pi.zod.boolean().optional().describe("Set true with `plan` during implementation to propose a mid-flight amendment of remaining slices."),
			proposalContent: pi.zod.string().min(1).optional(),
			proposalScope: pi.zod.string().min(1).optional(),
			summary: pi.zod.string().min(1).optional(),
			signals: pi.zod.object({
				expectedFiles: pi.zod.number().int().min(1),
				distinctModules: pi.zod.number().int().min(1),
				riskFlags: pi.zod.array(riskFlagEnum),
				externalEffects: pi.zod.boolean(),
				estimatedSlices: pi.zod.number().int().min(1),
			}).strict().optional(),
			declaredFiles: pi.zod.array(pi.zod.string().min(1)).optional(),
			alignmentDoc: pi.zod.object({
				tldr: pi.zod.string().min(1),
				problem: pi.zod.string().min(1),
				goals: pi.zod.array(pi.zod.string().min(1)).min(1),
				nonGoals: pi.zod.array(pi.zod.string().min(1)).min(1),
				placement: pi.zod.object({
					summary: pi.zod.string().min(1),
					upstreamDownstream: pi.zod.array(pi.zod.string().min(1)).optional(),
					constraints: pi.zod.array(pi.zod.string().min(1)).optional(),
					nodes: pi.zod.array(pi.zod.object({
						id: pi.zod.string().min(1),
						label: pi.zod.string().min(1),
						kind: pi.zod.enum(["module", "external", "store", "boundary", "focal"]).optional(),
					}).strict()).optional(),
					edges: pi.zod.array(pi.zod.object({
						from: pi.zod.string().min(1),
						to: pi.zod.string().min(1),
						label: pi.zod.string().optional(),
					}).strict()).optional(),
				}).strict(),
				mechanism: pi.zod.object({
					overview: pi.zod.string().min(1),
					contracts: pi.zod.array(pi.zod.string().min(1)).optional(),
					failureModes: pi.zod.array(pi.zod.string().min(1)).optional(),
					persistenceOrMigration: pi.zod.string().optional(),
				}).strict(),
				changeSurface: pi.zod.array(pi.zod.object({
					path: pi.zod.string().min(1),
					action: pi.zod.enum(["add", "modify", "delete"]),
					summary: pi.zod.string().min(1),
				}).strict()).min(1),
				decisions: pi.zod.array(pi.zod.object({
					decision: pi.zod.string().min(1),
					choice: pi.zod.string().min(1),
					rejected: pi.zod.string().min(1),
					rationale: pi.zod.string().min(1),
					impact: pi.zod.string().min(1),
				}).strict()).optional(),
				risksAndAssumptions: pi.zod.array(pi.zod.string().min(1)).optional(),
				verification: pi.zod.string().min(1),
			}).strict().optional(),
			sliceUpdate: pi.zod.object({
				sliceId: pi.zod.string().min(1),
				status: pi.zod.enum(["pending", "in_progress", "partial", "done"]),
				commitSha: pi.zod.string().nullable().optional(),
				testProof: pi.zod.string().nullable().optional(),
				remaining: pi.zod.string().nullable().optional(),
			}).strict().optional(),
			checkpoint: pi.zod.object({
				reason: pi.zod.enum(["stage-boundary", "between-slices", "context-wrap-up", "manual"]),
				activeSliceId: pi.zod.string().nullable(),
				currentState: pi.zod.string().min(1),
				remainingInSlice: pi.zod.string().nullable().optional(),
				discoveries: pi.zod.array(pi.zod.string()).optional(),
				pendingQuestions: pi.zod.array(pi.zod.string()).optional(),
				lastVerification: pi.zod.string().nullable().optional(),
			}).strict().optional(),
			readyForDelivery: pi.zod.union([
				pi.zod.boolean(),
				pi.zod.object({ summary: pi.zod.string().optional() }).strict(),
			]).optional(),
			knowledgePath: pi.zod.string().min(1).optional(),
			knowledgeReason: pi.zod.string().min(1).optional(),
			knowledgeProposed: pi.zod.string().optional(),
		}).strict(),
		async execute(toolCallId, params) {
			const hasPlan = params.plan !== undefined || params.planPath !== undefined;
			const hasBoundaries = params.boundaries !== undefined || params.boundariesPath !== undefined || params.prdPath !== undefined;
			const hasPropose = (params.proposalContent !== undefined || params.proposalScope !== undefined) && !hasPlan;
			if (params.readyForDelivery === false) {
				throw new Error("readyForDelivery cannot be false; pass true or { summary } when ready.");
			}
			const providedIntents = countProvidedIntents({
				boundaries: hasBoundaries ? true : undefined,
				plan: hasPlan ? true : undefined,
				knowledge: params.knowledgePath !== undefined ? true : undefined,
				sliceUpdate: params.sliceUpdate,
				checkpoint: params.checkpoint,
				readyForDelivery: params.readyForDelivery ? params.readyForDelivery : undefined,
			});
			const extraIntents = [params.task !== undefined, hasPropose].filter(Boolean).length;

			if (extraIntents > 0) {
				if (extraIntents !== 1 || providedIntents.length > 0) {
					throw new Error("Provide a single intent: task, proposalContent+proposalScope, boundaries, plan, boundaries+plan, sliceUpdate, checkpoint, readyForDelivery, or knowledgePath.");
				}
			} else if (!isAllowedIntentCombination(providedIntents)) {
				throw new Error("Provide exactly one intent (or boundaries+plan together): task, boundaries/prdPath, plan, sliceUpdate, checkpoint, readyForDelivery, or knowledgePath.");
			}

			// Atomic boundaries + plan submission when both are passed in one call.
			if (hasBoundaries && hasPlan) {
				const grilled = params.prdPath !== undefined
					? grillFromPrd(await readFile(params.prdPath, "utf8"), [])
					: params.boundaries !== undefined
						? grillFromConversation(params.boundaries.decided as BoundaryDecision[], [])
						: grillFromConversation(recordedAnswers(parseJson(await readFile(params.boundariesPath!, "utf8"), "boundariesPath")), []);
				await controller().request({
					kind: "boundaries",
					decided: grilled.decided,
					open: grilled.open.map(b => b.category),
				}, `${toolCallId}:b`);
			}

			let intent: RequestIntent;
			if (params.task !== undefined) {
				intent = { kind: "task", task: params.task };
			} else if (params.knowledgePath !== undefined) {
				if (!params.knowledgeReason || params.knowledgeProposed === undefined) {
					throw new Error("A knowledge correction needs knowledgePath, knowledgeReason and knowledgeProposed together.");
				}
				intent = { kind: "knowledge", path: params.knowledgePath, reason: params.knowledgeReason, proposed: params.knowledgeProposed };
			} else if (hasBoundaries && !hasPlan) {
				const grilled = params.prdPath !== undefined
					? grillFromPrd(await readFile(params.prdPath, "utf8"), [])
					: params.boundaries !== undefined
						? grillFromConversation(params.boundaries.decided as BoundaryDecision[], [])
						: grillFromConversation(recordedAnswers(parseJson(await readFile(params.boundariesPath!, "utf8"), "boundariesPath")), []);
				intent = { kind: "boundaries", decided: grilled.decided, open: grilled.open.map(b => b.category) };
			} else if (hasPlan) {
				if (!params.signals && params.plan) {
					throw new Error("Submitting an inline plan requires `signals` (expectedFiles, distinctModules, riskFlags, externalEffects, estimatedSlices).");
				}
				const planObj = (params.plan ?? parseJson(await readFile(params.planPath!, "utf8"), "planPath")) as ImplementationPlan;
				const profile = params.signals
					? deriveRequirementProfile({
						signals: { ...params.signals, riskFlags: params.signals.riskFlags as RiskFlag[] },
						actualSlices: planObj.slices.length,
						...(params.declaredFiles ? { declaredFiles: params.declaredFiles } : {}),
					})
					: undefined;
				const scope = params.proposalScope ?? (params.declaredFiles?.join(", ") || planObj.slices.map(s => s.id).join(", "));
				const summary = params.summary ?? params.alignmentDoc?.tldr ?? planObj.slices.map(s => `${s.id}: ${s.behavior}`).join("; ");
				intent = {
					kind: params.amendPlan ? "plan.amend" : "plan",
					plan: planObj,
					scope,
					summary,
					...(profile ? { profile } : {}),
					...(params.alignmentDoc ? { alignmentDoc: alignmentDocumentSchema.parse(params.alignmentDoc) } : {}),
				};
			} else if (params.sliceUpdate !== undefined) {
				intent = {
					kind: "slice.update",
					sliceId: params.sliceUpdate.sliceId,
					status: params.sliceUpdate.status,
					...(params.sliceUpdate.commitSha !== undefined ? { commitSha: params.sliceUpdate.commitSha } : {}),
					...(params.sliceUpdate.testProof !== undefined ? { testProof: params.sliceUpdate.testProof } : {}),
					...(params.sliceUpdate.remaining !== undefined ? { remaining: params.sliceUpdate.remaining } : {}),
				};
			} else if (params.checkpoint !== undefined) {
				intent = {
					kind: "checkpoint",
					reason: params.checkpoint.reason,
					activeSliceId: params.checkpoint.activeSliceId,
					currentState: params.checkpoint.currentState,
					...(params.checkpoint.remainingInSlice !== undefined ? { remainingInSlice: params.checkpoint.remainingInSlice } : {}),
					...(params.checkpoint.discoveries !== undefined ? { discoveries: params.checkpoint.discoveries } : {}),
					...(params.checkpoint.pendingQuestions !== undefined ? { pendingQuestions: params.checkpoint.pendingQuestions } : {}),
					...(params.checkpoint.lastVerification !== undefined ? { lastVerification: params.checkpoint.lastVerification } : {}),
				};
			} else if (params.readyForDelivery !== undefined) {
				const summary = typeof params.readyForDelivery === "object" ? params.readyForDelivery.summary : undefined;
				intent = {
					kind: "ready_for_delivery",
					...(summary !== undefined ? { summary } : {}),
				};
			} else {
				if (!params.proposalContent || !params.proposalScope) throw new Error("A proposal needs both proposalContent and proposalScope.");
				intent = { kind: "propose", content: params.proposalContent, scope: params.proposalScope };
			}

			const outcome = await controller().request(intent, toolCallId);
			refreshUI(context);
			const view = outcome.view;
			const receipt = recoveryReceipt(controller().context());
			const advisorySuffix = outcome.advisory ? `\nADVISORY: ${outcome.advisory}` : "";
			return {
				content: [{
					type: "text" as const,
					text: `accepted: ${receipt}${view.techDesignHtmlPath ? `; html: ${view.techDesignHtmlPath}` : ""}${advisorySuffix}`,
				}],
				details: { runId: view.runId, revision: view.revision, phase: view.phase, gateToken: view.gateToken?.id ?? null },
			};
		},
	});
}

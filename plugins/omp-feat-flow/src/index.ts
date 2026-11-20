import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { createFlow, flowCommandDescription, effectOf, recoveryReceipt, type FlowController, type ModelStatus } from "./flow";
import { grillFromConversation, grillFromPrd, type BoundaryDecision } from "./grilling";
import type { ImplementationPlan } from "./plan";
import type { RequestIntent } from "./run";

/** A conversation answers file holds {decided, open}; only the recorded decisions are replayed. */
function recordedAnswers(value: unknown): BoundaryDecision[] {
	if (Array.isArray(value)) return value as BoundaryDecision[];
	if (value !== null && typeof value === "object" && "decided" in value && Array.isArray(value.decided)) {
		return value.decided as BoundaryDecision[];
	}
	throw new Error("boundariesPath must hold a JSON array of {category, answer} or an object with a decided array.");
}

function parseJson(text: string, field: string): unknown {
	try { return JSON.parse(text); } catch { throw new Error(`${field} must be valid JSON.`); }
}

const BUILD_ID = process.env.OMP_FEAT_FLOW_BUILD_ID ?? "unknown";

/**
 * Providers may name the environment variable that holds the key. The registry hands back that
 * literal name when the variable is unset, so an unresolved reference must not count as a credential.
 */
function usableCredential(key: string | undefined): boolean {
	if (!key || key === "N/A") return false;
	return /^[A-Z][A-Z0-9_]{2,}$/.test(key) ? Boolean(process.env[key]) : true;
}

/**
 * Native entry point. Identity is captured by the program: the model supplies requests,
 * never run, actor, epoch, revision or approval.
 */
export default function featFlow(pi: ExtensionAPI): void {
	const processInstanceId = randomUUID();
	let sessionId = "";
	let context: ExtensionContext | null = null;
	let flow: FlowController | null = null;
	let loading: Promise<void> | null = null;

	const modelStatus = async (): Promise<ModelStatus> => {
		if (!context) return { ready: false, reason: "session-not-started", provider: null, model: null, guidance: null };
		const current = context.models.current();
		if (!current) return { ready: false, reason: "no-model-selected", provider: null, model: null,
			guidance: "No model is selected. Run /model to pick a model before starting a requirement." };
		// Availability in the catalog is not a credential: resolve the provider's actual request key.
		const key = await context.modelRegistry.getApiKeyForProvider(current.provider);
		if (!usableCredential(key)) return { ready: false, reason: "credential-missing", provider: current.provider, model: current.id,
			guidance: `No credential is available for ${current.provider}/${current.id}. Run /login for ${current.provider}, `
				+ "or /model to choose an authenticated model; this flow does not retry or fall back to another model." };
		return { ready: true, reason: "ready", provider: current.provider, model: current.id, guidance: null };
	};

	const controller = (): FlowController => {
		flow ??= createFlow({
			cwd: () => process.cwd(),
			sessionId: () => sessionId,
			processInstanceId,
			buildId: BUILD_ID,
			notify: (text: string) => {
				pi.logger.info(text);
				if (context?.hasUI) context.ui.notify(text);
			},
			modelStatus,
			workspace: { enabled: process.env.OMP_FEAT_FLOW_CMUX === "1" },
			activeTools: () => pi.getActiveTools(),
			helperSdk: () => pi.pi as never,
			modelRegistry: () => context?.modelRegistry,
			model: () => context?.models.current(),
			installedRelease: async () => {
				try {
					const release = JSON.parse(await readFile(new URL("./release.json", import.meta.url), "utf8")) as { buildId?: string; version?: string };
					return typeof release.buildId === "string" && typeof release.version === "string"
						? { buildId: release.buildId, version: release.version } : null;
				} catch { return null; }
			},
			confirm: (title: string, message: string) => {
				if (!context) throw new Error("The session UI is not available yet.");
				return context.ui.confirm(title, message);
			},
		});
		return flow;
	};

	const start = async (ctx: ExtensionContext): Promise<void> => {
		context = ctx;
		const nextSessionId = ctx.sessionManager.getSessionId();
		if (flow && sessionId && sessionId !== nextSessionId) {
			// A new session must not inherit the previous session's authority, but the bound run stays known.
			await flow.rebindSession();
			loading = null;
		}
		sessionId = nextSessionId;
		loading ??= controller().lifecycle({ type: "session_start" }).then(() => {
			// A session opened on an existing run learns its facts before the first business request.
			const view = controller().context();
			if (!view.located) return;
			pi.sendMessage({ customType: "feat-flow-recovery", content: [{ type: "text", text: `feat-flow-recovery: ${recoveryReceipt(view)}` }] },
				{ deliverAs: "nextTurn" });
		});
		return loading;
	};

	pi.on("session_start", async (_event, ctx) => { await start(ctx); });
	// A TUI /clear keeps the session id but must not keep the old context's write authority.
	pi.on("session_clear", async () => {
		// The following session_start reopens the run, and the stale context is no longer an owner.
		flow?.lifecycle({ type: "session_clear" }).catch(() => {});
		await flow?.rebindSession();
	});
	// After compaction the next turn needs the run facts it lost; the receipt names blocked facts too.
	pi.on("session_compact", () => {
		const view = controller().context();
		pi.logger.info(`feat-flow session_compact: located=${view.located} reason=${view.reason ?? "none"}`);
		if (!view.located) return;
		// Idle delivery starts the first following turn; a queued followUp would wait for a user prompt.
		pi.sendMessage({ customType: "feat-flow-recovery", content: [{ type: "text", text: `feat-flow-recovery: ${recoveryReceipt(view)}` }] },
			{ deliverAs: "nextTurn" });
	});

	// `session_stop` fires after every prompt turn, so it only ends a turn, never this run's lease.
	pi.on("session_shutdown", async () => {
		await flow?.dispose();
		flow = null;
		loading = null;
	});

	pi.on("tool_call", (event, ctx) => {
		void start(ctx);
		const admission = controller().beforeTool({ toolCallId: event.toolCallId, toolName: event.toolName });
		if (admission.allow) return;
		pi.logger.info(`denied ${event.toolName} (${effectOf(event.toolName)}): ${admission.reason}`);
		return { block: true, reason: `feat-flow denied this ${effectOf(event.toolName)}: ${admission.reason}` };
	});

	pi.registerCommand("feat-flow-status", {
		description: flowCommandDescription("status"),
		handler: async (_args, ctx) => {
			await start(ctx);
			await controller().command("status", "");
			const view = controller().context();
			ctx.ui.notify(view.located ? `${view.runId} r${view.revision} ${view.phase} ${view.readiness}` : `no run: ${view.reason}`);
		},
	});
	pi.registerCommand("feat-flow-start", {
		description: flowCommandDescription("start"),
		handler: async (args, ctx) => {
			await start(ctx);
			try {
				await controller().command("start", args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				throw error;
			}
		},
	});

	pi.registerCommand("feat-flow-approve", {
		description: flowCommandDescription("approve"),
		handler: async (_args, ctx) => {
			await start(ctx);
			try {
				await controller().command("approve", "");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				throw error;
			}
		},
	});

	pi.registerCommand("feat-flow-sync", {
		description: flowCommandDescription("sync"),
		handler: async (_args, ctx) => {
			await start(ctx);
			try {
				await controller().command("sync", "");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				throw error;
			}
		},
	});

	pi.registerCommand("feat-flow-finish", {
		description: flowCommandDescription("finish"),
		handler: async (_args, ctx) => {
			await start(ctx);
			try {
				await controller().command("finish", "");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				throw error;
			}
		},
	});

	pi.registerCommand("feat-flow-update", {
		description: flowCommandDescription("update"),
		handler: async (_args, ctx) => {
			try {
				await controller().command("update", "");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error));
				throw error;
			}
		},
	});

	pi.registerTool({
		name: "feat_flow_request",
		label: "Feat Flow Request",
		// Custom tools default to "discoverable", which keeps them out of the active set.
		loadMode: "essential",
		description: "Submit one intent (a task change or a design proposal) to the current feat-flow run. "
			+ "Run identity, revision and approval are supplied by the host, never by this call, and this call can never approve a design.",
		parameters: pi.zod.object({
			task: pi.zod.string().min(1).optional().describe("Set the current task."),
			proposalContent: pi.zod.string().min(1).optional().describe("Proposal body for native review."),
			proposalScope: pi.zod.string().min(1).optional().describe("Files or behaviour the proposal covers."),
			prdPath: pi.zod.string().min(1).optional().describe("Existing PRD to grill for unresolved boundaries."),
			boundariesPath: pi.zod.string().min(1).optional()
				.describe("Path to a JSON file holding {\"decided\":[{\"category\",\"answer\"}],\"open\":[]} recorded from the conversation."),
			planPath: pi.zod.string().min(1).optional().describe("Path to a JSON file holding the implementation plan."),
			knowledgePath: pi.zod.string().min(1).optional().describe("Project-relative file the run's evidence contradicts."),
			knowledgeReason: pi.zod.string().min(1).optional().describe("The concrete recurring failure that justifies the correction."),
			knowledgeProposed: pi.zod.string().optional().describe("The full corrected file content; approval stays with the human."),
		}).strict(),
		async execute(toolCallId, params) {
			const provided = [params.task !== undefined, params.proposalContent !== undefined || params.proposalScope !== undefined,
				params.prdPath !== undefined, params.boundariesPath !== undefined, params.planPath !== undefined,
				params.knowledgePath !== undefined]
				.filter(Boolean).length;
			if (provided !== 1) throw new Error("Provide exactly one of task, proposalContent/proposalScope, prdPath, boundariesPath, planPath or knowledgePath.");
			let intent: RequestIntent;
			if (params.task !== undefined) intent = { kind: "task", task: params.task };
			else if (params.knowledgePath !== undefined) {
				if (!params.knowledgeReason || params.knowledgeProposed === undefined) {
					throw new Error("A knowledge correction needs knowledgePath, knowledgeReason and knowledgeProposed together.");
				}
				intent = { kind: "knowledge", path: params.knowledgePath, reason: params.knowledgeReason, proposed: params.knowledgeProposed };
			}
			else if (params.planPath !== undefined) {
				intent = { kind: "plan", plan: parseJson(await readFile(params.planPath, "utf8"), "planPath") as ImplementationPlan };
			} else if (params.boundariesPath !== undefined || params.prdPath !== undefined) {
				const grilled = params.prdPath !== undefined
					? grillFromPrd(await readFile(params.prdPath, "utf8"), [])
					: grillFromConversation(recordedAnswers(parseJson(await readFile(params.boundariesPath as string, "utf8"), "boundariesPath")), []);
				intent = { kind: "boundaries", decided: grilled.decided, open: grilled.open.map(boundary => boundary.category) };
			} else {
				if (!params.proposalContent || !params.proposalScope) throw new Error("A proposal needs both proposalContent and proposalScope.");
				intent = { kind: "propose", content: params.proposalContent, scope: params.proposalScope };
			}
			const outcome = await controller().request(intent, toolCallId);
			const view = outcome.view;
			const detail = intent.kind === "boundaries"
				? `decided: ${intent.decided.map(decision => decision.category).join(", ") || "none"}; open: ${intent.open.join(", ") || "none"}`
				: intent.kind === "plan" ? `${intent.plan.slices.length} serial slices, ${intent.plan.activities.length} activities`
					: intent.kind === "knowledge" ? `knowledge correction pending approval: ${intent.path}`
					: `approved ${view.approvedScope ? "yes" : "no"}`;
			return {
				content: [{ type: "text" as const, text: `accepted: run ${view.runId} revision ${view.revision}, phase ${view.phase}, ${detail}` }],
				details: { runId: view.runId, revision: view.revision, phase: view.phase, open: view.grilling?.open ?? null },
			};
		},
	});
}

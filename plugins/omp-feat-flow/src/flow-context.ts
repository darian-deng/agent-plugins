import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { stat as statPath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import type { ContextUsage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import {
	readUserConfigSafe,
	type ProjectConfigV2,
	type RoleEffort,
	type UserConfigV1,
} from "./config";
import type { DeliveryPorts } from "./delivery";
import { inspectRepository, type PreparedWorktree, type RepositoryLocation } from "./git";
import type { HelperSdk } from "./helpers";
import {
	materializeMethodPack,
	openPinnedMethodPack,
	type MaterializedMethodPack,
} from "./methods";
import type { AvailableModelChoice, OnboardingUI } from "./onboarding";
import type { AlignmentDocument, RequirementProfile } from "./profile";
import {
	locateRun,
	openRun,
	RunBusyError,
	type Admission,
	type ColdReadProof,
	type GateToken,
	type HostBinding,
	type RequestIntent,
	type RunKernel,
	type RunOutcome,
	type RunView,
} from "./run";
import type { StageWidgetView } from "./steering";
import { buildAlignmentReadModel, type AlignmentReadModel } from "./tech-design";
import type { Run } from "./workspace";

export type FlowCommand = "status" | "start" | "update" | "approve" | "finish" | "sync";
export type ToolEffect = "read" | "write" | "spawn";

export interface NativeToolAttempt {
	toolCallId: string;
	toolName: string;
	input?: Record<string, unknown> | undefined;
}

export interface NativeLifecycleEvent {
	type: "session_start" | "session_stop" | "session_clear" | "session_compact" | "session_switch" | "session_shutdown";
	reason?: string | undefined;
}

export interface RecoveryProjection {
	located: boolean;
	reason: string | null;
	runId: string | null;
	revision: number | null;
	phase: string | null;
	readiness: "ready" | "blocked" | null;
	waitingReason: string | null;
	ownerStatus: "self" | "other" | "unclaimed" | null;
	initialTask: string | null;
	currentTask: string | null;
	approvedScopeDigest: string | null;
	issue: string | null;
	worktree: string | null;
	unresolvedOperations: number;
	unknownOperations: number;
	openBoundaries: string[];
	planSlices: number;
	gateToken: GateToken | null;
	techDesignHtmlPath: string | null;
	view: Readonly<RunView> | null;
}
export interface ModelStatus {
	ready: boolean;
	reason: "ready" | "session-not-started" | "no-model-selected" | "credential-missing";
	provider: string | null;
	model: string | null;
	guidance: string | null;
}

export interface OnboardingHostPort {
	enabled: boolean;
	userConfigPath?: string;
	availableModels(): AvailableModelChoice[];
	resolveModel(spec: string): boolean;
	hasProviderKey(spec: string): Promise<boolean>;
}

export interface NativeHost {
	cwd(): string;
	sessionId(): string;
	readonly processInstanceId: string;
	readonly buildId: string;
	agentKind?: () => "main" | "sub";
	notify(text: string, type?: "info" | "warning" | "error"): void;
	modelStatus(): Promise<ModelStatus>;
	confirm(title: string, message: string): Promise<boolean>;
	ui?: OnboardingUI;
	workspace: { enabled: boolean; run?: Run };
	installedRelease(): Promise<{ buildId: string; version: string } | null>;
	helperSdk(): HelperSdk;
	deliveryPorts?(input: { worktree: string; repository: string; linearKey: string | null }): DeliveryPorts | null;
	activeTools(): string[];
	isReadOnlyMcpTool?(toolName: string): boolean;
	modelRegistry(): ModelRegistry | undefined;
	model(): Model | undefined;
	contextUsage?: () => ContextUsage | undefined;
	onboarding?: OnboardingHostPort;
	resolveRoleModel?: (role: "scout" | "coldReader" | "reviewer", userConfig: UserConfigV1 | null) => { model?: Model; effort?: RoleEffort };
	openExternal?: (path: string) => Promise<boolean>;
}

export interface FlowController {
	command(name: FlowCommand, args: string): Promise<void>;
	lifecycle(event: NativeLifecycleEvent): Promise<void>;
	context(): RecoveryProjection;
	beforeTool(call: NativeToolAttempt): Admission;
	recordToolOutcome(toolCallId: string, toolName: string, input: Record<string, unknown> | undefined, isError: boolean): void;
	onContextSample(): Promise<{ latched: boolean; mode?: "finalizing_slice" | "wrap_up"; advisory?: string }>;
	request(intent: RequestIntent, requestId: string): Promise<RunOutcome & { advisory?: string | null }>;
	decideGate(options?: { tokenId?: string; silentAuto?: boolean }): Promise<boolean>;
	stagePrompt(): string | null;
	recoveryBrief(consumeTurnFlag?: boolean): Promise<string | null>;
	stageWidget(): StageWidgetView | null;
	userConfig(): UserConfigV1 | null;
	packDir(): string | null;
	rebindSession(): Promise<void>;
	dispose(options?: { clean?: boolean }): Promise<void>;
}

const READ_ONLY_TOOLS: Record<string, true> = {
	read: true, grep: true, glob: true, ls: true, web_search: true, web_fetch: true, todo: true, ask: true,
};
const LSP_READONLY_ACTIONS = new Set([
	"diagnostics", "definition", "type_definition", "implementation", "references", "hover", "symbols", "status", "capabilities",
]);
const REQUEST_TOOLS: Record<string, true> = { feat_flow_request: true };
const SPAWNING_TOOLS: Record<string, true> = { task: true };

export function effectOf(toolName: string, input?: Record<string, unknown>): ToolEffect {
	if (SPAWNING_TOOLS[toolName]) return "spawn";
	if (toolName === "lsp") {
		return typeof input?.action === "string" && LSP_READONLY_ACTIONS.has(input.action) ? "read" : "write";
	}
	return READ_ONLY_TOOLS[toolName] || REQUEST_TOOLS[toolName] ? "read" : "write";
}

export function recoveryReceipt(projection: RecoveryProjection): string {
	if (!projection.located) return `no run: ${projection.reason}`;
	const facts = [
		`run ${projection.runId} r${projection.revision}`,
		`phase ${projection.phase}`,
		`${projection.readiness}${projection.waitingReason ? ` (${projection.waitingReason})` : ""}`,
		`owner ${projection.ownerStatus}`,
		`approved ${projection.approvedScopeDigest ? "yes" : "no"}`,
		`task ${projection.currentTask ?? "none"}`,
	];
	if (projection.unresolvedOperations > 0) facts.push(`${projection.unresolvedOperations} dispatched effect(s) unsettled`);
	if (projection.unknownOperations > 0) facts.push(`${projection.unknownOperations} effect(s) of unknown outcome`);
	if (projection.openBoundaries.length > 0) facts.push(`open boundaries: ${projection.openBoundaries.join(", ")}`);
	if (projection.planSlices > 0) facts.push(`${projection.planSlices} planned slice(s)`);
	return facts.join("; ");
}

const COMMAND_DESCRIPTIONS: Record<FlowCommand, string> = {
	status: "Report the current run: phase, readiness, wait reason, owner, tier and approved scope.",
	start: "Start or resume a requirement from a natural-language description or Linear ID/URL (pass `config` to reconfigure).",
	update: "Report bundled private MethodPack ref, local overrides, and running vs installed build.",
	sync: "Fetch the configured PR base into the run's private ref, rebase owned work and record the new review base.",
	finish: "Delivery Gate: sync, independent review (+ optional sec/perf audit), push, open 1 PR, and update Linear.",
	approve: "Plan/Checkpoint/Knowledge Gate: open design review & confirm approval (creates/binds Linear issue when required).",
};
export function flowCommandDescription(name: FlowCommand): string {
	return COMMAND_DESCRIPTIONS[name];
}

export function effectiveLinearMode(proj: ProjectConfigV2 | undefined): "required" | "optional" | "disabled" {
	if (!proj || proj.linear === undefined) return "required";
	if (proj.linear === null) return "disabled";
	return proj.linear.mode;
}

export function defaultUiFromHost(host: NativeHost): OnboardingUI {
	if (host.ui) return host.ui;
	return {
		hasUI: false,
		notify: (text, type) => host.notify(text, type),
		confirm: (title, message) => host.confirm(title, message),
		select: async () => undefined,
		input: async () => undefined,
	};
}

/** Canonical realpath containment check blocking `../` traversal and symlink escapes. */
export function resolveContainedWorktreePath(worktree: string, candidatePath: string): string | null {
	try {
		const root = realpathSync(resolve(worktree));
		const target = resolve(worktree, candidatePath);
		if (target !== root && !target.startsWith(root + sep)) return null;
		let probe = target;
		while (probe !== root && probe !== dirname(probe)) {
			try {
				lstatSync(probe);
				const real = realpathSync(probe);
				if (real !== root && !real.startsWith(root + sep)) return null;
				break;
			} catch (err) {
				if (err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT") {
					probe = dirname(probe);
					continue;
				}
				return null;
			}
		}
		return target;
	} catch {
		return null;
	}
}

export interface FlowRuntime {
	readonly host: NativeHost;
	live: { kernel: RunKernel; binding: HostBinding; runId: string } | null;
	known: { repo: PreparedWorktree; runId: string } | null;
	cachedUserConfig: UserConfigV1 | null;
	cachedPack: MaterializedMethodPack | null;
	subagentInFeatFlow: boolean | null;
	subagentCheckedCwd: string | null;
	cachedReadModels: Map<string, AlignmentReadModel>;
	openedDesignDigests: Set<string>;
	loading: Promise<void> | null;
	unavailable: string | null;
	disposed: boolean;
	needsRecoveryBrief: boolean;
	sawPassingCheck: boolean;
	pendingCheckPersist: Promise<void> | null;
	pendingWrapUpMode: "finalizing_slice" | "wrap_up" | null;
	wrapUpPersist: Promise<void> | null;
	backgroundColdRead: { digest: string; promise: Promise<ColdReadProof> } | null;
	isMainAgent(): boolean;
	deny(reason: string): Admission;
	roleModelAndEffort(role: "scout" | "coldReader" | "reviewer"): { model?: Model; thinkingLevel?: RoleEffort; modelRegistry?: ModelRegistry };
	gitHead(worktree: string): string;
	gitText(worktree: string, command: string[]): Promise<string>;
	ensurePack(commonDir: string, expectedMethodDigest?: string | null): Promise<MaterializedMethodPack | null>;
	ensureLoaded(): Promise<void> | null;
	checkSubagentWorkspace(): Promise<void>;
	loadAlignmentReadModel(view: RunView): AlignmentReadModel | undefined;
	projectVocabulary(worktree: string, entryPaths?: string[]): Promise<string>;
	checkChangedFilesWithinDeclared(view: RunView, head: string, declaredFiles: readonly string[]): Promise<{ ok: boolean; extra: string[] }>;
}

export function createFlowRuntime(host: NativeHost): FlowRuntime {
	const safeCfg = readUserConfigSafe(host.onboarding?.userConfigPath);
	const rt: FlowRuntime = {
		host,
		live: null,
		known: null,
		cachedUserConfig: safeCfg.ok ? safeCfg.config : null,
		cachedPack: null,
		subagentInFeatFlow: null,
		subagentCheckedCwd: null,
		cachedReadModels: new Map<string, AlignmentReadModel>(),
		openedDesignDigests: new Set<string>(),
		loading: null,
		unavailable: null,
		disposed: false,
		needsRecoveryBrief: false,
		sawPassingCheck: false,
		pendingCheckPersist: null,
		pendingWrapUpMode: null,
		wrapUpPersist: null,
		backgroundColdRead: null,
		isMainAgent: () => (host.agentKind ? host.agentKind() === "main" : true),

		deny: (reason: string): Admission => ({
			allow: false,
			reason,
			runId: rt.live?.runId ?? "",
			revision: null,
			ownerEpoch: null,
		}),

		roleModelAndEffort: (role: "scout" | "coldReader" | "reviewer") => {
			const resolved = host.resolveRoleModel?.(role, rt.cachedUserConfig);
			const spec = rt.cachedUserConfig?.roles[role];
			const model = resolved?.model ?? host.model();
			const effort = resolved?.effort ?? spec?.effort;
			const registry = host.modelRegistry();
			return {
				...(model ? { model } : {}),
				...(effort ? { thinkingLevel: effort } : {}),
				...(registry ? { modelRegistry: registry } : {}),
			};
		},

		gitHead: (worktree: string): string => {
			const result = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"], {
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});
			if (result.exitCode !== 0) throw new Error(`cannot read HEAD in ${worktree}: ${result.stderr.toString().slice(-300)}`);
			return result.stdout.toString().trim();
		},

		gitText: async (worktree: string, command: string[]): Promise<string> => {
			const result = Bun.spawn(["git", "-C", worktree, ...command], {
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			});
			const [stdout, , code] = await Promise.all([
				new Response(result.stdout).text(),
				new Response(result.stderr).text(),
				result.exited,
			]);
			if (code !== 0) throw new Error(`git ${command[0]} failed in ${worktree}`);
			return stdout;
		},

		ensurePack: async (commonDir: string, expectedMethodDigest?: string | null): Promise<MaterializedMethodPack | null> => {
			if (expectedMethodDigest) {
				if (rt.cachedPack?.methodDigest === expectedMethodDigest) return rt.cachedPack;
				rt.cachedPack = await openPinnedMethodPack(commonDir, expectedMethodDigest);
				return rt.cachedPack;
			}
			if (rt.cachedPack) return rt.cachedPack;
			try {
				rt.cachedPack = await materializeMethodPack(commonDir, {
					allowUserOverrides: rt.cachedUserConfig?.methods?.allowUserOverrides ?? false,
				});
				return rt.cachedPack;
			} catch {
				return null;
			}
		},

		checkSubagentWorkspace: async (): Promise<void> => {
			const cwd = host.cwd();
			if (rt.subagentCheckedCwd === cwd && rt.subagentInFeatFlow !== null) return;
			rt.subagentCheckedCwd = cwd;
			try {
				const loc = await inspectRepository(cwd);
				rt.subagentInFeatFlow = locateRun(loc) !== null;
			} catch {
				rt.subagentInFeatFlow = false;
			}
		},

		ensureLoaded: (): Promise<void> | null => {
			if (!rt.isMainAgent()) {
				rt.unavailable = "subagent-context";
				return rt.checkSubagentWorkspace();
			}
			if (rt.live || rt.unavailable || rt.disposed) return null;
			rt.loading ??= (async () => {
				let location: RepositoryLocation;
				try {
					location = await inspectRepository(host.cwd());
				} catch {
					rt.unavailable = "not-in-git-repository";
					return;
				}
				try {
					const sessionId = host.sessionId();
					if (!sessionId) {
						rt.unavailable = "session-identity-unavailable";
						return;
					}
					const direct = locateRun(location);
					const located = direct ?? (rt.known && rt.known.repo.worktree === location.repo ? rt.known : null);
					if (!located) {
						rt.unavailable = "run-not-initialized";
						return;
					}
					const binding: HostBinding = { processInstanceId: host.processInstanceId, sessionId, contextEpoch: 0 };
					const kernel = await openRun({
						repo: located.repo, runId: located.runId, buildId: host.buildId, mode: "owner", binding,
					});
					if (rt.disposed) {
						await kernel.dispose();
						return;
					}
					rt.live = { kernel, binding, runId: located.runId };
					rt.known = { repo: located.repo, runId: located.runId };
					const view = kernel.inspect();
					await rt.ensurePack(located.repo.commonDir, view.methodDigest).catch(() => {
						rt.cachedPack = null;
					});
					rt.needsRecoveryBrief = true;
				} catch (error) {
					rt.unavailable = error instanceof RunBusyError ? "run-owned-elsewhere" : "run-state-unavailable";
				}
			})();
			return rt.loading;
		},

		loadAlignmentReadModel: (view: RunView): AlignmentReadModel | undefined => {
			const cand = view.pendingAmendment?.candidate ?? view.candidate;
			if (!cand) return undefined;
			const cached = rt.cachedReadModels.get(cand.digest);
			if (cached) return cached;
			const docPath = view.pendingAmendment?.candidate.digest === cand.digest
				? view.pendingAmendment.alignmentDocPath
				: view.alignmentDocPath;
			if (!docPath || !existsSync(docPath)) return undefined;
			try {
				const parsed = JSON.parse(readFileSync(docPath, "utf8")) as {
					doc?: AlignmentDocument;
					profile?: RequirementProfile;
					meta?: Parameters<typeof buildAlignmentReadModel>[2];
					readModelDigest?: string;
				};
				if (!parsed.doc || !parsed.profile || !parsed.meta) return undefined;
				const rebuilt = buildAlignmentReadModel(parsed.doc, parsed.profile, parsed.meta);
				if (parsed.readModelDigest && parsed.readModelDigest !== rebuilt.digest) return undefined;
				if (view.pendingAmendment?.readModelDigest && view.pendingAmendment.readModelDigest !== rebuilt.digest) {
					return undefined;
				}
				rt.cachedReadModels.set(cand.digest, rebuilt);
				return rebuilt;
			} catch {
				return undefined;
			}
		},
		projectVocabulary: async (worktree: string, entryPaths?: string[]): Promise<string> => {
			const readContained = async (relPath: string): Promise<string> => {
				const safePath = resolveContainedWorktreePath(worktree, relPath);
				if (!safePath) return "";
				try { return await Bun.file(safePath).text(); } catch { return ""; }
			};
			const listMarkdown = (directory: string): string[] =>
				existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".md")).sort().slice(0, 40) : [];
			const standards = (await readContained("CODING_STANDARDS.md")).slice(0, 8000);
			const standardsBlock = standards.trim() ? `Standards:\n${standards}\n\n` : "";
			if (entryPaths && entryPaths.length > 0) {
				const blocks: string[] = [];
				for (const entry of entryPaths) {
					const safeTarget = resolveContainedWorktreePath(worktree, entry);
					if (!safeTarget || !existsSync(safeTarget)) continue;
					const entryStat = await statPath(safeTarget);
					if (entryStat.isDirectory()) {
						const names = listMarkdown(safeTarget);
						const readme = (await readContained(join(entry, "README.md"))).slice(0, 4000);
						if (names.length > 0) blocks.push(`Directory ${entry} — markdown files: ${names.join(", ")}${readme.trim() ? `\n${readme}` : ""}`);
					} else {
						const text = (await readContained(entry)).slice(0, 8000);
						if (text.trim()) blocks.push(`${entry}:\n${text}`);
					}
				}
				if (blocks.length > 0) {
					return `${standardsBlock}Project context:\n${blocks.join("\n\n")}\n`
						+ "For any directory listed above (or paths in GLOSSARY-MAP.md), use your read tool to inspect relevant rule or ADR files touching the changed paths. "
						+ "Flag any term that contradicts the vocabulary above, any decision this change contradicts, and any standards violation.\n\n";
				}
				return standardsBlock.trim() ? standardsBlock : "";
			}
			const glossary = (await readContained("GLOSSARY.md")).slice(0, 8000);
			const adrDir = resolveContainedWorktreePath(worktree, join("docs", "adr"));
			const adrs = adrDir && existsSync(adrDir) ? listMarkdown(adrDir) : [];
			const standardsText = [await readContained("CODING_STANDARDS.md"), await readContained("CONTRIBUTING.md")]
				.find(text => text.trim())?.slice(0, 8000) ?? "";
			if (!glossary && adrs.length === 0 && !standardsText) return "";
			return `Project vocabulary:\n${glossary || "(no GLOSSARY.md)"}\n`
				+ `Decisions on record (docs/adr): ${adrs.join(", ") || "none"}\n`
				+ (standardsText ? `Standards:\n${standardsText}\n` : "(no CODING_STANDARDS.md or CONTRIBUTING.md)\n")
				+ "Flag any term that contradicts the glossary, any decision this change contradicts, and any standards violation.\n\n";
		},

		checkChangedFilesWithinDeclared: async (view: RunView, head: string, declaredFiles: readonly string[]) => {
			if (declaredFiles.length === 0) return { ok: false, extra: ["(no declaredFiles specified)"] };
			const changed = (await rt.gitText(view.worktree, ["diff", "--name-only", `${view.currentIntegrationSha}..${head}`]))
				.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
			const declared = new Set(declaredFiles.map(f => f.replace(/^\.\//, "")));
			const extra = changed.filter(f => !declared.has(f));
			return { ok: extra.length === 0, extra };
		},
	};
	return rt;
}

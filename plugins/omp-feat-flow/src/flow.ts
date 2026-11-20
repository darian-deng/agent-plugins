import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, stat as statPath } from "node:fs/promises";
import { resolve } from "node:path";
import { reconcileInterruptedSync } from "./reconcile";
import { proposeKnowledge } from "./knowledge";
import { basename, isAbsolute, join } from "node:path";
import dependencies from "../resources/methods.json" with { type: "json" };
import { inspectRepository, prepare, sync, type PreparedWorktree } from "./git";
import { resolveMethods } from "./methods";
import { approvalPacket, coldReadPrompt, renderPacket } from "./questions";
import { runHelper, type HelperSdk } from "./helpers";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { captureTools, validateBinding } from "./binding";
import { deliver, type DeliveryPorts } from "./delivery";
import { deliveryBlockers } from "./evidence";
import { githubClient } from "./github";
import { linearClient, resolveLinearKey } from "./linear";
import { readProject } from "./run";
import { inspectUpdate } from "./update";
import { continuationCommand, defaultRun, ensureWorkspace, type Run } from "./workspace";

import {
	locateRun, openRun, RunBusyError, RunKernel,
	type Admission, type HostBinding, type RequestIntent, type RunOutcome,
} from "./run";

const dependenciesCore = dependencies.core;

/** Native tools with no worktree or external effect. Everything else is treated as a write. */
const READ_ONLY_TOOLS: Record<string, true> = {
	read: true, grep: true, glob: true, ls: true, lsp: true, web_search: true, web_fetch: true, todo: true, ask: true,
};
// The controlled signal tool writes nothing to the worktree: it submits one intent to the run outbox,
// whose own rules (identity, revision, single consumption) decide whether it advances.
const REQUEST_TOOLS: Record<string, true> = { feat_flow_request: true };
const SPAWNING_TOOLS: Record<string, true> = { task: true };

export type FlowCommand = "status" | "start" | "update" | "approve" | "finish" | "sync";
export type ToolEffect = "read" | "write" | "spawn";

export interface NativeToolAttempt {
	toolCallId: string;
	toolName: string;
}
export interface NativeLifecycleEvent {
	type: "session_start" | "session_stop" | "session_clear";
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
	currentTask: string | null;
	approvedScopeDigest: string | null;
	/** The one requirement issue this run delivers, once bound. */
	issue: string | null;
	/** Facts a recovery must show, never reconstruct: unresolved effects and open boundaries. */
	unresolvedOperations: number;
	unknownOperations: number;
	openBoundaries: string[];
	planSlices: number;
}
export interface ModelStatus {
	ready: boolean;
	reason: "ready" | "session-not-started" | "no-model-selected" | "credential-missing";
	provider: string | null;
	model: string | null;
	guidance: string | null;
}
export interface NativeHost {
	cwd(): string;
	sessionId(): string;
	readonly processInstanceId: string;
	readonly buildId: string;
	notify(text: string): void;
	modelStatus(): Promise<ModelStatus>;
	/** Native confirmation owned by the host UI; resolves only on an explicit answer. */
	confirm(title: string, message: string): Promise<boolean>;
	/** cmux is optional; when it is off the flow reports the real continuation command instead. */
	workspace: { enabled: boolean; run?: Run };
	/** Identity of the artifact the native installation reports, if readable. */
	installedRelease(): Promise<{ buildId: string; version: string } | null>;
	/** Optional delivery ports; tests inject fakes, production leaves this unset and uses the real clients. */
	deliveryPorts?(input: { worktree: string; repository: string; linearKey: string | null }): DeliveryPorts | null;
	/** The active tool names at this moment; the delivery binding is captured from the first call. */
	activeTools(): string[];
	/** The SDK entry points a helper session needs, plus the model the host is running. */
	helperSdk(): HelperSdk;
	modelRegistry(): ModelRegistry | undefined;
	model(): Model | undefined;
}
export interface FlowController {
	command(name: FlowCommand, args: string): Promise<void>;
	lifecycle(event: NativeLifecycleEvent): Promise<void>;
	context(): RecoveryProjection;
	beforeTool(call: NativeToolAttempt): Admission;
	request(intent: RequestIntent, requestId: string): Promise<RunOutcome>;
	/** A new session drops the old ownership but keeps which run this worktree is bound to. */
	rebindSession(): Promise<void>;
	dispose(): Promise<void>;
}

/** The one truthful receipt a recovery shows; blocked facts are named, never smoothed into "ready". */
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

export function effectOf(toolName: string): ToolEffect {
	if (SPAWNING_TOOLS[toolName]) return "spawn";
	return READ_ONLY_TOOLS[toolName] || REQUEST_TOOLS[toolName] ? "read" : "write";
}

const operations: Record<FlowCommand, string> = {
	status: "Report the current run: phase, readiness, wait reason, owner and approved scope.",
	start: "Create an isolated worktree and run for a requirement; binds the Linear issue when an identifier is given, otherwise the issue is bound later. Never creates duplicate branches or workspaces.",
	update: "Report which installed methods may be updated; never overwrite a modified or unknown copy.",
	sync: "Fetch the configured PR base into the run's private ref, rebase the owned work and record the new review base.",
	finish: "Independent review, sync to the PR base, push, open one PR, update the Linear issue, then close this run's owned workspace. Never merges or publishes.",
	approve: "Show the current candidate and its exact consequences in the native UI; only an explicit confirmation approves it.",
};

export function flowCommandDescription(name: FlowCommand): string {
	return operations[name];
}

export function createFlow(host: NativeHost): FlowController {
	let live: { kernel: RunKernel; binding: HostBinding; runId: string } | null = null;
	// The bound run survives a session change even though its ownership does not.
	let known: { repo: PreparedWorktree; runId: string } | null = null;
	let knownWorkspace: Awaited<ReturnType<typeof ensureWorkspace>> | null = null;
	// Captured once, before any helper session exists; a vanished or replaced server cannot satisfy it.
	const deliveryBinding = host.activeTools().some(name => name.startsWith("mcp__linear_")) ? captureTools(host.activeTools()) : null;
	let loading: Promise<void> | null = null;
	let unavailable: string | null = null;
	let disposed = false;
	/** Set by a real session clear; only an explicit native re-authorization clears it. */
	let writeRevoked = false;
	const modelOption = (model: Model | undefined) => model ? { model } : {};
	const registryOption = (registry: ModelRegistry | undefined) => registry ? { modelRegistry: registry } : {};

	const deny = (reason: string): Admission => ({
		allow: false, reason, runId: live?.runId ?? "", revision: null, ownerEpoch: null,
	});

	async function load(): Promise<void> {
		try {
			const sessionId = host.sessionId();
			if (!sessionId) {
				unavailable = "session-identity-unavailable";
				return;
			}
			const located = locateRun(await inspectRepository(host.cwd())) ?? known;
			if (!located) {
				unavailable = "run-not-initialized";
				return;
			}
			const binding: HostBinding = { processInstanceId: host.processInstanceId, sessionId, contextEpoch: 0 };
			const kernel = await openRun({
				repo: located.repo, runId: located.runId, buildId: host.buildId, mode: "owner", binding,
			});
			if (disposed) {
				await kernel.dispose();
				return;
			}
			live = { kernel, binding, runId: located.runId };
			known = { repo: located.repo, runId: located.runId };
		} catch (error) {
			// A clear is a fact about this session, not a transient load failure.
			unavailable = writeRevoked ? "context-cleared"
				: error instanceof RunBusyError ? "run-owned-elsewhere" : "run-state-unavailable";
		}
	}

	function ensureLoaded(): Promise<void> | null {
		if (live || unavailable || disposed) return null;
		loading ??= load();
		return loading;
	}

		const gitHead = (worktree: string): string => {
			const result = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"]);
			if (result.exitCode !== 0) throw new Error(`cannot read HEAD in ${worktree}: ${result.stderr.toString().slice(-300)}`);
			return result.stdout.toString().trim();
		};
		/** The project's own domain docs, bounded: the reviewer has no file access and no context files.
		 * Paths come from the project's own defaults (knowledge.entryPaths); the conventional
		 * GLOSSARY.md / docs/adr are only the fallback when a project declares none. */
		const projectVocabulary = async (worktree: string, entryPaths?: string[]): Promise<string> => {
			const read = async (path: string): Promise<string> => {
				try { return await Bun.file(join(worktree, path)).text(); } catch { return ""; }
			};
			const listMarkdown = async (directory: string): Promise<string[]> =>
				existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith(".md")).sort().slice(0, 40) : [];
			const standards = (await read("CODING_STANDARDS.md")).slice(0, 8000);
			const standardsBlock = standards.trim() ? `Standards:\n${standards}\n\n` : "";
			if (entryPaths && entryPaths.length > 0) {
				const blocks: string[] = [];
				for (const entry of entryPaths) {
					const target = join(worktree, entry);
					if (existsSync(target)) {
						const entryStat = await statPath(target);
						if (entryStat.isDirectory()) {
							const names = await listMarkdown(target);
							const readme = (await read(join(entry, "README.md"))).slice(0, 4000);
							if (names.length > 0) blocks.push(`ADR directory ${entry} — decisions on record: ${names.join(", ")}${readme.trim() ? `\n${readme}` : ""}`);
						} else {
							const text = (await read(entry)).slice(0, 8000);
							if (text.trim()) blocks.push(`${entry}:\n${text}`);
						}
					}
				}
				if (blocks.length > 0) {
					return `${standardsBlock}Project context:\n${blocks.join("\n\n")}\n`
						+ "Flag any term that contradicts the vocabulary above, any decision this change contradicts, and any standards violation.\n\n";
				}
				return standardsBlock.trim() ? standardsBlock : "";
			}
			const glossary = (await read("GLOSSARY.md")).slice(0, 8000);
			const adrDirectory = join(worktree, "docs", "adr");
			const adrs = existsSync(adrDirectory) ? readdirSync(adrDirectory).filter(name => name.endsWith(".md")).sort().slice(0, 40) : [];
			// The standards sources the upstream code-review skill mandates: the repo's own rule files.
			const standardsText = [await read("CODING_STANDARDS.md"), await read("CONTRIBUTING.md")]
				.find(text => text.trim())?.slice(0, 8000) ?? "";
			if (!glossary && adrs.length === 0 && !standardsText) return "";
			return `Project vocabulary:\n${glossary || "(no GLOSSARY.md)"}\n`
				+ `Decisions on record (docs/adr): ${adrs.join(", ") || "none"}\n`
				+ (standardsText ? `Standards:\n${standardsText}\n` : "(no CODING_STANDARDS.md or CONTRIBUTING.md)\n")
				+ "Flag any term that contradicts the glossary, any decision this change contradicts, and any standards violation.\n\n";
		};
		const gitText = async (worktree: string, command: string[]): Promise<string> => {
			const result = Bun.spawn(["git", "-C", worktree, ...command], { stdout: "pipe", stderr: "pipe" });
			const [stdout, , code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
			if (code !== 0) throw new Error(`git ${command[0]} failed in ${worktree}`);
			return stdout;
		};
		const syncRun = async (): Promise<void> => {
			if (!live) throw new Error(`No run is available: ${unavailable ?? "run-loading"}.`);
			const view = live.kernel.inspect();
			const unresolved = view.operations.filter(operation => operation.status === "dispatched" || operation.status === "unknown");
			if (unresolved.length > 0) {
				// An interrupted sync is reconciled from real Git state, never guessed from the ledger.
				if (unresolved.some(operation => operation.type !== "git-sync")) {
					throw new Error(`${unresolved.length} effect(s) are unsettled and are not a sync; reconcile them first.`);
				}
				const gitDir = view.git.worktreeGitDir;
				// The fetched base, and whether HEAD now sits on top of it, are read from Git; nothing is assumed.
				const baseRef = await gitText(view.worktree, ["ls-remote", "--heads", view.git.remote, view.git.prBase]).catch(() => "");
				const baseSha = /^([0-9a-f]{40})\s/m.exec(baseRef)?.[1] ?? null;
				const head = gitHead(view.worktree);
				let descends = false;
				if (baseSha && head !== baseSha) {
					descends = (await Bun.spawn(["git", "-C", view.worktree, "merge-base", "--is-ancestor", baseSha, head],
						{ stdout: "ignore", stderr: "ignore" }).exited) === 0;
				}
				const decision = reconcileInterruptedSync({
					rebasing: existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply")),
					porcelain: await gitText(view.worktree, ["status", "--porcelain"]),
					head, integrationSha: view.currentIntegrationSha, baseSha, headDescendsFromBase: descends,
				});
				if (decision.kind === "blocked") throw new Error(`the interrupted sync cannot be settled automatically (${decision.reason}); inspect it before continuing.`);
				for (const operation of unresolved) {
					await live.kernel.apply({ kind: "operation.settle", operationId: operation.id,
						outcome: decision.kind === "applied" ? "applied" : "not-applied",
						receipt: { target: operation.target, intentDigest: operation.intentDigest,
							reference: decision.kind === "applied" ? baseSha! : "reconciled-clean-tree" } }, live.binding);
				}
				if (decision.kind === "applied") {
					await live.kernel.apply({ kind: "sync", previousIntegrationSha: view.currentIntegrationSha, newIntegrationSha: baseSha! }, live.binding);
					host.notify(`reconciled ${unresolved.length} interrupted sync operation(s): the rebase had applied onto ${baseSha!.slice(0, 12)}.`);
				} else {
					host.notify(`reconciled ${unresolved.length} interrupted sync operation(s) from a clean worktree; nothing was applied.`);
				}
			}
			const operation = { id: `sync-${view.revision + 1}`, type: "git-sync" as const, target: view.git.prBase,
				intentDigest: createHash("sha256").update(`${view.runId}:${view.currentIntegrationSha}`).digest("hex") };
			await live.kernel.apply({ kind: "operation.prepare", operation }, live.binding);
			await live.kernel.apply({ kind: "operation.dispatch", operationId: operation.id }, live.binding);
			if (!known) throw new Error("The run's worktree is not bound in this session.");
			const result = await sync({ repo: { ...known.repo, currentIntegrationSha: view.currentIntegrationSha }, operationId: operation.id });
			if (result.outcome === "synced" || result.outcome === "unchanged") {
				// "unchanged" is a successful command with nothing applied; it must not settle as applied,
				// or the identical intent digest would block every retry at the same base.
				await live.kernel.apply({ kind: "operation.settle", operationId: operation.id,
					outcome: result.outcome === "unchanged" ? "not-applied" : "applied",
					receipt: { target: view.git.prBase, intentDigest: operation.intentDigest,
						reference: result.outcome === "unchanged" ? `unchanged:${view.currentIntegrationSha}` : result.newIntegrationSha } }, live.binding);
				if (result.outcome === "synced") {
					await live.kernel.apply({ kind: "sync", previousIntegrationSha: result.previousIntegrationSha,
						newIntegrationSha: result.newIntegrationSha }, live.binding);
				}
				host.notify(result.outcome === "unchanged" ? `${live.runId} is already on the current ${view.git.prBase} base`
					: `synced ${live.runId} onto ${result.newIntegrationSha.slice(0, 12)}; ${result.detail}`);
			} else {
				await live.kernel.apply({ kind: "operation.settle", operationId: operation.id, outcome: "not-applied",
					receipt: { target: view.git.prBase, intentDigest: operation.intentDigest, reference: result.outcome } }, live.binding);
				throw new Error(`sync ${result.outcome}: ${result.detail}`);
			}
		};
	return {
		async lifecycle(event) {
			if (event.type === "session_start") await ensureLoaded();
			if (event.type === "session_clear") {
				// Clearing the conversation revokes the old context's write readiness at once; the run, its
				// worktree and its evidence are untouched, and only a human re-authorization restores writes.
				// Even a session that never loaded a run must not inherit authority from before the clear.
				writeRevoked = true;
				if (!live) unavailable = "context-cleared";
				// Visible at the moment it happens: the operator sees that writes are revoked, not just later.
				host.notify("writes revoked after /clear: re-authorize with /feat-flow-start");
			}
		},
		context() {
			if (!live) {
				return { located: false, reason: unavailable ?? "run-loading", runId: null, revision: null, phase: null,
					readiness: null, waitingReason: null, ownerStatus: null, currentTask: null, approvedScopeDigest: null, issue: null,
					unresolvedOperations: 0, unknownOperations: 0, openBoundaries: [], planSlices: 0 };
			}
			const view = live.kernel.inspect();
			return { located: true, reason: null, runId: view.runId, revision: view.revision, phase: view.phase, issue: view.issue,
				readiness: view.readiness, waitingReason: view.waitingReason, ownerStatus: view.ownerStatus,
				currentTask: view.currentTask, approvedScopeDigest: view.approvedScope?.digest ?? null,
				unresolvedOperations: view.operations.filter(operation => operation.status === "dispatched").length,
				unknownOperations: view.operations.filter(operation => operation.status === "unknown").length,
				openBoundaries: view.grilling?.open ?? [], planSlices: view.plan?.slices.length ?? 0 };
		},
		beforeTool(call) {
			const effect = effectOf(call.toolName);
			if (effect === "read") return { allow: true, reason: "allowed", runId: live?.runId ?? "", revision: null, ownerEpoch: null };
			if (writeRevoked) return deny("context-cleared");
			if (!call.toolCallId) return deny("unattributed-tool-call");
			if (!live) {
				// A pending load cannot be resolved inside a synchronous admission decision: fail closed.
				ensureLoaded();
				return deny(unavailable ?? "run-loading");
			}
			return live.kernel.admit({ toolCallId: call.toolCallId, effect }, live.binding);
		},
		async command(name, arguments_) {
			if (name === "start") {
				if (!live && writeRevoked) {
					const confirmed = await host.confirm("Re-authorize this session after /clear?",
						"Clearing the conversation revoked this session's write authority. Approving only re-opens the saved run; "
						+ "it grants no merge, publication or delivery.");
					if (!confirmed) throw new Error("Cancelled: this session stays unauthorized after the clear.");
					writeRevoked = false;
					unavailable = null;
					await load();
					const reopened = ((): { kernel: RunKernel } | null => live)();
					host.notify(reopened ? `re-opened ${reopened.kernel.inspect().runId} after the clear; writes still follow its approved scope.`
						: "no run to reopen after the clear.");
					return;
				}
				if (live && writeRevoked) {
					const confirmed = await host.confirm("Re-authorize this session after /clear?",
						"Clearing the conversation revoked this session's write authority. Approving restores write access only for the "
						+ "already approved scope; it grants no merge, publication or delivery.");
					if (!confirmed) throw new Error("Cancelled: this session stays unauthorized after the clear.");
					const current = live.kernel.inspect();
					const scope = current.approvedScope;
					// The same confirmation also restores the kernel's own readiness when it was blocked by the clear.
					if (current.readiness === "blocked" && scope) {
						await live.kernel.apply({ kind: "owner.authorize", source: "native-ui", approved: true, runId: live.runId,
							digest: scope.digest, candidateRevision: scope.revision, ownerEpoch: current.ownerEpoch }, live.binding);
					}
					writeRevoked = false;
					host.notify(`re-authorized ${live.runId} after the clear.`);
					return;
				}
				if (live) {
					// A session that already opened a bound run may only re-authorize its blocked scope.
					const view = live.kernel.inspect();
					const scope = view.approvedScope;
					if (view.readiness !== "blocked" || !scope) throw new Error(`This session already owns run ${live.runId}.`);
					const confirmed = await host.confirm(`Authorize this session as owner of ${live.runId}?`,
						`The saved design is unchanged: scope ${scope.scope}. Approving here only lets this session continue that approved `
						+ "work; it grants no merge, publication or delivery, and an unresolved effect still blocks writes.");
					if (!confirmed) throw new Error("Cancelled: this session stays unauthorized for the run.");
					await live.kernel.apply({ kind: "owner.authorize", source: "native-ui", approved: true, runId: live.runId,
						digest: scope.digest, candidateRevision: scope.revision, ownerEpoch: live.kernel.inspect().ownerEpoch }, live.binding);
					host.notify(`authorized this session for ${live.runId}; nothing was created.`);
					return;
				}
				// Dependency preflight runs before any issue, branch, worktree or workspace exists.
				const methods = await resolveMethods(dependenciesCore);
				if (methods.guidance) throw new Error(methods.guidance);
				const model = await host.modelStatus();
				if (!model.ready) throw new Error(model.guidance ?? `No usable model: ${model.reason}.`);
				const input = arguments_.trim();
				// An existing requirement is addressed by exactly its identifier or its Linear URL; the slug derives from it.
				const bare = /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(input);
				const url = /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]+)-(\d+)(?:[/?#].*)?$/.exec(input);
				const issueMatch = bare ?? url;
				const slug = issueMatch ? `${issueMatch[1]!.toLowerCase()}-${issueMatch[2]}` : input;
				const boundIssue = issueMatch ? `${issueMatch[1]}-${issueMatch[2]}` : null;
				if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error("start needs a lowercase requirement slug or a Linear identifier, for example /feat-flow-start desk-1234.");
				const location = await inspectRepository(host.cwd());
				if (boundIssue) {
					// Validate the binding before any worktree exists: a typo or a foreign team's issue must fail here.
					// An offline run (tests, air-gapped machines) binds without a remote read and says so.
					const key = process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE === "1" ? null : await resolveLinearKey();
					if (key) {
						const described = await linearClient(key).describe(boundIssue).catch(() => null);
						if (!described) throw new Error(`${boundIssue} is not readable with the available Linear credential.`);
						const defaults = readProject(location.commonDir)?.defaults;
						if (defaults && described.teamId !== defaults.linear.teamId) {
							throw new Error(`${described.identifier} belongs to another team than the project's configured Linear team.`);
						}
					} else {
						host.notify(`bound ${boundIssue} without a Linear read: no credential is available (or the flow is offline) to verify it now.`);
					}
				}
				const existing = locateRun(location) ?? known;
				if (existing) {
					// Resuming a bound run: no new issue, branch, worktree or workspace; only ownership is re-granted.
					const binding: HostBinding = { processInstanceId: host.processInstanceId, sessionId: host.sessionId(), contextEpoch: 0 };
					const kernel = await openRun({ repo: existing.repo, runId: existing.runId, buildId: host.buildId, mode: "owner", binding });
					live = { kernel, binding, runId: existing.runId };
					known = { repo: existing.repo, runId: existing.runId };
					const view = kernel.inspect();
					const scope = view.approvedScope;
					if (view.readiness === "blocked" && scope) {
						const confirmed = await host.confirm(`Authorize this session as owner of ${existing.runId}?`,
							`The saved design is unchanged: scope ${scope.scope}. Approving here only lets this session continue that approved `
							+ "work; it grants no merge, publication or delivery, and an unresolved effect still blocks writes.");
						if (!confirmed) {
							await kernel.dispose();
							live = null;
							throw new Error("Cancelled: this session stays unauthorized for the run.");
						}
						await kernel.apply({ kind: "owner.authorize", source: "native-ui", approved: true, runId: existing.runId,
							digest: scope.digest, candidateRevision: scope.revision, ownerEpoch: kernel.inspect().ownerEpoch }, binding);
					}
					host.notify(`resumed ${existing.runId}; nothing was created.`);
					return;
				}
				// The project's own defaults decide the base; a generic default is never baked in.
				const defaults = readProject(location.commonDir)?.defaults;
				if (!defaults) throw new Error("This project has no omp-feat-flow defaults; record git.remote, git.startRef and git.prBase before starting.");
				const worktreeRoot = isAbsolute(defaults.git.worktreeRoot) ? defaults.git.worktreeRoot : join(location.repo, "..", defaults.git.worktreeRoot);
				const targetWorktree = join(worktreeRoot, slug);
				const repo = await prepare({ repo: location.repo, remote: defaults.git.remote, startRef: defaults.git.startRef,
					prBase: defaults.git.prBase, runId: slug, branch: `feat/${slug}`, worktree: targetWorktree });
				const binding: HostBinding = { processInstanceId: host.processInstanceId, sessionId: host.sessionId(), contextEpoch: 0 };
				let kernel: RunKernel;
				try {
					kernel = await RunKernel.create({ repo, runId: slug, buildId: host.buildId, mode: "owner", binding });
				} catch (error) {
					// Compensate only this attempt's own resources; an existing worktree or branch is never touched.
					const rollback = async (): Promise<void> => {
						const run = (command: string[]) => Bun.spawn(["git", "-C", location.repo, ...command], { stdout: "ignore", stderr: "ignore" }).exited;
						await run(["worktree", "remove", "--force", targetWorktree]);
						await run(["branch", "-D", `feat/${slug}`]);
						await run(["update-ref", "-d", `refs/omp-feat-flow/start/${slug}`]);
					};
					await rollback().catch(() => {});
					throw error;
				}
				if (boundIssue) await kernel.apply({ kind: "bindIssue", issue: boundIssue }, binding);
				live = { kernel, binding, runId: slug };
				known = { repo, runId: slug };
				const workspace = await ensureWorkspace({ runId: slug, worktree: repo.worktree, startCommand: "omp" },
					host.workspace.enabled ? host.workspace.run ?? defaultRun : async () => ({ code: 127, stdout: "", stderr: "cmux disabled" }));
				knownWorkspace = workspace;
				await kernel.apply({ kind: "workspace.record", workspace: { workspaceId: workspace.workspaceId, verified: workspace.verified,
					continuation: workspace.continuation, handoff: workspace.handoff } }, binding);
				host.notify(`run ${slug} created at ${repo.worktree}; workspace ${workspace.handoff === "switched" ? `switched to ${workspace.workspaceId}` : "not switched"}. `
					+ `Continue with: ${workspace.continuation}. The tracking issue is not created yet.`);
				return;
			}
			if (name === "approve") {
				await ensureLoaded();
				if (!live) throw new Error(`No run is available: ${unavailable ?? "run-loading"}.`);
				const before = live.kernel.inspect();
				// A knowledge correction has its own packet and its own approval; it grants no write scope.
				const knowledge = before.knowledgeCandidate;
				if (knowledge && !before.candidate) {
					const root = resolve(before.worktree);
					const proposal = await proposeKnowledge({ root, candidates: [knowledge] });
					if (!proposal.change) throw new Error(`No knowledge change to approve: ${proposal.reason}`);
					const diffText = proposal.changes.map(change => `## ${change.path} (${change.status})\n${change.diff.join("\n")}`).join("\n\n");
					const packetText = `Knowledge correction for ${live.runId}\nReason: ${knowledge.reason}\n\n${diffText}`;
					const cold = await runHelper(host.helperSdk(), { kind: "cold-read", cwd: before.worktree,
						prompt: coldReadPrompt(approvalPacket({ runId: live.runId, candidateRevision: before.candidateRevision,
							content: packetText, scope: knowledge.path, base: before.currentIntegrationSha })),
						...modelOption(host.model()), ...registryOption(host.modelRegistry()),
						binding: { taskId: live.runId, epoch: before.ownerEpoch, snapshotDigest: before.configDigest } });
					if (/^\s*NOT\b/i.test(cold.text)) throw new Error(`the knowledge packet was not answerable to a cold reader: ${cold.text.slice(0, 400)}`);
					const [title, ...rest] = packetText.split("\n");
					const confirmed = await host.confirm(title ?? "Approve this knowledge correction?",
						`${rest.join("\n")}\n\nApproving writes exactly this file content and nothing else.`);
					if (!confirmed) throw new Error("Cancelled: the knowledge file is untouched.");
					const after = live.kernel.inspect();
					if (after.knowledgeCandidate?.path !== knowledge.path || after.candidate) {
						throw new Error("The knowledge candidate changed while you were deciding; approve it again.");
					}
					await live.kernel.apply({ kind: "approve", source: "native-ui", approved: true, runId: live.runId,
						digest: createHash("sha256").update(JSON.stringify(knowledge)).digest("hex"),
						candidateRevision: 0, ownerEpoch: after.ownerEpoch }, live.binding);
					host.notify(`applied the knowledge correction to ${knowledge.path}; nothing else was granted.`);
					return;
				}
				const candidate = before.candidate;
				if (!candidate) throw new Error("There is no candidate proposal to approve.");
				if (before.readiness !== "ready") throw new Error(`Recovery is not ready (${before.waitingReason ?? before.readiness}); approve is refused.`);
				const material = JSON.parse(readFileSync(candidate.contentPath, "utf8")) as { content?: unknown; scope?: unknown };
				// One rendering: the human's confirm shows exactly the packet a cold reader would receive.
				const packet = approvalPacket({ runId: live.runId, candidateRevision: candidate.revision,
					content: String(material.content), scope: String(material.scope), base: before.currentIntegrationSha });
				const rendered = renderPacket(packet);
				// Every packet is cold-read first: a reader with no tools must be able to answer it from the text alone.
				const cold = await runHelper(host.helperSdk(), { kind: "cold-read", cwd: before.worktree,
					prompt: coldReadPrompt(packet), ...modelOption(host.model()), ...registryOption(host.modelRegistry()),
					binding: { taskId: live.runId, epoch: before.ownerEpoch, snapshotDigest: before.configDigest } });
				if (/^\s*NOT\b/i.test(cold.text)) throw new Error(`the packet was not answerable to a cold reader: ${cold.text.slice(0, 400)}`);
				const [title, ...rest] = rendered.split("\n");
				const confirmed = await host.confirm(title ?? "Approve this candidate?", `${rest.join("\n")}\n\nCold read: ${cold.text.slice(0, 400)}`);
				if (!confirmed) throw new Error("Cancelled: implementation stays closed.");
				const after = live.kernel.inspect();
				if (after.readiness !== "ready" || after.candidate?.digest !== candidate.digest || after.candidate.revision !== candidate.revision) {
					throw new Error("The candidate changed while you were deciding; approve the current one again.");
				}
				await live.kernel.apply({ kind: "approve", source: "native-ui", approved: true, runId: live.runId,
					digest: candidate.digest, candidateRevision: candidate.revision, ownerEpoch: after.ownerEpoch }, live.binding);
				host.notify(`approved ${live.runId} revision ${candidate.revision}.`);
				return;
			}
			if (name === "sync") {
				await syncRun();
				return;
			}
			if (name === "finish") {
				if (!live) throw new Error(`No run is available: ${unavailable ?? "run-loading"}.`);
				const view = live.kernel.inspect();
				const unresolved = view.operations.filter(operation => operation.status === "dispatched" || operation.status === "unknown");
				if (unresolved.length > 0) throw new Error(`Refusing to finish: ${unresolved.length} effect(s) are unsettled; reconcile them first.`);

				// Sync first: the review must judge the exact state that will be pushed, and a rebase that
				// moved the base would invalidate any proof taken before it.
				await syncRun();
				const synced = live.kernel.inspect();
				const scope = synced.approvedScope;
				if (!scope) throw new Error("finish needs an approved scope before it can deliver.");
				const head = gitHead(synced.worktree);
				const identity = { worktree: synced.worktree, base: synced.currentIntegrationSha, head,
					candidateDigest: scope.digest, configDigest: synced.configDigest, inputRevision: synced.inputRevision };
				const currentReview = synced.proofs.some(proof => proof.kind === "review"
					&& proof.worktree === identity.worktree && proof.base === identity.base && proof.head === identity.head
					&& proof.candidateDigest === identity.candidateDigest && proof.configDigest === identity.configDigest
					&& proof.inputRevision === identity.inputRevision);
				if (!currentReview) {
					// The reviewer sees the exact diff and the project's own vocabulary: helpers run with no
					// context files, so the glossary and ADR list have to be part of the prompt.
					const diff = await gitText(synced.worktree, ["diff", "--stat", `${identity.base}..${identity.head}`]);
					const patch = await gitText(synced.worktree, ["diff", `${identity.base}..${identity.head}`]);
					// The full patch is sealed where the reviewer can read it; a truncated inline copy would
					// let a large change pass review on evidence the reviewer never saw.
					const materials = join(synced.commonDir, "omp-feat-flow", "runs", synced.runId, "materials");
					await mkdir(materials, { recursive: true, mode: 0o700 });
					const patchPath = join(materials, `review-${identity.head.slice(0, 12)}.patch`);
					await Bun.write(patchPath, patch);
					const vocabulary = await projectVocabulary(synced.worktree, synced.project?.defaults.knowledge.entryPaths);
					const review = await runHelper(host.helperSdk(), { kind: "review", cwd: synced.worktree,
						prompt: `Review this change against the approved scope: ${scope.scope}.\n\n`
							+ `${vocabulary}\nThe full diff is sealed at ${patchPath}; read it with the read tool.\n`
							+ `Changed files:\n${diff.slice(0, 4000)}\n\nHead of the diff (full version in the sealed file):\n${patch.slice(0, 60000)}\n\n`
							+ "Structure your review under exactly two sections: ## Standards and ## Spec. "
							+ "Standards checks the standards text above and the project's vocabulary; Spec checks the change matches the approved scope. "
							+ "Your answer MUST contain both headings. After the two sections, answer on the first line with exactly ACCEPT if both axes pass, otherwise start with REJECT.",
						...modelOption(host.model()), ...registryOption(host.modelRegistry()),
						binding: { taskId: synced.runId, epoch: synced.ownerEpoch, snapshotDigest: synced.configDigest } });
					// An exact verdict: a mixed or hedged answer is not an acceptance.
					const verdict = review.text.trim().split(/\r?\n/)[0]?.trim() ?? "";
					const twoAxes = /##\s*Standards\b/.test(review.text) && /##\s*Spec\b/.test(review.text);
					if (verdict !== "ACCEPT" || !twoAxes) {
						throw new Error(`independent review did not accept (verdict ${verdict || "empty"}, axes ${twoAxes ? "present" : "missing"}): ${review.text.slice(0, 500)}`);
					}
					await live.kernel.apply({ kind: "proof.record", proof: { kind: "review", name: "independent", ...identity,
						detail: review.text.slice(0, 2000) } }, live.binding);
				}
				if (synced.phase !== "delivery") {
					await live.kernel.apply({ kind: "beginDelivery" }, live.binding);
					host.notify(`independent review accepted; ${live.runId} entered delivery.`);
				}
				const delivering = live.kernel.inspect();
				const issue = delivering.issue;
				if (!issue) throw new Error("delivery needs the one requirement issue; bind it before finishing (no issue is created implicitly).");
				const defaults = delivering.project?.defaults ?? readProject(delivering.commonDir)?.defaults;
				if (!defaults) throw new Error("delivery needs the project defaults: repository, Linear team and status mapping.");
				const linearKey = await resolveLinearKey();
				const injected = host.deliveryPorts?.({ worktree: delivering.worktree, repository: defaults.github.repository, linearKey });
				if (!injected && !linearKey) throw new Error("no Linear credential is available; delivery is blocked instead of being faked.");
				const ports: DeliveryPorts = injected ?? {
					git: async (command) => {
						const result = Bun.spawnSync(["git", "-C", delivering.worktree, ...command]);
						return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
					},
					github: githubClient(defaults.github.repository),
					linear: linearClient(linearKey!),
				};
				const delivered = await deliver({
					binding: { captured: deliveryBinding ?? captureTools(host.activeTools()), current: host.activeTools(),
						expect: { server: "linear", tool: "get_issue" } },
					runId: delivering.runId, worktree: delivering.worktree, remote: delivering.git.remote, prBase: delivering.git.prBase,
					branch: delivering.branch, head, integrationBase: delivering.currentIntegrationSha, issue,
					reviewState: defaults.linear.statusMapping.inReview, title: `${delivering.branch} (${delivering.runId})`,
					proofs: delivering.proofs, current: { worktree: delivering.worktree, base: delivering.currentIntegrationSha, head,
						candidateDigest: delivering.approvedScope?.digest ?? "", configDigest: delivering.configDigest,
						inputRevision: delivering.inputRevision },
				}, ports);
				if (delivered.outcome !== "delivered") throw new Error(`delivery ${delivered.outcome}: ${delivered.detail}`);
				host.notify(`delivered ${issue} with PR #${delivered.pr?.number}; Linear ${delivered.linear?.identifier} ${delivered.linear?.state}.`);
				const run = host.workspace.enabled ? host.workspace.run ?? defaultRun : async () => ({ code: 127, stdout: "", stderr: "cmux disabled" });
				// A later session learns the owned workspace from the run, not from this process's memory.
				const owned = knownWorkspace?.workspaceId
					? { workspaceId: knownWorkspace.workspaceId, verified: knownWorkspace.verified, continuation: knownWorkspace.continuation }
					: live.kernel.inspect().workspace;
				if (owned?.workspaceId && owned.verified) {
					const id = owned.workspaceId;
					let closed = false;
					for (let attempt = 0; attempt < 20 && !closed; attempt += 1) {
						if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 150));
						const result = await run("cmux", ["workspace", "close", id]);
						if (result.code === 0) closed = true;
					}
					if (!closed) throw new Error(`Delivery succeeded, but cleanup failed: the owned workspace ${id} could not be closed. `
						+ `The PR, branch and worktree are untouched; close it with: cmux workspace close ${id}`);
					await live.kernel.apply({ kind: "workspace.record", workspace: null }, live.binding);
					host.notify(`closed ${id} for ${live.runId}; the PR, branch and worktree are untouched.`);
				} else {
					host.notify(`no owned workspace to close for ${live.runId}; continue with: ${owned?.continuation ?? continuationCommand(view.worktree, view.runId)}`);
				}
				knownWorkspace = null;
				return;
			}
			if (name === "update") {
				// Read-only: a method is replaced only on explicit consent for a source-known, unmodified copy.
				const methods = await resolveMethods(dependenciesCore);
				const lines = methods.methods.map(method =>
					`${method.name}: ${method.status}${method.update.permitted ? " (update permitted)" : ` (preserved: ${method.update.reason})`}`);
				const installed = await host.installedRelease();
				const unresolved = live ? live.kernel.inspect().operations.filter(operation => operation.status === "dispatched" || operation.status === "unknown").length : 0;
				const assessment = inspectUpdate({ loadedBuildId: process.env.OMP_FEAT_FLOW_BUILD_ID ?? "unknown", installed, unresolvedEffects: unresolved });
				const text = `${lines.join("; ")}. Source ${methods.ref?.slice(0, 12) ?? "unknown"}; nothing was downloaded or overwritten. `
					+ `Build: ${assessment.relation} (${assessment.detail}).`;
				host.notify(text);
				return;
			}
			await ensureLoaded();
			const view = this.context();
			const workspaceSuffix = knownWorkspace ? `; workspace ${knownWorkspace.workspaceId ?? "none"} (${knownWorkspace.handoff})` : "";
			if (view.located && live) {
				const run = live.kernel.inspect();
				const head = (() => { try { return gitHead(run.worktree); } catch { return run.currentIntegrationSha; } })();
				const stale = deliveryBlockers(run.proofs, { worktree: run.worktree, base: run.currentIntegrationSha, head,
					candidateDigest: run.approvedScope?.digest ?? "", configDigest: run.configDigest, inputRevision: run.inputRevision });
				const installed = await host.installedRelease();
				const build = inspectUpdate({ loadedBuildId: process.env.OMP_FEAT_FLOW_BUILD_ID ?? "unknown", installed, unresolvedEffects: 0 });
				host.notify(`baseline ${run.currentIntegrationSha.slice(0, 12)} (start ${run.startSha.slice(0, 12)}), head ${head.slice(0, 12)}, `
					+ `issue ${run.issue ?? "unbound"}, proofs ${run.proofs.length}${stale.length ? ` (${stale.length} stale)` : ""}, `
					+ `build ${build.relation}`);
				host.notify(`next: ${run.knowledgeCandidate ? `approve the knowledge correction for ${run.knowledgeCandidate.path}`
					: !run.approvedScope ? "propose and approve a plan" : run.phase === "delivery" ? "finish to deliver and clean up" : "implement, then finish"}`);
			}
			// One line carries both facts: a second toast would replace the first in the UI.
			const revokedSuffix = writeRevoked ? "; writes revoked after /clear: re-authorize with /feat-flow-start" : "";
			host.notify((view.located
				? `run ${view.runId} r${view.revision} ${view.phase} ${view.readiness}${view.waitingReason ? ` (${view.waitingReason})` : ""}, owner ${view.ownerStatus}, approved ${view.approvedScopeDigest ? "yes" : "no"}`
				: `no run: ${view.reason}`) + revokedSuffix);
			if (view.located) host.notify(`${view.runId}${workspaceSuffix}`);
		},
		async request(intent, requestId) {
			await ensureLoaded();
			if (!live) throw new Error(`No run is available: ${unavailable ?? "run-loading"}.`);
			return live.kernel.apply({ kind: "request.submit", requestId, expectedRevision: live.kernel.inspect().revision, intent },
				live.binding);
		},
		async rebindSession() {
			await loading;
			await live?.kernel.dispose();
			live = null;
			loading = null;
			unavailable = null;
		},
		async dispose() {
			disposed = true;
			await loading;
			await live?.kernel.dispose();
			live = null;
		},
	};
}

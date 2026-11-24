import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import {
	effectiveRemote,
	effectiveStartRef,
	readProject,
	resolveWorktreeRoot,
	sha256Hex,
	type UserConfigV1,
} from "./config";
import { defaultUiFromHost, type FlowRuntime } from "./flow-context";
import { discoverRuns, inspectRepository, prepare, type PreparedWorktree } from "./git";
import { linearClient, resolveLinearKey } from "./linear";
import { verifyBundledMethods } from "./methods";
import { ensureProjectOnboarding, ensureUserOnboarding } from "./onboarding";
import { locateRun, openRun, provisionRun, recordProvisionedWorkspace, type HostBinding } from "./run";
import {
	closeWorkspace,
	continuationCommand,
	defaultRun,
	ensureWorkspace,
	findWorkspace,
	isCmuxEnabled,
	selectWorkspace,
	shellQuote,
} from "./workspace";

function escapeRegExp(raw: string): string {
	return raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveSlugFromDescription(description: string): string {
	const cleaned = description.trim();
	if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(cleaned)) {
		return cleaned;
	}
	const hash8 = sha256Hex(cleaned).slice(0, 8);
	const asciiTokens = cleaned
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (asciiTokens.length === 0) {
		return `req-${hash8}`;
	}
	let prefix = "";
	for (const tok of asciiTokens) {
		const next = prefix ? `${prefix}-${tok}` : tok;
		if (next.length > 28) break;
		prefix = next;
	}
	if (!prefix) prefix = asciiTokens[0]!.slice(0, 28);
	return `${prefix}-${hash8.slice(0, 6)}`.slice(0, 48);
}

function parseStartTarget(raw: string, teamKey?: string): { slug: string; boundIssue: string | null; initialTask: string | null } {
	const input = raw.trim();
	if (!input) {
		throw new Error("请提供需求描述或 Linear 单号/链接，例如 /feat-flow-start 登录超时自动重试 或 /feat-flow-start DESK-1234。");
	}
	const bare = /^([A-Z][A-Z0-9]+)-(\d+)$/.exec(input);
	const lowerIssue = teamKey ? new RegExp(`^(${escapeRegExp(teamKey)})-(\\d+)$`, "i").exec(input) : null;
	const url = /^https?:\/\/linear\.app\/[^/]+\/issue\/([a-z][a-z0-9]+)-(\d+)(?:[/?#].*)?$/i.exec(input);
	const issueMatch = bare ?? url ?? (lowerIssue ? [input, teamKey!, lowerIssue[2]!] : null);
	if (issueMatch) {
		return {
			slug: `${issueMatch[1]!.toLowerCase()}-${issueMatch[2]}`,
			boundIssue: `${issueMatch[1]!.toUpperCase()}-${issueMatch[2]}`,
			initialTask: null,
		};
	}
	return {
		slug: deriveSlugFromDescription(input),
		boundIssue: null,
		initialTask: input.slice(0, 800),
	};
}

async function verifyLinearIssue(rt: FlowRuntime, issueId: string, commonDir: string): Promise<string | null> {
	const key = process.env.OMP_FEAT_FLOW_LINEAR_OFFLINE === "1" ? null : await resolveLinearKey();
	if (key) {
		const described = await linearClient(key).describe(issueId).catch(() => null);
		if (!described) throw new Error(`${issueId} is not readable with the available Linear credential.`);
		const proj = readProject(commonDir)?.config;
		if (proj?.linear?.teamId && described.teamId !== proj.linear.teamId) {
			throw new Error(`${described.identifier} belongs to another team than the project's configured Linear team.`);
		}
		if (described.title) {
			const excerpt = described.description?.trim().replace(/\s+/g, " ").slice(0, 400);
			return excerpt ? `${described.identifier}: ${described.title} — ${excerpt}`.slice(0, 800) : `${described.identifier}: ${described.title}`.slice(0, 800);
		}
		return null;
	}
	rt.host.notify(`bound ${issueId} without a Linear read: no credential is available (or the flow is offline) to verify it now.`);
	return null;
}

async function cleanupFailedProvision(repoPath: string, slug: string, worktreePath: string, commonDir: string): Promise<void> {
	const runGit = (command: string[]) =>
		Bun.spawn(["git", "-C", repoPath, ...command], { stdout: "ignore", stderr: "ignore" }).exited;
	await runGit(["worktree", "remove", "--force", worktreePath]).catch(() => {});
	await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
	await runGit(["branch", "-D", `feat/${slug}`]).catch(() => {});
	await runGit(["update-ref", "-d", `refs/omp-feat-flow/start/${slug}`]).catch(() => {});
	await rm(join(commonDir, "omp-feat-flow", "runs", slug), { recursive: true, force: true }).catch(() => {});
}

function fallbackUserConfig(): UserConfigV1 {
	return {
		schemaVersion: 1,
		onboarding: { status: "completed", completedSteps: ["welcome", "models", "linear", "github", "cmux"] },
		roles: { author: null, scout: { model: "default", effort: "medium" }, coldReader: { model: "default", effort: "medium" }, reviewer: { model: "default", effort: "high" } },
		integrations: { linear: { enabled: false, credentialSource: "none" }, githubCliChecked: true, cmuxPreference: "auto" },
	};
}

async function runReconfigureMenu(rt: FlowRuntime, modeArg: string): Promise<void> {
	const ui = defaultUiFromHost(rt.host);
	let mode = modeArg.trim().toLowerCase();
	if (!mode && ui.hasUI) {
		const picked = await ui.select("选择要修改的配置层", [
			"修改全部配置（个人本机 + 当前仓库）",
			"仅修改个人本机配置（模型 / Linear Key / cmux）",
			"仅修改当前仓库配置（prBase / remote / Linear 团队）",
		]);
		if (!picked) return;
		mode = picked.includes("个人本机") ? "user" : picked.includes("当前仓库") ? "project" : "all";
	}
	if (!mode) mode = "all";
	if ((mode === "user" || mode === "all") && rt.host.onboarding?.enabled) {
		rt.cachedUserConfig = await ensureUserOnboarding({
			ui,
			availableModels: rt.host.onboarding.availableModels(),
			resolveModel: rt.host.onboarding.resolveModel,
			hasProviderKey: rt.host.onboarding.hasProviderKey,
			forceReconfigure: true,
			...(rt.host.onboarding.userConfigPath ? { configPath: rt.host.onboarding.userConfigPath } : {}),
		});
	}
	if (mode === "project" || mode === "all") {
		const loc = await inspectRepository(rt.host.cwd());
		await ensureProjectOnboarding({
			cwd: rt.host.cwd(),
			commonDir: loc.commonDir,
			ui,
			userConfig: rt.cachedUserConfig ?? fallbackUserConfig(),
			forceReconfigure: true,
		});
	}
}

export async function executeStart(rt: FlowRuntime, arguments_: string): Promise<void> {
	const ui = defaultUiFromHost(rt.host);
	const trimmedArg = arguments_.trim();
	if (/^config(?:\s+(?:user|project|all))?$/i.test(trimmedArg)) {
		const subMode = trimmedArg.split(/\s+/)[1] ?? "";
		await runReconfigureMenu(rt, subMode);
		return;
	}

	if (rt.host.onboarding?.enabled) {
		rt.cachedUserConfig = await ensureUserOnboarding({
			ui,
			availableModels: rt.host.onboarding.availableModels(),
			resolveModel: rt.host.onboarding.resolveModel,
			hasProviderKey: rt.host.onboarding.hasProviderKey,
			...(rt.host.onboarding.userConfigPath ? { configPath: rt.host.onboarding.userConfigPath } : {}),
		});
	}

	if (rt.live) {
		let view = rt.live.kernel.inspect();
		const scope = view.approvedScope;
		if (trimmedArg) {
			const { boundIssue } = parseStartTarget(trimmedArg, view.project?.config.linear?.teamKey);
			if (boundIssue) {
				if (view.issue && view.issue !== boundIssue) throw new Error(`This run already delivers ${view.issue}.`);
				if (!view.issue) {
					await verifyLinearIssue(rt, boundIssue, view.commonDir);
					await rt.live.kernel.apply({ kind: "bindIssue", issue: boundIssue }, rt.live.binding);
					rt.host.notify(`bound ${boundIssue} to ${rt.live.runId}.`);
					view = rt.live.kernel.inspect();
					if (view.readiness !== "blocked") return;
				}
			}
		}
		if (view.readiness !== "blocked") throw new Error(`This session already owns run ${rt.live.runId}.`);
		const hasUnsettled = view.operations.some(op => op.status === "dispatched" || op.status === "unknown");
		if (!scope) {
			if (hasUnsettled) {
				throw new Error(`Run ${rt.live.runId} has unsettled operations; reconcile with /feat-flow-sync or /feat-flow-approve first.`);
			}
			await rt.live.kernel.apply({ kind: "restore" }, rt.live.binding);
			rt.needsRecoveryBrief = true;
			rt.host.notify(`restored alignment session for ${rt.live.runId}.`);
			return;
		}
		const confirmed = await rt.host.confirm(
			`Authorize this session as owner of ${rt.live.runId}?`,
			`The saved design is unchanged: scope ${scope.scope}. Approving here only lets this session continue that approved `
			+ "work; it grants no merge, publication or delivery, and an unresolved effect still blocks writes.",
		);
		if (!confirmed) throw new Error("Cancelled: this session stays unauthorized for the run.");
		await rt.live.kernel.apply({
			kind: "owner.authorize", source: "native-ui", approved: true, runId: rt.live.runId,
			digest: scope.digest, candidateRevision: scope.revision, ownerEpoch: rt.live.kernel.inspect().ownerEpoch,
		}, rt.live.binding);
		rt.host.notify(`authorized this session for ${rt.live.runId}; nothing was created.`);
		return;
	}

	const bundle = await verifyBundledMethods();
	if (!bundle.valid) {
		throw new Error(`Bundled private skills invalid (${[...bundle.missing, ...bundle.mismatched].join(", ")}); reinstall omp-feat-flow.`);
	}
	const model = await rt.host.modelStatus();
	if (!model.ready) throw new Error(model.guidance ?? `No usable model: ${model.reason}.`);

	const location = await inspectRepository(rt.host.cwd());
	const projResolved = readProject(location.commonDir) ?? (await ensureProjectOnboarding({
		cwd: rt.host.cwd(),
		commonDir: location.commonDir,
		ui,
		userConfig: rt.cachedUserConfig ?? fallbackUserConfig(),
	}));
	const proj = projResolved.config;

	let rawArg = trimmedArg;
	let selectedExistingRunId: string | null = null;
	const preCatalog = await discoverRuns(location.commonDir, location.repo);
	if (!rawArg && !locateRun(location)) {
		if (ui.hasUI) {
			const runOptions = preCatalog.runs.map(r => {
				const excerpt = r.initialTask ? ` — ${r.initialTask.replace(/\s+/g, " ").slice(0, 42)}` : "";
				return `${r.runId}${excerpt} (${r.issue ?? "未绑单"} · ${r.phase})`;
			});
			const newOpt = "+ 启动新需求...";
			const cfgOpt = "⚙ 修改个人 / 当前仓库配置...";
			const picked = await ui.select("选择已有需求、创建新需求或修改配置", [
				...runOptions,
				newOpt,
				cfgOpt,
			]);
			if (!picked) throw new Error("Cancelled /feat-flow-start.");
			if (picked === cfgOpt) {
				await runReconfigureMenu(rt, "");
				return;
			}
			if (picked === newOpt) {
				rawArg = (await ui.input("描述你要做的需求，或粘贴 Linear 单号 / 链接:"))?.trim() ?? "";
			} else {
				const pickedIdx = runOptions.indexOf(picked);
				selectedExistingRunId = pickedIdx >= 0 ? preCatalog.runs[pickedIdx]!.runId : null;
				rawArg = selectedExistingRunId ?? "";
			}
		}
	}

	const existingHere = locateRun(location) ?? (rt.known && rt.known.repo.worktree === location.repo ? rt.known : null);
	const parsed = !rawArg && existingHere ? null : parseStartTarget(rawArg, proj.linear?.teamKey);
	let slug = selectedExistingRunId ?? parsed?.slug ?? existingHere?.runId ?? "";
	const boundIssue = selectedExistingRunId ? null : (parsed?.boundIssue ?? null);
	let initialTask = selectedExistingRunId ? null : (parsed?.initialTask ?? null);
	if (boundIssue) {
		const issueSummary = await verifyLinearIssue(rt, boundIssue, location.commonDir);
		if (issueSummary) initialTask = issueSummary;
	}

	if (existingHere) {
		const binding: HostBinding = { processInstanceId: rt.host.processInstanceId, sessionId: rt.host.sessionId(), contextEpoch: 0 };
		const kernel = await openRun({ repo: existingHere.repo, runId: existingHere.runId, buildId: rt.host.buildId, mode: "owner", binding });
		rt.live = { kernel, binding, runId: existingHere.runId };
		rt.known = { repo: existingHere.repo, runId: existingHere.runId };
		const view = kernel.inspect();
		await rt.ensurePack(location.commonDir, view.methodDigest).catch(() => { rt.cachedPack = null; });
		const scope = view.approvedScope;
		if (boundIssue && !view.issue) await kernel.apply({ kind: "bindIssue", issue: boundIssue }, binding);
		if (view.readiness === "blocked" && scope) {
			const confirmed = await rt.host.confirm(`Authorize this session as owner of ${existingHere.runId}?`,
				`The saved design is unchanged: scope ${scope.scope}.`);
			if (!confirmed) {
				await kernel.dispose();
				rt.live = null;
				throw new Error("Cancelled: this session stays unauthorized for the run.");
			}
			await kernel.apply({
				kind: "owner.authorize", source: "native-ui", approved: true, runId: existingHere.runId,
				digest: scope.digest, candidateRevision: scope.revision, ownerEpoch: kernel.inspect().ownerEpoch,
			}, binding);
		} else if (view.readiness === "blocked" && !scope
			&& !view.operations.some(operation => operation.status === "dispatched" || operation.status === "unknown")) {
			await kernel.apply({ kind: "restore" }, binding);
		}
		rt.needsRecoveryBrief = true;
		rt.unavailable = null;
		rt.host.notify(`resumed ${existingHere.runId}; nothing was created.`);
		return;
	}

	const worktreeRoot = await resolveWorktreeRoot(location.repo, proj);
	const lockPath = join(location.commonDir, "omp-feat-flow", "provisioning.lock");
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	const launchResult = await withFileLock(lockPath, async (): Promise<
		| { kind: "existing"; run: (typeof preCatalog.runs)[number] }
		| { kind: "provisioned"; repo: PreparedWorktree; slug: string }
	> => {
		const catalog = await discoverRuns(location.commonDir, location.repo);
		let candidateSlug = slug;
		let targetWorktree = join(worktreeRoot, candidateSlug);
		for (let attempt = 0; attempt <= 20; attempt += 1) {
			targetWorktree = join(worktreeRoot, candidateSlug);
			const match = catalog.match({ slug: candidateSlug, boundIssue, targetWorktree });
			if (match.kind === "run") {
				const exactBySelection = selectedExistingRunId === match.run.runId;
				const exactByIssue = Boolean(boundIssue && (match.run.issue === boundIssue || match.run.settledIssue === boundIssue));
				const exactByTask = !boundIssue && (
					(match.run.initialTask && initialTask && match.run.initialTask === initialTask)
					|| (!match.run.initialTask && match.run.runId === rawArg)
				);
				if (exactBySelection || exactByIssue || exactByTask) {
					return { kind: "existing", run: match.run };
				}
				if (boundIssue) return { kind: "existing", run: match.run };
				candidateSlug = `${slug}-${attempt + 2}`;
				continue;
			}
			if (match.kind === "orphan-branch" || match.kind === "path-exists") {
				if (!boundIssue && attempt < 20) {
					candidateSlug = `${slug}-${attempt + 2}`;
					continue;
				}
				if (match.kind === "orphan-branch") {
					throw new Error(`Branch ${match.branch} already exists without a feat-flow run; remove or pick a different target.`);
				}
				throw new Error(`Worktree path ${match.path} already exists without a feat-flow run.`);
			}
			break;
		}
		slug = candidateSlug;
		targetWorktree = join(worktreeRoot, slug);

		const remote = effectiveRemote(proj);
		const startRef = effectiveStartRef(proj);
		const pack = await rt.ensurePack(location.commonDir);
		let repo: PreparedWorktree | undefined;
		try {
			repo = await prepare({
				repo: location.repo, remote, startRef,
				prBase: proj.git.prBase, runId: slug, branch: `feat/${slug}`, worktree: targetWorktree,
			});
			// P0-1 & P0-2: provision state.json & locator BEFORE launching cmux/omp (and with owner: null in non-cmux too!).
			await provisionRun({
				repo,
				runId: slug,
				buildId: rt.host.buildId,
				methodDigest: pack?.methodDigest ?? null,
				project: projResolved,
				workspace: null,
				issue: boundIssue,
				initialTask,
				skipLock: true,
			});
			return { kind: "provisioned", repo, slug };
		} catch (error) {
			if (repo) {
				await cleanupFailedProvision(location.repo, slug, repo.worktree, location.commonDir);
			}
			throw error;
		}
	}, { retries: 50, retryDelayMs: 10 });

	const cmuxOn = rt.host.workspace.enabled && isCmuxEnabled(rt.cachedUserConfig?.integrations.cmuxPreference ?? "auto");
	const runCmd = cmuxOn ? rt.host.workspace.run ?? defaultRun : async () => ({ code: 127, stdout: "", stderr: "cmux disabled" });
	const activeSlug = launchResult.kind === "existing" ? launchResult.run.runId : launchResult.slug;
	const launchLockPath = join(location.commonDir, "omp-feat-flow", `launch-${activeSlug}.lock`);

	if (launchResult.kind === "existing") {
		const foundRun = launchResult.run;
		const resumed = await withFileLock(launchLockPath, async () => {
			if (!cmuxOn) return false;
			const ws = await findWorkspace({
				runId: foundRun.runId,
				repoIdentity: location.repoIdentity,
				worktree: foundRun.worktree,
				knownWorkspaceId: foundRun.workspaceId,
			}, runCmd);
			if (ws && (await selectWorkspace(ws.workspaceId, runCmd))) {
				rt.host.notify(`需求 ${foundRun.runId} (${foundRun.issue ?? "未绑单"} · ${foundRun.phase}) 已存在于 ${foundRun.worktree}，已为你切换到对应 cmux 工作区。`);
				return true;
			}
			const launchNonce = randomUUID().slice(0, 8);
			const recreated = await ensureWorkspace({
				runId: foundRun.runId,
				repoIdentity: location.repoIdentity,
				worktree: foundRun.worktree,
				startCommand: "omp",
				...(foundRun.initialTask ? { displayTitle: foundRun.initialTask } : {}),
				launchNonce,
			}, runCmd);
			if (recreated.handoff === "switched") {
				await recordProvisionedWorkspace(location.commonDir, foundRun.runId, {
					workspaceId: recreated.workspaceId,
					ownedByRun: recreated.ownedByRun,
					launchNonce,
					verified: recreated.verified,
					continuation: recreated.continuation,
					handoff: recreated.handoff,
				});
				rt.host.notify(`需求 ${foundRun.runId} 已存在于 ${foundRun.worktree}（原工作区已关闭），已新建 cmux 工作区并切换过去。`);
				return true;
			}
			return false;
		}, { retries: 30, retryDelayMs: 10 });
		if (resumed) return;
		rt.host.notify(`需求 ${foundRun.runId} 已存在于 ${foundRun.worktree}。\n继续执行请运行: ${continuationCommand(foundRun.worktree, foundRun.runId)}`);
		return;
	}

	const { repo } = launchResult;
	const wsReceipt = await withFileLock(launchLockPath, async () => {
		const launchNonce = randomUUID().slice(0, 8);
		const receipt = await ensureWorkspace({
			runId: activeSlug,
			repoIdentity: repo.repoIdentity,
			worktree: repo.worktree,
			startCommand: initialTask ? `omp ${shellQuote("请查看 feat-flow 恢复摘要并开始对齐当前需求。")}` : "omp",
			...(initialTask ? { displayTitle: initialTask } : {}),
			launchNonce,
		}, runCmd);

		const wsState = {
			workspaceId: receipt.workspaceId,
			ownedByRun: receipt.ownedByRun,
			launchNonce,
			verified: receipt.verified,
			continuation: receipt.continuation,
			handoff: receipt.handoff,
		};
		await recordProvisionedWorkspace(location.commonDir, activeSlug, wsState).catch(async error => {
			if (receipt.workspaceId && receipt.ownedByRun) await closeWorkspace(receipt.workspaceId, runCmd).catch(() => {});
			throw error;
		});
		return receipt;
	}, { retries: 30, retryDelayMs: 10 });

	if (wsReceipt.handoff === "switched") {
		rt.host.notify(`已为 ${activeSlug} 建立 worktree (${repo.worktree}) 并切入 cmux 工作区 ${wsReceipt.workspaceId}。`);
	} else {
		// Non-cmux launcher never claims RunOwner in the main checkout; user enters the provisioned worktree to start working.
		rt.host.notify(`run ${activeSlug} provisioned at ${repo.worktree}; continue with: ${wsReceipt.continuation}`);
	}
}

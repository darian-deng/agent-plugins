import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import {
	detectProjectDrift,
	detectUserDrift,
	mainCheckoutRoot,
	pendingOnboardingSteps,
	readProject,
	readUserConfig,
	saveProject,
	saveUserConfig,
	userConfigPath,
	type LinearPromptField,
	type OnboardingStep,
	type ProjectConfigV2,
	type ResolvedProject,
	type RoleEffort,
	type RoleModelSpec,
	type UserConfigV1,
} from "./config";
import { linearClient, resolveLinearKey, type LinearTeamSummary } from "./linear";
import { cmuxAvailable } from "./workspace";

const execute = promisify(execFile);

export interface AvailableModelChoice {
	spec: string; // provider/id
	label: string;
}

export interface OnboardingUI {
	hasUI: boolean;
	notify(text: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string, options?: { secret?: boolean }): Promise<string | undefined>;
	formDialog?: ((html: string) => Promise<Record<string, unknown> | undefined>) | undefined;
}

const EFFORT_OPTIONS: RoleEffort[] = ["low", "medium", "high", "xhigh", "minimal", "off"];
const ALL_PROMPT_FIELDS: LinearPromptField[] = ["project", "milestone", "release", "labels", "priority", "cycle"];

function escapeHtml(raw: string): string {
	return raw
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function selectOptionsHtml(values: readonly string[], selectedValue: string): string {
	return values
		.map(val => `<option value="${escapeHtml(val)}"${val === selectedValue ? " selected" : ""}>${escapeHtml(val)}</option>`)
		.join("");
}

async function pickModelAndEffort(
	ui: OnboardingUI,
	roleTitle: string,
	models: AvailableModelChoice[],
	defaultModel: string,
	defaultEffort: RoleEffort,
): Promise<RoleModelSpec> {
	const labels = models.map(m => m.spec);
	const ordered = [defaultModel, ...labels.filter(l => l !== defaultModel)];
	const pickedModel = await ui.select(`Select model for ${roleTitle}`, ordered);
	if (!pickedModel) throw new Error(`Cancelled onboarding while configuring ${roleTitle}.`);
	const effortOrder = [defaultEffort, ...EFFORT_OPTIONS.filter(e => e !== defaultEffort)];
	const pickedEffort = await ui.select(`Select thinking effort for ${roleTitle} (${pickedModel})`, effortOrder);
	if (!pickedEffort) throw new Error(`Cancelled onboarding while configuring ${roleTitle} effort.`);
	return { model: pickedModel, effort: pickedEffort as RoleEffort };
}

async function storeLinearKeyInKeychain(key: string): Promise<boolean> {
	if (process.platform !== "darwin") return false;
	const user = process.env.USER || "omp";
	try {
		await execute("security", ["add-generic-password", "-U", "-a", user, "-s", "omp-linear-api-key", "-w", key]);
		return true;
	} catch {
		return false;
	}
}

async function checkGhCli(): Promise<{ ok: boolean; user?: string }> {
	try {
		const { stdout } = await execute("gh", ["auth", "status"]);
		const m = /Logged in to [^\s]+ account ([^\s(]+)/i.exec(stdout);
		return m?.[1] ? { ok: true, user: m[1] } : { ok: true };
	} catch {
		return { ok: false };
	}
}

async function resolveAndPickLinearTeam(
	ui: OnboardingUI,
	key: string,
	existingDefaultId?: string,
): Promise<{ defaultTeamId?: string; defaultTeamKey?: string; viewerId?: string }> {
	try {
		const info = await linearClient(key).fetchTeams?.();
		const viewerId = info?.viewerId;
		const teams = info?.teams ?? [];
		if (teams.length === 1) {
			return {
				...(viewerId ? { viewerId } : {}),
				defaultTeamId: teams[0]!.id,
				defaultTeamKey: teams[0]!.key,
			};
		}
		if (teams.length > 1) {
			const preferred = teams.find(t => t.id === existingDefaultId);
			const ordered = preferred ? [preferred, ...teams.filter(t => t.id !== preferred.id)] : teams;
			const picked = await ui.select("选择常用默认 Linear 团队（新仓库接入时将默认预选）", ordered.map(t => `${t.key} — ${t.name}`));
			const matched = picked ? teams.find(t => picked.startsWith(`${t.key} `)) : undefined;
			if (matched) {
				return {
					...(viewerId ? { viewerId } : {}),
					defaultTeamId: matched.id,
					defaultTeamKey: matched.key,
				};
			}
		}
		return viewerId ? { viewerId } : {};
	} catch {
		ui.notify("Linear key read succeeded but team list query failed (offline?); saved credential state.", "warning");
		return {};
	}
}

export async function ensureUserOnboarding(input: {
	ui: OnboardingUI;
	availableModels: AvailableModelChoice[];
	hasProviderKey(spec: string): Promise<boolean>;
	resolveModel(spec: string): boolean;
	forceReconfigure?: boolean | undefined;
	configPath?: string | undefined;
}): Promise<UserConfigV1> {
	const { ui, availableModels } = input;
	const existing = readUserConfig(input.configPath);

	if (existing && existing.onboarding.status === "completed" && !input.forceReconfigure) {
		const drift = await detectUserDrift(existing, {
			resolveModel: input.resolveModel,
			hasProviderKey: input.hasProviderKey,
			hasLinearKey: async () => Boolean(await resolveLinearKey()),
		});
		if (!drift.drifted) return existing;

		if (!ui.hasUI) {
			throw new Error(
				`feat-flow user config drifted (missing models: ${drift.missingModels.join(", ") || "none"}; `
				+ `unauthenticated: ${drift.unauthenticatedModels.join(", ") || "none"}; linearMissing: ${drift.linearMissing}). `
				+ `Update ${userConfigPath(input.configPath)} interactively or fix credentials.`,
			);
		}
		ui.notify(
			`检测到 feat-flow 环境配置变化（缺失模型: ${drift.missingModels.join(", ") || "无"}；未认证: ${drift.unauthenticatedModels.join(", ") || "无"}；Linear凭据缺失: ${drift.linearMissing}），开始修复。`,
			"warning",
		);
		const repaired: UserConfigV1 = {
			...existing,
			roles: { ...existing.roles },
			integrations: { ...existing.integrations, linear: { ...existing.integrations.linear } },
		};
		for (const broken of [...drift.missingModels, ...drift.unauthenticatedModels]) {
			const role = broken.split(":")[0] as "author" | "scout" | "coldReader" | "reviewer";
			const fallback = availableModels[0]?.spec;
			if (!fallback) throw new Error("No authenticated models available in omp; run /login or configure a provider first.");
			if (role === "author") {
				const follow = await ui.confirm("Repair author model?", "Author model is unavailable. Follow active /model session instead?");
				repaired.roles.author = follow ? null : await pickModelAndEffort(ui, "author", availableModels, fallback, "high");
			} else {
				repaired.roles[role] = await pickModelAndEffort(ui, role, availableModels, fallback, role === "reviewer" ? "high" : "medium");
			}
		}
		if (drift.linearMissing) {
			const key = await ui.input(
				"Linear API key missing — paste key to save (or leave empty to switch Linear off):",
				"lin_api_...",
				{ secret: true },
			);
			if (key?.trim()) {
				const trimmed = key.trim();
				const stored = await storeLinearKeyInKeychain(trimmed);
				if (stored) {
					repaired.integrations.linear.enabled = true;
					repaired.integrations.linear.credentialSource = "keychain";
				} else {
					process.env.LINEAR_API_KEY = trimmed;
					repaired.integrations.linear.enabled = true;
					repaired.integrations.linear.credentialSource = "env";
					ui.notify("Keychain unavailable on this OS — LINEAR_API_KEY set for current session only; export LINEAR_API_KEY in your shell to persist.", "warning");
				}
			} else {
				repaired.integrations.linear.enabled = false;
				repaired.integrations.linear.credentialSource = "none";
			}
		}
		return saveUserConfig(repaired, input.configPath);
	}

	if (!ui.hasUI) {
		throw new Error(
			`feat-flow user onboarding has not completed. Create ${userConfigPath(input.configPath)} or run /feat-flow-start in an interactive terminal.`,
		);
	}
	if (availableModels.length === 0) {
		throw new Error("No authenticated omp models found. Run /login or configure a provider before onboarding feat-flow.");
	}

	const modelSpecs = availableModels.map(m => m.spec);
	const fastGuess = availableModels.find(m => /flash|mini|haiku|smol|deepseek/i.test(m.spec))?.spec ?? modelSpecs[0]!;
	const strongGuess = availableModels.find(m => /glm|kimi|sonnet|opus|sol|pro/i.test(m.spec))?.spec ?? modelSpecs[0]!;

	// Native one-shot formDialog path when supported by the host TUI.
	if (ui.formDialog && (input.forceReconfigure || !existing || existing.onboarding.completedSteps.length === 0)) {
		const existingLinearKey = await resolveLinearKey();
		const gh = await checkGhCli();
		const hasCmux = await cmuxAvailable();
		const currentCmuxPref = existing?.integrations.cmuxPreference ?? (hasCmux ? "auto" : "disabled");
		const authorChoices = ["follow-session", ...modelSpecs];
		const defaultAuthor = existing?.roles.author?.model ?? "follow-session";

		const html = [
			"<form>",
			"<p><strong>首次本机配置 omp-feat-flow</strong>（配置仅保存在本机，可随时通过 <code>/feat-flow-start config</code> 调整）</p>",
			`<p>环境探测：<code>gh</code> ${gh.ok ? `已登录 (${escapeHtml(gh.user ?? "ok")})` : "未登录"} · <code>cmux</code> ${hasCmux ? "可用" : "未检测到"} · Linear Key ${existingLinearKey ? "已就绪" : "未配置"}</p>`,
			"<fieldset><legend>角色模型与推理深度 (Role Models &amp; Effort)</legend>",
			`<label>Author 主开发模型 <select name="authorModel">${selectOptionsHtml(authorChoices, defaultAuthor)}</select></label>`,
			`<label>Author Effort（仅固定模型时生效）<select name="authorEffort">${selectOptionsHtml(EFFORT_OPTIONS, existing?.roles.author?.effort ?? "high")}</select></label>`,
			`<label>Scout 只读探索模型 <select name="scoutModel">${selectOptionsHtml(modelSpecs, existing?.roles.scout.model ?? fastGuess)}</select></label>`,
			`<label>Scout Effort <select name="scoutEffort">${selectOptionsHtml(EFFORT_OPTIONS, existing?.roles.scout.effort ?? "medium")}</select></label>`,
			`<label>ColdReader 冷读检验模型 <select name="coldReaderModel">${selectOptionsHtml(modelSpecs, existing?.roles.coldReader.model ?? fastGuess)}</select></label>`,
			`<label>ColdReader Effort <select name="coldReaderEffort">${selectOptionsHtml(EFFORT_OPTIONS, existing?.roles.coldReader.effort ?? "medium")}</select></label>`,
			`<label>Reviewer 独立审查模型 <select name="reviewerModel">${selectOptionsHtml(modelSpecs, existing?.roles.reviewer.model ?? strongGuess)}</select></label>`,
			`<label>Reviewer Effort <select name="reviewerEffort">${selectOptionsHtml(EFFORT_OPTIONS, existing?.roles.reviewer.effort ?? "high")}</select></label>`,
			"</fieldset>",
			"<fieldset><legend>集成与终端偏好</legend>",
			`<label>Linear 集成 <select name="linearMode">${selectOptionsHtml(["enable", "skip"], existing?.integrations.linear.enabled === false && !existingLinearKey ? "skip" : "enable")}</select></label>`,
			`<label>cmux 分屏偏好 <select name="cmuxPreference">${selectOptionsHtml(["auto", "enabled", "disabled"], currentCmuxPref)}</select></label>`,
			`<label><input type="checkbox" name="allowUserOverrides" value="yes"${existing?.methods?.allowUserOverrides ? " checked" : ""}> 允许本机全局 skills (~/.omp/agent/skills, ~/.claude/skills) 覆盖内置私有方法包</label>`,
			"</fieldset>",
			"</form>",
		].join("");

		const submitted = await ui.formDialog(html);
		if (!submitted) throw new Error("Cancelled feat-flow onboarding.");

		const authorChoice = String(submitted.authorModel ?? "follow-session");
		const authorSpec: RoleModelSpec | null = authorChoice === "follow-session"
			? null
			: { model: authorChoice, effort: (String(submitted.authorEffort ?? "high") as RoleEffort) };
		const scout: RoleModelSpec = {
			model: String(submitted.scoutModel ?? fastGuess),
			effort: String(submitted.scoutEffort ?? "medium") as RoleEffort,
		};
		const coldReader: RoleModelSpec = {
			model: String(submitted.coldReaderModel ?? fastGuess),
			effort: String(submitted.coldReaderEffort ?? "medium") as RoleEffort,
		};
		const reviewer: RoleModelSpec = {
			model: String(submitted.reviewerModel ?? strongGuess),
			effort: String(submitted.reviewerEffort ?? "high") as RoleEffort,
		};
		const cmuxPref = String(submitted.cmuxPreference ?? currentCmuxPref) as "auto" | "enabled" | "disabled";
		const allowOverrides = Array.isArray(submitted.allowUserOverrides)
			? submitted.allowUserOverrides.includes("yes")
			: submitted.allowUserOverrides === "yes";

		let linearKey = existingLinearKey;
		let credSource: "env" | "keychain" | "none" = process.env.LINEAR_API_KEY?.trim() ? "env" : linearKey ? "keychain" : "none";
		if (String(submitted.linearMode ?? "enable") === "enable" && !linearKey) {
			const pasted = await ui.input("Paste Linear API Key (lin_api_...; leave blank to skip Linear):", "lin_api_...", { secret: true });
			if (pasted?.trim()) {
				linearKey = pasted.trim();
				const stored = await storeLinearKeyInKeychain(linearKey);
				if (stored) {
					credSource = "keychain";
				} else {
					process.env.LINEAR_API_KEY = linearKey;
					credSource = "env";
					ui.notify("Keychain unavailable — LINEAR_API_KEY set for current session only; export LINEAR_API_KEY in shell profile to persist.", "warning");
				}
			}
		} else if (String(submitted.linearMode) === "skip") {
			linearKey = null;
			credSource = "none";
		}

		const teamInfo = linearKey ? await resolveAndPickLinearTeam(ui, linearKey, existing?.integrations.linear.defaultTeamId) : {};
		if (!gh.ok) ui.notify("未检测到已登录的 gh CLI（后续开 PR 前请运行 gh auth login）。", "warning");

		const completed: UserConfigV1 = {
			schemaVersion: 1,
			onboarding: {
				status: "completed",
				completedSteps: ["welcome", "models", "linear", "github", "cmux"],
				completedAt: new Date().toISOString(),
			},
			roles: { author: authorSpec, scout, coldReader, reviewer },
			integrations: {
				linear: {
					enabled: Boolean(linearKey),
					credentialSource: credSource,
					...(teamInfo.defaultTeamId ? { defaultTeamId: teamInfo.defaultTeamId } : {}),
					...(teamInfo.defaultTeamKey ? { defaultTeamKey: teamInfo.defaultTeamKey } : {}),
				},
				githubCliChecked: gh.ok,
				cmuxPreference: cmuxPref,
			},
			...(allowOverrides ? { methods: { allowUserOverrides: true } } : {}),
			observedEnv: {
				configuredProviders: [...new Set(availableModels.map(m => m.spec.split("/")[0] ?? ""))],
				...(gh.user ? { ghUser: gh.user } : {}),
				...(teamInfo.viewerId ? { linearViewerId: teamInfo.viewerId } : {}),
				checkedAt: new Date().toISOString(),
			},
		};
		await saveUserConfig(completed, input.configPath);
		ui.notify("feat-flow 本机初始化完成！", "info");
		return completed;
	}

	// Sequential fallback (partial resume or hosts without formDialog).
	let draft: UserConfigV1 = existing ?? {
		schemaVersion: 1,
		onboarding: { status: "in_progress", completedSteps: [] },
		roles: {
			author: null,
			scout: { model: fastGuess, effort: "medium" },
			coldReader: { model: fastGuess, effort: "medium" },
			reviewer: { model: strongGuess, effort: "high" },
		},
		integrations: {
			linear: { enabled: false, credentialSource: "none" },
			githubCliChecked: false,
			cmuxPreference: "auto",
		},
	};

	const pending = input.forceReconfigure ? ["welcome", "models", "linear", "github", "cmux"] as const : pendingOnboardingSteps(draft);
	if (existing?.onboarding.status === "in_progress" && !input.forceReconfigure) {
		ui.notify(`检测到上次 feat-flow 初始化未完成，将从步骤 [${pending[0]}] 继续。`);
	}

	if (pending.includes("welcome")) {
		const go = await ui.confirm(
			"欢迎首次使用 omp-feat-flow",
			"这是首次运行的一次性本机初始化，将依次帮你配置：\n"
			+ "1. scout / coldReader / reviewer 角色使用的模型与 thinking effort\n"
			+ "2. Linear 凭据与常用团队\n"
			+ "3. GitHub CLI 与 cmux 终端检测\n\n配置仅保存在本机，可随时通过 /feat-flow-start config 重设。",
		);
		if (!go) throw new Error("Cancelled feat-flow onboarding.");
		draft = {
			...draft,
			onboarding: { status: "in_progress", completedSteps: [...new Set([...draft.onboarding.completedSteps, "welcome"])] as OnboardingStep[] },
		};
		await saveUserConfig(draft, input.configPath);
	}

	if (pending.includes("models")) {
		const authorMode = await ui.select("主开发会话 (author) 模型策略", [
			"跟随当前 omp 会话 /model（推荐，不强抢临时切换）",
			"为 feat-flow 指定固定默认模型与 effort",
		]);
		if (!authorMode) throw new Error("Cancelled feat-flow onboarding.");
		const authorSpec = authorMode.startsWith("跟随")
			? null
			: await pickModelAndEffort(ui, "author", availableModels, modelSpecs[0]!, "high");
		const scout = await pickModelAndEffort(ui, "scout (只读代码库探索)", availableModels, fastGuess, "medium");
		const coldReader = await pickModelAndEffort(ui, "coldReader (方案/文档冷读检验)", availableModels, fastGuess, "medium");
		const reviewer = await pickModelAndEffort(ui, "reviewer (独立审查 & 安全/性能审计)", availableModels, strongGuess, "high");
		draft = {
			...draft,
			roles: { author: authorSpec, scout, coldReader, reviewer },
			onboarding: { status: "in_progress", completedSteps: [...new Set([...draft.onboarding.completedSteps, "models"])] as OnboardingStep[] },
		};
		await saveUserConfig(draft, input.configPath);
	}

	if (pending.includes("linear")) {
		let key = await resolveLinearKey();
		let credSource: "env" | "keychain" | "none" = process.env.LINEAR_API_KEY?.trim() ? "env" : key ? "keychain" : "none";
		if (!key) {
			const choice = await ui.select("Linear 集成配置", [
				"输入 Linear API Key（存入本机 Keychain）",
				"暂时跳过 Linear（仅用 GitHub PR）",
			]);
			if (!choice) throw new Error("Cancelled feat-flow onboarding.");
			if (!choice.startsWith("暂时跳过")) {
				const pasted = await ui.input("Paste Linear API Key (lin_api_...):", "lin_api_...", { secret: true });
				if (pasted?.trim()) {
					key = pasted.trim();
					const stored = await storeLinearKeyInKeychain(key);
					if (stored) {
						credSource = "keychain";
					} else {
						process.env.LINEAR_API_KEY = key;
						credSource = "env";
						ui.notify("Keychain unavailable — LINEAR_API_KEY set for current session only.", "warning");
					}
				}
			}
		}
		const teamInfo = key ? await resolveAndPickLinearTeam(ui, key, draft.integrations.linear.defaultTeamId) : {};
		draft = {
			...draft,
			integrations: {
				...draft.integrations,
				linear: {
					enabled: Boolean(key),
					credentialSource: credSource,
					...(teamInfo.defaultTeamId ? { defaultTeamId: teamInfo.defaultTeamId } : {}),
					...(teamInfo.defaultTeamKey ? { defaultTeamKey: teamInfo.defaultTeamKey } : {}),
				},
			},
			observedEnv: {
				configuredProviders: [...new Set(availableModels.map(m => m.spec.split("/")[0] ?? ""))],
				...(teamInfo.viewerId ? { linearViewerId: teamInfo.viewerId } : {}),
				checkedAt: new Date().toISOString(),
			},
			onboarding: { status: "in_progress", completedSteps: [...new Set([...draft.onboarding.completedSteps, "linear"])] as OnboardingStep[] },
		};
		await saveUserConfig(draft, input.configPath);
	}

	if (pending.includes("github") || pending.includes("cmux")) {
		const gh = await checkGhCli();
		if (!gh.ok) ui.notify("未检测到已登录的 gh CLI（后续开 PR 前请运行 gh auth login）。", "warning");
		const hasCmux = await cmuxAvailable();
		draft = {
			...draft,
			integrations: {
				...draft.integrations,
				githubCliChecked: gh.ok,
				cmuxPreference: hasCmux ? "auto" : "disabled",
			},
			observedEnv: {
				configuredProviders: draft.observedEnv?.configuredProviders ?? [],
				...(gh.user ? { ghUser: gh.user } : {}),
				...(draft.observedEnv?.linearViewerId ? { linearViewerId: draft.observedEnv.linearViewerId } : {}),
				checkedAt: new Date().toISOString(),
			},
			onboarding: {
				status: "completed",
				completedSteps: ["welcome", "models", "linear", "github", "cmux"],
				completedAt: new Date().toISOString(),
			},
		};
		await saveUserConfig(draft, input.configPath);
		ui.notify("feat-flow 本机初始化完成！", "info");
	}

	return draft;
}

function parseRepoFromRemoteUrl(url: string): string | null {
	const cleaned = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
	const ssh = /:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(cleaned);
	if (ssh?.[1]) return ssh[1];
	const https = /\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(cleaned);
	return https?.[1] ?? null;
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execute("git", ["-C", cwd, ...args], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
	return stdout.trim();
}

export async function ensureProjectOnboarding(input: {
	cwd: string;
	commonDir: string;
	ui: OnboardingUI;
	userConfig: UserConfigV1;
	forceReconfigure?: boolean;
}): Promise<ResolvedProject> {
	const { cwd, commonDir, ui, userConfig } = input;
	const existing = readProject(commonDir);
	if (existing && !input.forceReconfigure) {
		// Use fast local refs on startup rather than network `git ls-remote` on every `/feat-flow-start`.
		const drift = await detectProjectDrift(cwd, existing.config, {
			hasRemoteBranch: async (remote, branch) => {
				const remoteRef = await gitOut(cwd, ["show-ref", `refs/remotes/${remote}/${branch}`]).catch(() => "");
				if (remoteRef.trim()) return true;
				const localRef = await gitOut(cwd, ["show-ref", `refs/heads/${branch}`]).catch(() => "");
				return Boolean(localRef.trim());
			},
			verifyLinear: async (teamId, reviewState) => {
				const key = await resolveLinearKey();
				if (!key) return null;
				const info = await linearClient(key).fetchTeams?.().catch(() => null);
				if (!info) return null;
				const team = info.teams.find(t => t.id === teamId);
				if (!team) return { teamExists: false, reviewStateExists: false };
				return { teamExists: true, reviewStateExists: team.states.some(s => s.name === reviewState) };
			},
		});
		if (!drift.drifted) return existing;
		if (!ui.hasUI) {
			throw new Error(
				`Project config drifted (missingPrBase: ${drift.missingPrBase}, missingLinearTeam: ${drift.missingLinearTeam}, missingLinearReviewState: ${drift.missingLinearReviewState}). Reconfigure interactively.`,
			);
		}
		ui.notify("检测到当前仓库 feat-flow 配置发生漂移，正在打开修复引导。", "warning");
	}

	if (!ui.hasUI) {
		throw new Error(
			`This repository has no feat-flow project.json at ${join(commonDir, "omp-feat-flow", "project.json")}. Run /feat-flow-start interactively to configure it.`,
		);
	}

	const mainRoot = await mainCheckoutRoot(cwd);
	const remotesRaw = await gitOut(cwd, ["remote"]).catch(() => "origin");
	const remotes = remotesRaw.split(/\r?\n/).filter(Boolean);
	const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? "origin");
	const remoteUrl = await gitOut(cwd, ["remote", "get-url", remote]).catch(() => "");
	const inferredRepo = existing?.config.github?.repository ?? parseRepoFromRemoteUrl(remoteUrl);

	const remoteBranchesRaw = await gitOut(cwd, ["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/`]).catch(() => "");
	const localBranchesRaw = await gitOut(cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).catch(() => "");
	const candidates = [
		...new Set([
			...remoteBranchesRaw.split(/\r?\n/).map(r => r.replace(`${remote}/`, "").trim()),
			...localBranchesRaw.split(/\r?\n/).map(r => r.trim()),
		]),
	].filter(r => r && r !== "HEAD");
	const priority = ["staging", "develop", "main", "master"];
	const sortedBranches = [
		...priority.filter(b => candidates.includes(b)),
		...candidates.filter(b => !priority.includes(b)),
	];
	const defaultPrBase = existing?.config.git.prBase ?? sortedBranches[0] ?? "main";
	const defaultWorktreeRoot = existing?.config.git.worktreeRoot ?? `../${basename(mainRoot)}-worktrees`;

	const detectedDocs = ["apps/desktop/GLOSSARY.md", "GLOSSARY.md", "GLOSSARY-MAP.md", "CODING_STANDARDS.md", "docs/adr", "docs/agents", ".claude/rules"]
		.filter(rel => existsSync(join(mainRoot, rel)));

	let teams: LinearTeamSummary[] = [];
	let linearQueryFailed = false;
	const linearKey = userConfig.integrations.linear.enabled ? await resolveLinearKey() : null;
	if (linearKey) {
		try {
			teams = (await linearClient(linearKey).fetchTeams?.())?.teams ?? [];
		} catch {
			linearQueryFailed = true;
		}
	}

	if (userConfig.integrations.linear.enabled && teams.length === 0) {
		const msg = !linearKey
			? "用户配置已启用 Linear，但当前未找到 Linear API Key。"
			: linearQueryFailed
				? "无法连接 Linear 获取团队列表（网络离线或 API Key 失效）。"
				: "当前 Linear 账号未返回任何可用团队。";
		const proceedGitHubOnly = await ui.confirm(
			"Linear 团队不可用",
			`${msg}\n\n是否暂以「仅 GitHub PR (disabled)」模式保存本仓库？选 No 将取消以便先联网或运行 /feat-flow-start config user 修复。`,
		);
		if (!proceedGitHubOnly) throw new Error(`Project onboarding aborted: ${msg}`);
	}

	const preferredTeam = teams.find(t => t.id === (existing?.config.linear?.teamId ?? userConfig.integrations.linear.defaultTeamId)) ?? teams[0];
	const defaultReviewState = existing?.config.linear?.reviewState
		?? preferredTeam?.states.find(s => /in\s*qa|in\s*review|review/i.test(s.name))?.name
		?? preferredTeam?.states[0]?.name
		?? "In Review";
	const defaultFields = new Set<LinearPromptField>(existing?.config.linear?.promptFields ?? ["project", "labels", "priority"]);

	let prBase = defaultPrBase;
	let worktreeRoot = defaultWorktreeRoot;
	let repository = inferredRepo ?? "";
	let linearBlock: ProjectConfigV2["linear"] = null;

	if (ui.formDialog) {
		const branchList = sortedBranches.length > 0 ? sortedBranches : [defaultPrBase];
		const stateNames = preferredTeam ? preferredTeam.states.map(s => s.name) : [defaultReviewState];
		const orderedStates = [defaultReviewState, ...stateNames.filter(s => s !== defaultReviewState)];
		const modeOptions = teams.length > 0 ? ["required", "optional", "disabled"] : ["disabled"];
		const defaultMode = teams.length === 0 ? "disabled" : (existing?.config.linear?.mode ?? "required");
		const teamLabels = teams.map(t => `${t.key} — ${t.name}`);
		const defaultTeamLabel = preferredTeam ? `${preferredTeam.key} — ${preferredTeam.name}` : "";

		const html = [
			"<form>",
			`<p><strong>仓库接入配置</strong>（保存至 <code>${escapeHtml(join(commonDir, "omp-feat-flow", "project.json"))}</code>）</p>`,
			"<fieldset><legend>Git 与 GitHub 设置</legend>",
			`<label>目标 PR 分支 (prBase) <select name="prBase">${selectOptionsHtml(branchList, defaultPrBase)}</select></label>`,
			`<label>Worktree 目录 <input type="text" name="worktreeRoot" value="${escapeHtml(defaultWorktreeRoot)}" required></label>`,
			`<label>GitHub 仓库 (owner/repo) <input type="text" name="repository" value="${escapeHtml(repository)}" placeholder="owner/repo" required pattern="^[a-zA-Z0-9_.-]+\\/[a-zA-Z0-9_.-]+$"></label>`,
			"</fieldset>",
			"<fieldset><legend>Linear 协作策略</legend>",
			`<label>Linear 模式 <select name="linearMode">${selectOptionsHtml(modeOptions, defaultMode)}</select></label>`,
			...(teams.length > 0
				? [
					`<label>Linear 团队 <select name="linearTeam">${selectOptionsHtml(teamLabels, defaultTeamLabel)}</select></label>`,
					`<label>交付回写状态 <select name="reviewState">${selectOptionsHtml(orderedStates, defaultReviewState)}</select></label>`,
				]
				: ["<p>当前无可用 Linear 团队，将使用纯 GitHub PR 模式。</p>"]),
			"</fieldset>",
			...(teams.length > 0
				? [
					"<fieldset><legend>新建 Linear 单时收集的字段</legend>",
					...ALL_PROMPT_FIELDS.map(f =>
						`<label><input type="checkbox" name="promptFields" value="${f}"${defaultFields.has(f) ? " checked" : ""}> ${f}</label>`),
					"</fieldset>",
				]
				: []),
			"</form>",
		].join("");

		const submitted = await ui.formDialog(html);
		if (!submitted) throw new Error("Cancelled project onboarding.");
		prBase = String(submitted.prBase ?? defaultPrBase).trim();
		worktreeRoot = String(submitted.worktreeRoot ?? defaultWorktreeRoot).trim() || defaultWorktreeRoot;
		repository = String(submitted.repository ?? "").trim();
		if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
			throw new Error(`Invalid GitHub repository "${repository}" — expected "owner/repo".`);
		}
		const chosenMode = String(submitted.linearMode ?? defaultMode) as "required" | "optional" | "disabled";
		if (chosenMode !== "disabled" && teams.length > 0) {
			const teamLabel = String(submitted.linearTeam ?? defaultTeamLabel);
			const chosenTeam = teams.find(t => teamLabel.startsWith(`${t.key} `)) ?? preferredTeam!;
			const reviewState = String(submitted.reviewState ?? defaultReviewState).trim() || defaultReviewState;
			const rawFields = Array.isArray(submitted.promptFields)
				? submitted.promptFields.map(String).filter((f): f is LinearPromptField => (ALL_PROMPT_FIELDS as string[]).includes(f))
				: [];
			linearBlock = {
				mode: chosenMode,
				teamId: chosenTeam.id,
				teamKey: chosenTeam.key,
				reviewState,
				promptFields: rawFields.length > 0 ? rawFields : ["project", "labels", "priority"],
			};
		}
	} else {
		const pickedBase = await ui.select("选择目标 PR 分支 (git.prBase)", sortedBranches.length > 0 ? sortedBranches : [defaultPrBase]);
		if (!pickedBase) throw new Error("Cancelled project onboarding.");
		prBase = pickedBase;
		if (!repository || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) {
			const typedRepo = await ui.input("输入 GitHub 仓库 (owner/repo):", "owner/repo");
			if (!typedRepo?.trim() || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(typedRepo.trim())) {
				throw new Error("A valid GitHub repository (owner/repo) is required.");
			}
			repository = typedRepo.trim();
		}
		if (teams.length > 0) {
			let selectedTeam = preferredTeam;
			if (teams.length > 1) {
				const pickedTeam = await ui.select("选择本仓库关联的 Linear 团队", [
					...teams.map(t => `${t.key} — ${t.name}`),
					"仅 GitHub PR（不使用 Linear）",
				]);
				if (!pickedTeam) throw new Error("Cancelled project onboarding.");
				selectedTeam = pickedTeam.startsWith("仅 GitHub") ? undefined : teams.find(t => pickedTeam.startsWith(`${t.key} `));
			}
			if (selectedTeam) {
				const modePick = await ui.select(`Linear 单据策略 (${selectedTeam.key})`, [
					"required — 批准方案前必须已有或创建 Linear 单（推荐）",
					"optional — 允许跳过建单直接写代码",
					"disabled — 纯 GitHub PR",
				]);
				if (!modePick) throw new Error("Cancelled project onboarding.");
				const mode = modePick.startsWith("disabled") ? "disabled" : modePick.startsWith("optional") ? "optional" : "required";
				if (mode !== "disabled") {
					const stateNames = selectedTeam.states.map(s => s.name);
					const orderedStates = [defaultReviewState, ...stateNames.filter(s => s !== defaultReviewState)];
					const reviewState = await ui.select(`选择交付后回写的 Linear 状态 (${selectedTeam.key})`, orderedStates);
					if (!reviewState) throw new Error("Cancelled project onboarding.");
					linearBlock = {
						mode,
						teamId: selectedTeam.id,
						teamKey: selectedTeam.key,
						reviewState,
						promptFields: [...defaultFields],
					};
				}
			}
		}
	}

	const nextConfig: ProjectConfigV2 = {
		schemaVersion: 2,
		revision: existing?.revision ?? 0,
		git: {
			prBase,
			remote,
			startRef: `${remote}/${prBase}`,
			worktreeRoot,
		},
		github: { repository },
		linear: linearBlock,
		knowledge: detectedDocs.length > 0 ? { entryPaths: detectedDocs } : undefined,
	};

	const saved = await saveProject(commonDir, nextConfig, existing?.revision ?? 0);
	ui.notify(`仓库配置已保存：prBase=${prBase}, repo=${repository}, linear=${linearBlock ? `${linearBlock.teamKey} (${linearBlock.mode})` : "disabled"}`);
	return saved;
}

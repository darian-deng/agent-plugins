import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { z } from "zod";

const execute = promisify(execFile);

export const ONBOARDING_STEPS = ["welcome", "models", "linear", "github", "cmux"] as const;
export type OnboardingStep = typeof ONBOARDING_STEPS[number];

export const roleEffortSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);
export type RoleEffort = z.infer<typeof roleEffortSchema>;

export const roleModelSpecSchema = z.object({
	model: z.string().min(1),
	effort: roleEffortSchema,
}).strict();
export type RoleModelSpec = z.infer<typeof roleModelSpecSchema>;

export const userConfigSchemaV1 = z.object({
	schemaVersion: z.literal(1),
	onboarding: z.object({
		status: z.enum(["not_started", "in_progress", "completed"]),
		completedSteps: z.array(z.enum(ONBOARDING_STEPS)).max(8),
		completedAt: z.string().optional(),
	}).strict(),
	roles: z.object({
		author: roleModelSpecSchema.nullable().optional(),
		scout: roleModelSpecSchema,
		coldReader: roleModelSpecSchema,
		reviewer: roleModelSpecSchema,
	}).strict(),
	integrations: z.object({
		linear: z.object({
			enabled: z.boolean(),
			credentialSource: z.enum(["env", "keychain", "none"]),
			defaultTeamId: z.string().min(1).optional(),
			defaultTeamKey: z.string().regex(/^[A-Z][A-Z0-9]+$/).optional(),
		}).strict(),
		githubCliChecked: z.boolean(),
		cmuxPreference: z.enum(["auto", "enabled", "disabled"]),
	}).strict(),
	methods: z.object({
		allowUserOverrides: z.boolean().default(false),
	}).strict().optional(),
	observedEnv: z.object({
		configuredProviders: z.array(z.string()),
		ghUser: z.string().optional(),
		linearViewerId: z.string().optional(),
		checkedAt: z.string(),
	}).strict().optional(),
}).strict();
export type UserConfigV1 = z.infer<typeof userConfigSchemaV1>;

export const linearPromptFieldSchema = z.enum(["project", "milestone", "release", "labels", "priority", "cycle"]);
export type LinearPromptField = z.infer<typeof linearPromptFieldSchema>;

export const projectConfigSchemaV2 = z.object({
	schemaVersion: z.literal(2).default(2),
	revision: z.number().int().nonnegative().default(1),
	git: z.object({
		prBase: z.string().min(1),
		remote: z.string().min(1).optional(),
		startRef: z.string().min(1).optional(),
		worktreeRoot: z.string().min(1).optional(),
	}).strict(),
	github: z.object({
		repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
	}).strict().optional(),
	linear: z.object({
		mode: z.enum(["required", "optional", "disabled"]).default("required"),
		teamId: z.string().min(1).optional(),
		teamKey: z.string().regex(/^[A-Z][A-Z0-9]+$/).optional(),
		reviewState: z.string().min(1).optional(),
		promptFields: z.array(linearPromptFieldSchema).optional(),
	}).strict().nullable().optional(),
	knowledge: z.object({
		entryPaths: z.array(z.string().min(1)).max(64),
	}).strict().optional(),
	context: z.object({
		stageClearPct: z.number().int().min(10).max(50).default(25),
		betweenSlicePct: z.number().int().min(25).max(70).default(45),
		wrapUpPct: z.number().int().min(40).max(85).default(60),
	}).strict().optional(),
}).strict();
export type ProjectConfigV2 = z.infer<typeof projectConfigSchemaV2>;

// Legacy v1 reader support (read-only migration; dead fields dropped cleanly).
const legacyProjectSnapshotSchemaV1 = z.object({
	schemaVersion: z.literal(1),
	revision: z.number().int().positive(),
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	defaults: z.object({
		git: z.object({
			remote: z.string().min(1),
			startRef: z.string().min(1),
			prBase: z.string().min(1),
			worktreeRoot: z.string().min(1),
		}),
		github: z.object({
			host: z.string().optional(),
			repository: z.string().regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
		}),
		linear: z.object({
			workspaceId: z.string().optional(),
			teamId: z.string().min(1),
			statusMapping: z.object({
				inProgress: z.string().optional(),
				inReview: z.string().min(1),
				done: z.string().optional(),
			}),
		}).nullable().optional(),
		models: z.unknown().optional(),
		knowledge: z.object({ entryPaths: z.array(z.string().min(1)).max(64) }).optional(),
	}),
});

export interface ResolvedProject {
	config: ProjectConfigV2;
	revision: number;
	policyDigest: string;
	legacyV1: boolean;
}

function missing(error: unknown): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	const entries = keys
		.filter(key => (value as Record<string, unknown>)[key] !== undefined)
		.map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
	return `{${entries.join(",")}}`;
}

export function sha256Hex(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

export async function writeAtomic(path: string, content: string): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temporary, "wx", 0o600);
		try {
			await file.writeFile(content);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		const directory = await open(dirname(path), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await rm(temporary, { force: true });
	}
}

export function userConfigPath(customPath?: string): string {
	if (customPath) return customPath;
	return process.env.OMP_FEAT_FLOW_USER_CONFIG || join(homedir(), ".omp", "agent", "omp-feat-flow.json");
}

export type UserConfigReadResult =
	| { ok: true; config: UserConfigV1 | null }
	| { ok: false; path: string; error: string };

export function readUserConfigSafe(customPath?: string): UserConfigReadResult {
	const path = userConfigPath(customPath);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (missing(error)) return { ok: true, config: null };
		return { ok: false, path, error: error instanceof Error ? error.message : String(error) };
	}
	const parsed = userConfigSchemaV1.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, path, error: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") };
	}
	return { ok: true, config: parsed.data };
}

export function readUserConfig(customPath?: string): UserConfigV1 | null {
	const result = readUserConfigSafe(customPath);
	if (!result.ok) throw new Error(`Invalid user config at ${result.path}: ${result.error}`);
	return result.config;
}

export async function saveUserConfig(config: UserConfigV1, customPath?: string): Promise<UserConfigV1> {
	const parsed = userConfigSchemaV1.parse(config);
	const path = userConfigPath(customPath);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeAtomic(path, JSON.stringify(parsed, null, 2) + "\n");
	return parsed;
}

export function pendingOnboardingSteps(config: UserConfigV1 | null): OnboardingStep[] {
	if (!config) return [...ONBOARDING_STEPS];
	if (config.onboarding.status === "completed") return [];
	const done = new Set(config.onboarding.completedSteps);
	return ONBOARDING_STEPS.filter(step => !done.has(step));
}

export interface UserDriftProbe {
	resolveModel(modelSpec: string): boolean;
	hasProviderKey(modelSpec: string): Promise<boolean>;
	hasLinearKey(): Promise<boolean>;
}

export interface UserDriftReport {
	drifted: boolean;
	missingModels: string[];
	unauthenticatedModels: string[];
	linearMissing: boolean;
}

export async function detectUserDrift(config: UserConfigV1, probe: UserDriftProbe): Promise<UserDriftReport> {
	const missingModels: string[] = [];
	const unauthenticatedModels: string[] = [];
	const roleEntries: Array<[string, RoleModelSpec | null | undefined]> = [
		["author", config.roles.author],
		["scout", config.roles.scout],
		["coldReader", config.roles.coldReader],
		["reviewer", config.roles.reviewer],
	];
	for (const [role, spec] of roleEntries) {
		if (!spec) continue;
		if (!probe.resolveModel(spec.model)) {
			missingModels.push(`${role}:${spec.model}`);
			continue;
		}
		if (!(await probe.hasProviderKey(spec.model))) {
			unauthenticatedModels.push(`${role}:${spec.model}`);
		}
	}
	const linearMissing = config.integrations.linear.enabled ? !(await probe.hasLinearKey()) : false;
	return {
		drifted: missingModels.length > 0 || unauthenticatedModels.length > 0 || linearMissing,
		missingModels,
		unauthenticatedModels,
		linearMissing,
	};
}

export function projectConfigPath(commonDir: string): string {
	return join(commonDir, "omp-feat-flow", "project.json");
}

function policyDigestFor(config: ProjectConfigV2): string {
	const { revision: _rev, ...policy } = config;
	return sha256Hex(canonicalJson(policy));
}

export function readProject(commonDir: string): ResolvedProject | null {
	const path = projectConfigPath(commonDir);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if (missing(error)) return null;
		throw error;
	}
	if (raw !== null && typeof raw === "object" && "schemaVersion" in raw && (raw as { schemaVersion: unknown }).schemaVersion === 1) {
		const legacy = legacyProjectSnapshotSchemaV1.parse(raw);
		const config: ProjectConfigV2 = projectConfigSchemaV2.parse({
			schemaVersion: 2,
			revision: legacy.revision,
			git: {
				prBase: legacy.defaults.git.prBase,
				remote: legacy.defaults.git.remote,
				startRef: legacy.defaults.git.startRef,
				worktreeRoot: legacy.defaults.git.worktreeRoot,
			},
			github: { repository: legacy.defaults.github.repository },
			linear: legacy.defaults.linear
				? {
					mode: "required",
					teamId: legacy.defaults.linear.teamId,
					reviewState: legacy.defaults.linear.statusMapping.inReview,
				}
				: null,
			knowledge: legacy.defaults.knowledge,
		});
		return { config, revision: legacy.revision, policyDigest: policyDigestFor(config), legacyV1: true };
	}
	const parsed = projectConfigSchemaV2.parse(raw);
	return { config: parsed, revision: parsed.revision, policyDigest: policyDigestFor(parsed), legacyV1: false };
}

export async function saveProject(
	commonDir: string,
	config: Omit<ProjectConfigV2, "schemaVersion" | "revision"> & { schemaVersion?: 2; revision?: number },
	expectedRevision: number,
): Promise<ResolvedProject> {
	if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
		throw new Error("A valid expected project revision is required.");
	}
	const directory = join(await realpath(commonDir), "omp-feat-flow");
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "project.json");
	return withFileLock(path, async () => {
		const current = readProject(commonDir);
		if ((current?.revision ?? 0) !== expectedRevision) {
			throw new Error("Project defaults changed while this choice was pending; reload before saving.");
		}
		const nextRevision = expectedRevision + 1;
		const validated = projectConfigSchemaV2.parse({ ...config, schemaVersion: 2, revision: nextRevision });
		await writeAtomic(path, JSON.stringify(validated, null, 2) + "\n");
		return { config: validated, revision: nextRevision, policyDigest: policyDigestFor(validated), legacyV1: false };
	}, { retries: 50, retryDelayMs: 10 });
}

export async function mainCheckoutRoot(cwd: string): Promise<string> {
	const { stdout } = await execute("git", ["-C", cwd, "worktree", "list", "--porcelain"], {
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	const firstLine = stdout.split(/\r?\n/).find(line => line.startsWith("worktree "));
	const root = firstLine ? firstLine.slice("worktree ".length).trim() : cwd;
	return realpath(root);
}

export async function resolveWorktreeRoot(cwd: string, config: ProjectConfigV2): Promise<string> {
	const mainRoot = await mainCheckoutRoot(cwd);
	const configured = config.git.worktreeRoot ?? `../${basename(mainRoot)}-worktrees`;
	const resolved = isAbsolute(configured) ? resolve(configured) : resolve(mainRoot, configured);
	return realpath(resolved).catch(() => resolved);
}

export function effectiveRemote(config: ProjectConfigV2): string {
	return config.git.remote ?? "origin";
}

export function effectiveStartRef(config: ProjectConfigV2): string {
	return config.git.startRef ?? `${effectiveRemote(config)}/${config.git.prBase}`;
}

export interface ProjectDriftProbe {
	hasRemoteBranch(remote: string, branch: string): Promise<boolean>;
	verifyLinear(teamId: string, reviewState: string): Promise<{ teamExists: boolean; reviewStateExists: boolean } | null>;
}

export interface ProjectDriftReport {
	drifted: boolean;
	missingPrBase: boolean;
	missingLinearTeam: boolean;
	missingLinearReviewState: boolean;
}

export async function detectProjectDrift(
	_cwd: string,
	config: ProjectConfigV2,
	probe: ProjectDriftProbe,
): Promise<ProjectDriftReport> {
	const remote = effectiveRemote(config);
	const missingPrBase = !(await probe.hasRemoteBranch(remote, config.git.prBase));
	let missingLinearTeam = false;
	let missingLinearReviewState = false;
	if (config.linear && config.linear.mode !== "disabled" && config.linear.teamId && config.linear.reviewState) {
		const check = await probe.verifyLinear(config.linear.teamId, config.linear.reviewState);
		if (check) {
			missingLinearTeam = !check.teamExists;
			missingLinearReviewState = check.teamExists && !check.reviewStateExists;
		}
	}
	return {
		drifted: missingPrBase || missingLinearTeam || missingLinearReviewState,
		missingPrBase,
		missingLinearTeam,
		missingLinearReviewState,
	};
}

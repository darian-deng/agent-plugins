import type { Model } from "@oh-my-pi/pi-ai";
import type { CreateAgentSessionOptions, ModelRegistry, SessionManager } from "@oh-my-pi/pi-coding-agent";

/** The SDK entry points a helper needs; the extension passes `pi.pi`, tests pass the real module. */
export interface HelperSdk {
	createAgentSession: (options: CreateAgentSessionOptions) => Promise<{ session: HelperSession }>;
	SessionManager: { inMemory(cwd: string): SessionManager };
}

export interface HelperSession {
	readonly model?: Model | undefined;
	prompt(text: string): Promise<boolean>;
	waitForIdle(): Promise<void>;
	getLastAssistantText(): string | undefined;
	dispose(): Promise<void> | void;
}

export type HelperKind = "cold-read" | "review";

export interface HelperBinding {
	taskId: string;
	epoch: number;
	snapshotDigest: string;
}

export interface HelperJob {
	kind: HelperKind;
	cwd: string;
	prompt: string;
	/** Pinned when the calling host already knows them; otherwise the isolated profile's default. */
	model?: Model<any>;
	modelRegistry?: ModelRegistry;
	binding: HelperBinding;
}

export interface HelperReceipt {
	kind: HelperKind;
	text: string;
	tools: readonly string[];
	binding: HelperBinding;
	model: { provider: string; id: string };
	sessionId?: string;
}

/** A cold reader must not act; a review may only inspect. Nothing else is admitted. */
export const HELPER_TOOLS: Record<HelperKind, string[]> = { "cold-read": [], review: ["read", "grep", "glob"] };

/**
 * One fresh isolated session per job. Ambient resources, MCP, process-state binding, warming,
 * fallback and extension discovery are off; only the job's read-only tools remain, and only this
 * child session is disposed.
 */
export async function runHelper(sdk: HelperSdk, job: HelperJob): Promise<HelperReceipt> {
	if (!job.binding.taskId || !Number.isSafeInteger(job.binding.epoch) || job.binding.epoch < 0
		|| !/^[a-f0-9]{64}$/.test(job.binding.snapshotDigest)) {
		throw new Error("A helper job needs its task, epoch and method snapshot identity.");
	}
	const tools = [...HELPER_TOOLS[job.kind]];
	const options: CreateAgentSessionOptions = {
		cwd: job.cwd,
		sessionManager: sdk.SessionManager.inMemory(job.cwd),
		restrictToolNames: true,
		toolNames: tools,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		noContextFiles: true,
		contextFiles: [],
		excludeAgentsMd: true,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		disableExtensionDiscovery: true,
		additionalExtensionPaths: [],
		bindProcessState: false,
		cacheWarming: "off",
		autoTitle: false,
		deferHintCompression: true,
		disableModelFallback: true,
		disableServerSideFallback: true,
	};
	if (job.model) options.model = job.model;
	if (job.modelRegistry) {
		options.modelRegistry = job.modelRegistry;
		options.authStorage = job.modelRegistry.authStorage;
	}
	const created = await sdk.createAgentSession(options);
	const session = created.session;
	let text: string | undefined;
	try {
		const accepted = await session.prompt(job.prompt);
		if (!accepted) throw new Error("The helper session refused the job prompt.");
		await session.waitForIdle();
		text = session.getLastAssistantText();
	} finally {
		await session.dispose();
	}
	if (text === undefined) throw new Error("The helper session ended without an assistant answer.");
	const actual = job.model ?? session.model;
	if (!actual) throw new Error("The helper session ran without a resolvable model identity.");
	return { kind: job.kind, text, tools, binding: job.binding, model: { provider: actual.provider, id: actual.id } };
}

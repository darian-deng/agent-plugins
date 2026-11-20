import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMeter, type Meter, type MeterBudget } from "./meter";

export const LIVE_MODEL = "llm-proxy-v2/kimi-k3.1-pro";
/** The allowance is explicit per campaign; raising it needs a recorded developer approval. */
const BUDGET: MeterBudget = { maxRequests: Number(process.env.FEAT_FLOW_MAX_REQUESTS ?? "96"), maxOutputTokens: 8192, maxBodyBytes: 1048576 };

export interface LiveArgs {
	campaign: string;
	only: string | null;
}

/** A live case only runs inside an explicit campaign; a missing flag fails instead of guessing. */
export function parseLiveArgs(): LiveArgs {
	const campaign = process.env.FEAT_FLOW_CAMPAIGN ?? "";
	const only = process.env.FEAT_FLOW_CASE || null;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(campaign)) {
		throw new Error("A live case requires --campaign <id>; the shared live allowance is never implicit.");
	}
	return { campaign, only };
}

const PACKAGE = new URL("../../", import.meta.url).pathname;
const CLI = join(PACKAGE, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js");
const RUNTIME = join(PACKAGE, "runtime/index.mjs");

async function upstreamBaseUrl(): Promise<string> {
	const configured = process.env.FEAT_FLOW_UPSTREAM;
	if (configured) return configured;
	const text = await readFile(join(process.env.HOME ?? "", ".omp", "agent", "models.yml"), "utf8");
	const match = /^\s*baseUrl:\s*(\S+)\s*$/m.exec(text);
	if (!match?.[1]) throw new Error("No llm-proxy base URL: set FEAT_FLOW_UPSTREAM.");
	return match[1];
}

const ISOLATED_CONFIG = `autoResume: false
memory:
  backend: off
advisor:
  enabled: false
prewalk:
  enabled: false
spotlight:
  experiment:
    enabled: false
providers:
  cacheWarming: off
retry:
  enabled: false
models:
  noJudge: true
  offline: true
mcp:
  enableProjectConfig: false
disabledProviders:
  - native
  - mcp-json
defaultThinkingLevel: high
# Manual compaction must be possible on a small fixture: keep only a short tail.
compaction:
  keepRecentTokens: 2000
  thresholdTokens: 1000000
`;

function meteredModels(baseUrl: string): string {
	return `providers:
  llm-proxy-v2:
    baseUrl: ${baseUrl}
    api: anthropic-messages
    apiKey: LLM_PROXY_V2_API_KEY
    auth: apiKey
    disableStrictTools: true
    models:
      - id: kimi-k3.1-pro
        name: Kimi K3.1 Pro
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, high, max]
          defaultLevel: high
        input: [text, image]
        contextWindow: 1000000
        maxTokens: 8192
        tokenizer: kimi-k2
        cost: { input: 2.00, output: 10.00, cacheRead: 0.20, cacheWrite: 2.00 }
`;
}

export interface Frame {
	type?: string;
	[key: string]: unknown;
}

export interface NativeHost {
	root: string;
	meter: Meter;
	profile: IsolatedProfile;
	frames: Frame[];
	call(frame: Record<string, unknown>): Promise<Frame>;
	prompt(message: string): Promise<Frame>;
	/** Send a prompt without waiting, so a native UI frame raised by it can be answered first. */
	startPrompt(message: string): { id: string; result: Promise<Frame> };
	/** Raw frame send, for answers such as `extension_ui_response`. */
	send(frame: Record<string, unknown>): void;
	next(predicate: (frame: Frame) => boolean, label: string, timeoutMs?: number, after?: number): Promise<Frame>;
	/** Current frame count, to scope a later wait to frames that have not arrived yet. */
	mark(): number;
	stop(): Promise<void>;
}

/**
 * Launch the real native RPC mode with the built extension: isolated agent directory,
 * one metered inference path, no session persistence and no ambient MCP/extension discovery.
 */
export interface NativeHostOptions {
	env?: Record<string, string>;
	/** Per-case compaction policy for the isolated profile. */
	compaction?: { thresholdTokens?: number; keepRecentTokens?: number };
	/** A genuine negative fixture: the child gets no provider credential at all. */
	withCredential?: boolean;
	/** Load the artifact from the native installation instead of an explicit extension path. */
	installed?: boolean;
	/** Reuse an existing profile (so an install can happen before boot and an upgrade while it runs). */
	profile?: IsolatedProfile;
}

export interface IsolatedProfile {
	root: string;
	agentDir: string;
	home: string;
	meter: Meter;
	env: Record<string, string>;
	stop(): void;
}

/** A dedicated profile whose only inference path is the meter; used by the native host and by helper runs. */
export function campaignLog(campaign: string): string {
	return new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${campaign}/meter.jsonl`, import.meta.url).pathname;
}

export async function startIsolatedProfile(campaign: string, withCredential = true, extraEnv: Record<string, string> = {},
	compaction: { thresholdTokens?: number; keepRecentTokens?: number } = {}): Promise<IsolatedProfile> {
	const root = await mkdtemp(join(tmpdir(), "omp-feat-live-"));
	const agentDir = join(root, "agent");
	const home = join(root, "home");
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await mkdir(home, { recursive: true, mode: 0o700 });
	await mkdir(campaignLog(campaign).replace(/\/meter\.jsonl$/, ""), { recursive: true });
	const meter = startMeter(await upstreamBaseUrl(), BUDGET, campaignLog(campaign));
	const config = ISOLATED_CONFIG
		.replace("keepRecentTokens: 2000", `keepRecentTokens: ${compaction.keepRecentTokens ?? 2000}`)
		.replace("thresholdTokens: 1000000", `thresholdTokens: ${compaction.thresholdTokens ?? 1000000}`);
	await writeFile(join(agentDir, "config.yml"), config);
	await writeFile(join(agentDir, "models.yml"), meteredModels(meter.baseUrl));
	const key = withCredential ? process.env.LLM_PROXY_V2_API_KEY : undefined;
	if (withCredential && !key) {
		meter.stop();
		throw new Error("LLM_PROXY_V2_API_KEY is not set; the live case will not run without its real credential.");
	}
	return {
		root, agentDir, home, meter,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			TMPDIR: process.env.TMPDIR ?? "/tmp",
			LANG: process.env.LANG ?? "en_US.UTF-8",
			NO_COLOR: "1",
			PI_CODING_AGENT_DIR: agentDir,
			// Bun merges this map onto the parent environment: an omitted variable would still leak through,
			// so a negative credential fixture must blank every provider credential and foreign config switch.
			LLM_PROXY_V2_API_KEY: key ?? "",
			ANTHROPIC_API_KEY: "",
			OPENAI_API_KEY: "",
			GEMINI_API_KEY: "",
			GOOGLE_API_KEY: "",
			CLAUDE_CONFIG_DIR: "",
			PI_NOTIFICATIONS: "off",
			...extraEnv,
		},
		stop: () => meter.stop(),
	};
}

export async function startNativeHost(cwd: string, campaign: string, options: NativeHostOptions = {}): Promise<NativeHost> {
	const extraEnv = options.env ?? {};
	if (!options.installed) {
		const built = Bun.spawnSync([process.execPath, "scripts/build.ts"], { cwd: PACKAGE, stdout: "pipe", stderr: "pipe" });
		if (built.exitCode !== 0) throw new Error(`runtime build failed: ${built.stderr.toString()}`);
	}
	const profile = options.profile
		?? await startIsolatedProfile(campaign, options.withCredential !== false, extraEnv, options.compaction);
	const { root, meter } = profile;
	// Installed mode proves the artifact the native installation actually loads; an explicit extension
	// path would bypass discovery and hide exactly the upgrade question this case exists to answer.
	const loadArgs = options.installed ? [] : ["--no-extensions", "--extension", RUNTIME];
	const child = Bun.spawn([
		process.execPath, CLI, "--mode", "rpc-ui", "--no-session", "--no-title", ...loadArgs,
		"--model", LIVE_MODEL, "--thinking", "high", "--approval-mode", "yolo",
	], {
		cwd,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...profile.env, OMP_FEAT_FLOW_CAMPAIGN: campaign },
	});

	const frames: Frame[] = [];
	const listeners = new Set<(frame: Frame) => void>();
	const stderr = new Response(child.stderr).text();
	void (async () => {
		const decoder = new TextDecoder();
		const reader = child.stdout.getReader();
		let buffer = "";
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let frame: Frame;
				try { frame = JSON.parse(line) as Frame; } catch { throw new Error(`non-JSON RPC frame: ${line.slice(0, 200)}`); }
				frames.push(frame);
				for (const listener of listeners) listener(frame);
			}
		}
	})();

	let sequence = 0;
	const send = (frame: Record<string, unknown>): string => {
		const id = `c${++sequence}`;
		child.stdin.write(JSON.stringify({ ...frame, id }) + "\n");
		void child.stdin.flush();
		return id;
	};
	const nextFrame = (predicate: (frame: Frame) => boolean, label: string, timeoutMs = 300_000): Promise<Frame> => {
		const { promise, resolve, reject } = Promise.withResolvers<Frame>();
		const settle = (frame: Frame) => {
			clearTimeout(timeout);
			listeners.delete(settle);
			resolve(frame);
		};
		const timeout = setTimeout(() => {
			listeners.delete(settle);
			reject(new Error(`timed out waiting for ${label}; ${frames.length} frames seen`));
		}, timeoutMs);
		const seen = frames.find(predicate);
		if (seen) settle(seen);
		else listeners.add(frame => { if (predicate(frame)) settle(frame); });
		return promise;
	};
	const waitFor = (id: string, predicate: (frame: Frame) => boolean): Promise<Frame> => nextFrame(frame => frame.id === id && predicate(frame), `RPC frame ${id}`);
	try {
		await nextFrame(frame => frame.type === "ready", "native RPC ready", 120_000);
	} catch (error) {
		child.kill();
		meter.stop();
		throw new Error(`${error instanceof Error ? error.message : String(error)}. stderr: ${(await stderr).slice(-4000)}`);
	}

	const host: NativeHost = {
		root,
		meter,
		profile,
		frames,
		async call(frame) {
			const id = send(frame);
			return waitFor(id, item => item.type === "response" && item.id === id);
		},
		async prompt(message) {
			return host.startPrompt(message).result;
		},
		startPrompt(message) {
			const id = send({ type: "prompt", message });
			const result = (async () => {
				const accepted = await waitFor(id, item => item.type === "response" && item.id === id);
				if (accepted.success !== true) throw new Error(`prompt rejected: ${JSON.stringify(accepted).slice(0, 2000)}`);
				return waitFor(id, item => item.type === "prompt_result" && item.id === id);
			})();
			return { id, result };
		},
		send(frame) {
			child.stdin.write(JSON.stringify(frame) + "\n");
			void child.stdin.flush();
		},
		next(predicate, label, timeoutMs, after = 0) {
			return nextFrame(frame => frames.indexOf(frame) >= after && predicate(frame), label, timeoutMs);
		},
		mark() {
			return frames.length;
		},
		async stop() {
			try { child.stdin.end(); } catch { /* already closed */ }
			child.kill();
			await child.exited;
			profile.stop();
		},
	};
	return host;
}

export function framesText(frames: readonly Frame[]): string {
	return frames.map(frame => JSON.stringify(frame)).join("\n");
}

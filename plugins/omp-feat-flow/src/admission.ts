import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	effectOf,
	resolveContainedWorktreePath,
	type FlowRuntime,
	type NativeToolAttempt,
} from "./flow-context";
import type { Admission, RequestIntent } from "./run";

const REMOTE_DELIVERY_MCP_MUTATORS = new Set([
	"mcp__linear_save_issue",
	"mcp__linear_save_comment",
	"mcp__linear_save_status_update",
	"mcp__linear_merge_diff",
	"mcp__linear_submit_diff_review",
]);

function isRemoteGitOrGhCommand(cmd: string): boolean {
	if (/api\.linear\.app\/graphql/i.test(cmd)) return true;
	// Split shell pipelines/chains roughly to inspect each command segment.
	const segments = cmd.split(/&&|\|\||;|\n|\|/);
	for (const seg of segments) {
		const tokens = seg.trim().split(/\s+/).map(t => t.replace(/^["']|["']$/g, "")).filter(Boolean);
		if (tokens.length === 0) continue;
		const head = tokens[0]!;
		if (head === "git" || head.endsWith("/git")) {
			// Skip global git options (-C <dir>, -c <kv>, --git-dir=..., --work-tree=..., etc.) before finding subcommand.
			let i = 1;
			while (i < tokens.length) {
				const t = tokens[i]!;
				if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace" || t === "--super-prefix") {
					i += 2;
					continue;
				}
				if (t.startsWith("-")) {
					i += 1;
					continue;
				}
				if (t.toLowerCase() === "push") return true;
				break;
			}
		}
		if (head === "gh" || head.endsWith("/gh")) {
			const sub = tokens.slice(1).filter(t => !t.startsWith("-"));
			if (sub[0] === "pr" && ["create", "merge", "edit", "close"].includes(sub[1] ?? "")) {
				return true;
			}
		}
	}
	return false;
}

function isScoutSpawn(input?: Record<string, unknown>): boolean {
	if (!input) return false;
	if (input.agent === "scout") return true;
	if (Array.isArray(input.tasks) && input.tasks.length > 0) {
		return input.tasks.every(item =>
			item !== null && typeof item === "object" && (item as { agent?: unknown }).agent === "scout",
		);
	}
	return false;
}

export type BashCommandClass = "verifier" | "mutator" | "other";

const MUTATING_BINARIES = new Set(["touch", "rm", "mv", "cp", "tee", "chmod", "chown", "ln", "mkdir", "truncate"]);
const DIRECT_VERIFIERS = new Set(["vitest", "jest", "pytest", "unittest", "mocha", "ava", "tap", "tsc", "eslint", "oxlint", "biome"]);
const PM_BINARIES = new Set(["npm", "pnpm", "bun", "yarn"]);
const PM_VALUE_FLAGS = new Set(["--filter", "--cwd", "-C", "--prefix", "--workspace", "-w"]);
const PM_BOOL_FLAGS = new Set(["-r", "--recursive", "--silent", "-s", "--if-present", "--parallel", "--stream"]);
const VERIFIER_SCRIPT_RE = /^(?:test|typecheck|lint|build|check|verify)(?:[:_-][a-z0-9_-]+)*$/i;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function tokenizeAndSplitAndSegments(raw: string): { ok: boolean; hasMutatorRedirect: boolean; segments: string[][] } {
	const cmd = raw.trim();
	if (!cmd) return { ok: false, hasMutatorRedirect: false, segments: [] };
	const segments: string[][] = [];
	let curTokens: string[] = [];
	let curTok = "";
	let hasTok = false;
	let inSingle = false;
	let inDouble = false;
	let hasMutatorRedirect = false;
	let invalidSyntax = false;

	const pushTok = () => {
		if (hasTok) {
			curTokens.push(curTok);
			curTok = "";
			hasTok = false;
		}
	};

	for (let i = 0; i < cmd.length; i += 1) {
		const ch = cmd[i]!;
		const next = cmd[i + 1] ?? "";
		if (inSingle) {
			if (ch === "'") inSingle = false;
			else { curTok += ch; hasTok = true; }
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (next === "\n" || next === "\r") { invalidSyntax = true; break; }
				if (next) { curTok += next; hasTok = true; i += 1; }
				continue;
			}
			if (ch === "$" && next === "(") { invalidSyntax = true; break; }
			if (ch === "`") { invalidSyntax = true; break; }
			if (ch === '"') inDouble = false;
			else { curTok += ch; hasTok = true; }
			continue;
		}
		if (ch === "\\") {
			if (next === "\n" || next === "\r" || !next) { invalidSyntax = true; break; }
			curTok += next;
			hasTok = true;
			i += 1;
			continue;
		}
		if (ch === "'") { inSingle = true; hasTok = true; continue; }
		if (ch === '"') { inDouble = true; hasTok = true; continue; }
		if (ch === "`" || (ch === "$" && next === "(") || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === ";" || ch === "\n" || ch === "\r" || ch === "|") {
			invalidSyntax = true;
			continue;
		}
		if (ch === "<" && next === "(") {
			invalidSyntax = true;
			continue;
		}
		if (ch === ">") {
			pushTok();
			const rest = cmd.slice(i);
			if (/^>>?\s*\/dev\/null(?=\s|$|&&)/.test(rest)) {
				const m = /^>>?\s*\/dev\/null/.exec(rest)!;
				i += m[0].length - 1;
				continue;
			}
			if (/^>&[12](?=\s|$|&&)/.test(rest)) {
				i += 2;
				continue;
			}
			hasMutatorRedirect = true;
			invalidSyntax = true;
			continue;
		}
		if ((ch === "1" || ch === "2") && !hasTok && next === ">") {
			const rest = cmd.slice(i);
			if (/^[12]>&[12](?=\s|$|&&)/.test(rest)) {
				i += 3;
				continue;
			}
			if (/^[12]>>?\s*\/dev\/null(?=\s|$|&&)/.test(rest)) {
				const m = /^[12]>>?\s*\/dev\/null/.exec(rest)!;
				i += m[0].length - 1;
				continue;
			}
		}
		if (ch === "&") {
			if (next === "&") {
				pushTok();
				if (curTokens.length === 0) return { ok: false, hasMutatorRedirect, segments: [] };
				segments.push(curTokens);
				curTokens = [];
				i += 1;
				continue;
			}
			invalidSyntax = true;
			continue;
		}
		if (/\s/.test(ch)) {
			pushTok();
			continue;
		}
		curTok += ch;
		hasTok = true;
	}

	if (inSingle || inDouble || invalidSyntax) {
		return { ok: false, hasMutatorRedirect, segments: [] };
	}
	pushTok();
	if (curTokens.length > 0) segments.push(curTokens);
	return { ok: segments.length > 0, hasMutatorRedirect, segments };
}

function segmentHasMutator(tokens: string[]): boolean {
	let i = 0;
	while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i]!)) i += 1;
	const head = (tokens[i] ?? "").toLowerCase();
	const base = head.includes("/") ? head.slice(head.lastIndexOf("/") + 1) : head;
	if (!base) return false;
	if (MUTATING_BINARIES.has(base)) return true;
	if (base === "sed" && tokens.slice(i + 1).some(a => a === "-i" || a.startsWith("-i") || a === "--in-place")) return true;
	if (PM_BINARIES.has(base)) {
		const sub = (tokens[i + 1] ?? "").toLowerCase();
		if (new Set(["install", "i", "add", "remove", "rm", "update", "up", "uninstall", "un", "ci"]).has(sub)) return true;
	}
	return false;
}

function classifySegment(tokens: string[]): "verifier" | "prep" | "other" {
	let i = 0;
	while (i < tokens.length && ENV_ASSIGN_RE.test(tokens[i]!)) i += 1;
	const rawHead = tokens[i];
	if (!rawHead) return "other";
	const base = (rawHead.includes("/") ? rawHead.slice(rawHead.lastIndexOf("/") + 1) : rawHead).toLowerCase();
	const args = tokens.slice(i + 1);

	if (base === "cd" || base === "echo" || base === "printf" || base === "true") return "prep";
	if (base === "git") {
		const sub = (args[0] ?? "").toLowerCase();
		if (sub === "add" || sub === "commit" || sub === "status" || sub === "diff" || sub === "log" || sub === "rev-parse") {
			return "prep";
		}
		return "other";
	}
	if (DIRECT_VERIFIERS.has(base)) return "verifier";
	if (base === "cargo") {
		const sub = (args[0] ?? "").toLowerCase();
		return sub === "test" || sub === "check" || sub === "clippy" ? "verifier" : "other";
	}
	if (base === "go") {
		return (args[0] ?? "").toLowerCase() === "test" ? "verifier" : "other";
	}
	if (PM_BINARIES.has(base)) {
		let j = 0;
		while (j < args.length) {
			const a = args[j]!;
			if (PM_VALUE_FLAGS.has(a)) { j += 2; continue; }
			if (a.startsWith("--filter=") || a.startsWith("--cwd=") || a.startsWith("--prefix=") || a.startsWith("--workspace=")) {
				j += 1;
				continue;
			}
			if (PM_BOOL_FLAGS.has(a)) { j += 1; continue; }
			if (a.startsWith("-")) return "other";
			break;
		}
		const first = (args[j] ?? "").toLowerCase();
		if (first === "workspace" && base === "yarn") {
			const script = (args[j + 2] ?? "").toLowerCase();
			return VERIFIER_SCRIPT_RE.test(script) ? "verifier" : "other";
		}
		if (first === "run") {
			const script = (args[j + 1] ?? "").toLowerCase();
			return VERIFIER_SCRIPT_RE.test(script) ? "verifier" : "other";
		}
		if (base === "bun" && first === "test") return "verifier";
		return VERIFIER_SCRIPT_RE.test(first) ? "verifier" : "other";
	}
	return "other";
}

export function classifyVerificationCommand(cmd: string): BashCommandClass {
	const parsed = tokenizeAndSplitAndSegments(cmd);
	if (!parsed.ok) {
		if (parsed.hasMutatorRedirect || /\b(touch|rm|mv|cp|sed\s+-i|tee)\b|\b(npm|pnpm|bun|yarn)\s+(install|i|add|remove|rm|update|up|uninstall|un|ci)\b/i.test(cmd)) {
			return "mutator";
		}
		return "other";
	}
	let sawVerifier = false;
	for (const seg of parsed.segments) {
		if (segmentHasMutator(seg)) return "mutator";
		const cls = classifySegment(seg);
		if (cls === "other") return "other";
		if (cls === "verifier") sawVerifier = true;
	}
	return sawVerifier ? "verifier" : "other";
}

function repoHasTests(worktree: string): boolean {
	try {
		const pkgPath = join(worktree, "package.json");
		if (existsSync(pkgPath)) {
			const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
			const testScript = parsed.scripts?.test ?? "";
			if (testScript && !/no test specified/i.test(testScript)) return true;
		}
		for (const candidate of ["tests", "test", "__tests__"]) {
			if (existsSync(join(worktree, candidate))) return true;
		}
	} catch { /* ignore */ }
	return false;
}

function trivialVerificationScripts(worktree: string): string[] {
	try {
		const pkgPath = join(worktree, "package.json");
		if (!existsSync(pkgPath)) return [];
		const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
		const trivialRe = /^\s*(?:(?:true|:|exit\s+0)(?:\s+#.*)?|(?:echo|printf)\b[^;\n|&]*)\s*$/i;
		const bad: string[] = [];
		for (const [name, body] of Object.entries(parsed.scripts ?? {})) {
			if (VERIFIER_SCRIPT_RE.test(name) && typeof body === "string" && trivialRe.test(body)) {
				bad.push(name);
			}
		}
		return bad;
	} catch {
		return [];
	}
}

export function admitToolCall(rt: FlowRuntime, call: NativeToolAttempt): Admission {
	if (process.env.OMP_FEAT_FLOW_OFF === "1") {
		return { allow: true, reason: "disabled", runId: rt.live?.runId ?? "", revision: null, ownerEpoch: null };
	}
	const effect = effectOf(call.toolName, call.input);
	if (!rt.isMainAgent()) {
		if (rt.subagentInFeatFlow === false) {
			return { allow: true, reason: "subagent-outside-feat-flow", runId: "", revision: null, ownerEpoch: null };
		}
		if (rt.subagentInFeatFlow === null) {
			// Synchronous fallback when tool_call fires before async session_start finishes.
			void rt.checkSubagentWorkspace();
		}
		if (effect === "read") {
			return { allow: true, reason: "subagent-read", runId: "", revision: null, ownerEpoch: null };
		}
		return rt.deny("subagent-read-only");
	}

	if (effect === "read") {
		return { allow: true, reason: "allowed", runId: rt.live?.runId ?? "", revision: null, ownerEpoch: null };
	}
	if (!call.toolCallId) return rt.deny("unattributed-tool-call");
	if (!rt.live) {
		if (!rt.known && (rt.unavailable === "run-not-initialized" || rt.unavailable === "not-in-git-repository")) {
			return { allow: true, reason: rt.unavailable, runId: "", revision: null, ownerEpoch: null };
		}
		rt.ensureLoaded();
		return rt.deny(rt.unavailable ?? "run-loading");
	}

	if (call.toolName.startsWith("mcp__")) {
		if (REMOTE_DELIVERY_MCP_MUTATORS.has(call.toolName)) {
			return rt.deny("workflow-guard");
		}
		if (rt.host.isReadOnlyMcpTool?.(call.toolName)) {
			return { allow: true, reason: "allowed-readonly-mcp", runId: rt.live.runId, revision: null, ownerEpoch: null };
		}
	}

	// Allow read-only scout subagents (flat or batch tasks[]) while blocking mutating subagents.
	if (effect === "spawn") {
		if (isScoutSpawn(call.input)) {
			const view = rt.live.kernel.inspect();
			return { allow: true, reason: "allowed-scout", runId: rt.live.runId, revision: view.revision, ownerEpoch: view.ownerEpoch };
		}
		return rt.deny("scope-not-approved");
	}

	const view = rt.live.kernel.inspect();
	if (view.phase === "implementation" && call.toolName === "bash") {
		const cmd = typeof call.input?.command === "string" ? call.input.command : "";
		if (cmd && isRemoteGitOrGhCommand(cmd)) return rt.deny("workflow-guard");
	}

	// Enforce worktree realpath containment on file-writing tools (write, edit).
	if (call.toolName === "write" || call.toolName === "edit") {
		const targetPath = typeof call.input?.path === "string"
			? call.input.path
			: typeof call.input?.file_path === "string"
				? call.input.file_path
				: undefined;
		if (targetPath && !resolveContainedWorktreePath(view.worktree, targetPath)) {
			return rt.deny("path-outside-worktree");
		}
	}

	const wrapMode = view.contextWrapUp?.mode ?? rt.pendingWrapUpMode;
	if (wrapMode) {
		if (wrapMode === "finalizing_slice" && call.toolName === "bash") {
			return rt.live.kernel.admit({ toolCallId: call.toolCallId, effect }, rt.live.binding);
		}
		return rt.deny(wrapMode === "finalizing_slice" ? "finalizing-slice" : "context-wrap-up");
	}

	return rt.live.kernel.admit({ toolCallId: call.toolCallId, effect }, rt.live.binding);
}

export function recordToolOutcome(
	rt: FlowRuntime,
	_toolCallId: string,
	toolName: string,
	input: Record<string, unknown> | undefined,
	isError: boolean,
): void {
	if (!rt.isMainAgent() || !rt.live) return;
	const effect = effectOf(toolName, input);
	if (toolName === "bash") {
		if (isError) {
			rt.sawPassingCheck = false;
			return;
		}
		const cmd = typeof input?.command === "string" ? input.command : "";
		const cls = classifyVerificationCommand(cmd);
		if (cls === "mutator") {
			rt.sawPassingCheck = false;
			return;
		}
		if (cls === "verifier") {
			rt.sawPassingCheck = true;
			const view = rt.live.kernel.inspect();
			try {
				const head = rt.gitHead(view.worktree);
				const p = rt.live.kernel.apply({ kind: "check.record", head }, rt.live.binding)
					.then(() => {})
					.catch(() => {})
					.finally(() => {
						if (rt.pendingCheckPersist === p) rt.pendingCheckPersist = null;
					});
				rt.pendingCheckPersist = p;
			} catch { /* ignore */ }
		}
		return;
	}
	if (effect === "write") {
		rt.sawPassingCheck = false;
	}
}

export async function verifySliceDone(rt: FlowRuntime, intent: Extract<RequestIntent, { kind: "slice.update" }>): Promise<void> {
	if (!rt.live || intent.status !== "done") return;
	const currentView = rt.live.kernel.inspect();
	const dirty = (await rt.gitText(currentView.worktree, ["status", "--porcelain"])).trim();
	if (dirty) {
		throw new Error("Cannot mark slice done while worktree has uncommitted changes; commit cleanly first.");
	}
	const head = rt.gitHead(currentView.worktree);
	if (intent.commitSha !== undefined && intent.commitSha !== null) {
		const trimmed = intent.commitSha.trim();
		if (!/^[a-f0-9]{7,40}$/i.test(trimmed) || !head.startsWith(trimmed)) {
			throw new Error(`Slice commitSha ${intent.commitSha || "(empty)"} does not match worktree HEAD ${head.slice(0, 12)}.`);
		}
	}
	const descends = (await Bun.spawn(["git", "-C", currentView.worktree, "merge-base", "--is-ancestor", currentView.currentIntegrationSha, head],
		{ stdout: "ignore", stderr: "ignore" }).exited) === 0;
	if (!descends || head === currentView.currentIntegrationSha) {
		throw new Error("Slice completion requires a new commit descending from the current integration base.");
	}
	if (currentView.plan?.slices.some(s => s.id !== intent.sliceId && s.status === "done" && s.commitSha === head)) {
		throw new Error(`Slice ${intent.sliceId} requires a distinct commit beyond the previous completed slice (${head.slice(0, 12)}).`);
	}
	const explicitNoTests = typeof intent.testProof === "string" && /^no-tests:\s*\S+/i.test(intent.testProof.trim());
	if (explicitNoTests && repoHasTests(currentView.worktree)) {
		throw new Error("Repository has tests; cannot bypass verification with no-tests:.");
	}
	const trivialScripts = trivialVerificationScripts(currentView.worktree);
	if (trivialScripts.length > 0 && !explicitNoTests) {
		throw new Error(`Repository package.json has trivial verification script(s) (${trivialScripts.join(", ")}); run real tests instead.`);
	}
	const verifiedOnHead = rt.sawPassingCheck || currentView.lastVerifiedCheckHead === head;
	if (!verifiedOnHead && !explicitNoTests) {
		throw new Error("Host did not observe a passing verification command (bash exit 0) after edits on this slice.");
	}
	if (currentView.autoDeliverGrant && !currentView.autoDeliverGrant.revoked) {
		const scopeCheck = await rt.checkChangedFilesWithinDeclared(currentView, head, currentView.autoDeliverGrant.declaredFiles);
		if (!scopeCheck.ok) {
			await rt.live.kernel.apply({ kind: "autoDeliver.revoke" }, rt.live.binding);
			rt.host.notify(
				`Changed files exceeded small-tier declared surface (${scopeCheck.extra.join(", ")}); Delivery Gate confirmation will be required.`,
				"warning",
			);
		}
	}
	rt.sawPassingCheck = false;
}

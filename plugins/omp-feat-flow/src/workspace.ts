import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename } from "node:path";

/** A command runner, injectable so absence of cmux is testable without a fake terminal. */
export type Run = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WorkspaceRequest {
	runId: string;
	repoIdentity?: string;
	worktree: string;
	/** Command the requirement session starts with. */
	startCommand: string;
	displayTitle?: string;
	launchNonce?: string;
}

export interface WorkspaceReceipt {
	mode: "cmux" | "non-cmux";
	/** The exact continuation a plain terminal must run; also shown after a cmux handoff. */
	continuation: string;
	workspaceId: string | null;
	surfaceId: string | null;
	ownedByRun: boolean;
	launchNonce: string | null;
	ownershipMarker: string;
	handoff: "switched" | "not-switched";
	/** True only when cmux's own listing shows this exact workspace record under its ownership marker. */
	verified: boolean;
}

export interface CmuxWorkspaceRecord {
	id: string;
	title?: string;
	custom_title?: string;
	description?: string;
	current_directory?: string;
}

function repoHash8(repoIdentity?: string): string {
	if (!repoIdentity) return "default0";
	return createHash("sha256").update(repoIdentity).digest("hex").slice(0, 8);
}

export function ownershipMarker(runId: string, repoIdentity?: string, launchNonce?: string): string {
	const prefix = repoIdentity ? `feat-flow:${repoHash8(repoIdentity)}:${runId}` : `feat-flow:${runId}`;
	return launchNonce ? `${prefix}:${launchNonce}` : prefix;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function continuationCommand(worktree: string, _runId: string): string {
	return `cd ${shellQuote(worktree)} && omp`;
}

export const defaultRun: Run = async (command, args) => {
	const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	return { code, stdout, stderr };
};

export async function cmuxAvailable(run: Run = defaultRun): Promise<boolean> {
	try {
		return (await run("cmux", ["workspace", "list"])).code === 0;
	} catch {
		return false;
	}
}

export function isCmuxEnabled(preference: "auto" | "enabled" | "disabled" = "auto"): boolean {
	if (process.env.OMP_FEAT_FLOW_CMUX === "0" || preference === "disabled") return false;
	if (process.env.OMP_FEAT_FLOW_CMUX === "1" || preference === "enabled") return true;
	return Boolean(process.env.CMUX_WORKSPACE_ID);
}

function jsonString(text: string, key: string): string | null {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed !== null && typeof parsed === "object" && key in parsed) {
			const value: unknown = (parsed as Record<string, unknown>)[key];
			if (typeof value === "string") return value;
		}
	} catch { /* not JSON */ }
	return null;
}

function parseWorkspaceRecords(text: string): CmuxWorkspaceRecord[] {
	try {
		const parsed: unknown = JSON.parse(text);
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is CmuxWorkspaceRecord =>
				item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string",
			);
		}
		if (parsed !== null && typeof parsed === "object") {
			const out: CmuxWorkspaceRecord[] = [];
			const seen = new Set<string>();
			const visit = (node: unknown) => {
				if (!node || typeof node !== "object") return;
				if (Array.isArray(node)) { node.forEach(visit); return; }
				const rec = node as Record<string, unknown>;
				if (typeof rec.id === "string" && ("current_directory" in rec || "custom_title" in rec || "description" in rec || "title" in rec)) {
					if (!seen.has(rec.id)) {
						seen.add(rec.id);
						out.push(rec as unknown as CmuxWorkspaceRecord);
					}
				}
				if (Array.isArray(rec.workspaces)) visit(rec.workspaces);
				if (Array.isArray(rec.windows)) visit(rec.windows);
			};
			visit(parsed);
			return out;
		}
		return [];
	} catch {
		return [];
	}
}

function recordMatchesMarker(record: CmuxWorkspaceRecord, markerPrefix: string): boolean {
	const fields = [record.description, record.custom_title, record.title];
	return fields.some(val => typeof val === "string" && (val === markerPrefix || val.startsWith(`${markerPrefix}:`) || val.startsWith(`${markerPrefix} `)));
}

function safeRealpath(path: string): string {
	try { return realpathSync(path); } catch { return path; }
}

function nonCmux(request: WorkspaceRequest, marker: string, continuation: string): WorkspaceReceipt {
	return {
		mode: "non-cmux",
		continuation,
		workspaceId: null,
		surfaceId: null,
		ownedByRun: false,
		launchNonce: request.launchNonce ?? null,
		ownershipMarker: marker,
		handoff: "not-switched",
		verified: false,
	};
}

/**
 * Find an existing cmux workspace for a run.
 * Distinguishes run-owned workspaces (matched by saved workspaceId or repo-scoped ownership marker)
 * from manually opened user panes (matched by cwd only -> focusable, never auto-closed).
 */
export async function findWorkspace(
	input: { runId: string; repoIdentity?: string; worktree: string; knownWorkspaceId: string | null },
	run: Run = defaultRun,
): Promise<{ workspaceId: string; ownedByRun: boolean } | null> {
	if (!(await cmuxAvailable(run))) return null;
	const treeRes = await run("cmux", ["--id-format", "uuids", "tree", "--all", "--json"]).catch(() => null);
	const listing = treeRes && treeRes.code === 0
		? treeRes
		: await run("cmux", ["--id-format", "uuids", "workspace", "list", "--json"]).catch(() => null);
	if (!listing || listing.code !== 0) return null;
	const records = parseWorkspaceRecords(listing.stdout);
	const prefix = ownershipMarker(input.runId, input.repoIdentity);

	if (input.knownWorkspaceId) {
		const byId = records.find(r => r.id === input.knownWorkspaceId);
		if (byId) return { workspaceId: byId.id, ownedByRun: true };
	}
	const byMarker = records.find(r => recordMatchesMarker(r, prefix));
	if (byMarker) return { workspaceId: byMarker.id, ownedByRun: true };

	const targetCwd = safeRealpath(input.worktree);
	const byCwd = records.find(r => r.current_directory && safeRealpath(r.current_directory) === targetCwd);
	if (byCwd) return { workspaceId: byCwd.id, ownedByRun: false };

	return null;
}

export async function selectWorkspace(workspaceId: string, run: Run = defaultRun): Promise<boolean> {
	try {
		const res = await run("cmux", ["workspace", "select", workspaceId]);
		return res.code === 0;
	} catch {
		return false;
	}
}

export async function closeWorkspace(workspaceId: string, run: Run = defaultRun): Promise<boolean> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 150));
		const result = await run("cmux", ["workspace", "close", workspaceId]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
		if (result.code === 0) return true;
		if (/not found|no such|does not exist|unknown/i.test(result.stderr)) return true;
	}
	return false;
}

/**
 * One workspace per requirement, tagged with repo-scoped ownership marker and optional launchNonce.
 * Verifies id AND marker on the SAME JSON record rather than substring search across stdout.
 */
export async function ensureWorkspace(request: WorkspaceRequest, run: Run = defaultRun): Promise<WorkspaceReceipt> {
	const marker = ownershipMarker(request.runId, request.repoIdentity, request.launchNonce);
	const continuation = continuationCommand(request.worktree, request.runId);
	if (!(await cmuxAvailable(run))) return nonCmux(request, marker, continuation);

	const titleSuffix = request.displayTitle?.trim();
	const safeTitle = titleSuffix ? Array.from(titleSuffix).slice(0, 48).join("") : "";
	const name = safeTitle
		? `${safeTitle} (${request.runId})`
		: `${ownershipMarker(request.runId, request.repoIdentity)} ${basename(request.worktree)}`;
	const created = await run("cmux", [
		"--id-format", "uuids", "workspace", "create",
		"--name", name,
		"--description", marker,
		"--cwd", request.worktree,
		"--command", request.startCommand,
		"--focus", "true",
		"--json",
	]);
	if (created.code !== 0) return nonCmux(request, marker, continuation);
	const createdId = jsonString(created.stdout, "workspace_id") ?? jsonString(created.stdout, "id");
	const surfaceId = jsonString(created.stdout, "surface_id");
	if (!createdId) return nonCmux(request, marker, continuation);

	let verified = false;
	for (let attempt = 0; attempt < 20 && !verified; attempt += 1) {
		if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 150));
		const listing = await run("cmux", ["--id-format", "uuids", "workspace", "list", "--json"]);
		if (listing.code !== 0) continue;
		const records = parseWorkspaceRecords(listing.stdout);
		const matched = records.find(record => record.id === createdId);
		if (matched && recordMatchesMarker(matched, marker)) {
			verified = true;
		}
	}
	return {
		mode: "cmux",
		continuation,
		workspaceId: createdId,
		surfaceId,
		ownedByRun: verified,
		launchNonce: request.launchNonce ?? null,
		ownershipMarker: marker,
		handoff: verified ? "switched" : "not-switched",
		verified,
	};
}

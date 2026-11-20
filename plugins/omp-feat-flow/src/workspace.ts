import { basename } from "node:path";

/** A command runner, injectable so absence of cmux is testable without a fake terminal. */
export type Run = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface WorkspaceRequest {
	runId: string;
	worktree: string;
	/** Command the requirement session starts with. */
	startCommand: string;
}

export interface WorkspaceReceipt {
	mode: "cmux" | "non-cmux";
	/** The exact continuation a plain terminal must run; also shown after a cmux handoff. */
	continuation: string;
	workspaceId: string | null;
	surfaceId: string | null;
	ownershipMarker: string;
	handoff: "switched" | "not-switched";
	/** True only when cmux's own listing shows this workspace under its ownership marker. */
	verified: boolean;
}

export function ownershipMarker(runId: string): string {
	return `feat-flow:${runId}`;
}

export function continuationCommand(worktree: string, _runId: string): string {
	return `cd ${JSON.stringify(worktree)} && omp`;
}

export const defaultRun: Run = async (command, args) => {
	const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
	]);
	return { code, stdout, stderr };
};

async function cmuxAvailable(run: Run): Promise<boolean> {
	try {
		return (await run("cmux", ["workspace", "list"])).code === 0;
	} catch {
		return false;
	}
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

function nonCmux(request: WorkspaceRequest, marker: string, continuation: string): WorkspaceReceipt {
	return { mode: "non-cmux", continuation, workspaceId: null, surfaceId: null, ownershipMarker: marker, handoff: "not-switched", verified: false };
}

/**
 * One workspace per requirement, named with its ownership marker. Only the workspace created here is
 * focused afterwards; no other developer workspace is moved, focused or closed.
 */
export async function ensureWorkspace(request: WorkspaceRequest, run: Run = defaultRun): Promise<WorkspaceReceipt> {
	const marker = ownershipMarker(request.runId);
	const continuation = continuationCommand(request.worktree, request.runId);
	if (!(await cmuxAvailable(run))) return nonCmux(request, marker, continuation);

	const name = `${marker} ${basename(request.worktree)}`;
	// The id format is a global option: it must precede the subcommand.
	const created = await run("cmux", ["--id-format", "uuids", "workspace", "create", "--name", name,
		"--description", marker, "--cwd", request.worktree, "--command", request.startCommand, "--focus", "true", "--json"]);
	if (created.code !== 0) return nonCmux(request, marker, continuation);
	// `workspace create --json` answers with workspace_id/window_id/surface_id.
	const createdId = jsonString(created.stdout, "workspace_id") ?? jsonString(created.stdout, "id");
	const surfaceId = jsonString(created.stdout, "surface_id");
	if (!createdId) return nonCmux(request, marker, continuation);

	// Trust cmux's own listing: the id must exist and carry this run's marker. Creation is applied
	// asynchronously, so the listing is polled a bounded number of times instead of assumed instant.
	let verified = false;
	for (let attempt = 0; attempt < 20 && !verified; attempt += 1) {
		if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 150));
		const listing = await run("cmux", ["workspace", "list", "--json"]);
		verified = listing.code === 0 && listing.stdout.includes(createdId) && listing.stdout.includes(marker);
	}
	return { mode: "cmux", continuation, workspaceId: createdId, surfaceId, ownershipMarker: marker,
		handoff: verified ? "switched" : "not-switched", verified };
}

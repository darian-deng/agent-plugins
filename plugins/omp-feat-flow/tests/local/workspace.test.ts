import { expect, test } from "bun:test";
import {
	continuationCommand,
	ensureWorkspace,
	findWorkspace,
	ownershipMarker,
	selectWorkspace,
	type Run,
} from "../../src/workspace";

const request = {
	runId: "desk-1",
	repoIdentity: "/repos/plaud-web/.git",
	worktree: "/tmp/flow/source-worktrees/desk-1",
	startCommand: "omp",
	launchNonce: "nonce-abc",
};

function runner(
	available: boolean,
	created = '{"workspace_id":"10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A"}',
	listing?: string,
): Run {
	const marker = ownershipMarker(request.runId, request.repoIdentity, request.launchNonce);
	const defaultListing = JSON.stringify({
		workspaces: [{ id: "10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A", description: marker, current_directory: request.worktree }],
	});
	return async (command, args) => {
		if (!available) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		const joined = [command, ...args].join(" ");
		if (joined.includes("workspace list")) return { code: 0, stdout: listing ?? defaultListing, stderr: "" };
		if (joined.includes("workspace create")) return { code: 0, stdout: created, stderr: "" };
		if (joined.includes("workspace select")) return { code: 0, stdout: "", stderr: "" };
		return { code: 1, stdout: "", stderr: "unexpected" };
	};
}

test("without cmux the flow returns the real continuation instead of a fake switch", async () => {
	const receipt = await ensureWorkspace(request, runner(false));
	expect(receipt).toMatchObject({ mode: "non-cmux", handoff: "not-switched", verified: false, ownedByRun: false, workspaceId: null });
	expect(receipt.continuation).toBe(continuationCommand(request.worktree, request.runId));
	expect(receipt.ownershipMarker).toBe(ownershipMarker("desk-1", request.repoIdentity, "nonce-abc"));
});

test("verification checks the SAME workspace record for id and repo-scoped marker, never cross-record substrings", async () => {
	const verified = await ensureWorkspace(request, runner(true));
	expect(verified).toMatchObject({
		mode: "cmux",
		handoff: "switched",
		verified: true,
		ownedByRun: true,
		workspaceId: "10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A",
	});

	// Marker appears on workspace B while created id is workspace A -> MUST NOT verify!
	const marker = ownershipMarker(request.runId, request.repoIdentity, request.launchNonce);
	const splitAcrossRecords = JSON.stringify({
		workspaces: [
			{ id: "10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A", description: "other-ws" },
			{ id: "10001800-10BB-4BB1-8CC1-0F0E1D2C3B4B", description: marker },
		],
	});
	const unverified = await ensureWorkspace(request, runner(true, undefined, splitAcrossRecords));
	expect(unverified).toMatchObject({ mode: "cmux", handoff: "not-switched", verified: false, ownedByRun: false });
});

test("two repositories with identical runId produce distinct ownership markers and findWorkspace distinguishes owned vs manual panes", async () => {
	const m1 = ownershipMarker("fix-auth", "/repos/app-a/.git");
	const m2 = ownershipMarker("fix-auth", "/repos/app-b/.git");
	expect(m1).not.toBe(m2);

	// A manual user pane matching only cwd is focusable (ownedByRun: false, closeable: false).
	const manualListing = JSON.stringify({
		workspaces: [{ id: "manual-ws", title: "user-pane", current_directory: request.worktree }],
	});
	const foundManual = await findWorkspace({
		runId: request.runId,
		repoIdentity: request.repoIdentity,
		worktree: request.worktree,
		knownWorkspaceId: null,
	}, runner(true, undefined, manualListing));
	expect(foundManual).toMatchObject({ workspaceId: "manual-ws", ownedByRun: false });

	expect(await selectWorkspace("manual-ws", runner(true, undefined, manualListing))).toBe(true);
});

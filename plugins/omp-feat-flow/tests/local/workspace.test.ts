import { expect, test } from "bun:test";
import { continuationCommand, ensureWorkspace, ownershipMarker, type Run } from "../../src/workspace";

const request = { runId: "desk-1", worktree: "/tmp/flow/source-worktrees/desk-1", startCommand: "omp" };

function runner(available: boolean, created = '{"id":"10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A"}',
	listing = '{"workspaces":[{"id":"10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A","custom_title":"feat-flow:desk-1 desk-1"}]}'): Run {
	return async (command, args) => {
		if (!available) throw Object.assign(new Error("not found"), { code: "ENOENT" });
		const joined = [command, ...args].join(" ");
		if (joined.includes("workspace list")) return { code: 0, stdout: listing, stderr: "" };
		if (joined.includes("workspace create")) return { code: 0, stdout: created, stderr: "" };
		return { code: 1, stdout: "", stderr: "unexpected" };
	};
}

test("without cmux the flow returns the real continuation instead of a fake switch", async () => {
	const receipt = await ensureWorkspace(request, runner(false));
	expect(receipt).toMatchObject({ mode: "non-cmux", handoff: "not-switched", verified: false, workspaceId: null });
	expect(receipt.continuation).toBe(continuationCommand(request.worktree, request.runId));
	expect(receipt.continuation).toContain("omp");
	expect(receipt.ownershipMarker).toBe(ownershipMarker("desk-1"));
});

test("a cmux workspace is only reported switched when its own listing shows the marker", async () => {
	const verified = await ensureWorkspace(request, runner(true));
	expect(verified).toMatchObject({ mode: "cmux", handoff: "switched", verified: true,
		workspaceId: "10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A" });

	const unverified = await ensureWorkspace(request, runner(true, '{"id":"10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A"}',
		'{"workspaces":[{"id":"10001800-10BB-4BB1-8CC1-0F0E1D2C3B4B","custom_title":"someone-else"}]}'));
	expect(unverified).toMatchObject({ mode: "cmux", handoff: "not-switched", verified: false });

	const failed = await ensureWorkspace(request, async (command, args) => {
		const joined = [command, ...args].join(" ");
		if (joined.includes("workspace list")) return { code: 0, stdout: "", stderr: "" };
		return { code: 2, stdout: "", stderr: "no window" };
	});
	expect(failed).toMatchObject({ mode: "non-cmux", handoff: "not-switched" });
});

test("the created workspace carries the ownership marker and the run's worktree", async () => {
	const calls: string[][] = [];
	const run: Run = async (command, args) => {
		calls.push([command, ...args]);
		if (args.join(" ").includes("workspace list")) {
			return { code: 0, stdout: '{"workspaces":[{"id":"10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A","custom_title":"feat-flow:desk-1 desk-1"}]}', stderr: "" };
		}
		return { code: 0, stdout: '{"id":"10001800-09AA-4BB1-8CC1-0F0E1D2C3B4A"}', stderr: "" };
	};
	await ensureWorkspace(request, run);
	const created = calls.find(call => call.includes("workspace") && call.includes("create"));
	expect(created).toBeDefined();
	expect(created).toContain(`feat-flow:desk-1 desk-1`);
	expect(created).toContain(request.worktree);
	expect(created).toContain("--focus");
});

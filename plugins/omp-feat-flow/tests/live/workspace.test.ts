import { afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";
import { defaultRun, ensureWorkspace, ownershipMarker } from "../../src/workspace";
import { parseLiveArgs } from "../support/native-host";

const CASE = "workspace-isolation";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const fixtures: GitFixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

async function cmuxWorkspaces(): Promise<string> {
	const listing = await defaultRun("cmux", ["workspace", "list", "--json"]);
	return listing.code === 0 ? listing.stdout : "";
}

test(`live ${CASE}: an owned cmux workspace is created, verified and closed again`, async () => {
	if (args.only && args.only !== CASE) return;
	const available = await defaultRun("cmux", ["workspace", "list"]).catch(() => ({ code: 127, stdout: "", stderr: "" }));
	if (available.code !== 0) {
		// A machine without cmux is the documented non-cmux path, not a pass for this case.
		throw new Error("cmux is not reachable; the workspace case cannot run here.");
	}
	const fixture = await gitFixture();
	fixtures.push(fixture);
	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	const worktree = join(fixture.root, "source-worktrees", "desk-ws");
	await git(fixture.source, ["worktree", "add", "-b", "feat/desk-ws", worktree, "origin/staging"]);
	const mark = ownershipMarker("desk-ws");

	const receipt = await ensureWorkspace({ runId: "desk-ws", worktree, startCommand: "true" });
	const listingAfterCreate = await cmuxWorkspaces();
	let closed = false;
	try {
		await mkdir(EVIDENCE, { recursive: true });
		await writeFile(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
			case: CASE, campaign: args.campaign, receipt, listedAfterCreate: listingAfterCreate.includes(mark),
		}, null, 2) + "\n");
		expect(receipt.mode).toBe("cmux");
		expect(receipt.verified).toBe(true);
		expect(listingAfterCreate).toContain(mark);
	} finally {
		// Both creation and closing are applied asynchronously, so retry until the id is gone.
		let gone = false;
		for (let attempt = 0; attempt < 20 && !gone; attempt += 1) {
			if (attempt > 0) await Bun.sleep(200);
			const close = await defaultRun("cmux", ["workspace", "close", receipt.workspaceId ?? "\u0000"]);
			closed ||= close.code === 0;
			gone = !(await cmuxWorkspaces()).includes(receipt.workspaceId ?? "\u0000");
		}
		// The owned workspace must be gone; unrelated workspaces are not touched.
		expect(closed).toBe(true);
		expect(gone).toBe(true);
	}
}, 120_000);

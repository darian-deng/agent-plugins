import { afterEach, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { discoverRuns, inspectRepository, prepare } from "../../src/git";
import { openRun, provisionRun, RunKernel } from "../../src/run";
import { git, gitFixture, type GitFixture } from "../support/git-fixture";

const fixtures: GitFixture[] = [];
const kernels: RunKernel[] = [];

afterEach(async () => {
	for (const k of kernels.splice(0)) await k.dispose();
	for (const f of fixtures.splice(0)) await f.cleanup();
});

test("discoverRuns resolves existing runs by Linear issue, settled linear-issue receipt, runId, branch, and orphan collision", async () => {
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const loc = await inspectRepository(fixture.source);

	// Run 1: started by slug "login-fix", bound via bindIssue to DESK-101.
	const wt1 = await prepare({
		repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "login-fix", branch: "feat/login-fix", worktree: join(fixture.root, "wt", "login-fix"),
	});
	await provisionRun({ repo: wt1, runId: "login-fix", buildId: "b", issue: "DESK-101" });

	// Run 2: crashed between settle and bind — only settled linear-issue receipt holds DESK-202.
	const wt2 = await prepare({
		repo: fixture.source, remote: "origin", startRef: "main", prBase: "main",
		runId: "cache-fix", branch: "feat/cache-fix", worktree: join(fixture.root, "wt", "cache-fix"),
	});
	const k2 = await openRun({ repo: wt2, runId: "cache-fix", buildId: "b", mode: "owner", binding: { processInstanceId: "p", sessionId: "p", contextEpoch: 0 } });
	kernels.push(k2);
	const op = { id: "linear-issue-cache-fix", type: "linear-issue" as const, target: "team-1", intentDigest: "a".repeat(64) };
	await k2.apply({ kind: "operation.prepare", operation: op }, { processInstanceId: "p", sessionId: "p", contextEpoch: 0 });
	await k2.apply({ kind: "operation.dispatch", operationId: op.id }, { processInstanceId: "p", sessionId: "p", contextEpoch: 0 });
	await k2.apply({ kind: "operation.settle", operationId: op.id, outcome: "applied", receipt: { target: "team-1", intentDigest: op.intentDigest, reference: "DESK-202" } }, { processInstanceId: "p", sessionId: "p", contextEpoch: 0 });
	await k2.dispose();

	// Orphan branch without a run state.
	await git(fixture.source, ["branch", "feat/orphan-slug"]);
	// Orphan directory collision at target worktree path.
	await mkdir(join(fixture.root, "wt", "dir-taken"), { recursive: true });

	const catalog = await discoverRuns(loc.commonDir, fixture.source);
	expect(catalog.match({ slug: "desk-101", boundIssue: "DESK-101" })).toMatchObject({ kind: "run", run: { runId: "login-fix" } });
	expect(catalog.match({ slug: "desk-202", boundIssue: "DESK-202" })).toMatchObject({ kind: "run", run: { runId: "cache-fix" } });
	expect(catalog.match({ slug: "login-fix", boundIssue: null })).toMatchObject({ kind: "run", run: { runId: "login-fix" } });
	expect(catalog.match({ slug: "orphan-slug", boundIssue: null })).toMatchObject({ kind: "orphan-branch", branch: "feat/orphan-slug" });
	expect(catalog.match({ slug: "dir-taken", boundIssue: null, targetWorktree: join(fixture.root, "wt", "dir-taken") })).toMatchObject({ kind: "path-exists" });
	expect(catalog.match({ slug: "brand-new", boundIssue: null, targetWorktree: join(fixture.root, "wt", "brand-new") })).toEqual({ kind: "none" });
});

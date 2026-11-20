import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTools } from "../../src/binding";
import { deliver, deliveryMarker, type DeliveryPorts } from "../../src/delivery";
import type { Proof } from "../../src/evidence";
import { git } from "../support/git-fixture";
import { parseLiveArgs } from "../support/native-host";
import { desktopTeamId, graphql, linearKey } from "../support/linear";

// Real repository and Linear calls take seconds; the default hook timeout is far too short for cleanup.
setDefaultTimeout(180_000);

const CASE = "delivery-partial-success";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;
const LINEAR_TOOLS = ["mcp__linear_get_issue", "mcp__linear_update_issue"];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function sh(cwd: string, cmd: string[]): Promise<string> {
	const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${(err || out).slice(-800)}`);
	return out;
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

test(`live ${CASE}: PR success followed by a lost Linear receipt repairs only the backwrite`, async () => {
	if (args.only && args.only !== CASE) return;
	const key = await linearKey();
	// Cleanup capability is a precondition, not an afterthought: without it the fixture repository
	// could be created and never removed, so the case refuses to start.
	const scopes = await sh(tmpdir(), ["gh", "api", "-i", "user"]);
	const scopeLine = /x-oauth-scopes:\s*([^\r\n]+)/i.exec(scopes)?.[1] ?? "";
	if (!scopeLine.split(/,\s*/).includes("delete_repo")) {
		throw new Error("gh lacks the delete_repo scope; the delivery fixture would be unremovable. Refresh with: gh auth refresh -h github.com -s delete_repo");
	}
	const owner = (await sh(tmpdir(), ["gh", "api", "user", "-q", ".login"])).trim();
	const stamp = Date.now().toString(36);
	const repoName = `omp-feat-flow-deliv-${stamp}`;
	const full = `${owner}/${repoName}`;
	let issueId = "";

	const repo = await mkdtemp(join(tmpdir(), "omp-feat-deliv-"));
	const ledger: Record<string, unknown> = { repository: full };
	cleanups.push(async () => {
		const pullRequests = JSON.parse(await sh(tmpdir(), ["gh", "pr", "list", "--repo", full, "--state", "open", "--json", "number"]).catch(() => "[]")) as Array<{ number: number }>;
		for (const pullRequest of pullRequests) {
			await sh(tmpdir(), ["gh", "pr", "close", String(pullRequest.number), "--repo", full, "--delete-branch"]).catch(() => {});
		}
		ledger.prsClosed = pullRequests.length;
		// Deletion is verified; a failure is recorded and rethrown so the case cannot pass silently.
		const deleted = await sh(tmpdir(), ["gh", "repo", "delete", full, "--yes"]).then(() => true).catch(() => false);
		ledger.repositoryDeleted = deleted;
		await rm(repo, { recursive: true, force: true }).catch(() => {});
		if (!deleted) {
			await Bun.write(join(EVIDENCE, `${CASE}-cleanup.json`), JSON.stringify(ledger, null, 2) + "\n");
			throw new Error(`cleanup failed: ${full} still exists`);
		}
		await Bun.write(join(EVIDENCE, `${CASE}-cleanup.json`), JSON.stringify(ledger, null, 2) + "\n");
	});

	// A freshly owned private repository with a real base branch.
	await sh(tmpdir(), ["gh", "repo", "create", full, "--private", "--description", "omp-feat-flow delivery fixture"]);
	const worktree = repo;
	await sh(repo, ["git", "init", "--initial-branch=main", "."]);
	await writeFile(join(repo, "README.md"), "fixture\n");
	await git(repo, ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "add", "-A"]);
	await git(repo, ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-m", "base"]);
	await git(repo, ["branch", "staging"]);
	await git(repo, ["remote", "add", "origin", `https://github.com/${full}.git`]);
	// The fixture repository authenticates through the existing gh credential helper, not a token in the URL.
	await git(repo, ["config", "credential.https://github.com.helper", "!gh auth git-credential"]);
	await git(repo, ["push", "origin", "main", "staging"]);

	// The feature branch lives in a worktree of the same repository.
	await writeFile(join(repo, "feature.txt"), "delivered\n");
	await git(repo, ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "checkout", "-b", "feat/delivery"]);
	await git(repo, ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "add", "-A"]);
	await git(repo, ["-c", "user.email=fixture@example.com", "-c", "user.name=fixture", "commit", "-m", "feature"]);
	const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
	const base = (await git(repo, ["rev-parse", "origin/staging"])).trim();

	// One dedicated Desktop issue, non-Bug, deletable.
	const created = await graphql(key, `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`,
		{ input: { teamId: await desktopTeamId(key),
			title: `[omp-feat-flow test] delivery ${stamp}`, description: "Fixture for the delivery case; deleted after it." } });
	issueId = created.issueCreate.issue.id;
	const identifier = created.issueCreate.issue.identifier as string;
	cleanups.push(async () => {
		if (issueId) await graphql(key, `mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: issueId }).catch(() => {});
	});

	const identity = { worktree, base, head, candidateDigest: digest("candidate"), configDigest: digest("config"), inputRevision: 3 };
	const proofs: Proof[] = [
		{ ...identity, kind: "check", name: "typecheck", detail: "exit 0" },
		{ ...identity, kind: "review", name: "independent", detail: "accept" },
	];
	const binding = { captured: captureTools(LINEAR_TOOLS), current: [...LINEAR_TOOLS], expect: { server: "linear", tool: "get_issue" } };

	const marker = deliveryMarker(`live-${stamp}`);
	const issue = async (_identifier?: string, expected = marker): Promise<{ identifier: string; state: string; hasMarker: boolean; description: string } | null> => {
		const data = await graphql(key, `query($id: String!) { issue(id: $id) { identifier state { name } description } }`, { id: issueId });
		if (!data.issue) return null;
		const description = String(data.issue.description ?? "");
		return { identifier: data.issue.identifier, state: data.issue.state.name, hasMarker: description.includes(expected), description };
	};

	const realLinear = {
		getIssue: issue,
		updateIssue: async (id: string, change: { state: string; marker: string }) => {
			// States are team-scoped: resolve through this issue's own team, never a global name match.
			const states = (await graphql(key, `query($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`, { id }))
				.issue.team.states.nodes as Array<{ id: string; name: string }>;
			const stateId = states.find(state => state.name === change.state)?.id;
			if (!stateId) throw new Error(`the issue team has no state named ${change.state}`);
			const current = await graphql(key, `query($id: String!) { issue(id: $id) { description } }`, { id });
			await graphql(key, `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
				{ id, input: { stateId, description: `${current.issue.description}\n\n${change.marker}` } });

		},
	};

	const request = { binding, runId: `live-${stamp}`, worktree, remote: "origin", prBase: "staging", branch: "feat/delivery",
		head, integrationBase: base, issue: identifier, reviewState: "In Dev", title: "omp-feat-flow live delivery",
		proofs, current: identity };

	// The Linear write really happens on the server; only the test's receipt is dropped.
	let dropped = false;
	let updates = 0;
	const droppedPorts: DeliveryPorts = {
		git: async (args) => { const r = Bun.spawnSync(["git", "-C", worktree, ...args]); return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; },
		github: {
			findPullRequests: async (branch) => {
				const out = await sh(tmpdir(), ["gh", "pr", "list", "--repo", full, "--head", branch, "--state", "all", "--json", "number,url,headRefOid,body"]);
				return JSON.parse(out) as Array<{ number: number; url: string; headRefOid: string; body: string }>;
			},
			createPullRequest: async (input) => {
				const out = await sh(tmpdir(), ["gh", "pr", "create", "--repo", full, "--head", input.head, "--base", input.base, "--title", input.title, "--body", input.body]);
				const number = Number(/(\d+)\s*$/.exec(out.trim())?.[1] ?? 0);
				return { number, url: out.trim(), headRefOid: head, body: input.body };
			},
		},
		linear: {
			getIssue: realLinear.getIssue,
			updateIssue: async (id, change) => {
				updates += 1;
				await realLinear.updateIssue(id, change);
				if (!dropped) { dropped = true; throw new Error("simulated connection loss after the server applied the backwrite"); }
			},
		},
	};

	// The write reaches the server; the receipt is lost; the same call reads the exact issue back.
	const first = await deliver(request, droppedPorts);
	expect(first.pr).not.toBeNull();
	expect(first.outcome).toBe("delivered");
	expect(first.linear?.updated).toBe(true);
	expect(updates).toBe(1);
	const afterFailure = await issue();
	expect(afterFailure?.hasMarker).toBe(true);
	const prsAfterFirst = JSON.parse(await sh(tmpdir(), ["gh", "pr", "list", "--repo", full, "--head", "feat/delivery", "--state", "all", "--json", "number"]));
	expect(prsAfterFirst.length).toBe(1);

	// Reconciliation: the same request reads the exact PR and issue back; nothing is repeated.
	const second = await deliver(request, droppedPorts);
	expect(second.outcome).toBe("delivered");
	expect(second.pr?.number).toBe(first.pr?.number);
	expect(second.linear).toMatchObject({ identifier, updated: false });
	expect(updates).toBe(1);
	const prsAfterSecond = JSON.parse(await sh(tmpdir(), ["gh", "pr", "list", "--repo", full, "--head", "feat/delivery", "--state", "all", "--json", "number"]));
	expect(prsAfterSecond.length).toBe(1);
	expect((await issue())?.hasMarker).toBe(true);

	await Bun.write(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
		repository: full, pullRequest: second.pr, issue: { identifier, state: (await issue())?.state },
		firstOutcome: first.outcome, secondOutcome: second.outcome, prCount: prsAfterSecond.length,
		linearWrites: updates, markerOccurrences: ((await issue())?.description ?? "").split(marker).length - 1,
	}, null, 2) + "\n");
}, 300_000);

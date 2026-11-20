import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTools } from "../../src/binding";
import { deliver, deliveryMarker, type DeliveryPorts } from "../../src/delivery";
import type { Proof } from "../../src/evidence";
import { git } from "../support/git-fixture";
import { desktopTeamId, graphql, linearKey } from "../support/linear";
import { parseLiveArgs } from "../support/native-host";

const CASE = "push-response-lost";
const args = parseLiveArgs();
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;
const LINEAR_TOOLS = ["mcp__linear_get_issue", "mcp__linear_update_issue"];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function sh(cwd: string, cmd: string[]): Promise<string> {
	const child = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${(err || out).slice(-600)}`);
	return out;
}

test(`live ${CASE}: a lost push receipt reconciles the exact remote head instead of pushing again`, async () => {
	if (args.only && args.only !== CASE) return;
	const scopes = await sh(tmpdir(), ["gh", "api", "-i", "user"]);
	if (!/x-oauth-scopes:\s*([^\r\n]+)/i.exec(scopes)?.[1]?.split(/,\s*/).includes("delete_repo")) {
		throw new Error("gh lacks delete_repo; the fixture repository would be unremovable");
	}
	const key = await linearKey();
	const owner = (await sh(tmpdir(), ["gh", "api", "user", "-q", ".login"])).trim();
	const stamp = Date.now().toString(36);
	const full = `${owner}/omp-feat-flow-push-${stamp}`;
	const repo = await mkdtemp(join(tmpdir(), "omp-feat-push-"));
	let issueId = "";
	cleanups.push(async () => {
		const deleted = await sh(tmpdir(), ["gh", "repo", "delete", full, "--yes"]).then(() => true).catch(() => false);
		await rm(repo, { recursive: true, force: true }).catch(() => {});
		if (!deleted) throw new Error(`cleanup failed: ${full} still exists`);
	});
	cleanups.push(async () => {
		if (issueId) await graphql(key, `mutation($id: String!) { issueDelete(id: $id) { success } }`, { id: issueId }).catch(() => {});
	});

	await sh(tmpdir(), ["gh", "repo", "create", full, "--private"]);
	await sh(repo, ["git", "init", "--initial-branch=main", "."]);
	await writeFile(join(repo, "README.md"), "fixture\n");
	await git(repo, ["-c", "user.email=f@e", "-c", "user.name=f", "add", "-A"]);
	await git(repo, ["-c", "user.email=f@e", "-c", "user.name=f", "commit", "-m", "base"]);
	await git(repo, ["branch", "staging"]);
	await git(repo, ["remote", "add", "origin", `https://github.com/${full}.git`]);
	await git(repo, ["config", "credential.https://github.com.helper", "!gh auth git-credential"]);
	await git(repo, ["push", "origin", "main", "staging"]);
	await writeFile(join(repo, "feature.txt"), "pushed\n");
	await git(repo, ["-c", "user.email=f@e", "-c", "user.name=f", "checkout", "-b", "feat/push"]);
	await git(repo, ["-c", "user.email=f@e", "-c", "user.name=f", "add", "-A"]);
	await git(repo, ["-c", "user.email=f@e", "-c", "user.name=f", "commit", "-m", "feature"]);
	const head = (await git(repo, ["rev-parse", "HEAD"])).trim();
	const base = (await git(repo, ["rev-parse", "origin/staging"])).trim();

	const created = await graphql(key, `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
		{ input: { teamId: await desktopTeamId(key), title: `[omp-feat-flow test] push ${stamp}`, description: "Deleted after the case." } });
	issueId = created.issueCreate.issue.id;
	const identifier = created.issueCreate.issue.identifier as string;

	const hash = (value: string) => createHash("sha256").update(value).digest("hex");
	const identity = { worktree: repo, base, head, candidateDigest: hash("c"), configDigest: hash("d"), inputRevision: 3 };
	const proofs: Proof[] = [{ ...identity, kind: "check", name: "typecheck", detail: "exit 0" }];
	const request = { binding: { captured: captureTools(LINEAR_TOOLS), current: [...LINEAR_TOOLS], expect: { server: "linear", tool: "get_issue" } },
		runId: `push-${stamp}`, worktree: repo, remote: "origin", prBase: "staging", branch: "feat/push",
		head, integrationBase: base, issue: identifier, reviewState: "In Dev", title: "push tracer", proofs, current: identity };

	let pushes = 0;
	let dropped = false;
	const ports: DeliveryPorts = {
		git: async (command) => {
			const result = Bun.spawnSync(["git", "-C", repo, ...command]);
			if (command[0] === "push") {
				pushes += 1;
				if (!dropped) { dropped = true; throw new Error("simulated receipt loss after the push applied"); }
			}
			return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
		},
		github: {
			findPullRequests: async (branch) => JSON.parse(await sh(tmpdir(), ["gh", "pr", "list", "--repo", full, "--head", branch, "--state", "all", "--json", "number,url,headRefOid,body"])) as Array<{ number: number; url: string; headRefOid: string; body: string }>,
			createPullRequest: async (input) => {
				const url = (await sh(tmpdir(), ["gh", "pr", "create", "--repo", full, "--head", input.head, "--base", input.base, "--title", input.title, "--body", input.body])).trim();
				return { number: Number(/(\d+)\s*$/.exec(url)?.[1] ?? 0), url, headRefOid: head, body: input.body };
			},
		},
		// Real Linear reads and one real backwrite; nothing here is a fabricated response.
		linear: {
			getIssue: async (_identifier: string, marker: string) => {
				const data = await graphql(key, `query($id: String!) { issue(id: $id) { identifier state { name } description } }`, { id: issueId });
				if (!data.issue) return null;
				const description = String(data.issue.description ?? "");
				return { identifier: data.issue.identifier, state: data.issue.state.name, hasMarker: description.includes(marker) };
			},
			updateIssue: async (id, change) => {
				const states = (await graphql(key, `query($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`, { id }))
					.issue.team.states.nodes as Array<{ id: string; name: string }>;
				const stateId = states.find(state => state.name === change.state)?.id;
				if (!stateId) throw new Error(`the issue team has no state named ${change.state}`);
				const current = await graphql(key, `query($id: String!) { issue(id: $id) { description } }`, { id });
				await graphql(key, `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
					{ id, input: { stateId, description: `${current.issue.description}\n\n${change.marker}` } });
			},
		},
	};

	const receipt = await deliver(request, ports);
	const remoteHead = (await git(repo, ["ls-remote", "origin", "refs/heads/feat/push"])).split(/\s/)[0];
	expect(receipt.outcome).toBe("delivered");
	expect(pushes).toBe(1);
	expect(remoteHead).toBe(head);

	await Bun.write(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
		repository: full, pushAttempts: pushes, remoteHead, localHead: head, outcome: receipt.outcome, pr: receipt.pr?.number,
	}, null, 2) + "\n");
}, 300_000);

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureTools } from "../../src/binding";
import { deliver, deliveryMarker, hasDeliveryMarker, type DeliveryPorts, type PullRequestHandle } from "../../src/delivery";
import type { Proof, ProofCurrent } from "../../src/evidence";
import { git as realGit } from "../support/git-fixture";

const LINEAR = ["mcp__linear_get_issue", "mcp__linear_update_issue"];
const binding = { captured: captureTools(LINEAR), current: [...LINEAR], expect: { server: "linear", tool: "get_issue" } };

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function localRemote(): Promise<{ root: string; remote: string; worktree: string; head: string }> {
	const root = await mkdtemp(join(tmpdir(), "omp-feat-delivery-"));
	roots.push(root);
	const remote = join(root, "origin.git");
	const worktree = join(root, "wt");
	await realGit(root, ["init", "--bare", "--initial-branch=main", remote]);
	await realGit(root, ["init", "--initial-branch=main", worktree]);
	await writeFile(join(worktree, "a.txt"), "one\n");
	await realGit(worktree, ["add", "a.txt"]);
	await realGit(worktree, ["-c", "user.name=F", "-c", "user.email=f@example.invalid", "commit", "-m", "base"]);
	await realGit(worktree, ["remote", "add", "origin", remote]);
	const head = (await realGit(worktree, ["rev-parse", "HEAD"])).trim();
	return { root, remote, worktree, head };
}

function gitPort(): DeliveryPorts["git"] {
	return async (args, cwd) => {
		try {
			const stdout = await realGit(cwd, args);
			return { code: 0, stdout, stderr: "" };
		} catch (error) {
			const output = error as { stdout?: string; stderr?: string };
			return { code: 1, stdout: output.stdout ?? "", stderr: output.stderr ?? String(error) };
		}
	};
}

const current: ProofCurrent = { worktree: "/wt", base: "a".repeat(40), head: "b".repeat(40),
	candidateDigest: "c".repeat(64), configDigest: "d".repeat(64), inputRevision: 1 };
const proof: Proof = { ...current, kind: "check", name: "unit", detail: "exit 0" };

test("stale evidence blocks delivery before any remote write", async () => {
	let gitCalls = 0;
	const ports: DeliveryPorts = {
		git: async () => { gitCalls += 1; return { code: 0, stdout: "", stderr: "" }; },
		github: { findPullRequests: async () => [], createPullRequest: async () => { throw new Error("must not create"); } },
		linear: { getIssue: async () => null, updateIssue: async () => { throw new Error("must not write"); } },
	};
	const receipt = await deliver({ runId: "r", worktree: "/wt", remote: "origin", prBase: "staging", branch: "feat/r",
		head: "b".repeat(40), integrationBase: "a".repeat(40), issue: "DESK-1", title: "t", reviewState: "In Review", proofs: [proof], binding,
		current: { ...current, base: "e".repeat(40) } }, ports);
	expect(receipt.outcome).toBe("blocked");
	expect(receipt.blockers[0]).toContain("review base");
	expect(gitCalls).toBe(0);
});

test("a lost create response reconciles the existing PR instead of creating a duplicate", async () => {
	const { worktree, head } = await localRemote();
	let creates = 0;
	const created: PullRequestHandle = { number: 7, url: "https://example.invalid/pr/7", headRefOid: head, body: deliveryMarker("r1") };
	const ports: DeliveryPorts = {
		git: gitPort(),
		github: {
			findPullRequests: async () => (creates > 0 ? [created] : []),
			createPullRequest: async () => { creates += 1; throw new Error("connection dropped after the server created the PR"); },
		},
		linear: { getIssue: async () => ({ identifier: "DESK-1", state: "Todo", hasMarker: false }), updateIssue: async () => {} },
	};
	const receipt = await deliver({ runId: "r1", worktree, remote: "origin", prBase: "staging", branch: "feat/r1",
		head, integrationBase: head, issue: "DESK-1", title: "t", reviewState: "In Review", proofs: [{ ...proof, head, base: head, worktree }], binding,
		current: { ...current, head, base: head, worktree } }, ports);
	expect(creates).toBe(1);
	expect(receipt.outcome).toBe("delivered");
	expect(receipt.pr?.number).toBe(7);
});

test("an already-applied Linear backwrite is settled by reading the issue, not by writing twice", async () => {
	const { worktree, head } = await localRemote();
	let updates = 0;
	const ports: DeliveryPorts = {
		git: gitPort(),
		github: { findPullRequests: async () => [{ number: 9, url: "u", headRefOid: head, body: deliveryMarker("r2") }],
			createPullRequest: async () => { throw new Error("must not create"); } },
		linear: {
			// Marker presence is judged per run: only this run's marker counts.
			getIssue: async (_identifier: string, marker: string) => ({ identifier: "DESK-2", state: "In Review", hasMarker: marker === deliveryMarker("r2") }),
			updateIssue: async () => { updates += 1; },
		},
	};
	const receipt = await deliver({ runId: "r2", worktree, remote: "origin", prBase: "staging", branch: "feat/r2",
		head, integrationBase: head, issue: "DESK-2", title: "t", reviewState: "In Review", proofs: [{ ...proof, head, base: head, worktree }], binding,
		current: { ...current, head, base: head, worktree } }, ports);
	expect(receipt.outcome).toBe("delivered");
	expect(receipt.linear).toMatchObject({ identifier: "DESK-2", updated: false });
	expect(updates).toBe(0);
});

test("a vanished MCP connection blocks before any remote write", async () => {
	let gitCalls = 0;
	const ports = {
		git: async () => { gitCalls += 1; return { code: 0, stdout: "", stderr: "" }; },
		github: { findPullRequests: async () => [], createPullRequest: async () => { throw new Error("must not be called"); } },
		linear: { getIssue: async () => null, updateIssue: async () => { throw new Error("must not be called"); } },
	};
	const receipt = await deliver({ runId: "r3", worktree: "/wt", remote: "origin", prBase: "staging", branch: "feat/r3",
		head: "b".repeat(40), integrationBase: "a".repeat(40), issue: "DESK-3", title: "t", reviewState: "In Review", proofs: [],
		binding: { captured: captureTools(LINEAR), current: ["mcp__other_get_issue"], expect: { server: "linear", tool: "get_issue" } },
		current: { worktree: "/wt", base: "a".repeat(40), head: "b".repeat(40), candidateDigest: "c", configDigest: "d", inputRevision: 1 } }, ports);
	expect(receipt.outcome).toBe("blocked");
	expect(gitCalls).toBe(0);
});

test("a marker is a whole token, so a longer run id cannot settle a shorter one", () => {
	expect(hasDeliveryMarker("body feat-flow-delivery:desk-1234 tail", deliveryMarker("desk-123"))).toBe(false);
	expect(hasDeliveryMarker("body feat-flow-delivery:desk-123 tail", deliveryMarker("desk-123"))).toBe(true);
	expect(hasDeliveryMarker("feat-flow-delivery:desk-1234", deliveryMarker("desk-1234"))).toBe(true);
});

test("a closed PR with the same head is not adopted; a new one is opened", async () => {
	const { worktree, head } = await localRemote();
	let creates = 0;
	const closed: PullRequestHandle = { number: 3, url: "https://example.invalid/pr/3", headRefOid: head, body: "", base: "staging", state: "CLOSED" };
	const opened: PullRequestHandle = { number: 4, url: "https://example.invalid/pr/4", headRefOid: head, body: "", base: "staging", state: "OPEN" };
	const ports: DeliveryPorts = {
		git: gitPort(),
		github: {
			findPullRequests: async () => (creates > 0 ? [opened] : [closed]),
			createPullRequest: async () => { creates += 1; return opened; },
		},
		linear: { getIssue: async (_id: string, marker: string) => ({ identifier: "DESK-9", state: "Todo", hasMarker: false }),
			updateIssue: async () => {} },
	};
	const base = head;
	const proofFor = { ...proof, worktree, head, base };
	const receipt = await deliver({ runId: "r9", worktree, remote: "origin", prBase: "staging", branch: "feat/r9",
		head, integrationBase: head, issue: "DESK-9", title: "t", reviewState: "In Review",
		proofs: [proofFor], binding, current: { ...current, worktree, head, base } }, ports);
	expect(creates).toBe(1);
	expect(receipt.outcome).toBe("delivered");
	expect(receipt.pr?.number).toBe(4);
});

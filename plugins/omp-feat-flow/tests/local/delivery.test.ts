import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliver, deliveryMarker, hasDeliveryMarker, type DeliveryPorts, type PullRequestHandle } from "../../src/delivery";
import type { Proof, ProofCurrent } from "../../src/evidence";
import { git as realGit } from "../support/git-fixture";

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
		const child = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		return { code, stdout, stderr };
	};
}

const current: ProofCurrent = {
	worktree: "/wt", base: "a".repeat(40), head: "b".repeat(40),
	candidateDigest: "c".repeat(64), configDigest: "d".repeat(64), inputRevision: 1,
};
const proof: Proof = { ...current, kind: "check", name: "unit", detail: "exit 0" };

test("stale evidence blocks delivery before any remote write", async () => {
	let gitCalls = 0;
	const ports: DeliveryPorts = {
		git: async () => { gitCalls += 1; return { code: 0, stdout: "", stderr: "" }; },
		github: { findPullRequests: async () => [], createPullRequest: async () => { throw new Error("must not create"); } },
		linear: { getIssue: async () => null, updateIssue: async () => { throw new Error("must not write"); } },
	};
	const receipt = await deliver({
		runId: "r", worktree: "/wt", remote: "origin", prBase: "staging", branch: "feat/r",
		head: "b".repeat(40), integrationBase: "a".repeat(40), issue: "DESK-1", title: "t", reviewState: "In Review",
		proofs: [proof], current: { ...current, base: "e".repeat(40) },
	}, ports);
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
	const receipt = await deliver({
		runId: "r1", worktree, remote: "origin", prBase: "staging", branch: "feat/r1",
		head, integrationBase: head, issue: "DESK-1", title: "t", reviewState: "In Review",
		proofs: [{ ...proof, head, base: head, worktree }], current: { ...current, head, base: head, worktree },
	}, ports);
	expect(creates).toBe(1);
	expect(receipt.outcome).toBe("delivered");
	expect(receipt.pr?.number).toBe(7);
});

test("an already-applied Linear backwrite is settled by reading the issue, not by writing twice", async () => {
	const { worktree, head } = await localRemote();
	let updates = 0;
	const ports: DeliveryPorts = {
		git: gitPort(),
		github: {
			findPullRequests: async () => [{ number: 9, url: "u", headRefOid: head, body: deliveryMarker("r2") }],
			createPullRequest: async () => { throw new Error("must not create"); },
		},
		linear: {
			getIssue: async (_identifier: string, marker: string) => ({ identifier: "DESK-2", state: "In Review", hasMarker: marker === deliveryMarker("r2") }),
			updateIssue: async () => { updates += 1; },
		},
	};
	const receipt = await deliver({
		runId: "r2", worktree, remote: "origin", prBase: "staging", branch: "feat/r2",
		head, integrationBase: head, issue: "DESK-2", title: "t", reviewState: "In Review",
		proofs: [{ ...proof, head, base: head, worktree }], current: { ...current, head, base: head, worktree },
	}, ports);
	expect(receipt.outcome).toBe("delivered");
	expect(receipt.linear).toMatchObject({ identifier: "DESK-2", updated: false });
	expect(updates).toBe(0);
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
		linear: { getIssue: async () => ({ identifier: "DESK-9", state: "Todo", hasMarker: false }), updateIssue: async () => {} },
	};
	const proofFor = { ...proof, worktree, head, base: head };
	const receipt = await deliver({
		runId: "r9", worktree, remote: "origin", prBase: "staging", branch: "feat/r9",
		head, integrationBase: head, issue: "DESK-9", title: "t", reviewState: "In Review",
		proofs: [proofFor], current: { ...current, worktree, head, base: head },
	}, ports);
	expect(creates).toBe(1);
	expect(receipt.outcome).toBe("delivered");
	expect(receipt.pr?.number).toBe(4);
});

test("GitHub-only mode (issue null) opens PR and delivers cleanly without touching Linear", async () => {
	const { worktree, head } = await localRemote();
	let linearCalls = 0;
	const opened: PullRequestHandle = { number: 12, url: "https://example.invalid/pr/12", headRefOid: head, body: "", base: "staging", state: "OPEN" };
	const ports: DeliveryPorts = {
		git: gitPort(),
		github: { findPullRequests: async () => [], createPullRequest: async () => opened },
		linear: {
			getIssue: async () => { linearCalls += 1; return null; },
			updateIssue: async () => { linearCalls += 1; },
		},
	};
	const receipt = await deliver({
		runId: "r-gh", worktree, remote: "origin", prBase: "staging", branch: "feat/r-gh",
		head, integrationBase: head, issue: null, title: "t", reviewState: "In Review",
		proofs: [{ ...proof, worktree, head, base: head }], current: { ...current, worktree, head, base: head },
	}, ports);
	expect(receipt.outcome).toBe("delivered");
	expect(receipt.pr?.number).toBe(12);
	expect(receipt.linear).toBeNull();
	expect(linearCalls).toBe(0);
});

test("pinned expectedRemoteTip prevents blindly overwriting a concurrent remote push", async () => {
	const { worktree, head } = await localRemote();
	const gitOps: string[][] = [];
	const ports: DeliveryPorts = {
		git: async (args, cwd) => {
			gitOps.push(args);
			if (args[0] === "ls-remote") return { code: 0, stdout: `${"9".repeat(40)}\trefs/heads/feat/r-pin\n`, stderr: "" };
			return gitPort()(args, cwd);
		},
		github: { findPullRequests: async () => [], createPullRequest: async () => { throw new Error("must not create"); } },
		linear: { getIssue: async () => null, updateIssue: async () => {} },
	};
	const receipt = await deliver({
		runId: "r-pin", worktree, remote: "origin", prBase: "staging", branch: "feat/r-pin",
		head, integrationBase: head, issue: null, title: "t", reviewState: "In Review",
		expectedRemoteTip: "1".repeat(40),
		proofs: [{ ...proof, worktree, head, base: head }], current: { ...current, worktree, head, base: head },
	}, ports);
	expect(receipt.outcome).toBe("unknown");
	expect(receipt.detail).toContain("remote tip moved");
	expect(gitOps.some(op => op[0] === "push")).toBe(false);
});

import { validateBinding, type BindingExpectation, type ToolSnapshot } from "./binding";
import { deliveryBlockers, type Proof, type ProofCurrent } from "./evidence";

export interface GitResult { code: number; stdout: string; stderr: string }

export interface PullRequestHandle { number: number; url: string; headRefOid: string; body: string; base?: string; state?: string }

/** The only remote surfaces delivery uses; each call is an exact read or an exact write. */
export interface DeliveryPorts {
	git(args: string[], cwd: string): Promise<GitResult>;
	github: {
		findPullRequests(headBranch: string): Promise<PullRequestHandle[]>;
		createPullRequest(input: { head: string; base: string; title: string; body: string }): Promise<PullRequestHandle>;
	};
	linear: {
		/** Marker presence must be judged against this run's exact marker, never any delivery marker. */
		getIssue(identifier: string, marker: string): Promise<{ identifier: string; state: string; hasMarker: boolean } | null>;
		updateIssue(identifier: string, input: { state: string; marker: string }): Promise<void>;
	};
}

export interface DeliveryRequest {
	/** The native MCP identity captured before any helper, plus the set active at delivery time. */
	binding: { captured: ToolSnapshot; current: string[]; expect: BindingExpectation };
	runId: string;
	worktree: string;
	remote: string;
	prBase: string;
	branch: string;
	head: string;
	integrationBase: string;
	issue: string;
	/** The team's actual review state, resolved from its metadata rather than assumed. */
	reviewState: string;
	title: string;
	proofs: Proof[];
	current: ProofCurrent;
}

export interface DeliveryReceipt {
	outcome: "delivered" | "blocked" | "unknown";
	blockers: string[];
	pr: PullRequestHandle | null;
	linear: { identifier: string; state: string; updated: boolean } | null;
	detail: string;
}

/** The PR body follows the upstream `pr` template: Summary, Evidence, Merge Danger. */
function prBody(request: DeliveryRequest, marker: string): string {
	const checks = request.proofs.map(proof => `- ${proof.kind} ${proof.name}: ${proof.detail.slice(0, 200)}`).join("\n");
	const scope = request.proofs.length > 0
		? "The change was reviewed against the approved scope and the project's vocabulary; the review proof is bound to this exact base and head."
		: "";
	return [`${marker}`,
		`\n## Summary\n${request.title} — the single delivery for run ${request.runId} against ${request.prBase}.`,
		`\n## Evidence\nBase ${request.integrationBase.slice(0, 12)} → head ${request.head.slice(0, 12)}.\n${checks || "No recorded proofs."}\n${scope}`,
		`\n## Merge Danger\n**Door:** one-way if the base moved under this branch (force-with-lease was used); review the rebase before merging.\n**Blast Radius:** this branch only; the run never merges or publishes itself.`].join("");
}

export function deliveryMarker(runId: string): string {
	return `feat-flow-delivery:${runId}`;
}

/** A marker is a whole token: run `desk-123` must never match run `desk-1234`. */
export function hasDeliveryMarker(description: string, marker: string): boolean {
	const pattern = new RegExp(`${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9._-])`);
	return pattern.test(description);
}

/**
 * Does the side effect once and repairs partial success by reading the exact object back.
 * A lost response never triggers a second create: the existing PR or issue state is reconciled.
 */
export async function deliver(request: DeliveryRequest, ports: DeliveryPorts): Promise<DeliveryReceipt> {
	const marker = deliveryMarker(request.runId);
	const binding = validateBinding(request.binding.captured, request.binding.current, request.binding.expect);
	const blockers = [...binding.blockers, ...deliveryBlockers(request.proofs, request.current)];
	if (blockers.length > 0) return { outcome: "blocked", blockers, pr: null, linear: null, detail: "the captured binding or the evidence no longer matches this delivery" };

	// Push exactly this head; an already-matching remote head is a settled push, not a new one.
	const remoteHead = await ports.git(["ls-remote", "--heads", request.remote, request.branch], request.worktree).catch(() => null);
	if (remoteHead === null || remoteHead.code !== 0) {
		return { outcome: "unknown", blockers: [], pr: null, linear: null, detail: "the remote head could not be read; nothing is assumed about the push" };
	}
	const remoteSha = /^([0-9a-f]{40})\s/m.exec(remoteHead.stdout)?.[1] ?? null;
	if (remoteSha !== request.head) {
		// The lease names the exact ref we just read: a concurrent push becomes a definite rejection,
		// not an "unknown" that no retry can clear.
		// A rejected promise and a failed exit code are the same fact: the receipt is lost, so read the remote.
		const pushed = await ports.git(["push", `--force-with-lease=refs/heads/${request.branch}:${remoteSha ?? ""}`,
			request.remote, `${request.head}:refs/heads/${request.branch}`], request.worktree)
			.catch((error: unknown) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
		if (pushed.code !== 0) {
			const after = await ports.git(["ls-remote", "--heads", request.remote, request.branch], request.worktree).catch(() => null);
			const now = after && after.code === 0 ? /^([0-9a-f]{40})\s/m.exec(after.stdout)?.[1] ?? null : null;
			if (after === null || after.code !== 0 || now !== request.head) {
				return { outcome: "unknown", blockers: [], pr: null, linear: null,
					detail: `push did not apply (remote head ${now?.slice(0, 12) ?? "unreadable"}): ${pushed.stderr.trim().slice(0, 300)}` };
			}
		}
	}

	// One open PR to the approved base per requirement; a closed or retargeted PR is not this delivery.
	const usable = (candidate: PullRequestHandle): boolean => (candidate.base === undefined || candidate.base === request.prBase)
		&& (candidate.state === undefined || candidate.state === "OPEN");
	// Reconcile an existing exact-head PR before creating anything.
	const existing = (await ports.github.findPullRequests(request.branch)).filter(pr => pr.headRefOid === request.head && usable(pr));
	let pr: PullRequestHandle;
	if (existing.length > 1) {
		return { outcome: "unknown", blockers: [], pr: null, linear: null, detail: "more than one pull request matches this head; refusing to guess" };
	}
	if (existing.length === 1) pr = existing[0]!;
	else {
		try {
			pr = await ports.github.createPullRequest({ head: request.branch, base: request.prBase, title: request.title,
				// The upstream `pr` skill's body shape: the smallest statement of the change, real evidence,
				// and an explicit door call, instead of a bare marker line.
				body: prBody(request, marker) });
		} catch (error) {
			const reconciled = (await ports.github.findPullRequests(request.branch)).filter(candidate => candidate.headRefOid === request.head && usable(candidate));
			if (reconciled.length !== 1) {
				return { outcome: "unknown", blockers: [], pr: null, linear: null,
					detail: `create response lost and reconciliation found ${reconciled.length} candidates: ${error instanceof Error ? error.message : String(error)}` };
			}
			pr = reconciled[0]!;
		}
	}

	// Linear backwrite: an issue already carrying the marker is settled, never updated twice.
	const issue = await ports.linear.getIssue(request.issue, marker);
	if (!issue) return { outcome: "unknown", blockers, pr, linear: null, detail: `issue ${request.issue} was not readable through the captured binding` };
	if (issue.hasMarker) {
		return { outcome: "delivered", blockers: [], pr, linear: { identifier: issue.identifier, state: issue.state, updated: false },
			detail: `PR #${pr.number} and ${issue.identifier} were already reconciled` };
	}
	try {
		await ports.linear.updateIssue(request.issue, { state: request.reviewState, marker });
	} catch (error) {
		const after = await ports.linear.getIssue(request.issue, marker);
		if (after?.hasMarker) {
			return { outcome: "delivered", blockers: [], pr, linear: { identifier: after.identifier, state: after.state, updated: true },
				detail: `backwrite confirmed by reading ${after.identifier} back` };
		}
		return { outcome: "unknown", blockers, pr, linear: { identifier: request.issue, state: after?.state ?? "unknown", updated: false },
			detail: `Linear backwrite unconfirmed: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { outcome: "delivered", blockers: [], pr, linear: { identifier: request.issue, state: "In Review", updated: true },
		detail: `PR #${pr.number} opened against ${request.prBase}; ${request.issue} moved to In Review` };
}

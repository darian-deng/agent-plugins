import { deliveryBlockers, type Proof, type ProofCurrent } from "./evidence";

export interface GitResult { code: number; stdout: string; stderr: string }

export interface PullRequestHandle {
	number: number;
	url: string;
	headRefOid: string;
	body: string;
	base?: string;
	state?: string;
	isCrossRepository?: boolean;
}

export type DeliveryStepStatus = "not-started" | "in-flight" | "settled";

export interface DeliveryStepStates {
	push: DeliveryStepStatus;
	pr: DeliveryStepStatus;
	linearState: DeliveryStepStatus;
	linearComment: DeliveryStepStatus;
	prNumber?: number | undefined;
	prUrl?: string | undefined;
}

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
		updateIssue(identifier: string, input: { state: string; marker: string; prUrl?: string }): Promise<void>;
	};
}

export interface DeliveryRequest {
	runId: string;
	worktree: string;
	remote: string;
	prBase: string;
	branch: string;
	head: string;
	integrationBase: string;
	/** Optional: null in GitHub-only / optional Linear mode when no issue is bound. */
	issue: string | null;
	/** Optional pinned remote tip before sync/push; prevents blindly overwriting concurrent remote commits. */
	expectedRemoteTip?: string | null;
	reviewState: string;
	title: string;
	proofs: Proof[];
	current: ProofCurrent;
	onStepUpdate?: (steps: DeliveryStepStates) => Promise<void> | void;
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
 * Does each external effect once and repairs partial success by reading the exact object back.
 * Supports GitHub-only mode (`issue === null`) and pinned `expectedRemoteTip` protection.
 */
export async function deliver(request: DeliveryRequest, ports: DeliveryPorts): Promise<DeliveryReceipt> {
	const marker = deliveryMarker(request.runId);
	const blockers = deliveryBlockers(request.proofs, request.current);
	if (blockers.length > 0) {
		return { outcome: "blocked", blockers, pr: null, linear: null, detail: "the recorded evidence no longer matches this delivery" };
	}
	const steps: DeliveryStepStates = {
		push: "not-started",
		pr: "not-started",
		linearState: "not-started",
		linearComment: "not-started",
	};
	const reportSteps = async () => { await request.onStepUpdate?.({ ...steps }); };
	const remoteHead = await ports.git(["ls-remote", "--heads", request.remote, request.branch], request.worktree).catch(() => null);
	if (remoteHead === null || remoteHead.code !== 0) {
		return { outcome: "unknown", blockers: [], pr: null, linear: null, detail: "the remote head could not be read; nothing is assumed about the push" };
	}
	const remoteSha = /^([0-9a-f]{40})\s/m.exec(remoteHead.stdout)?.[1] ?? null;
	if (remoteSha !== request.head) {
		if (request.expectedRemoteTip !== undefined && remoteSha !== request.expectedRemoteTip) {
			return {
				outcome: "unknown",
				blockers: [],
				pr: null,
				linear: null,
				detail: `remote tip moved concurrently (${remoteSha?.slice(0, 12) ?? "none"} !== expected ${request.expectedRemoteTip?.slice(0, 12) ?? "none"}); refusing to overwrite`,
			};
		}
		steps.push = "in-flight";
		await reportSteps();
		const pushed = await ports.git([
			"push",
			`--force-with-lease=refs/heads/${request.branch}:${remoteSha ?? ""}`,
			request.remote,
			`${request.head}:refs/heads/${request.branch}`,
		], request.worktree).catch((error: unknown) => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
		if (pushed.code !== 0) {
			const after = await ports.git(["ls-remote", "--heads", request.remote, request.branch], request.worktree).catch(() => null);
			const now = after && after.code === 0 ? /^([0-9a-f]{40})\s/m.exec(after.stdout)?.[1] ?? null : null;
			if (after === null || after.code !== 0 || now !== request.head) {
				return {
					outcome: "unknown",
					blockers: [],
					pr: null,
					linear: null,
					detail: `push did not apply (remote head ${now?.slice(0, 12) ?? "unreadable"}): ${pushed.stderr.trim().slice(0, 300)}`,
				};
			}
		}
	}
	steps.push = "settled";
	await reportSteps();

	const usable = (candidate: PullRequestHandle): boolean =>
		(candidate.base === undefined || candidate.base === request.prBase)
		&& (candidate.state === undefined || candidate.state === "OPEN")
		&& candidate.isCrossRepository !== true;
	const matchesHeadOrSameRepoOpen = (candidate: PullRequestHandle): boolean =>
		usable(candidate) && (candidate.headRefOid === request.head || (candidate.base === request.prBase && candidate.state === "OPEN"));
	const existing = (await ports.github.findPullRequests(request.branch)).filter(matchesHeadOrSameRepoOpen);
	let pr: PullRequestHandle;
	if (existing.length > 1) {
		return { outcome: "unknown", blockers: [], pr: null, linear: null, detail: "more than one pull request matches this head; refusing to guess" };
	}
	if (existing.length === 1) pr = existing[0]!;
	else {
		steps.pr = "in-flight";
		await reportSteps();
		try {
			pr = await ports.github.createPullRequest({
				head: request.branch,
				base: request.prBase,
				title: request.title,
				body: prBody(request, marker),
			});
		} catch (error) {
			const reconciled = (await ports.github.findPullRequests(request.branch)).filter(matchesHeadOrSameRepoOpen);
			if (reconciled.length !== 1) {
				return {
					outcome: "unknown",
					blockers: [],
					pr: null,
					linear: null,
					detail: `create response lost and reconciliation found ${reconciled.length} candidates: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			pr = reconciled[0]!;
		}
	}
	steps.pr = "settled";
	steps.prNumber = pr.number;
	steps.prUrl = pr.url;
	await reportSteps();
	if (!request.issue) {
		return {
			outcome: "delivered",
			blockers: [],
			pr,
			linear: null,
			detail: `PR #${pr.number} opened against ${request.prBase} (GitHub-only mode)`,
		};
	}

	const issue = await ports.linear.getIssue(request.issue, marker);
	if (!issue) {
		return { outcome: "unknown", blockers, pr, linear: null, detail: `PR #${pr.number} opened; issue ${request.issue} was not readable` };
	}
	if (issue.hasMarker) {
		steps.linearState = "settled";
		steps.linearComment = "settled";
		await reportSteps();
		return {
			outcome: "delivered",
			blockers: [],
			pr,
			linear: { identifier: issue.identifier, state: issue.state, updated: false },
			detail: `PR #${pr.number} and ${issue.identifier} were already reconciled`,
		};
	}
	steps.linearState = "in-flight";
	steps.linearComment = "in-flight";
	await reportSteps();
	try {
		await ports.linear.updateIssue(request.issue, { state: request.reviewState, marker, prUrl: pr.url });
	} catch (error) {
		const after = await ports.linear.getIssue(request.issue, marker).catch(() => null);
		if (after?.hasMarker) {
			steps.linearState = "settled";
			steps.linearComment = "settled";
			await reportSteps();
			return {
				outcome: "delivered",
				blockers: [],
				pr,
				linear: { identifier: after.identifier, state: after.state, updated: true },
				detail: `backwrite confirmed by reading ${after.identifier} back`,
			};
		}
		return {
			outcome: "unknown",
			blockers,
			pr,
			linear: { identifier: request.issue, state: after?.state ?? "unknown", updated: false },
			detail: `PR #${pr.number} opened; Linear backwrite pending: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	steps.linearState = "settled";
	steps.linearComment = "settled";
	await reportSteps();
	return {
		outcome: "delivered",
		blockers: [],
		pr,
		linear: { identifier: request.issue, state: request.reviewState, updated: true },
		detail: `PR #${pr.number} opened against ${request.prBase}; ${request.issue} moved to ${request.reviewState}`,
	};
}

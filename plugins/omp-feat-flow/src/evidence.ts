
export type ProofKind = "check" | "review";

/** What a proof actually ran on; nothing here is inferred from an author's summary. */
export interface ProofIdentity {
	worktree: string;
	base: string;
	head: string;
	candidateDigest: string;
	configDigest: string;
	inputRevision: number;
}

export interface Proof extends ProofIdentity {
	kind: ProofKind;
	name: string;
	/** Free-form outcome recorded by the runner (command, exit code, reviewer verdict). */
	detail: string;
}

export interface ProofCurrent extends ProofIdentity {}

export function staleReasons(proof: Proof, current: ProofCurrent): string[] {
	const reasons: string[] = [];
	if (proof.worktree !== current.worktree) reasons.push("worktree");
	if (proof.base !== current.base) reasons.push("review base");
	if (proof.head !== current.head) reasons.push("head");
	if (proof.candidateDigest !== current.candidateDigest) reasons.push("candidate");
	if (proof.configDigest !== current.configDigest) reasons.push("configuration");
	if (proof.inputRevision !== current.inputRevision) reasons.push("input revision");
	return reasons;
}

/** Delivery is closed while any proof no longer matches the current worktree. */
export function deliveryBlockers(proofs: readonly Proof[], current: ProofCurrent): string[] {
	return proofs.flatMap(proof => {
		const reasons = staleReasons(proof, current);
		return reasons.length === 0 ? [] : [`${proof.kind} ${proof.name} is stale (${reasons.join(", ")})`];
	});
}

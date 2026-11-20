import { expect, test } from "bun:test";
import { deliveryBlockers, staleReasons, type Proof, type ProofIdentity } from "../../src/evidence";

const base: ProofIdentity = { worktree: "/w/a", base: "a".repeat(40), head: "b".repeat(40),
	candidateDigest: "c".repeat(64), configDigest: "d".repeat(64), inputRevision: 3 };
const proof = (overrides: Partial<Proof> = {}): Proof => ({ ...base, kind: "check", name: "unit", detail: "exit 0", ...overrides });

test("a proof only speaks for the exact worktree revision it ran on", () => {
	expect(staleReasons(proof(), base)).toEqual([]);
	expect(staleReasons(proof(), { ...base, base: "e".repeat(40) })).toEqual(["review base"]);
	expect(staleReasons(proof(), { ...base, head: "f".repeat(40) })).toEqual(["head"]);
	expect(staleReasons(proof(), { ...base, inputRevision: 4 })).toEqual(["input revision"]);
});

test("delivery stays closed while any proof is stale, and sync alone makes it stale", () => {
	const check = proof();
	const review = proof({ kind: "review", name: "spec" });
	expect(deliveryBlockers([check, review], base)).toEqual([]);
	// A sync moves only the review base; both proofs stop attesting the current code.
	const afterSync = { ...base, base: "1".repeat(40) };
	const blockers = deliveryBlockers([check, review], afterSync);
	expect(blockers).toHaveLength(2);
	expect(blockers[0]).toContain("review base");
	expect(blockers[1]).toContain("spec");
});

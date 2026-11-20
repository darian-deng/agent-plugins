import { expect, test } from "bun:test";
import { reconcileInterruptedSync } from "../../src/reconcile";

const base = { rebasing: false, porcelain: "", head: "a".repeat(40), integrationSha: "a".repeat(40) };

test("only a clean, unmoved worktree is settled automatically", () => {
	expect(reconcileInterruptedSync(base)).toEqual({ kind: "reclaim", reason: "clean-tree" });
	expect(reconcileInterruptedSync({ ...base, rebasing: true })).toEqual({ kind: "blocked", reason: "rebase-in-progress" });
	expect(reconcileInterruptedSync({ ...base, porcelain: " M file.txt\n" })).toEqual({ kind: "blocked", reason: "foreign-changes" });
	expect(reconcileInterruptedSync({ ...base, head: "b".repeat(40) })).toEqual({ kind: "blocked", reason: "head-moved" });
});

test("a clean worktree whose HEAD descends from the fetched base is an applied rebase", () => {
	const base = { rebasing: false, porcelain: "", head: "b".repeat(40), integrationSha: "a".repeat(40),
		baseSha: "c".repeat(40), headDescendsFromBase: true };
	expect(reconcileInterruptedSync(base)).toEqual({ kind: "applied", head: "b".repeat(40) });
	expect(reconcileInterruptedSync({ ...base, headDescendsFromBase: false })).toEqual({ kind: "blocked", reason: "head-moved" });
	expect(reconcileInterruptedSync({ ...base, baseSha: null })).toEqual({ kind: "blocked", reason: "head-moved" });
	expect(reconcileInterruptedSync({ ...base, porcelain: " M x\n" })).toEqual({ kind: "blocked", reason: "foreign-changes" });
});

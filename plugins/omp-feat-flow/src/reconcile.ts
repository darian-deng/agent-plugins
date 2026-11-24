export type SyncReconciliation =
	| { kind: "reclaim"; reason: "clean-tree" }
	| { kind: "applied"; head: string }
	| { kind: "blocked"; reason: "rebase-in-progress" | "foreign-changes" | "head-moved" };

/**
 * Decides an interrupted sync from observed Git state only. The ledger is not evidence of what
 * happened, so settlement is derived from the worktree: an interrupted rebase either applied
 * (HEAD descends from the fetched base), left nothing (HEAD still on the old base), or is
 * undecidable and stays blocked.
 */
export function reconcileInterruptedSync(input: {
	rebasing: boolean;
	porcelain: string;
	head: string;
	integrationSha: string;
	preSyncHead?: string | null;
	/** The fetched PR base, when it could be read. */
	baseSha?: string | null;
	/** Whether HEAD is a descendant of that base (computed with git, not assumed). */
	headDescendsFromBase?: boolean;
}): SyncReconciliation {
	if (input.rebasing) return { kind: "blocked", reason: "rebase-in-progress" };
	if (input.porcelain.trim()) return { kind: "blocked", reason: "foreign-changes" };
	if (input.head === input.integrationSha || (input.preSyncHead && input.head === input.preSyncHead)) {
		return { kind: "reclaim", reason: "clean-tree" };
	}
	if (input.baseSha && input.headDescendsFromBase) return { kind: "applied", head: input.head };
	return { kind: "blocked", reason: "head-moved" };
}

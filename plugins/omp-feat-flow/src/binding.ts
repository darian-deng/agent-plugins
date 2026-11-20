import { createHash } from "node:crypto";

export interface ToolSnapshot {
	/** Exact active tool names as the native host reported them at capture time. */
	names: string[];
	digest: string;
}

/** Capture the active tool set once, before any helper session exists. */
export function captureTools(names: string[]): ToolSnapshot {
	const sorted = [...names].sort();
	return { names: sorted, digest: digestOf(sorted) };
}

function digestOf(names: string[]): string {
	const hash = createHash("sha256");
	for (const name of names) hash.update(name).update("\0");
	return hash.digest("hex");
}

export interface BindingExpectation {
	/** Server and tool must both match; a same-named tool from another server is a substitution. */
	server: string;
	tool: string;
}

export interface BindingCheck {
	ok: boolean;
	blockers: string[];
}

/**
 * The native host reports names, not manager objects. Requiring the exact minted name in both the
 * captured and the current set is the strictest check available: a vanished or replaced server
 * cannot satisfy it, and nothing here reacquires a connection by searching for a similar name.
 */
export function validateBinding(captured: ToolSnapshot, current: string[], expectation: BindingExpectation): BindingCheck {
	const minted = `mcp__${expectation.server.replace(/[^a-zA-Z0-9_]/g, "_")}_${expectation.tool}`;
	const blockers: string[] = [];
	if (!captured.names.includes(minted)) blockers.push(`the captured tool set never contained ${minted}`);
	if (!current.includes(minted)) blockers.push(`${minted} is not active now; refusing to substitute another connection`);
	if (digestOf(captured.names) !== captured.digest) blockers.push("the captured tool set was altered after capture");
	return { ok: blockers.length === 0, blockers };
}

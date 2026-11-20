import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export interface KnowledgeCandidate {
	/** Path relative to the project root. */
	path: string;
	/** The full intended content of the file. */
	proposed: string;
	/** Why this correction is warranted by a recurring, observed failure. */
	reason: string;
}

export interface KnowledgeRequest {
	root: string;
	candidates: KnowledgeCandidate[];
}

export interface KnowledgeChange {
	path: string;
	status: "modified" | "created";
	diff: string[];
}

export interface KnowledgeProposal {
	change: boolean;
	reason: string;
	changes: KnowledgeChange[];
}

/** A trailing newline is one empty tail element on both sides; it is not a content change. */
function lines(text: string): string[] {
	const parts = text.split("\n");
	if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts;
}

function lineDiff(before: string[], after: string[]): string[] {
	const diff: string[] = [];
	const max = Math.max(before.length, after.length);
	for (let index = 0; index < max; index += 1) {
		const old = before[index];
		const next = after[index];
		if (old === next) continue;
		if (old !== undefined) diff.push(`-${old}`);
		if (next !== undefined) diff.push(`+${next}`);
	}
	return diff;
}

/**
 * A correction is proposed only when a real file would actually change and the caller names a concrete
 * recurring failure. Empty requests produce no documentation, no glossary and no new rules.
 */
export async function proposeKnowledge(request: KnowledgeRequest): Promise<KnowledgeProposal> {
	if (request.candidates.length === 0) {
		return { change: false, reason: "Nothing in the current project knowledge is contradicted by observed evidence.", changes: [] };
	}
	const root = resolve(request.root);
	const changes: KnowledgeChange[] = [];
	for (const candidate of request.candidates) {
		if (!candidate.reason.trim()) throw new Error(`${candidate.path}: a knowledge correction needs its concrete reason.`);
		const target = resolve(join(root, candidate.path));
		if (!target.startsWith(root + "/")) throw new Error(`${candidate.path} escapes the project root.`);
		const existing = await readFile(target, "utf8").catch(() => null);
		if (existing === candidate.proposed) continue;
		const diff = existing === null ? lines(candidate.proposed).map(line => `+${line}`)
			: lineDiff(lines(existing), lines(candidate.proposed));
		if (diff.length === 0) continue;
		changes.push({ path: relative(root, target), status: existing === null ? "created" : "modified", diff });
	}
	if (changes.length === 0) {
		return { change: false, reason: "The proposed content already matches the existing files; no correction is warranted.", changes: [] };
	}
	return { change: true, reason: `${changes.length} file(s) would change; the diff needs explicit approval.`, changes };
}

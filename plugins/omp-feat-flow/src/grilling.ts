

export type BoundaryCategory = "goals" | "non-goals" | "business-boundary" | "error-path" | "acceptance";

// The five areas the design names; "authorization" was a flow-internal concept leaking into
// domain questions — the permission boundary is governed by the approval machinery, not asked of the user.
export const BOUNDARY_CATEGORIES: BoundaryCategory[] = ["goals", "non-goals", "business-boundary", "error-path", "acceptance"];

export interface BoundaryDecision {
	category: BoundaryCategory;
	answer: string;
}

export interface Boundary {
	category: BoundaryCategory;
}

/**
 * Both entries converge here: whatever the material already answers stays answered, and only the
 * categories it leaves open become questions. Nothing is asked twice.
 */
export interface GrillResult {
	decided: BoundaryDecision[];
	open: Boundary[];
}

const DECISIONS_HEADING = /^##\s+Decisions\s*$/i;
const RULE = /^[-*]\s+([a-z-]+)\s*:\s*(.+)$/i;

/** Read the explicit decisions a PRD records; anything absent from this section is still open. */
export function readPrdDecisions(markdown: string): BoundaryDecision[] {
	const decisions: BoundaryDecision[] = [];
	let inside = false;
	for (const line of markdown.split("\n")) {
		if (DECISIONS_HEADING.test(line.trim())) {
			inside = true;
			continue;
		}
		if (!inside) continue;
		if (/^##\s+/.test(line)) break;
		const match = RULE.exec(line.trim());
		if (!match) continue;
		const category = match[1] as BoundaryCategory;
		if (!BOUNDARY_CATEGORIES.includes(category)) continue;
		decisions.push({ category, answer: match[2]!.trim() });
	}
	return decisions;
}

function openBoundaries(decided: BoundaryDecision[], _facts: string[]): Boundary[] {
	const answered = new Set(decided.map(decision => decision.category));
	// The question for an open boundary is asked with a recommended answer, upstream grilling
	// style; answers are recorded by the human, not by the model.
	return BOUNDARY_CATEGORIES.filter(category => !answered.has(category)).map(category => ({ category }));
}

export function grillFromPrd(markdown: string, facts: string[]): GrillResult {
	const decided = readPrdDecisions(markdown);
	return { decided, open: openBoundaries(decided, facts) };
}

/** A conversation entry supplies the same answers explicitly; no category is re-interviewed. */
export function grillFromConversation(answers: BoundaryDecision[], facts: string[]): GrillResult {
	if (!Array.isArray(answers)) throw new Error("Boundary answers must be a JSON array of {category, answer} objects.");
	const seen = new Set<BoundaryCategory>();
	for (const answer of answers) {
		if (!BOUNDARY_CATEGORIES.includes(answer.category)) throw new Error(`Unknown boundary category: ${answer.category}`);
		if (seen.has(answer.category)) throw new Error(`Duplicate boundary answer for ${answer.category}.`);
		if (!answer.answer.trim()) throw new Error(`The ${answer.category} answer is empty.`);
		seen.add(answer.category);
	}
	return { decided: answers, open: openBoundaries(answers, facts) };
}



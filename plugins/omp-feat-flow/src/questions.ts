import { createHash } from "node:crypto";

export interface QuestionOption {
	id: string;
	label: string;
	/** What the chooser gives up or gains. */
	tradeoff: string;
	/** Exactly what this choice permits once granted. */
	permission: string;
}

export interface QuestionPacket {
	/** Digest of the canonical content; a change of any field changes it. */
	id: string;
	purpose: string;
	facts: string[];
	options: QuestionOption[];
	recommendation: string | null;
	missingInformation: string[];
	permissions: string[];
}

export interface QuestionInput {
	purpose: string;
	facts: string[];
	options: QuestionOption[];
	recommendation?: string | null;
	missingInformation?: string[];
	permissions: string[];
}

function canonical(input: QuestionInput): string {
	return JSON.stringify({
		purpose: input.purpose,
		facts: input.facts,
		options: input.options,
		recommendation: input.recommendation ?? null,
		missingInformation: input.missingInformation ?? [],
		permissions: input.permissions,
	});
}

export function buildPacket(input: QuestionInput): QuestionPacket {
	if (!input.purpose.trim()) throw new Error("A question packet needs its purpose.");
	if (input.options.length === 0) throw new Error("A question packet needs at least one option.");
	if (input.permissions.length === 0) throw new Error("A question packet must state the permission consequences.");
	const ids = new Set(input.options.map(option => option.id));
	if (ids.size !== input.options.length) throw new Error("Option ids must be unique.");
	for (const option of input.options) {
		if (!option.permission.trim()) throw new Error(`Option ${option.id} must state what it permits.`);
	}
	return { id: createHash("sha256").update(canonical(input)).digest("hex"), purpose: input.purpose, facts: [...input.facts],
		options: input.options.map(option => ({ ...option })), recommendation: input.recommendation ?? null,
		missingInformation: [...(input.missingInformation ?? [])], permissions: [...input.permissions] };
}

/** The single rendering shared by the cold reader and the native fields the human sees. */
export function renderPacket(packet: QuestionPacket): string {
	const lines = [`Purpose: ${packet.purpose}`, "Facts:"];
	for (const fact of packet.facts) lines.push(`- ${fact}`);
	if (packet.missingInformation.length > 0) {
		lines.push("Missing information:");
		for (const missing of packet.missingInformation) lines.push(`- ${missing}`);
	}
	lines.push("Options:");
	for (const option of packet.options) {
		lines.push(`- ${option.id}: ${option.label} | tradeoff: ${option.tradeoff} | permits: ${option.permission}`);
	}
	if (packet.recommendation !== null) lines.push(`Recommendation: ${packet.recommendation}`);
	lines.push("Permission consequences:");
	for (const permission of packet.permissions) lines.push(`- ${permission}`);
	return lines.join("\n");
}

/**
 * The cold reader receives the packet itself, not a summary of the conversation, and must answer
 * whether the packet is answerable without its author. It never gets tools.
 */
export function coldReadPrompt(packet: QuestionPacket): string {
	return [
		"You are a cold reader. You have no tools and no conversation history.",
		"Answer only from the packet below.",
		"First line: ANSWERABLE or NOT_ANSWERABLE, then the option id you would choose, or BLOCKED and the exact missing fact.",
		"Then explain in at most three sentences why, citing packet lines.",
		"",
		renderPacket(packet),
	].join("\n");
}

export interface ApprovalInput {
	runId: string;
	candidateRevision: number;
	content: string;
	scope: string;
	base: string;
}

/** The approval packet: the candidate, what approving permits, and what it does not. */
export function approvalPacket(input: ApprovalInput): QuestionPacket {
	return buildPacket({
		purpose: `Approve the design for ${input.runId} candidate revision ${input.candidateRevision}?`,
		facts: [`Scope: ${input.scope}`, `Base: ${input.base}`, `Proposal: ${input.content}`],
		options: [
			{ id: "approve", label: "Approve this candidate", tradeoff: "Implementation writes open for this scope only.",
				permission: "Permits implementation writes inside the stated scope at the current revision and input revision." },
			{ id: "cancel", label: "Keep implementation closed", tradeoff: "Nothing is written; the candidate stays reviewable.",
				permission: "Permits nothing; the run stays in alignment." },
		],
		recommendation: null,
		missingInformation: [],
		permissions: [
			"Approval binds this run, owner epoch, candidate digest and input revision.",
			"A later candidate or input change makes this grant stale; it is never silently extended.",
			"Approval does not permit merge, publication or delivery.",
		],
	});
}

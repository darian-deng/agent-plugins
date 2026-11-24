import { expect, test } from "bun:test";
import { deriveRequirementProfile, type AlignmentDocument } from "../../src/profile";
import {
	alignmentColdReadPrompt,
	approvalPacket,
	buildPacket,
	knowledgeColdReadPrompt,
	parseAlignmentColdReadVerdict,
	parseKnowledgeColdReadVerdict,
	parseReviewVerdict,
	renderPacket,
	validateApprovalPacket,
	type QuestionOption,
} from "../../src/questions";
import { buildAlignmentReadModel } from "../../src/tech-design";

const input = {
	purpose: "Which storage should the export use?",
	facts: ["Exports are under 50 MB.", "The service writes to Postgres today."],
	options: [
		{ id: "file", label: "A local file", tradeoff: "No new dependency; not shared between hosts.",
			permission: "Permits writing an export file inside the run worktree." },
		{ id: "table", label: "A database table", tradeoff: "Shared and queryable; needs a migration.",
			permission: "Permits one additive migration inside the approved scope." },
	],
	recommendation: "file" as const,
	missingInformation: ["Retention period"],
	permissions: ["No production data is read."],
};

test("packet rendering keeps option tradeoffs, missing facts, and permissions consistent", () => {
	const packet = buildPacket(input);
	const rendered = renderPacket(packet);
	expect(rendered).toContain("Permits one additive migration inside the approved scope.");
	expect(rendered).toContain("Missing information:\n- Retention period");
	expect(rendered).toContain("Recommendation: file");
});

const [fileOption, tableOption] = input.options as [QuestionOption, QuestionOption];

test("any change to the packet changes its identity", () => {
	const first = buildPacket(input);
	const second = buildPacket({ ...input, facts: [...input.facts, "Exports can reach 60 MB."] });
	expect(second.id).not.toBe(first.id);
	const third = buildPacket({ ...input, options: [fileOption, { ...tableOption, permission: "Permits merge." }] });
	expect(third.id).not.toBe(first.id);
	expect(buildPacket(input).id).toBe(first.id);
});

test("a packet without a stated consequence or purpose is refused", () => {
	expect(() => buildPacket({ ...input, purpose: "  " })).toThrow();
	expect(() => buildPacket({ ...input, permissions: [] })).toThrow();
	expect(() => buildPacket({ ...input, options: [fileOption, { ...fileOption, label: "duplicate id" }] })).toThrow();
	expect(() => buildPacket({ ...input, options: [{ ...fileOption, permission: "" }] })).toThrow();
});

test("approval packet states permissions and passes deterministic host validation without LLM cold-read", () => {
	const packet = approvalPacket({ runId: "desk-1", candidateRevision: 2, content: "Bound a change.", scope: "src/a.ts", base: "abc123" });
	validateApprovalPacket(packet);
	const rendered = renderPacket(packet);
	expect(rendered).toContain("Permits implementation writes inside the stated scope");
	expect(rendered).toContain("does not permit merge, publication or delivery");
	expect(rendered).toContain("candidate revision 2");
	expect(rendered).toContain("src/a.ts");
});

test("knowledge diff cold-read rejects bare prose and accepts prose-wrapped calibrated JSON", () => {
	const prompt = knowledgeColdReadPrompt({ path: "GLOSSARY.md", reason: "Clarify export term", diffText: "+- export: bounded file" });
	expect(prompt).toContain("untrusted data");
	expect(() => parseKnowledgeColdReadVerdict("ANSWERABLE")).toThrow();

	const wrapped = `Here is my assessment:\n\`\`\`json\n${JSON.stringify({
		verdict: "PASS",
		missing: [],
		contradictions: [],
		bloat: [],
		summary: "Reason and diff are unambiguous.",
	})}\n\`\`\`\nDone.`;
	expect(parseKnowledgeColdReadVerdict(wrapped).verdict).toBe("PASS");
});

test("alignment doc cold-read requires ALL core sections with verbatim quotes and rejects prose spoofing", () => {
	const doc: AlignmentDocument = {
		tldr: "Add cache TTL.",
		problem: "Stale items persist indefinitely.",
		goals: ["Expire entries after 60s."],
		nonGoals: ["No LRU eviction."],
		placement: { summary: "CacheStore", upstreamDownstream: [], constraints: [], nodes: [], edges: [] },
		mechanism: { overview: "Store timestamp", contracts: [], failureModes: ["Expired entry returns null"], persistenceOrMigration: "None" },
		changeSurface: [{ path: "src/cache.ts", action: "modify", summary: "Add TTL check" }],
		decisions: [],
		risksAndAssumptions: [],
		verification: "bun test cache.test.ts",
	};
	const profile = deriveRequirementProfile({
		signals: { expectedFiles: 1, distinctModules: 1, riskFlags: [], externalEffects: false, estimatedSlices: 1 },
	});
	const readModel = buildAlignmentReadModel(doc, profile, {
		runId: "r-1", candidateRevision: 1, baseSha: "abc", linearMode: "optional", issue: null,
		slices: [{ id: "s1", behavior: "Add TTL", test: "cache.test.ts", dependsOn: [] }],
	});
	const prompt = alignmentColdReadPrompt(readModel);
	expect(prompt).toContain("FAIL_MISSING");
	expect(prompt).toContain("FAIL_BLOAT");

	// Fabricated quote not present in readModel is rejected by host verification.
	expect(() => parseAlignmentColdReadVerdict(JSON.stringify({
		verdict: "PASS",
		questionResults: [{ questionId: "non-goals", status: "ANSWERED", sectionId: "goals", quote: "Fabricated quote not in document" }],
		missing: [], contradictions: [], bloat: [], summary: "ok",
	}), readModel)).toThrow(/quote/i);

	// Partial core coverage (only 3 of 7 core sections) is rejected!
	expect(() => parseAlignmentColdReadVerdict(JSON.stringify({
		verdict: "PASS",
		questionResults: [
			{ questionId: "tldr", status: "ANSWERED", sectionId: "tldr", quote: "Add cache TTL." },
			{ questionId: "goals", status: "ANSWERED", sectionId: "goals", quote: "No LRU eviction." },
			{ questionId: "change-surface", status: "ANSWERED", sectionId: "change-surface", quote: "src/cache.ts" },
		],
		missing: [], contradictions: [], bloat: [], summary: "partial",
	}), readModel)).toThrow(/missing/i);

	// All 7 core sections answered with verbatim quotes + prose wrapper passes cleanly!
	const fullProse = `Result:\n${JSON.stringify({
		verdict: "PASS",
		questionResults: [
			{ questionId: "tldr", status: "ANSWERED", sectionId: "tldr", quote: "Add cache TTL." },
			{ questionId: "workflow", status: "ANSWERED", sectionId: "workflow", quote: "Gate 1: Plan Approve" },
			{ questionId: "goals", status: "ANSWERED", sectionId: "goals", quote: "No LRU eviction." },
			{ questionId: "placement", status: "ANSWERED", sectionId: "placement", quote: "CacheStore" },
			{ questionId: "mechanism", status: "ANSWERED", sectionId: "mechanism", quote: "Store timestamp" },
			{ questionId: "change-surface", status: "ANSWERED", sectionId: "change-surface", quote: "src/cache.ts" },
			{ questionId: "verification", status: "ANSWERED", sectionId: "verification", quote: "bun test cache.test.ts" },
		],
		missing: [],
		contradictions: [],
		bloat: [],
		summary: "All 7 core sections answered cleanly.",
	})}`;
	const valid = parseAlignmentColdReadVerdict(fullProse, readModel);
	expect(valid.verdict).toBe("PASS");
});

test("parseReviewVerdict accepts strict JSON and legacy ACCEPT headings while rejecting invalid prose", () => {
	expect(parseReviewVerdict('{"verdict":"ACCEPT","findings":[],"summary":"Clean"}').verdict).toBe("ACCEPT");
	expect(parseReviewVerdict('{"verdict":"REJECT","findings":["Bug"],"summary":"Unsafe"}').verdict).toBe("REJECT");
	expect(parseReviewVerdict("ACCEPT\n## Standards\nok\n## Spec\nok").verdict).toBe("ACCEPT");
	expect(() => parseReviewVerdict("Looks fine to me!")).toThrow();
});

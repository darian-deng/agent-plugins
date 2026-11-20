import { expect, test } from "bun:test";
import { approvalPacket, buildPacket, coldReadPrompt, renderPacket, type QuestionOption } from "../../src/questions";

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

test("the cold reader and the native fields read the same packet", () => {
	const packet = buildPacket(input);
	const rendered = renderPacket(packet);
	const prompt = coldReadPrompt(packet);
	expect(prompt.endsWith(rendered)).toBe(true);
	expect(rendered).toContain("Permits one additive migration inside the approved scope.");
	expect(rendered).toContain("Missing information:\n- Retention period");
	expect(rendered).toContain("Recommendation: file");
	expect(prompt).toContain("You have no tools");
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

test("the approval packet states both what approval permits and what it never permits", () => {
	const packet = approvalPacket({ runId: "desk-1", candidateRevision: 2, content: "Bound a change.", scope: "src/a.ts", base: "abc123" });
	const rendered = renderPacket(packet);
	expect(rendered).toContain("Permits implementation writes inside the stated scope");
	expect(rendered).toContain("does not permit merge, publication or delivery");
	expect(rendered).toContain("candidate revision 2");
	expect(rendered).toContain("src/a.ts");
});

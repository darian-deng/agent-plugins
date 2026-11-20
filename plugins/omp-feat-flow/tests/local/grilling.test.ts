import { expect, test } from "bun:test";
import { BOUNDARY_CATEGORIES, grillFromConversation, grillFromPrd } from "../../src/grilling";
import { buildPlan, PLAN_INVARIANT } from "../../src/plan";

const prd = `# Export requirement

## Reliable answers
- Exports are under 50 MB.
- The service already stores exports on disk.

## Decisions
- non-goals: No new database table.
- acceptance: A 50 MB export completes in under two minutes.

## Later
- authorization: not decided here, this line is outside the decisions block.
`;

test("a PRD with reliable answers still exposes its unresolved boundaries", () => {
	const result = grillFromPrd(prd, ["Exports are under 50 MB."]);
	expect(result.decided.map(decision => decision.category)).toEqual(["non-goals", "acceptance"]);
	expect(result.open.map(boundary => boundary.category)).toEqual(["goals", "business-boundary", "error-path"]);
});

test("recorded decisions are never asked again", () => {
	const complete = `## Decisions
- goals: Ship export under the existing service.
- business-boundary: Only the owning team may export.
- error-path: A failed export returns 503 and leaves no partial file.
- non-goals: No shared table.
- acceptance: A 50 MB export completes in under two minutes.
`;
	const result = grillFromPrd(complete, []);
	expect(result.decided).toHaveLength(BOUNDARY_CATEGORIES.length);
	expect(result.open).toEqual([]);
	expect(result.open).toEqual([]);
	expect(result.decided).toHaveLength(BOUNDARY_CATEGORIES.length);
});

test("a conversation entry needs no repeated interview when its answers cover the boundaries", () => {
	const answers = [
		{ category: "goals" as const, answer: "Ship the bounded export." },
		{ category: "business-boundary" as const, answer: "Only the owning team." },
		{ category: "error-path" as const, answer: "503, no partial file." },
		{ category: "non-goals" as const, answer: "No new table." },
		{ category: "acceptance" as const, answer: "Under two minutes for 50 MB." },
	];
	const result = grillFromConversation(answers, ["A small bounded export."]);
	expect(result.open).toEqual([]);
	expect(grillFromConversation(answers.slice(0, 2), ["x"]).open.map(boundary => boundary.category))
		.toEqual(((["error-path", "non-goals", "acceptance"] as const)).slice(0, 3).sort((a, b) =>
			BOUNDARY_CATEGORIES.indexOf(a) - BOUNDARY_CATEGORIES.indexOf(b)));
	expect(() => grillFromConversation([answers[0]!, answers[0]!], [])).toThrow();
	expect(() => grillFromConversation({} as never, [])).toThrow(/JSON array/);
	expect(() => grillFromConversation([{ category: "other" as never, answer: "x" }], [])).toThrow();
});

test("an activity only exists for a named uncertain seam", () => {
	const base = { id: "s1", behavior: "export writes one file", test: "a 1 MB export yields one file", dependsOn: [] };
	expect(() => buildPlan({ uncertainties: [{ kind: "prototype", seam: " ", reason: "unknown" }], slices: [base] })).toThrow();
	expect(() => buildPlan({ uncertainties: [{ kind: "spec", seam: "streaming", reason: "" }], slices: [base] })).toThrow();
	const withPrototype = buildPlan({
		uncertainties: [{ kind: "prototype", seam: "streaming 50 MB without buffering", reason: "The buffer behaviour is unknown." }],
		slices: [base, { id: "s2", behavior: "stream", test: "memory stays flat", dependsOn: ["s1"] }],
	});
	expect(withPrototype.activities).toHaveLength(1);
	expect(withPrototype.invariant).toBe(PLAN_INVARIANT);
});

test("the plan stays serial and refuses parallel writers", () => {
	const slices = [
		{ id: "s1", behavior: "a", test: "ta", dependsOn: [] },
		{ id: "s2", behavior: "b", test: "tb", dependsOn: ["s1"] },
	];
	expect(buildPlan({ uncertainties: [], slices }).slices.map(slice => slice.id)).toEqual(["s1", "s2"]);
	expect(() => buildPlan({ uncertainties: [], slices: [slices[0]!, { ...slices[1]!, dependsOn: [] }] })).toThrow(/predecessor/);
	expect(() => buildPlan({ uncertainties: [], slices: [slices[0]!, { ...slices[1]!, dependsOn: ["s3"] }] })).toThrow(/earlier slice/);
	expect(() => buildPlan({ uncertainties: [], slices: [slices[0]!, { ...slices[1]!, id: "s1" }] })).toThrow(/appears twice/);
	expect(() => buildPlan({ uncertainties: [], slices: [{ ...slices[0]!, dependsOn: ["s9"] }] })).toThrow(/earlier slice/);
	expect(() => buildPlan({ uncertainties: [], slices: [] })).toThrow();
});

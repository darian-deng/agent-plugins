export type ActivityKind = "prototype" | "research" | "spec" | "ticket" | "wizard";

export interface PlanActivity {
	kind: ActivityKind;
	/** The concrete uncertain seam this activity must reduce; there is no activity without one. */
	seam: string;
	reason: string;
}

export interface PlanSlice {
	id: string;
	behavior: string;
	test: string;
	dependsOn: string[];
}

export interface ImplementationPlan {
	activities: PlanActivity[];
	slices: PlanSlice[];
	invariant: string;
}

export const PLAN_INVARIANT = "one failing behavioral slice, then minimal green, then review; no parallel writers";

/**
 * An adaptive plan, not a stage template: an activity exists only for a named uncertain seam, and the
 * slices are strictly serial so each one has a single writer and a single failing test.
 */
/**
 * Validates a submitted plan on the real input path: duplicate ids, unknown dependencies and parallel
 * writers are refused here, not only in the builder tests.
 */
export function validatePlan(plan: ImplementationPlan): void {
	buildPlan({ uncertainties: plan.activities, slices: plan.slices });
	if (!plan.invariant || plan.invariant.trim().length < 8) {
		throw new Error("A plan needs its one-line invariant; it is what the review holds the change to.");
	}
}

export function buildPlan(input: { uncertainties: PlanActivity[]; slices: PlanSlice[] }): ImplementationPlan {
	const seams = new Set<string>();
	for (const activity of input.uncertainties) {
		if (!activity.seam.trim()) throw new Error(`A ${activity.kind} activity needs the uncertain seam it resolves.`);
		if (!activity.reason.trim()) throw new Error(`A ${activity.kind} activity needs its actual reason.`);
		if (seams.has(activity.seam)) throw new Error(`The seam ${activity.seam} is already covered by another activity.`);
		seams.add(activity.seam);
	}
	if (input.slices.length === 0) throw new Error("A plan needs at least one behavioral slice.");
	const seen = new Map<string, number>();
	input.slices.forEach((slice, index) => {
		if (!slice.behavior.trim() || !slice.test.trim()) throw new Error(`Slice ${slice.id} needs a behavior and its test.`);
		if (seen.has(slice.id)) throw new Error(`Slice ${slice.id} appears twice.`);
		for (const dependency of slice.dependsOn) {
			const earlier = seen.get(dependency);
			if (earlier === undefined) throw new Error(`Slice ${slice.id} depends on ${dependency}, which is not an earlier slice.`);
		}
		// Serial discipline: the first slice starts from the baseline, every later one from its predecessor.
		const expected = index === 0 ? 0 : 1;
		if (slice.dependsOn.length !== expected) {
			throw new Error(index === 0
				? "The first slice must start from the approved baseline."
				: `Slice ${slice.id} must depend on exactly its predecessor; parallel writers are not planned.`);
		}
		if (index > 0 && slice.dependsOn[0] !== input.slices[index - 1]!.id) {
			throw new Error(`Slice ${slice.id} must depend on ${input.slices[index - 1]!.id}.`);
		}
		seen.set(slice.id, index);
	});
	return { activities: input.uncertainties.map(activity => ({ ...activity })), slices: input.slices.map(slice => ({ ...slice, dependsOn: [...slice.dependsOn] })), invariant: PLAN_INVARIANT };
}

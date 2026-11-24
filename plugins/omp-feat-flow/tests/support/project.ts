import { inspectRepository } from "../../src/git";
import { saveProject, type ProjectConfigV2 } from "../../src/run";

export const FIXTURE_DEFAULTS: ProjectConfigV2 = {
	schemaVersion: 2,
	revision: 0,
	git: { remote: "origin", startRef: "origin/staging", prBase: "staging", worktreeRoot: "../source-worktrees" },
	github: { repository: "fixture/repository" },
	linear: { mode: "required", teamId: "team", reviewState: "In Review" },
	knowledge: { entryPaths: ["README.md"] },
};

export async function seedProject(source: string, overrides: Partial<ProjectConfigV2> = {}): Promise<void> {
	const location = await inspectRepository(source);
	await saveProject(location.commonDir, { ...FIXTURE_DEFAULTS, ...overrides }, 0);
}

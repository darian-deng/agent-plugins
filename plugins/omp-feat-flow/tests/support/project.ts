import { inspectRepository } from "../../src/git";
import { saveProject, type ProjectDefaults } from "../../src/run";

/** Minimal real defaults so a live fixture can start a run; every field is required by the schema. */
export const FIXTURE_DEFAULTS: ProjectDefaults = {
	git: { remote: "origin", startRef: "origin/staging", prBase: "staging", worktreeRoot: "source-worktrees" },
	github: { host: "github.com", repository: "fixture/repository" },
	linear: { workspaceId: "workspace", teamId: "team",
		statusMapping: { inProgress: "In Progress", inReview: "In Review", done: "Done" } },
	models: { author: "fixture", helper: "fixture", reviewer: "fixture" },
	knowledge: { entryPaths: ["README.md"] },
};

export async function seedProject(source: string, overrides: Partial<ProjectDefaults> = {}): Promise<void> {
	const location = await inspectRepository(source);
	await saveProject(location.commonDir, { ...FIXTURE_DEFAULTS, ...overrides }, 0);
}

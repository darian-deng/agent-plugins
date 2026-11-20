export interface UpdateAssessment {
	loadedBuildId: string;
	installedBuildId: string;
	version: string;
	relation: "same" | "stale" | "unknown";
	/** A newer artifact is installed but this process keeps running the loaded code until a real restart. */
	requiresRestart: boolean;
	blockers: string[];
	detail: string;
}

export interface UpdateRequest {
	loadedBuildId: string;
	installed: { buildId: string; version: string } | null;
	/** Effects that are dispatched but unsettled, or of unknown outcome. */
	unresolvedEffects: number;
}

/**
 * Compares the immutable identity of the running code with what the native installation reports.
 * Nothing here loads new code or claims the installed build is running.
 */
export function inspectUpdate(request: UpdateRequest): UpdateAssessment {
	const installedBuildId = request.installed?.buildId ?? "";
	const version = request.installed?.version ?? "unknown";
	if (request.unresolvedEffects > 0) {
		return { loadedBuildId: request.loadedBuildId, installedBuildId, version, relation: "unknown", requiresRestart: false,
			blockers: [`${request.unresolvedEffects} effect(s) are unsettled; an upgrade cannot start from here`],
			detail: "blocked until every dispatched or unknown effect is reconciled" };
	}
	if (!request.installed) {
		return { loadedBuildId: request.loadedBuildId, installedBuildId, version, relation: "unknown", requiresRestart: false,
			blockers: ["no readable native installation metadata"], detail: "the installed artifact cannot be identified" };
	}
	if (request.installed.buildId === request.loadedBuildId) {
		return { loadedBuildId: request.loadedBuildId, installedBuildId, version, relation: "same", requiresRestart: false,
			blockers: [], detail: `running build ${request.loadedBuildId.slice(0, 12)} v${version}` };
	}
	return { loadedBuildId: request.loadedBuildId, installedBuildId, version, relation: "stale", requiresRestart: true,
		blockers: [],
		detail: `running ${request.loadedBuildId.slice(0, 12)} while ${installedBuildId.slice(0, 12)} v${version} is installed; `
			+ "only a real native restart loads it, and reload-plugins does not replace loaded code" };
}

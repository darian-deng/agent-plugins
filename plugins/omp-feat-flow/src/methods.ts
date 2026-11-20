import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import baseline from "../resources/methods-baseline.json" with { type: "json" };
import dependencies from "../resources/methods.json" with { type: "json" };

export interface MethodFileSnapshot {
	path: string;
	bytes: number;
	sha256: string;
}

export type MethodStatus = "audited-match" | "modified" | "incomplete" | "missing" | "unknown-source";
export interface MethodSnapshot {
	name: string;
	directory: string;
	upstream: string | null;
	status: MethodStatus;
	files: MethodFileSnapshot[];
	missingFiles: string[];
	extraFiles: string[];
	changedFiles: string[];
	/** Allowed only for a selected, source-known and locally unmodified copy. */
	update: { permitted: boolean; reason: string };
}
export interface MethodSnapshotSet {
	root: string;
	ref: string | null;
	core: string[];
	methods: MethodSnapshot[];
	/** Only a missing or incomplete core install stops start; a locally modified copy stays usable. */
	blockingCore: string[];
	modifiedCore: string[];
	guidance: string | null;
}

interface BaselineFile {
	schemaVersion: 1;
	repo: string;
	ref: string;
	methods: Record<string, { upstream: string; files: Record<string, { bytes: number; sha256: string }> }>;
}

const BASELINE = baseline as BaselineFile;

/** The profile's skill directory; a live case points this at a dedicated profile, never the user's. */
export function methodsRoot(): string {
	return process.env.OMP_FEAT_FLOW_SKILLS_DIR || join(homedir(), ".agents", "skills");
}

async function listFiles(directory: string): Promise<string[]> {
	const found: string[] = [];
	const walk = async (current: string): Promise<void> => {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) found.push(relative(directory, path));
		}
	};
	if (!(await stat(directory).catch(() => null))?.isDirectory()) return [];
	await walk(directory);
	return found.sort();
}

export interface MethodAdoption {
	runDirectory: string;
	directory: string;
	ref: string | null;
	adopted: Array<{ name: string; status: MethodStatus; files: MethodFileSnapshot[] }>;
}

export async function resolveMethods(names: readonly string[], root = methodsRoot()): Promise<MethodSnapshotSet> {
	const methods: MethodSnapshot[] = [];
	for (const name of names) {
		const expected = BASELINE.methods[name];
		const directory = join(root, name);
		const files: MethodFileSnapshot[] = [];
		for (const path of await listFiles(directory)) {
			const bytes = await readFile(join(directory, path));
			files.push({ path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
		}
		const present = new Set(files.map(file => file.path));
		if (!expected) {
			methods.push({ name, directory, upstream: null, status: files.length === 0 ? "missing" : "unknown-source", files,
				missingFiles: [], extraFiles: [], changedFiles: [], update: { permitted: false, reason: "No audited upstream baseline is recorded for this method." } });
			continue;
		}
		const expectedPaths = Object.keys(expected.files);
		const missingFiles = expectedPaths.filter(path => !present.has(path));
		const extraFiles = files.map(file => file.path).filter(path => !(path in expected.files));
		const changedFiles = files.filter(file => {
			const audited = expected.files[file.path];
			return audited !== undefined && audited.sha256 !== file.sha256;
		}).map(file => file.path);
		const status: MethodStatus = files.length === 0 ? "missing" : missingFiles.length > 0 ? "incomplete"
			: changedFiles.length > 0 || extraFiles.length > 0 ? "modified" : "audited-match";
		methods.push({ name, directory, upstream: expected.upstream, status, files, missingFiles, extraFiles, changedFiles,
			update: status === "audited-match"
				? { permitted: true, reason: `Matches the audited ${BASELINE.repo}@${BASELINE.ref.slice(0, 12)} content.` }
				: { permitted: false, reason: status === "modified" ? "The installed copy differs from its known source; it is preserved, not updated."
					: status === "incomplete" ? "The installed copy is missing audited files; nothing is filled in from a moving global directory."
					: "The method is not installed from a known source." } });
	}
	const core = [...dependencies.core];
	const blockingCore = methods.filter(method => core.includes(method.name)
		&& (method.status === "missing" || method.status === "incomplete")).map(method => method.name);
	const modifiedCore = methods.filter(method => core.includes(method.name) && method.status === "modified").map(method => method.name);
	const guidance = blockingCore.length === 0 ? null
		: `${blockingCore.join(", ")} is missing or incomplete and must be installed from a known source before an issue, branch, worktree or workspace is created. `
			+ `Verified: ${BASELINE.repo}@${BASELINE.ref.slice(0, 12)}. `
			+ `Option A (selected skills only): ${dependencies.skillsCli}. `
			+ `Option B (whole official plugin, installs all ${dependencies.pluginSkillCount} methods): ${dependencies.pluginInstall}. `
			+ `This flow never installs a method or a package manager by itself.`;
	return { root, ref: BASELINE.ref, core, methods, blockingCore, modifiedCore, guidance };
}

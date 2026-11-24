import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { writeAtomic } from "./config";
import skillsManifest from "../resources/skills-manifest.json" with { type: "json" };

export interface SkillFileEntry {
	bytes: number;
	sha256: string;
}

export interface SkillManifestEntry {
	role: "core" | "conditional";
	upstream: string;
	files: Record<string, SkillFileEntry>;
}

export interface SkillsManifest {
	schemaVersion: 2;
	repo: string;
	ref: string;
	skills: Record<string, SkillManifestEntry>;
}

export const BUNDLED_SKILLS_MANIFEST = skillsManifest as SkillsManifest;

export function bundledSkillsRoot(): string {
	return process.env.OMP_FEAT_FLOW_BUNDLED_SKILLS_DIR || join(dirname(dirname(fileURLToPath(import.meta.url))), "resources", "skills");
}

export function defaultUserOverrideDirs(): string[] {
	return [
		join(homedir(), ".omp", "agent", "skills"),
		join(homedir(), ".claude", "skills"),
	];
}

export interface BundleVerification {
	valid: boolean;
	ref: string;
	skills: string[];
	missing: string[];
	mismatched: string[];
}

export async function verifyBundledMethods(root = bundledSkillsRoot()): Promise<BundleVerification> {
	const missing: string[] = [];
	const mismatched: string[] = [];
	const skills = Object.keys(BUNDLED_SKILLS_MANIFEST.skills).sort();
	for (const name of skills) {
		const entry = BUNDLED_SKILLS_MANIFEST.skills[name]!;
		for (const [rel, expected] of Object.entries(entry.files)) {
			const filePath = join(root, name, rel);
			if (!existsSync(filePath)) {
				missing.push(`${name}/${rel}`);
				continue;
			}
			const buf = await readFile(filePath);
			const actual = createHash("sha256").update(buf).digest("hex");
			if (actual !== expected.sha256 || buf.byteLength !== expected.bytes) {
				mismatched.push(`${name}/${rel}`);
			}
		}
	}
	return {
		valid: missing.length === 0 && mismatched.length === 0,
		ref: BUNDLED_SKILLS_MANIFEST.ref,
		skills,
		missing,
		mismatched,
	};
}

export interface MaterializedMethodPack {
	methodDigest: string;
	packDir: string;
	manifestRef: string;
	overriddenMethods: string[];
	skills: string[];
}

async function listRelativeFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			for (const child of await listRelativeFiles(full)) out.push(`${entry.name}/${child}`);
		} else if (entry.isFile()) {
			out.push(entry.name);
		}
	}
	return out.sort();
}

export async function materializeMethodPack(
	commonDir: string,
	options?: { bundledRoot?: string; overrideDirs?: string[]; allowUserOverrides?: boolean },
): Promise<MaterializedMethodPack> {
	const bundledRoot = options?.bundledRoot ?? bundledSkillsRoot();
	const allowOverrides = options?.allowUserOverrides ?? false;
	const overrideDirs = allowOverrides || options?.overrideDirs !== undefined
		? (options?.overrideDirs ?? defaultUserOverrideDirs())
		: [];
	const verification = await verifyBundledMethods(bundledRoot);
	if (!verification.valid) {
		throw new Error(
			`Bundled private skills failed verification (missing: ${verification.missing.join(", ") || "none"}, mismatched: ${verification.mismatched.join(", ") || "none"}).`,
		);
	}

	const hash = createHash("sha256");
	const sources = new Map<string, { dir: string; overridden: boolean }>();
	const overriddenMethods: string[] = [];

	for (const name of verification.skills) {
		let sourceDir = join(bundledRoot, name);
		let overridden = false;
		for (const overrideBase of overrideDirs) {
			const candidate = join(overrideBase, name);
			if (existsSync(join(candidate, "SKILL.md"))) {
				sourceDir = candidate;
				overridden = true;
				break;
			}
		}
		if (overridden) overriddenMethods.push(name);
		sources.set(name, { dir: sourceDir, overridden });
		const files = await listRelativeFiles(sourceDir);
		for (const rel of files) {
			hash.update(`${name}/${rel}\0`);
			hash.update(await readFile(join(sourceDir, rel)));
			hash.update("\0");
		}
	}

	const methodDigest = hash.digest("hex");
	const packsRoot = join(commonDir, "omp-feat-flow", "packs");
	const packDir = join(packsRoot, methodDigest);
	await mkdir(packsRoot, { recursive: true, mode: 0o700 });
	await withFileLock(packDir, async () => {
		if (existsSync(join(packDir, "MANIFEST.json"))) return;
		const staging = `${packDir}.tmp-${process.pid}-${Date.now()}`;
		await rm(staging, { recursive: true, force: true });
		try {
			await mkdir(staging, { recursive: true, mode: 0o700 });
			for (const [name, { dir }] of sources) {
				const dest = join(staging, name);
				await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
				await cp(dir, dest, { recursive: true });
			}
			const manifestPayload = {
				schemaVersion: 2,
				methodDigest,
				repo: BUNDLED_SKILLS_MANIFEST.repo,
				ref: BUNDLED_SKILLS_MANIFEST.ref,
				overriddenMethods,
				skills: verification.skills,
			};
			await writeAtomic(join(staging, "MANIFEST.json"), JSON.stringify(manifestPayload, null, 2) + "\n");
			if (!existsSync(join(packDir, "MANIFEST.json"))) {
				await rm(packDir, { recursive: true, force: true });
				await rename(staging, packDir);
			}
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}, { retries: 50, retryDelayMs: 10 });

	return {
		methodDigest,
		packDir,
		manifestRef: BUNDLED_SKILLS_MANIFEST.ref,
		overriddenMethods,
		skills: verification.skills,
	};
}

export async function openPinnedMethodPack(commonDir: string, expectedMethodDigest: string): Promise<MaterializedMethodPack> {
	if (!/^[a-f0-9]{64}$/.test(expectedMethodDigest)) {
		throw new Error("Run has an invalid pinned methodDigest.");
	}
	const packDir = join(commonDir, "omp-feat-flow", "packs", expectedMethodDigest);
	const manifestPath = join(packDir, "MANIFEST.json");
	if (!existsSync(manifestPath)) {
		throw new Error(`Pinned MethodPack ${expectedMethodDigest.slice(0, 12)} is missing from ${packDir}; refusing to substitute current methods.`);
	}
	const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
		methodDigest?: string;
		ref?: string;
		overriddenMethods?: string[];
		skills?: string[];
	};
	if (manifest.methodDigest !== expectedMethodDigest) {
		throw new Error(`Pinned MethodPack manifest digest mismatch (${manifest.methodDigest ?? "missing"} != ${expectedMethodDigest}).`);
	}
	const skills = (manifest.skills ?? []).slice().sort();
	const hash = createHash("sha256");
	for (const name of skills) {
		const dir = join(packDir, name);
		if (!existsSync(dir)) throw new Error(`Pinned MethodPack skill directory "${name}" is missing.`);
		const files = await listRelativeFiles(dir);
		for (const rel of files) {
			hash.update(`${name}/${rel.split(sep).join("/")}\0`);
			hash.update(await readFile(join(dir, rel)));
			hash.update("\0");
		}
	}
	const actualDigest = hash.digest("hex");
	if (actualDigest !== expectedMethodDigest) {
		throw new Error(`Pinned MethodPack ${expectedMethodDigest.slice(0, 12)} failed integrity verification (actual ${actualDigest.slice(0, 12)}).`);
	}
	return {
		methodDigest: expectedMethodDigest,
		packDir,
		manifestRef: manifest.ref ?? BUNDLED_SKILLS_MANIFEST.ref,
		overriddenMethods: manifest.overriddenMethods ?? [],
		skills,
	};
}
export async function readPackMethod(packDir: string, methodName: string, file = "SKILL.md"): Promise<string> {
	const path = join(packDir, methodName, file);
	if (!existsSync(path)) {
		throw new Error(`Method ${methodName}/${file} is missing from pack ${relative(packDir, path)}.`);
	}
	return readFile(path, "utf8");
}

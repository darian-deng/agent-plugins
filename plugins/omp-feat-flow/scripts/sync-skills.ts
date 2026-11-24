import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = join(ROOT, "resources", "skills");
const MANIFEST_PATH = join(ROOT, "resources", "skills-manifest.json");

const SKILL_CATALOG: Record<string, { role: "core" | "conditional"; upstream: string }> = {
	grilling: { role: "core", upstream: "skills/productivity/grilling" },
	tdd: { role: "core", upstream: "skills/engineering/tdd" },
	"code-review": { role: "core", upstream: "skills/engineering/code-review" },
	"domain-modeling": { role: "core", upstream: "skills/engineering/domain-modeling" },
	research: { role: "conditional", upstream: "skills/engineering/research" },
	prototype: { role: "conditional", upstream: "skills/engineering/prototype" },
	"codebase-design": { role: "conditional", upstream: "skills/engineering/codebase-design" },
	"diagnosing-bugs": { role: "conditional", upstream: "skills/engineering/diagnosing-bugs" },
	retro: { role: "conditional", upstream: "skills/engineering/retro" },
};

async function walkFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walkFiles(full)));
		else if (entry.isFile()) out.push(full);
	}
	return out.sort();
}

export async function generateSkillsManifest(ref: string): Promise<void> {
	const skills: Record<string, {
		role: "core" | "conditional";
		upstream: string;
		files: Record<string, { bytes: number; sha256: string }>;
	}> = {};
	for (const [name, meta] of Object.entries(SKILL_CATALOG).sort(([a], [b]) => a.localeCompare(b))) {
		const dir = join(SKILLS_DIR, name);
		const all = await walkFiles(dir);
		const files: Record<string, { bytes: number; sha256: string }> = {};
		for (const file of all) {
			const buf = await readFile(file);
			files[relative(dir, file).split(sep).join("/")] = {
				bytes: buf.byteLength,
				sha256: createHash("sha256").update(buf).digest("hex"),
			};
		}
		skills[name] = { role: meta.role, upstream: meta.upstream, files };
	}
	await mkdir(join(ROOT, "resources"), { recursive: true });
	await writeFile(MANIFEST_PATH, JSON.stringify({
		schemaVersion: 2,
		repo: "mattpocock/skills",
		ref,
		skills,
	}, null, 2) + "\n");
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.includes("--check")) {
		const { verifyBundledMethods } = await import("../src/methods");
		const status = await verifyBundledMethods();
		if (!status.valid) {
			console.error(`skills manifest check failed: missing=${status.missing.join(",")} mismatched=${status.mismatched.join(",")}`);
			process.exit(1);
		}
		console.log(`skills manifest OK (${status.skills.length} skills @ ${status.ref})`);
		process.exit(0);
	}
	const argRef = args[0] ?? process.env.MATT_SKILLS_REF;
	if (argRef && argRef.startsWith("-")) {
		throw new Error(`Invalid ref argument: ${argRef}`);
	}
	let ref = argRef;
	if (!ref) {
		try {
			const existing = JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as { ref?: string };
			ref = existing.ref;
		} catch { /* fallback */ }
	}
	if (!ref) ref = "main";
	await generateSkillsManifest(ref);
	console.log(`wrote resources/skills-manifest.json (ref: ${ref})`);
}

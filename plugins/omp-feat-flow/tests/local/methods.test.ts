import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMethods } from "../../src/methods";

const INSTALLED = join(homedir(), ".agents", "skills");
const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function profile(): Promise<string> {
	const created = await mkdtemp(join(tmpdir(), "omp-feat-profile-"));
	roots.push(created);
	for (const method of ["grilling", "tdd", "code-review"]) await cp(join(INSTALLED, method), join(created, method), { recursive: true });
	return created;
}

test("a missing core method blocks start while a locally modified one does not", async () => {
	const root = await profile();
	await rm(join(root, "grilling"), { recursive: true, force: true });
	await writeFile(join(root, "tdd", "SKILL.md"), "local convention\n");
	const resolved = await resolveMethods(["grilling", "tdd", "code-review"], root);
	expect(resolved.blockingCore).toEqual(["grilling"]);
	expect(resolved.modifiedCore).toEqual(["tdd"]);
	expect(resolved.guidance).toContain("grilling is missing or incomplete");
	expect(resolved.guidance).toContain("grilling is missing or incomplete");
});

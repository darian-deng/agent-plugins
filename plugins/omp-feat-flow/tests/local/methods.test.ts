import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	materializeMethodPack,
	readPackMethod,
	verifyBundledMethods,
} from "../../src/methods";

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("bundled private methods verify cleanly and expose zero top-level plugin skills dir", async () => {
	// Top-level skills/ must not exist so omp never registers duplicate /skill:<name> commands.
	const pluginRoot = new URL("../..", import.meta.url).pathname;
	expect(existsSync(join(pluginRoot, "skills"))).toBe(false);

	const check = await verifyBundledMethods();
	expect(check.valid).toBe(true);
	expect(check.missing).toEqual([]);
	expect(check.mismatched).toEqual([]);
	expect(check.skills).toContain("grilling");
	expect(check.skills).toContain("retro");
	expect(check.skills).toContain("prototype");
});

test("materializeMethodPack snapshots content-addressed bundle and tracks user overrides cleanly", async () => {
	const commonDir = await mkdtemp(join(tmpdir(), "omp-ff-pack-"));
	const overrideRoot = await mkdtemp(join(tmpdir(), "omp-ff-ovr-"));
	tempDirs.push(commonDir, overrideRoot);

	const basePack = await materializeMethodPack(commonDir, { overrideDirs: [overrideRoot] });
	expect(basePack.methodDigest).toMatch(/^[a-f0-9]{64}$/);
	expect(basePack.overriddenMethods).toEqual([]);
	expect(await readPackMethod(basePack.packDir, "tdd")).toContain("Test-Driven Development");

	// User override creates a distinct content-addressed pack without altering the previous pack.
	await mkdir(join(overrideRoot, "tdd"), { recursive: true });
	await writeFile(join(overrideRoot, "tdd", "SKILL.md"), "# Custom Team TDD\n");
	const customPack = await materializeMethodPack(commonDir, { overrideDirs: [overrideRoot] });
	expect(customPack.methodDigest).not.toBe(basePack.methodDigest);
	expect(customPack.overriddenMethods).toEqual(["tdd"]);
	expect(await readPackMethod(customPack.packDir, "tdd")).toBe("# Custom Team TDD\n");
	// Previously pinned pack remains immutable for in-flight runs.
	expect(await readFile(join(basePack.packDir, "tdd", "SKILL.md"), "utf8")).toContain("Test-Driven Development");
});

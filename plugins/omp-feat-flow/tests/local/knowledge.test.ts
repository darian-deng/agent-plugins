import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeKnowledge } from "../../src/knowledge";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "omp-feat-knowledge-"));
	roots.push(root);
	await mkdir(join(root, "docs"), { recursive: true });
	await writeFile(join(root, "docs", "rules.md"), "Use the run worktree.\nRun the owning test once.\n");
	return root;
}

test("no observed contradiction creates no documentation", async () => {
	const root = await project();
	const none = await proposeKnowledge({ root, candidates: [] });
	expect(none).toMatchObject({ change: false, changes: [] });
	expect(none.reason).toContain("contradicted by observed evidence");

	const identical = await proposeKnowledge({ root, candidates: [
		{ path: "docs/rules.md", proposed: "Use the run worktree.\nRun the owning test once.\n", reason: "no change" }] });
	expect(identical.change).toBe(false);
	expect(identical.reason).toContain("already matches");
});

test("a warranted correction returns the actual diff of the real file", async () => {
	const root = await project();
	const proposal = await proposeKnowledge({ root, candidates: [
		{ path: "docs/rules.md", proposed: "Use the run worktree.\nRun the owning test once.\nNever rebase a published branch.\n",
			reason: "A delivered PR was force-pushed twice after a rebase." }] });
	expect(proposal.change).toBe(true);
	expect(proposal.changes[0]).toMatchObject({ path: "docs/rules.md", status: "modified" });
	expect(proposal.changes[0]?.diff).toEqual(["+Never rebase a published branch."]);
});

test("a correction needs a concrete reason and cannot escape the project", async () => {
	const root = await project();
	await expect(proposeKnowledge({ root, candidates: [{ path: "docs/rules.md", proposed: "x", reason: " " }] }))
		.rejects.toBeInstanceOf(Error);
	await expect(proposeKnowledge({ root, candidates: [{ path: "../outside.md", proposed: "x", reason: "r" }] }))
		.rejects.toBeInstanceOf(Error);
});

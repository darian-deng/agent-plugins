import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMethods } from "../../src/methods";
import { gitFixture, type GitFixture } from "../support/git-fixture";
import { framesText, parseLiveArgs, startNativeHost, type NativeHost } from "../support/native-host";
import { seedProject } from "../support/project";

const args = parseLiveArgs();
const CASE = "methods-missing";
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;
const INSTALLED = join(homedir(), ".agents", "skills");

const fixtures: GitFixture[] = [];
const hosts: NativeHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

const git = async (cwd: string, arguments_: string[]): Promise<string> => {
	const process_ = Bun.spawn(["git", ...arguments_], { cwd, stdout: "pipe", stderr: "pipe" });
	await process_.exited;
	return (await new Response(process_.stdout).text()).trim();
};

test(`live ${CASE}: a missing core method stops before any issue, branch, worktree or workspace exists`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	// A dedicated profile holding real copies of the other core methods, with grilling absent.
	const profile = await mkdtemp(join(tmpdir(), "omp-feat-methods-"));
	for (const method of ["tdd", "code-review"]) await cp(join(INSTALLED, method), join(profile, method), { recursive: true });
	await mkdir(join(profile, "grilling"), { recursive: true });

	const before = {
		branches: await git(fixture.source, ["branch", "--list", "--format=%(refname:short)"]),
		worktrees: await git(fixture.source, ["worktree", "list", "--porcelain"]),
		status: await git(fixture.source, ["status", "--porcelain"]),
		head: await git(fixture.source, ["rev-parse", "HEAD"]),
		root: (await readdir(fixture.root)).sort(),
	};
	const resolved = await resolveMethods(["grilling", "tdd", "code-review"], profile);
	expect(resolved.blockingCore).toEqual(["grilling"]);
	expect(resolved.methods.find(method => method.name === "tdd")?.status).toBe("audited-match");

	const host = await startNativeHost(fixture.source, args.campaign, { env: { OMP_FEAT_FLOW_SKILLS_DIR: profile } });
	hosts.push(host);
	const result = await host.prompt("/feat-flow-start");
	const transcript = framesText(host.frames);
	const after = {
		branches: await git(fixture.source, ["branch", "--list", "--format=%(refname:short)"]),
		worktrees: await git(fixture.source, ["worktree", "list", "--porcelain"]),
		status: await git(fixture.source, ["status", "--porcelain"]),
		head: await git(fixture.source, ["rev-parse", "HEAD"]),
		root: (await readdir(fixture.root)).sort(),
	};
	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, `${CASE}.json`), JSON.stringify({
		case: CASE, campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
		resolved: { blockingCore: resolved.blockingCore, modifiedCore: resolved.modifiedCore, statuses: resolved.methods.map(method => [method.name, method.status]),
			update: resolved.methods.map(method => [method.name, method.update.permitted]) },
		prompt: { status: result.status, error: result.error, agentInvoked: result.agentInvoked },
		after, before,
	}, null, 2) + "\n");
	await writeFile(join(EVIDENCE, `${CASE}.rpc.jsonl`), transcript + "\n");

	expect(transcript).toContain("grilling is missing or incomplete");
	expect(transcript).toContain("npx skills add mattpocock/skills --skill grilling tdd code-review --global --agent pi");
	expect(after).toEqual(before);
	expect(host.meter.requests()).toBe(host.meter.initial());
}, 240_000);

test(`live model-missing: no credential gives static login/model guidance without inference`, async () => {
	if (args.only && args.only !== "model-missing") return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const profile = await mkdtemp(join(tmpdir(), "omp-feat-methods-"));
	for (const method of ["grilling", "tdd", "code-review"]) await cp(join(INSTALLED, method), join(profile, method), { recursive: true });
	const before = {
		branches: await git(fixture.source, ["branch", "--list", "--format=%(refname:short)"]),
		worktrees: await git(fixture.source, ["worktree", "list", "--porcelain"]),
		status: await git(fixture.source, ["status", "--porcelain"]),
		head: await git(fixture.source, ["rev-parse", "HEAD"]),
		root: (await readdir(fixture.root)).sort(),
	};
	const host = await startNativeHost(fixture.source, args.campaign,
		{ env: { OMP_FEAT_FLOW_SKILLS_DIR: profile }, withCredential: false });
	hosts.push(host);
	const result = await host.prompt("/feat-flow-start");
	const transcript = framesText(host.frames);
	const after = {
		branches: await git(fixture.source, ["branch", "--list", "--format=%(refname:short)"]),
		worktrees: await git(fixture.source, ["worktree", "list", "--porcelain"]),
		status: await git(fixture.source, ["status", "--porcelain"]),
		head: await git(fixture.source, ["rev-parse", "HEAD"]),
		root: (await readdir(fixture.root)).sort(),
	};
	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, "model-missing.json"), JSON.stringify({
		case: "model-missing", campaign: args.campaign, requests: host.meter.requests(), meterFailures: host.meter.failures(),
		prompt: { status: result.status, error: result.error, agentInvoked: result.agentInvoked }, before, after,
	}, null, 2) + "\n");
	await writeFile(join(EVIDENCE, "model-missing.rpc.jsonl"), transcript + "\n");

	expect(transcript).toMatch(/\/login|\/model/);
	expect(after).toEqual(before);
	expect(host.meter.requests()).toBe(host.meter.initial());
}, 240_000);

test("live methods-modified: a modified method is preserved and never silently updated", async () => {
	if (args.only && args.only !== "methods-modified") return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const profile = await mkdtemp(join(tmpdir(), "omp-feat-methods-"));
	for (const method of ["grilling", "tdd", "code-review"]) await cp(join(INSTALLED, method), join(profile, method), { recursive: true });
	const skill = join(profile, "grilling", "SKILL.md");
	const original = await readFile(skill, "utf8");
	const local = `${original}\nLocal project convention: ask one boundary question at a time.\n`;
	await writeFile(skill, local);
	const resolved = await resolveMethods(["grilling", "tdd", "code-review"], profile);
	expect(resolved.methods.find(method => method.name === "grilling")).toMatchObject({
		status: "modified", changedFiles: ["SKILL.md"], update: { permitted: false } });

	await git(fixture.seed, ["push", "origin", "main:staging"]);
	await git(fixture.source, ["fetch", "origin"]);
	await seedProject(fixture.source);
	const host = await startNativeHost(fixture.source, args.campaign, { env: { OMP_FEAT_FLOW_SKILLS_DIR: profile } });
	hosts.push(host);
	await host.prompt("/feat-flow-update");
	const startAttempt = await host.prompt("/feat-flow-start desk-methods");
	const transcript = framesText(host.frames);
	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, "methods-modified.json"), JSON.stringify({
		case: "methods-modified", campaign: args.campaign, requests: host.meter.requests(),
		start: { status: startAttempt.status, agentInvoked: startAttempt.agentInvoked },
		resolved: resolved.methods.map(method => [method.name, method.status, method.update.permitted]),
	}, null, 2) + "\n");
	await writeFile(join(EVIDENCE, "methods-modified.rpc.jsonl"), transcript + "\n");

	expect(transcript).toContain("grilling: modified (preserved:");
	expect(transcript).toContain("tdd: audited-match (update permitted)");
	expect(transcript).toContain("nothing was downloaded or overwritten");
	// A locally modified copy stays usable: start is not blocked by it, only by its absence.
	expect(transcript).toContain("run desk-methods created");
	expect(await readFile(skill, "utf8")).toBe(local);
	expect(host.meter.requests()).toBe(host.meter.initial());
}, 240_000);

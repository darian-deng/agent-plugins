import { afterEach, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledSkillsRoot, verifyBundledMethods } from "../../src/methods";
import { gitFixture, type GitFixture } from "../support/git-fixture";
import { framesText, parseLiveArgs, startNativeHost, type NativeHost } from "../support/native-host";

const args = parseLiveArgs();
const CASE = "methods-bundled";
const EVIDENCE = new URL(`../../../../.superpowers/sdd/2026-11-18-omp-feat-flow/live/${args.campaign}/`, import.meta.url).pathname;

const fixtures: GitFixture[] = [];
const hosts: NativeHost[] = [];
afterEach(async () => {
	for (const host of hosts.splice(0)) await host.stop();
	for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

test(`live ${CASE}: a tampered private method bundle stops before any issue, branch, worktree or workspace exists`, async () => {
	if (args.only && args.only !== CASE) return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const brokenRoot = await mkdtemp(join(tmpdir(), "omp-feat-methods-"));
	await cp(bundledSkillsRoot(), brokenRoot, { recursive: true });
	await writeFile(join(brokenRoot, "grilling", "SKILL.md"), "tampered\n");

	const check = await verifyBundledMethods(brokenRoot);
	expect(check.valid).toBe(false);
	expect(check.mismatched).toContain("grilling/SKILL.md");

	const host = await startNativeHost(fixture.source, args.campaign, { env: { OMP_FEAT_FLOW_BUNDLED_SKILLS_DIR: brokenRoot } });
	hosts.push(host);
	await host.prompt("/feat-flow-start");
	const transcript = framesText(host.frames);
	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, `${CASE}.rpc.jsonl`), transcript + "\n");

	expect(transcript).toContain("Bundled private skills invalid");
	expect(host.meter.requests()).toBe(host.meter.initial());
}, 240_000);

test(`live model-missing: no credential gives static login/model guidance without inference`, async () => {
	if (args.only && args.only !== "model-missing") return;
	const fixture = await gitFixture();
	fixtures.push(fixture);
	const host = await startNativeHost(fixture.source, args.campaign, { withCredential: false });
	hosts.push(host);
	await host.prompt("/feat-flow-start");
	const transcript = framesText(host.frames);
	await mkdir(EVIDENCE, { recursive: true });
	await writeFile(join(EVIDENCE, "model-missing.rpc.jsonl"), transcript + "\n");

	expect(transcript).toMatch(/No credential is available|No model is selected/);
	expect(host.meter.requests()).toBe(host.meter.initial());
}, 240_000);
